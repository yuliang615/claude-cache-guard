import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { defaultPaths, expandHome } from "./paths.js";
import { ensureDir, readJsonIfExists } from "./json-file.js";
import { evaluateUsageThreshold } from "./threshold.js";

const HANDOFF_FILE_NAME = "next_session.md";
const MAX_PROJECT_ID_NAME_BYTES = 120;

// Present in the starter template; hook won't treat an untouched template as complete.
export const STARTER_HANDOFF_MARKER = "Initialized by claude-cache-guard.";

// Unicode-friendly slug: keeps letters/marks/digits, replaces everything else with "-".
// NFC-normalized so precomposed vs decomposed chars map to the same id.
export function sanitizeProjectName(projectName) {
  const normalized = String(projectName ?? "").normalize("NFC");
  const sanitized = normalized.replace(/[^\p{L}\p{M}\p{N}._-]/gu, "-");
  const safeName = sanitized.length > 0 ? sanitized : "project";
  return truncateToByteLength(safeName, MAX_PROJECT_ID_NAME_BYTES);
}

// Truncate by UTF-8 bytes so multi-byte chars aren't split mid-character.
function truncateToByteLength(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let usedBytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (usedBytes + charBytes > maxBytes) break;
    result += char;
    usedBytes += charBytes;
  }
  return result.length > 0 ? result : "project";
}

export function shortPathHash(absolutePath) {
  return createHash("sha256").update(absolutePath).digest("hex").slice(0, 8);
}

export function getProjectInfo(cwd = process.cwd()) {
  const absoluteCwd = resolveProjectPath(cwd);
  const projectName = path.basename(absoluteCwd) || "project";
  // NFC-normalize to get a stable hash across macOS/Linux normalization differences
  const projectId = `${sanitizeProjectName(projectName)}--${shortPathHash(absoluteCwd.normalize("NFC"))}`;
  return {
    name: projectName,
    id: projectId,
    cwd: absoluteCwd
  };
}

export function resolveProjectPath(cwd) {
  const absoluteCwd = path.resolve(cwd);
  try {
    return fs.realpathSync(absoluteCwd);
  } catch {
    return absoluteCwd;
  }
}

export function getHandoffPaths({
  homeDir,
  cwd = process.cwd(),
  storageDir = "~/.claude/next-session",
  fileName = HANDOFF_FILE_NAME
} = {}) {
  const paths = defaultPaths(homeDir);
  const project = getProjectInfo(cwd);
  const resolvedStorageDir = expandHomeWithHomeDir(storageDir, paths.homeDir);
  const handoffDir = path.join(resolvedStorageDir, project.id);
  return {
    ...paths,
    project,
    handoffDir,
    handoffPath: path.join(handoffDir, safeHandoffFileName(fileName))
  };
}

// Contain fileName to a single path segment: the handoff file must live directly
// in <storageDir>/<projectId>/. Callers should already pass a validated name, but
// guarding at the join is the last line of defense that keeps a traversal value
// (e.g. "../../../.ssh/id_rsa") from escaping the storage dir for any caller.
function safeHandoffFileName(fileName) {
  if (typeof fileName !== "string" || fileName.length === 0) return HANDOFF_FILE_NAME;
  if (fileName.includes("/") || fileName.includes("\\")) return HANDOFF_FILE_NAME;
  const base = path.basename(fileName);
  if (base === "" || base === "." || base === "..") return HANDOFF_FILE_NAME;
  return base;
}

