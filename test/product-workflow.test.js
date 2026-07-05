import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_GLOBAL_CONFIG,
  disableProject,
  enableProject,
  getProjectConfigPath,
  getProjectState,
  mergeConfig,
  thresholdOptionsFromConfig
} from "../src/config.js";
import { getProjectInfo } from "../src/handoff.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "claude-cache-guard.js");

function tempDir(prefix = "ccg-product-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeProject(name = "project") {
  const cwd = path.join(tempDir(), name);
  fs.mkdirSync(cwd, { recursive: true });
  return fs.realpathSync(cwd);
}

function runCli({ home, cwd = root, args, input, env = {} }) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, HOME: home, ...env },
    input,
    encoding: "utf8"
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeUsageState(home, fiveHour = 76, sevenDay = 22, options = {}) {
  // The hook only acts on FRESH usage data, so default updated_at to "now" (real time,
  // because the hook runs as a child process using the real clock). Tests that need
  // stale data pass an explicit updatedAt. resetsAt identifies the 5-hour window.
  const { updatedAt = new Date().toISOString(), resetsAt = "2999-06-13T17:00:00Z" } = options;
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "usage-state.json"),
    JSON.stringify({
      source: "claude-code-statusLine",
      updated_at: updatedAt,
      model: { id: "claude-opus-4-6", display_name: "Opus 4.6" },
      context_window: { used_percentage: 30 },
      five_hour: { used_percentage: fiveHour, resets_at: resetsAt },
      seven_day: { used_percentage: sevenDay, resets_at: "2026-06-18T09:00:00Z" }
    })
  );
}

function setFiveHourResetTime(home, resetsAt) {
  const statePath = path.join(home, ".claude", "usage-state.json");
  const state = readJson(statePath);
  state.five_hour.resets_at = resetsAt;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function projectHandoffPath(home, cwd) {
  const config = readJson(path.join(cwd, ".claude-cache-guard.json"));
  return path.join(home, ".claude", "next-session", config.project_id, "next_session.md");
}

function completeHandoffMarkdown(label = "ready") {
  return `# Next Session Handoff

## Snapshot
${label}

## Original User Prompts
1. /goal do the thing exactly as I typed it.

## What Changed
None.

## Current State
Ready.

## Decisions And Rationale
None.

## Files And Artifacts
None.

## Commands And Verification
None.

## Open Questions
None.

## Risks And Caveats
None.

## Do Not Repeat
None.

## Next Steps
1. Continue.

## Resume Prompt
Read this handoff and continue.
`;
}

test("config path and show are read-only when global config is missing", () => {
  const home = tempDir();
  const pathResult = runCli({ home, args: ["config", "path"] });
  assert.equal(pathResult.status, 0, pathResult.stderr);
  assert.equal(pathResult.stdout.trim(), path.join(home, ".claude", "cache-guard", "config.json"));

  const showResult = runCli({ home, args: ["config", "show"] });
  assert.equal(showResult.status, 0, showResult.stderr);
  assert.deepEqual(JSON.parse(showResult.stdout), DEFAULT_GLOBAL_CONFIG);
  assert.equal(fs.existsSync(pathResult.stdout.trim()), false);
});

test("install keeps existing config values and removes retired threshold fields", () => {
  const home = tempDir();
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(path.join(claudeDir, "cache-guard"), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({}));
  const configPath = path.join(claudeDir, "cache-guard", "config.json");
  const customConfig = {
    version: 1,
    thresholds: { five_hour_warning: 60, five_hour_critical: 85, seven_day_warning: null },
    handoff: { storage_dir: "~/.claude/custom-handoff", file_name: "handoff.md", mode: "manual", max_lines: 150 },
    actions: { on_warning: "custom_warning", on_critical: "custom_critical" }
  };
  fs.writeFileSync(configPath, JSON.stringify(customConfig, null, 2));

  const install = runCli({ home, args: ["install"] });
  assert.equal(install.status, 0, install.stderr);
  assert.deepEqual(readJson(configPath), {
    version: 1,
    thresholds: { five_hour_warning: 60, seven_day_warning: null },
    handoff: { storage_dir: "~/.claude/custom-handoff", file_name: "handoff.md", mode: "manual", max_lines: 150 },
    actions: { on_warning: "custom_warning" }
  });
});

test("install threshold flag writes custom warning threshold", () => {
  const home = tempDir();
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({}));
  const result = runCli({ home, args: ["install", "--five-hour-warning", "65"] });
  assert.equal(result.status, 0, result.stderr);
  const config = readJson(path.join(claudeDir, "cache-guard", "config.json"));
  assert.equal(config.thresholds.five_hour_warning, 65);
  assert.equal(config.thresholds.five_hour_critical, undefined);
});

test("non-TTY install without flag writes default warning threshold", () => {
  const home = tempDir();
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({}));
  const result = runCli({ home, args: ["install"] });
  assert.equal(result.status, 0, result.stderr);
  const config = readJson(path.join(claudeDir, "cache-guard", "config.json"));
  assert.equal(config.thresholds.five_hour_warning, 90);
  assert.equal(config.thresholds.five_hour_critical, undefined);
});

