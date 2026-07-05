import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  removeProjectSlashCommands,
  removePrototypeBareCommandResidue,
  countProjectSlashCommands,
  listPrototypeBareCommandResidue,
} from "../src/project-hooks.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "claude-cache-guard.js");

// A never-shipped prototype `ccg enable` (2026-06-22, working tree only) wrote
// these 11 BARE-named command files into a project's .claude/commands — no
// frontmatter, no managed marker. usage.md shadows Claude Code's built-in /usage
// (a real incident). The cleanup gates on BOTH the bare name AND a content
// fingerprint, so a user's own same-name file is never touched. These are the
// verbatim prototype contents, reconstructed from the incident machine's residue
// (resume.md's embedded absolute path is intentionally machine-specific here to
// prove the fingerprint is path-independent).
const PROTOTYPE_CONTENTS = {
  "usage.md": `Run \`ccg usage\` and report current Claude Code usage.

Highlight the 5-hour and 7-day window percentages and when they reset. If usage is approaching the threshold, flag it.
`,
  "status.md": `Run \`ccg status\` and summarize the output.

Report whether ccg is enabled, the warning threshold, hook status, handoff state, and any issues. Suggest fixes for anything that looks wrong.
`,
  "debug.md": `Run \`ccg debug\` and summarize the diagnostic output.

Highlight anything that looks misconfigured. This is mostly useful when troubleshooting ccg issues.
`,
  "disable.md": `Disable ccg for this project. Run \`ccg disable\` with any flags the user provided after this command.

Add \`--rmhandoff\` to also delete the handoff file. Without it, the handoff is kept for future reference.
`,
  "doctor.md": `Run \`ccg doctor\` and report the results.

Explain any warnings or failures and suggest how to fix them. If everything passes, say so briefly.
`,
  // The bare era shipped two enable.md variants (`/project:disable`, then
  // `/disable`); the fingerprint must match both. This is the earlier one.
  "enable.md": `Enable or re-enable ccg for this project. Run \`ccg enable\` with any flags the user provided after this command.

Add \`--force\` to overwrite an existing handoff file. Useful after \`/project:disable\` or to refresh a stale setup.
`,
  "handoff.md": `Run \`ccg handoff\` and show the handoff prompt for this project.

This is the prompt CCG uses to ask Claude to write the next_session.md. Useful for debugging or manually triggering a handoff.
`,
  // resume.md embeds a machine-specific absolute path; the fingerprint must match
  // regardless of what that path is.
  "resume.md": `Resume the unfinished work from the CCG handoff.

Read the handoff file at /Users/somebody-else/.claude/next-session/other-project--ffffffff/next_session.md, then:
1. Verify the current project state before editing — trust the filesystem over the handoff when they differ.
2. Continue from "Next Steps" — don't redo completed work unless verification shows it's needed.
3. "Original User Prompts" is authoritative — if summaries conflict, the original prompts win.
4. Respect safety constraints and "Do Not Repeat" notes.
5. Work autonomously until done or blocked.
`,
  "setting.md": `Adjust ccg project settings. Run \`ccg setting\` with any arguments the user provided after this command.

Common flags:
- \`--five-hour-warning <number>\` — warning percentage (1–99)
- \`--on-warning <auto|ask>\` — auto stops the goal; ask lets you choose

If no arguments were given, run \`ccg setting\` interactively or show current settings with \`ccg status\`.
`,
  "config.md": `Show ccg global config. Run \`ccg config show\` and summarize the output.

Report the current global thresholds and handoff settings. Mention \`ccg config path\` if the user wants to edit the file directly.
`,
  "check-threshold.md": `Run \`ccg check-threshold\` with any flags the user provided after this command and report the result.

Common flags: \`--five-hour <percent>\`, \`--seven-day <percent>\`, \`--json\`. Without flags it uses the configured thresholds.
`,
};

// The later enable.md variant (18:13–18:20 of the bare era) — same fingerprint
// markers, different tail. Both generations must be swept.
const ENABLE_VARIANT_B = PROTOTYPE_CONTENTS["enable.md"].replace(
  "/project:disable",
  "/disable"
);

const PROTOTYPE_NAMES = Object.keys(PROTOTYPE_CONTENTS);
const PROTOTYPE_BARE_NAMES = PROTOTYPE_NAMES.map((n) => n.replace(/\.md$/, ""));

function tempProject(prefix = "ccg-proto-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync(dir);
}

function commandsDirOf(cwd) {
  return path.join(cwd, ".claude", "commands");
}

