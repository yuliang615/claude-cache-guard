import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { defaultPaths } from "./paths.js";
import { ensureDir, readJsonIfExists, writeJsonAtomic } from "./json-file.js";
import { readStdin } from "./statusline.js";
import { createHandoffPrompt, readHandoffGuidance, STARTER_HANDOFF_MARKER } from "./handoff.js";
import { getProjectState, handoffModeFromConfig, thresholdOptionsFromConfig } from "./config.js";
import { evaluateUsageThreshold } from "./threshold.js";

// Per-project hook state keyed by window id (from resets_at, not wall-clock).
export const HOOK_STATE_VERSION = 4;

// Max age before usage data is considered stale (overridable via config).
const DEFAULT_USAGE_FRESH_MAX_MS = 15 * 60 * 1000;

export async function runUsageHandoffHook({ stdin = process.stdin, stdout = process.stdout } = {}) {
  try {
    const raw = await readStdin(stdin);
    const input = raw.trim() ? JSON.parse(raw) : {};
    const output = await evaluateUsageHandoffHook({ input });
    if (output) stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    // fail open — never block Stop
    await recordHookError(error);
  }
}

export async function evaluateUsageHandoffHook({ input = {}, homeDir, cwd, now = Date.now() } = {}) {
  const hookEventName = typeof input.hook_event_name === "string" ? input.hook_event_name : "Stop";
  if (isSubagentHook(input)) return null;

  const projectCwd = cwd ?? (typeof input.cwd === "string" ? input.cwd : process.cwd());
  const projectState = await getProjectState({ homeDir, cwd: projectCwd });
  if (!projectState.enabled) return null;

  const paths = defaultPaths(homeDir);
  const usageState = await readJsonIfExists(paths.statePath, null).catch(() => null);
  const thresholds = thresholdOptionsFromConfig(projectState.effectiveConfig);
  const mode = handoffModeFromConfig(projectState.effectiveConfig);
  const threshold = evaluateUsageThreshold(usageState, { ...thresholds, now });
  const hookStatePath = getUsageHandoffHookStatePath({
    homeDir: paths.homeDir,
    projectId: projectState.project.id
  });
  const previous = await readJsonIfExists(hookStatePath, null).catch(() => null);

  if (threshold.status === "unavailable") return null;

  // expired window — treat as reset
  if (threshold.status === "stale") {
    await resetIfActive({ previous, hookStatePath, projectState, threshold, thresholds });
    return null;
  }

  // stale usage data — wait for statusLine to refresh
  if (!isUsageFresh(usageState, freshnessMaxMs(projectState.effectiveConfig), now)) {
    return null;
  }

  // below threshold — clear active episode if any
  if (threshold.status === "ok") {
    await resetIfActive({ previous, hookStatePath, projectState, threshold, thresholds });
    return null;
  }

  // warning: data is fresh, window hasn't reset
  const windowId = usageWindowId(usageState);

  // No resets_at means no window identity. Firing here would mark the episode
  // "handled" under an empty window id that every later window also shares, so
  // the project would never warn again. Wait for usage with an identifiable
  // window instead (same posture as the stale guard).
  if (windowId === "") return null;

  const sameWindow =
    previous?.threshold_active === true && normalizeWindowId(previous.window_id) === normalizeWindowId(windowId);

  // already handled this window — don't nag
  if (sameWindow && previous.phase === "handled") {
    return null;
  }

  // pending episode still open
  if (sameWindow && previous.phase === "pending") {
    // mode switched to "ask" mid-window — settle quietly, don't force stop
    if (mode === "ask") {
      await writeHookState({
        hookStatePath,
        input,
        projectState,
        threshold,
        thresholds,
        windowId,
        mode,
        thresholdActive: true,
        phase: "handled",
        reminderCount: previous.reminder_count ?? 1,
        warnedAt: previous.warned_at ?? new Date().toISOString(),
        handledAt: new Date().toISOString(),
        handoffBaselineSignature: previous.handoff_baseline_signature ?? "",
        triggerSessionId: previous.trigger_session_id ?? getSessionId(input),
        triggerEvent: previous.trigger_event ?? hookEventName
      });
      return null;
    }
    if (await handoffCompletedThisEpisode({ projectState, previous })) {
      await writeHookState({
        hookStatePath,
        input,
        projectState,
        threshold,
        thresholds,
        windowId,
        mode,
        thresholdActive: true,
        phase: "handled",
        reminderCount: previous.reminder_count ?? 1,
        warnedAt: previous.warned_at ?? new Date().toISOString(),
        handledAt: new Date().toISOString(),
        handoffBaselineSignature: previous.handoff_baseline_signature ?? "",
        triggerSessionId: previous.trigger_session_id ?? getSessionId(input),
        triggerEvent: previous.trigger_event ?? hookEventName
      });
      return createHandoffCompletedOutput({ projectState, threshold, hookEventName });
    }

    await writeHookState({
      hookStatePath,
      input,
      projectState,
      threshold,
      thresholds,
      windowId,
      mode,
      thresholdActive: true,
      phase: "pending",
      reminderCount: (previous.reminder_count ?? 1) + 1,
      warnedAt: previous.warned_at ?? new Date().toISOString(),
      handledAt: null,
      handoffBaselineSignature: previous.handoff_baseline_signature ?? "",
      triggerSessionId: previous.trigger_session_id ?? getSessionId(input),
      triggerEvent: previous.trigger_event ?? hookEventName
    });
    return createPendingHandoffOutput({ projectState, threshold, hookEventName });
  }

  // new episode for this window
  if (mode === "ask") {
    await writeHookState({
      hookStatePath,
      input,
      projectState,
      threshold,
      thresholds,
      windowId,
      mode,
      thresholdActive: true,
      phase: "handled",
      reminderCount: 1,
      warnedAt: new Date().toISOString(),
      handledAt: new Date().toISOString(),
      handoffBaselineSignature: await readHandoffSignature(projectState.handoffPath),
      triggerSessionId: getSessionId(input),
      triggerEvent: hookEventName
    });
    return createUsageHandoffAskOutput({ projectState, threshold, thresholds, hookEventName });
  }

  // auto mode — open pending episode
  await writeHookState({
    hookStatePath,
    input,
    projectState,
    threshold,
    thresholds,
    windowId,
    mode,
    thresholdActive: true,
    phase: "pending",
    reminderCount: 1,
    warnedAt: new Date().toISOString(),
    handledAt: null,
    handoffBaselineSignature: await readHandoffSignature(projectState.handoffPath),
    triggerSessionId: getSessionId(input),
    triggerEvent: hookEventName
  });

  const reminder = createUsageHandoffReminder({ projectState, threshold, thresholds });
  return {
    systemMessage: `Claude Cache Guard: 5-hour usage is ${formatPercent(threshold.five_hour.used_percentage)} (${threshold.status}); handoff reminder sent to Claude.`,
    hookSpecificOutput: {
      hookEventName,
      additionalContext: reminder
    }
  };
}

