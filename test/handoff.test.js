import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createHandoffPrompt,
  createResumePrompt,
  getHandoffPaths,
  getProjectInfo,
  getHandoffStatus,
  initHandoff,
  sanitizeProjectName
} from "../src/handoff.js";

function tempDir(prefix = "ccg-handoff-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeProject(name = "My Project!") {
  const parent = tempDir();
  const cwd = path.join(parent, name);
  fs.mkdirSync(cwd, { recursive: true });
  return fs.realpathSync(cwd);
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

test("project id uses sanitized basename plus short path hash", () => {
  const cwd = makeProject("My Project!@#");
  const project = getProjectInfo(cwd);
  assert.equal(sanitizeProjectName("My Project!@#"), "My-Project---");
  assert.match(project.id, /^My-Project-----[a-f0-9]{8}$/);
  assert.equal(project.name, "My Project!@#");
  assert.equal(project.cwd, cwd);
});

test("project id truncates very long basenames before adding hash", () => {
  const cwd = makeProject("a".repeat(250));
  const project = getProjectInfo(cwd);
  assert.equal(sanitizeProjectName("a".repeat(250)).length, 120);
  assert.equal(project.id.length, 130);
  assert.match(project.id, /^a{120}--[a-f0-9]{8}$/);
});

test("same-name projects in different paths get different ids", () => {
  const firstParent = tempDir("ccg-handoff-a-");
  const secondParent = tempDir("ccg-handoff-b-");
  const first = path.join(firstParent, "same-name");
  const second = path.join(secondParent, "same-name");
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });

  const firstProject = getProjectInfo(fs.realpathSync(first));
  const secondProject = getProjectInfo(fs.realpathSync(second));
  assert.notEqual(firstProject.id, secondProject.id);
  assert.match(firstProject.id, /^same-name--[a-f0-9]{8}$/);
  assert.match(secondProject.id, /^same-name--[a-f0-9]{8}$/);
});

// Legacy ASCII-only rule, kept here so we can prove the new Unicode-aware
// sanitizer is byte-for-byte identical for every name the old rule handled.
function legacySanitizeProjectName(name) {
  const sanitized = String(name).replace(/[^a-zA-Z0-9._-]/g, "-");
  const safe = sanitized.length > 0 ? sanitized : "project";
  return safe.slice(0, 120);
}

test("project id stays byte-for-byte identical to the legacy rule for ASCII names", () => {
  const asciiNames = [
    "My Project!@#",
    "a".repeat(250),
    "simple",
    "with.dot_and-dash",
    "--edge--",
    "foo!!!bar",
    "   spaces   ",
    "",
    "123",
    "a/b\\c",
    "UPPER_lower-123.tar.gz",
    "."
  ];
  for (const name of asciiNames) {
    assert.equal(
      sanitizeProjectName(name),
      legacySanitizeProjectName(name),
      `ASCII parity broken for ${JSON.stringify(name)}`
    );
  }
});

test("project id preserves non-ASCII scripts instead of flattening to dashes", () => {
  assert.equal(sanitizeProjectName("我的專案"), "我的專案");
  assert.equal(sanitizeProjectName("проект"), "проект");
  assert.equal(sanitizeProjectName("日本語プロジェクト"), "日本語プロジェクト");
  assert.equal(sanitizeProjectName("한국어"), "한국어");
  assert.equal(sanitizeProjectName("مشروع"), "مشروع");
  assert.equal(sanitizeProjectName("café-app"), "café-app".normalize("NFC"));
  // Mixed scripts plus safe ASCII punctuation survive together.
  assert.equal(sanitizeProjectName("我的-project_2"), "我的-project_2");
});

test("project id normalizes to NFC so decomposed and precomposed names match", () => {
  const precomposed = "caf\u00e9"; // cafe + precomposed U+00E9 (NFC)
  const decomposed = "cafe\u0301"; // cafe + combining acute accent U+0301 (NFD)
  assert.notEqual(precomposed, decomposed); // different code-point sequences going in
  assert.equal(sanitizeProjectName(precomposed), sanitizeProjectName(decomposed));
  assert.equal(sanitizeProjectName(decomposed), "caf\u00e9"); // both collapse to the NFC form
});

