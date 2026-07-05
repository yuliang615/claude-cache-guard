import fs from "node:fs";
import path from "node:path";
import { defaultPaths, expandHome } from "./paths.js";
import { ensureDir, readJsonIfExists, writeJsonAtomic } from "./json-file.js";
import { getHandoffPaths, getProjectInfo, initHandoff } from "./handoff.js";

export const PROJECT_CONFIG_FILE = ".claude-cache-guard.json";

export const DEFAULT_GLOBAL_CONFIG = Object.freeze({
  version: 1,
  thresholds: {
    five_hour_warning: 90,
    seven_day_warning: null
  },
  handoff: {
    storage_dir: "~/.claude/next-session",
    file_name: "next_session.md",
    mode: "manual",
    max_lines: 220
  },
  actions: {
    on_warning: "auto_handoff"
  }
});

// "auto_handoff" (+ legacy "suggest_handoff") or "ask"
export const HANDOFF_MODE_AUTO = "auto";
export const HANDOFF_MODE_ASK = "ask";

export function createDefaultGlobalConfig({ fiveHourWarning } = {}) {
  const config = mergeConfig(DEFAULT_GLOBAL_CONFIG);
  if (fiveHourWarning !== undefined) {
    config.thresholds.five_hour_warning = validateFiveHourWarning(fiveHourWarning);
  }
  return config;
}

export function validateFiveHourWarning(value) {
  const parsed = Number(value);
  // Integers only, matching the /ccgconfig menu's own "integer 1-99" rule —
  // the CLI flag and the menu are two paths to the same setting and must
  // accept the same values.
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 99) {
    throw new Error("five-hour warning threshold must be a whole number from 1 to 99");
  }
  return parsed;
}

export function validateOnWarning(value) {
  if (typeof value !== "string") {
    throw new Error('on-warning mode must be "auto" or "ask"');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized === "auto_handoff") return "auto_handoff";
  if (normalized === "ask") return "ask";
  throw new Error(`on-warning mode must be "auto" or "ask" (got "${value}")`);
}

// Anything that isn't explicit "ask" falls back to auto (covers legacy values too).
export function handoffModeFromConfig(config) {
  return config?.actions?.on_warning === "ask" ? HANDOFF_MODE_ASK : HANDOFF_MODE_AUTO;
}

export function getProjectConfigPath(cwd = process.cwd()) {
  return path.join(path.resolve(cwd), PROJECT_CONFIG_FILE);
}

export async function getGlobalConfigState({ homeDir } = {}) {
  const paths = defaultPaths(homeDir);
  const existing = await readJsonIfExists(paths.configPath, null);
  return {
    path: paths.configPath,
    exists: Boolean(existing),
    legacy: isLegacyInstallMetadata(existing),
    config: existing
  };
}

export async function ensureGlobalConfig({
  homeDir,
  fiveHourWarning,
  reconfigureThresholds = false
} = {}) {
  const paths = defaultPaths(homeDir);
  const existing = await readJsonIfExists(paths.configPath, null);
  if (existing) {
    if (isLegacyInstallMetadata(existing)) {
      const installState = await readJsonIfExists(paths.installStatePath, null);
      if (!installState) {
        await writeJsonAtomic(paths.installStatePath, existing);
      }
      const config = createDefaultGlobalConfig({ fiveHourWarning });
      await writeJsonAtomic(paths.configPath, config);
      return { path: paths.configPath, config, created: true, migratedLegacy: true };
    }
    const existingConfig = removeRetiredConfigFields(existing);
    if (reconfigureThresholds) {
      const config = mergeConfig(DEFAULT_GLOBAL_CONFIG, existingConfig);
      if (fiveHourWarning !== undefined) {
        config.thresholds.five_hour_warning = validateFiveHourWarning(fiveHourWarning);
      }
      await writeJsonAtomic(paths.configPath, config);
      return { path: paths.configPath, config, created: false, reconfigured: true };
    }
    if (existingConfig !== existing) {
      await writeJsonAtomic(paths.configPath, existingConfig);
      return { path: paths.configPath, config: existingConfig, created: false, migratedRetiredFields: true };
    }
    return { path: paths.configPath, config: existingConfig, created: false };
  }
  await ensureDir(paths.bridgeDir);
  const config = createDefaultGlobalConfig({ fiveHourWarning });
  await writeJsonAtomic(paths.configPath, config);
  return { path: paths.configPath, config, created: true };
}

