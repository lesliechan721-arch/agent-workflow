import { writePluginIntentState, readPluginIntentState } from '../../src/utils/plugin-intent-state.js';
import { readProjectStatus } from '../../src/project/project-status.js';
import { statusCommandV8 } from '../../src/commands/status-v6.js';
import * as artifactRenderer from '../../src/utils/artifact-renderer.js';
import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { prepareProjectRecovery, executeProjectRecovery, runProjectRecovery } from '../../src/project/recovery.js';
import { projectTargetsSet } from '../../src/project/project-commands.js';
import { createEmptyProjectPreferences, resolveProjectPreferencesPath, writeProjectPreferences } from '../../src/project/project-preferences.js';
import { resolveProjectIntentPath } from '../../src/project/project-state.js';
import { readProjectDemand } from '../../src/project/project-demand.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolvePluginConfigStorePath, writePluginConfigStore } from '../../src/utils/plugin-config.js';

import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

type Agent = 'codex' | 'claude-code' | 'cursor';

async function fixture(plugins: Array<{
  name: string;
  dependencies?: string[];
  native?: boolean;
  nativeArtifactOnly?: boolean;
  nativeSkill?: string;
  portableSkill?: string;
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
      if (!plugin.native) manifest.marketplace.policy.products = ['CODEX'];
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
  const intentPath = resolveProjectIntentPath({ cwd });
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
 if (process.env.RECOVERY_FAIL_SKILL === name) process.exit(2);
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
    options: (targets?: Agent[]) => ({ cwd, env,
      cliVersion: '1.0.0', ...(targets ? { targets } : {}), all: true, yes: true }),
  };
}

async function addCalls(log: string): Promise<string[][]> {
  if (!await fs.pathExists(log)) return [];
  return (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as string[]).filter((args) => args[0] === 'add');
}

async function nativeRunnerForProject(cwd: string, env: NodeJS.ProcessEnv) {
  const projectRoot = await fs.realpath(cwd);
  const claudeHome = env.AW_CLAUDE_HOME!;
  const installedPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  const knownPath = path.join(claudeHome, 'plugins', 'known_marketplaces.json');
  return vi.fn(async (invocation: NativeCliInvocation) => {
    if (invocation.command !== 'claude') return { exitCode: 0,
      stdout: invocation.args.includes('--json') ? '{"installed":[],"available":[]}' : 'codex-cli 0.200.0', stderr: '' };
    const args = invocation.args;
    if (args[0] !== 'plugin') return { exitCode: 0, stdout: '2.1.88 (Claude Code)', stderr: '' };
    const scopeIndex = args.indexOf('--scope');
    const scope = scopeIndex === -1 ? 'user' : args[scopeIndex + 1]!;
    const settingsPath = scope === 'project' ? path.join(cwd, '.claude', 'settings.json')
      : path.join(claudeHome, 'settings.json');
    const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
    if (args[1] === 'marketplace' && args[2] === 'add') {
      const marketplaceRoot = args[3]!;
      const config = await fs.readJson(path.join(marketplaceRoot, 'config.json')) as { marketplaceName: string };
      await fs.outputJson(settingsPath, { ...settings, extraKnownMarketplaces: {
        ...((settings.extraKnownMarketplaces ?? {}) as Record<string, unknown>),
        [config.marketplaceName]: { source: { source: 'directory', path: marketplaceRoot } },
      } });
      const known = await fs.readJson(knownPath).catch(() => ({})) as Record<string, unknown>;
      await fs.outputJson(knownPath, { ...known, [config.marketplaceName]: {
        source: { source: 'directory', path: marketplaceRoot }, installLocation: marketplaceRoot,
      } });
    }
    if (args[1] === 'install' || args[1] === 'uninstall') {
      const pluginId = args[2]!;
      const enabled = { ...((settings.enabledPlugins ?? {}) as Record<string, unknown>) };
      if (args[1] === 'install') enabled[pluginId] = true;
      else delete enabled[pluginId];
      await fs.outputJson(settingsPath, { ...settings, enabledPlugins: enabled });
      const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} })) as {
        plugins?: Record<string, Array<Record<string, unknown>>>;
      };
      const plugins = { ...(installed.plugins ?? {}) };
      const records = [...(plugins[pluginId] ?? [])].filter((record) =>
        record.scope !== scope || (scope === 'project' && record.projectPath !== projectRoot));
      if (args[1] === 'install') records.push({ name: pluginId.slice(0, pluginId.lastIndexOf('@')),
        scope, ...(scope === 'project' ? { projectPath: projectRoot } : {}), version: '1.0.0' });
      if (records.length > 0) plugins[pluginId] = records;
      else delete plugins[pluginId];
      await fs.outputJson(installedPath, { plugins });
    }
    return { exitCode: 0, stdout: '2.1.88 (Claude Code)', stderr: '' };
  });
}