test("project id replaces emoji and symbols with dashes", () => {
  assert.equal(sanitizeProjectName("🎉party🎉"), "-party-");
  assert.equal(sanitizeProjectName("a🚀b"), "a-b");
  assert.equal(sanitizeProjectName("price=$5"), "price--5");
});

test("project id caps multibyte names by UTF-8 byte length without splitting a character", () => {
  const cjk = sanitizeProjectName("我".repeat(250)); // 3 bytes each
  assert.equal(Buffer.byteLength(cjk, "utf8") <= 120, true);
  assert.equal(cjk, "我".repeat(40)); // 40 * 3 bytes = 120 bytes
  assert.equal(Buffer.from(cjk, "utf8").toString("utf8"), cjk);

  // Astral-plane letter (U+20000, a 4-byte / surrogate-pair CJK ideograph).
  const astral = sanitizeProjectName("𠀀".repeat(31)); // 31 * 4 = 124 bytes > 120
  assert.equal(Buffer.byteLength(astral, "utf8") <= 120, true);
  assert.equal([...astral].length, 30); // 30 * 4 bytes = 120 bytes, 31st dropped whole
  // A clean UTF-8 round-trip proves no surrogate pair was split mid-character.
  assert.equal(Buffer.from(astral, "utf8").toString("utf8"), astral);
});

test("getProjectInfo builds a readable id for a non-ASCII directory and handoff initializes under it", async () => {
  const home = tempDir();
  const cwd = makeProject("我的專案");
  const expectedName = path.basename(cwd).normalize("NFC");
  const project = getProjectInfo(cwd);
  assert.ok(project.id.startsWith(`${expectedName}--`), `readable id expected, got ${project.id}`);
  assert.match(project.id, /--[a-f0-9]{8}$/);
  assert.match(project.id, /[一-鿿]/); // CJK actually survived into the id

  const result = await initHandoff({ homeDir: home, cwd });
  assert.equal(result.created, true);
  assert.equal(fs.existsSync(result.handoffPath), true);
  assert.ok(result.handoffPath.includes(expectedName));
});

test("getProjectInfo yields one stable id for the same directory in NFC and NFD forms", () => {
  const parent = tempDir();
  const precomposed = "caf\u00e9"; // cafe + precomposed U+00E9 (NFC)
  const decomposed = "cafe\u0301"; // cafe + combining acute accent U+0301 (NFD)
  assert.notEqual(precomposed, decomposed);
  fs.mkdirSync(path.join(parent, precomposed), { recursive: true });

  const fromPrecomposed = getProjectInfo(path.join(parent, precomposed));
  const fromDecomposed = getProjectInfo(path.join(parent, decomposed));
  // Same physical directory, two normalization forms -> exactly one project id,
  // so the handoff directory and moved-project detection stay consistent.
  assert.equal(fromPrecomposed.id, fromDecomposed.id);
  assert.ok(fromPrecomposed.id.startsWith("caf\u00e9--"));
  assert.match(fromPrecomposed.id, /--[a-f0-9]{8}$/);
});

test("handoff initializes under a long multibyte directory name within filename limits", async () => {
  const home = tempDir();
  const longName = "專".repeat(50); // 150 UTF-8 bytes: a legal directory name whose slug must be capped
  const cwd = makeProject(longName);
  const project = getProjectInfo(cwd);
  const slug = project.id.slice(0, project.id.lastIndexOf("--"));
  assert.equal(Buffer.byteLength(slug, "utf8") <= 120, true);

  const result = await initHandoff({ homeDir: home, cwd });
  const dirEntry = path.basename(path.dirname(result.handoffPath));
  assert.equal(Buffer.byteLength(dirEntry, "utf8") <= 255, true);
  assert.equal(fs.existsSync(result.handoffPath), true);
});