test("install with existing config keeps existing warning threshold", () => {
  const home = tempDir();
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(path.join(claudeDir, "cache-guard"), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({}));
  const configPath = path.join(claudeDir, "cache-guard", "config.json");
  const customConfig = {
    ...DEFAULT_GLOBAL_CONFIG,
    thresholds: { ...DEFAULT_GLOBAL_CONFIG.thresholds, five_hour_warning: 55 }
  };
  fs.writeFileSync(configPath, JSON.stringify(customConfig, null, 2));
  const result = runCli({ home, args: ["install", "--five-hour-warning", "65"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already exists/);
  assert.match(result.stdout, /run ccg uninstall before reinstalling/);
  assert.equal(readJson(configPath).thresholds.five_hour_warning, 55);
});

test("install --reconfigure updates existing global thresholds and preserves other config", () => {
  const home = tempDir();
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(path.join(claudeDir, "cache-guard"), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({}));
  const configPath = path.join(claudeDir, "cache-guard", "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...DEFAULT_GLOBAL_CONFIG,
      thresholds: { ...DEFAULT_GLOBAL_CONFIG.thresholds, five_hour_warning: 70, five_hour_critical: 90 },
      handoff: { ...DEFAULT_GLOBAL_CONFIG.handoff, max_lines: 150 }
    }, null, 2)
  );

  const result = runCli({
    home,
    args: ["install", "--reconfigure", "--five-hour-warning", "88"]
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reconfigured/);
  const config = readJson(configPath);
  assert.equal(config.thresholds.five_hour_warning, 88);
  assert.equal(config.thresholds.five_hour_critical, undefined);
  assert.equal(config.handoff.max_lines, 150);
});

test("config show is read-only for legacy install metadata", () => {
  const home = tempDir();
  const bridgeDir = path.join(home, ".claude", "cache-guard");
  fs.mkdirSync(bridgeDir, { recursive: true });
  const legacy = {
    managed_by: "claude-cache-guard",
    previousStatusLine: { type: "command", command: "printf old" },
    lastBackupPath: "/tmp/backup.json"
  };
  fs.writeFileSync(path.join(bridgeDir, "config.json"), JSON.stringify(legacy, null, 2));

  const result = runCli({ home, args: ["config", "show"] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), DEFAULT_GLOBAL_CONFIG);
  assert.deepEqual(readJson(path.join(bridgeDir, "config.json")), legacy);
  assert.equal(fs.existsSync(path.join(bridgeDir, "install-state.json")), false);
});

test("enable creates project config and handoff file", () => {
  const home = tempDir();
  const cwd = makeProject("enable project");
  const result = runCli({ home, cwd, args: ["enable"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Project enabled/);
  assert.match(result.stdout, /Claude Code v2\.1\.169\+ reloads hook settings automatically/);
  assert.match(result.stdout, /project settings: using global config/);
  assert.match(result.stdout, /run ccg setting/);

  const projectConfig = readJson(getProjectConfigPath(cwd));
  assert.equal(projectConfig.enabled, true);
  assert.equal(projectConfig.project_name, "enable project");
  assert.match(projectConfig.project_id, /^enable-project--[a-f0-9]{8}$/);
  assert.equal(projectConfig.handoff.file.startsWith("~/.claude/next-session/"), true);
  assert.deepEqual(projectConfig.overrides, {});

  const handoffPath = projectConfig.handoff.file.replace("~/", `${home}/`);
  assert.equal(fs.existsSync(handoffPath), true);
  assert.match(fs.readFileSync(handoffPath, "utf8"), /# Next Session Handoff/);

  const localSettings = readJson(path.join(cwd, ".claude", "settings.local.json"));
  assert.match(
    localSettings.hooks.Stop[0].hooks[0].command,
    /claude-cache-guard\.js" hook usage-handoff/
  );
  assert.match(
    localSettings.hooks.PostToolBatch[0].hooks[0].command,
    /claude-cache-guard\.js" hook usage-handoff/
  );
});

test("enable creates the handoff guidance starter + .bak but no project-local commands dir", () => {
  const home = tempDir();
  const cwd = makeProject("enable guidance");
  const result = runCli({ home, cwd, args: ["enable"] });
  assert.equal(result.status, 0, result.stderr);

  // Slash commands are global now (installed by ccg install); enable must not
  // create a project-local .claude/commands dir.
  assert.equal(fs.existsSync(path.join(cwd, ".claude", "commands")), false, "enable must not create project-local commands");
  assert.doesNotMatch(result.stdout, /available: \/ccg/, "enable no longer prints the slash-command list");

  // The comment-only guidance starter and its pristine .bak are created.
  const guidancePath = path.join(cwd, ".claude", "ccg-handoff.md");
  const backupPath = `${guidancePath}.bak`;
  assert.equal(fs.existsSync(guidancePath), true);
  assert.equal(fs.existsSync(backupPath), true);
  assert.match(result.stdout, /handoff guidance: .*ccg-handoff\.md \(edit it to add project-specific handoff reminders; restore from ccg-handoff\.md\.bak if you break it\)/);
  // It is comment-only, so status does NOT report guidance as active.
  const status = runCli({ home, cwd, args: ["status"] });
  assert.doesNotMatch(status.stdout, /handoff guidance: active/);

  // A user edits the guidance; re-enabling must not overwrite it or the .bak.
  fs.writeFileSync(guidancePath, "My real reminders.\n");
  fs.writeFileSync(backupPath, "my own bak content\n");
  assert.equal(runCli({ home, cwd, args: ["enable", "--force"] }).status, 0);
  assert.equal(fs.readFileSync(guidancePath, "utf8"), "My real reminders.\n", "user guidance preserved");
  assert.equal(fs.readFileSync(backupPath, "utf8"), "my own bak content\n", "user .bak not clobbered");
});

test("enable migrates project-local ccg commands from older versions while keeping a user same-name file", () => {
  const home = tempDir();
  const cwd = makeProject("enable migration");
  const commandsDir = path.join(cwd, ".claude", "commands");
  fs.mkdirSync(commandsDir, { recursive: true });
  // A managed ccg command left by an older per-project install (carries the marker).
  const managed = "---\n# managed by claude-cache-guard — regenerated by ccg enable\ndescription: old\ndisable-model-invocation: true\n---\nold body\n";
  fs.writeFileSync(path.join(commandsDir, "ccgstatus.md"), managed);
  fs.writeFileSync(path.join(commandsDir, "ccgusage.md"), managed);
  // A user's own same-name file (no marker) must survive.
  const userBody = "my own ccgresume, keep me\n";
  fs.writeFileSync(path.join(commandsDir, "ccgresume.md"), userBody);

  // The global set must exist before enable may sweep the project-local one.
  assert.equal(runCli({ home, cwd, args: ["install"] }).status, 0);
  const result = runCli({ home, cwd, args: ["enable"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /slash commands: removed 2 project-local ccg command\(s\) from a previous version/);

  // Managed leftovers are gone; the user's file is untouched.
  assert.equal(fs.existsSync(path.join(commandsDir, "ccgstatus.md")), false);
  assert.equal(fs.existsSync(path.join(commandsDir, "ccgusage.md")), false);
  assert.equal(fs.existsSync(path.join(commandsDir, "ccgresume.md")), true);
  assert.equal(fs.readFileSync(path.join(commandsDir, "ccgresume.md"), "utf8"), userBody);
});

test("enable keeps old project-local ccg commands when the global set is not installed yet", () => {
  // Upgrade path: the old per-project commands may be the user's ONLY copy.
  // Sweeping them before ccg install would leave zero /ccg* commands anywhere
  // (/ccgenable would delete itself mid-run).
  const home = tempDir();
  const cwd = makeProject("enable upgrade guard");
  const commandsDir = path.join(cwd, ".claude", "commands");
  fs.mkdirSync(commandsDir, { recursive: true });
  const managed = "---\n# managed by claude-cache-guard — regenerated by ccg enable\ndescription: old\ndisable-model-invocation: true\n---\nold body\n";
  fs.writeFileSync(path.join(commandsDir, "ccgstatus.md"), managed);
  fs.writeFileSync(path.join(commandsDir, "ccgenable.md"), managed);

  const result = runCli({ home, cwd, args: ["enable"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /slash commands: kept 2 project-local ccg command\(s\)/);
  assert.match(result.stdout, /run ccg install/);
  assert.equal(fs.existsSync(path.join(commandsDir, "ccgstatus.md")), true);
  assert.equal(fs.existsSync(path.join(commandsDir, "ccgenable.md")), true);
});

test("disable keeps the handoff guidance file and its .bak (user content)", () => {
  const home = tempDir();
  const cwd = makeProject("disable keeps guidance");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  const guidancePath = path.join(cwd, ".claude", "ccg-handoff.md");
  const backupPath = `${guidancePath}.bak`;
  fs.writeFileSync(guidancePath, "Real reminders survive disable.\n");
  assert.equal(fs.existsSync(backupPath), true);

  const disable = runCli({ home, cwd, args: ["disable"] });
  assert.equal(disable.status, 0, disable.stderr);
  assert.equal(fs.existsSync(guidancePath), true, "disable must keep the guidance file");
  assert.equal(fs.readFileSync(guidancePath, "utf8"), "Real reminders survive disable.\n");
  assert.equal(fs.existsSync(backupPath), true, "disable must keep the pristine .bak");
});

test("enable supports long project names by capping the handoff directory id", () => {
  const home = tempDir();
  const cwd = makeProject("a".repeat(250));
  const result = runCli({ home, cwd, args: ["enable"] });
  assert.equal(result.status, 0, result.stderr);

  const projectConfig = readJson(getProjectConfigPath(cwd));
  assert.equal(projectConfig.project_id.length, 130);
  assert.match(projectConfig.project_id, /^a{120}--[a-f0-9]{8}$/);
  assert.equal(fs.existsSync(projectConfig.handoff.file.replace("~/", `${home}/`)), true);
});

test("enable does not leave enabled project config when handoff init fails", () => {
  const home = tempDir();
  const cwd = makeProject("blocked handoff");
  const blockedStorage = path.join(home, "blocked-storage");
  fs.writeFileSync(blockedStorage, "not a directory");
  fs.mkdirSync(path.join(home, ".claude", "cache-guard"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "cache-guard", "config.json"),
    JSON.stringify({
      ...DEFAULT_GLOBAL_CONFIG,
      handoff: {
        ...DEFAULT_GLOBAL_CONFIG.handoff,
        storage_dir: blockedStorage
      }
    }, null, 2)
  );

  const result = runCli({ home, cwd, args: ["enable"] });
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(getProjectConfigPath(cwd)), false);
  assert.equal(fs.existsSync(path.join(cwd, ".claude", "settings.local.json")), false);
});

test("enable does not leave enabled project config when hook install fails", () => {
  const home = tempDir();
  const cwd = makeProject("blocked hook");
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".claude", "settings.local.json"), "[]\n");

  const result = runCli({ home, cwd, args: ["enable"] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /settings\.local\.json must contain a JSON object/);
  assert.equal(fs.existsSync(getProjectConfigPath(cwd)), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "cache-guard", "config.json")), false);
});

test("enable --force overwrites an existing handoff file", () => {
  const home = tempDir();
  const cwd = makeProject("force handoff");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  const projectConfig = readJson(getProjectConfigPath(cwd));
  const handoffPath = projectConfig.handoff.file.replace("~/", `${home}/`);
  fs.writeFileSync(handoffPath, "custom handoff\n");

  const result = runCli({ home, cwd, args: ["enable", "--force"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /handoff: overwritten/);
  assert.match(result.stdout, /handoff backup:/);
  assert.notEqual(fs.readFileSync(handoffPath, "utf8"), "custom handoff\n");
  assert.match(fs.readFileSync(handoffPath, "utf8"), /# Next Session Handoff/);
  const backupPath = result.stdout.match(/handoff backup: (.+)/)?.[1]?.trim();
  assert.equal(fs.readFileSync(backupPath, "utf8"), "custom handoff\n");
});

test("enable rejects threshold override and points to ccg setting", () => {
  const home = tempDir();
  const cwd = makeProject("enable custom threshold");
  const result = runCli({ home, cwd, args: ["enable", "--five-hour-warning", "65"] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown enable option/);
  assert.match(result.stderr, /ccg setting/);
});

test("setting threshold flag writes project override threshold", () => {
  const home = tempDir();
  const cwd = makeProject("setting custom threshold");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);

  const result = runCli({ home, cwd, args: ["setting", "--five-hour-warning", "65"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Project settings updated/);
  assert.match(result.stdout, /five_hour_warning: 65%/);
  assert.match(result.stdout, /Claude Code v2\.1\.169\+ reloads hook settings automatically/);
  assert.doesNotMatch(result.stdout, /five_hour_critical/);

  const projectConfig = readJson(getProjectConfigPath(cwd));
  assert.equal(projectConfig.enabled, true);
  assert.equal(projectConfig.overrides.thresholds.five_hour_warning, 65);
  assert.equal(projectConfig.overrides.thresholds.five_hour_critical, undefined);
});

test("raising the project threshold above current usage immediately rearms the hook", () => {
  const home = tempDir();
  const cwd = makeProject("setting rearms hook");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  writeUsageState(home, 12, 26);

  const lowThreshold = runCli({ home, cwd, args: ["setting", "--five-hour-warning", "9"] });
  assert.equal(lowThreshold.status, 0, lowThreshold.stderr);
  assert.match(lowThreshold.stdout, /hook eligibility: ready/);

  const firstTrigger = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({
      hook_event_name: "PostToolBatch",
      session_id: "first-session",
      cwd,
      tool_calls: []
    })
  });
  assert.equal(firstTrigger.status, 0, firstTrigger.stderr);
  assert.match(JSON.parse(firstTrigger.stdout).systemMessage, /5-hour usage is 12%/);

  const handoffPath = projectHandoffPath(home, cwd);
  const handoffContent = completeHandoffMarkdown("first threshold episode");
  fs.writeFileSync(handoffPath, handoffContent);
  const completed = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({
      hook_event_name: "PostToolBatch",
      session_id: "first-session",
      cwd,
      tool_calls: [
        {
          tool_name: "Write",
          tool_input: { file_path: handoffPath, content: handoffContent },
          tool_response: { success: true }
        }
      ]
    })
  });
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).continue, false);

  const raised = runCli({ home, cwd, args: ["setting", "--five-hour-warning", "20"] });
  assert.equal(raised.status, 0, raised.stderr);
  assert.match(raised.stdout, /hook eligibility: reset/);
  assert.match(raised.stdout, /current 5h usage 12% is below the new 20% threshold/);

  const config = readJson(path.join(cwd, ".claude-cache-guard.json"));
  const hookStatePath = path.join(home, ".claude", "cache-guard", "hook-state", `${config.project_id}.json`);
  const resetState = readJson(hookStatePath);
  assert.equal(resetState.threshold_active, false);
  assert.equal(resetState.phase, "reset");
  assert.equal(resetState.reset_reason, "threshold_changed");
  assert.equal(resetState.five_hour.warning_threshold, 20);

  writeUsageState(home, 20, 26);
  const secondTrigger = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({
      hook_event_name: "PostToolBatch",
      session_id: "second-session",
      cwd,
      tool_calls: []
    })
  });
  assert.equal(secondTrigger.status, 0, secondTrigger.stderr);
  assert.match(JSON.parse(secondTrigger.stdout).systemMessage, /5-hour usage is 20%/);
});

test("changing the threshold does not rearm while current usage is still above it", () => {
  const home = tempDir();
  const cwd = makeProject("setting remains active");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  writeUsageState(home, 30, 26);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "20"] }).status, 0);

  const trigger = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({
      hook_event_name: "PostToolBatch",
      session_id: "active-session",
      cwd,
      tool_calls: []
    })
  });
  assert.equal(trigger.status, 0, trigger.stderr);
  assert.match(JSON.parse(trigger.stdout).systemMessage, /5-hour usage is 30%/);

  const raisedButStillBelowUsage = runCli({
    home,
    cwd,
    args: ["setting", "--five-hour-warning", "25"]
  });
  assert.equal(raisedButStillBelowUsage.status, 0, raisedButStillBelowUsage.stderr);
  assert.match(raisedButStillBelowUsage.stdout, /hook eligibility: unchanged/);

  const config = readJson(path.join(cwd, ".claude-cache-guard.json"));
  const hookState = readJson(
    path.join(home, ".claude", "cache-guard", "hook-state", `${config.project_id}.json`)
  );
  assert.equal(hookState.threshold_active, true);
  assert.equal(hookState.phase, "pending");
});

