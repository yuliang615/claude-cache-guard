import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveEffectiveConfig,
  enableProject,
  disableProject,
  getProjectState,
  getProjectConfigPath,
  thresholdOptionsFromConfig,
  handoffModeFromConfig
} from "../src/config.js";
import { getHandoffPaths } from "../src/handoff.js";

function tempDir(prefix = "ccg-config-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// realpath so macOS /var -> /private/var symlinks don't skew path comparisons.
function makeHome() {
  return fs.realpathSync(tempDir("ccg-config-home-"));
}

function makeProject(name = "proj") {
  const parent = tempDir("ccg-config-proj-");
  const cwd = path.join(parent, name);
  fs.mkdirSync(cwd, { recursive: true });
  return fs.realpathSync(cwd);
}

function writeProjectConfig(cwd, config) {
  fs.writeFileSync(getProjectConfigPath(cwd), JSON.stringify(config));
}

function readProjectConfigRaw(cwd) {
  return JSON.parse(fs.readFileSync(getProjectConfigPath(cwd), "utf8"));
}

// Is target a strict descendant of <home>/.claude/next-session? String-based so
// it also holds after removeHandoff deletes the target (home is already realpath'd).
function isWithinStorage(home, target) {
  const storage = fs.realpathSync(path.join(home, ".claude", "next-session"));
  const rel = path.relative(storage, path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// BUG-09: a hand-edited null handoff subtree must degrade to safe defaults
// ---------------------------------------------------------------------------

test("BUG-09: resolveEffectiveConfig degrades a null handoff subtree to safe defaults", async () => {
  const home = makeHome();
  const cwd = makeProject("null-handoff");
  writeProjectConfig(cwd, { overrides: { handoff: null } });

  const effective = await resolveEffectiveConfig({ homeDir: home, cwd });
  assert.ok(effective.handoff && typeof effective.handoff === "object");
  assert.notEqual(effective.handoff, null);
  assert.equal(typeof effective.handoff.storage_dir, "string");
  assert.ok(effective.handoff.storage_dir.length > 0);
  assert.equal(effective.handoff.file_name, "next_session.md");
  // The deref that previously threw TypeError must now be safe.
  assert.doesNotThrow(() => `${effective.handoff.storage_dir}/${effective.handoff.file_name}`);
});

test("BUG-09: enableProject and disableProject survive a null handoff subtree without throwing", async () => {
  const home = makeHome();
  const cwd = makeProject("null-handoff-lifecycle");
  writeProjectConfig(cwd, { overrides: { handoff: null } });

  const enabled = await enableProject({ homeDir: home, cwd });
  assert.ok(enabled.handoffPath.length > 0);
  assert.equal(fs.existsSync(enabled.handoffPath), true);
  assert.equal(isWithinStorage(home, enabled.handoffPath), true);

  const state = await getProjectState({ homeDir: home, cwd });
  assert.equal(state.enabled, true);
  assert.equal(typeof state.effectiveConfig.handoff.storage_dir, "string");

  const disabled = await disableProject({ homeDir: home, cwd, removeHandoff: true });
  assert.ok(disabled.handoffPath.length > 0);
  assert.equal(isWithinStorage(home, disabled.handoffPath), true);
});

test("BUG-09: null thresholds/actions and null storage_dir overrides never crash resolution", async () => {
  const overridesCases = [
    { thresholds: null },
    { actions: null },
    { handoff: { storage_dir: null } },
    { handoff: { file_name: null } }
  ];
  for (const overrides of overridesCases) {
    const home = makeHome();
    const cwd = makeProject("null-subtree");
    writeProjectConfig(cwd, { overrides });

    const effective = await resolveEffectiveConfig({ homeDir: home, cwd });
    // Downstream readers must not throw.
    assert.doesNotThrow(
      () => thresholdOptionsFromConfig(effective),
      `thresholdOptionsFromConfig threw for ${JSON.stringify(overrides)}`
    );
    assert.doesNotThrow(
      () => handoffModeFromConfig(effective),
      `handoffModeFromConfig threw for ${JSON.stringify(overrides)}`
    );
    // handoff subtree is always a usable object with safe strings.
    assert.equal(typeof effective.handoff.storage_dir, "string");
    assert.ok(effective.handoff.storage_dir.length > 0);
    assert.equal(typeof effective.handoff.file_name, "string");
    assert.ok(effective.handoff.file_name.length > 0);
    await assert.doesNotReject(
      getProjectState({ homeDir: home, cwd }),
      `getProjectState rejected for ${JSON.stringify(overrides)}`
    );
  }
});

// ---------------------------------------------------------------------------
// BUG-18: handoff.file must be fenced to the storage dir before it is read
// ---------------------------------------------------------------------------

test("BUG-18: getProjectState ignores a handoff.file pointing outside the storage dir", async () => {
  const home = makeHome();
  const cwd = makeProject("resume-fence");
  // A normal enable writes an in-fence handoff.file and a matching project_id.
  await enableProject({ homeDir: home, cwd });

  // Attacker with write access to .claude-cache-guard.json repoints only
  // handoff.file at an out-of-storage secret, keeping project_id intact so the
  // metadataMatchesCurrentProject guard is genuinely satisfied.
  const secretDir = tempDir("ccg-config-secret-");
  const secretPath = path.join(secretDir, "id_rsa");
  fs.writeFileSync(secretPath, "PRIVATE KEY MATERIAL");
  const config = readProjectConfigRaw(cwd);
  config.handoff.file = secretPath;
  writeProjectConfig(cwd, config);

  const expected = getHandoffPaths({ homeDir: home, cwd });
  const state = await getProjectState({ homeDir: home, cwd });

  // The only real guard is bypassed; the fence is what actually protects us.
  assert.equal(state.metadataMatchesCurrentProject, true);
  assert.notEqual(state.handoffPath, secretPath);
  assert.equal(state.handoffPath, expected.handoffPath);
  assert.equal(isWithinStorage(home, state.handoffPath), true);
});

test("BUG-18: a handoff.file symlinked out of storage is still fenced", async () => {
  const home = makeHome();
  const cwd = makeProject("resume-symlink");
  const enabled = await enableProject({ homeDir: home, cwd });

  // Plant a symlink INSIDE the storage dir that escapes to an external secret.
  const secretDir = tempDir("ccg-config-symsecret-");
  const secretPath = path.join(secretDir, "credentials");
  fs.writeFileSync(secretPath, "aws secret");
  const linkPath = path.join(path.dirname(enabled.handoffPath), "leak.md");
  fs.symlinkSync(secretPath, linkPath);

  const config = readProjectConfigRaw(cwd);
  config.handoff.file = linkPath; // path is textually "inside" storage, target isn't
  writeProjectConfig(cwd, config);

  const expected = getHandoffPaths({ homeDir: home, cwd });
  const state = await getProjectState({ homeDir: home, cwd });
  assert.notEqual(fs.realpathSync(state.handoffPath), secretPath);
  assert.equal(state.handoffPath, expected.handoffPath);
});

// The delete path is deliberately NOT fenced (see disableProject): it only removes
// and never prints content, so the real protection is removeProjectHandoff's
// basename(dirname) === project_id guard, which must refuse to delete an
// out-of-storage handoff.file even with --rmhandoff.
test("BUG-18: disableProject never deletes an out-of-storage handoff.file (delete guard holds)", async () => {
  const home = makeHome();
  const cwd = makeProject("disable-guard");
  await enableProject({ homeDir: home, cwd });

  const secretDir = tempDir("ccg-config-secret2-");
  const secretPath = path.join(secretDir, "credentials");
  fs.writeFileSync(secretPath, "aws secret");
  const config = readProjectConfigRaw(cwd);
  config.handoff.file = secretPath;
  writeProjectConfig(cwd, config);

  const result = await disableProject({ homeDir: home, cwd, removeHandoff: true });

  assert.equal(result.removedHandoffFile, false);
  assert.equal(result.skippedHandoffRemovalUnrecognized, true);
  assert.equal(fs.existsSync(secretPath), true); // out-of-storage secret untouched
});

test("BUG-18: an in-storage handoff.file is kept unchanged (legit path unaffected)", async () => {
  const home = makeHome();
  const cwd = makeProject("legit-file");
  const enabled = await enableProject({ homeDir: home, cwd });
  const expected = getHandoffPaths({ homeDir: home, cwd });

  const state = await getProjectState({ homeDir: home, cwd });
  assert.equal(state.handoffPath, expected.handoffPath);
  assert.equal(state.handoffPath, enabled.handoffPath);
  assert.equal(isWithinStorage(home, state.handoffPath), true);
  assert.equal(fs.existsSync(state.handoffPath), true);
});

// ---------------------------------------------------------------------------
// BUG-18b: the resume fence must survive a project config that also controls the
// fence's own inputs (storage_dir / file_name). A cloned repo shipping
// .claude-cache-guard.json could otherwise widen the fence or traverse out of it.
// ---------------------------------------------------------------------------

function writeGlobalConfig(home, config) {
  const bridgeDir = path.join(home, ".claude", "cache-guard");
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, "config.json"), JSON.stringify(config));
}

test("BUG-18b: a project override file_name traversal cannot escape the storage dir", async () => {
  const home = makeHome();
  const cwd = makeProject("filename-traversal");
  await enableProject({ homeDir: home, cwd });

  // Attacker repoints file_name via project overrides at a traversal that would
  // land on an out-of-storage secret once path.join'd.
  const config = readProjectConfigRaw(cwd);
  config.overrides = { ...(config.overrides ?? {}), handoff: { file_name: "../../../../../../etc/passwd" } };
  writeProjectConfig(cwd, config);

  const effective = await resolveEffectiveConfig({ homeDir: home, cwd });
  // Project scope may not set file_name at all; it falls back to the default.
  assert.equal(effective.handoff.file_name, "next_session.md");

  const state = await getProjectState({ homeDir: home, cwd });
  assert.equal(isWithinStorage(home, state.handoffPath), true);
  assert.equal(path.basename(state.handoffPath), "next_session.md");
});

test("BUG-18b: a project override storage_dir cannot widen the fence to whitelist a secret", async () => {
  const home = makeHome();
  const cwd = makeProject("storage-widen");
  await enableProject({ homeDir: home, cwd });

  // The secret sits under home but outside the real storage dir.
  const secretPath = path.join(home, "stolen.txt");
  fs.writeFileSync(secretPath, "PRIVATE KEY MATERIAL");

  // Attacker points handoff.file at the secret AND widens storage_dir to home so
  // the naive fence (isPathWithin(storage_dir, handoff.file)) would pass.
  const config = readProjectConfigRaw(cwd);
  config.handoff.file = secretPath;
  config.overrides = { ...(config.overrides ?? {}), handoff: { storage_dir: home } };
  writeProjectConfig(cwd, config);

  const state = await getProjectState({ homeDir: home, cwd });
  // storage_dir override is ignored, so the fence base stays the trusted default
  // and the out-of-storage secret is rejected.
  assert.notEqual(state.handoffPath, secretPath);
  assert.equal(isWithinStorage(home, state.handoffPath), true);
});

test("BUG-18b: getHandoffPaths contains a raw traversal file_name at the join site", async () => {
  const home = makeHome();
  const cwd = makeProject("raw-filename");
  await enableProject({ homeDir: home, cwd }); // materialize the storage dir for isWithinStorage
  const paths = getHandoffPaths({ homeDir: home, cwd, fileName: "../../../../../../etc/passwd" });
  assert.equal(path.basename(paths.handoffPath), "next_session.md");
  assert.equal(isWithinStorage(home, paths.handoffPath), true);
});

test("BUG-18b: a custom storage_dir / file_name in the GLOBAL config is still honored", async () => {
  const home = makeHome();
  const cwd = makeProject("global-custom");
  writeGlobalConfig(home, {
    version: 1,
    thresholds: { five_hour_warning: 90, seven_day_warning: null },
    handoff: { storage_dir: "~/.claude/custom-handoff", file_name: "handoff.md", mode: "manual", max_lines: 220 },
    actions: { on_warning: "auto_handoff" }
  });

  const effective = await resolveEffectiveConfig({ homeDir: home, cwd });
  assert.equal(effective.handoff.file_name, "handoff.md");
  assert.match(effective.handoff.storage_dir, /custom-handoff$/);

  const state = await getProjectState({ homeDir: home, cwd });
  const expected = getHandoffPaths({
    homeDir: home,
    cwd,
    storageDir: "~/.claude/custom-handoff",
    fileName: "handoff.md"
  });
  assert.equal(state.handoffPath, expected.handoffPath);
  assert.equal(path.basename(state.handoffPath), "handoff.md");
});
