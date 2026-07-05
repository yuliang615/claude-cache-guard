import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { thresholdOptionsFromConfig } from "../src/config.js";
import { writeJsonAtomic } from "../src/json-file.js";
import {
  redactSensitiveString,
  sanitizeStatusLineInput,
  stringOrNull,
  resetValueOrNull,
} from "../src/sanitize.js";
import { formatPercent, formatReset } from "../src/statusline.js";

function tempDir(prefix = "ccg-audit-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// [1] effective threshold is validated on read, not just on write
test("thresholdOptionsFromConfig degrades an invalid persisted threshold to the default", () => {
  assert.equal(thresholdOptionsFromConfig({ thresholds: { five_hour_warning: 70 } }).fiveHourThreshold, 70);
  assert.equal(thresholdOptionsFromConfig({ thresholds: { five_hour_warning: "not-a-number" } }).fiveHourThreshold, 90);
  assert.equal(thresholdOptionsFromConfig({ thresholds: { five_hour_warning: 150 } }).fiveHourThreshold, 90);
  assert.equal(thresholdOptionsFromConfig({ thresholds: { five_hour_warning: 0 } }).fiveHourThreshold, 90);
  assert.equal(thresholdOptionsFromConfig({ thresholds: { five_hour_warning: null } }).fiveHourThreshold, 90);
  assert.equal(thresholdOptionsFromConfig({}).fiveHourThreshold, 90);
  // seven-day: valid stays, invalid degrades to null, null stays null
  assert.equal(thresholdOptionsFromConfig({ thresholds: { seven_day_warning: 80 } }).sevenDayThreshold, 80);
  assert.equal(thresholdOptionsFromConfig({ thresholds: { seven_day_warning: 999 } }).sevenDayThreshold, null);
  assert.equal(thresholdOptionsFromConfig({ thresholds: { seven_day_warning: null } }).sevenDayThreshold, null);
});

// [6] writeJsonAtomic refuses undefined instead of writing the literal "undefined"
test("writeJsonAtomic throws on undefined rather than corrupting the file", async () => {
  const dir = tempDir();
  await assert.rejects(() => writeJsonAtomic(path.join(dir, "x.json"), undefined), /refusing to write undefined/);
  assert.equal(fs.existsSync(path.join(dir, "x.json")), false);
});

// [2] writeJsonAtomic never leaves a temp file behind on a failed write/rename
test("writeJsonAtomic cleans up its temp file when the write fails", async () => {
  const dir = tempDir();
  const target = path.join(dir, "target"); // make the target a directory -> rename fails (EISDIR)
  fs.mkdirSync(target);
  await assert.rejects(() => writeJsonAtomic(target, { x: 1 }));
  const leftover = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftover, [], "no orphaned temp file");
});

// [7] redactSensitiveString handles JSON-style "key":"value" secrets
test("redactSensitiveString redacts JSON-style key/value secrets", () => {
  assert.match(redactSensitiveString('{"token":"abc123secret"}'), /\[redacted\]/);
  assert.doesNotMatch(redactSensitiveString('{"token":"abc123secret"}'), /abc123secret/);
  // still handles the plain forms
  assert.match(redactSensitiveString("token=abc123"), /\[redacted\]/);
  assert.match(redactSensitiveString("api_key: sk-xyz"), /\[redacted\]/);
});

// [10] allowlisted string VALUES are dropped if they look sensitive
test("sanitize drops sensitive-looking values from allowlisted string fields", () => {
  assert.equal(stringOrNull("Bearer sk-abc.def"), null);
  assert.equal(stringOrNull("Opus 4.6"), "Opus 4.6");
  assert.equal(resetValueOrNull("session=leak"), null);
  assert.equal(resetValueOrNull("2026-06-13T17:00:00Z"), "2026-06-13T17:00:00Z");

  const state = sanitizeStatusLineInput({
    model: { id: "authorization=secret", display_name: "Opus 4.6" },
    rate_limits: { five_hour: { used_percentage: 50, resets_at: "token=abc" } },
  });
  assert.equal(state.model.id, null, "sensitive model id dropped");
  assert.equal(state.model.display_name, "Opus 4.6");
  assert.equal(state.five_hour.resets_at, null, "sensitive resets_at dropped");
});

// [8] formatPercent never renders Infinity%
test("formatPercent returns n/a for overflow-prone finite input", () => {
  assert.equal(formatPercent(1e308), "n/a");
  assert.equal(formatPercent(42), "42%");
  assert.equal(formatPercent(75.25), "75.3%");
  assert.equal(formatPercent(Infinity), "n/a");
});

// Percentages outside 0-100 mean broken upstream data; render n/a, not "-5%".
test("formatPercent returns n/a for out-of-range values", () => {
  assert.equal(formatPercent(-5), "n/a");
  assert.equal(formatPercent(200), "n/a");
  assert.equal(formatPercent(0), "0%");
  assert.equal(formatPercent(100), "100%");
});

// [9] formatReset never renders "Invalid Date"
test("formatReset returns empty string for out-of-range numeric timestamps", () => {
  assert.equal(formatReset(1e16), ""); // > max valid Date ms -> Invalid Date
  assert.doesNotMatch(formatReset(1e16), /Invalid Date/);
  assert.match(formatReset("2026-06-13T17:00:00Z"), /reset 2026-06-13T17:00:00Z/);
  assert.equal(formatReset(""), "");
});
