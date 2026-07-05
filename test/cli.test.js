import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SLASH_COMMAND_NAMES } from "../src/project-hooks.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "claude-cache-guard.js");

function runCli(home, args, input) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    env: { ...process.env, HOME: home },
    input,
    encoding: "utf8"
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("install patches only statusLine and uninstall restores previous statusLine", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccg-"));
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.json");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        permissions: { allow: ["Bash(ls:*)"] },
        model: "opus",
        language: "zh-TW",
        theme: "dark",
        plugins: { example: true },
        hooks: { Stop: [] },
        statusLine: {
          type: "command",
          command: "printf old-status",
          padding: 2
        }
      },
      null,
      2
    )
  );

  const install = runCli(home, ["install"]);
  assert.equal(install.status, 0, install.stderr);
  const installedSettings = readJson(settingsPath);
  assert.deepEqual(installedSettings.permissions, { allow: ["Bash(ls:*)"] });
  assert.equal(installedSettings.model, "opus");
  assert.equal(installedSettings.language, "zh-TW");
  assert.equal(installedSettings.theme, "dark");
  assert.deepEqual(installedSettings.plugins, { example: true });
  assert.deepEqual(installedSettings.hooks, { Stop: [] });
  assert.match(installedSettings.statusLine.command, /claude-cache-guard\.js" statusline/);
  assert.equal(installedSettings.statusLine.padding, 2);

  const config = readJson(path.join(claudeDir, "cache-guard", "config.json"));
  assert.equal(config.version, 1);
  assert.equal(config.thresholds.five_hour_warning, 90);
  assert.equal(config.thresholds.five_hour_critical, undefined);
  const installState = readJson(path.join(claudeDir, "cache-guard", "install-state.json"));
  assert.equal(installState.previousStatusLine.command, "printf old-status");
  assert.ok(installState.lastBackupPath);
  assert.equal(fs.existsSync(installState.lastBackupPath), true);

  const uninstall = runCli(home, ["uninstall"]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  const uninstalledSettings = readJson(settingsPath);
  assert.equal(uninstalledSettings.statusLine.command, "printf old-status");
  assert.deepEqual(uninstalledSettings.permissions, { allow: ["Bash(ls:*)"] });
});

test("install writes the global slash commands and plain uninstall removes them", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccg-"));
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({ statusLine: { type: "command", command: "printf old-status" } })
  );
  const commandsDir = path.join(claudeDir, "commands");

  const install = runCli(home, ["install"]);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /slash commands: .*\.claude\/commands \(8 commands\)/);
  assert.match(install.stdout, /available: \/ccgresume/);
  assert.match(install.stdout, /slash commands load when the claude process starts/);

  // All 8 ccg*.md are installed globally.
  const installedFiles = fs.readdirSync(commandsDir).filter((f) => f.startsWith("ccg")).sort();
  assert.deepEqual(installedFiles, SLASH_COMMAND_NAMES.map((n) => `${n}.md`).sort());
  assert.equal(SLASH_COMMAND_NAMES.length, 8);
  // ccgresume no longer bakes in a per-project handoff path.
  const resume = fs.readFileSync(path.join(commandsDir, "ccgresume.md"), "utf8");
  assert.ok(resume.includes("!`ccg resume"));
  assert.doesNotMatch(resume, /undefined/);

  const uninstall = runCli(home, ["uninstall"]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.match(uninstall.stdout, /slash commands: removed 8/);
  assert.equal(fs.existsSync(commandsDir), false, "empty commands dir cleaned up on uninstall");
  // ~/.claude itself must survive (holds settings.json).
  assert.equal(fs.existsSync(claudeDir), true);
  assert.equal(fs.existsSync(path.join(claudeDir, "settings.json")), true);
});

test("uninstall keeps a user-authored same-name file in ~/.claude/commands", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccg-"));
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({ statusLine: { type: "command", command: "printf old-status" } })
  );
  const commandsDir = path.join(claudeDir, "commands");
  fs.mkdirSync(commandsDir, { recursive: true });
  const userBody = "my own hand-written ccgstatus\n";
  fs.writeFileSync(path.join(commandsDir, "ccgstatus.md"), userBody);

  // install backs up the user's file (renamed aside) and drops the generated one.
  assert.equal(runCli(home, ["install"]).status, 0);
  const backups = fs.readdirSync(commandsDir).filter((f) => f.startsWith("ccgstatus.md.bak-"));
  assert.equal(backups.length, 1);

  // The user re-adds their own ccgstatus.md alongside the generated command.
  fs.writeFileSync(path.join(commandsDir, "ccgstatus.md"), userBody);
  // Make it non-managed again so uninstall recognizes it as the user's.
  const uninstall = runCli(home, ["uninstall"]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.match(uninstall.stdout, /slash command kept: ccgstatus\.md is not ccg-managed — left in place/);
  assert.equal(fs.existsSync(path.join(commandsDir, "ccgstatus.md")), true, "user file survives");
  assert.equal(fs.readFileSync(path.join(commandsDir, "ccgstatus.md"), "utf8"), userBody);
  // The generated ccg commands are gone; the dir remains because the user file is there.
  assert.equal(fs.existsSync(path.join(commandsDir, "ccgresume.md")), false);
  assert.equal(fs.existsSync(commandsDir), true);
});