test("internal handoff init creates next_session.md under temp HOME", async () => {
  const home = tempDir();
  const cwd = makeProject("phase-three");
  const expected = getHandoffPaths({ homeDir: home, cwd });

  const result = await initHandoff({ homeDir: home, cwd });
  assert.equal(result.handoffPath, expected.handoffPath);
  assert.equal(result.created, true);
  assert.equal(fs.existsSync(expected.handoffPath), true);

  const body = read(expected.handoffPath);
  assert.match(body, /# Next Session Handoff/);
  assert.match(body, /## Snapshot/);
  assert.match(body, new RegExp(`- Project: ${escapeRegExp(expected.project.name)} \\(${escapeRegExp(expected.project.id)}\\)`));
  assert.match(body, new RegExp(`- Working Directory: ${escapeRegExp(cwd)}`));
  assert.match(body, /- Updated At:/);
  assert.match(body, /## Original User Prompts/);
  assert.match(body, /## What Changed/);
  assert.match(body, /## Decisions And Rationale/);
  assert.match(body, /## Commands And Verification/);
  assert.match(body, /## Resume Prompt/);
});

test("internal handoff init does not overwrite existing file without force", async () => {
  const home = tempDir();
  const cwd = makeProject("no-overwrite");
  const expected = getHandoffPaths({ homeDir: home, cwd });

  const first = await initHandoff({ homeDir: home, cwd });
  assert.equal(first.created, true);
  fs.writeFileSync(expected.handoffPath, "custom handoff\n");

  const second = await initHandoff({ homeDir: home, cwd });
  assert.equal(second.created, false);
  assert.equal(read(expected.handoffPath), "custom handoff\n");
});

test("internal handoff init force overwrites existing file", async () => {
  const home = tempDir();
  const cwd = makeProject("force-overwrite");
  const expected = getHandoffPaths({ homeDir: home, cwd });

  const first = await initHandoff({ homeDir: home, cwd });
  assert.equal(first.created, true);
  fs.writeFileSync(expected.handoffPath, "custom handoff\n");

  const second = await initHandoff({ homeDir: home, cwd, force: true });
  assert.equal(second.created, true);
  assert.equal(second.overwritten, true);
  assert.notEqual(read(expected.handoffPath), "custom handoff\n");
  assert.match(read(expected.handoffPath), /# Next Session Handoff/);
});

// FIX 3: force init must not write THROUGH a symlink to a victim file. It
// replaces the link with a regular file and backs up what was reachable.
test("force init replaces a symlinked handoff with a regular file and never writes through to the victim", async () => {
  const home = tempDir();
  const cwd = makeProject("force-symlink");
  const expected = getHandoffPaths({ homeDir: home, cwd });

  // Materialize the handoff dir, then plant a symlink at the handoff path that
  // points at a victim file elsewhere.
  const first = await initHandoff({ homeDir: home, cwd });
  assert.equal(first.created, true);
  const victim = path.join(cwd, "victim.txt");
  const victimBody = "precious victim content\n";
  fs.writeFileSync(victim, victimBody);
  fs.rmSync(expected.handoffPath);
  fs.symlinkSync(victim, expected.handoffPath);

  const result = await initHandoff({ homeDir: home, cwd, force: true });
  assert.equal(result.created, true);
  assert.equal(result.replacedSymlink, true);

  // Victim byte-for-byte intact — the write did NOT follow the link.
  assert.equal(read(victim), victimBody);
  // handoffPath is now a REGULAR file carrying the fresh template.
  const st = fs.lstatSync(expected.handoffPath);
  assert.equal(st.isSymbolicLink(), false);
  assert.equal(st.isFile(), true);
  assert.match(read(expected.handoffPath), /# Next Session Handoff/);
  // The .before-force backup captured what was reachable through the link.
  assert.ok(result.backupPath && fs.existsSync(result.backupPath));
  assert.equal(read(result.backupPath), victimBody);
});

// FIX 3: the non-force path (O_EXCL) must refuse an existing symlink and leave
// the victim untouched.
test("non-force init refuses a symlinked handoff and leaves the victim intact", async () => {
  const home = tempDir();
  const cwd = makeProject("nonforce-symlink");
  const expected = getHandoffPaths({ homeDir: home, cwd });

  const first = await initHandoff({ homeDir: home, cwd });
  assert.equal(first.created, true);
  const victim = path.join(cwd, "victim.txt");
  const victimBody = "precious victim content\n";
  fs.writeFileSync(victim, victimBody);
  fs.rmSync(expected.handoffPath);
  fs.symlinkSync(victim, expected.handoffPath);

  const result = await initHandoff({ homeDir: home, cwd });
  assert.equal(result.created, false);
  // Both the link and its victim are untouched.
  assert.equal(fs.lstatSync(expected.handoffPath).isSymbolicLink(), true);
  assert.equal(read(victim), victimBody);
});

// FIX 3: a DANGLING symlink at the handoff path (its target does not exist)
// wedged non-force enable — "wx" hit EEXIST on the link while status reported
// "exists: no". The dead link points nowhere, so init removes it and writes a
// fresh REGULAR file, returning created:true.
test("non-force init replaces a dangling symlinked handoff with a fresh regular file", async () => {
  const home = tempDir();
  const cwd = makeProject("dangling-handoff");
  const expected = getHandoffPaths({ homeDir: home, cwd });

  // Ensure the handoff dir exists, then plant a symlink at the handoff path that
  // points at a target that does not exist (dangling).
  fs.mkdirSync(path.dirname(expected.handoffPath), { recursive: true });
  const missingTarget = path.join(cwd, "does-not-exist.md");
  fs.symlinkSync(missingTarget, expected.handoffPath);
  assert.equal(fs.lstatSync(expected.handoffPath).isSymbolicLink(), true);
  assert.equal(fs.existsSync(expected.handoffPath), false, "target must be missing (dangling)");

  const result = await initHandoff({ homeDir: home, cwd });
  assert.equal(result.created, true);
  // The dead link is replaced by a REGULAR file carrying the fresh template.
  const st = fs.lstatSync(expected.handoffPath);
  assert.equal(st.isSymbolicLink(), false);
  assert.equal(st.isFile(), true);
  assert.match(read(expected.handoffPath), /# Next Session Handoff/);
  // The originally-missing target must NOT have been created behind the link.
  assert.equal(fs.existsSync(missingTarget), false, "the dead link's target must stay absent");
});

// FIX 3: the contrast case — a symlink whose TARGET exists keeps the current
// behavior: created:false and the target is left byte-for-byte untouched.
test("non-force init leaves a symlink with an existing target untouched (created:false)", async () => {
  const home = tempDir();
  const cwd = makeProject("live-target-handoff");
  const expected = getHandoffPaths({ homeDir: home, cwd });

  fs.mkdirSync(path.dirname(expected.handoffPath), { recursive: true });
  const target = path.join(cwd, "target.md");
  const targetBody = "existing target content\n";
  fs.writeFileSync(target, targetBody);
  fs.symlinkSync(target, expected.handoffPath);

  const result = await initHandoff({ homeDir: home, cwd });
  assert.equal(result.created, false);
  // The link and its live target are both untouched.
  assert.equal(fs.lstatSync(expected.handoffPath).isSymbolicLink(), true);
  assert.equal(read(target), targetBody);
});

test("internal handoff path resolves the expected path", () => {
  const home = tempDir();
  const cwd = makeProject("path-only");
  const expected = getHandoffPaths({ homeDir: home, cwd });

  assert.equal(expected.handoffPath.endsWith("/next_session.md"), true);
  assert.match(expected.handoffPath, new RegExp(`${escapeRegExp(expected.project.id)}/next_session\\.md$`));
});

test("internal handoff status works when file does not exist", async () => {
  const home = tempDir();
  const cwd = makeProject("status-missing");
  const expected = getHandoffPaths({ homeDir: home, cwd });

  const result = await getHandoffStatus({ homeDir: home, cwd });
  assert.equal(result.project.id, expected.project.id);
  assert.equal(result.handoffPath, expected.handoffPath);
  assert.equal(result.exists, false);
  assert.equal(result.usage.available, false);
});

test("internal handoff status works when file and usage state exist", async () => {
  const home = tempDir();
  const cwd = makeProject("status-existing");
  const expected = getHandoffPaths({ homeDir: home, cwd });

  await initHandoff({ homeDir: home, cwd });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "usage-state.json"),
    JSON.stringify({
      source: "claude-code-statusLine",
      updated_at: "2026-06-13T12:00:00.000Z",
      model: { id: "claude-opus-4-6", display_name: "Opus 4.6" },
      context_window: { used_percentage: 30 },
      five_hour: { used_percentage: 91, resets_at: "2999-06-13T17:00:00Z" },
      seven_day: { used_percentage: 22, resets_at: "2026-06-18T09:00:00Z" }
    })
  );

  const result = await getHandoffStatus({ homeDir: home, cwd });
  assert.equal(result.handoffPath, expected.handoffPath);
  assert.equal(result.exists, true);
  assert.equal(result.usage.available, true);
  assert.equal(result.usage.five_hour.used_percentage, 91);
  assert.equal(result.usage.threshold.status, "warning");
});

test("internal handoff prompt includes path, sections, and secret rules", () => {
  const home = tempDir();
  const cwd = makeProject("prompt-project");
  const expected = getHandoffPaths({ homeDir: home, cwd });

  const prompt = createHandoffPrompt({
    handoffPath: expected.handoffPath,
    project: expected.project
  });
  assert.match(prompt, new RegExp(escapeRegExp(expected.handoffPath)));
  for (const tag of [
    "role",
    "handoff_target",
    "project",
    "objective",
    "process",
    "strict_safety_rules",
    "output_contract",
    "quality_bar"
  ]) {
    assert.match(prompt, new RegExp(`<${tag}>`));
    assert.match(prompt, new RegExp(`</${tag}>`));
  }
  for (const section of [
    "Snapshot",
    "Original User Prompts",
    "What Changed",
    "Current State",
    "Decisions And Rationale",
    "Files And Artifacts",
    "Commands And Verification",
    "Open Questions",
    "Risks And Caveats",
    "Do Not Repeat",
    "Next Steps",
    "Resume Prompt"
  ]) {
    assert.match(prompt, new RegExp(escapeRegExp(section)));
  }
  assert.match(prompt, /fresh Claude Code session can continue/);
  assert.match(prompt, /Write the handoff Markdown file/);
  assert.match(prompt, /Read the existing handoff file if it exists/);
  assert.match(prompt, /Rewrite the entire handoff file from scratch/);
  assert.match(prompt, /Do not append to the existing file/);
  assert.match(prompt, /Do not patch individual sections in place/);
  assert.match(prompt, /overwriting the previous file content/);
  assert.match(prompt, /Do not run broad secret scans/);
  assert.match(prompt, /Do not read \.env files/);
  assert.match(prompt, /Do not call external services/);
  assert.match(prompt, /verify the current repository state before editing/);
  assert.match(prompt, /avoid redoing completed work/);
  assert.match(prompt, /token values/);
  assert.match(prompt, /OAuth values/);
  assert.match(prompt, /API keys/);
  assert.match(prompt, /cookies/);
  assert.match(prompt, /authorization headers/);
  assert.match(prompt, /private keys/);
  assert.match(prompt, /passwords/);
  assert.match(prompt, /\.env exists but values were not copied/);
  // The verbatim original-prompts contract must be spelled out, not just listed.
  assert.match(prompt, /Reproduce every distinct user instruction VERBATIM/);
  assert.match(prompt, /Do not summarize, paraphrase, translate, shorten, reorder, or merge/);
  assert.match(prompt, /reconstructed from compacted context/);
  assert.match(prompt, /preserving the user's original prompts verbatim/);
  assert.match(prompt, /Original User Prompts section is exempt from the length budget/);
});

test("resume prompt continues from handoff without requiring Git", () => {
  const home = tempDir();
  const cwd = makeProject("resume-project");
  const expected = getHandoffPaths({ homeDir: home, cwd });

  const prompt = createResumePrompt({
    handoffPath: expected.handoffPath,
    project: expected.project
  });
  assert.match(prompt, new RegExp(escapeRegExp(expected.handoffPath)));
  assert.match(prompt, new RegExp(escapeRegExp(expected.project.cwd)));
  assert.match(prompt, /The handoff content is included below/);
  assert.match(prompt, /Original User Prompts.*authoritative/s);
  assert.match(prompt, /the original prompts win/);
  assert.match(prompt, /Git is optional/);
  assert.match(prompt, /Do not fail or ask the user to install Git/);
  assert.match(prompt, /project-native tools/);
  assert.match(prompt, /Continue the unfinished work/);
  assert.match(prompt, /Do not merely summarize/);
  assert.match(prompt, /Work autonomously/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
