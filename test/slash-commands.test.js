import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SLASH_COMMAND_NAMES,
  installGlobalSlashCommands,
  removeGlobalSlashCommands,
} from "../src/project-hooks.js";

// Slash commands are GLOBAL now: `ccg install` writes them under ~/.claude/commands.
// These tests drive the global installer/remover against a throwaway temp HOME.
function tempHome(prefix = "ccg-slash-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync(dir);
}

function commandsDirOf(home) {
  return path.join(home, ".claude", "commands");
}

function listCommands(home) {
  const dir = commandsDirOf(home);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

test("SLASH_COMMAND_NAMES are ccg-prefixed, hyphen-free, and unique", () => {
  assert.ok(SLASH_COMMAND_NAMES.length >= 8);
  for (const name of SLASH_COMMAND_NAMES) {
    assert.match(name, /^ccg/, `command "${name}" must be ccg prefixed`);
    assert.doesNotMatch(name, /-/, `command "${name}" must not contain a hyphen`);
  }
  assert.equal(new Set(SLASH_COMMAND_NAMES).size, SLASH_COMMAND_NAMES.length, "names must be unique");
});

test("install creates one ccg*.md per command under ~/.claude/commands and reports them", async () => {
  const home = tempHome();
  const result = await installGlobalSlashCommands({ homeDir: home });

  assert.equal(result.commandsDir, commandsDirOf(home));
  assert.equal(result.installed.length, SLASH_COMMAND_NAMES.length);

  const files = listCommands(home);
  assert.deepEqual(
    files,
    SLASH_COMMAND_NAMES.map((n) => `${n}.md`).sort()
  );

  // ccgresume no longer bakes in a handoff path; it goes through `ccg resume`.
  const resume = fs.readFileSync(path.join(commandsDirOf(home), "ccgresume.md"), "utf8");
  assert.ok(resume.includes("!`ccg resume"), "must pre-execute `ccg resume`");
  assert.doesNotMatch(resume, /undefined/, "no handoffPath interpolates as undefined");
});

test("install is idempotent: a second install overwrites without piling up files", async () => {
  const home = tempHome();
  await installGlobalSlashCommands({ homeDir: home });
  await installGlobalSlashCommands({ homeDir: home });
  assert.equal(listCommands(home).length, SLASH_COMMAND_NAMES.length);
});

test("remove deletes every ccg*.md it installed (round-trip) but keeps ~/.claude itself", async () => {
  const home = tempHome();
  await installGlobalSlashCommands({ homeDir: home });
  assert.equal(listCommands(home).length, SLASH_COMMAND_NAMES.length);

  const result = await removeGlobalSlashCommands({ homeDir: home });
  const removed = result.results.filter((r) => r.removed).map((r) => r.name).sort();
  assert.deepEqual(removed, [...SLASH_COMMAND_NAMES].sort());

  // An otherwise-empty commands dir is cleaned up entirely...
  assert.equal(fs.existsSync(commandsDirOf(home)), false);
  // ...but the global remover must NEVER remove ~/.claude (it holds settings.json,
  // usage-state.json, and more).
  assert.equal(fs.existsSync(path.join(home, ".claude")), true, "~/.claude must survive");
});

// Regression for the data-loss bug: uninstall must NEVER delete a user's own
// hand-written slash commands that happen to share a generic name. ccg only
// ever created ccg*.md files, so removal must be scoped to that namespace.
test("remove leaves the user's own non-ccg slash commands untouched", async () => {
  const home = tempHome();
  const dir = commandsDirOf(home);
  fs.mkdirSync(dir, { recursive: true });

  const userFiles = {
    "status.md": "my own status command",
    "config.md": "my own config command",
    "resume.md": "my own resume command",
    "deploy.md": "my own deploy command",
  };
  for (const [name, body] of Object.entries(userFiles)) {
    fs.writeFileSync(path.join(dir, name), body);
  }

  await installGlobalSlashCommands({ homeDir: home });
  await removeGlobalSlashCommands({ homeDir: home });

  // Every user file survives with original content; no ccg*.md remains.
  for (const [name, body] of Object.entries(userFiles)) {
    const p = path.join(dir, name);
    assert.equal(fs.existsSync(p), true, `${name} must survive ccg uninstall`);
    assert.equal(fs.readFileSync(p, "utf8"), body, `${name} content must be unchanged`);
  }
  assert.equal(
    listCommands(home).filter((f) => f.startsWith("ccg")).length,
    0,
    "all ccg*.md must be gone"
  );
});

test("remove keeps a non-empty commands dir (user files present) and is safe when nothing is installed", async () => {
  const home = tempHome();
  const dir = commandsDirOf(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "deploy.md"), "x");

  // Removing when no ccg commands were ever installed must not throw and must
  // not delete the dir (it still has the user's file).
  const result = await removeGlobalSlashCommands({ homeDir: home });
  assert.equal(result.results.every((r) => r.removed === false), true);
  assert.equal(fs.existsSync(path.join(dir, "deploy.md")), true);
  assert.equal(fs.existsSync(dir), true, "non-empty commands dir must remain");
});