function seedCommands(cwd, files) {
  const dir = commandsDirOf(cwd);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

function runCli({ home, cwd, args }) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

test("removeProjectSlashCommands deletes every verbatim prototype bare-name file", async () => {
  const cwd = tempProject();
  const dir = seedCommands(cwd, PROTOTYPE_CONTENTS);

  const result = await removeProjectSlashCommands({ cwd });

  const removed = result.results.filter((r) => r.removed).map((r) => r.name).sort();
  assert.deepEqual(removed, [...PROTOTYPE_BARE_NAMES].sort(), "all 11 prototype files reported removed (extension-less names)");
  for (const name of PROTOTYPE_NAMES) {
    assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} must be gone`);
  }
});

test("removeProjectSlashCommands sweeps both enable.md generations", async () => {
  const cwd = tempProject();
  const dir = seedCommands(cwd, { "enable.md": ENABLE_VARIANT_B });

  const result = await removeProjectSlashCommands({ cwd });

  assert.equal(fs.existsSync(path.join(dir, "enable.md")), false, "variant B must be gone");
  assert.equal(result.results.find((r) => r.name === "enable" && r.removed) !== undefined, true);
});

test("removeProjectSlashCommands keeps a user's own same-name file, without naming it in results", async () => {
  const cwd = tempProject();
  // A user's own usage.md / status.md that merely share a generic name. Content
  // does not match the prototype fingerprint, so they must survive untouched —
  // and produce NO results entry at all (ccg never wrote them, so disable and
  // uninstall output must not mention them).
  const userFiles = {
    "usage.md": "# My own usage notes\n\nnothing to do with ccg.\n",
    "status.md": "Show me the git status please.\n",
    "config.md": "my personal /config helper\n",
  };
  const dir = seedCommands(cwd, userFiles);

  const result = await removeProjectSlashCommands({ cwd });

  for (const [name, body] of Object.entries(userFiles)) {
    const p = path.join(dir, name);
    assert.equal(fs.existsSync(p), true, `${name} must survive`);
    assert.equal(fs.readFileSync(p, "utf8"), body, `${name} content must be unchanged`);
    const entry = result.results.find((r) => r.commandPath === p);
    assert.equal(entry, undefined, `${name} must not appear in results at all`);
  }
});

test("removeProjectSlashCommands never touches a symlink planted at a bare name", async () => {
  const cwd = tempProject();
  const dir = commandsDirOf(cwd);
  fs.mkdirSync(dir, { recursive: true });
  // The victim even contains verbatim prototype content: proof we never FOLLOW the
  // link to read/delete it. A symlink at a bare name is never ours.
  const victim = path.join(cwd, "victim.md");
  fs.writeFileSync(victim, PROTOTYPE_CONTENTS["usage.md"]);
  const linkPath = path.join(dir, "usage.md");
  fs.symlinkSync(victim, linkPath);

  const result = await removeProjectSlashCommands({ cwd });

  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true, "the link must remain");
  assert.equal(fs.existsSync(victim), true, "the victim must survive");
  assert.equal(fs.readFileSync(victim, "utf8"), PROTOTYPE_CONTENTS["usage.md"]);
  const entry = result.results.find((r) => r.commandPath === linkPath);
  assert.equal(entry, undefined, "the link must not appear in results");
});

test("an unreadable bare-name file is skipped, and never aborts the rest of the sweep", async (t) => {
  const cwd = tempProject();
  const dir = seedCommands(cwd, {
    "usage.md": PROTOTYPE_CONTENTS["usage.md"],
    "config.md": "user file made unreadable\n",
    "status.md": PROTOTYPE_CONTENTS["status.md"],
  });
  const lockedPath = path.join(dir, "config.md");
  fs.chmodSync(lockedPath, 0o000);
  t.after(() => {
    try { fs.chmodSync(lockedPath, 0o644); } catch { /* already gone */ }
  });

  // Listing skips the unreadable file and still reports the two genuine ones.
  const residue = await listPrototypeBareCommandResidue({ cwd });
  assert.deepEqual(residue.map((r) => r.name).sort(), ["status.md", "usage.md"]);

  // The sweep removes the two genuine files, keeps the unreadable one, no throw.
  const result = await removeProjectSlashCommands({ cwd });
  assert.equal(fs.existsSync(path.join(dir, "usage.md")), false);
  assert.equal(fs.existsSync(path.join(dir, "status.md")), false);
  assert.equal(fs.existsSync(lockedPath), true, "the unreadable file must survive");
  assert.equal(result.results.find((r) => r.commandPath === lockedPath), undefined);
});

test("removePrototypeBareCommandResidue removes only residue and tidies an emptied dir", async () => {
  const cwd = tempProject();
  const dir = seedCommands(cwd, {
    "usage.md": PROTOTYPE_CONTENTS["usage.md"],
    "resume.md": PROTOTYPE_CONTENTS["resume.md"],
  });

  const result = await removePrototypeBareCommandResidue({ cwd });

  assert.deepEqual(result.results.map((r) => r.name).sort(), ["resume", "usage"]);
  assert.equal(result.results.every((r) => r.removed === true), true);
  assert.equal(fs.existsSync(dir), false, "emptied commands dir must be cleaned up");

  // No .claude/commands at all -> empty result, no throw.
  const bare = tempProject();
  const empty = await removePrototypeBareCommandResidue({ cwd: bare });
  assert.deepEqual(empty.results, []);

  // A dir that still holds a user file is kept, and the user file untouched.
  const mixed = tempProject();
  const mixedDir = seedCommands(mixed, {
    "usage.md": PROTOTYPE_CONTENTS["usage.md"],
    "deploy.md": "user's own command\n",
  });
  const mixedResult = await removePrototypeBareCommandResidue({ cwd: mixed });
  assert.deepEqual(mixedResult.results.map((r) => r.name), ["usage"]);
  assert.equal(fs.existsSync(path.join(mixedDir, "deploy.md")), true);
});

test("countProjectSlashCommands ignores bare-name files entirely (residue has its own accounting)", async () => {
  const cwd = tempProject();
  seedCommands(cwd, {
    // Genuine prototype residue and a user bare-name file: NEITHER counts — this
    // count drives enable's "kept N project-local ccg command(s)" message and the
    // doctor ccg* leftover check, and bare files are not ccg* commands.
    "usage.md": PROTOTYPE_CONTENTS["usage.md"],
    "resume.md": PROTOTYPE_CONTENTS["resume.md"],
    "status.md": "my own status command\n",
    // An old per-project ccg command file DOES count.
    "ccgusage.md": "old managed copy\n",
  });

  const count = await countProjectSlashCommands({ cwd });
  assert.equal(count, 1, "only the ccg*-named leftover counts");
});

test("listPrototypeBareCommandResidue returns the matched files, empty when none", async () => {
  const withResidue = tempProject();
  seedCommands(withResidue, {
    "usage.md": PROTOTYPE_CONTENTS["usage.md"],
    "config.md": PROTOTYPE_CONTENTS["config.md"],
    "deploy.md": "not a prototype file\n", // unrelated bare name, ignored
    "status.md": "my own status\n", // same name, different content, ignored
  });

  const residue = await listPrototypeBareCommandResidue({ cwd: withResidue });
  assert.deepEqual(
    residue.map((r) => r.name).sort(),
    ["config.md", "usage.md"],
    "only fingerprint-matched files are listed"
  );
  for (const entry of residue) {
    assert.ok(entry.commandPath.endsWith(entry.name), "commandPath points at the file");
  }

  const clean = tempProject();
  seedCommands(clean, { "status.md": "my own status\n" });
  assert.deepEqual(await listPrototypeBareCommandResidue({ cwd: clean }), [], "none -> empty list");

  // No .claude/commands at all -> empty, no throw.
  const bare = tempProject();
  assert.deepEqual(await listPrototypeBareCommandResidue({ cwd: bare }), []);
});

test("ccg doctor warns about prototype residue and goes quiet once it is gone", () => {
  const home = tempProject("ccg-proto-home-");
  const cwd = tempProject("ccg-proto-doctor-");
  seedCommands(cwd, {
    "usage.md": PROTOTYPE_CONTENTS["usage.md"],
    "status.md": "my own status command\n", // user file: must NOT be flagged
  });

  const before = runCli({ home, cwd, args: ["doctor"] });
  assert.match(before.stdout, /prototype command residue/);
  assert.match(before.stdout, /usage\.md/);
  assert.match(before.stdout, /run ccg enable here to remove them/);
  assert.doesNotMatch(before.stdout, /status\.md/, "a user's bare-name file must not be flagged");

  fs.rmSync(path.join(commandsDirOf(cwd), "usage.md"));
  const after = runCli({ home, cwd, args: ["doctor"] });
  assert.match(after.stdout, /no prototype bare-name command files/);
});

test("ccg enable removes prototype residue even when the global command set is not installed", () => {
  // The original incident layout: bare prototype files, and the user has never
  // run the new `ccg install` (no ~/.claude/commands). BUG-QA-15 keeps OLD ccg*
  // copies in that state — but prototype residue shadows built-in commands and
  // must be removed unconditionally, or doctor's advice loops forever.
  const home = tempProject("ccg-proto-home-");
  const cwd = tempProject("ccg-proto-enable-");
  const dir = seedCommands(cwd, {
    ...PROTOTYPE_CONTENTS,
    // An old managed ccg* copy: BUG-QA-15 says enable must KEEP it (it may be
    // the user's only /ccg* command until ccg install runs).
    "ccgstatus.md": "---\n# managed by claude-cache-guard — regenerated by ccg enable\ndescription: old\ndisable-model-invocation: true\n---\nold body\n",
  });

  const result = runCli({ home, cwd, args: ["enable"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /removed 11 prototype bare-name command file\(s\)/);
  assert.match(result.stdout, /kept 1 project-local ccg command\(s\)/, "BUG-QA-15 keep-path must still hold, counting only ccg* files");

  for (const name of PROTOTYPE_NAMES) {
    assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} must be gone after enable`);
  }
  assert.equal(fs.existsSync(path.join(dir, "ccgstatus.md")), true, "old ccg* copy must survive until ccg install");
});
