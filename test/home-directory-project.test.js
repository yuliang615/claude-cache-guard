import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  installGlobalSlashCommands,
  removeProjectSlashCommands,
  countProjectSlashCommands,
  projectCommandsDirIsGlobal,
  SLASH_COMMAND_NAMES,
} from "../src/project-hooks.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "claude-cache-guard.js");

// Incident (2026-07-05): claude launched in the home directory makes the home
// dir the project, so the "project-local" .claude/commands IS ~/.claude/commands.
// `ccg enable`'s migration sweep then saw the freshly installed GLOBAL command
// set as per-project leftovers and deleted it — /ccgconfig became "Unknown
// command" mid-session, right after /ccgenable. These tests pin the fix: every
// project-scoped sweep must be a no-op when the project commands dir resolves
// to the global one.

function tempHome() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccg-home-")));
}

function globalCommandsDirOf(home) {
  return path.join(home, ".claude", "commands");
}

function runCli({ home, cwd, args }) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

test("projectCommandsDirIsGlobal: true for the home dir, false for a real project", async () => {
  const home = tempHome();
  assert.equal(await projectCommandsDirIsGlobal({ cwd: home, homeDir: home }), true);

  const project = path.join(home, "some-project");
  fs.mkdirSync(project, { recursive: true });
  assert.equal(await projectCommandsDirIsGlobal({ cwd: project, homeDir: home }), false);
});

test("projectCommandsDirIsGlobal survives a symlinked home path", async () => {
  const home = tempHome();
  fs.mkdirSync(globalCommandsDirOf(home), { recursive: true });
  const link = path.join(tempHome(), "home-link");
  fs.symlinkSync(home, link);
  assert.equal(await projectCommandsDirIsGlobal({ cwd: link, homeDir: home }), true);
});

test("removeProjectSlashCommands is a no-op on the global dir and says so", async () => {
  const home = tempHome();
  await installGlobalSlashCommands({ homeDir: home });

  const result = await removeProjectSlashCommands({ cwd: home, homeDir: home });

  assert.equal(result.skippedGlobalDir, true);
  assert.deepEqual(result.results, []);
  for (const name of SLASH_COMMAND_NAMES) {
    const p = path.join(globalCommandsDirOf(home), `${name}.md`);
    assert.equal(fs.existsSync(p), true, `${name}.md must survive the project sweep`);
  }
});

test("countProjectSlashCommands does not count the global set as leftovers", async () => {
  const home = tempHome();
  await installGlobalSlashCommands({ homeDir: home });
  assert.equal(await countProjectSlashCommands({ cwd: home, homeDir: home }), 0);
});

test("ccg enable run in the home directory keeps every global command (incident regression)", async () => {
  const home = tempHome();
  await installGlobalSlashCommands({ homeDir: home });

  const res = runCli({ home, cwd: home, args: ["enable"] });

  assert.equal(res.status, 0, `enable must succeed:\n${res.stdout}\n${res.stderr}`);
  assert.doesNotMatch(res.stdout, /removed \d+ project-local ccg command/, "the migration sweep must not fire");
  for (const name of SLASH_COMMAND_NAMES) {
    const p = path.join(globalCommandsDirOf(home), `${name}.md`);
    assert.equal(fs.existsSync(p), true, `${name}.md must still exist after enable in ~`);
  }
});

test("ccg disable run in the home directory keeps the global commands and explains why", async () => {
  const home = tempHome();
  await installGlobalSlashCommands({ homeDir: home });
  const enable = runCli({ home, cwd: home, args: ["enable"] });
  assert.equal(enable.status, 0, `enable must succeed first:\n${enable.stdout}\n${enable.stderr}`);

  const res = runCli({ home, cwd: home, args: ["disable"] });

  assert.equal(res.status, 0, `disable must succeed:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /slash commands: kept .*ccg uninstall removes it/);
  for (const name of SLASH_COMMAND_NAMES) {
    const p = path.join(globalCommandsDirOf(home), `${name}.md`);
    assert.equal(fs.existsSync(p), true, `${name}.md must still exist after disable in ~`);
  }
});
