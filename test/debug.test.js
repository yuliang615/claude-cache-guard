import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "claude-cache-guard.js");

test("debug does not print raw statusLine commands or guard config values", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccg-debug-"));
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(path.join(claudeDir, "cache-guard"), { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({
      statusLine: {
        type: "command",
        command: "ANTHROPIC_AUTH_TOKEN=secret-value printf status"
      }
    })
  );
  fs.writeFileSync(
    path.join(claudeDir, "cache-guard", "config.json"),
    JSON.stringify({
      managed_by: "claude-cache-guard",
      previousStatusLine: {
        type: "command",
        command: "bearer hidden-value"
      },
      lastBackupPath: path.join(claudeDir, "cache-guard", "backups", "settings.json")
    })
  );

  const result = spawnSync(process.execPath, [bin, "debug"], {
    cwd: root,
    env: { ...process.env, HOME: home },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes("secret-value"), false);
  assert.equal(result.stdout.includes("hidden-value"), false);
  assert.equal(result.stdout.includes("ANTHROPIC_AUTH_TOKEN"), false);
  assert.equal(result.stdout.includes("bearer"), false);
  const debug = JSON.parse(result.stdout);
  assert.equal(debug.statusLine.has_command, true);
  assert.equal(debug.bridge_config.exists, true);
  assert.equal(debug.bridge_config.has_previous_statusLine, undefined);
});
