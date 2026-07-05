import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  addUsageHandoffHooks,
  removeUsageHandoffHooks,
  getProjectLocalSettingsPath
} from "../src/project-hooks.js";
import { isBridgeStatusLine } from "../src/settings.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "claude-cache-guard.js");

// The legacy bin name from before the project was renamed to claude-cache-guard. A hook or
// statusLine left pointing here crashes with MODULE_NOT_FOUND because the file no longer exists.
const LEGACY_HOOK = 'node "/Users/someone/claude_usage/bin/claude-usage-bridge.js" hook usage-handoff';
const LEGACY_STATUSLINE = 'node "/Users/someone/claude_usage/bin/claude-usage-bridge.js" statusline';

function tempHome() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccg-legacy-home-")));
}

function makeProject(name = "legacy-project") {
  const cwd = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccg-legacy-")), name);
  fs.mkdirSync(cwd, { recursive: true });
  return fs.realpathSync(cwd);
}

function runCli({ home, cwd, args }) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    encoding: "utf8"
  });
}

function countHookCommands(settings, eventName) {
  return (settings.hooks?.[eventName] ?? []).flatMap((entry) => entry.hooks ?? []).length;
}

test("bare legacy/current names are recognized, hyphen-prefixed lookalikes are not", () => {
  const mine = (command) => ({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } });
  // Bare names that ARE the guard (current + legacy) must be stripped.
  for (const cmd of ["cub hook usage-handoff", "ccg hook usage-handoff", "claude-usage-bridge hook usage-handoff"]) {
    assert.equal(removeUsageHandoffHooks(mine(cmd)).removed, true, cmd);
  }
  // Lookalikes preceded by a word char or hyphen must be left untouched.
  for (const cmd of ["my-ccg hook usage-handoff", "xcub hook usage-handoff", "notccg hook usage-handoff"]) {
    assert.equal(removeUsageHandoffHooks(mine(cmd)).removed, false, cmd);
  }
  // Lookalikes with a LONGER subcommand token must also be left untouched: the guard's
  // real command ends exactly at "usage-handoff", so "usage-handoff-extra"/"usage-handoffX"
  // are different (third-party) commands and must not be stripped.
  for (const cmd of ["ccg hook usage-handoff-extra", "ccg hook usage-handoffX", "cub hook usage-handoff-2"]) {
    assert.equal(removeUsageHandoffHooks(mine(cmd)).removed, false, cmd);
  }
  // The legitimate form with trailing whitespace still matches.
  assert.equal(removeUsageHandoffHooks(mine("ccg hook usage-handoff ")).removed, true);
});

test("isBridgeStatusLine recognizes legacy bin and bare cub, not lookalikes", () => {
  assert.equal(isBridgeStatusLine({ type: "command", command: LEGACY_STATUSLINE }), true);
  assert.equal(isBridgeStatusLine({ type: "command", command: "cub statusline" }), true);
  assert.equal(isBridgeStatusLine({ type: "command", command: "my-ccg statusline" }), false);
});

test("enable replaces a leftover legacy hook with the current command (no broken duplicate)", () => {
  const home = tempHome();
  const cwd = makeProject();
  // Simulate the post-rename state: settings.local.json still carries the legacy hook on
  // both events, exactly what caused "Ran 2 stop hooks" + MODULE_NOT_FOUND.
  const settingsPath = getProjectLocalSettingsPath(cwd);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const seeded = addUsageHandoffHooks({}, LEGACY_HOOK);
  fs.writeFileSync(settingsPath, JSON.stringify(seeded, null, 2));

  const result = runCli({ home, cwd, args: ["enable"] });
  assert.equal(result.status, 0, result.stderr);

  const raw = fs.readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(raw);
  // No legacy reference survives anywhere in the file.
  assert.equal(raw.includes("claude-usage-bridge"), false);
  // Exactly one managed hook per event — not a duplicate stacked next to the legacy one.
  assert.equal(countHookCommands(settings, "Stop"), 1);
  assert.equal(countHookCommands(settings, "PostToolBatch"), 1);
  assert.match(settings.hooks.Stop[0].hooks[0].command, /claude-cache-guard\.js" hook usage-handoff/);
});