export function getUsageHandoffHookStatePath({ homeDir = defaultPaths().homeDir, projectId }) {
  return path.join(defaultPaths(homeDir).hookStateDir, `${projectId}.json`);
}

export async function reconcileUsageHandoffAfterSettingsChange({ homeDir, cwd = process.cwd(), now = Date.now() } = {}) {
  const projectState = await getProjectState({ homeDir, cwd });
  if (!projectState.enabled) return { reset: false, status: "disabled" };

  const paths = defaultPaths(homeDir);
  const usageState = await readJsonIfExists(paths.statePath, null).catch(() => null);
  const thresholds = thresholdOptionsFromConfig(projectState.effectiveConfig);
  const threshold = evaluateUsageThreshold(usageState, { ...thresholds, now });
  const hookStatePath = getUsageHandoffHookStatePath({
    homeDir: paths.homeDir,
    projectId: projectState.project.id
  });
  const previous = await readJsonIfExists(hookStatePath, null).catch(() => null);

  if (
    previous?.threshold_active !== true ||
    (threshold.status !== "ok" && threshold.status !== "stale")
  ) {
    return {
      reset: false,
      status: threshold.status,
      wasActive: previous?.threshold_active === true,
      usedPercentage: threshold.five_hour.used_percentage,
      warningThreshold: thresholds.fiveHourThreshold
    };
  }

  await ensureDir(path.dirname(hookStatePath));
  await writeJsonAtomic(hookStatePath, {
    version: HOOK_STATE_VERSION,
    updated_at: new Date().toISOString(),
    project_id: projectState.project.id,
    window_id: normalizeWindowId(previous.window_id),
    threshold_active: false,
    phase: "reset",
    reset_reason: "threshold_changed",
    mode: previous.mode ?? null,
    reminder_count: previous.reminder_count ?? 0,
    warned_at: previous.warned_at ?? null,
    handled_at: previous.handled_at ?? null,
    handoff_baseline_signature: previous.handoff_baseline_signature ?? "",
    trigger_session_id: previous.trigger_session_id ?? null,
    trigger_event: previous.trigger_event ?? null,
    status: threshold.status,
    five_hour: {
      used_percentage: threshold.five_hour.used_percentage,
      warning_threshold: thresholds.fiveHourThreshold,
      remaining_percentage: remainingPercentage(threshold.five_hour.used_percentage)
    },
    handoff_path: projectState.handoffPath
  });

  return {
    reset: true,
    status: threshold.status,
    wasActive: true,
    usedPercentage: threshold.five_hour.used_percentage,
    warningThreshold: thresholds.fiveHourThreshold,
    hookStatePath
  };
}

