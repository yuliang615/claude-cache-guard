import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseInstallOptions,
  resolveInstallThresholds
} from "../src/cli.js";
import { PassThrough, Writable } from "node:stream";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "claude-cache-guard.js");

function tempDir(prefix = "ccg-ux-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeProject(name = "project") {
  const cwd = path.join(tempDir(), name);
  fs.mkdirSync(cwd, { recursive: true });
  return fs.realpathSync(cwd);
}

function runCli({ home, cwd = root, args, input }) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    input,
    encoding: "utf8"
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeUsageState(home, fiveHourUsed, { sevenDay = 22, resetsAt = "2999-06-13T17:00:00Z" } = {}) {
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "usage-state.json"),
    JSON.stringify({
      source: "claude-code-statusLine",
      updated_at: new Date().toISOString(),
      model: { id: "claude-opus-4-6", display_name: "Opus 4.6" },
      context_window: { used_percentage: 30 },
      five_hour: { used_percentage: fiveHourUsed, resets_at: resetsAt },
      seven_day: { used_percentage: sevenDay, resets_at: "2026-06-18T09:00:00Z" }
    })
  );
}

function projectLocalSettingsPath(cwd) {
  return path.join(cwd, ".claude", "settings.local.json");
}

// --- BUG-06: disable distinguishes whole-file delete from partial hook removal ---

test("BUG-06: disable keeps settings.local.json and removes only ccg hooks when other settings exist", () => {
  const home = tempDir();
  const cwd = makeProject("disable partial file");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);

  // The user has their own settings alongside the ccg hooks.
  const localPath = projectLocalSettingsPath(cwd);
  const local = readJson(localPath);
  local.permissions = { allow: ["Bash(ls:*)"] };
  fs.writeFileSync(localPath, JSON.stringify(local, null, 2));

  const result = runCli({ home, cwd, args: ["disable"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /hook settings: removed ccg hooks from .* \(file kept with your other settings\)/);
  assert.equal(fs.existsSync(localPath), true);
  assert.deepEqual(readJson(localPath).permissions, { allow: ["Bash(ls:*)"] });
});

// --- BUG-07: explicit check-threshold flags honor the full 0-100 range ---

test("BUG-07: check-threshold --five-hour 100 is honored (not clamped to 90)", () => {
  const home = tempDir();
  writeUsageState(home, 95);
  const result = runCli({ home, args: ["check-threshold", "--five-hour", "100", "--json"] });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.five_hour.threshold, 100);
});

test("BUG-07: check-threshold --five-hour 0 warns immediately (not clamped to 90)", () => {
  const home = tempDir();
  writeUsageState(home, 50);
  const result = runCli({ home, args: ["check-threshold", "--five-hour", "0", "--json"] });
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "warning");
  assert.equal(parsed.five_hour.threshold, 0);
});

// --- BUG-10: status explains a warning that cannot be windowed ---

test("BUG-10: status warns about a missing resets_at that blocks the handoff hook", () => {
  const home = tempDir();
  const cwd = makeProject("status no reset");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "90"] }).status, 0);
  // Above threshold but with no reset time to identify the window.
  writeUsageState(home, 95, { resetsAt: null });

  const result = runCli({ home, cwd, args: ["status"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /threshold status: warning/);
  assert.match(result.stdout, /note: five_hour\.resets_at is missing/);
  assert.match(result.stdout, /will not fire until the statusLine provides a reset time/);
});

test("BUG-10: status stays quiet about resets_at when a reset time is present", () => {
  const home = tempDir();
  const cwd = makeProject("status with reset");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "90"] }).status, 0);
  writeUsageState(home, 95, { resetsAt: "2999-06-13T17:00:00Z" });

  const result = runCli({ home, cwd, args: ["status"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /threshold status: warning/);
  assert.doesNotMatch(result.stdout, /note: five_hour\.resets_at is missing/);
});

// --- BUG-13: usage after install points to Claude Code, not another install ---

test("BUG-13: usage without state tells an un-installed user to run ccg install", () => {
  const home = tempDir();
  const result = runCli({ home, args: ["usage"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No usage state found/);
  assert.match(result.stdout, /Run ccg install, then use Claude Code until the statusLine refreshes\./);
});

// --- BUG-15: user-facing guidance uses the short alias ccg ---

test("BUG-15: unknown command points at ccg help", () => {
  const home = tempDir();
  const result = runCli({ home, args: ["totally-unknown"] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Run ccg help\./);
  assert.doesNotMatch(result.stderr, /Run claude-cache-guard help/);
});

// --- BUG-02: install --reconfigure defaults the prompt to the current threshold ---

function fakeTtyPair() {
  const input = new PassThrough();
  input.isTTY = true;
  let outputText = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputText += chunk.toString();
      callback();
    }
  });
  output.isTTY = true;
  output.getText = () => outputText;
  return { input, output };
}

function scriptedAsk(answers, output) {
  let index = 0;
  return async (prompt) => {
    output.write(prompt);
    return answers[index++] ?? "";
  };
}

test("BUG-02: reconfigure prompt defaults to the current effective threshold on Enter", async () => {
  const { input, output } = fakeTtyPair();
  const value = await resolveInstallThresholds({
    options: parseInstallOptions(["--reconfigure"]),
    configState: { exists: true, legacy: false, config: { thresholds: { five_hour_warning: 66 } } },
    input,
    output,
    ask: scriptedAsk([""], output)
  });
  assert.deepEqual(value, { fiveHourWarning: 66 });
  assert.match(output.getText(), /\[66\]/);
});

test("BUG-02: first-time install still defaults to 90", async () => {
  const { input, output } = fakeTtyPair();
  const value = await resolveInstallThresholds({
    options: parseInstallOptions(["--reconfigure"]),
    configState: { exists: false, legacy: false },
    input,
    output,
    ask: scriptedAsk([""], output)
  });
  assert.deepEqual(value, { fiveHourWarning: 90 });
  assert.match(output.getText(), /\[90\]/);
});
