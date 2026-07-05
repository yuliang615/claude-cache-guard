import test from "node:test";
import assert from "node:assert/strict";
import { isBridgeStatusLine } from "../src/settings.js";
import { mergeConfig } from "../src/config.js";

test("isBridgeStatusLine matches the guard's own invocation forms", () => {
  assert.equal(
    isBridgeStatusLine({ type: "command", command: 'node "/x/bin/claude-cache-guard.js" statusline' }),
    true
  );
  assert.equal(isBridgeStatusLine({ type: "command", command: "claude-cache-guard statusline" }), true);
  assert.equal(isBridgeStatusLine({ type: "command", command: "ccg statusline" }), true);
});

test("isBridgeStatusLine does not match third-party statuslines that merely mention ccg", () => {
  assert.equal(isBridgeStatusLine({ type: "command", command: "my-ccg statusline" }), false);
  assert.equal(isBridgeStatusLine({ type: "command", command: "supercub statusline" }), false);
  assert.equal(isBridgeStatusLine({ type: "command", command: "scoop-ccg statusline --json" }), false);
  assert.equal(isBridgeStatusLine({ type: "command", command: "printf hi" }), false);
});

test("isBridgeStatusLine requires statusline to be a whole subcommand token, not a prefix", () => {
  // The guard's real command is always exactly "... statusline" (optionally followed by
  // whitespace). A longer token that merely starts with "statusline" is a different,
  // third-party command and must NOT be clobbered/rewritten as if it were the guard's.
  assert.equal(isBridgeStatusLine({ type: "command", command: "ccg statusline-extra" }), false);
  assert.equal(isBridgeStatusLine({ type: "command", command: "ccg statuslineX" }), false);
  assert.equal(isBridgeStatusLine({ type: "command", command: "claude-cache-guard statusline-foo" }), false);
  assert.equal(isBridgeStatusLine({ type: "command", command: 'node "/x/bin/claude-cache-guard.js" statusline-foo' }), false);
  // The legitimate forms (bare, with trailing args, and the node invocation) still match.
  assert.equal(isBridgeStatusLine({ type: "command", command: "ccg statusline" }), true);
  assert.equal(isBridgeStatusLine({ type: "command", command: "ccg statusline --json" }), true);
  assert.equal(isBridgeStatusLine({ type: "command", command: 'node "/x/bin/claude-cache-guard.js" statusline' }), true);
});

test("mergeConfig ignores __proto__ keys and never pollutes Object.prototype", () => {
  const merged = mergeConfig({ a: 1 }, JSON.parse('{"__proto__":{"polluted":"yes"},"b":2}'));
  assert.equal(({}).polluted, undefined);
  assert.equal(merged.polluted, undefined);
  assert.equal(merged.a, 1);
  assert.equal(merged.b, 2);
});
