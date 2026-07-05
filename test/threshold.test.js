import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateUsageThreshold } from "../src/threshold.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "claude-cache-guard.js");

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccg-threshold-"));
}

function writeUsageState(home, state) {
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "usage-state.json"), JSON.stringify(state, null, 2));
}

function runCli(home, args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    env: { ...process.env, HOME: home },
    encoding: "utf8"
  });
}

function usageState(fiveHourUsed, sevenDayUsed = 22) {
  return {
    source: "claude-code-statusLine",
    updated_at: "2026-06-13T12:00:00.000Z",
    model: {
      id: "claude-opus-4-6",
      display_name: "Opus 4.6"
    },
    context_window: {
      used_percentage: 30
    },
    five_hour: {
      used_percentage: fiveHourUsed,
      resets_at: "2999-06-13T17:00:00Z"
    },
    seven_day: {
      used_percentage: sevenDayUsed,
      resets_at: "2026-06-18T09:00:00Z"
    }
  };
}

test("evaluateUsageThreshold is directly testable", () => {
  const result = evaluateUsageThreshold(usageState(76), { fiveHourThreshold: 75 });
  assert.equal(result.status, "warning");
  assert.equal(result.exitCode, 1);
  assert.equal(result.five_hour.used_percentage, 76);
});

test("evaluateUsageThreshold treats usage as stale after five-hour reset time", () => {
  const state = usageState(97);
  state.five_hour.resets_at = "2026-06-15T12:00:00Z";
  const result = evaluateUsageThreshold(state, {
    fiveHourThreshold: 97,
    now: "2026-06-15T12:00:00Z"
  });
  assert.equal(result.status, "stale");
  assert.equal(result.exitCode, 3);
  assert.equal(result.five_hour.used_percentage, 97);
  assert.match(result.message, /stale/);
});

test("check-threshold: 5h 20 threshold 75 returns ok exit 0", () => {
  const home = tempHome();
  writeUsageState(home, usageState(20));
  const result = runCli(home, ["check-threshold", "--five-hour", "75"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status: ok/);
  assert.match(result.stdout, /5h usage: 20%/);
  assert.match(result.stdout, /threshold: 75%/);
});

test("check-threshold: 5h 76 threshold 75 returns warning exit 1", () => {
  const home = tempHome();
  writeUsageState(home, usageState(76));
  const result = runCli(home, ["check-threshold", "--five-hour", "75"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /status: warning/);
  assert.match(result.stdout, /You should update next_session\.md soon\./);
});

test("check-threshold: past 5h reset time returns stale exit 3", () => {
  const home = tempHome();
  const state = usageState(97);
  state.five_hour.resets_at = "2000-01-01T00:00:00Z";
  writeUsageState(home, state);
  const result = runCli(home, ["check-threshold", "--five-hour", "97"]);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /status: stale/);
  assert.match(result.stdout, /5h usage: stale 97% \(reset time passed\)/);
  assert.match(result.stdout, /statusLine guard refreshes usage-state\.json/);
});

test("check-threshold: missing usage-state.json returns unavailable exit 3", () => {
  const home = tempHome();
  const result = runCli(home, ["check-threshold"]);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /status: unavailable/);
});

test("check-threshold: invalid JSON returns unavailable exit 3", () => {
  const home = tempHome();
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "usage-state.json"), "{not json");
  const result = runCli(home, ["check-threshold"]);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /status: unavailable/);
});

test("check-threshold --json outputs valid JSON", () => {
  const home = tempHome();
  writeUsageState(home, usageState(76, 22));
  const result = runCli(home, ["check-threshold", "--five-hour", "75", "--seven-day", "80", "--json"]);
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed, {
    status: "warning",
    five_hour: {
      used_percentage: 76,
      threshold: 75
    },
    seven_day: {
      used_percentage: 22,
      threshold: 80
    },
    message: "You should update next_session.md soon."
  });
});

test("check-threshold unavailable when five_hour.used_percentage is missing", () => {
  const home = tempHome();
  const state = usageState(20);
  delete state.five_hour.used_percentage;
  writeUsageState(home, state);
  const result = runCli(home, ["check-threshold"]);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /status: unavailable/);
});

test("check-threshold: an invalid flag value exits 2 (distinct from warning's exit 1)", () => {
  const home = tempHome();
  writeUsageState(home, usageState(95));
  const result = runCli(home, ["check-threshold", "--five-hour", "abc"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /must be a number from 0 to 100/);
});