test("setting requires an enabled project", () => {
  const home = tempDir();
  const cwd = makeProject("setting disabled project");
  const result = runCli({ home, cwd, args: ["settings", "--five-hour-warning", "66"] });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Project is not enabled/);
  assert.equal(fs.existsSync(getProjectConfigPath(cwd)), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "cache-guard", "config.json")), false);
});

test("setting without flag fails in non-TTY instead of waiting", () => {
  const home = tempDir();
  const cwd = makeProject("setting non tty");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  const result = runCli({ home, cwd, args: ["setting"] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --five-hour-warning/);
});

test("enable uses global warning threshold through effective config without project override", () => {
  const home = tempDir();
  const cwd = makeProject("enable global default");
  const bridgeDir = path.join(home, ".claude", "cache-guard");
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.writeFileSync(
    path.join(bridgeDir, "config.json"),
    JSON.stringify({
      ...DEFAULT_GLOBAL_CONFIG,
      thresholds: { ...DEFAULT_GLOBAL_CONFIG.thresholds, five_hour_warning: 68 }
    })
  );

  writeUsageState(home, 69);
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);

  const projectConfig = readJson(getProjectConfigPath(cwd));
  assert.deepEqual(projectConfig.overrides, {});

  const status = runCli({ home, cwd, args: ["status"] });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /threshold status: warning/);
  assert.match(status.stdout, /5h warning threshold: 68% \(from global config\)/);
  assert.match(status.stdout, /7d warning threshold: not set/);
});

test("status shows the project-override warning threshold and its source", () => {
  const home = tempDir();
  const cwd = makeProject("status override threshold");
  writeUsageState(home, 12);
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "55"] }).status, 0);

  const status = runCli({ home, cwd, args: ["status"] });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /5h warning threshold: 55% \(from project override\)/);
});

test("enable preserves overrides and refreshes project metadata", () => {
  const home = tempDir();
  const cwd = makeProject("override project");
  const projectConfigPath = getProjectConfigPath(cwd);
  fs.writeFileSync(
    projectConfigPath,
    JSON.stringify({
      version: 1,
      enabled: false,
      project_name: "old",
      project_id: "old--12345678",
      handoff: { file: "~/.claude/old/file.md" },
      overrides: {
        thresholds: { five_hour_warning: 60, five_hour_critical: 85 },
        handoff: { max_lines: 150 }
      }
    })
  );

  const result = runCli({ home, cwd, args: ["enable", "--force"] });
  assert.equal(result.status, 0, result.stderr);
  const projectConfig = readJson(projectConfigPath);
  assert.equal(projectConfig.enabled, true);
  assert.equal(projectConfig.project_name, "override project");
  assert.match(projectConfig.project_id, /^override-project--[a-f0-9]{8}$/);
  assert.deepEqual(projectConfig.overrides, {
    thresholds: { five_hour_warning: 60 },
    handoff: { max_lines: 150 }
  });
});

test("setting preserves existing project config while updating threshold override", () => {
  const home = tempDir();
  const cwd = makeProject("existing override project");
  const projectConfigPath = getProjectConfigPath(cwd);
  fs.writeFileSync(
    projectConfigPath,
    JSON.stringify({
      version: 1,
      enabled: true,
      project_name: "existing override project",
      project_id: "existing--12345678",
      handoff: { file: "~/.claude/old/file.md" },
      overrides: {
        thresholds: { five_hour_warning: 60, five_hour_critical: 85 }
      }
    })
  );

  const result = runCli({ home, cwd, args: ["setting", "--five-hour-warning", "65"] });
  assert.equal(result.status, 0, result.stderr);

  const projectConfig = readJson(projectConfigPath);
  assert.equal(projectConfig.enabled, true);
  assert.equal(projectConfig.project_name, "existing override project");
  assert.equal(projectConfig.overrides.thresholds.five_hour_warning, 65);
  assert.equal(projectConfig.overrides.thresholds.five_hour_critical, undefined);
});

test("project state and disable resolve home-relative handoff paths with provided homeDir", async () => {
  const home = tempDir();
  const cwd = makeProject("programmatic home");
  const enabled = await enableProject({ homeDir: home, cwd });
  const state = await getProjectState({ homeDir: home, cwd });
  assert.equal(state.handoffPath, enabled.handoffPath);
  assert.equal(state.handoffPath.startsWith(home), true);
  assert.equal(fs.existsSync(state.handoffPath), true);

  const disabled = await disableProject({ homeDir: home, cwd, removeHandoff: true });
  assert.equal(disabled.removedHandoffFile, true);
  assert.equal(fs.existsSync(enabled.handoffPath), false);
});

test("disable removes project config and hook while keeping handoff by default", () => {
  const home = tempDir();
  const cwd = makeProject("disable project");
  const globalConfig = {
    ...DEFAULT_GLOBAL_CONFIG,
    thresholds: { ...DEFAULT_GLOBAL_CONFIG.thresholds, five_hour_warning: 80 }
  };
  const bridgeDir = path.join(home, ".claude", "cache-guard");
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, "config.json"), JSON.stringify(globalConfig, null, 2));

  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  const projectConfigPath = getProjectConfigPath(cwd);
  const projectConfig = readJson(projectConfigPath);
  const handoffPath = projectConfig.handoff.file.replace("~/", `${home}/`);
  const localSettingsPath = path.join(cwd, ".claude", "settings.local.json");
  assert.equal(fs.existsSync(projectConfigPath), true);
  assert.equal(fs.existsSync(handoffPath), true);
  assert.equal(fs.existsSync(localSettingsPath), true);

  const disable = runCli({ home, cwd, args: ["disable"] });
  assert.equal(disable.status, 0, disable.stderr);
  assert.match(disable.stdout, /Project disabled/);
  assert.match(disable.stdout, /project config: removed/);
  assert.match(disable.stdout, /handoff file: kept/);
  assert.match(disable.stdout, /hook settings: removed/);
  assert.match(disable.stdout, /global config: unchanged/);
  assert.equal(fs.existsSync(projectConfigPath), false);
  assert.equal(fs.existsSync(handoffPath), true);
  assert.equal(fs.existsSync(localSettingsPath), false);
  // enable now writes a project-local handoff guidance starter (.claude/ccg-handoff.md
  // + its pristine .bak). disable must NOT delete that user content, so the .claude dir
  // survives holding exactly those two files; the hook settings and any ccg commands dir
  // are gone.
  assert.equal(fs.existsSync(path.join(cwd, ".claude")), true, "project-local .claude survives (holds the guidance file + .bak)");
  assert.equal(fs.existsSync(path.join(cwd, ".claude", "ccg-handoff.md")), true, "handoff guidance kept by disable");
  assert.equal(fs.existsSync(path.join(cwd, ".claude", "ccg-handoff.md.bak")), true, "pristine .bak kept by disable");
  assert.match(disable.stdout, /handoff guidance: kept .*ccg-handoff\.md/, "disable tells the user the guidance file was kept");
  assert.equal(fs.existsSync(path.join(cwd, ".claude", "commands")), false, "enable creates no project-local commands dir");
  assert.deepEqual(readJson(path.join(bridgeDir, "config.json")), globalConfig);
});

