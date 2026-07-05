import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeStatusLineInput, hasSensitiveMarker, redactSensitiveString } from "../src/sanitize.js";

test("sanitizeStatusLineInput writes only allowlisted non-sensitive usage fields", () => {
  const state = sanitizeStatusLineInput(
    {
      model: {
        id: "claude-opus-4-6",
        display_name: "Opus 4.6"
      },
      context_window: {
        used_percentage: 12.5,
        total_input_tokens: 999999
      },
      rate_limits: {
        five_hour: {
          used_percentage: 88.1,
          resets_at: "2026-06-13T17:00:00Z",
          oauth_token: "must-not-copy"
        },
        seven_day: {
          used_percentage: 21,
          resets_at: 1780000000
        }
      },
      oauth_token: "must-not-copy",
      session_id: "must-not-copy"
    },
    new Date("2026-06-13T12:00:00Z")
  );

  assert.deepEqual(Object.keys(state), [
    "source",
    "updated_at",
    "model",
    "context_window",
    "five_hour",
    "seven_day"
  ]);
  assert.equal(state.five_hour.used_percentage, 88.1);
  assert.equal(state.five_hour.resets_at, "2026-06-13T17:00:00Z");
  assert.equal(JSON.stringify(state).includes("must-not-copy"), false);
  assert.equal(JSON.stringify(state).includes("total_input_tokens"), false);
});

test("sanitizeStatusLineInput handles missing rate_limits without crashing", () => {
  const state = sanitizeStatusLineInput({ model: { display_name: "Sonnet" } });
  assert.equal(state.five_hour.used_percentage, null);
  assert.equal(state.five_hour.resets_at, null);
  assert.equal(state.seven_day.used_percentage, null);
  assert.equal(state.seven_day.resets_at, null);
});

test("hasSensitiveMarker detects a bare Bearer token without other marker words", () => {
  assert.equal(hasSensitiveMarker("Bearer abc123XYZ"), true);
  assert.equal(hasSensitiveMarker("hello world status"), false);
});

test("redactSensitiveString redacts a bare Bearer token", () => {
  const out = redactSensitiveString("Bearer abc123XYZ");
  assert.equal(out.includes("abc123XYZ"), false);
  assert.match(out, /\[redacted\]/);
});

test("control characters and ANSI escapes are stripped from allowlisted strings", () => {
  const ESC = String.fromCharCode(27);
  const state = sanitizeStatusLineInput({
    model: {
      id: `opus${ESC}[2J`,
      display_name: `line1\nline2\ttab ${ESC}[31mred${ESC}[0m`
    },
    rate_limits: {
      five_hour: { used_percentage: 50, resets_at: `2026-07-05${ESC}[2K${ESC}[1A` }
    }
  });
  // No control bytes may survive into the state (they would corrupt the
  // rendered statusLine on every repaint).
  for (const value of [state.model.id, state.model.display_name, state.five_hour.resets_at]) {
    assert.equal(typeof value, "string");
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(value, /[\u0000-\u001f\u007f-\u009f]/);
  }
  assert.equal(state.model.display_name.includes("line1"), true);
});

test("a control-character-only string sanitizes to null, and control bytes cannot split a sensitive marker", () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const NUL = String.fromCharCode(0);
  const state = sanitizeStatusLineInput({
    model: {
      id: `${ESC}${BEL}${NUL}\n\t`,
      display_name: `tok${NUL}en=abc123`
    }
  });
  assert.equal(state.model.id, null, "nothing printable left -> null");
  assert.equal(state.model.display_name, null, "stripping must not defeat the sensitive-marker check");
});