test("remove is a no-op (no throw) when the commands dir does not exist", async () => {
  const home = tempHome();
  const result = await removeGlobalSlashCommands({ homeDir: home });
  assert.equal(result.results.every((r) => r.removed === false), true);
});

// /ccgconfig is the settings command: flags apply directly via `ccg setting`,
// no flags just reports the pre-executed current values. It must never steer
// Claude toward `ccg setting` with no flags — that path requires a TTY and
// always throws in Claude Code's non-interactive shell. There is no separate
// ccgsetting command.
test("ccgconfig applies flags via ccg setting and avoids the TTY failure path", async () => {
  const home = tempHome();
  await installGlobalSlashCommands({ homeDir: home });
  assert.equal(SLASH_COMMAND_NAMES.includes("ccgsetting"), false);
  assert.equal(fs.existsSync(path.join(commandsDirOf(home), "ccgsetting.md")), false);

  const body = fs.readFileSync(path.join(commandsDirOf(home), "ccgconfig.md"), "utf8");
  assert.match(body, /\$ARGUMENTS/, "must receive the user's flags");
  assert.match(body, /--five-hour-warning <1-99>/, "must document the threshold flag");
  assert.match(body, /--on-warning <auto\|ask>/, "must document the warning-mode flag");
  assert.match(body, /AskUserQuestion/, "no-flag path must open the native selection menu");
  assert.match(body, /90%, 95%, 97%/, "menu must offer the 90/95/97 threshold choices");
  assert.match(body, /Validate the answers before running/, "free-typed menu answers must be validated");
  assert.match(body, /Never run `ccg setting` with no flags/);
});