test("disable --rmhandoff explicitly removes this project's handoff file", () => {
  const home = tempDir();
  const cwd = makeProject("disable remove handoff");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  const projectConfig = readJson(getProjectConfigPath(cwd));
  const handoffPath = projectConfig.handoff.file.replace("~/", `${home}/`);

  const disable = runCli({ home, cwd, args: ["disable", "--rmhandoff"] });
  assert.equal(disable.status, 0, disable.stderr);
  assert.match(disable.stdout, /handoff file: removed/);
  assert.equal(fs.existsSync(handoffPath), false);
});

test("status detects stale project metadata and disable refuses to delete the original project's handoff", () => {
  const home = tempDir();
  const oldCwd = makeProject("moved project old");
  const newCwd = makeProject("moved project new");
  assert.equal(runCli({ home, cwd: oldCwd, args: ["enable"] }).status, 0);
  const oldConfigPath = getProjectConfigPath(oldCwd);
  const oldConfig = readJson(oldConfigPath);
  const oldHandoffPath = oldConfig.handoff.file.replace("~/", `${home}/`);

  // Simulate a copied/moved project: the carried-over config still points at the
  // ORIGINAL project's id + handoff path.
  fs.copyFileSync(oldConfigPath, getProjectConfigPath(newCwd));
  fs.mkdirSync(path.join(newCwd, ".claude"), { recursive: true });
  fs.copyFileSync(
    path.join(oldCwd, ".claude", "settings.local.json"),
    path.join(newCwd, ".claude", "settings.local.json")
  );
  const newProject = getProjectInfo(newCwd);
  const hookStateDir = path.join(home, ".claude", "cache-guard", "hook-state");
  fs.mkdirSync(hookStateDir, { recursive: true });
  fs.writeFileSync(path.join(hookStateDir, `${oldConfig.project_id}.json`), "{}");
  fs.writeFileSync(path.join(hookStateDir, `${newProject.id}.json`), "{}");
  writeUsageState(home, 91, 22);

  const status = runCli({ home, cwd: newCwd, args: ["status"] });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /project metadata: stale/);
  assert.match(status.stdout, /refresh this moved or copied project's metadata/);

  const disable = runCli({ home, cwd: newCwd, args: ["disable", "--rmhandoff"] });
  assert.equal(disable.status, 0, disable.stderr);
  // Stale metadata: the original project's handoff and hook state MUST be preserved.
  assert.match(disable.stdout, /handoff file: kept/);
  assert.match(disable.stdout, /NOT removed because this project's saved metadata does not match/);
  assert.equal(fs.existsSync(oldHandoffPath), true);
  assert.equal(fs.existsSync(path.join(hookStateDir, `${oldConfig.project_id}.json`)), true);
  // The current (copied) directory's own local state is still cleaned up.
  assert.equal(fs.existsSync(getProjectConfigPath(newCwd)), false);
  assert.equal(fs.existsSync(path.join(newCwd, ".claude", "settings.local.json")), false);
  assert.equal(fs.existsSync(path.join(hookStateDir, `${newProject.id}.json`)), false);
});

test("usage handoff hook requires a main-agent full Write, then stops the current goal", () => {
  const home = tempDir();
  const cwd = makeProject("hook warning");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "90"] }).status, 0);
  writeUsageState(home, 90, 22);

  const input = JSON.stringify({
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd,
    stop_hook_active: false
  });
  const result = runCli({ home, cwd, args: ["hook", "usage-handoff"], input });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, undefined);
  assert.match(output.systemMessage, /5-hour usage is 90%/);
  assert.equal(output.hookSpecificOutput.hookEventName, "Stop");
  assert.match(output.hookSpecificOutput.additionalContext, /Claude Cache Guard WARNING/);
  assert.match(output.hookSpecificOutput.additionalContext, /Before continuing the current goal/);
  assert.match(output.hookSpecificOutput.additionalContext, /main Claude agent must do this itself/);
  assert.match(output.hookSpecificOutput.additionalContext, /Use the Write tool directly/);
  assert.match(output.hookSpecificOutput.additionalContext, /<handoff_target>/);
  assert.match(output.hookSpecificOutput.additionalContext, /Do not read \.env files/);

  const statusAfterFirstReminder = runCli({ home, cwd, args: ["status"] });
  assert.equal(statusAfterFirstReminder.status, 0, statusAfterFirstReminder.stderr);
  assert.match(statusAfterFirstReminder.stdout, /hook reminder: waiting for main Claude handoff/);
  assert.match(statusAfterFirstReminder.stdout, /hook reminder scope: project usage window/);
  assert.match(statusAfterFirstReminder.stdout, /hook reminder mode: auto/);
  assert.match(statusAfterFirstReminder.stdout, /hook reminder trigger session: session-1/);
  assert.match(statusAfterFirstReminder.stdout, /hook reminder trigger event: Stop/);
  assert.match(statusAfterFirstReminder.stdout, /hook reminder count: 1/);
  assert.match(statusAfterFirstReminder.stdout, /hook reminder usage: 90%/);
  assert.match(statusAfterFirstReminder.stdout, /handoff handled: no/);
  assert.match(statusAfterFirstReminder.stdout, /hook state: /);
  assert.match(statusAfterFirstReminder.stdout, /recommendation: Handoff is pending/);

  const second = runCli({ home, cwd, args: ["hook", "usage-handoff"], input });
  assert.equal(second.status, 0, second.stderr);
  assert.match(JSON.parse(second.stdout).hookSpecificOutput.additionalContext, /pending handoff/);

  writeUsageState(home, 92, 22);
  const afterUsageIncrease = runCli({ home, cwd, args: ["hook", "usage-handoff"], input });
  assert.equal(afterUsageIncrease.status, 0, afterUsageIncrease.stderr);
  assert.match(JSON.parse(afterUsageIncrease.stdout).hookSpecificOutput.additionalContext, /pending handoff/);

  const handoffPath = projectHandoffPath(home, cwd);
  const handoffContent = completeHandoffMarkdown("session-1");
  fs.writeFileSync(handoffPath, handoffContent);
  const completed = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({
      hook_event_name: "PostToolBatch",
      session_id: "session-1",
      cwd,
      tool_calls: [
        {
          tool_name: "Write",
          tool_input: { file_path: handoffPath, content: handoffContent },
          tool_response: { success: true }
        }
      ]
    })
  });
  assert.equal(completed.status, 0, completed.stderr);
  const completedOutput = JSON.parse(completed.stdout);
  assert.equal(completedOutput.continue, false);
  assert.match(completedOutput.stopReason, /current goal has been stopped/);
  assert.match(completedOutput.stopReason, /\/ccgresume/);

  const nextSession = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "session-2", cwd, stop_hook_active: false })
  });
  assert.equal(nextSession.status, 0, nextSession.stderr);
  assert.equal(nextSession.stdout, "");

  const statusAfterSecondSession = runCli({ home, cwd, args: ["status"] });
  assert.equal(statusAfterSecondSession.status, 0, statusAfterSecondSession.stderr);
  assert.match(statusAfterSecondSession.stdout, /hook reminder: handoff complete for this usage window; project quiet/);
  assert.match(statusAfterSecondSession.stdout, /hook reminder trigger session: session-1/);
  assert.doesNotMatch(statusAfterSecondSession.stdout, /handoff handled: no/);
  assert.match(statusAfterSecondSession.stdout, /recommendation: This project's handoff is already handled for the current usage window; CCG stays quiet until usage resets\. In a new or cleared Claude Code session, type \/ccgresume/);

  writeUsageState(home, 20, 22);
  const afterRecovery = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "session-3", cwd, stop_hook_active: false })
  });
  assert.equal(afterRecovery.status, 0, afterRecovery.stderr);
  assert.equal(afterRecovery.stdout, "");

  writeUsageState(home, 91, 22);
  const afterNextThresholdCrossing = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "session-4", cwd, stop_hook_active: false })
  });
  assert.equal(afterNextThresholdCrossing.status, 0, afterNextThresholdCrossing.stderr);
  assert.match(JSON.parse(afterNextThresholdCrossing.stdout).systemMessage, /5-hour usage is 91%/);

  const statusAfterNewEpisode = runCli({ home, cwd, args: ["status"] });
  assert.equal(statusAfterNewEpisode.status, 0, statusAfterNewEpisode.stderr);
  assert.match(statusAfterNewEpisode.stdout, /hook reminder trigger session: session-4/);
  assert.match(statusAfterNewEpisode.stdout, /hook reminder: waiting for main Claude handoff/);
});

test("usage handoff hook stays silent below threshold and when disabled", () => {
  const home = tempDir();
  const cwd = makeProject("hook quiet");
  const invalidInput = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: "not json"
  });
  assert.equal(invalidInput.status, 0, invalidInput.stderr);
  assert.equal(invalidInput.stdout, "");
  assert.equal(invalidInput.stderr, "");
  assert.match(
    fs.readFileSync(path.join(home, ".claude", "cache-guard", "hook-errors.log"), "utf8"),
    /SyntaxError/
  );

  writeUsageState(home, 42, 22);
  let result = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");

  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  result = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd, stop_hook_active: true })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");

  result = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "s2", cwd, stop_hook_active: false })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("usage handoff hook can remind during an active Stop hook continuation", () => {
  const home = tempDir();
  const cwd = makeProject("hook goal continuation");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "88"] }).status, 0);
  writeUsageState(home, 89, 54);

  const duringGoal = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "goal-session", cwd, stop_hook_active: true })
  });
  assert.equal(duringGoal.status, 0, duringGoal.stderr);
  assert.match(JSON.parse(duringGoal.stdout).systemMessage, /5-hour usage is 89%/);

  const statusAfterReminder = runCli({ home, cwd, args: ["status"] });
  assert.equal(statusAfterReminder.status, 0, statusAfterReminder.stderr);
  assert.match(statusAfterReminder.stdout, /hook reminder: waiting for main Claude handoff/);
  assert.match(statusAfterReminder.stdout, /hook reminder trigger session: goal-session/);

  const repeatedContinuation = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "goal-session", cwd, stop_hook_active: true })
  });
  assert.equal(repeatedContinuation.status, 0, repeatedContinuation.stderr);
  assert.match(JSON.parse(repeatedContinuation.stdout).hookSpecificOutput.additionalContext, /pending handoff/);
});

