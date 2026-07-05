import test from "node:test";
import assert from "node:assert/strict";
import { formatReset, renderPreviousStatusLine } from "../src/statusline.js";

test("formatReset renders ISO strings as-is and handles empty values", () => {
  assert.equal(formatReset("2026-06-13T17:00:00Z"), " reset 2026-06-13T17:00:00Z");
  assert.equal(formatReset(null), "");
  assert.equal(formatReset(undefined), "");
  assert.equal(formatReset(""), "");
});

test("formatReset treats large numbers as milliseconds and small numbers as seconds", () => {
  const seconds = 1781000000; // ~2026 expressed in seconds since epoch
  const millis = 1781000000 * 1000; // same instant expressed in milliseconds
  // Both representations of the same instant must render identically (no nonsense far-future date).
  assert.equal(formatReset(seconds), formatReset(millis));
  assert.match(formatReset(millis), / reset /);
});

test(
  "BUG-01: a forked grandchild cannot outrun the 1.5s timeout",
  { timeout: 15000 },
  async () => {
    // `sleep 3; echo` forks a grandchild that inherits our stdout pipe; the old
    // code waited on it (~3s). The group-kill deadline must resolve near 1.5s.
    const start = performance.now();
    const result = await renderPreviousStatusLine(
      { type: "command", command: "sleep 3; echo TOO-LATE" },
      "{}"
    );
    const elapsed = performance.now() - start;
    assert.equal(result, null, "must not capture the grandchild's late output");
    assert.ok(elapsed < 2500, `expected < 2500ms, took ${Math.round(elapsed)}ms`);
  }
);

test("QA: a non-string previous command fails open (null), never throws", async () => {
  // A hand-edited settings.json could leave a numeric statusLine.command; spawn
  // would throw synchronously and blank the line. It must degrade to null instead.
  assert.equal(await renderPreviousStatusLine({ type: "command", command: 123 }, "{}"), null);
  assert.equal(await renderPreviousStatusLine({ type: "command", command: "" }, "{}"), null);
  assert.equal(await renderPreviousStatusLine({ type: "command", command: null }, "{}"), null);
});

test("QA: a large stdin payload to a command that ignores stdin does not crash (EPIPE handled)", async () => {
  // >64KB overflows the pipe buffer; if the command exits without draining stdin,
  // the write emits EPIPE. With a stdin error handler it must still resolve cleanly.
  const bigInput = "x".repeat(200000);
  const result = await renderPreviousStatusLine(
    { type: "command", command: "echo OK" },
    bigInput
  );
  assert.equal(result, "OK");
});

test("QA: the spawned previous command is tagged with CCG_BRIDGE_CHILD=1 (recursion marker)", async () => {
  // The structural recursion guard relies on children inheriting this marker so a
  // self-referential previous command detects it is a child and stops recursing.
  const result = await renderPreviousStatusLine(
    { type: "command", command: "echo marker=$CCG_BRIDGE_CHILD" },
    "{}"
  );
  assert.equal(result, "marker=1");
});
