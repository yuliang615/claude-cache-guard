const ALLOWED_TOP_LEVEL = new Set([
  "source",
  "updated_at",
  "model",
  "context_window",
  "five_hour",
  "seven_day"
]);

export function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Allowlisted strings end up verbatim in the rendered statusLine; a stray
// newline or ANSI escape (ESC/CSI/C1) would corrupt the terminal on every
// repaint. Strip all control characters BEFORE the sensitive-marker check so
// interleaved control bytes cannot split a marker word past the regex.
function stripControlChars(value) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

export function stringOrNull(value) {
  if (typeof value !== "string") return null;
  const cleaned = stripControlChars(value);
  if (cleaned.length === 0) return null;
  // Defense in depth: even allowlisted string fields must not carry secrets.
  return hasSensitiveMarker(cleaned) ? null : cleaned;
}

export function resetValueOrNull(value) {
  if (typeof value === "string") {
    const cleaned = stripControlChars(value);
    if (cleaned.length === 0) return null;
    return hasSensitiveMarker(cleaned) ? null : cleaned;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function sanitizeStatusLineInput(input, now = new Date()) {
  const rateLimits = input?.rate_limits && typeof input.rate_limits === "object"
    ? input.rate_limits
    : null;
  const fiveHour = rateLimits?.five_hour && typeof rateLimits.five_hour === "object"
    ? rateLimits.five_hour
    : null;
  const sevenDay = rateLimits?.seven_day && typeof rateLimits.seven_day === "object"
    ? rateLimits.seven_day
    : null;

  const state = {
    source: "claude-code-statusLine",
    updated_at: now.toISOString(),
    model: {
      id: stringOrNull(input?.model?.id),
      display_name: stringOrNull(input?.model?.display_name)
    },
    context_window: {
      used_percentage: numberOrNull(input?.context_window?.used_percentage)
    },
    five_hour: {
      used_percentage: numberOrNull(fiveHour?.used_percentage),
      resets_at: resetValueOrNull(fiveHour?.resets_at)
    },
    seven_day: {
      used_percentage: numberOrNull(sevenDay?.used_percentage),
      resets_at: resetValueOrNull(sevenDay?.resets_at)
    }
  };

  assertAllowedStateShape(state);
  return state;
}

export function assertAllowedStateShape(state) {
  for (const key of Object.keys(state)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      throw new Error(`Refusing to write unexpected usage-state key: ${key}`);
    }
  }
}

export function redactDiagnostic(value) {
  if (typeof value === "string") return redactSensitiveString(value);
  if (Array.isArray(value)) return value.map(redactDiagnostic);
  if (!value || typeof value !== "object") return value;

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/token|auth|oauth|cookie|session|api[_-]?key|secret|password/i.test(key)) {
      result[key] = "[redacted]";
    } else {
      result[key] = redactDiagnostic(child);
    }
  }
  return result;
}

export function hasSensitiveMarker(value) {
  return typeof value === "string" && (
    /token|auth|oauth|cookie|session|api[_-]?key|secret|password/i.test(value) ||
    /\bBearer\s+\S/i.test(value)
  );
}

export function redactSensitiveString(value) {
  if (!hasSensitiveMarker(value)) return value;
  return value
    .replace(/([A-Z0-9_]*(?:TOKEN|AUTH|OAUTH|COOKIE|SESSION|API_KEY|APIKEY|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|[^\s]+)/gi, "$1[redacted]")
    .replace(/((?:token|auth|oauth|cookie|session|api[_-]?key|secret|password)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&]+)/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[redacted]");
}