test("usage handoff hook migrates a legacy active reminder instead of suppressing the main session", () => {
  const home = tempDir();
  const cwd = makeProject("hook legacy state");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "9"] }).status, 0);
  writeUsageState(home, 9, 25);

  const config = readJson(path.join(cwd, ".claude-cache-guard.json"));
  const statePath = path.join(home, ".claude", "cache-guard", "hook-state", `${config.project_id}.json`);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    updated_at: "2026-06-18T03:18:36.509Z",
    project_id: config.project_id,
    session_id: "legacy-session",
    threshold_active: true,
    status: "warning",
    five_hour: { used_percentage: 9, warning_threshold: 9, remaining_percentage: 91 },
    handoff_path: projectHandoffPath(home, cwd)
  }, null, 2));

  const recovered = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({
      hook_event_name: "PostToolBatch",
      session_id: "legacy-session",
      cwd,
      tool_calls: []
    })
  });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(JSON.parse(recovered.stdout).hookSpecificOutput.additionalContext, /main Claude agent must do this itself/);

  const migrated = readJson(statePath);
  assert.equal(migrated.version, 4);
  assert.equal(migrated.phase, "pending");
  assert.equal(migrated.trigger_session_id, "legacy-session");
});

test("usage handoff hook ignores subagents and stops after a main-agent handoff Write", () => {
  const home = tempDir();
  const cwd = makeProject("hook tool batch");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "91"] }).status, 0);
  writeUsageState(home, 95, 55);

  const subagentBatch = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({
      hook_event_name: "PostToolBatch",
      session_id: "goal-tool-batch",
      agent_id: "agent-123",
      agent_type: "general-purpose",
      cwd,
      tool_calls: []
    })
  });
  assert.equal(subagentBatch.status, 0, subagentBatch.stderr);
  assert.equal(subagentBatch.stdout, "");

  const statusAfterSubagent = runCli({ home, cwd, args: ["status"] });
  assert.equal(statusAfterSubagent.status, 0, statusAfterSubagent.stderr);
  assert.match(statusAfterSubagent.stdout, /hook reminder: not sent/);

  const afterToolBatch = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({ hook_event_name: "PostToolBatch", session_id: "goal-tool-batch", cwd })
  });
  assert.equal(afterToolBatch.status, 0, afterToolBatch.stderr);
  const output = JSON.parse(afterToolBatch.stdout);
  assert.match(output.systemMessage, /5-hour usage is 95%/);
  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolBatch");
  assert.match(output.hookSpecificOutput.additionalContext, /Before continuing the current goal/);
  assert.match(output.hookSpecificOutput.additionalContext, /Use the Write tool directly/);

  const secondToolBatch = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({ hook_event_name: "PostToolBatch", session_id: "goal-tool-batch", cwd })
  });
  assert.equal(secondToolBatch.status, 0, secondToolBatch.stderr);
  assert.match(JSON.parse(secondToolBatch.stdout).hookSpecificOutput.additionalContext, /pending handoff/);

  const handoffPath = projectHandoffPath(home, cwd);
  const incompleteContent = "# Next Session Handoff\n\n## Snapshot\nincomplete\n";
  fs.writeFileSync(handoffPath, incompleteContent);
  const incompleteWrite = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({
      hook_event_name: "PostToolBatch",
      session_id: "goal-tool-batch",
      cwd,
      tool_calls: [
        {
          tool_name: "Write",
          tool_input: { file_path: handoffPath, content: incompleteContent },
          tool_response: { success: true }
        }
      ]
    })
  });
  assert.equal(incompleteWrite.status, 0, incompleteWrite.stderr);
  assert.match(JSON.parse(incompleteWrite.stdout).hookSpecificOutput.additionalContext, /pending handoff/);

  // A complete handoff is recognized from the FILESYSTEM regardless of the event
  // payload: this PostToolBatch carries no tool list at all, yet the freshly written,
  // complete file is enough to finish the episode and stop the goal.
  const completeContent = completeHandoffMarkdown("main goal");
  fs.writeFileSync(handoffPath, completeContent);
  const completedWrite = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({ hook_event_name: "PostToolBatch", session_id: "goal-tool-batch", cwd })
  });
  assert.equal(completedWrite.status, 0, completedWrite.stderr);
  assert.equal(JSON.parse(completedWrite.stdout).continue, false);

  // Once handled, the project stays quiet for the rest of this usage window, even from a
  // brand new session.
  const afterHandled = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "later-session", cwd, stop_hook_active: false })
  });
  assert.equal(afterHandled.status, 0, afterHandled.stderr);
  assert.equal(afterHandled.stdout, "");
});

test("usage handoff hook treats old post-reset usage as stale and does not remind", () => {
  const home = tempDir();
  const cwd = makeProject("hook stale usage");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "97"] }).status, 0);
  writeUsageState(home, 97, 55);
  setFiveHourResetTime(home, "2000-01-01T00:00:00Z");

  const staleHook = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "stale-session", cwd })
  });
  assert.equal(staleHook.status, 0, staleHook.stderr);
  assert.equal(staleHook.stdout, "");

  const status = runCli({ home, cwd, args: ["status"] });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /5h usage: stale 97% \(reset time passed\)/);
  assert.match(status.stdout, /threshold status: stale/);
  assert.match(status.stdout, /hook reminder: not sent/);
  assert.match(status.stdout, /Send one short Claude Code prompt to refresh statusLine usage/);
});

test("usage handoff hook resets an active reminder when reset time has passed", () => {
  const home = tempDir();
  const cwd = makeProject("hook stale reset");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "90"] }).status, 0);
  writeUsageState(home, 95, 55);

  const firstReminder = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "first-warning", cwd })
  });
  assert.equal(firstReminder.status, 0, firstReminder.stderr);
  assert.match(JSON.parse(firstReminder.stdout).systemMessage, /5-hour usage is 95%/);

  setFiveHourResetTime(home, "2000-01-01T00:00:00Z");
  const staleReset = runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "stale-reset", cwd })
  });
  assert.equal(staleReset.status, 0, staleReset.stderr);
  assert.equal(staleReset.stdout, "");

  const status = runCli({ home, cwd, args: ["status"] });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /threshold status: stale/);
  assert.match(status.stdout, /hook reminder: reset/);
});

