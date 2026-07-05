export const DEFAULT_FIVE_HOUR_THRESHOLD = 90;

export const thresholdMessages = {
  ok: "Usage is below the configured threshold.",
  warning: "You should update next_session.md soon.",
  stale: "Claude usage data is stale because the 5-hour reset time has passed. Use Claude Code until the statusLine guard refreshes usage-state.json.",
  unavailable: "Claude usage data is unavailable. Run the statusLine guard first."
};

export const thresholdExitCodes = {
  ok: 0,
  warning: 1,
  stale: 3,
  unavailable: 3
};

export function parseThresholdOptions(args) {
  const options = {
    fiveHourThreshold: DEFAULT_FIVE_HOUR_THRESHOLD,
    sevenDayThreshold: null,
    json: false,
    provided: {
      fiveHourThreshold: false,
      sevenDayThreshold: false
    }
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--five-hour") {
      options.fiveHourThreshold = parseThresholdValue(args[index + 1], "--five-hour");
      options.provided.fiveHourThreshold = true;
      index += 1;
      continue;
    }
    if (arg === "--seven-day") {
      options.sevenDayThreshold = parseThresholdValue(args[index + 1], "--seven-day");
      options.provided.sevenDayThreshold = true;
      index += 1;
      continue;
    }
    throw new Error(`Unknown check-threshold option: ${arg}`);
  }

  return options;
}

export function parseThresholdValue(value, flagName) {
  if (value === undefined) {
    throw new Error(`${flagName} requires a numeric percentage`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${flagName} must be a number from 0 to 100`);
  }
  return parsed;
}

export function evaluateUsageThreshold(state, options = {}) {
  const fiveHourThreshold = options.fiveHourThreshold ?? DEFAULT_FIVE_HOUR_THRESHOLD;
  const sevenDayThreshold = options.sevenDayThreshold ?? null;
  const fiveHourUsed = state?.five_hour?.used_percentage;
  const fiveHourResetsAt = state?.five_hour?.resets_at ?? null;
  const sevenDayUsed = state?.seven_day?.used_percentage;

  if (!Number.isFinite(fiveHourUsed)) {
    return thresholdResult({
      status: "unavailable",
      fiveHourUsed: null,
      fiveHourThreshold,
      sevenDayUsed: numberOrNull(sevenDayUsed),
      sevenDayThreshold
    });
  }

  if (isPastResetTime(fiveHourResetsAt, options.now)) {
    return thresholdResult({
      status: "stale",
      fiveHourUsed,
      fiveHourThreshold,
      sevenDayUsed: numberOrNull(sevenDayUsed),
      sevenDayThreshold
    });
  }

  const status = fiveHourUsed >= fiveHourThreshold ? "warning" : "ok";

  return thresholdResult({
    status,
    fiveHourUsed,
    fiveHourThreshold,
    sevenDayUsed: numberOrNull(sevenDayUsed),
    sevenDayThreshold
  });
}

export function thresholdResult({
  status,
  fiveHourUsed,
  fiveHourThreshold,
  sevenDayUsed,
  sevenDayThreshold
}) {
  return {
    status,
    five_hour: {
      used_percentage: fiveHourUsed,
      threshold: fiveHourThreshold
    },
    seven_day: {
      used_percentage: sevenDayUsed,
      threshold: sevenDayThreshold
    },
    message: thresholdMessages[status],
    exitCode: thresholdExitCodes[status]
  };
}

export function formatThresholdText(result) {
  return [
    `status: ${result.status}`,
    `5h usage: ${formatFiveHourThresholdUsage(result)}`,
    `threshold: ${formatThresholdPercent(result.five_hour.threshold)}`,
    `message: ${result.message}`
  ].join("\n");
}

export function formatThresholdJson(result) {
  return JSON.stringify({
    status: result.status,
    five_hour: result.five_hour,
    seven_day: result.seven_day,
    message: result.message
  }, null, 2);
}

function formatThresholdPercent(value) {
  return Number.isFinite(value) ? `${value}%` : "n/a";
}

function formatFiveHourThresholdUsage(result) {
  if (result.status === "stale") {
    return `stale ${formatThresholdPercent(result.five_hour.used_percentage)} (reset time passed)`;
  }
  return formatThresholdPercent(result.five_hour.used_percentage);
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function isPastResetTime(value, now = Date.now()) {
  const resetTimeMs = parseResetTimeMs(value);
  if (!Number.isFinite(resetTimeMs)) return false;
  return resetTimeMs <= normalizeNowMs(now);
}

function parseResetTimeMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeNowMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}