export async function readGlobalConfig({ homeDir } = {}) {
  const paths = defaultPaths(homeDir);
  const existing = await readJsonIfExists(paths.configPath, null);
  if (!existing) return structuredClone(DEFAULT_GLOBAL_CONFIG);
  if (isLegacyInstallMetadata(existing)) return structuredClone(DEFAULT_GLOBAL_CONFIG);
  return normalizeHandoffConfig(mergeConfig(DEFAULT_GLOBAL_CONFIG, removeRetiredConfigFields(existing)));
}

export async function readProjectConfig({ cwd = process.cwd() } = {}) {
  return readJsonIfExists(getProjectConfigPath(cwd), null);
}

export async function resolveEffectiveConfig({ homeDir, cwd = process.cwd(), cliOverrides = {} } = {}) {
  const globalConfig = await readGlobalConfig({ homeDir });
  const projectConfig = await readProjectConfig({ cwd });
  const projectOverrides = stripProjectHandoffPathOverrides(projectConfig?.overrides ?? {});
  return normalizeHandoffConfig(removeRetiredConfigFields(
    mergeConfig(globalConfig, projectOverrides, cliOverrides)
  ));
}

export function mergeConfig(...configs) {
  return configs.reduce((merged, config) => deepMerge(merged, config ?? {}), {});
}

export async function enableProject({ homeDir, cwd = process.cwd(), force = false } = {}) {
  const project = getProjectInfo(cwd);
  const configPath = getProjectConfigPath(cwd);
  const existing = await readJsonIfExists(configPath, {});
  const overrides = existing?.overrides && typeof existing.overrides === "object"
    ? removeRetiredConfigFields(mergeConfig(existing.overrides))
    : {};
  const effective = await resolveEffectiveConfig({ homeDir, cwd });
  const handoff = getHandoffPaths({
    homeDir,
    cwd,
    storageDir: effective.handoff.storage_dir,
    fileName: effective.handoff.file_name
  });

  const nextProjectConfig = {
    ...existing,
    version: 1,
    enabled: true,
    project_name: project.name,
    project_id: project.id,
    handoff: {
      ...(existing?.handoff && typeof existing.handoff === "object" ? existing.handoff : {}),
      file: toHomeRelative(handoff.handoffPath, homeDir)
    },
    overrides
  };

  const handoffInit = await initHandoff({
    force,
    homeDir,
    cwd,
    storageDir: effective.handoff.storage_dir,
    fileName: effective.handoff.file_name
  });
  try {
    await writeJsonAtomic(configPath, nextProjectConfig);
  } catch (error) {
    if (handoffInit.overwritten && handoffInit.backupPath) {
      // copyFile follows a destination symlink and would write THROUGH it to the
      // target; drop the link first so the restore lands on the real path.
      const destStat = await lstatIfExists(handoff.handoffPath);
      if (destStat && destStat.isSymbolicLink()) {
        await fs.promises.rm(handoff.handoffPath, { force: true });
      }
      await fs.promises.copyFile(handoffInit.backupPath, handoff.handoffPath);
      await fs.promises.chmod(handoff.handoffPath, 0o600);
    } else if (handoffInit.created) {
      await removeProjectHandoff({
        handoffPath: handoff.handoffPath,
        projectIds: [project.id]
      });
    }
    throw error;
  }

  return {
    configPath,
    projectConfig: nextProjectConfig,
    handoffPath: handoff.handoffPath,
    handoffCreated: handoffInit.created,
    handoffOverwritten: handoffInit.overwritten,
    handoffBackupPath: handoffInit.backupPath,
    project
  };
}

