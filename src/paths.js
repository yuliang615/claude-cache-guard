import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

export function expandHome(value, homeDir = os.homedir()) {
  if (!value || typeof value !== "string") return value;
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return value;
}

export function defaultPaths(homeDir = os.homedir()) {
  const claudeDir = path.join(homeDir, ".claude");
  const bridgeDir = path.join(claudeDir, "cache-guard");
  return {
    homeDir,
    claudeDir,
    settingsPath: path.join(claudeDir, "settings.json"),
    statePath: path.join(claudeDir, "usage-state.json"),
    commandsDir: path.join(claudeDir, "commands"),
    bridgeDir,
    configPath: path.join(bridgeDir, "config.json"),
    installStatePath: path.join(bridgeDir, "install-state.json"),
    hookStateDir: path.join(bridgeDir, "hook-state"),
    hookErrorLogPath: path.join(bridgeDir, "hook-errors.log"),
    backupsDir: path.join(bridgeDir, "backups"),
    packageRoot: PACKAGE_ROOT,
    cliPath: path.join(PACKAGE_ROOT, "bin", "claude-cache-guard.js")
  };
}