test("uninstall --rmconfig is still accepted and removes the global config (now the default)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccg-"));
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.json");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      statusLine: {
        type: "command",
        command: "printf old-status"
      }
    })
  );

  const install = runCli(home, ["install", "--five-hour-warning", "80"]);
  assert.equal(install.status, 0, install.stderr);
  const configPath = path.join(claudeDir, "cache-guard", "config.json");
  assert.equal(readJson(configPath).thresholds.five_hour_warning, 80);

  // The now-redundant --rmconfig flag must not error, and the config (like the
  // whole cache-guard dir) is gone afterward.
  const uninstall = runCli(home, ["uninstall", "--rmconfig"]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.match(uninstall.stdout, /guard files: removed/);
  assert.equal(fs.existsSync(configPath), false);
  assert.equal(fs.existsSync(path.join(claudeDir, "cache-guard")), false);
  assert.equal(readJson(settingsPath).statusLine.command, "printf old-status");
});

test("plain uninstall is a full restore: cache-guard dir and usage-state gone, statusLine restored, handoffs kept", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccg-"));
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.json");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ statusLine: { type: "command", command: "printf old-status" } })
  );

  assert.equal(runCli(home, ["install", "--five-hour-warning", "90"]).status, 0);

  // Drive one statusLine refresh so usage-state.json actually exists.
  const input = JSON.stringify({
    model: { id: "claude-opus-4-6", display_name: "Opus 4.6" },
    context_window: { used_percentage: 30 },
    rate_limits: {
      five_hour: { used_percentage: 50, resets_at: "2999-06-13T17:00:00Z" },
      seven_day: { used_percentage: 20, resets_at: "2999-06-18T09:00:00Z" }
    }
  });
  assert.equal(runCli(home, ["statusline"], input).status, 0);

  const statePath = path.join(claudeDir, "usage-state.json");
  const bridgeDir = path.join(claudeDir, "cache-guard");
  assert.equal(fs.existsSync(statePath), true);
  assert.equal(fs.existsSync(bridgeDir), true);

  // A handoff work product must survive the uninstall.
  const handoffFile = path.join(claudeDir, "next-session", "proj--abcdef12", "next_session.md");
  fs.mkdirSync(path.dirname(handoffFile), { recursive: true });
  fs.writeFileSync(handoffFile, "keep me");

  const uninstall = runCli(home, ["uninstall"]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(fs.existsSync(bridgeDir), false, "cache-guard dir must be gone");
  assert.equal(fs.existsSync(statePath), false, "usage-state.json must be gone");
  assert.equal(readJson(settingsPath).statusLine.command, "printf old-status");
  assert.equal(fs.existsSync(handoffFile), true, "handoff work product must be kept");
  assert.match(uninstall.stdout, /handoff files: kept/);
  assert.doesNotMatch(uninstall.stdout, /To restore the install-time backup/);
});

// Recursively search a directory tree for a string in any file's contents.
function treeContains(dir, needle) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (treeContains(full, needle)) return true;
    } else if (entry.isFile()) {
      if (fs.readFileSync(full, "utf8").includes(needle)) return true;
    }
  }
  return false;
}