export async function updateProjectSettings({ cwd = process.cwd(), fiveHourWarning, onWarning } = {}) {
  const configPath = getProjectConfigPath(cwd);
  const existing = await readJsonIfExists(configPath, {});
  const project = getProjectInfo(cwd);
  const overrides = existing?.overrides && typeof existing.overrides === "object"
    ? removeRetiredConfigFields(mergeConfig(existing.overrides))
    : {};
  if (fiveHourWarning !== undefined) {
    overrides.thresholds = {
      ...(overrides.thresholds && typeof overrides.thresholds === "object" ? overrides.thresholds : {}),
      five_hour_warning: validateFiveHourWarning(fiveHourWarning)
    };
  }
  if (onWarning !== undefined) {
    overrides.actions = {
      ...(overrides.actions && typeof overrides.actions === "object" ? overrides.actions : {}),
      on_warning: validateOnWarning(onWarning)
    };
  }
  const nextProjectConfig = {
    ...existing,
    version: existing?.version ?? 1,
    enabled: existing?.enabled === true,
    project_name: existing?.project_name ?? project.name,
    project_id: existing?.project_id ?? project.id,
    handoff: existing?.handoff ?? {},
    overrides
  };
  await writeJsonAtomic(configPath, nextProjectConfig);
  return { configPath, projectConfig: nextProjectConfig };
}

export async function disableProject({ homeDir, cwd = process.cwd(), removeHandoff = false } = {}) {
  const paths = defaultPaths(homeDir);
  const configPath = getProjectConfigPath(cwd);
  const project = getProjectInfo(cwd);
  const existing = await readJsonIfExists(configPath, null);
  const effective = await resolveEffectiveConfig({ homeDir, cwd });
  const fallbackHandoff = getHandoffPaths({
    homeDir,
    cwd,
    storageDir: effective.handoff.storage_dir,
    fileName: effective.handoff.file_name
  });
  // The delete path is NOT the exfil vector getProjectState guards against: it
  // only removes (never prints content) and removeProjectHandoff already refuses
  // to delete unless basename(dirname) is a known project id. Honoring a custom
  // out-of-storage handoff.file here is what lets disable report the accurate
  // "kept ... not recognized" instead of silently deleting an in-storage file.
  const handoffPath = existing?.handoff?.file
    ? expandHome(existing.handoff.file, paths.homeDir)
    : fallbackHandoff.handoffPath;
  // don't delete another project's data if this dir was copied/moved
  const metadataMatches = !existing?.project_id || existing.project_id === project.id;
  const allProjectIds = [
    project.id,
    typeof existing?.project_id === "string" ? existing.project_id : null
  ].filter(Boolean);
  const removeHandoffNow = removeHandoff && metadataMatches;
  const handoffRemoval = removeHandoffNow
    ? await removeProjectHandoff({
      handoffPath,
      projectIds: allProjectIds
    })
    : { removedFile: false, removedDir: false, dirNotEmpty: false, guarded: false };
  const removedProjectConfig = await removeFileIfExists(configPath);
  const hookStateIds = metadataMatches ? allProjectIds : [project.id];
  const hookStatePaths = [...new Set(hookStateIds)].map((projectId) => path.join(paths.hookStateDir, `${projectId}.json`));
  const removedHookStatePaths = [];
  for (const hookStatePath of hookStatePaths) {
    if (await removeFileIfExists(hookStatePath)) removedHookStatePaths.push(hookStatePath);
  }

  return {
    configPath,
    handoffPath,
    metadataMatches,
    skippedHandoffRemovalStale: removeHandoff && !metadataMatches,
    skippedHandoffRemovalUnrecognized: removeHandoffNow && handoffRemoval.guarded === true,
    hookStatePath: hookStatePaths[0],
    hookStatePaths,
    removedProjectConfig,
    removedHandoffFile: handoffRemoval.removedFile,
    removedHandoffDir: handoffRemoval.removedDir,
    handoffDirNotEmpty: handoffRemoval.dirNotEmpty === true,
    removedHookState: removedHookStatePaths.length > 0,
    removedHookStatePaths,
    keptHandoffFile: !removeHandoffNow && Boolean(handoffPath)
  };
}