// Cheap-by-construction contract: every command ships frontmatter (description
// for the / menu, disable-model-invocation to stay out of the model's per-turn
// skill context), and read-only commands pre-execute their ccg call so the
// model only formats output that is already in the prompt.
test("every command has frontmatter and report commands pre-execute their ccg call", async () => {
  const home = tempHome();
  await installGlobalSlashCommands({ homeDir: home });
  for (const name of SLASH_COMMAND_NAMES) {
    const body = fs.readFileSync(path.join(commandsDirOf(home), `${name}.md`), "utf8");
    assert.match(body, /^---\n/, `${name} must start with frontmatter`);
    // The managed marker must be the first line inside the frontmatter (a YAML
    // comment, so it's invisible to the parser) — it's how install/remove tell
    // a ccg-generated file from a user's same-name file.
    assert.match(body, /^---\n# managed by claude-cache-guard/, `${name} must carry the managed marker as its first frontmatter line`);
    assert.match(body, /\ndescription: /, `${name} must have a description`);
    assert.match(body, /\ndisable-model-invocation: true\n/, `${name} must not be model-invocable`);
  }
  const preExecuted = [
    ["ccgresume", "ccg resume"],
    ["ccgstatus", "ccg status"],
    ["ccgusage", "ccg usage"],
    ["ccgconfig", "ccg status"],
    ["ccghandoff", "ccg handoff"],
  ];
  for (const [name, cliCall] of preExecuted) {
    const body = fs.readFileSync(path.join(commandsDirOf(home), `${name}.md`), "utf8");
    assert.ok(body.includes("!`" + cliCall), `${name} must pre-execute \`${cliCall}\``);
  }
  // /ccgdebug absorbs the retired /ccgdoctor: it pre-executes BOTH diagnostics.
  const debugBody = fs.readFileSync(path.join(commandsDirOf(home), "ccgdebug.md"), "utf8");
  assert.ok(debugBody.includes("!`ccg doctor"), "ccgdebug must pre-execute `ccg doctor`");
  assert.ok(debugBody.includes("!`ccg debug"), "ccgdebug must pre-execute `ccg debug`");
});

// Regression pin: ccgresume must NOT pre-execute `cat` on the handoff, and must
// NOT bake in a handoff path (it is global now, project-agnostic). It goes through
// `ccg resume`, which resolves the project from cwd and prints the handoff; the
// fallback tells Claude to run `ccg status` to find the path and read it directly.
test("ccgresume reads the handoff via `ccg resume` with a `ccg status` fallback and no baked-in path", async () => {
  const home = tempHome();
  await installGlobalSlashCommands({ homeDir: home });

  const resume = fs.readFileSync(path.join(commandsDirOf(home), "ccgresume.md"), "utf8");
  assert.ok(resume.includes("!`ccg resume"), "must pre-execute `ccg resume`");
  assert.doesNotMatch(resume, /!`\s*cat /, "must not pre-execute a `cat` on the handoff path");
  assert.match(resume, /allowed-tools: Bash\(ccg:\*\)/, "must grant Bash(ccg:*), not Bash(cat:*)");
  // The fallback routes through `ccg status` to find the path — nothing project-
  // specific is interpolated into the template.
  assert.match(resume, /run `ccg status` to find the handoff path and read that file yourself/);
  assert.doesNotMatch(resume, /undefined/, "no undefined anywhere");
  // The resume command deliberately carries no model/effort override.
  assert.doesNotMatch(resume, /\nmodel:/);
  assert.doesNotMatch(resume, /\neffort:/);
});

// Renamed or retired commands must not leave the old .md behind: a stale
// ccg-setting.md or ccgsetting.md would keep dead entries in the user's
// command list forever.
test("install removes the legacy command files left by older versions", async () => {
  const home = tempHome();
  fs.mkdirSync(commandsDirOf(home), { recursive: true });
  for (const legacy of ["ccg-setting.md", "ccg-status.md", "ccg-resume.md", "ccg-check-threshold.md", "ccgsetting.md", "ccgdoctor.md", "ccgcheckthreshold.md"]) {
    fs.writeFileSync(path.join(commandsDirOf(home), legacy), "old body");
  }

  await installGlobalSlashCommands({ homeDir: home });

  const files = listCommands(home);
  assert.equal(files.some((f) => f.startsWith("ccg-")), false, "no hyphenated ccg-*.md may remain");
  assert.equal(fs.existsSync(path.join(commandsDirOf(home), "ccgsetting.md")), false, "retired ccgsetting.md must be cleaned up");
  assert.equal(fs.existsSync(path.join(commandsDirOf(home), "ccgdoctor.md")), false, "retired ccgdoctor.md must be cleaned up (now part of /ccgdebug)");
  assert.equal(fs.existsSync(path.join(commandsDirOf(home), "ccgcheckthreshold.md")), false, "retired ccgcheckthreshold.md must be cleaned up (now part of /ccgstatus)");
  assert.equal(fs.existsSync(path.join(commandsDirOf(home), "ccgstatus.md")), true);
});

test("remove also deletes the legacy hyphenated ccg-*.md without an install first", async () => {
  const home = tempHome();
  fs.mkdirSync(commandsDirOf(home), { recursive: true });
  fs.writeFileSync(path.join(commandsDirOf(home), "ccg-setting.md"), "old body");
  fs.writeFileSync(path.join(commandsDirOf(home), "ccg-resume.md"), "old body");

  const result = await removeGlobalSlashCommands({ homeDir: home });

  for (const name of ["ccg-setting", "ccg-resume"]) {
    const legacy = result.results.find((r) => r.name === name);
    assert.equal(legacy?.removed, true, `${name} must be reported as removed`);
    assert.equal(fs.existsSync(path.join(commandsDirOf(home), `${name}.md`)), false);
  }
  assert.equal(fs.existsSync(commandsDirOf(home)), false, "empty commands dir is cleaned up");
});

// FIX 1: a user's own same-name command must be preserved (renamed aside),
// never silently clobbered.
test("install backs up a user-authored same-name command instead of clobbering it", async () => {
  const home = tempHome();
  const dir = commandsDirOf(home);
  fs.mkdirSync(dir, { recursive: true });
  const userBody = "my hand-written ccgstatus command\n";
  fs.writeFileSync(path.join(dir, "ccgstatus.md"), userBody);

  const result = await installGlobalSlashCommands({ homeDir: home });

  // ccgstatus.md is now the generated command (carries the marker) and differs
  // from the user's original.
  const nowBody = fs.readFileSync(path.join(dir, "ccgstatus.md"), "utf8");
  assert.match(nowBody, /^---\n# managed by claude-cache-guard/);
  assert.notEqual(nowBody, userBody);

  // Exactly one .bak-* sibling holding the user's original bytes.
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith("ccgstatus.md.bak-"));
  assert.equal(backups.length, 1, "exactly one backup of the user's file");
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), userBody);

  // The install entry records where the backup went.
  const entry = result.installed.find((e) => e.name === "ccgstatus");
  assert.ok(entry.backupPath && fs.existsSync(entry.backupPath), "backupPath recorded and exists");
});

// FIX 1: a file generated by a pre-marker ccg version is recognized as ours via
// the grandfather clause, so install overwrites it without a spurious backup and
// remove deletes it.
test("install overwrites a pre-marker generated file without backing it up, and remove deletes it", async () => {
  const home = tempHome();
  const dir = commandsDirOf(home);
  await installGlobalSlashCommands({ homeDir: home });

  // Simulate a pre-marker file: strip the marker line but keep the frontmatter
  // and the disable-model-invocation key (the grandfather signal).
  const target = path.join(dir, "ccgusage.md");
  const preMarker = fs.readFileSync(target, "utf8").replace(/^# managed by claude-cache-guard[^\n]*\n/m, "");
  assert.doesNotMatch(preMarker, /managed by claude-cache-guard/);
  assert.match(preMarker, /\ndisable-model-invocation: true\n/);
  fs.writeFileSync(target, preMarker);

  await installGlobalSlashCommands({ homeDir: home });

  assert.equal(
    fs.readdirSync(dir).filter((f) => f.startsWith("ccgusage.md.bak-")).length,
    0,
    "a pre-marker file must NOT be backed up"
  );
  assert.match(fs.readFileSync(target, "utf8"), /^---\n# managed by claude-cache-guard/);

  await removeGlobalSlashCommands({ homeDir: home });
  assert.equal(fs.existsSync(target), false, "the re-marked file must be removed");
});

// FIX 1: remove must keep a user's own same-name file (here: plain text, no
// frontmatter) with its content untouched.
test("remove keeps a user-authored same-name command untouched", async () => {
  const home = tempHome();
  const dir = commandsDirOf(home);
  fs.mkdirSync(dir, { recursive: true });
  const userBody = "plain text, my own ccgusage, no frontmatter\n";
  fs.writeFileSync(path.join(dir, "ccgusage.md"), userBody);

  const result = await removeGlobalSlashCommands({ homeDir: home });

  const entry = result.results.find((r) => r.name === "ccgusage");
  assert.equal(entry.removed, false);
  assert.ok(entry.keptReason, "kept file must carry a reason the CLI can report");
  assert.equal(fs.existsSync(path.join(dir, "ccgusage.md")), true);
  assert.equal(fs.readFileSync(path.join(dir, "ccgusage.md"), "utf8"), userBody);
});

// FIX 1 + FIX 2: a symlink planted at a command path must be replaced by a
// regular file; the write must never follow the link to its victim.
test("install replaces a symlink at a command path with a regular file, leaving the victim intact", async () => {
  const home = tempHome();
  const dir = commandsDirOf(home);
  fs.mkdirSync(dir, { recursive: true });
  const victim = path.join(home, "victim.txt");
  const victimBody = "precious user data\n";
  fs.writeFileSync(victim, victimBody);
  fs.symlinkSync(victim, path.join(dir, "ccgdebug.md"));

  const result = await installGlobalSlashCommands({ homeDir: home });

  // Victim byte-for-byte intact.
  assert.equal(fs.readFileSync(victim, "utf8"), victimBody);
  // The command path is now a REGULAR file (not a link) with generated content.
  const st = fs.lstatSync(path.join(dir, "ccgdebug.md"));
  assert.equal(st.isSymbolicLink(), false);
  assert.equal(st.isFile(), true);
  assert.match(fs.readFileSync(path.join(dir, "ccgdebug.md"), "utf8"), /^---\n# managed by claude-cache-guard/);
  const entry = result.installed.find((e) => e.name === "ccgdebug");
  assert.equal(entry.replacedSymlink, true);
});

// FIX 1: removing a symlinked command path removes only the link, not the target.
test("remove of a symlinked command path removes only the link, not the target", async () => {
  const home = tempHome();
  const dir = commandsDirOf(home);
  fs.mkdirSync(dir, { recursive: true });
  const victim = path.join(home, "victim.txt");
  const victimBody = "precious user data\n";
  fs.writeFileSync(victim, victimBody);
  fs.symlinkSync(victim, path.join(dir, "ccgdebug.md"));

  const result = await removeGlobalSlashCommands({ homeDir: home });

  const entry = result.results.find((r) => r.name === "ccgdebug");
  assert.equal(entry.removed, true);
  assert.equal(fs.existsSync(path.join(dir, "ccgdebug.md")), false, "the link is gone");
  assert.equal(fs.existsSync(victim), true, "the target survives");
  assert.equal(fs.readFileSync(victim, "utf8"), victimBody);
});

// FIX 2: a DANGLING symlink at a legacy command name (its target no longer
// exists) must still be cleaned up. access(F_OK) follows the link and reports
// ENOENT, letting the stale link survive; probing with lstat instead detects the
// link itself and removes it. Install cleans legacy names, so install removes it.
test("install removes a dangling symlink planted at a legacy command name", async () => {
  const home = tempHome();
  const dir = commandsDirOf(home);
  fs.mkdirSync(dir, { recursive: true });
  const legacyPath = path.join(dir, "ccgdoctor.md");
  fs.symlinkSync(path.join(home, "missing-target.md"), legacyPath);
  // Sanity: the link exists (lstat) but its target does not (existsSync follows it).
  assert.equal(fs.lstatSync(legacyPath).isSymbolicLink(), true);
  assert.equal(fs.existsSync(legacyPath), false, "target must be missing (dangling)");

  await installGlobalSlashCommands({ homeDir: home });

  assert.equal(
    fs.lstatSync(legacyPath, { throwIfNoEntry: false }),
    undefined,
    "dangling legacy symlink must be removed by install"
  );
});

// FIX 2: the global remover must also clear a dangling legacy symlink, even with
// no install first, and report it as removed.
test("remove clears a dangling legacy symlink without an install first", async () => {
  const home = tempHome();
  const dir = commandsDirOf(home);
  fs.mkdirSync(dir, { recursive: true });
  const legacyPath = path.join(dir, "ccgdoctor.md");
  fs.symlinkSync(path.join(home, "missing-target.md"), legacyPath);

  const result = await removeGlobalSlashCommands({ homeDir: home });

  const entry = result.results.find((r) => r.name === "ccgdoctor");
  assert.equal(entry?.removed, true, "dangling legacy symlink must be reported removed");
  assert.equal(
    fs.lstatSync(legacyPath, { throwIfNoEntry: false }),
    undefined,
    "dangling legacy symlink must be gone"
  );
  // No install ran, so no ccg*.md exists; the empty commands dir is cleaned up.
  assert.equal(fs.existsSync(dir), false, "empty commands dir is cleaned up");
});
