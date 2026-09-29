import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import * as nativeStatus from '../../src/commands/status-v6.js';
import { prepareRecovery, executeRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import { targetsSet } from '../../src/commands/targets-command.js';
import { createEmptyPreferences, resolvePreferencesPath } from '../../src/intent/deployment-preferences.js';
import { resolveIntentPath } from '../../src/intent/intent-store.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { checkRecovery, readRecoveryStatus } from '../../src/recovery/status.js';
import { readDemand } from '../../src/recovery/demand.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';

import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

type Agent = 'codex' | 'claude-code' | 'cursor';

async function fixture(plugins: Array<{
  name: string;
  dependencies?: string[];
  native?: boolean;
  nativeArtifactOnly?: boolean;
  nativeSkill?: string;
  portableSkill?: string;
  portableCodexSwitch?: boolean;
  configurable?: boolean;
}>) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = path.join(isolation.layout.fixtureCwd, 'recovery-project');
  const sourceRoot = path.join(isolation.layout.fixtureCwd, 'recovery-source');
  await fs.ensureDir(cwd);
  await git(cwd, ['init', '--quiet']);
  for (const plugin of plugins) {
    const portableSkill = plugin.portableSkill ?? plugin.name;
    const skill = path.join(sourceRoot, 'plugins', plugin.name, 'agent-skills', 'skills', portableSkill);
    await fs.outputFile(path.join(skill, 'SKILL.md'),
      `---\nname: ${portableSkill}\ndescription: ${portableSkill} fixture\n---\n${portableSkill}\n`);
    await fs.outputFile(path.join(skill, 'README.md'), `# ${plugin.name}\n`);
    if (plugin.native && !plugin.nativeArtifactOnly && !plugin.nativeSkill) await fs.outputFile(path.join(sourceRoot, 'plugins', plugin.name, 'skills', plugin.name, 'SKILL.md'),
      `---\nname: ${plugin.name}\ndescription: Native fixture\n---\nNative.\n`);
    if (plugin.nativeSkill) await fs.outputFile(path.join(sourceRoot, 'plugins', plugin.name, 'scripts', 'render.mjs'), [
      'import { readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      `console.log(JSON.stringify({ version: 2, artifacts: [{ id: "dynamic-skill", kind: "skill", platform: context.platform, target: "codex.skill", state: "present", refreshKeys: [], skillKey: ${JSON.stringify(plugin.nativeSkill)}, content: { files: { "SKILL.md": ${JSON.stringify(`---\nname: ${plugin.nativeSkill}\ndescription: Native fixture\n---\nNative.\n`)}, "README.md": "Native.\\n", "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n" } } }] }));`,
    ].join('\n'));
  }
  await createDependencyCatalogSnapshotFixture(sourceRoot, plugins.map((plugin) => ({
    name: plugin.name,
    ...(plugin.dependencies ? { dependencies: plugin.dependencies } : {}),
    configureManifest: (manifest) => {
      manifest.distributions = { agentSkills: { skills: './agent-skills/skills' } };
      if (plugin.portableCodexSwitch) {
        manifest.extensions!.instructions![0]!.agentOverrides = { codex: null };
      }
      if (!plugin.native) manifest.marketplace.policy.products = plugin.portableCodexSwitch
        ? ['CODEX', 'CLAUDE'] : ['CODEX'];
      if (plugin.native) manifest.extensions = {
        instructions: [{ name: 'native', title: 'Native', content: 'Native.' }],
      };
      if (plugin.native && !plugin.nativeArtifactOnly && !plugin.nativeSkill) manifest.skills = './skills';
      if (plugin.nativeSkill) {
        manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
        manifest.artifacts = { targets: [{ id: 'dynamic-skill', platform: 'codex', scopes: ['project'],
          target: 'codex.skill', delivery: { mode: 'aw-extension' }, states: ['present'], refreshKeys: [], skillKey: plugin.nativeSkill }] };
      }
      if (plugin.configurable) manifest.config = { fields: { mode: { type: 'string' } } };
    },
  })));
  const entries = [];
  for (const plugin of plugins) {
    const pluginRoot = path.join(sourceRoot, 'plugins', plugin.name);
    const manifest = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    await fs.outputJson(path.join(pluginRoot, 'agent-skills', 'skills', plugin.portableSkill ?? plugin.name, 'aw-plugin-requirements.json'),
      createAwPluginRequirementsReceipt({ name: plugin.name, version: '1.0.0' },
        manifest.manifest.requires?.aw.capabilities ?? []));
    entries.push(await createCatalogManifestV7Entry(manifest, pluginRoot));
  }
  const catalogPath = path.join(sourceRoot, 'catalog-manifest.json');
  await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries });
  const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
    expectedDigest: snapshot.digest, env: isolation.env,
  });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
  const generated = await fs.readJson(path.join(sourceRoot, '.aw-generated.json')) as { workspaceIdentity: string };
  const intentPath = await resolveIntentPath({ scope: 'project', cwd });
  const intent = {
    schemaVersion: 3, kind: 'aw-plugin-intents',
    sources: { team: { logicalIdentity: generated.workspaceIdentity } },
    roots: plugins.filter((plugin) => plugin.name !== 'shared').map((plugin) => ({ pluginId: `team/${plugin.name}` })),
  };
  await fs.outputFile(intentPath, `  ${JSON.stringify(intent, null, 2)}\n`);
  const bin = path.join(isolation.layout.fixtureCwd, 'fake-skills-bin');
  const log = path.join(isolation.layout.fixtureCwd, 'skills-calls.jsonl');
  await fs.ensureDir(bin);
  await fs.writeFile(path.join(bin, 'skills'), `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const cwd = process.cwd();
fs.appendFileSync(process.env.RECOVERY_SKILLS_LOG, JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log('1.5.23'); process.exit(0); }
let lock = {version:1,skills:{}};
try { lock=JSON.parse(fs.readFileSync(path.join(cwd,'skills-lock.json'))); } catch {}
if (args[0] === 'list') {
 const rows = [];
 const queried=args.includes('--agent')?args[args.indexOf('--agent')+1]:null;
 for (const name of Object.keys(lock.skills)) {
  const shared=path.join(cwd,'.agents','skills',name);
  const claude=path.join(cwd,'.claude','skills',name);
  const dest=queried==='claude-code'?claude:queried?shared:fs.existsSync(shared)?shared:claude;
  const agents=[...(fs.existsSync(shared)&&queried!=='claude-code'?['Codex','Cursor']:[]),...(fs.existsSync(claude)&&(!queried||queried==='claude-code')?['Claude Code']:[])];
  if (fs.existsSync(dest)) rows.push({name,path:dest,scope:'project',agents,source:lock.skills[name].source});
 }
 console.log(JSON.stringify(rows)); process.exit(0);
}
if (args[0] === 'add') {
 const source=args[1], name=args[args.indexOf('--skill')+1], agent=args[args.indexOf('--agent')+1];
if (process.env.RECOVERY_FAIL_SKILL === name) {
 if (process.env.RECOVERY_BAD_LOCK_ON_FAIL_SKILL) fs.writeFileSync(path.join(cwd,'skills-lock.json'),'{broken');
 process.exit(2);
}
 const dest=path.join(cwd,agent==='claude-code'?'.claude':'.agents','skills',name);
 fs.mkdirSync(path.dirname(dest),{recursive:true});
 if (process.env.RECOVERY_PARTIAL_SKILL === name) {
  fs.rmSync(dest,{recursive:true,force:true});
  fs.mkdirSync(dest,{recursive:true});
  fs.copyFileSync(path.join(source,'skills',name,'SKILL.md'),path.join(dest,'SKILL.md')); process.exit(2);
 }
 fs.cpSync(path.join(source,'skills',name),dest,{recursive:true});
 lock.skills[name]={source,sourceType:'local',computedHash:'fixture'};
 fs.writeFileSync(path.join(cwd,'skills-lock.json'),JSON.stringify(lock));
 process.exit(process.env.RECOVERY_FAIL_AFTER_COPY_SKILL === name ? 2 : 0);
}
process.exit(2);
`);
  await fs.chmod(path.join(bin, 'skills'), 0o755);
  const env = { ...isolation.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RECOVERY_SKILLS_LOG: log };
  return { cwd, sourceRoot, intentPath, log, env,
    options: (targets?: Agent[]) => ({ scope: 'project' as const, cwd, env,
      cliVersion: '1.0.0', ...(targets ? { targets } : {}), all: true, yes: true }),
  };
}