describe('unified project recovery', () => {
  // Test Value Gate: a declared root without a local Agent must remain actionable, while an empty project is a no-op.
  it('keeps no-target, empty and invalid declarations distinct', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    const before = await fs.readFile(setup.intentPath);
    const missing = await runProjectRecovery('sync', [], setup.options());
    expect(missing.blockers.map((entry) => entry.code)).toContain('localTargetsRequired');
    expect(missing.intent.roots).toEqual(['team/alpha']);
    expect(await fs.readFile(setup.intentPath)).toEqual(before);

    await fs.writeJson(setup.intentPath, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    const empty = await runProjectRecovery('sync', [], setup.options());
    expect(empty).toMatchObject({ ok: true, requestedRoots: [], targetResults: [] });
    await fs.writeFile(setup.intentPath, '{broken');
    const invalid = await runProjectRecovery('sync', [], setup.options());
    expect(invalid).toMatchObject({ ok: false, intent: { state: 'invalid', roots: null } });
    expect(invalid.blockers.map((entry) => entry.code)).toContain('pluginIntentStateInvalid');
    expect(await addCalls(setup.log)).toEqual([]);
  });

  // Test Value Gate: a selected Native delivery must never fall through to Portable after a Native failure.
  it('retains Native delivery when the Native tool fails', async () => {
    const setup = await fixture([{ name: 'alpha', native: true }]);
    const nativeCliRunner = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'failed' }));
    const result = await runProjectRecovery('sync', [], setup.options(['codex']), {
      nativeCliRunner, codexManagerResolver: async () => { throw new Error('native-fixture-failure'); },
    });
    expect(result.targetResults).toEqual([expect.objectContaining({
      pluginId: 'team/alpha', agent: 'codex', delivery: { kind: 'native', platform: 'codex' },
    })]);
    expect(result.ok, JSON.stringify(result, null, 2)).toBe(false);
    expect(await addCalls(setup.log)).toEqual([]);
  });

  // Test Value Gate: Review evidence must be checked before a backend writes output.
  it.each(['intent', 'preferences', 'footprint'])('rejects %s changed after Review without provider writes', async (change) => {
    const setup = await fixture([{ name: 'alpha' }]);
    const plan = await prepareProjectRecovery('sync', [], setup.options(['cursor']));
    expect(plan.receipt.targetResults[0]?.blockers).toEqual([]);
    if (change === 'intent') await fs.appendFile(setup.intentPath, '\n');
    else {
      if (change === 'preferences') {
        const preferencePath = await resolveProjectPreferencesPath({ cwd: setup.cwd, env: setup.env });
        await fs.outputFile(preferencePath, JSON.stringify(createEmptyProjectPreferences()));
      } else await fs.outputFile(path.join(setup.cwd, '.agents', 'skills', 'alpha', 'SKILL.md'), 'foreign');
    }
    const result = await executeProjectRecovery(plan);
    expect(result.blockers.map((entry) => entry.code)).toContain('operationReviewStale');
    expect(result.outputsMayHaveChanged).toBe(false);
    expect(await addCalls(setup.log)).toEqual([]);
  });

  // Test Value Gate: source and project config evidence can change after Review; no backend may write from the old plan.
  it.each(['source-config', 'active', 'plugin-config'])('rejects changed %s before the first write', async (change) => {
    const setup = await fixture([{ name: 'alpha', configurable: true }]);
    const plan = await prepareProjectRecovery('sync', [], setup.options(['cursor']));
    expect(plan.receipt.targetResults[0]?.blockers).toEqual([]);
    if (change === 'source-config') {
      const snapshot = await readCatalogSourcesConfigSnapshot(setup.env);
      await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
        { id: 'team', type: 'path', primary: true, path: setup.sourceRoot, autoCheck: false },
      ] },
        expectedDigest: snapshot.digest, env: setup.env });
    } else if (change === 'active') {
      const pluginRoot = path.join(setup.sourceRoot, 'plugins', 'alpha');
      await fs.writeFile(path.join(pluginRoot, 'README.md'), 'new catalog content\n');
      const manifestPath = path.join(setup.sourceRoot, 'catalog-manifest.json');
      const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
      await fs.writeJson(manifestPath, { ...manifest, entries: [
        await createCatalogManifestV7Entry(await readPluginManifest(pluginRoot, { mode: 'bundle' }), pluginRoot),
      ] });
      await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: setup.env,
        impactConfirmed: true });
    } else {
      const demand = await readProjectDemand(setup.options(['cursor']));
      const plugin = demand.roots?.[0]?.plugin;
      expect(plugin).toBeDefined();
      await writePluginConfigStore({ sourceId: 'team', sourceIdentity: plugin!.sourceIdentity,
        logicalIdentity: plugin!.catalogLogicalIdentity, pluginName: 'alpha', scope: 'project',
        cwd: setup.cwd, env: setup.env, values: { mode: 'second' } });
    }
    const result = await executeProjectRecovery(plan);
    expect(result.blockers.map((entry) => entry.code)).toContain('operationReviewStale');
    expect(result.outputsMayHaveChanged).toBe(false);
    expect(await addCalls(setup.log)).toEqual([]);
  });

  // Test Value Gate: retry pairs are exact; the cross-product must not install unrequested Agents.
  it('runs only exact non-rectangular retry pairs and preserves shared declaration bytes', async () => {
    const setup = await fixture([{ name: 'alpha' }, { name: 'beta' }]);
    const before = await fs.readFile(setup.intentPath);
    const result = await runProjectRecovery('sync', [], {
      ...setup.options(['cursor', 'claude-code']), exactTargets: [
        { pluginId: 'team/alpha', agent: 'cursor' },
        { pluginId: 'team/beta', agent: 'claude-code' },
      ],
    });
    expect(result.targetResults.map(({ pluginId, agent }) => [pluginId, agent])).toEqual([
      ['team/alpha', 'cursor'], ['team/beta', 'claude-code'],
    ]);
    expect((await addCalls(setup.log)).map((args) => [args[args.indexOf('--skill') + 1], args[args.indexOf('--agent') + 1]]))
      .toEqual([['alpha', 'cursor'], ['beta', 'claude-code']]);
    expect(await fs.readFile(setup.intentPath)).toEqual(before);
  });

  // Test Value Gate: a typo in exact retry pairs must not turn a requested root into a successful empty operation.
  it('rejects an exact retry pair outside the selected roots and Agents', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    const before = await fs.readFile(setup.intentPath);
    const result = await runProjectRecovery('sync', [], {
      ...setup.options(['cursor']), exactTargets: [{ pluginId: 'team/misspelled', agent: 'cursor' }],
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((entry) => entry.code))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^(?:projectSelectionInvalid|invalidExactTargets)$/u)]));
    expect(result.outputsMayHaveChanged).toBe(false);
    expect(await fs.readFile(setup.intentPath)).toEqual(before);
    expect(await addCalls(setup.log)).toEqual([]);
  });

  // Test Value Gate: failed refresh remains visible even when its old Active is usable; another source still succeeds.
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
    expect((await readProjectDemand(setup.options(['cursor']))).roots?.find((root) => root.pluginId === 'offline/beta'))
      .toMatchObject({ sourceState: 'ready', blockers: [] });
    const result = await runProjectRecovery('sync', [], { ...setup.options(['cursor']), refresh: true });
    expect(result.ok).toBe(false);
    expect(result.targetResults.find((target) => target.pluginId === 'offline/beta')?.blockers.map((entry) => entry.code))
      .toContain('catalogGenerationRefreshFailed');
    expect(result.targetResults.find((target) => target.pluginId === 'team/alpha')?.execution).toBe('applied');
    expect(result.remainingTargets.map((target) => target.pluginId)).toContain('offline/beta');
    expect(await fs.pathExists(path.join(setup.cwd, '.agents', 'skills', 'alpha', 'SKILL.md'))).toBe(true);
    expect(await fs.readFile(setup.intentPath)).toEqual(before);
  });

  // Test Value Gate: local target changes cannot rewrite the shared declaration or remove a prior Agent's output.
  it('keeps shared bytes and prior output when the local Agent choice changes', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    const before = await fs.readFile(setup.intentPath);
    expect((await projectTargetsSet({ cwd: setup.cwd, env: setup.env, agents: ['cursor'] })).ok).toBe(true);
    const first = await runProjectRecovery('sync', [], setup.options());
    expect(first.ok).toBe(true);
    const cursorSkill = path.join(setup.cwd, '.agents', 'skills', 'alpha', 'SKILL.md');
    const cursorBytes = await fs.readFile(cursorSkill);
    expect((await projectTargetsSet({ cwd: setup.cwd, env: setup.env, agents: ['claude-code'] })).ok).toBe(true);
    const second = await runProjectRecovery('sync', [], setup.options());
    expect(second.selection.agents).toEqual(['claude-code']);
    expect(second.ok, JSON.stringify(second, null, 2)).toBe(true);
    expect(await fs.readFile(cursorSkill)).toEqual(cursorBytes);
    expect(await fs.readFile(setup.intentPath)).toEqual(before);
  });

  // Test Value Gate: a foreign Cursor tree cannot block the independent Claude Code copy of the same Portable root.
  it('applies Claude Code while a foreign Cursor copy remains blocked', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    const foreignPath = path.join(setup.cwd, '.agents', 'skills', 'alpha', 'SKILL.md');
    await fs.outputFile(foreignPath, 'foreign cursor skill\n');
    const result = await runProjectRecovery('sync', [], setup.options(['cursor', 'claude-code']));
    expect(result.targetResults.find((target) => target.agent === 'claude-code'))
      .toMatchObject({ pluginId: 'team/alpha', delivery: { kind: 'agent-skills' }, execution: 'applied' });
    expect(result.remainingTargets.map(({ pluginId, agent }) => [pluginId, agent]))
      .toEqual([['team/alpha', 'cursor']]);
    expect(result.targetResults.find((target) => target.agent === 'cursor')?.blockers.length).toBeGreaterThan(0);
    const guidance = result.recoveryActions.join('\n');
    expect(guidance).toContain('.agents/skills/alpha');
    expect(guidance).toContain('Codex 和 Cursor');
    expect(guidance).toContain('备份');
    expect(guidance).toContain('移开');
    expect(guidance).not.toContain(setup.cwd);
    expect(await fs.readFile(foreignPath, 'utf8')).toBe('foreign cursor skill\n');
    expect(await fs.pathExists(path.join(setup.cwd, '.claude', 'skills', 'alpha', 'SKILL.md'))).toBe(true);
    expect((await addCalls(setup.log)).map((args) => args[args.indexOf('--agent') + 1])).toEqual(['claude-code']);
    const { runCli } = await import('../../src/index.js');
    const stdout: string[] = [];
    const exitCode = await runCli(['sync', 'team/alpha', '-s', 'project', '--target', 'cursor', '--yes'], {
      cwd: setup.cwd, env: setup.env, interactive: false,
      io: { stdout: (text) => stdout.push(text), stderr: () => undefined },
    });
    expect(exitCode).toBe(1);
    expect(stdout.join('')).toContain('.agents/skills/alpha');
    expect(stdout.join('')).toContain('Codex 和 Cursor');
    expect(stdout.join('')).toContain('备份');
    expect(await fs.readFile(foreignPath, 'utf8')).toBe('foreign cursor skill\n');
    expect(await addCalls(setup.log)).toHaveLength(1);
  });

  // Test Value Gate: a shared dependency writes once, and its public result identifies every affected root on success or failure.
  it.each((['sync', 'reinstall'] as const).flatMap((command) =>
    ['success', 'before-copy', 'after-copy', 'partial-copy'].map((mode) => ({ command, mode }))))(
    'writes a shared Portable dependency once and preserves attribution ($command, $mode)', async ({ command, mode }) => {
    const setup = await fixture([
      { name: 'alpha', dependencies: ['shared'] },
      { name: 'beta', dependencies: ['shared'] },
      { name: 'shared' },
    ]);
    if (command === 'reinstall') {
      expect((await runProjectRecovery('sync', [], setup.options(['cursor']))).ok).toBe(true);
      await fs.writeFile(setup.log, '');
    }
    const failed = mode !== 'success';
    const before = await fs.readFile(setup.intentPath);
    const options = { ...setup.options(['cursor']),
      env: { ...setup.env,
        ...(mode === 'before-copy' ? { RECOVERY_FAIL_SKILL: 'shared' } : {}),
        ...(mode === 'after-copy' ? { RECOVERY_FAIL_AFTER_COPY_SKILL: 'shared' } : {}),
        ...(mode === 'partial-copy' ? { RECOVERY_PARTIAL_SKILL: 'shared' } : {}),
      } };
    const plan = await prepareProjectRecovery(command, [], options);
    for (const target of plan.receipt.targetResults) {
      expect(target.backend).toEqual(expect.arrayContaining([
        expect.objectContaining({ skill: 'shared', providerPluginId: 'team/shared',
          requiredBy: ['team/alpha', 'team/beta'] }),
      ]));
    }
    const result = await executeProjectRecovery(plan);
    expect(result.targetResults.map(({ pluginId }) => pluginId)).toEqual(['team/alpha', 'team/beta']);
    expect(result.ok, JSON.stringify(result, null, 2)).toBe(!failed);
    for (const target of result.targetResults) {
      expect(target.backend).toEqual(expect.arrayContaining([
        expect.objectContaining({ skill: 'shared', providerPluginId: 'team/shared',
          requiredBy: ['team/alpha', 'team/beta'],
          ...(failed ? { execution: 'failed', blockers: expect.arrayContaining(['portableSkillsCliInstallFailed']) } : {}),
        }),
      ]));
    }
    expect(result.remainingTargets).toEqual(failed ? [
      { pluginId: 'team/alpha', agent: 'cursor' }, { pluginId: 'team/beta', agent: 'cursor' },
    ] : []);
    const written = (await addCalls(setup.log)).map((args) => args[args.indexOf('--skill') + 1]);
    expect(written.filter((name) => name === 'shared')).toHaveLength(1);
    expect(written.sort()).toEqual(failed ? ['alpha', 'shared'] : ['alpha', 'beta', 'shared']);
    expect(await fs.readFile(setup.intentPath)).toEqual(before);
    if (mode === 'before-copy') {
      const retried = await runProjectRecovery('sync', ['team/beta'], { ...setup.options(['cursor']), all: false });
      expect(retried.ok).toBe(true);
      expect(retried.targetResults).toHaveLength(1);
      expect(retried.targetResults[0]?.backend).toEqual(expect.arrayContaining([
        expect.objectContaining({ providerPluginId: 'team/shared', requiredBy: ['team/beta'] }),
      ]));
    }
  });

  // Test Value Gate: explicit cleanup cannot report success while a verified Portable directory remains, even with no source.
  it.each([false, true].flatMap((force) => [false, true].map((offline) => ({ force, offline }))))(
    'reports Portable residue through CLI cleanup without changing shared state (force=$force, offline=$offline)', async ({ force, offline }) => {
      const setup = await fixture([{ name: 'alpha', configurable: true }]);
      const plugin = (await readProjectDemand(setup.options())).roots![0]!.plugin!;
      await writePluginConfigStore({ sourceId: 'team', sourceIdentity: plugin.sourceIdentity,
        logicalIdentity: plugin.catalogLogicalIdentity, pluginName: 'alpha', scope: 'project',
        cwd: setup.cwd, env: setup.env, values: { mode: 'keep' } });
      const configPath = resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'alpha', scope: 'project', cwd: setup.cwd });
      const installed = await runProjectRecovery('sync', ['team/alpha'], { ...setup.options(['claude-code']), all: false });
      expect(installed.ok).toBe(true);
      expect(installed.targetResults[0]?.delivery?.kind).toBe('agent-skills');
      const output = path.join(setup.cwd, '.claude', 'skills', 'alpha', 'SKILL.md');
      const before = await Promise.all([fs.readFile(output), fs.readFile(setup.intentPath), fs.readFile(configPath)]);
      if (offline) {
        const snapshot = await readCatalogSourcesConfigSnapshot(setup.env);
        await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
          sources: snapshot.config.sources.map((source) => ({ ...source, id: 'other' })) },
          expectedDigest: snapshot.digest, env: setup.env });
      }
      const { runCli } = await import('../../src/index.js');
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCli(['cleanup', 'team/alpha', '-s', 'project', '--target', 'claude-code',
        '--yes', '--json', ...(force ? ['--force'] : [])], { cwd: setup.cwd, env: setup.env, interactive: false,
        io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) } });
      const result = JSON.parse(stdout.join(''));
      expect(exitCode).toBe(1);
      expect(stderr.join('')).toBe('');
      expect(result.ok).toBe(false);
      expect(result.remainingTargets).toEqual([{ pluginId: 'team/alpha', agent: 'claude-code' }]);
      expect(result.targetResults[0].blockers).toContainEqual(expect.objectContaining({ code: 'backend-action-unsupported' }));
      if (!offline) expect(result.targetResults[0].delivery.kind).toBe('agent-skills');
      expect(result.recoveryActions.join('\n')).toContain('.claude/skills/alpha');
      expect(result.recoveryActions.join('\n')).toContain('备份');
      expect(result.recoveryActions.join('\n')).not.toContain(setup.cwd);
      expect(result.declarationChanged).toBe(false);
      expect(await Promise.all([fs.readFile(output), fs.readFile(setup.intentPath), fs.readFile(configPath)])).toEqual(before);
      expect(await addCalls(setup.log)).toHaveLength(1);
    });

  // Test Value Gate: install declares a verified root before recovery; no target or backend failure cannot erase it.
  it('keeps the new root after no-target and failed install, while preparation alone leaves it absent', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    const installOptions = { ...setup.options(), all: false };
    await fs.remove(setup.intentPath);
    const planned = await prepareProjectRecovery('install', ['team/alpha'],
      { ...installOptions, targets: ['cursor'] });
    expect(planned.declaration).toEqual(['team/alpha']);
    expect(await fs.pathExists(setup.intentPath)).toBe(false);
    expect(await addCalls(setup.log)).toEqual([]);

    const noTarget = await runProjectRecovery('install', ['team/alpha'], installOptions);
    expect(noTarget.blockers.map((entry) => entry.code)).toContain('localTargetsRequired');
    expect(noTarget.declarationChanged).toBe(true);
    expect((await fs.readJson(setup.intentPath)).roots).toEqual([{ pluginId: 'team/alpha' }]);
    expect(await addCalls(setup.log)).toEqual([]);

    await fs.remove(setup.intentPath);
    const failed = await runProjectRecovery('install', ['team/alpha'], {
      ...installOptions, targets: ['cursor'], env: { ...setup.env, RECOVERY_FAIL_SKILL: 'alpha' },
    });
    expect(failed.ok).toBe(false);
    expect(failed.declarationChanged).toBe(true);
    expect(failed.targetResults[0]?.execution).not.toBe('applied');
    expect((await fs.readJson(setup.intentPath)).roots).toEqual([{ pluginId: 'team/alpha' }]);
  });

  // Test Value Gate: the same shared declaration and config must drive each Agent's selected delivery in separate local homes.
  it('delivers one declaration to Codex, Claude Code and Cursor in separate local environments', async () => {
    const setup = await fixture([{ name: 'alpha', native: true, nativeArtifactOnly: true, configurable: true }]);
    const demand = await readProjectDemand(setup.options());
    const plugin = demand.roots?.[0]?.plugin;
    expect(plugin).toBeDefined();
    await writePluginConfigStore({ sourceId: 'team', sourceIdentity: plugin!.sourceIdentity,
      logicalIdentity: plugin!.catalogLogicalIdentity, pluginName: 'alpha', scope: 'project',
      cwd: setup.cwd, env: setup.env, values: { mode: 'same' } });
    const configPath = resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'alpha', scope: 'project', cwd: setup.cwd });
    const [intentBytes, configBytes] = await Promise.all([fs.readFile(setup.intentPath), fs.readFile(configPath)]);
    const deliveries = [];
    for (const agent of ['codex', 'claude-code', 'cursor'] as const) {
      const cwd = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, `three-path-${agent}`);
      await fs.ensureDir(cwd);
      await git(cwd, ['init', '--quiet']);
      const localRoot = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, `local-${agent}`);
      const env = { ...setup.env, HOME: path.join(localRoot, 'home'), USERPROFILE: path.join(localRoot, 'home'),
        AW_HOME: path.join(localRoot, 'aw-home'), AW_CODEX_HOME: path.join(localRoot, 'codex-home'),
        AW_CLAUDE_HOME: path.join(localRoot, 'claude-home'),
        XDG_CONFIG_HOME: path.join(localRoot, 'xdg-config'), XDG_CACHE_HOME: path.join(localRoot, 'xdg-cache'),
        XDG_STATE_HOME: path.join(localRoot, 'xdg-state'),
        RECOVERY_SKILLS_LOG: path.join(localRoot, 'provider-calls.jsonl') };
      await fs.outputFile(resolveProjectIntentPath({ cwd }), intentBytes);
      await fs.outputFile(resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'alpha', scope: 'project', cwd }), configBytes);
      const sourceConfig = await readCatalogSourcesConfigSnapshot(env);
      await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: setup.sourceRoot }] },
        expectedDigest: sourceConfig.digest, env });
      await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
      const nativeCliRunner = await nativeRunnerForProject(cwd, env);
      const result = await runProjectRecovery('sync', [],
        { cwd, env, cliVersion: '1.0.0', targets: [agent], all: true, yes: true },
        { nativeCliRunner, codexManagerResolver: async () => ({
          kind: 'system', version: '0.200.0', command: 'codex', argsPrefix: [],
        }) });
      deliveries.push(result.targetResults[0]?.delivery);
      expect(result.ok, `${agent}: ${JSON.stringify(result)}; calls=${JSON.stringify(nativeCliRunner.mock.calls.map(([call]) => call.args))}`).toBe(true);
      expect(await fs.readFile(resolveProjectIntentPath({ cwd }))).toEqual(intentBytes);
      expect(await fs.readFile(resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'alpha', scope: 'project', cwd })))
        .toEqual(configBytes);
      if (agent === 'cursor') expect(await fs.pathExists(path.join(cwd, '.agents', 'skills', 'alpha', 'SKILL.md'))).toBe(true);
      else expect(result.targetResults[0]?.observation).toBe('verified');
    }
    expect(deliveries).toEqual([
      { kind: 'native', platform: 'codex' },
      { kind: 'native', platform: 'claude' },
      { kind: 'agent-skills', provider: 'skills-cli', agentId: 'cursor' },
    ]);
  });

  // Test Value Gate: Native and Portable plans targeting one physical Skill directory must stop before either backend writes.
  it('blocks a Native and Portable shared path before writing', async () => {
    const setup = await fixture([
      { name: 'native', native: true, nativeSkill: 'shared' },
      { name: 'portable', portableSkill: 'shared' },
    ]);
    const options = { ...setup.options(['codex', 'cursor']), exactTargets: [
      { pluginId: 'team/native', agent: 'codex' as const },
      { pluginId: 'team/portable', agent: 'cursor' as const },
    ] };
    const runtime = { nativeCliRunner: vi.fn(async () => ({ exitCode: 0,
      stdout: 'codex-cli 0.200.0', stderr: '' })), codexManagerResolver: async () => ({
      kind: 'system' as const, version: '0.200.0', command: 'codex', argsPrefix: [] as string[],
    }) };
    const plan = await prepareProjectRecovery('sync', [], options, runtime);
    const result = await executeProjectRecovery(plan);
    expect(plan.receipt.targetResults.map((target) => target.blockers.map((blocker) => blocker.code)),
      JSON.stringify({ receipt: plan.receipt, result }, null, 2)).toEqual([['artifactCollision'], ['artifactCollision']]);
    expect(result.ok).toBe(false);
    expect(result.outputsMayHaveChanged).toBe(false);
    expect(await fs.pathExists(path.join(setup.cwd, '.agents', 'skills', 'shared'))).toBe(false);
    expect(await addCalls(setup.log)).toEqual([]);
  });

  // Test Value Gate: two Native roots may share official config and activation paths without a false collision.
  it('applies two Codex Native roots that share config and activation files', async () => {
    const setup = await fixture([{ name: 'alpha', native: true, nativeArtifactOnly: true },
      { name: 'beta', native: true, nativeArtifactOnly: true }]);
    const nativeCliRunner = await nativeRunnerForProject(setup.cwd, setup.env);
    const runtime = { nativeCliRunner, codexManagerResolver: async () => ({
      kind: 'system' as const, version: '0.200.0', command: 'codex', argsPrefix: [] as string[],
    }) };
    const plan = await prepareProjectRecovery('sync', [], setup.options(['codex']), runtime);
    expect(plan.receipt.targetResults.map((target) => target.blockers.map((entry) => entry.code)))
      .toEqual([[], []]);
    const result = await executeProjectRecovery(plan);
    expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.targetResults.map(({ pluginId, agent, execution }) => [pluginId, agent, execution]))
      .toEqual([['team/alpha', 'codex', 'applied'], ['team/beta', 'codex', 'applied']]);
    expect(await fs.pathExists(path.join(setup.cwd, '.codex', 'config.toml'))).toBe(true);
  });

  // Test Value Gate: force cleanup is precise; confirmed whole cleanup removes only the deleted plugin's strong state and reports Portable residue.
  it('preserves v3 on force cleanup and reports Portable residue after confirmed whole cleanup', async () => {
    const setup = await fixture([{ name: 'alpha', native: true, nativeArtifactOnly: true, configurable: true },
      { name: 'beta', native: true, nativeArtifactOnly: true }]);
    const initial = await readProjectDemand(setup.options());
    const alpha = initial.roots?.find((root) => root.pluginId === 'team/alpha')?.plugin;
    expect(alpha).toBeDefined();
    const metadata = { sourceId: 'team', sourceIdentity: alpha!.sourceIdentity,
      logicalIdentity: alpha!.catalogLogicalIdentity, pluginName: 'alpha', cwd: setup.cwd, env: setup.env };
    for (const scope of ['user', 'project'] as const) {
      await writePluginConfigStore({ ...metadata, scope, values: { mode: scope } });
    }
    await writePluginIntentState({ scope: 'user', cwd: setup.cwd, env: setup.env }, {
      schemaVersion: 2, kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'team/alpha', platforms: ['codex', 'claude'] },
        { pluginId: 'team/beta', platforms: ['codex'] }], dependencyScopeOverrides: [],
    });
    await writeProjectPreferences({ cwd: setup.cwd, env: setup.env }, {
      schemaVersion: 1, kind: 'aw-project-preferences', agents: ['cursor'],
      dependencyScopeOverrides: [{ pluginId: 'team/alpha', platform: 'codex', scope: 'user' },
        { pluginId: 'team/beta', platform: 'codex', scope: 'user' }],
    });
    const portable = await runProjectRecovery('sync', ['team/alpha'],
      { ...setup.options(['cursor']), all: false });
    expect(portable.ok).toBe(true);
    const portablePath = path.join(setup.cwd, '.agents', 'skills', 'alpha', 'SKILL.md');
    const portableBytes = await fs.readFile(portablePath);
    const declarationBytes = await fs.readFile(setup.intentPath);
    const userDeclaration = await readPluginIntentState({ scope: 'user', cwd: setup.cwd, env: setup.env });
    const projectConfigPath = resolvePluginConfigStorePath({ ...metadata, scope: 'project' });
    const userConfigPath = resolvePluginConfigStorePath({ ...metadata, scope: 'user' });
    const configBytes = await fs.readFile(projectConfigPath);
    const userConfigBytes = await fs.readFile(userConfigPath);
    const preferencesPath = await resolveProjectPreferencesPath({ cwd: setup.cwd, env: setup.env });
    const preferenceBytes = await fs.readFile(preferencesPath);
    const nativeCliRunner = await nativeRunnerForProject(setup.cwd, setup.env);
    const runtime = { nativeCliRunner, codexManagerResolver: async () => ({
      kind: 'system' as const, version: '0.200.0', command: 'codex', argsPrefix: [] as string[],
    }) };
    await runProjectRecovery('cleanup', ['team/alpha'], {
      ...setup.options(['codex']), all: false, force: true,
    }, runtime);
    expect(await fs.readFile(setup.intentPath)).toEqual(declarationBytes);
    expect(await readPluginIntentState({ scope: 'user', cwd: setup.cwd, env: setup.env })).toEqual(userDeclaration);
    expect(await fs.readFile(projectConfigPath)).toEqual(configBytes);
    expect(await fs.readFile(userConfigPath)).toEqual(userConfigBytes);
    expect(await fs.readFile(preferencesPath)).toEqual(preferenceBytes);

    const catalogPath = path.join(setup.sourceRoot, 'catalog-manifest.json');
    const catalog = await fs.readJson(catalogPath) as { entries: Array<{ name: string }> };
    await fs.writeJson(catalogPath, { ...catalog, entries: catalog.entries.filter((entry) => entry.name !== 'alpha') });
    for (const marketplacePath of [path.join(setup.sourceRoot, '.agents', 'plugins', 'marketplace.json'),
      path.join(setup.sourceRoot, '.claude-plugin', 'marketplace.json')]) {
      const marketplace = await fs.readJson(marketplacePath) as { plugins: Array<{ name: string }> };
      await fs.writeJson(marketplacePath, { ...marketplace,
        plugins: marketplace.plugins.filter((plugin) => plugin.name !== 'alpha') });
    }
    await fs.remove(path.join(setup.sourceRoot, 'plugins', 'alpha'));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: setup.env,
      impactConfirmed: true });
    const reviewed = await prepareProjectRecovery('cleanup', ['team/alpha'], {
      ...setup.options(), all: false, yes: true,
    }, runtime);
    expect(reviewed.removedPluginIds).toEqual(['team/alpha']);
    expect(reviewed.receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/alpha', agent: 'codex', delivery: expect.objectContaining({ kind: 'native' }) }),
      expect.objectContaining({ pluginId: 'team/alpha', agent: 'claude-code', delivery: expect.objectContaining({ kind: 'native' }) }),
      expect.objectContaining({ pluginId: 'team/alpha', agent: 'cursor' }),
    ]));
    const result = await executeProjectRecovery(reviewed);
    expect(result.declarationChanged).toBe(true);
    expect(result.preferencesChanged).toBe(true);
    expect(result.intent.roots).toEqual(['team/beta']);
    expect((await readPluginIntentState({ scope: 'user', cwd: setup.cwd, env: setup.env })).roots)
      .toEqual([{ pluginId: 'team/beta', platforms: ['codex'] }]);
    expect(await fs.pathExists(projectConfigPath)).toBe(false);
    expect(await fs.pathExists(userConfigPath)).toBe(false);
    expect((await fs.readJson(preferencesPath)).dependencyScopeOverrides)
      .toEqual([{ pluginId: 'team/beta', platform: 'codex', scope: 'user' }]);
    expect(result.remainingTargets.length).toBeGreaterThan(0);
    expect(result.targetResults.some((target) => target.blockers.some((entry) => entry.code === 'backend-action-unsupported')))
      .toBe(true);
    expect(result.recoveryActions.join('\n')).toContain('.agents/skills/alpha');
    expect(result.recoveryActions.join('\n')).toContain('Codex 和 Cursor');
    expect(result.recoveryActions.join('\n')).toContain('AW 不自动删除');
    expect(await fs.readFile(portablePath)).toEqual(portableBytes);
  });

  // Test Value Gate: user-scope whole cleanup must report preserved Portable output while committing the authorized strong-state changes.
  it.each([false, true])('reports Portable residue after user-scope whole cleanup (evidenceLost=%s)', async (evidenceLost) => {
    const setup = await fixture([{ name: 'alpha', native: true, nativeArtifactOnly: true, configurable: true }, { name: 'beta' }]);
    const alpha = (await readProjectDemand(setup.options())).roots!.find((root) => root.pluginId === 'team/alpha')!.plugin!;
    const metadata = { sourceId: 'team', sourceIdentity: alpha.sourceIdentity,
      logicalIdentity: alpha.catalogLogicalIdentity, pluginName: 'alpha', cwd: setup.cwd, env: setup.env };
    for (const scope of ['user', 'project'] as const) await writePluginConfigStore({ ...metadata, scope, values: { mode: scope } });
    await writePluginIntentState({ scope: 'user', cwd: setup.cwd, env: setup.env }, {
      schemaVersion: 2, kind: 'aw-plugin-intents', roots: [{ pluginId: 'team/alpha', platforms: ['codex'] }], dependencyScopeOverrides: [],
    });
    expect((await runProjectRecovery('sync', ['team/alpha'], { ...setup.options(['cursor']), all: false })).ok).toBe(true);
    const output = path.join(setup.cwd, '.agents', 'skills', 'alpha', 'SKILL.md');
    const lock = path.join(setup.cwd, 'skills-lock.json');
    const before = await Promise.all([fs.readFile(output), fs.readFile(lock)]);
    if (evidenceLost) await fs.remove(path.join(setup.cwd, '.agent-workflows', '.local', 'portable'));
    const catalogPath = path.join(setup.sourceRoot, 'catalog-manifest.json');
    const catalog = await fs.readJson(catalogPath) as { entries: Array<{ name: string }> };
    await fs.writeJson(catalogPath, { ...catalog, entries: catalog.entries.filter((entry) => entry.name !== 'alpha') });
    for (const marketplacePath of [path.join(setup.sourceRoot, '.agents', 'plugins', 'marketplace.json'),
      path.join(setup.sourceRoot, '.claude-plugin', 'marketplace.json')]) {
      const marketplace = await fs.readJson(marketplacePath) as { plugins: Array<{ name: string }> };
      await fs.writeJson(marketplacePath, { ...marketplace, plugins: marketplace.plugins.filter((entry) => entry.name !== 'alpha') });
    }
    await fs.remove(path.join(setup.sourceRoot, 'plugins', 'alpha'));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: setup.env, impactConfirmed: true });
    const { runCli } = await import('../../src/index.js');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(['cleanup', 'team/alpha', '-s', 'user', '-p', 'codex', '--yes', '--json'], {
      cwd: setup.cwd, env: setup.env, interactive: false,
      nativeCliRunner: await nativeRunnerForProject(setup.cwd, setup.env),
      io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    });
    const receipt = JSON.parse(stdout.join(''));
    expect(receipt).toMatchObject({ receiptSchemaVersion: 6, command: 'cleanup', ok: false, overallState: 'partial' });
    expect(exitCode).toBe(1);
    expect(receipt.warnings.join('\n')).toContain('Portable');
    expect(receipt.recoveryActions.length).toBeGreaterThan(0);
    if (!evidenceLost) {
      expect(receipt.recoveryActions.join('\n')).toContain('.agents/skills/alpha');
      expect(receipt.recoveryActions.join('\n')).toContain('Codex');
      expect(receipt.recoveryActions.join('\n')).toContain('Cursor');
    }
    expect(stdout.join('') + stderr.join('')).not.toContain(setup.cwd);
    expect((await fs.readJson(setup.intentPath)).roots).toEqual([{ pluginId: 'team/beta' }]);
    expect((await readPluginIntentState({ scope: 'user', cwd: setup.cwd, env: setup.env })).roots).toEqual([]);
    for (const scope of ['user', 'project'] as const) expect(await fs.pathExists(resolvePluginConfigStorePath({ ...metadata, scope }))).toBe(false);
    expect(await Promise.all([fs.readFile(output), fs.readFile(lock)])).toEqual(before);
    expect(await addCalls(setup.log)).toHaveLength(1);
  });

  // Test Value Gate: a multi-source Native batch must apply and clean both selected roots without losing an unselected declaration.
  it('cleans deleted Native roots from two sources in one Review and keeps the other root', async () => {
    const setup = await fixture([{ name: 'alpha', native: true, nativeArtifactOnly: true },
      { name: 'beta', native: true, nativeArtifactOnly: true },
      { name: 'survivor', native: true, nativeArtifactOnly: true }]);
    const secondRoot = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'second-cleanup-source');
    await fs.copy(setup.sourceRoot, secondRoot);
    const markerPath = path.join(secondRoot, '.aw-generated.json');
    const marker = await fs.readJson(markerPath) as { workspaceIdentity: string };
    await fs.writeJson(markerPath, { ...marker, workspaceIdentity: 'fixture:second-cleanup' });
    const sourceConfig = await readCatalogSourcesConfigSnapshot(setup.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
      { id: 'team', type: 'path', primary: true, path: setup.sourceRoot },
      { id: 'second', type: 'path', primary: false, path: secondRoot },
    ] }, expectedDigest: sourceConfig.digest, env: setup.env });
    await syncCatalogSourceGeneration({ sourceId: 'second', cliVersion: '1.0.0', env: setup.env });
    const intent = await fs.readJson(setup.intentPath) as {
      sources: Record<string, { logicalIdentity: string }>;
      roots: Array<{ pluginId: string }>;
    };
    intent.sources.second = { logicalIdentity: 'fixture:second-cleanup' };
    intent.roots = [{ pluginId: 'team/alpha' }, { pluginId: 'second/beta' }, { pluginId: 'team/survivor' }];
    await fs.writeJson(setup.intentPath, intent);
    expect((await projectTargetsSet({ cwd: setup.cwd, env: setup.env, agents: ['codex'] })).ok).toBe(true);
    const nativeCliRunner = await nativeRunnerForProject(setup.cwd, setup.env);
    const runtime = { nativeCliRunner, codexManagerResolver: async () => ({
      kind: 'system' as const, version: '0.200.0', command: 'codex', argsPrefix: [] as string[],
    }) };
    const syncPlan = await prepareProjectRecovery('sync', ['team/alpha', 'second/beta'],
      { ...setup.options(), all: false }, runtime);
    const synced = await executeProjectRecovery(syncPlan);
    expect(synced.ok, JSON.stringify(synced, null, 2)).toBe(true);
    expect(synced.targetResults.filter((target) => target.agent === 'codex').map((target) => target.execution))
      .toEqual(['applied', 'applied']);

    for (const [sourceId, sourceRoot, removedName] of [
      ['team', setup.sourceRoot, 'alpha'], ['second', secondRoot, 'beta'],
    ] as const) {
      const catalogPath = path.join(sourceRoot, 'catalog-manifest.json');
      const catalog = await fs.readJson(catalogPath) as { entries: Array<{ name: string }> };
      await fs.writeJson(catalogPath, { ...catalog,
        entries: catalog.entries.filter((entry) => entry.name !== removedName) });
      for (const marketplacePath of [path.join(sourceRoot, '.agents', 'plugins', 'marketplace.json'),
        path.join(sourceRoot, '.claude-plugin', 'marketplace.json')]) {
        const marketplace = await fs.readJson(marketplacePath) as { plugins: Array<{ name: string }> };
        await fs.writeJson(marketplacePath, { ...marketplace,
          plugins: marketplace.plugins.filter((plugin) => plugin.name !== removedName) });
      }
      await fs.remove(path.join(sourceRoot, 'plugins', removedName));
      await syncCatalogSourceGeneration({ sourceId, cliVersion: '1.0.0', env: setup.env,
        impactConfirmed: true });
    }
    const plan = await prepareProjectRecovery('cleanup', ['team/alpha', 'second/beta'],
      { ...setup.options(), all: false, yes: true }, runtime);
    expect(plan.removedPluginIds).toEqual(['team/alpha', 'second/beta']);
    const result = await executeProjectRecovery(plan);
    expect(result.ok, JSON.stringify(result.targetResults.map((target) => ({
      pluginId: target.pluginId, agent: target.agent, execution: target.execution,
      blockers: target.blockers.map((entry) => entry.code),
    })))).toBe(true);
    expect(result.intent.roots).toEqual(['team/survivor']);
    expect((await fs.readJson(setup.intentPath)).roots).toEqual([{ pluginId: 'team/survivor' }]);
    expect(result.remainingTargets).toEqual([]);
    expect(result.targetResults.map(({ pluginId, agent, execution }) => [pluginId, agent, execution])).toEqual([
      ['team/alpha', 'codex', 'applied'], ['team/alpha', 'claude-code', 'no-op'],
      ['second/beta', 'codex', 'applied'], ['second/beta', 'claude-code', 'no-op'],
    ]);
  });
});


