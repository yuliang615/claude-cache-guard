import fs from "node:fs";
import { spawn } from "node:child_process";
import { defaultPaths } from "./paths.js";
import { readJsonIfExists, writeJsonAtomic } from "./json-file.js";
import { sanitizeStatusLineInput } from "./sanitize.js";
import { isBridgeStatusLine } from "./settings.js";

export async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runStatusLineBridge({ stdin = process.stdin, stdout = process.stdout } = {}) {
  const rawInput = await readStdin(stdin);
  let input;
  try {
    input = rawInput.trim() ? JSON.parse(rawInput) : {};
  } catch {
    stdout.write("Claude usage guard: invalid statusLine JSON\n");
    return 0;
  }

  const paths = defaultPaths();
  const state = sanitizeStatusLineInput(input);
  try {
    await writeJsonAtomic(paths.statePath, state);
  } catch (error) {
    // fail open — log for `doctor` but keep rendering
    await recordStateWriteError(paths, error).catch(() => {});
  }

  // A hand-corrupted install-state.json / config.json must not crash every refresh:
  // treat unreadable state as absent and fall back to the default render.
  const installState = (await readJsonIfExists(paths.installStatePath, null).catch(() => null))
    ?? (await readJsonIfExists(paths.configPath, {}).catch(() => ({})));
  // When we spawn the previous statusLine we tag the child with CCG_BRIDGE_CHILD.
  // If that child turns out to be this very bridge (a self-referential previous
  // command the recursion regex failed to recognize), this guard stops it from
  // recursing again — bounding the chain to a single level regardless of how the
  // command was quoted or wrapped.
  const isBridgeChild = process.env.CCG_BRIDGE_CHILD === "1";
  const previousStatusLine = installState?.previousStatusLine;
  const previousOutput = isBridgeChild
    ? null
    : await renderPreviousStatusLine(previousStatusLine, rawInput, installState?.selfCommand).catch(() => null);
  stdout.write(`${previousOutput || renderDefaultStatusLine(state)}\n`);
  return 0;
}

export function renderDefaultStatusLine(state) {
  const model = state.model.display_name || state.model.id || "Claude";
  const context = formatPercent(state.context_window.used_percentage);
  const fiveHour = formatPercent(state.five_hour.used_percentage);
  const sevenDay = formatPercent(state.seven_day.used_percentage);
  const reset5h = formatReset(state.five_hour.resets_at);
  const reset7d = formatReset(state.seven_day.resets_at);

  if (!hasRateLimitValues(state)) {
    return `${model} | ctx ${context} | 5h n/a | 7d n/a | rate_limits unavailable`;
  }
  return `${model} | ctx ${context} | 5h ${fiveHour}${reset5h} | 7d ${sevenDay}${reset7d}`;
}

export function hasRateLimitValues(state) {
  return Boolean(
    hasValue(state?.five_hour?.used_percentage) ||
      hasValue(state?.five_hour?.resets_at) ||
      hasValue(state?.seven_day?.used_percentage) ||
      hasValue(state?.seven_day?.resets_at)
  );
}

function hasValue(value) {
  return value !== null && value !== undefined;
}

export function formatPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  // Percentages outside 0-100 mean the upstream payload is broken; render n/a
  // rather than a nonsensical "-5%" / "200%" (this also covers huge values
  // that would overflow to Infinity in the rounding below).
  if (value < 0 || value > 100) return "n/a";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}%`;
}

export function formatReset(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000; // accept seconds or ms
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return ""; // out-of-range -> Invalid Date
    return ` reset ${date.toLocaleString()}`;
  }
  if (typeof value === "string") return ` reset ${value}`;
  return "";
}

async function recordStateWriteError(paths, error) {
  try {
    await fs.promises.mkdir(paths.bridgeDir, { recursive: true, mode: 0o700 });
    const message = error instanceof Error ? error.message : String(error);
    const line = `${new Date().toISOString()} usage-state write failed: ${message}\n`;
    await fs.promises.appendFile(paths.hookErrorLogPath, line, { mode: 0o600 });
  } catch {
    // also fail open
  }
}

export async function renderPreviousStatusLine(previousStatusLine, rawInput, selfCommand) {
  // command must be a non-empty string; a non-string (e.g. a number) would make
  // spawn throw synchronously and blank the status line instead of failing open.
  if (!previousStatusLine || previousStatusLine.type !== "command" ||
      typeof previousStatusLine.command !== "string" || previousStatusLine.command.length === 0) {
    return null;
  }
  if (selfCommand && previousStatusLine.command === selfCommand) return null;
  // Would this command re-invoke our own statusline bridge? If so, don't recurse.
  // This regex is a best-effort filter; the CCG_BRIDGE_CHILD env marker below is
  // the guarantee that a form it misses still can't recurse past one level.
  if (isBridgeStatusLine({ type: "command", command: previousStatusLine.command })) return null;

  return new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Release our end of the pipes so a reparented grandchild still holding the
      // stdout write end can't keep this bridge process alive past the deadline.
      try { child?.stdout?.destroy(); } catch {}
      try { child?.stdin?.destroy(); } catch {}
      resolve(value);
    };
    const killGroup = () => {
      // Negative pid targets the whole group (POSIX); fall back to the direct
      // child on platforms without group signals (e.g. Windows).
      try { process.kill(-child.pid, "SIGKILL"); } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
    };

    // Node's own child `timeout` only signals the direct shell, letting reparented
    // grandchildren keep the pipe open; enforce the deadline against the group.
    const timer = setTimeout(() => {
      killGroup();
      finish(null);
    }, 1500);

    try {
      // detached: the shell becomes a process group leader so we can kill the whole
      // group (grandchildren from `;`/pipelines that inherit our stdout pipe).
      // CCG_BRIDGE_CHILD lets a spawned copy of this bridge detect it is a child
      // and refuse to render its own previous command (structural recursion guard).
      child = spawn(previousStatusLine.command, {
        shell: true,
        stdio: ["pipe", "pipe", "ignore"],
        detached: true,
        env: { ...process.env, CCG_BRIDGE_CHILD: "1" }
      });
    } catch {
      finish(null);
      return;
    }

    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 4096) killGroup();
    });
    // Ignore pipe errors (e.g. EPIPE when the command exits without reading stdin,
    // or a broken pipe after killGroup) so they don't crash the bridge.
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code === 0 && output.trim()) finish(output.trimEnd());
      else finish(null);
    });
    child.stdin.end(rawInput);
    child.unref();
  });
}