async function addCalls(log: string): Promise<string[][]> {
  if (!await fs.pathExists(log)) return [];
  return (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as string[]).filter((args) => args[0] === 'add');
}

describe('scoped recovery integration', () => {
  it('passes selected roots to Native status so an unrelated inventory error cannot fail User --check', async () => {
    const setup = await fixture([{ name: 'alpha', native: true }, { name: 'beta', native: true }]);
    await writeIntentFixture({ scope: 'user', cwd: setup.cwd, env: setup.env }, {
      roots: [{ pluginId: 'team/alpha' }, { pluginId: 'team/beta' }], agents: ['claude-code'],
    });
    const native = vi.spyOn(nativeStatus, 'statusCommandV8').mockImplementation(async (input) => ({
      payload: { schemaVersion: 8, catalog: { primarySourceId: 'team', configDigest: 'config',
        compositeDigest: 'catalog', sources: [] },
      filters: { plugins: input.plugins ?? [], platform: 'both', cwd: input.cwd }, targets: [],
      errors: input.plugins?.includes('team/beta') || !input.plugins
        ? [{ code: 'stateInventoryFailed', message: 'beta inventory unreadable' }] : [] },
      nativeObservations: [{ pluginId: 'team/alpha', platform: 'claude', content: 'satisfied', blockers: [] }],
      nativeExtraObserved: [],
    }) as never);
    try {
      const options = { scope: 'user' as const, cwd: setup.cwd, env: setup.env, targets: ['claude-code'] };
      expect((await checkRecovery(['team/alpha'], options)).ok).toBe(true);
      expect(native).toHaveBeenCalledWith(expect.objectContaining({ plugins: ['team/alpha'] }));
      expect((await checkRecovery([], { ...options, all: true })).errors)
        .toContainEqual(expect.objectContaining({ code: 'stateInventoryFailed' }));
    } finally { native.mockRestore(); }
  });
  it.each([false, true])('limits User sync --check observation errors to selected roots and dependencies (dependency=%s)', async (dependsOnBeta) => {
    const setup = await fixture([{ name: 'alpha', native: true,
      ...(dependsOnBeta ? { dependencies: ['beta'] } : {}) }, { name: 'beta', native: true }]);
    await writeIntentFixture({ scope: 'user', cwd: setup.cwd, env: setup.env }, {
      roots: [{ pluginId: 'team/alpha' }, { pluginId: 'team/beta' }], agents: ['claude-code'],
    });
    const options = { scope: 'user' as const, cwd: setup.cwd, env: setup.env,
      targets: ['claude-code'], nativeObservations: [{ pluginId: 'team/alpha', platform: 'claude' as const,
        content: 'satisfied' as const, blockers: [] }] };
    const alpha = await checkRecovery(['team/alpha'], options);
    expect(alpha.requestedRoots).toEqual(['team/alpha']);
    expect(alpha.errors.map((error) => error.pluginId)).toEqual(dependsOnBeta ? ['team/beta'] : []);
    expect(alpha.ok).toBe(!dependsOnBeta);
    expect((await checkRecovery(['team/beta'], options)).ok).toBe(false);
    expect((await checkRecovery([], { ...options, all: true })).ok).toBe(false);
  });
  // Test Value Gate: unreadable demand and a missing Agent selection must never appear as an empty success.
  it('keeps no-target, empty and invalid declarations distinct', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    const before = await fs.readFile(setup.intentPath);
    const missing = await runRecovery('sync', [], setup.options());
    expect(missing).toMatchObject({ kind: 'aw-recovery', scope: 'project', ok: false,
      intent: { roots: ['team/alpha'] }, requestedRoots: ['team/alpha'] });
    expect(missing.blockers.map((entry) => entry.code)).toContain('localTargetsRequired');
    expect(await fs.readFile(setup.intentPath)).toEqual(before);

    await fs.writeJson(setup.intentPath, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    expect(await runRecovery('sync', [], setup.options())).toMatchObject({
      ok: true, requestedRoots: [], targetResults: [],
    });
    await fs.writeFile(setup.intentPath, '{broken');
    const invalid = await runRecovery('sync', [], setup.options());
    expect(invalid).toMatchObject({ ok: false, intent: { state: 'invalid', roots: null } });
    expect(invalid.blockers.map((entry) => entry.code)).toContain('pluginIntentStateInvalid');
    expect(await addCalls(setup.log)).toEqual([]);
  });

  // Test Value Gate: Native failure cannot silently install a Portable copy.
  it('retains Native delivery when the Native tool fails', async () => {
    const setup = await fixture([{ name: 'alpha', native: true }]);
    const nativeCliRunner = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'failed' }));
    const result = await runRecovery('sync', [], setup.options(['codex']), {
      nativeCliRunner, codexManagerResolver: async () => { throw new Error('native-fixture-failure'); },
    });
    expect(result.targetResults).toEqual([expect.objectContaining({
      pluginId: 'team/alpha', agent: 'codex', delivery: { kind: 'native', platform: 'codex' },
    })]);
    expect(result.ok).toBe(false);
    expect(await addCalls(setup.log)).toEqual([]);
  });

  // Test Value Gate: Portable cleanup remains unsupported unless live ownership proves a historical Native output.
  it('does not invent historical Native cleanup for a pure Portable target', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    const pluginRoot = path.join(setup.sourceRoot, 'plugins', 'alpha');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const rawManifest = await fs.readJson(manifestPath) as Record<string, unknown>;
    rawManifest.slashCommands = './commands';
    await fs.writeJson(manifestPath, rawManifest);
    await fs.outputFile(path.join(pluginRoot, 'commands', 'portable-only.md'), '# Portable-only fixture\n');
    const catalogPath = path.join(setup.sourceRoot, 'catalog-manifest.json');
    const catalog = await fs.readJson(catalogPath) as Record<string, unknown>;
    const updatedManifest = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    await fs.writeJson(catalogPath, {
      ...catalog,
      entries: [await createCatalogManifestV7Entry(updatedManifest, pluginRoot)],
    });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: setup.env,
      impactConfirmed: true });

    const result = await runRecovery('cleanup', ['team/alpha'], {
      ...setup.options(['codex']), all: false,
    }, { nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }) });

    expect(result.targetResults).toEqual([expect.objectContaining({
      pluginId: 'team/alpha', agent: 'codex', delivery: expect.objectContaining({ kind: 'agent-skills' }),
    })]);
    expect(result.targetResults[0]?.blockers.map((entry) => entry.code))
      .toContain('backend-action-unsupported');
    expect(await addCalls(setup.log)).toEqual([]);
  });

  // Test Value Gate: a delivery switch must not install Portable while an owned Native output still exists.
  it('blocks Native-to-Portable recovery until the historical Native output is cleaned', async () => {
    const setup = await fixture([{ name: 'alpha', native: true, nativeArtifactOnly: true }]);
    const nativeRuntime = {
      nativeCliRunner: async (invocation: { args: string[] }) => invocation.args.includes('--version')
        ? { exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }
        : invocation.args.includes('--json')
          ? { exitCode: 0, stdout: JSON.stringify({ installed: [], available: [] }), stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
      codexManagerResolver: async () => ({
        kind: 'system' as const, version: '0.200.0', command: 'codex', argsPrefix: [] as string[],
      }),
    };
    const installed = await runRecovery('sync', [], setup.options(['codex']), nativeRuntime);
    expect(installed.ok, JSON.stringify(installed)).toBe(true);

    const pluginRoot = path.join(setup.sourceRoot, 'plugins', 'alpha');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const rawManifest = await fs.readJson(manifestPath) as Record<string, unknown>;
    delete rawManifest.extensions;
    delete rawManifest.skills;
    rawManifest.slashCommands = './commands';
    await fs.writeJson(manifestPath, rawManifest);
    await fs.outputFile(path.join(pluginRoot, 'commands', 'portable-switch.md'), '# Portable switch fixture\n');
    await fs.outputFile(path.join(pluginRoot, 'codex', 'skills', 'portable-switch', 'SKILL.md'),
      '---\nname: portable-switch\ndescription: Portable switch fixture\n---\nFixture.\n');
    await fs.outputFile(path.join(pluginRoot, 'claude', 'commands', 'portable-switch.md'),
      '# Portable switch fixture\n');
    const codexProjectionPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    await fs.writeJson(codexProjectionPath, { ...await fs.readJson(codexProjectionPath), skills: './codex/skills' });
    const claudeProjectionPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    await fs.writeJson(claudeProjectionPath, { ...await fs.readJson(claudeProjectionPath), commands: './claude/commands' });
    const catalogPath = path.join(setup.sourceRoot, 'catalog-manifest.json');
    const catalog = await fs.readJson(catalogPath) as Record<string, unknown>;
    const updatedManifest = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    await fs.outputJson(path.join(pluginRoot, 'codex', 'skills', 'portable-switch', 'aw-plugin-requirements.json'),
      createAwPluginRequirementsReceipt({ name: 'alpha', version: '1.0.0' },
        updatedManifest.manifest.requires?.aw.capabilities ?? []));
    await fs.writeJson(catalogPath, {
      ...catalog,
      entries: [await createCatalogManifestV7Entry(updatedManifest, pluginRoot)],
    });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: setup.env,
      impactConfirmed: true });

    const beforePortableWrites = await addCalls(setup.log);
    const blocked = await runRecovery('sync', [], setup.options(['codex']), nativeRuntime);
    expect(blocked.ok).toBe(false);
    expect(blocked.targetResults).toEqual([expect.objectContaining({
      pluginId: 'team/alpha', agent: 'codex', delivery: expect.objectContaining({ kind: 'agent-skills' }),
      execution: 'not-run',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'deliverySwitchCleanupRequired' })]),
    })]);
    expect(await addCalls(setup.log)).toEqual(beforePortableWrites);

    const cleanupPlan = await prepareRecovery('cleanup', ['team/alpha'], {
      ...setup.options(['codex']), all: false,
    }, nativeRuntime);
    const ownedPaths = cleanupPlan.nativeGroups.flatMap((group) => group.preview.operationPlan?.actions
      .filter((action) => action.kind === 'removeOwnedArtifact').map((action) => action.path) ?? []);
    expect(ownedPaths.length).toBeGreaterThan(0);
    const savedPaths = ownedPaths.map((_, index) => path.join(path.dirname(setup.cwd), 'saved-native', String(index)));
    for (const [index, ownedPath] of ownedPaths.entries()) await fs.copy(ownedPath, savedPaths[index]!);
    await cleanupPlan.context.dispose();

    const cleaned = await runRecovery('cleanup', ['team/alpha'], {
      ...setup.options(['codex']), all: false,
    }, nativeRuntime);
    expect(cleaned.ok, JSON.stringify(cleaned)).toBe(true);
    expect(cleaned.targetResults).toEqual([expect.objectContaining({
      pluginId: 'team/alpha', agent: 'codex', delivery: { kind: 'native', platform: 'codex' },
      blockers: [],
    })]);
    expect(await addCalls(setup.log)).toEqual(beforePortableWrites);

    const portablePlan = await prepareRecovery('sync', [], setup.options(['codex']), nativeRuntime);
    expect(portablePlan.receipt.targetResults[0]?.blockers).toEqual([]);
    for (const [index, ownedPath] of ownedPaths.entries()) await fs.copy(savedPaths[index]!, ownedPath);
    const stale = await executeRecovery(portablePlan);
    expect(stale.blockers.map((entry) => entry.code)).toContain('operationReviewStale');
    expect(stale.outputsMayHaveChanged).toBe(false);
    expect(await addCalls(setup.log)).toEqual(beforePortableWrites);

    expect((await targetsSet({ scope: 'project', cwd: setup.cwd, env: setup.env,
      agents: ['codex'] })).ok).toBe(true);
    const uninstalled = await runRecovery('uninstall', ['team/alpha'], {
      ...setup.options(), all: false,
    }, nativeRuntime);
    expect(uninstalled.ok, JSON.stringify(uninstalled)).toBe(true);
    expect(uninstalled.targetResults[0]).toMatchObject({
      delivery: { kind: 'native', platform: 'codex' }, execution: 'applied', blockers: [],
    });
  });

  // Test Value Gate: changing delivery must not install Native beside a separately located Portable Skill.
  it('blocks Portable-to-Native delivery until the old Portable output is moved', async () => {
    const setup = await fixture([{ name: 'alpha', portableCodexSwitch: true }]);
    const nativeRuntime = {
      nativeCliRunner: async (invocation: { args: string[] }) => invocation.args.includes('--version')
        ? { exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }
        : invocation.args.includes('--json')
          ? { exitCode: 0, stdout: JSON.stringify({ installed: [], available: [] }), stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
      codexManagerResolver: async () => ({
        kind: 'system' as const, version: '0.200.0', command: 'codex', argsPrefix: [] as string[],
      }),
    };
    const portable = await runRecovery('sync', [], setup.options(['codex']), nativeRuntime);
    expect(portable.ok, JSON.stringify(portable)).toBe(true);
    const portablePath = path.join(setup.cwd, '.agents', 'skills', 'alpha');
    expect(await fs.pathExists(portablePath)).toBe(true);

    const pluginRoot = path.join(setup.sourceRoot, 'plugins', 'alpha');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath) as {
      extensions: { instructions: Array<{ agentOverrides?: { codex: null } }> };
    };
    delete manifest.extensions.instructions[0]!.agentOverrides;
    await fs.writeJson(manifestPath, manifest);
    const catalogPath = path.join(setup.sourceRoot, 'catalog-manifest.json');
    const catalog = await fs.readJson(catalogPath) as Record<string, unknown>;
    await fs.writeJson(catalogPath, { ...catalog, entries: [
      await createCatalogManifestV7Entry(await readPluginManifest(pluginRoot, { mode: 'bundle' }), pluginRoot),
    ] });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: setup.env,
      impactConfirmed: true });

    const beforeWrites = await addCalls(setup.log);
    const blocked = await runRecovery('sync', [], setup.options(['codex']), nativeRuntime);
    expect(blocked).toMatchObject({ ok: false, outputsMayHaveChanged: false });
    expect(blocked.targetResults[0]).toMatchObject({
      delivery: { kind: 'native', platform: 'codex' }, execution: 'not-run',
    });
    expect(blocked.targetResults[0]?.blockers.map((entry) => entry.code))
      .toEqual(['deliverySwitchPortableCleanupRequired']);
    expect(await fs.pathExists(portablePath)).toBe(true);
    expect(await addCalls(setup.log)).toEqual(beforeWrites);

    const lockPath = path.join(setup.cwd, 'skills-lock.json');
    const lockBytes = await fs.readFile(lockPath);
    await fs.writeFile(lockPath, '{broken');
    const uncertain = await prepareRecovery('sync', [], setup.options(['codex']), nativeRuntime);
    expect(uncertain.receipt.targetResults[0]?.blockers.map((entry) => entry.code))
      .toContain('deliverySwitchPortableObservationFailed');
    await uncertain.context.dispose();
    await fs.writeFile(lockPath, lockBytes);

    await fs.move(portablePath, path.join(setup.cwd, 'saved-portable'));
    const unblocked = await prepareRecovery('sync', [], setup.options(['codex']), nativeRuntime);
    expect(unblocked.receipt.targetResults[0]?.blockers.map((entry) => entry.code))
      .not.toContain('deliverySwitchPortableCleanupRequired');
    const nativePaths = unblocked.nativeGroups.flatMap((group) =>
      group.preview.nativeFootprints?.map((footprint) => footprint.path) ?? []);
    expect(nativePaths.length).toBeGreaterThan(0);
    expect(nativePaths).not.toContain(portablePath);
    await fs.move(path.join(setup.cwd, 'saved-portable'), portablePath);
    const stale = await executeRecovery(unblocked);
    expect(stale.blockers.map((entry) => entry.code)).toContain('operationReviewStale');
    expect(stale.outputsMayHaveChanged).toBe(false);
    await fs.move(portablePath, path.join(setup.cwd, 'saved-portable'));
    const recovered = await runRecovery('sync', [], setup.options(['codex']), nativeRuntime);
    expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
    expect(recovered.targetResults[0]).toMatchObject({
      delivery: { kind: 'native', platform: 'codex' }, blockers: [],
    });
  });

  // Test Value Gate: changed Review evidence prevents all backend writes.
  it.each(['intent', 'preferences', 'footprint'])('rejects changed %s after Review', async (change) => {
    const setup = await fixture([{ name: 'alpha' }]);
    const plan = await prepareRecovery('sync', [], setup.options(['cursor']));
    expect(plan.receipt.targetResults[0]?.blockers).toEqual([]);
    if (change === 'intent') await fs.appendFile(setup.intentPath, '\n');
    else if (change === 'preferences') {
      const filePath = await resolvePreferencesPath(setup.options());
      await fs.outputFile(filePath, JSON.stringify(createEmptyPreferences()));
    } else {
      await fs.outputFile(path.join(setup.cwd, '.agents', 'skills', 'alpha', 'SKILL.md'), 'foreign');
    }
    const result = await executeRecovery(plan);
    expect(result.blockers.map((entry) => entry.code)).toContain('operationReviewStale');
    expect(result.outputsMayHaveChanged).toBe(false);
    expect(await addCalls(setup.log)).toEqual([]);
  });

  it.each(['source-config', 'active', 'plugin-config'])(
    'rejects changed %s before the first backend write', async (change) => {
      const setup = await fixture([{ name: 'alpha', configurable: true }]);
      const plan = await prepareRecovery('sync', [], setup.options(['cursor']));
      expect(plan.receipt.targetResults[0]?.blockers).toEqual([]);
      if (change === 'source-config') {
        const snapshot = await readCatalogSourcesConfigSnapshot(setup.env);
        await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
          { id: 'team', type: 'path', primary: true, path: setup.sourceRoot, autoCheck: false },
        ] }, expectedDigest: snapshot.digest, env: setup.env });
      } else if (change === 'active') {
        const pluginRoot = path.join(setup.sourceRoot, 'plugins', 'alpha');
        await fs.writeFile(path.join(pluginRoot, 'README.md'), 'changed bundle\n');
        const manifestPath = path.join(setup.sourceRoot, 'catalog-manifest.json');
        const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
        await fs.writeJson(manifestPath, { ...manifest, entries: [
          await createCatalogManifestV7Entry(await readPluginManifest(pluginRoot, { mode: 'bundle' }), pluginRoot),
        ] });
        await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: setup.env,
          impactConfirmed: true });
      } else {
        const plugin = (await readDemand(setup.options(['cursor']))).roots?.[0]?.plugin;
        expect(plugin).toBeDefined();
        await writePluginConfigStore({ sourceId: 'team', sourceIdentity: plugin!.sourceIdentity,
          logicalIdentity: plugin!.catalogLogicalIdentity, pluginName: 'alpha', scope: 'project',
          cwd: setup.cwd, env: setup.env, values: { mode: 'second' } });
      }
      const result = await executeRecovery(plan);
      expect(result.blockers.map((entry) => entry.code)).toContain('operationReviewStale');
      expect(result.outputsMayHaveChanged).toBe(false);
      expect(await addCalls(setup.log)).toEqual([]);
    });

  // Test Value Gate: an unavailable source must not stop an independent source from recovering.
  it('keeps an independent success when refresh of another source fails', async () => {
    const setup = await fixture([{ name: 'alpha' }, { name: 'beta' }]);
    const offlineRoot = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'offline-source');
    await fs.copy(setup.sourceRoot, offlineRoot);
    const markerPath = path.join(offlineRoot, '.aw-generated.json');
    const marker = await fs.readJson(markerPath) as { workspaceIdentity: string };
    await fs.writeJson(markerPath, { ...marker, workspaceIdentity: 'fixture:offline-refresh' });
    const sourceConfig = await readCatalogSourcesConfigSnapshot(setup.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
      { id: 'team', type: 'path', primary: true, path: setup.sourceRoot },
      { id: 'offline', type: 'path', primary: false, path: offlineRoot },
    ] }, expectedDigest: sourceConfig.digest, env: setup.env });
    await syncCatalogSourceGeneration({ sourceId: 'offline', cliVersion: '1.0.0', env: setup.env });
    const intent = await fs.readJson(setup.intentPath) as {
      sources: Record<string, { logicalIdentity: string }>;
      roots: Array<{ pluginId: string }>;
    };
    intent.sources.offline = { logicalIdentity: 'fixture:offline-refresh' };
    intent.roots = [{ pluginId: 'team/alpha' }, { pluginId: 'offline/beta' }];
    await fs.writeJson(setup.intentPath, intent);
    const before = await fs.readFile(setup.intentPath);
    await fs.remove(offlineRoot);
    const result = await runRecovery('sync', [], { ...setup.options(['cursor']), refresh: true });
    expect(result.ok).toBe(false);
    expect(result.targetResults.find((target) => target.pluginId === 'offline/beta')?.blockers.length)
      .toBeGreaterThan(0);
    expect(result.targetResults.find((target) => target.pluginId === 'team/alpha')?.execution)
      .toBe('applied');
    expect(result.remainingTargets.map((target) => target.pluginId)).toContain('offline/beta');
    await expect(fs.pathExists(path.join(setup.cwd, '.agents', 'skills', 'alpha', 'SKILL.md')))
      .resolves.toBe(true);
    expect(await fs.readFile(setup.intentPath)).toEqual(before);
  });

  // Test Value Gate: exact retry pairs cannot turn into a Cartesian product of roots and Agents.
  it('runs only exact non-rectangular retry pairs and preserves declaration bytes', async () => {
    const setup = await fixture([{ name: 'alpha' }, { name: 'beta' }]);
    const before = await fs.readFile(setup.intentPath);
    const result = await runRecovery('sync', [], {
      ...setup.options(['cursor', 'claude-code']), exactTargets: [
        { pluginId: 'team/alpha', agent: 'cursor' },
        { pluginId: 'team/beta', agent: 'claude-code' },
      ],
    });
    expect(result.targetResults.map(({ pluginId, agent }) => [pluginId, agent])).toEqual([
      ['team/alpha', 'cursor'], ['team/beta', 'claude-code'],
    ]);
    expect((await addCalls(setup.log)).map((args) => [
      args[args.indexOf('--skill') + 1], args[args.indexOf('--agent') + 1],
    ])).toEqual([['alpha', 'cursor'], ['beta', 'claude-code']]);
    expect(await fs.readFile(setup.intentPath)).toEqual(before);
  });

  it('rejects an exact retry pair outside the selected roots before output writes', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    const before = await fs.readFile(setup.intentPath);
    const result = await runRecovery('sync', [], {
      ...setup.options(['cursor']), exactTargets: [{ pluginId: 'team/misspelled', agent: 'cursor' }],
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((entry) => entry.code)).toContain('invalidExactTargets');
    expect(result.outputsMayHaveChanged).toBe(false);
    expect(await fs.readFile(setup.intentPath)).toEqual(before);
    expect(await addCalls(setup.log)).toEqual([]);
  });

  // Test Value Gate: local Agent preferences cannot rewrite shared intent or delete another Agent's output.
  it('keeps shared bytes and prior output when local Agent selection changes', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    const before = await fs.readFile(setup.intentPath);
    expect((await targetsSet({ scope: 'project', cwd: setup.cwd, env: setup.env,
      agents: ['cursor'] })).ok).toBe(true);
    expect((await runRecovery('sync', [], setup.options())).ok).toBe(true);
    const cursorSkill = path.join(setup.cwd, '.agents', 'skills', 'alpha', 'SKILL.md');
    const cursorBytes = await fs.readFile(cursorSkill);
    expect((await targetsSet({ scope: 'project', cwd: setup.cwd, env: setup.env,
      agents: ['claude-code'] })).ok).toBe(true);
    const second = await runRecovery('sync', [], setup.options());
    expect(second.selection.agents).toEqual(['claude-code']);
    expect(second.ok).toBe(true);
    expect(await fs.readFile(cursorSkill)).toEqual(cursorBytes);
    expect(await fs.readFile(setup.intentPath)).toEqual(before);
  });

  // Test Value Gate: a failed install still records its verified declaration; preparation alone is read-only.
  it('keeps a new root after no-target and failed install', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    const installOptions = { ...setup.options(), all: false };
    await fs.remove(setup.intentPath);
    const planned = await prepareRecovery('install', ['team/alpha'], {
      ...installOptions, targets: ['cursor'],
    });
    expect(planned.declaration).toEqual(['team/alpha']);
    expect(await fs.pathExists(setup.intentPath)).toBe(false);
    await planned.context.dispose();
    const noTarget = await runRecovery('install', ['team/alpha'], installOptions);
    expect(noTarget.blockers.map((entry) => entry.code)).toContain('localTargetsRequired');
    expect(noTarget.declarationChanged).toBe(true);
    expect((await fs.readJson(setup.intentPath)).roots).toEqual([{ pluginId: 'team/alpha' }]);
    await fs.remove(setup.intentPath);
    const failed = await runRecovery('install', ['team/alpha'], {
      ...installOptions, targets: ['cursor'], env: { ...setup.env, RECOVERY_FAIL_SKILL: 'alpha' },
    });
    expect(failed.ok).toBe(false);
    expect(failed.declarationChanged).toBe(true);
    expect((await fs.readJson(setup.intentPath)).roots).toEqual([{ pluginId: 'team/alpha' }]);
  });

  // Test Value Gate: a known missing postcheck remains distinct from a failed global observation.
  it('reports a failed Portable postcheck as missing only when the provider lock stays readable', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    const options = setup.options(['cursor']);
    const knownMissing = await runRecovery('sync', [], { ...options,
      env: { ...setup.env, RECOVERY_FAIL_SKILL: 'alpha' },
    });
    expect(knownMissing.targetResults).toEqual([expect.objectContaining({
      pluginId: 'team/alpha', agent: 'cursor', execution: 'failed',
      content: 'absent', observation: 'missing',
    })]);

    const unreadable = await runRecovery('sync', [], { ...options,
      env: { ...setup.env, RECOVERY_FAIL_SKILL: 'alpha', RECOVERY_BAD_LOCK_ON_FAIL_SKILL: '1' },
    });
    expect(unreadable.targetResults).toEqual([expect.objectContaining({
      pluginId: 'team/alpha', agent: 'cursor', observation: 'unknown',
    })]);
    expect(unreadable.targetResults[0]?.blockers.map((entry) => entry.code))
      .toContain('portableProviderLockInvalid');
  });

  // Test Value Gate: all equivalent paths to one repo must show the same Portable status without writes.
  it('observes one satisfied target from root, subdirectory and alias', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    await targetsSet({ scope: 'project', cwd: setup.cwd, env: setup.env, agents: ['cursor'] });
    expect((await runRecovery('sync', [], setup.options())).ok).toBe(true);
    const subdirectory = path.join(setup.cwd, 'src');
    const alias = path.join(path.dirname(setup.cwd), 'recovery-project-alias');
    await fs.ensureDir(subdirectory);
    await fs.symlink(setup.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const intentBytes = await fs.readFile(setup.intentPath);
    const writes = await addCalls(setup.log);
    const statuses = [];
    for (const cwd of [setup.cwd, subdirectory, alias]) {
      statuses.push(await readRecoveryStatus({ scope: 'project', cwd, env: setup.env,
        cliVersion: '1.0.0', nativeObservations: [] }));
    }
    for (const status of statuses) expect(status).toMatchObject({
      schemaVersion: 1, kind: 'aw-recovery-status', scope: 'project', ok: true,
      allSatisfied: true, errors: [], inventory: [{ pluginId: 'team/alpha', targetResults: [{
        agent: 'cursor', content: 'satisfied', observation: 'verified', blockers: [],
      }] }],
    });
    expect(statuses[1]).toEqual(statuses[0]);
    expect(statuses[2]).toEqual(statuses[0]);
    expect(await addCalls(setup.log)).toEqual(writes);
    expect(await fs.readFile(setup.intentPath)).toEqual(intentBytes);
  });
});