async function resetIfActive({ previous, hookStatePath, projectState, threshold, thresholds }) {
  if (previous?.threshold_active !== true) return;
  await ensureDir(path.dirname(hookStatePath));
  await writeJsonAtomic(hookStatePath, {
    version: HOOK_STATE_VERSION,
    updated_at: new Date().toISOString(),
    project_id: projectState.project.id,
    window_id: normalizeWindowId(previous.window_id),
    threshold_active: false,
    phase: "reset",
    reset_reason: threshold.status === "stale" ? "usage_window_reset" : "below_threshold",
    mode: previous.mode ?? null,
    reminder_count: previous.reminder_count ?? 0,
    warned_at: previous.warned_at ?? null,
    handled_at: previous.handled_at ?? null,
    handoff_baseline_signature: previous.handoff_baseline_signature ?? "",
    trigger_session_id: previous.trigger_session_id ?? null,
    trigger_event: previous.trigger_event ?? null,
    status: threshold.status,
    five_hour: {
      used_percentage: threshold.five_hour.used_percentage,
      warning_threshold: thresholds.fiveHourThreshold,
      remaining_percentage: remainingPercentage(threshold.five_hour.used_percentage)
    },
    handoff_path: projectState.handoffPath
  });
}

function isSubagentHook(input) {
  return typeof input.agent_id === "string" && input.agent_id.length > 0;
}

async function writeHookState({
  hookStatePath,
  input,
  projectState,
  threshold,
  thresholds,
  windowId,
  mode,
  thresholdActive,
  phase,
  reminderCount,
  warnedAt,
  handledAt,
  handoffBaselineSignature,
  triggerSessionId,
  triggerEvent
}) {
  await ensureDir(path.dirname(hookStatePath));
  await writeJsonAtomic(hookStatePath, {
    version: HOOK_STATE_VERSION,
    updated_at: new Date().toISOString(),
    project_id: projectState.project.id,
    window_id: normalizeWindowId(windowId),
    threshold_active: thresholdActive,
    phase,
    mode: mode ?? null,
    reminder_count: reminderCount ?? 0,
    warned_at: warnedAt ?? null,
    handled_at: handledAt ?? null,
    handoff_baseline_signature: typeof handoffBaselineSignature === "string" ? handoffBaselineSignature : "",
    trigger_session_id: triggerSessionId ?? null,
    trigger_event: triggerEvent ?? null,
    status: threshold.status,
    five_hour: {
      used_percentage: threshold.five_hour.used_percentage,
      warning_threshold: thresholds.fiveHourThreshold,
      remaining_percentage: remainingPercentage(threshold.five_hour.used_percentage)
    },
    handoff_path: projectState.handoffPath
  });
}

