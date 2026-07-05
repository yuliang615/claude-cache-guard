import fs from "node:fs";
import path from "node:path";
import { defaultPaths } from "./paths.js";
import { copyIfExists, ensureDir, readJsonIfExists, writeJsonAtomic } from "./json-file.js";
import { hasSensitiveMarker } from "./sanitize.js";
import { ensureGlobalConfig } from "./config.js";

const MANAGED_BY = "claude-cache-guard";

export function bridgeCommand(paths = defaultPaths()) {
  return `node ${JSON.stringify(paths.cliPath)} statusline`;
}

export function isBridgeStatusLine(statusLine) {
  // Matches current + legacy invocation forms, word-boundary anchored.
  return Boolean(
    statusLine &&
      statusLine.type === "command" &&
      typeof statusLine.command === "string" &&
      /(?:claude-cache-guard|claude-usage-bridge)\.js"?\s+statusline(?=\s|$)|(?<![\w-])(?:claude-cache-guard|claude-usage-bridge)\s+statusline(?=\s|$)|(?<![\w-])(?:ccg|cub)\s+statusline(?=\s|$)/.test(statusLine.command)
  );
}

export async function backupSettings(paths = defaultPaths(), label = "settings") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(paths.backupsDir, `${label}.${stamp}.json`);
  const copied = await copyIfExists(paths.settingsPath, backupPath);
  return copied ? backupPath : null;
}

export async function installBridge({
  fiveHourWarning,
  reconfigureThresholds = false
} = {}) {
  const paths = defaultPaths();
  await ensureDir(paths.claudeDir);
  await ensureDir(paths.bridgeDir);
  await ensureDir(paths.backupsDir);

  const settings = await readJsonIfExists(paths.settingsPath, {});
  if (!settings || Array.isArray(settings) || typeof settings !== "object") {
    throw new Error(`${paths.settingsPath} must contain a JSON object`);
  }

  const currentStatusLine = settings.statusLine;

  const backupPath = await backupSettings(paths, "settings.before-install");
  const command = bridgeCommand(paths);
  const globalConfig = await ensureGlobalConfig({
    homeDir: paths.homeDir,
    fiveHourWarning,
    reconfigureThresholds
  });
  const installState = await readInstallState(paths);
  const previousStatusLineCandidate = isBridgeStatusLine(currentStatusLine)
    ? installState?.previousStatusLine ?? null
    : currentStatusLine ?? null;
  const skippedSensitivePreviousStatusLine = hasSensitiveStatusLine(previousStatusLineCandidate);
  const previousStatusLine = skippedSensitivePreviousStatusLine ? null : previousStatusLineCandidate;

  const nextSettings = {
    ...settings,
    statusLine: {
      ...(currentStatusLine && typeof currentStatusLine === "object" ? currentStatusLine : {}),
      type: "command",
      command,
      padding: currentStatusLine?.padding ?? 0
    }
  };

  await writeJsonAtomic(paths.installStatePath, {
    managed_by: MANAGED_BY,
    installed_at: new Date().toISOString(),
    selfCommand: command,
    previousStatusLine,
    lastBackupPath: backupPath
  });
  await writeJsonAtomic(paths.settingsPath, nextSettings);

  return {
    settingsPath: paths.settingsPath,
    configPath: paths.configPath,
    installStatePath: paths.installStatePath,
    statePath: paths.statePath,
    backupPath,
    command,
    globalConfigCreated: globalConfig.created,
    globalConfigReconfigured: Boolean(globalConfig.reconfigured),
    wrappedPreviousStatusLine: Boolean(previousStatusLine),
    skippedSensitivePreviousStatusLine
  };
}

export async function uninstallBridge({ remove = false, removeConfig = false } = {}) {
  const paths = defaultPaths();
  const settings = await readJsonIfExists(paths.settingsPath, {});

  if (!settings || Array.isArray(settings) || typeof settings !== "object") {
    throw new Error(`${paths.settingsPath} must contain a JSON object`);
  }

  const installState = await readInstallState(paths);
  const statusLineWasBridge = isBridgeStatusLine(settings.statusLine);

  const backupPath = statusLineWasBridge
    ? await backupSettings(paths, "settings.before-uninstall")
    : null;

  let restoredPreviousStatusLine = false;
  let removedStatusLine = false;
  if (statusLineWasBridge) {
    const nextSettings = { ...settings };
    if (!remove && installState?.previousStatusLine) {
      nextSettings.statusLine = installState.previousStatusLine;
      restoredPreviousStatusLine = true;
    } else {
      delete nextSettings.statusLine;
      removedStatusLine = true;
    }
    await writeJsonAtomic(paths.settingsPath, nextSettings);
  }

  const removedConfig = removeConfig ? await removeFileIfExists(paths.configPath) : false;

  return {
    settingsPath: paths.settingsPath,
    backupPath,
    removedConfig,
    configPath: paths.configPath,
    statusLineWasBridge,
    restoredPreviousStatusLine,
    removedStatusLine,
    lastInstallBackupPath: installState?.lastBackupPath ?? null
  };
}

export async function restoreSettingsBackup(backupPath) {
  const paths = defaultPaths();
  if (!backupPath) throw new Error("Missing backup path");
  try {
    await fs.promises.access(backupPath, fs.constants.R_OK);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`backup file not found: ${backupPath}`);
    }
    throw error;
  }
  await backupSettings(paths, "settings.before-restore");
  await fs.promises.copyFile(backupPath, paths.settingsPath);
  await fs.promises.chmod(paths.settingsPath, 0o600);
  return { settingsPath: paths.settingsPath, restoredFrom: backupPath };
}

function hasSensitiveStatusLine(statusLine) {
  return containsSensitiveValue(statusLine);
}

function containsSensitiveValue(value) {
  if (typeof value === "string") return hasSensitiveMarker(value);
  if (Array.isArray(value)) return value.some(containsSensitiveValue);
  if (value && typeof value === "object") return Object.values(value).some(containsSensitiveValue);
  return false;
}

async function readInstallState(paths = defaultPaths()) {
  const installState = await readJsonIfExists(paths.installStatePath, null);
  if (installState) return installState;

  // pre-config releases stored install metadata in config.json
  const legacyConfig = await readJsonIfExists(paths.configPath, null);
  if (legacyConfig?.managed_by === MANAGED_BY) return legacyConfig;
  return {};
}

async function removeFileIfExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    await fs.promises.rm(filePath, { force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