// FIX 4: uninstall --remove must NOT destroy the only recovery copy of the
// pre-install statusLine. --remove deletes (does not restore) the statusLine, so
// install-state.json + backups/ are the sole record of the user's original — they
// must survive, and the original statusLine string must stay findable under HOME.
test("uninstall --remove keeps backups and install-state so the original statusLine stays recoverable", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccg-"));
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.json");
  const customCommand = "printf CUSTOM_STATUSLINE_XYZ";
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ statusLine: { type: "command", command: customCommand } })
  );

  assert.equal(runCli(home, ["install", "--five-hour-warning", "90"]).status, 0);
  const bridgeDir = path.join(claudeDir, "cache-guard");
  const backupsDir = path.join(bridgeDir, "backups");
  const installStatePath = path.join(bridgeDir, "install-state.json");
  const commandsDir = path.join(claudeDir, "commands");
  assert.equal(fs.existsSync(installStatePath), true);
  // install created the global slash commands.
  assert.equal(fs.existsSync(path.join(commandsDir, "ccgresume.md")), true);

  const uninstall = runCli(home, ["uninstall", "--remove"]);
  assert.equal(uninstall.status, 0, uninstall.stderr);

  // The statusLine was removed (not restored) from settings.json.
  assert.equal(fs.existsSync(settingsPath), true);
  assert.equal(readJson(settingsPath).statusLine, undefined);
  assert.match(uninstall.stdout, /statusLine: removed/);

  // Global slash commands carry no recovery value, so the --remove path removes
  // them too (while keeping the statusLine recovery copies below).
  assert.match(uninstall.stdout, /slash commands: removed 8/);
  assert.equal(fs.existsSync(commandsDir), false, "global commands removed on --remove path");

  // The recovery copies survive: backups/ and install-state.json still exist.
  assert.equal(fs.existsSync(backupsDir), true, "backups dir must be kept");
  assert.equal(fs.existsSync(installStatePath), true, "install-state.json must be kept");
  assert.match(uninstall.stdout, /pre-install settings backup/);
  assert.match(uninstall.stdout, /To restore the install-time backup:/);

  // Disposable state is still cleaned up.
  assert.equal(fs.existsSync(path.join(claudeDir, "usage-state.json")), false);
  assert.equal(fs.existsSync(path.join(bridgeDir, "config.json")), false);

  // The original statusLine command is still findable somewhere under HOME.
  assert.equal(treeContains(home, customCommand), true, "original statusLine must remain recoverable under HOME");
});

test("statusline writes usage-state atomically and prints prior statusLine output", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccg-"));
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(path.join(claudeDir, "cache-guard"), { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "cache-guard", "config.json"),
    JSON.stringify({
      previousStatusLine: {
        type: "command",
        command: "node -e \"process.stdin.resume(); process.stdin.on('end', () => console.log('previous-ok'))\""
      }
    })
  );
  const input = JSON.stringify({
    model: { id: "claude-opus-4-6", display_name: "Opus 4.6" },
    context_window: { used_percentage: 41.2 },
    rate_limits: {
      five_hour: { used_percentage: 76, resets_at: "2026-06-13T17:00:00Z" },
      seven_day: { used_percentage: 32, resets_at: "2026-06-18T09:00:00Z" }
    },
    oauth_token: "must-not-copy"
  });

  const result = runCli(home, ["statusline"], input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "previous-ok");

  const state = readJson(path.join(claudeDir, "usage-state.json"));
  assert.equal(state.five_hour.used_percentage, 76);
  assert.equal(state.seven_day.used_percentage, 32);
  assert.equal(JSON.stringify(state).includes("must-not-copy"), false);
});

test("uninstall leaves a user-replaced statusLine untouched and reports it as unchanged", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccg-"));
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: "command", command: "printf orig" } }));

  assert.equal(runCli(home, ["install", "--five-hour-warning", "90"]).status, 0);
  // The user manually replaces the guard statusLine with their own command.
  const installed = readJson(settingsPath);
  installed.statusLine = { type: "command", command: "printf USER_CUSTOM" };
  fs.writeFileSync(settingsPath, JSON.stringify(installed));

  const uninstall = runCli(home, ["uninstall"]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.match(uninstall.stdout, /statusLine: unchanged/);
  assert.doesNotMatch(uninstall.stdout, /previous statusLine: restored/);
  assert.doesNotMatch(uninstall.stdout, /statusLine: removed/);
  assert.equal(readJson(settingsPath).statusLine.command, "printf USER_CUSTOM");
});

test("statusline records usage-state write failures instead of failing silently", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccg-"));
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  // Make the usage-state.json path a directory so the atomic write/rename fails.
  fs.mkdirSync(path.join(claudeDir, "usage-state.json"), { recursive: true });

  const input = JSON.stringify({
    model: { display_name: "Opus" },
    context_window: { used_percentage: 10 },
    rate_limits: { five_hour: { used_percentage: 50, resets_at: "2026-06-13T17:00:00Z" } }
  });
  const result = runCli(home, ["statusline"], input);
  // The status line must never break Claude Code, even when the write fails.
  assert.equal(result.status, 0, result.stderr);
  const log = fs.readFileSync(path.join(claudeDir, "cache-guard", "hook-errors.log"), "utf8");
  assert.match(log, /usage-state write failed/);
});