export async function getProjectState({ homeDir, cwd = process.cwd() } = {}) {
  const project = getProjectInfo(cwd);
  const projectConfig = await readProjectConfig({ cwd });
  const effectiveConfig = await resolveEffectiveConfig({ homeDir, cwd });
  // A persisted handoff.file is trusted only when it resolves inside the storage
  // dir; commandResume prints this file to the conversation, so an out-of-fence
  // path (e.g. hand-edited to ~/.ssh/id_rsa) must not be read.
  const handoffPath = resolveFencedHandoffPath({
    configuredFile: projectConfig?.handoff?.file,
    homeDir,
    cwd,
    storageDir: effectiveConfig.handoff.storage_dir,
    fileName: effectiveConfig.handoff.file_name
  });
  return {
    project,
    projectConfig,
    enabled: projectConfig?.enabled === true,
    metadataMatchesCurrentProject: !projectConfig
      ? true
      : typeof projectConfig.project_id === "string" && projectConfig.project_id.length > 0
        ? projectConfig.project_id === project.id
        : false,
    effectiveConfig,
    projectConfigPath: getProjectConfigPath(cwd),
    handoffPath
  };
}

export function thresholdOptionsFromConfig(config) {
  // Validate on read, not just on write: a hand-edited or corrupt persisted
  // threshold outside 1-99 (or non-numeric) must degrade to the safe default
  // instead of silently disabling the warning or tripping it spuriously.
  const five = Number(config?.thresholds?.five_hour_warning);
  const rawSeven = config?.thresholds?.seven_day_warning;
  const seven = Number(rawSeven);
  return {
    fiveHourThreshold: Number.isFinite(five) && five >= 1 && five <= 99
      ? five
      : DEFAULT_GLOBAL_CONFIG.thresholds.five_hour_warning,
    sevenDayThreshold: rawSeven == null
      ? null
      : (Number.isFinite(seven) && seven >= 1 && seven <= 99 ? seven : null)
  };
}

export function recommendationForThreshold(status) {
  switch (status) {
    case "warning":
      return "Run ccg handoff and ask Claude Code to update the handoff before starting larger work.";
    case "ok":
      return "No handoff action needed yet.";
    case "stale":
      return "Usage data is stale because the 5-hour reset time has passed. Send one short Claude Code prompt to refresh statusLine usage before testing handoff.";
    default:
      return "Usage data unavailable. Use Claude Code until the statusLine guard updates usage-state.json.";
  }
}

