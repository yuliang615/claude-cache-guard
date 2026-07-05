import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PassThrough, Writable } from "node:stream";
import {
  parseInstallOptions,
  resolveInstallThresholds
} from "../src/cli.js";
import { DEFAULT_GLOBAL_CONFIG } from "../src/config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "claude-cache-guard.js");

function tempDir(prefix = "ccg-qa-") {
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

function writeSettings(home, settings) {
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify(settings, null, 2));
}

function globalConfigPath(home) {
  return path.join(home, ".claude", "cache-guard", "config.json");
}

function writeGlobalConfig(home, config) {
  const dir = path.join(home, ".claude", "cache-guard");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(globalConfigPath(home), JSON.stringify(config, null, 2));
}

function configWithFiveHour(value) {
  return {
    ...DEFAULT_GLOBAL_CONFIG,
    thresholds: { ...DEFAULT_GLOBAL_CONFIG.thresholds, five_hour_warning: value }
  };
}

function projectHandoffPath(home, cwd) {
  const config = readJson(path.join(cwd, ".claude-cache-guard.json"));
  return path.join(home, ".claude", "next-session", config.project_id, "next_session.md");
}

function projectLocalSettingsPath(cwd) {
  return path.join(cwd, ".claude", "settings.local.json");
}

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

function nonTtyPair() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = false;
  output.isTTY = false;
  return { input, output };
}

// Simulates readline/promises rejecting the question on Ctrl+D. Node v24's
// readline rejects with an AbortError whose message is "Aborted with Ctrl+D".
function abortingAsk(output) {
  return async (prompt) => {
    output.write(prompt);
    const error = new Error("Aborted with Ctrl+D");
    error.name = "AbortError";
    error.code = "ABORT_ERR";
    throw error;
  };
}

// --- BUG-QA-01: non-interactive install --reconfigure must not silently reset ---

test("QA-01: non-interactive install --reconfigure without a flag throws instead of resetting", async () => {
  const { input, output } = nonTtyPair();
  await assert.rejects(
    resolveInstallThresholds({
      options: parseInstallOptions(["--reconfigure"]),
      configState: { exists: true, legacy: false, config: { thresholds: { five_hour_warning: 75 } } },
      input,
      output
    }),
    /ccg install --reconfigure requires --five-hour-warning when stdin\/stdout is not interactive/
  );
});

test("QA-01: non-interactive first-time install (no config) still defaults to 90", async () => {
  const { input, output } = nonTtyPair();
  assert.deepEqual(
    await resolveInstallThresholds({
      options: parseInstallOptions(["--reconfigure"]),
      configState: { exists: false, legacy: false },
      input,
      output
    }),
    { fiveHourWarning: 90 }
  );
});

test("QA-01: non-interactive install over legacy metadata still defaults to 90", async () => {
  const { input, output } = nonTtyPair();
  assert.deepEqual(
    await resolveInstallThresholds({
      options: parseInstallOptions(["--reconfigure"]),
      configState: { exists: true, legacy: true },
      input,
      output
    }),
    { fiveHourWarning: 90 }
  );
});