export function createHandoffTemplate(project, now = new Date()) {
  const timestamp = now.toISOString();
  return `# Next Session Handoff

## Snapshot
- Updated At: ${timestamp}
- Project: ${project.name} (${project.id})
- Working Directory: ${project.cwd}
- Current Goal:
- Current Status: ${STARTER_HANDOFF_MARKER} Replace this starter template with a complete handoff when work needs to continue in a future session.

## Original User Prompts
<!-- Every distinct user instruction, VERBATIM and in order (slash commands and arguments exactly as typed). Do not summarize or paraphrase: compaction changes the meaning, so this is the un-compacted source of truth. -->

## What Changed

## Current State

## Decisions And Rationale

## Files And Artifacts

## Commands And Verification

## Open Questions

## Risks And Caveats

## Do Not Repeat

## Next Steps
1.
2.
3.

## Resume Prompt

You are continuing work on this project. Read this handoff file first, verify the current repository state before editing, continue from "Next Steps", respect the safety constraints, and avoid redoing completed work unless verification shows it is necessary.
`;
}

export async function initHandoff({
  force = false,
  homeDir,
  cwd = process.cwd(),
  now = new Date(),
  storageDir,
  fileName
} = {}) {
  const handoff = getHandoffPaths({ homeDir, cwd, storageDir, fileName });
  await ensureDir(handoff.handoffDir);
  const template = createHandoffTemplate(handoff.project, now);
  const existedBefore = await fileExists(handoff.handoffPath);

  if (force) {
    // Back up first: copyFile follows a source symlink, which is acceptable — the
    // backup captures whatever was reachable through the handoff path.
    const backupPath = existedBefore ? await backupHandoffFile(handoff.handoffPath, now) : null;
    // An in-place "w" open would follow a symlink and truncate its TARGET (an
    // arbitrary victim file). Remove the link itself first, then write via
    // temp-file-then-rename so a fresh regular file replaces the link.
    const linkStat = await lstatIfExists(handoff.handoffPath);
    const replacedSymlink = Boolean(linkStat && linkStat.isSymbolicLink());
    if (replacedSymlink) await fs.promises.rm(handoff.handoffPath, { force: true });
    await writeHandoffAtomic(handoff.handoffDir, handoff.handoffPath, template);
    return { ...handoff, created: true, overwritten: existedBefore, backupPath, replacedSymlink };
  }

  // A DANGLING symlink at the handoff path is a special non-force case: "wx" would
  // hit EEXIST on the link (so enable reports "already exists" and status reports
  // "exists: no") even though the link points nowhere and nothing is actually
  // there — wedging enable/status/resume with no way forward. Detect it — lstat
  // sees the link but the target is unreachable — and remove the dead link so a
  // fresh regular file can be created. A symlink whose TARGET exists is left alone,
  // keeping the current behavior (EEXIST -> created:false; nothing written).
  const existingLink = await lstatIfExists(handoff.handoffPath);
  if (existingLink && existingLink.isSymbolicLink() && !(await fileExists(handoff.handoffPath))) {
    await fs.promises.rm(handoff.handoffPath, { force: true });
  }

  try {
    // "wx" is O_CREAT|O_EXCL: it refuses (EEXIST) rather than following a symlink,
    // so the non-force path can never write through a link to a victim file.
    const handle = await fs.promises.open(handoff.handoffPath, "wx", 0o600);
    try {
      await handle.writeFile(template, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { ...handoff, created: true, overwritten: false, backupPath: null };
  } catch (error) {
    if (error?.code === "EEXIST") {
      return { ...handoff, created: false, overwritten: false };
    }
    throw error;
  }
}

// Write via temp-file-then-rename in the handoff dir, mode 0o600, fsync'd —
// rename replaces a destination symlink instead of following it.
async function writeHandoffAtomic(dir, targetPath, content) {
  const tempPath = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.promises.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tempPath, targetPath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function lstatIfExists(targetPath) {
  try {
    return await fs.promises.lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function backupHandoffFile(handoffPath, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backupPath = `${handoffPath}.before-force.${stamp}.bak`;
  await fs.promises.copyFile(handoffPath, backupPath, fs.constants.COPYFILE_EXCL);
  await fs.promises.chmod(backupPath, 0o600);
  return backupPath;
}

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function getHandoffStatus({ homeDir, cwd = process.cwd(), storageDir, fileName, handoffPath } = {}) {
  const handoff = handoffPath
    ? { ...getHandoffPaths({ homeDir, cwd, storageDir, fileName }), handoffPath }
    : getHandoffPaths({ homeDir, cwd, storageDir, fileName });
  const fileStatus = await getFileStatus(handoff.handoffPath);
  const usage = await getUsageSummary(handoff.statePath);
  return {
    project: handoff.project,
    handoffPath: handoff.handoffPath,
    exists: fileStatus.exists,
    mtime: fileStatus.mtime,
    size: fileStatus.size,
    lines: fileStatus.lines,
    usage
  };
}

export function formatHandoffStatus(status) {
  const lines = [
    `project name: ${status.project.name}`,
    `project id: ${status.project.id}`,
    `handoff path: ${status.handoffPath}`,
    `exists: ${status.exists ? "yes" : "no"}`,
    `mtime: ${status.mtime ?? "n/a"}`,
    `size: ${status.size}`,
    `lines: ${status.lines}`
  ];

  if (status.usage.available) {
    lines.push(`5h usage: ${status.usage.five_hour.used_percentage}%`);
    lines.push(`threshold status: ${status.usage.threshold.status}`);
  } else {
    lines.push("5h usage: n/a");
    lines.push("threshold status: unavailable");
  }

  return lines.join("\n");
}

export const HANDOFF_GUIDANCE_FILENAME = ".claude/ccg-handoff.md";

// The starter written by `ccg enable`. It is comment-only, so readHandoffGuidance
// strips it to "" and the handoff prompt stays unchanged until the user adds real
// lines outside the comment block. Kept as a pristine .bak copy too, so a user who
// mangles the file can restore it.
export const HANDOFF_GUIDANCE_STARTER = `<!--
  CCG 交接提醒檔：把這個專案交接時要注意的事寫在這裡，一行一條。
  內容會附加在 CCG 標準交接指示之後；這個註解區塊本身會被忽略。
  Claude：使用者要求新增或修改交接提醒時，直接幫他們編輯這個檔案——
  把提醒加在這個註解區塊下方，一行一條，不要動註解本身。
  Write project-specific handoff reminders here, one per line.
  They are appended after CCG's standard handoff instructions; this comment block is ignored.
  Claude: when the user asks to add or change a handoff reminder, edit this file
  for them — add reminders below this comment block, one per line, and leave the
  comment block itself alone.
-->
`;

// Optional project-local guidance for the handoff writer, read from
// <cwd>/.claude/ccg-handoff.md. HTML comment blocks (the starter's instructions)
// are stripped before deciding whether guidance is active, so a comment-only file
// is treated as no guidance. Only the text outside comments is appended to (never
// replaces) the standard prompt, so the output contract and safety rules always
// hold. Returns "" when the file is absent, comment-only, empty, or unreadable —
// a customization must never break the handoff.
export function readHandoffGuidance(cwd = process.cwd()) {
  try {
    const raw = fs.readFileSync(path.join(cwd, ".claude", "ccg-handoff.md"), "utf8");
    const stripped = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!stripped) return "";
    const MAX = 8000;
    return stripped.length > MAX
      ? `${stripped.slice(0, MAX)}\n\n[truncated by claude-cache-guard: guidance over ${MAX} characters]`
      : stripped;
  } catch {
    return "";
  }
}

// Create the project-local handoff guidance starter under <cwd>/.claude/, plus a
// pristine .bak copy, each ONLY when missing. Both are user-editable content: the
// .bak lets a user restore the file if they break it. Writes are atomic
// (temp+rename, mode 0o600) and never follow a symlink at the destination (lstat
// discipline). An existing file (or symlink, or .bak) is left byte-for-byte alone.
export async function ensureHandoffGuidanceStarter({ cwd = process.cwd() } = {}) {
  const claudeDir = path.join(path.resolve(cwd), ".claude");
  await ensureDir(claudeDir);
  const guidancePath = path.join(claudeDir, "ccg-handoff.md");
  const backupPath = `${guidancePath}.bak`;
  const createdGuidance = await createFileIfMissing(claudeDir, guidancePath, HANDOFF_GUIDANCE_STARTER);
  const createdBackup = await createFileIfMissing(claudeDir, backupPath, HANDOFF_GUIDANCE_STARTER);
  return { guidancePath, backupPath, createdGuidance, createdBackup };
}

// Write content to targetPath only if nothing is there. lstat (never access/stat,
// which follow a link) so an existing symlink counts as "present" and is left
// alone rather than written through to its target.
async function createFileIfMissing(dir, targetPath, content) {
  const stat = await lstatIfExists(targetPath);
  if (stat) return false;
  await writeHandoffAtomic(dir, targetPath, content);
  return true;
}

export function createHandoffPrompt({ handoffPath, project = getProjectInfo(), customGuidance = "" } = {}) {
  // Neutralize the wrapper's own delimiter inside the guidance so its content
  // cannot close the block early and smuggle text out from under the
  // "guidance is subordinate" framing. The source is maintainer-authored, but
  // the stated guarantee should actually hold.
  const safeGuidance = String(customGuidance).trim().replace(
    /<\s*(\/?)\s*project_specific_guidance\s*>/gi,
    "[$1project_specific_guidance]"
  );
  const guidanceBlock = safeGuidance
    ? `\n\n<project_specific_guidance>\nThe project maintainer added the guidance below (from ${HANDOFF_GUIDANCE_FILENAME}). Apply it only where it does not conflict with the output contract, the strict safety rules, or the Original User Prompts rules above — those always win. It is extra context and emphasis, not permission to change the required structure or skip any safety rule.\n\n${safeGuidance}\n</project_specific_guidance>`
    : "";
  return `<role>
You are a senior Claude Code handoff writer. Your job is to create a compact but complete continuity document so the next Claude Code session can resume this exact work without needing the current conversation.
</role>

<handoff_target>
Write the handoff Markdown file at this exact path:
${handoffPath}
</handoff_target>

<project>
- Name: ${project.name}
- ID: ${project.id}
- Working Directory: ${project.cwd}
</project>

<objective>
Create or update next_session.md so a fresh Claude Code session can continue from the current state with minimal rediscovery. The file should preserve decisions, working context, verification status, and the next concrete actions. It should not be a transcript.
</objective>

<process>
1. Read the existing handoff file if it exists.
2. Inspect only the minimum local context needed to make the handoff accurate:
   - files already touched or discussed in this session,
   - project config files directly relevant to the current task,
   - test or command output already available in this session,
   - git status only if it is needed to identify changed files.
3. Use the old handoff only as source material. Keep still-accurate facts, remove stale details, and mark uncertain items as unknown.
4. Rewrite the entire handoff file from scratch using the output contract below, preserving the user's original prompts verbatim per the "Original User Prompts" rules. Do not append to the existing file. Do not patch individual sections in place.
5. Write the complete replacement Markdown to the handoff target path, overwriting the previous file content.
6. After writing, reply briefly with the path updated and any important caveats.
</process>

<strict_safety_rules>
- Do not read .env files.
- Do not run broad secret scans.
- Do not print, copy, summarize, or store token values, OAuth values, API keys, cookies, session values, authorization headers, private keys, passwords, or actual .env values.
- It is OK to write: ".env exists but values were not copied".
- Do not call external services.
- Do not push to git, publish packages, deploy, or modify remote systems.
- Do not use destructive git commands or delete user work.
</strict_safety_rules>

<output_contract>
The handoff file must be Markdown with this exact top-level structure:

# Next Session Handoff

## Snapshot
- Updated At:
- Project:
- Working Directory:
- Current Goal:
- Current Status:

## Original User Prompts

## What Changed

## Current State

## Decisions And Rationale

## Files And Artifacts

## Commands And Verification

## Open Questions

## Risks And Caveats

## Do Not Repeat

## Next Steps
1.
2.
3.

## Resume Prompt

Write the Resume Prompt as a ready-to-paste instruction for the next Claude Code session. It must tell the next session to:
- read this handoff file first,
- verify the current repository state before editing,
- continue from the listed Next Steps,
- respect the safety constraints above,
- avoid redoing completed work unless the verification shows it is necessary.

Filling the "Original User Prompts" section (critical):
- Reproduce every distinct user instruction VERBATIM and in chronological order, including slash commands and their exact arguments as the user typed them.
- Do not summarize, paraphrase, translate, shorten, reorder, or merge prompts. Compaction is lossy for intent and constraints, so this section is the un-compacted source of truth that every other section must stay consistent with.
- Record later corrections or changes of intent as separate ordered entries instead of overwriting earlier ones, so the evolution of the request is preserved.
- If earlier messages were already dropped from context by Claude Code auto-compaction, recover their verbatim text from the session transcript when it is available; otherwise reproduce what remains and mark it clearly as "[reconstructed from compacted context - original wording may be lost]".
- The only edit allowed to a user message is redacting a secret it contained (token, key, password, and the like) per the safety rules above; keep the rest of the message intact.
</output_contract>

<quality_bar>
- Be concrete: include exact file paths, commands run, test results, config values, and commit hashes when known.
- Separate facts from guesses. If something is uncertain, write "Unknown" or "Needs verification".
- Optimize for the next session's first 5 minutes: what should it read, what should it run, what should it avoid?
- Prefer short paragraphs and dense bullets over long narrative.
- Keep it under about 220 lines unless the work is unusually complex.
- The Original User Prompts section is exempt from the length budget: never drop, truncate, or condense the user's actual prompts to save space.
- The next session should be able to start with only next_session.md and local repo inspection.
</quality_bar>${guidanceBlock}`;
}

export function createResumePrompt({ handoffPath, project = getProjectInfo() }) {
  return `Resume the unfinished work for this project from the CCG handoff.

Project:
- Name: ${project.name}
- Working Directory: ${project.cwd}
- Handoff File: ${handoffPath}

The handoff content is included below. Follow these rules:
1. Treat "Original User Prompts" as the authoritative, verbatim record of what the user asked for; if any summarized section conflicts with it, the original prompts win.
2. Verify the current project state before editing. Use the files, manifests, tests, build commands, or other project-native tools that are actually available.
3. Git is optional. Use Git only if it is installed and this project is a Git repository. Do not fail or ask the user to install Git when it is unavailable.
4. Compare the handoff with the current filesystem state. When they differ, trust the current state and preserve existing user work.
5. Continue the unfinished work from the handoff's "Next Steps". Do not merely summarize the handoff, and do not redo completed work unless verification shows it is necessary.
6. Respect the safety constraints, decisions, risks, and "Do Not Repeat" notes recorded in the handoff.
7. Work autonomously until the resumed task is complete or genuinely blocked.`;
}

export async function getFileStatus(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    const raw = await fs.promises.readFile(filePath, "utf8");
    return {
      exists: true,
      mtime: stats.mtime.toISOString(),
      size: stats.size,
      lines: raw.length === 0 ? 0 : raw.split(/\r\n|\r|\n/).length
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        exists: false,
        mtime: null,
        size: 0,
        lines: 0
      };
    }
    throw error;
  }
}

async function getUsageSummary(statePath) {
  try {
    const state = await readJsonIfExists(statePath, null);
    const threshold = evaluateUsageThreshold(state);
    if (!Number.isFinite(state?.five_hour?.used_percentage)) {
      return { available: false, threshold };
    }
    return {
      available: true,
      five_hour: {
        used_percentage: state.five_hour.used_percentage
      },
      threshold
    };
  } catch {
    const threshold = evaluateUsageThreshold(null);
    return { available: false, threshold };
  }
}

function expandHomeWithHomeDir(value, homeDir) {
  return expandHome(value, homeDir);
}