export function toHomeRelative(filePath, homeDir = defaultPaths().homeDir) {
  const resolvedHome = path.resolve(homeDir);
  const resolvedFile = path.resolve(filePath);
  const relative = path.relative(resolvedHome, resolvedFile);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join("/")}`;
  }
  return filePath;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// A handoff file_name must name a single file: no directory separators and not a
// traversal token. Otherwise a value like "../../../.ssh/id_rsa" would escape
// <storage>/<projectId>/ once path.join'd and turn `ccg resume` into an
// arbitrary-file read. Anything unsafe degrades to the default file name.
function isSafeHandoffFileName(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return name === path.basename(name);
}

// handoff.storage_dir and handoff.file_name decide which files `ccg resume` reads
// and prints, so they are honored only from the user-owned global config, never
// from a project's .claude-cache-guard.json. A cloned repo could otherwise ship
// overrides that relocate the storage dir (widening the resume fence so an
// out-of-storage handoff.file passes) or smuggle a path-traversal file_name.
// Project scope may still override thresholds and actions.
function stripProjectHandoffPathOverrides(overrides) {
  if (!isPlainObject(overrides) || !isPlainObject(overrides.handoff)) return overrides;
  const handoff = { ...overrides.handoff };
  delete handoff.storage_dir;
  delete handoff.file_name;
  return { ...overrides, handoff };
}

// A hand-edited config may set the handoff subtree to null (still valid JSON) or
// drop storage_dir/file_name; deepMerge would then leave handoff === null and
// every `handoff.storage_dir` deref throws. Degrade to the safe defaults instead,
// keeping any other valid handoff fields untouched.
function normalizeHandoffConfig(config) {
  if (!isPlainObject(config)) {
    return { handoff: { ...DEFAULT_GLOBAL_CONFIG.handoff } };
  }
  const source = isPlainObject(config.handoff) ? config.handoff : {};
  const handoff = { ...DEFAULT_GLOBAL_CONFIG.handoff, ...source };
  if (!isNonEmptyString(handoff.storage_dir)) {
    handoff.storage_dir = DEFAULT_GLOBAL_CONFIG.handoff.storage_dir;
  }
  if (!isSafeHandoffFileName(handoff.file_name)) {
    handoff.file_name = DEFAULT_GLOBAL_CONFIG.handoff.file_name;
  }
  const result = { ...config };
  result.handoff = handoff;
  return result;
}

// Defense in depth: trust a persisted handoff.file only when it resolves inside
// the configured storage dir. A locally-writable .claude-cache-guard.json could
// otherwise point handoff.file at ~/.ssh/id_rsa and have `ccg resume` print it
// into the conversation. The fence base (storageDir) comes from the global config
// only — project overrides for it are stripped upstream — so it can't be widened
// to whitelist the secret. Falls back to the storage-derived path when out of fence.
function resolveFencedHandoffPath({ configuredFile, homeDir, cwd, storageDir, fileName }) {
  const fallbackPath = getHandoffPaths({ homeDir, cwd, storageDir, fileName }).handoffPath;
  if (!isNonEmptyString(configuredFile)) return fallbackPath;
  const resolvedHomeDir = defaultPaths(homeDir).homeDir;
  const expandedFile = expandHome(configuredFile, resolvedHomeDir);
  const expandedStorageDir = expandHome(storageDir, resolvedHomeDir);
  return isPathWithin(expandedStorageDir, expandedFile) ? expandedFile : fallbackPath;
}

// True only when targetPath is a strict descendant of containerDir. Both sides are
// realpath-resolved (deepest existing ancestor) so a symlinked directory can't
// smuggle a path out of the storage dir.
function isPathWithin(containerDir, targetPath) {
  const container = realpathBestEffort(path.resolve(containerDir));
  const target = realpathBestEffort(path.resolve(targetPath));
  const relative = path.relative(container, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// realpath the deepest existing ancestor and re-join the missing tail, so a
// not-yet-created handoff file still resolves while symlinked ancestors are followed.
function realpathBestEffort(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    const parent = path.dirname(targetPath);
    if (parent === targetPath) return targetPath;
    return path.join(realpathBestEffort(parent), path.basename(targetPath));
  }
}

function deepMerge(base, override) {
  if (!isPlainObject(base)) return cloneValue(override);
  const result = cloneValue(base);
  if (!isPlainObject(override)) return result;
  for (const [key, value] of Object.entries(override)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = cloneValue(value);
    }
  }
  return result;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isLegacyInstallMetadata(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.managed_by === "claude-cache-guard" &&
      !value.thresholds &&
      !value.handoff &&
      !value.version
  );
}

function removeRetiredConfigFields(config) {
  const next = mergeConfig(config);
  let changed = false;
  if (next.thresholds && typeof next.thresholds === "object" && "five_hour_critical" in next.thresholds) {
    delete next.thresholds.five_hour_critical;
    changed = true;
  }
  if (next.actions && typeof next.actions === "object" && "on_critical" in next.actions) {
    delete next.actions.on_critical;
    changed = true;
  }
  return changed ? next : config;
}

async function removeProjectHandoff({ handoffPath, projectIds }) {
  // only delete if parent dir matches a known project id
  if (!handoffPath || !projectIds.includes(path.basename(path.dirname(handoffPath)))) {
    return { removedFile: false, removedDir: false, dirNotEmpty: false, guarded: true };
  }
  const removedFile = await removeFileIfExists(handoffPath);
  let removedDir = false;
  let dirNotEmpty = false;
  try {
    await fs.promises.rmdir(path.dirname(handoffPath));
    removedDir = true;
  } catch (error) {
    if (error?.code === "ENOTEMPTY") {
      // The handoff file was deleted, but the storage dir still holds other
      // files (e.g. enable --force's .before-force.*.bak). Report it so the
      // caller can tell the user the dir was kept instead of dropping it silently.
      dirNotEmpty = removedFile;
    } else if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return { removedFile, removedDir, dirNotEmpty, guarded: false };
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

async function lstatIfExists(targetPath) {
  try {
    return await fs.promises.lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