test("QA-01 E2E: install --reconfigure without a flag errors and keeps the existing threshold", () => {
  const home = tempDir();
  writeSettings(home, {});
  writeGlobalConfig(home, configWithFiveHour(75));

  const result = runCli({ home, args: ["install", "--reconfigure"] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ccg install --reconfigure requires --five-hour-warning when stdin\/stdout is not interactive/);
  // The user's chosen threshold must survive; it must not be reset to 90.
  assert.equal(readJson(globalConfigPath(home)).thresholds.five_hour_warning, 75);
});

test("QA-01 E2E: first-time non-interactive install writes the documented default of 90", () => {
  const home = tempDir();
  writeSettings(home, {});

  const result = runCli({ home, args: ["install"] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(globalConfigPath(home)).thresholds.five_hour_warning, 90);
});

// --- BUG-QA-03: disable --rmhandoff keeps a non-empty storage dir and says so ---

test("QA-03: disable --rmhandoff keeps the storage dir when other files remain", () => {
  const home = tempDir();
  const cwd = makeProject("qa03");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);

  const handoffPath = projectHandoffPath(home, cwd);
  // Real content so `enable --force` leaves a .before-force backup in the dir.
  fs.writeFileSync(handoffPath, "custom handoff content\n");
  assert.equal(runCli({ home, cwd, args: ["enable", "--force"] }).status, 0);

  const dir = path.dirname(handoffPath);
  const backups = fs.readdirSync(dir).filter((name) => name.includes(".before-force."));
  assert.equal(backups.length, 1, `expected one --force backup in ${dir}, saw ${fs.readdirSync(dir).join(", ")}`);

  const result = runCli({ home, cwd, args: ["disable", "--rmhandoff"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /handoff file: removed /);
  assert.ok(
    result.stdout.includes(`handoff directory: kept ${dir} (contains other files, such as --force backups)`),
    result.stdout
  );
  assert.doesNotMatch(result.stdout, /handoff directory: removed because it was empty/);
  // The handoff file is gone, but the dir and its other files survive.
  assert.equal(fs.existsSync(handoffPath), false);
  assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.existsSync(path.join(dir, backups[0])), true);
});

// --- BUG-QA-04: doctor explains a missing settings.json ---

test("QA-04: doctor explains a missing Claude Code settings.json", () => {
  const home = tempDir();
  // No settings.json anywhere under this HOME.
  const result = runCli({ home, args: ["doctor"] });
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /warn: Claude Code settings - not found at .*settings\.json; run Claude Code once \(or ccg install\) to create it/
  );
});

// --- BUG-QA-05: doctor/status name the missing hook events, not "none" ---

test("QA-05: doctor and status name the missing hook events instead of contradicting themselves", () => {
  const home = tempDir();
  const cwd = makeProject("qa05");
  writeSettings(home, {});
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  // Project stays enabled, but its settings.local.json disappears entirely.
  fs.rmSync(projectLocalSettingsPath(cwd), { force: true });

  const doctor = runCli({ home, cwd, args: ["doctor"] });
  assert.match(doctor.stdout, /missing events from .*settings\.local\.json: Stop, PostToolBatch; run ccg enable again/);
  assert.doesNotMatch(doctor.stdout, /missing events from .*: none/);

  const status = runCli({ home, cwd, args: ["status"] });
  assert.match(status.stdout, /project hook events: installed none; missing Stop, PostToolBatch/);
  assert.doesNotMatch(status.stdout, /project hook events: installed none; missing none/);
});

// --- BUG-QA-07: Ctrl+D during an interactive prompt yields a clear message ---

test("QA-07: install prompt turns a Ctrl+D abort into a clear cancellation message", async () => {
  const { input, output } = fakeTtyPair();
  await assert.rejects(
    resolveInstallThresholds({
      options: parseInstallOptions(["--reconfigure"]),
      configState: { exists: true, legacy: false, config: { thresholds: { five_hour_warning: 66 } } },
      input,
      output,
      ask: abortingAsk(output)
    }),
    /Cancelled; no changes were made\./
  );
});

test("QA-07: a non-abort question error propagates unchanged", async () => {
  const { input, output } = fakeTtyPair();
  const boom = async (prompt) => {
    output.write(prompt);
    throw new Error("disk exploded");
  };
  await assert.rejects(
    resolveInstallThresholds({
      options: parseInstallOptions(["--reconfigure"]),
      configState: { exists: true, legacy: false, config: { thresholds: { five_hour_warning: 66 } } },
      input,
      output,
      ask: boom
    }),
    /disk exploded/
  );
});

// --- BUG-QA-08: usage on a corrupt usage-state.json explains recovery ---

test("QA-08: usage on a corrupt usage-state.json explains recovery instead of a raw JSON error", () => {
  const home = tempDir();
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "usage-state.json"), "{ this is not valid json");

  const result = runCli({ home, args: ["usage"] });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /usage-state\.json is corrupt: .*is not valid JSON/);
  assert.match(
    result.stdout,
    /It will be rewritten on the next statusLine refresh\. Run ccg doctor for more detail\./
  );
});