function getSessionId(input) {
  return typeof input.session_id === "string" ? input.session_id : null;
}

// Detect completion by content hash, not mtime or hook payload (payload shape is
// undocumented and changes between CC versions). Requires: no starter sentinel,
// all required sections present, and content changed since baseline.
async function handoffCompletedThisEpisode({ projectState, previous }) {
  try {
    const content = await fs.promises.readFile(projectState.handoffPath, "utf8");
    if (content.includes(STARTER_HANDOFF_MARKER)) return false;
    if (!isCompleteHandoffMarkdown(content)) return false;
    const baseline = previous?.handoff_baseline_signature;
    if (typeof baseline === "string" && baseline.length > 0) {
      return signatureOf(content) !== baseline;
    }
    // no baseline (file missing at warn or pre-upgrade card) — accept if complete
    return true;
  } catch {
    return false;
  }
}

function signatureOf(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function readHandoffSignature(filePath) {
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    return signatureOf(content);
  } catch {
    return "";
  }
}

function usageWindowId(usageState) {
  const resetsAt = usageState?.five_hour?.resets_at;
  return normalizeWindowId(resetsAt);
}

function normalizeWindowId(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function isUsageFresh(usageState, maxAgeMs, now) {
  const updatedAt = usageState?.updated_at;
  const updatedMs = typeof updatedAt === "string" ? Date.parse(updatedAt) : NaN;
  if (!Number.isFinite(updatedMs)) return false;
  const age = now - updatedMs;
  if (age <= 0) return true; // clock skew — treat as fresh
  return age <= maxAgeMs;
}

function freshnessMaxMs(effectiveConfig) {
  const seconds = effectiveConfig?.actions?.usage_max_age_seconds;
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return DEFAULT_USAGE_FRESH_MAX_MS;
}

function isCompleteHandoffMarkdown(content) {
  const requiredSections = [
    "# Next Session Handoff",
    "## Snapshot",
    "## Original User Prompts",
    "## What Changed",
    "## Current State",
    "## Decisions And Rationale",
    "## Files And Artifacts",
    "## Commands And Verification",
    "## Open Questions",
    "## Risks And Caveats",
    "## Do Not Repeat",
    "## Next Steps",
    "## Resume Prompt"
  ];
  // Anchor each header to the start of a line so a document that merely mentions
  // the section names inline (e.g. docs about the handoff format) is not mistaken
  // for a completed handoff.
  return requiredSections.every((section) => {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped}\\s*$`, "m").test(content);
  });
}

async function recordHookError(error) {
  try {
    const paths = defaultPaths();
    await ensureDir(paths.bridgeDir);
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    const line = `${new Date().toISOString()} ${name}: ${message}\n`;
    await fs.promises.appendFile(paths.hookErrorLogPath, line, { mode: 0o600 });
  } catch {
    // also fail open
  }
}

export function createUsageHandoffReminder({ projectState, threshold, thresholds }) {
  const used = threshold.five_hour.used_percentage;
  const remaining = remainingPercentage(used);
  return `Claude Cache Guard WARNING: 5-hour usage is ${formatPercent(used)} with about ${formatPercent(remaining)} remaining.

Project:
- Name: ${projectState.project.name}
- ID: ${projectState.project.id}
- Working Directory: ${projectState.project.cwd}

Thresholds:
- warning: ${formatPercent(thresholds.fiveHourThreshold)}

Instruction:
The configured usage threshold has been reached. Before continuing the current goal or taking on more work, update the handoff now:
1. Use the handoff prompt below.
2. The main Claude agent must do this itself. Do not delegate the handoff to an Agent or subagent.
3. Use the Write tool directly on the exact target path to fully replace next_session.md. Do not use Edit, append, or shell redirection.
4. Keep secrets out of the handoff. Do not read .env files.
5. After the Write tool finishes, Claude Cache Guard will stop this goal automatically. Do not continue other project work.

Handoff prompt:

${createHandoffPrompt({
    handoffPath: projectState.handoffPath,
    project: projectState.project,
    customGuidance: readHandoffGuidance(projectState.project.cwd)
  })}`;
}

export function createUsageHandoffAskReminder({ projectState, threshold, thresholds }) {
  const used = threshold.five_hour.used_percentage;
  const remaining = remainingPercentage(used);
  return `Claude Cache Guard CHOICE: 5-hour usage is ${formatPercent(used)} with about ${formatPercent(remaining)} remaining.

Project:
- Name: ${projectState.project.name}
- ID: ${projectState.project.id}
- Working Directory: ${projectState.project.cwd}

Thresholds:
- warning: ${formatPercent(thresholds.fiveHourThreshold)}

Instruction:
The configured usage threshold has been reached. Ask the user how to proceed before continuing, and present these two options:
1. Write the handoff now and wrap up: use the handoff prompt below to fully replace next_session.md with the Write tool, then stop here so work can resume in a fresh session.
2. Keep going: continue the current work despite the high usage (for example if the user still has budget or simply wants to finish).
Ask the user which they prefer and follow their choice. Claude Cache Guard will not stop automatically. It will not prompt again while 5-hour usage stays above the threshold in this window; if usage falls below the threshold and later crosses it again, it may ask once more.

Handoff prompt (use only if the user chooses to write the handoff):

${createHandoffPrompt({
    handoffPath: projectState.handoffPath,
    project: projectState.project,
    customGuidance: readHandoffGuidance(projectState.project.cwd)
  })}`;
}

function createUsageHandoffAskOutput({ projectState, threshold, thresholds, hookEventName }) {
  return {
    systemMessage: `Claude Cache Guard: 5-hour usage is ${formatPercent(threshold.five_hour.used_percentage)} (${threshold.status}); asked the user how to proceed.`,
    hookSpecificOutput: {
      hookEventName,
      additionalContext: createUsageHandoffAskReminder({ projectState, threshold, thresholds })
    }
  };
}

function createPendingHandoffOutput({ projectState, threshold, hookEventName }) {
  return {
    systemMessage: `Claude Cache Guard: handoff is still required at ${formatPercent(threshold.five_hour.used_percentage)} usage.`,
    hookSpecificOutput: {
      hookEventName,
      additionalContext: `Claude Cache Guard: stop other work and complete the pending handoff now. The main Claude agent must use the Write tool directly to fully replace ${projectState.handoffPath}. Do not delegate this to an Agent or subagent, and do not use Edit, append, or shell redirection. After the handoff file is fully written, Claude Cache Guard will stop the current goal automatically.`
    }
  };
}

function createHandoffCompletedOutput({ projectState, threshold, hookEventName }) {
  const message = `Claude Cache Guard: ${path.basename(projectState.handoffPath)} was fully written for this usage window at ${formatPercent(threshold.five_hour.used_percentage)} usage.`;
  if (hookEventName === "PostToolBatch") {
    return {
      continue: false,
      stopReason: `${message} The current goal has been stopped. In a new or cleared Claude Code session for ${projectState.project.cwd}, type /ccgresume to continue.`,
      systemMessage: `${message} Current goal stopped.`
    };
  }
  return { systemMessage: `${message} Claude may stop now.` };
}

function remainingPercentage(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.round((100 - value) * 10) / 10);
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 10) / 10}%` : "n/a";
}