test("status prompts enable when project is not enabled", () => {
  const home = tempDir();
  const cwd = makeProject("status disabled");
  writeUsageState(home, 20);
  const result = runCli({ home, cwd, args: ["status"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /project enabled: no/);
  assert.match(result.stdout, /Run ccg enable/);
});

test("status enabled shows usage threshold and handoff state", () => {
  const home = tempDir();
  const cwd = makeProject("status enabled");
  writeUsageState(home, 91, 22);
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  const result = runCli({ home, cwd, args: ["status"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /project enabled: yes/);
  assert.match(result.stdout, /project metadata: current/);
  assert.match(result.stdout, /5h usage: 91%/);
  assert.match(result.stdout, /7d usage: 22%/);
  assert.match(result.stdout, /threshold status: warning/);
  assert.match(result.stdout, /project hook: installed/);
  assert.match(result.stdout, /project hook events: installed Stop, PostToolBatch; missing none/);
  assert.match(result.stdout, /runtime note: Claude Code v2\.1\.169\+ reloads hook settings automatically/);
  assert.match(result.stdout, /hook reminder: not sent/);
  assert.match(result.stdout, /handoff exists: yes/);
});

test("status warns when enabled project is missing usage handoff hooks", () => {
  const home = tempDir();
  const cwd = makeProject("status missing hook");
  writeUsageState(home, 91, 22);
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  fs.rmSync(path.join(cwd, ".claude", "settings.local.json"), { force: true });

  const result = runCli({ home, cwd, args: ["status"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /project enabled: yes/);
  assert.match(result.stdout, /project hook: missing/);
  assert.match(result.stdout, /Run ccg enable again to install the project usage handoff hooks/);
});

test("status warns when enabled project has only the legacy Stop hook", () => {
  const home = tempDir();
  const cwd = makeProject("status legacy stop only hook");
  writeUsageState(home, 91, 22);
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  const localSettingsPath = path.join(cwd, ".claude", "settings.local.json");
  const localSettings = readJson(localSettingsPath);
  delete localSettings.hooks.PostToolBatch;
  fs.writeFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2));

  const result = runCli({ home, cwd, args: ["status"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /project hook: missing/);
  assert.match(result.stdout, /project hook events: installed Stop; missing PostToolBatch/);
  assert.match(result.stdout, /Run ccg enable again to install the project usage handoff hooks/);
});

test("status warns when enabled project hook settings are invalid JSON", () => {
  const home = tempDir();
  const cwd = makeProject("status invalid hook");
  writeUsageState(home, 91, 22);
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  fs.writeFileSync(path.join(cwd, ".claude", "settings.local.json"), "{not json");

  const result = runCli({ home, cwd, args: ["status"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /project hook: invalid settings/);
  assert.match(result.stdout, /Fix \.claude\/settings\.local\.json/);
});

test("top-level handoff prompts enable when project is not enabled", () => {
  const home = tempDir();
  const cwd = makeProject("handoff disabled");
  const result = runCli({ home, cwd, args: ["handoff"] });
  // Exit 0, not 1: /ccghandoff pre-executes this command, and Claude Code
  // silently aborts the whole slash-command turn on a non-zero pre-exec.
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Project is not enabled/);
  assert.match(result.stdout, /ccg enable/);
});

test("top-level handoff uses enabled project handoff path", () => {
  const home = tempDir();
  const cwd = makeProject("handoff enabled");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  const projectConfig = readJson(getProjectConfigPath(cwd));
  const result = runCli({ home, cwd, args: ["handoff"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(escapeRegExp(projectConfig.handoff.file.replace("~/", `${home}/`))));
  assert.match(result.stdout, /<strict_safety_rules>/);
  assert.match(result.stdout, /token values/);
  assert.match(result.stdout, /API keys/);
});

test("handoff --show quotes the whole prompt so a model treats it as data, not orders", () => {
  // /ccghandoff pre-executes this; a raw handoff prompt is imperative and a
  // model that sees it will overwrite the user's real next_session.md.
  const home = tempDir();
  const cwd = makeProject("handoff show");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  const result = runCli({ home, cwd, args: ["handoff", "--show"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /quoted for display only/i);
  const lines = result.stdout.split("\n");
  const promptStart = lines.findIndex((line) => line.startsWith("> "));
  assert.notEqual(promptStart, -1, "prompt body must be blockquoted");
  for (const line of lines.slice(promptStart)) {
    if (line.trim() === "") continue;
    assert.match(line, /^> /, `unquoted prompt line leaked into --show output: ${line}`);
  }
});

test("resume rejects normal terminal use", () => {
  const home = tempDir();
  const cwd = makeProject("resume terminal rejected");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);

  const result = runCli({
    home,
    cwd,
    args: ["resume"],
    env: {
      CLAUDECODE: ""
    }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only works inside Claude Code/);
  assert.match(result.stderr, /\/ccgresume/);
});

test("resume inside Claude Code continues in the current new or cleared session", () => {
  const home = tempDir();
  const cwd = makeProject("resume current claude session");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  const handoffPath = projectHandoffPath(home, cwd);
  fs.writeFileSync(handoffPath, completeHandoffMarkdown("after clear"));

  const result = runCli({
    home,
    cwd,
    args: ["resume"],
    env: {
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "current-session"
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Resuming project from/);
  assert.match(result.stdout, new RegExp(escapeRegExp(handoffPath)));
  assert.match(result.stdout, /The handoff content is included below/);
  assert.match(result.stdout, /Continue the unfinished work/);
  assert.match(result.stdout, /Git is optional/);
  // handoff file content is output inline so Claude can act immediately
  assert.match(result.stdout, /# Next Session Handoff/);
  assert.match(result.stdout, /--- Handoff file/);
});

test("resume explains the missing prerequisite on stdout with exit 0", () => {
  // Exit 0 + stdout, not exit 1 + stderr: /ccgresume pre-executes this
  // command, and Claude Code silently aborts the whole slash-command turn on
  // a non-zero pre-exec. With globally installed slash commands, "not
  // enabled" / "no handoff yet" are normal states the model must be able to
  // relay to the user.
  const home = tempDir();
  const cwd = makeProject("resume validation");

  const disabled = runCli({
    home,
    cwd,
    args: ["resume"],
    env: { CLAUDECODE: "1" }
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /No handoff to resume/);
  assert.match(disabled.stdout, /Run ccg enable/);

  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  fs.rmSync(projectHandoffPath(home, cwd));
  const missing = runCli({
    home,
    cwd,
    args: ["resume"],
    env: { CLAUDECODE: "1" }
  });
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /No handoff to resume/);
  assert.match(missing.stdout, /does not exist/);
});

test("removed low-level handoff commands fail with product workflow guidance", () => {
  const home = tempDir();
  const cwd = makeProject("removed handoff");
  for (const args of [
    ["handoff", "init"],
    ["handoff", "init", "--force"],
    ["handoff", "status"],
    ["handoff", "path"],
    ["handoff", "print-prompt"]
  ]) {
    const result = runCli({ home, cwd, args });
    assert.equal(result.status, 1, `${args.join(" ")} should fail`);
    assert.match(result.stderr, /was removed/);
    assert.match(result.stderr, /ccg enable/);
    assert.match(result.stderr, /ccg status/);
    assert.match(result.stderr, /ccg handoff/);
  }
});

test("config merge priority is defaults, global, project overrides, CLI flags", () => {
  const merged = mergeConfig(
    DEFAULT_GLOBAL_CONFIG,
    { thresholds: { five_hour_warning: 70 }, handoff: { max_lines: 200 } },
    { thresholds: { five_hour_warning: 60 }, handoff: { max_lines: 150 } },
    { thresholds: { five_hour_warning: 55 } }
  );
  assert.equal(merged.thresholds.five_hour_warning, 55);
  assert.equal(merged.thresholds.seven_day_warning, null);
  assert.equal(merged.handoff.max_lines, 150);
  assert.equal(merged.handoff.file_name, "next_session.md");
  assert.deepEqual(thresholdOptionsFromConfig(merged), {
    fiveHourThreshold: 55,
    sevenDayThreshold: null
  });
});

test("corrupt global config degrades gracefully instead of crashing status/check-threshold", () => {
  const home = tempDir();
  const cwd = makeProject("corrupt config");
  const bridgeDir = path.join(home, ".claude", "cache-guard");
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, "config.json"), "{ not valid json");
  writeUsageState(home, 95, 30);

  const status = runCli({ home, cwd, args: ["status"] });
  assert.equal(status.status, 1, status.stderr);
  assert.match(status.stdout, /status error: .*config\.json is not valid JSON/);
  assert.match(status.stdout, /recommendation:/);

  const check = runCli({ home, cwd, args: ["check-threshold"] });
  // Falls back to the default threshold (90); usage 95 => warning (exit 1), never a crash.
  assert.equal(check.status, 1, check.stderr);
  assert.match(check.stdout, /status: warning/);
  assert.match(check.stderr, /ignoring invalid guard config/);
});

test("disable does not remove a third-party hook command that merely mentions ccg", () => {
  const home = tempDir();
  const cwd = makeProject("third party hook");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  const localPath = path.join(cwd, ".claude", "settings.local.json");
  const settings = readJson(localPath);
  settings.hooks.Stop.push({ hooks: [{ type: "command", command: "my-ccg hook usage-handoff" }] });
  fs.writeFileSync(localPath, JSON.stringify(settings, null, 2));

  const disable = runCli({ home, cwd, args: ["disable"] });
  assert.equal(disable.status, 0, disable.stderr);
  const after = readJson(localPath);
  const stopCommands = after.hooks.Stop.flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.deepEqual(stopCommands, ["my-ccg hook usage-handoff"]);
  assert.equal(after.hooks.PostToolBatch, undefined);
});

test("status flags an enabled project config that is missing project_id as stale, not current", () => {
  const home = tempDir();
  const cwd = makeProject("missing id");
  fs.writeFileSync(
    getProjectConfigPath(cwd),
    JSON.stringify({
      version: 1,
      enabled: true,
      project_name: "x",
      handoff: { file: "~/.claude/next-session/x/next_session.md" },
      overrides: {}
    })
  );
  writeUsageState(home, 50, 20);

  const status = runCli({ home, cwd, args: ["status"] });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /project metadata: stale/);
  assert.doesNotMatch(status.stdout, /project metadata: current/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runHook({ home, cwd, event = "Stop", sessionId, extra = {} }) {
  return runCli({
    home,
    cwd,
    args: ["hook", "usage-handoff"],
    input: JSON.stringify({ hook_event_name: event, session_id: sessionId, cwd, ...extra })
  });
}

function hookStatePathFor(home, cwd) {
  const config = readJson(path.join(cwd, ".claude-cache-guard.json"));
  return path.join(home, ".claude", "cache-guard", "hook-state", `${config.project_id}.json`);
}

// --- Regression tests for the per-project / per-usage-window handoff model ---

test("bug (a): a handoff written from a different session completes the same project episode", () => {
  const home = tempDir();
  const cwd = makeProject("bug-a cross session");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "90"] }).status, 0);
  writeUsageState(home, 95, 22);

  // Session A is the one that gets warned.
  const warnA = runHook({ home, cwd, sessionId: "A" });
  assert.match(JSON.parse(warnA.stdout).systemMessage, /5-hour usage is 95%/);

  // A DIFFERENT session (B) writes the complete handoff. The PostToolBatch payload is
  // deliberately empty: completion is detected from the file on disk, not the payload.
  fs.writeFileSync(projectHandoffPath(home, cwd), completeHandoffMarkdown("written by B"));
  const completedB = runHook({ home, cwd, event: "PostToolBatch", sessionId: "B" });
  assert.equal(completedB.status, 0, completedB.stderr);
  assert.equal(JSON.parse(completedB.stdout).continue, false);

  assert.equal(readJson(hookStatePathFor(home, cwd)).phase, "handled");
});

test("bug (b): concurrent sessions share one project episode without clobbering it", () => {
  const home = tempDir();
  const cwd = makeProject("bug-b concurrent");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "90"] }).status, 0);
  writeUsageState(home, 95, 22);

  // Session A triggers the warning.
  const warnA = runHook({ home, cwd, sessionId: "A" });
  assert.match(JSON.parse(warnA.stdout).systemMessage, /5-hour usage is 95%/);

  // Session B stops while A's handoff is still pending: it must NOT reset the episode.
  // The episode stays pending, the count increments, and the trigger session is kept.
  const warnB = runHook({ home, cwd, sessionId: "B" });
  assert.match(JSON.parse(warnB.stdout).hookSpecificOutput.additionalContext, /pending handoff/);

  const midState = readJson(hookStatePathFor(home, cwd));
  assert.equal(midState.phase, "pending");
  assert.equal(midState.reminder_count, 2);
  assert.equal(midState.trigger_session_id, "A");

  // Either session completing the handoff settles it for everyone.
  fs.writeFileSync(projectHandoffPath(home, cwd), completeHandoffMarkdown("done"));
  const completed = runHook({ home, cwd, event: "PostToolBatch", sessionId: "A" });
  assert.equal(JSON.parse(completed.stdout).continue, false);

  // The other concurrent session is now quiet.
  assert.equal(runHook({ home, cwd, sessionId: "B" }).stdout, "");
});

test("bug (c): a handled project stays quiet in the same window and re-arms on a new window", () => {
  const home = tempDir();
  const cwd = makeProject("bug-c window");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "90"] }).status, 0);
  // Window 1.
  writeUsageState(home, 95, 22, { resetsAt: "2999-06-13T17:00:00Z" });

  runHook({ home, cwd, sessionId: "A" });
  fs.writeFileSync(projectHandoffPath(home, cwd), completeHandoffMarkdown("w1"));
  assert.equal(JSON.parse(runHook({ home, cwd, event: "PostToolBatch", sessionId: "A" }).stdout).continue, false);

  // A brand new session in the SAME window, still at 95%, must stay quiet whether it
  // stops or keeps doing tool work.
  assert.equal(runHook({ home, cwd, sessionId: "C" }).stdout, "");
  assert.equal(runHook({ home, cwd, event: "PostToolBatch", sessionId: "C" }).stdout, "");

  // A NEW 5-hour window (resets_at changed) at 95% re-arms protection.
  writeUsageState(home, 95, 22, { resetsAt: "2999-06-13T22:00:00Z" });
  const reArmed = runHook({ home, cwd, sessionId: "D" });
  assert.match(JSON.parse(reArmed.stdout).systemMessage, /5-hour usage is 95%/);
  assert.match(JSON.parse(reArmed.stdout).hookSpecificOutput.additionalContext, /Claude Cache Guard WARNING/);
});

test("different projects are independent: handling one does not silence another", () => {
  const home = tempDir();
  const projA = makeProject("indep-a");
  const projB = makeProject("indep-b");
  assert.equal(runCli({ home, cwd: projA, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd: projB, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd: projA, args: ["setting", "--five-hour-warning", "90"] }).status, 0);
  assert.equal(runCli({ home, cwd: projB, args: ["setting", "--five-hour-warning", "90"] }).status, 0);
  writeUsageState(home, 95, 22);

  // Project A is warned and handed off.
  runHook({ home, cwd: projA, sessionId: "A" });
  fs.writeFileSync(projectHandoffPath(home, projA), completeHandoffMarkdown("A done"));
  assert.equal(JSON.parse(runHook({ home, cwd: projA, event: "PostToolBatch", sessionId: "A" }).stdout).continue, false);

  // Project B has never been handled, so it must still warn at the same usage.
  const warnB = runHook({ home, cwd: projB, sessionId: "B" });
  assert.match(JSON.parse(warnB.stdout).systemMessage, /5-hour usage is 95%/);
  assert.match(JSON.parse(warnB.stdout).hookSpecificOutput.additionalContext, /Claude Cache Guard WARNING/);
});

test("ask mode asks once with a choice, never auto-stops, then stays quiet for the window", () => {
  const home = tempDir();
  const cwd = makeProject("ask mode");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  const setMode = runCli({ home, cwd, args: ["setting", "--five-hour-warning", "90", "--on-warning", "ask"] });
  assert.equal(setMode.status, 0, setMode.stderr);
  assert.match(setMode.stdout, /on_warning: ask/);
  assert.equal(readJson(getProjectConfigPath(cwd)).overrides.actions.on_warning, "ask");

  writeUsageState(home, 95, 22);

  // First warning asks the user; it must NOT force a stop.
  const ask1 = JSON.parse(runHook({ home, cwd, sessionId: "A" }).stdout);
  assert.equal(ask1.continue, undefined);
  assert.match(ask1.hookSpecificOutput.additionalContext, /Claude Cache Guard CHOICE/);
  assert.match(ask1.hookSpecificOutput.additionalContext, /Ask the user/);

  // Even after the handoff file is fully written, ask mode does not force-stop, and the
  // project is already quiet for this window.
  fs.writeFileSync(projectHandoffPath(home, cwd), completeHandoffMarkdown("ask"));
  assert.equal(runHook({ home, cwd, event: "PostToolBatch", sessionId: "B" }).stdout, "");

  const status = runCli({ home, cwd, args: ["status"] });
  assert.match(status.stdout, /handoff mode: ask/);
  assert.match(status.stdout, /asked the user once this usage window; project quiet/);
});

test("stale usage data (old updated_at) does not trigger a reminder; fresh data does", () => {
  const home = tempDir();
  const cwd = makeProject("freshness");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "90"] }).status, 0);

  // Usage says 95% but the snapshot is an hour old: do not act on it.
  writeUsageState(home, 95, 22, { updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  const staleRun = runHook({ home, cwd, sessionId: "A" });
  assert.equal(staleRun.status, 0, staleRun.stderr);
  assert.equal(staleRun.stdout, "");

  // Fresh data at the same percentage does warn.
  writeUsageState(home, 95, 22);
  assert.match(JSON.parse(runHook({ home, cwd, sessionId: "A" }).stdout).systemMessage, /5-hour usage is 95%/);
});

