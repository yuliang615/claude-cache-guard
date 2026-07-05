import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "claude-cache-guard.js");

// --- Behavioral proof that the re-arm actually happens in one window ---

function tempDir(prefix = "ccg-ask-rearm-") {
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

function writeUsageState(home, fiveHour, { resetsAt = "2999-06-13T17:00:00Z" } = {}) {
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "usage-state.json"),
    JSON.stringify({
      source: "claude-code-statusLine",
      updated_at: new Date().toISOString(),
      model: { id: "claude-opus-4-6", display_name: "Opus 4.6" },
      context_window: { used_percentage: 30 },
      five_hour: { used_percentage: fiveHour, resets_at: resetsAt },
      seven_day: { used_percentage: 22, resets_at: "2026-06-18T09:00:00Z" }
    })
  );
}

function runHook({ home, cwd, sessionId }) {
  return runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, cwd })
  });
}

test("ask mode re-arms within the same window when usage dips below then crosses again", () => {
  const home = tempDir();
  const cwd = makeProject("ask rearm");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  const setMode = runCli({ home, cwd, args: ["setting", "--five-hour-warning", "90", "--on-warning", "ask"] });
  assert.equal(setMode.status, 0, setMode.stderr);

  // Same window (identical resets_at) throughout: 95 -> 50 -> 95.
  const resetsAt = "2999-06-13T17:00:00Z";

  // 1) Above threshold: ask fires with a CHOICE.
  writeUsageState(home, 95, { resetsAt });
  const first = runHook({ home, cwd, sessionId: "A" });
  assert.equal(first.status, 0, first.stderr);
  const firstOut = JSON.parse(first.stdout);
  assert.match(firstOut.hookSpecificOutput.additionalContext, /Claude Cache Guard CHOICE/);
  assert.match(firstOut.hookSpecificOutput.additionalContext, /may ask once more/);

  // 2) Below threshold in the SAME window: the episode is disarmed (silent no-op).
  writeUsageState(home, 50, { resetsAt });
  const dip = runHook({ home, cwd, sessionId: "B" });
  assert.equal(dip.status, 0, dip.stderr);
  assert.equal(dip.stdout, "");

  // 3) Crosses the threshold again in the SAME window: ask fires ONCE MORE, proving the
  // re-arm behavior and that the reminder's wording no longer over-promises.
  writeUsageState(home, 95, { resetsAt });
  const second = runHook({ home, cwd, sessionId: "C" });
  assert.equal(second.status, 0, second.stderr);
  const secondOut = JSON.parse(second.stdout);
  assert.match(secondOut.hookSpecificOutput.additionalContext, /Claude Cache Guard CHOICE/);
  assert.match(secondOut.hookSpecificOutput.additionalContext, /may ask once more/);
});