describe('project recovery status location', () => {
  // Test Value Gate: status must observe the recovered worktree from every supported cwd without writes.
  it('observes the same satisfied Portable target from the root, a subdirectory and a path alias', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    await projectTargetsSet({ cwd: setup.cwd, env: setup.env, agents: ['cursor'] });
    const recovered = await runProjectRecovery('sync', [], setup.options());
    expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
    const subdirectory = path.join(setup.cwd, 'src');
    const alias = path.join(path.dirname(setup.cwd), 'recovery-project-alias');
    await fs.ensureDir(subdirectory);
    await fs.symlink(setup.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const projectFiles = async (): Promise<Record<string, string>> => {
      const files: Record<string, string> = {};
      const visit = async (directory: string): Promise<void> => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const filename = path.join(directory, entry.name);
          const relative = path.relative(setup.cwd, filename);
          files[relative] = entry.isDirectory() ? 'directory'
            : (await fs.readFile(filename)).toString('base64');
          if (entry.isDirectory()) await visit(filename);
        }
      };
      await visit(setup.cwd);
      return files;
    };
    const before = await projectFiles();
    const writes = await addCalls(setup.log);
    const render = vi.spyOn(artifactRenderer, 'runArtifactRenderer');
    const nativeCliRunner = await nativeRunnerForProject(setup.cwd, setup.env);
    try {
      const statuses = [];
      for (const cwd of [setup.cwd, subdirectory, alias]) {
        const options = { cwd, env: setup.env, cliVersion: '1.0.0', nativeCliRunner };
        statuses.push(await readProjectStatus(options));
        statuses.push((await statusCommandV8(options)).payload.projectRecovery);
      }
      for (const status of statuses) {
        expect(status).toMatchObject({
          ok: true, allSatisfied: true, errors: [],
          inventory: [{ pluginId: 'team/alpha', targetResults: [{
            agent: 'cursor', content: 'satisfied', observation: 'verified', blockers: [],
          }] }],
        });
        expect(status).toEqual(statuses[0]);
      }
      expect(render).not.toHaveBeenCalled();
      expect(await addCalls(setup.log)).toEqual(writes);
      expect(await projectFiles()).toEqual(before);
    } finally {
      render.mockRestore();
    }
  });
});