test("setting --on-warning rejects invalid modes", () => {
  const home = tempDir();
  const cwd = makeProject("invalid mode");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  const result = runCli({ home, cwd, args: ["setting", "--on-warning", "sometimes"] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /on-warning mode must be "auto" or "ask"/);
});

test("setting --on-warning alone updates mode without requiring a threshold", () => {
  const home = tempDir();
  const cwd = makeProject("mode only");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  const result = runCli({ home, cwd, args: ["setting", "--on-warning", "ask"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /on_warning: ask/);
  assert.doesNotMatch(result.stdout, /five_hour_warning:/);
  const projectConfig = readJson(getProjectConfigPath(cwd));
  assert.equal(projectConfig.overrides.actions.on_warning, "ask");
  assert.equal(projectConfig.overrides.thresholds, undefined);
});

test("auto mode: an untouched starter template is NOT treated as a completed handoff", () => {
  const home = tempDir();
  const cwd = makeProject("template not complete");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "90"] }).status, 0);
  writeUsageState(home, 95, 22);

  // Warn opens a pending episode; baseline = signature of the starter template.
  runHook({ home, cwd, sessionId: "A" });

  // Re-save the handoff file WITHOUT changing its content (still the starter template).
  // A mere touch / identical re-save must NOT count as a completed handoff.
  const hp = projectHandoffPath(home, cwd);
  fs.writeFileSync(hp, fs.readFileSync(hp, "utf8"));
  const stillPending = runHook({ home, cwd, event: "PostToolBatch", sessionId: "A" });
  const pendingParsed = JSON.parse(stillPending.stdout);
  assert.equal(pendingParsed.continue, undefined);
  assert.match(pendingParsed.hookSpecificOutput.additionalContext, /pending handoff/);

  // A real handoff (starter sentinel gone, all sections present) does complete.
  fs.writeFileSync(hp, completeHandoffMarkdown("real"));
  const done = runHook({ home, cwd, event: "PostToolBatch", sessionId: "A" });
  assert.equal(JSON.parse(done.stdout).continue, false);
});

test("switching to ask mode mid-window stops the auto force-stop for a pending episode", () => {
  const home = tempDir();
  const cwd = makeProject("mode switch midwindow");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "90"] }).status, 0);
  writeUsageState(home, 95, 22);

  // Auto mode warns -> pending episode.
  const warn = runHook({ home, cwd, sessionId: "A" });
  assert.match(JSON.parse(warn.stdout).hookSpecificOutput.additionalContext, /Claude Cache Guard WARNING/);

  // User switches to ask mid-window (usage still high, so the pending card is unchanged).
  assert.equal(runCli({ home, cwd, args: ["setting", "--on-warning", "ask"] }).status, 0);

  // Even with a complete handoff on disk, ask mode must NOT force-stop the goal.
  fs.writeFileSync(projectHandoffPath(home, cwd), completeHandoffMarkdown("real"));
  const afterSwitch = runHook({ home, cwd, event: "PostToolBatch", sessionId: "A" });
  assert.equal(afterSwitch.status, 0, afterSwitch.stderr);
  assert.equal(afterSwitch.stdout, "");
});

test("disable --rmhandoff keeps a handoff whose directory layout is not recognized and says so", () => {
  const home = tempDir();
  const cwd = makeProject("disable custom layout");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);

  // Point the project's handoff at a custom directory whose basename is NOT a project id
  // (e.g. a hand-edited storage layout). The safety guard must refuse to delete it, and the
  // CLI must say "kept ... not recognized" rather than the misleading "not found".
  const projectConfigPath = getProjectConfigPath(cwd);
  const projectConfig = readJson(projectConfigPath);
  const customDir = path.join(home, ".claude", "custom-handoffs");
  fs.mkdirSync(customDir, { recursive: true });
  const customHandoff = path.join(customDir, "next_session.md");
  fs.writeFileSync(customHandoff, completeHandoffMarkdown("custom"));
  projectConfig.handoff.file = customHandoff.replace(`${home}/`, "~/");
  fs.writeFileSync(projectConfigPath, JSON.stringify(projectConfig, null, 2));

  const disable = runCli({ home, cwd, args: ["disable", "--rmhandoff"] });
  assert.equal(disable.status, 0, disable.stderr);
  assert.match(disable.stdout, /handoff file: kept/);
  assert.match(disable.stdout, /not recognized as this project's handoff/);
  assert.doesNotMatch(disable.stdout, /handoff file: not found/);
  assert.doesNotMatch(disable.stdout, /handoff file: removed/);
  assert.equal(fs.existsSync(customHandoff), true);
});

test("a 5-hour window that expires, then a brand-new window starting later (different resets_at) both behave correctly", () => {
  // Mirrors how Claude's 5-hour limit actually works: the window starts when you use Claude
  // and is identified by its reset time (resets_at), NOT by a fixed wall clock. If you
  // finish one window (say it started at 5:00 and resets at 10:00), go idle, then only start
  // a NEW conversation hours later (say 12:00, which resets at 17:00), Claude Code reports a
  // DIFFERENT resets_at for that new window. The guard keys off resets_at, so the new window
  // re-arms and asks for a fresh handoff. In the gap between the two windows, leftover/expired
  // data must never trigger a warning.
  const home = tempDir();
  const cwd = makeProject("dynamic window restart");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "90"] }).status, 0);

  // Window 1 (started 5:00, resets 10:00): warn + handoff -> handled for this window.
  writeUsageState(home, 95, 22, { resetsAt: "2999-06-13T10:00:00Z" });
  assert.match(JSON.parse(runHook({ home, cwd, sessionId: "w1" }).stdout).systemMessage, /5-hour usage is 95%/);
  fs.writeFileSync(projectHandoffPath(home, cwd), completeHandoffMarkdown("w1"));
  assert.equal(JSON.parse(runHook({ home, cwd, event: "PostToolBatch", sessionId: "w1" }).stdout).continue, false);
  assert.equal(readJson(hookStatePathFor(home, cwd)).window_id, "2999-06-13T10:00:00Z");

  // The gap: window 1 has expired (resets_at now in the past) AND the snapshot is old. The
  // guard must NOT act on this leftover 95% number.
  writeUsageState(home, 95, 22, { resetsAt: "2000-01-01T00:00:00Z", updatedAt: "2000-01-01T00:00:00Z" });
  assert.equal(runHook({ home, cwd, sessionId: "gap" }).stdout, "");

  // A brand-new window starts later (first message at 12:00, resets 17:00): a DIFFERENT,
  // fresh resets_at -> re-arm and ask for a fresh handoff even at the same 95%.
  writeUsageState(home, 95, 22, { resetsAt: "2999-06-13T17:00:00Z" });
  const w2 = runHook({ home, cwd, sessionId: "w2" });
  assert.match(JSON.parse(w2.stdout).systemMessage, /5-hour usage is 95%/);
  assert.match(JSON.parse(w2.stdout).hookSpecificOutput.additionalContext, /Claude Cache Guard WARNING/);
  assert.equal(readJson(hookStatePathFor(home, cwd)).window_id, "2999-06-13T17:00:00Z");
});

test("a global usage reset (reported usage drops sharply) re-arms the project so it warns again when usage climbs back", () => {
  // If Anthropic resets everyone's usage at once, the only thing the guard sees is the
  // reported number dropping. It never computes its own clock, so it simply follows the
  // reported usage: the drop clears the handled card (re-arm), and a later climb back to the
  // threshold asks for a fresh handoff again.
  const home = tempDir();
  const cwd = makeProject("global reset");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "90"] }).status, 0);

  // Handled at 95% in the current window.
  writeUsageState(home, 95, 22);
  assert.match(JSON.parse(runHook({ home, cwd, sessionId: "g1" }).stdout).systemMessage, /5-hour usage is 95%/);
  fs.writeFileSync(projectHandoffPath(home, cwd), completeHandoffMarkdown("g1"));
  assert.equal(JSON.parse(runHook({ home, cwd, event: "PostToolBatch", sessionId: "g1" }).stdout).continue, false);

  // Global reset: reported usage drops sharply -> guard goes quiet and re-arms.
  writeUsageState(home, 5, 22);
  assert.equal(runHook({ home, cwd, sessionId: "g2" }).stdout, "");
  assert.equal(readJson(hookStatePathFor(home, cwd)).threshold_active, false);

  // Usage climbs back to the threshold -> a fresh handoff is required again.
  writeUsageState(home, 95, 22);
  assert.match(JSON.parse(runHook({ home, cwd, sessionId: "g3" }).stdout).systemMessage, /5-hour usage is 95%/);
});

test("ccg handoff appends project-local guidance from .claude/ccg-handoff.md, and status reports it", () => {
  const home = tempDir();
  const cwd = makeProject("guided project");
  writeUsageState(home, 20, 22);
  runCli({ home, cwd, args: ["enable"] });

  // Without a guidance file, the handoff prompt has no project_specific_guidance block.
  const before = runCli({ home, cwd, args: ["handoff"] });
  assert.equal(before.status, 0, before.stderr);
  assert.doesNotMatch(before.stdout, /project_specific_guidance/);

  // Add project-local guidance.
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".claude", "ccg-handoff.md"), "Always run `npm test` and note the result.\n");

  const after = runCli({ home, cwd, args: ["handoff"] });
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout, /<project_specific_guidance>/);
  assert.match(after.stdout, /Always run `npm test`/);
  // It must stay subordinate to the output contract and safety rules.
  assert.match(after.stdout, /those always win/);
  assert.match(after.stdout, /<output_contract>/);

  // status surfaces it so the user can confirm it is active.
  const status = runCli({ home, cwd, args: ["status"] });
  assert.match(status.stdout, /handoff guidance: active \(\.claude\/ccg-handoff\.md\)/);

  // A whitespace-only guidance file is treated as no guidance (no block, no status line).
  fs.writeFileSync(path.join(cwd, ".claude", "ccg-handoff.md"), "   \n\n");
  assert.doesNotMatch(runCli({ home, cwd, args: ["handoff"] }).stdout, /project_specific_guidance/);
  assert.doesNotMatch(runCli({ home, cwd, args: ["status"] }).stdout, /handoff guidance: active/);
});

test("hook reminders embed project-local handoff guidance in both warn and ask modes", () => {
  // The hook reminders are the primary path the user actually sees; both the
  // auto/warn builder and the ask builder must carry the guidance. Use a
  // separate project per mode so per-window episode state does not interfere.
  function guidanceInHookContext({ askMode }) {
    const home = tempDir();
    const cwd = makeProject(askMode ? "guided ask" : "guided warn");
    assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
    const settingArgs = askMode
      ? ["setting", "--five-hour-warning", "90", "--on-warning", "ask"]
      : ["setting", "--five-hour-warning", "90"];
    assert.equal(runCli({ home, cwd, args: settingArgs }).status, 0);
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".claude", "ccg-handoff.md"), "Always run `cargo test` first.\n");
    writeUsageState(home, 90, 22);
    return JSON.parse(runHook({ home, cwd, sessionId: askMode ? "ask-1" : "warn-1" }).stdout);
  }

  const warn = guidanceInHookContext({ askMode: false });
  assert.match(warn.hookSpecificOutput.additionalContext, /Claude Cache Guard WARNING/);
  assert.match(warn.hookSpecificOutput.additionalContext, /<project_specific_guidance>/);
  assert.match(warn.hookSpecificOutput.additionalContext, /cargo test/);

  const ask = guidanceInHookContext({ askMode: true });
  assert.match(ask.hookSpecificOutput.additionalContext, /Claude Cache Guard CHOICE/);
  assert.match(ask.hookSpecificOutput.additionalContext, /<project_specific_guidance>/);
  assert.match(ask.hookSpecificOutput.additionalContext, /cargo test/);
});

test("hook does not fire on usage with no resets_at, then warns once a real window appears", () => {
  const home = tempDir();
  const cwd = makeProject("no window id");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);
  assert.equal(runCli({ home, cwd, args: ["setting", "--five-hour-warning", "90"] }).status, 0);

  // 95% and fresh, but no resets_at -> no identifiable window -> no-op (not a
  // handoff under an empty window id that would never re-arm).
  writeUsageState(home, 95, 22, { resetsAt: null });
  const noWindow = runHook({ home, cwd, sessionId: "A" });
  assert.equal(noWindow.status, 0, noWindow.stderr);
  assert.equal(noWindow.stdout, "");

  // Once usage carries a real window id, the same percentage warns.
  writeUsageState(home, 95, 22);
  assert.match(JSON.parse(runHook({ home, cwd, sessionId: "A" }).stdout).systemMessage, /5-hour usage is 95%/);
});

test("ccg disable survives a corrupt .claude/settings.local.json and still cleans up the rest", () => {
  const home = tempDir();
  const cwd = makeProject("disable corrupt");
  assert.equal(runCli({ home, cwd, args: ["enable"] }).status, 0);

  // Corrupt the local settings so removeProjectUsageHook would otherwise throw.
  fs.writeFileSync(path.join(cwd, ".claude", "settings.local.json"), "{ not valid json");

  const result = runCli({ home, cwd, args: ["disable"] });
  assert.match(result.stdout, /Project disabled/);
  assert.match(result.stdout, /project config: removed/);
  assert.match(result.stdout, /hook settings: NOT removed/);
  assert.equal(result.status, 1, "partial failure is surfaced as a non-zero exit");

  // The cleanup that could proceed did: project config and slash commands are gone.
  assert.equal(fs.existsSync(path.join(cwd, ".claude-cache-guard.json")), false);
  assert.equal(fs.existsSync(path.join(cwd, ".claude", "commands", "ccgresume.md")), false);
});
