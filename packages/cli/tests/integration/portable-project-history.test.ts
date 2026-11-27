import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { executeRecovery, prepareRecovery } from '../../src/recovery/coordinator.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { createScopeContext } from '../../src/intent/scope-context.js';
import { runCli } from '../../src/index.js';
import { resolvePortableCatalogBindingInput } from '../../src/portable/materializer.js';
import { executePortableRecovery, inspectPortableRecovery, preparePortableCleanup, preparePortableRecovery } from '../../src/portable/recovery.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import { createCatalogManifestV7, createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { CatalogPreparationReadScope } from '../../src/utils/catalog-operation-context.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(scope: 'user' | 'project' = 'project', twoSkills = false, mixed = false) {
  const isolated = getCurrentSourceTestIsolation();
  const cwd = isolated.layout.fixtureCwd;
  await fs.ensureDir(path.join(cwd, '.git'));
  const sourceRoot = path.join(cwd, 'catalog');
  const pluginRoot = path.join(sourceRoot, 'plugins', 'portable');
  await createCatalogSnapshotFixture(sourceRoot, 'portable', [], 'Portable writer fixture', (manifest) => {
    manifest.platforms = mixed ? ['generic', 'opencode'] : ['generic'];
    manifest.config = { fields: { tone: { type: 'string', default: 'first' } } };
    manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
    manifest.artifacts = { configKeys: ['tone'] };
  });
  const renderLog = path.join(cwd, 'render-log');
  await fs.outputFile(path.join(pluginRoot, 'scripts/render.mjs'), [
    "import fs from 'node:fs';",
    "const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
    "const batch = context.allowedOutputKinds.includes('skill') ? 'skill' : 'non-skill';",
    `fs.appendFileSync(${JSON.stringify(renderLog)}, context.platform + ':' + batch + '\\n');`,
    `const names = ${JSON.stringify(twoSkills ? ['alpha', 'beta'] : ['alpha'])};`,
    "const components = names.map(name => ({id:name,kind:'skill',name,content:{files:{'SKILL.md':{text:'---\\nname: '+name+'\\ndescription: Test skill\\n---\\nTone: '+context.config.values.tone+' Platform: '+context.platform+' Scope: '+context.scope},'README.md':{text:'Skill readme'},'references/guide.md':{text:'Complete local guide.'},'.hidden':{text:'retain hidden bytes'}}}}));",
    "console.log(JSON.stringify({version:3,components:components.filter(item => context.allowedOutputKinds.includes(item.kind)),omitted:[],unmet:[]}));",
  ].join('\n'));
  const refreshCatalog = async () => {
    const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    await fs.writeJson(path.join(sourceRoot, 'catalog-manifest.json'), createCatalogManifestV7({
      catalogVersion: plugin.manifest.version, channel: 'latest',
      marketplace: { owner: { name: 'Fixture Owner', url: 'https://example.invalid/fixture' }, interface: { displayName: 'Fixture Marketplace' } },
      requires: { aw: { capabilities: ['aw.catalog-snapshot.v7'] } }, release: { state: 'development' },
      entries: [await createCatalogManifestV7Entry(plugin, pluginRoot)],
    }));
  };
  await refreshCatalog();
  const before = await readCatalogSourcesConfigSnapshot(isolated.env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
    sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: before.digest, env: isolated.env });
  await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env: isolated.env });
  const context = await createScopeContext({ scope, cwd, env: isolated.env });
  const options = { scope, context, selector: 'local/portable', agents: ['generic' as const], env: context.env, cliVersion: '1.0.0' };
  const active = (await readCatalogGenerationState(options.env)).sources.local!.active!;
  const setTone = async (tone: string, platform?: 'generic') => writePluginConfigStore({
    sourceId: 'local', sourceIdentity: active.sourceIdentity, logicalIdentity: active.logicalIdentity,
    pluginName: 'portable', scope: 'user', cwd, env: options.env, values: { tone }, platform,
  });
  return { options, active, sourceRoot, pluginRoot, refreshCatalog, setTone, renderLog };
}
async function apply(options: Awaited<ReturnType<typeof fixture>>['options'], authorizeUpdate = false) {
  const prepared = await preparePortableRecovery(options);
  expect(prepared.blockers, JSON.stringify(prepared)).toEqual([]);
  const result = await withAwHomeMutationLock({ env: options.env, action: (token) =>
    executePortableRecovery({ prepared, token, authorizeUpdate }) });
  expect(result.execution, JSON.stringify(result)).toBe('applied');
  return prepared;
}

describe('Portable writer through real Catalog and renderer', () => {
  // Test Value Gate: one preparation shares transport across binding and cold
  // materialization, but recovery's own prewrite fallback must read it afresh.
  it('reuses prepared Catalog transport and rejects damage before writing', async () => {
    const value = await fixture();
    const { options, active } = value;
    const { snapshotRoot } = resolveCatalogStoreLocation({ ...active, env: options.env });
    const marketplace = path.join(snapshotRoot, '.claude-plugin', 'marketplace.json');
    const original = await fs.readFile(marketplace);
    const readScope = new CatalogPreparationReadScope({ env: options.env });
    const reads = vi.spyOn(fs, 'readFile');
    const transportReads = () => reads.mock.calls.filter(([file]) => file === marketplace).length;
    try {
      await resolvePortableCatalogBindingInput({ ...options, platform: 'generic',
        cwd: options.context.executionCwd, catalogReadScope: readScope });
      const prepared = await preparePortableRecovery(options, readScope);
      expect(prepared.blockers).toEqual([]);
      expect(transportReads()).toBe(1);
      await fs.appendFile(marketplace, '\n');
      const execute = () => withAwHomeMutationLock({ env: options.env, action: (token) =>
        executePortableRecovery({ prepared, token }) });
      expect(await execute()).toMatchObject({ execution: 'not-run', globalBlockers: ['operationReviewStale'], outputsMayHaveChanged: false });
      expect(transportReads()).toBe(2);
      expect(await fs.pathExists(prepared.targets[0]!.physicalPath)).toBe(false);
      await fs.writeFile(marketplace, original);
      expect(await execute()).toMatchObject({ execution: 'applied' });
      expect(transportReads()).toBe(3);
      expect(await fs.readFile(path.join(prepared.targets[0]!.physicalPath, 'SKILL.md'), 'utf8')).toContain('Tone: first');
    } finally {
      reads.mockRestore();
      await options.context.dispose();
    }
  }, 30_000);

  // Test Value Gate: two mixed-install children encountering the same cold generation must share both renderer batches.
  it('materializes the shared cold generic generation once for a mixed install', async () => {
    installNativeTestQualification({ platforms: ['opencode'], discovery: true });
    const parallelism = vi.spyOn(os, 'availableParallelism').mockReturnValue(4);
    const value = await fixture('user', false, true);
    const { context, env } = value.options;
    const input = { scope: 'user' as const, context: 'user' as const, cwd: context.callerCwd, env, cliVersion: '1.0.0', yes: true };
    await writeIntentFixture(input, { roots: [], targets: ['opencode', 'generic'] });
    await fs.ensureDir(path.dirname(context.generationRoot));
    const lstat = fs.lstat.bind(fs);
    let coldReaders = 0;
    let release!: () => void;
    const rendezvous = new Promise<void>((resolve) => { release = resolve; });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; release(); }, 8000);
    const observe = vi.spyOn(fs, 'lstat').mockImplementation(async (candidate) => {
      try { return await lstat(candidate); }
      catch (error) {
        if (String(candidate) === context.generationRoot && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          coldReaders++;
          if (coldReaders === 2) { clearTimeout(timeout); release(); }
          await rendezvous;
        }
        throw error;
      }
    });
    try {
      const review = await prepareRecovery('install', ['local/portable'], input);
      expect(coldReaders).toBeGreaterThanOrEqual(2);
      expect(timedOut).toBe(false);
      const receipt = await executeRecovery(review);
      expect(receipt.ok, JSON.stringify(receipt.targetResults.map(({ agent, blockers, backend }) => ({ agent, blockers, backend })))).toBe(true);
      expect(receipt.targetResults).toHaveLength(2);
      for (const target of receipt.targetResults) expect(target).toMatchObject({ execution: 'applied', observation: 'verified' });
      expect((await fs.readFile(value.renderLog, 'utf8')).split('\n').filter((line) => line.startsWith('generic:')).sort())
        .toEqual(['generic:non-skill', 'generic:skill']);
      expect(await fs.readFile(path.join(context.targetHomes.home, '.agents', 'skills', 'alpha', 'SKILL.md'), 'utf8'))
        .toContain('Platform: generic Scope: user');
    } finally { clearTimeout(timeout); release(); observe.mockRestore(); parallelism.mockRestore(); await context.dispose(); }
  }, 30000);

  // Test Value Gate: generic overrides common config, while User and Project keep separate render contexts and output.
  it('uses the generic override in separate User and Project render contexts', async () => {
    const value = await fixture();
    await value.setTone('COMMON-SETTING');
    await value.setTone('GENERIC-SETTING', 'generic');
    const userContext = await createScopeContext({ scope: 'user', cwd: value.options.context.callerCwd, env: value.options.env });
    const user = { ...value.options, scope: 'user' as const, context: userContext, env: userContext.env };
    try {
      const userPrepared = await apply(user);
      const projectPrepared = await apply(value.options);
      const userTarget = userPrepared.targets[0]!;
      const projectTarget = projectPrepared.targets[0]!;
      expect(userTarget.physicalPath).toBe(path.join(userContext.targetHomes.home, '.agents', 'skills', 'alpha'));
      expect(projectTarget.physicalPath).toBe(path.join(value.options.context.executionCwd, '.agents', 'skills', 'alpha'));
      expect(await fs.readFile(path.join(userTarget.physicalPath, 'SKILL.md'), 'utf8')).toContain('Tone: GENERIC-SETTING Platform: generic Scope: user');
      expect(await fs.readFile(path.join(projectTarget.physicalPath, 'SKILL.md'), 'utf8')).toContain('Tone: GENERIC-SETTING Platform: generic Scope: project');
      expect(userTarget.configDigest).not.toBe(projectTarget.configDigest);
      expect(userPrepared.generations?.generic).not.toBe(projectPrepared.generations?.generic);
      const before = await fs.readFile(value.renderLog, 'utf8');
      expect((await inspectPortableRecovery(user)).targets.map((target) => target.observation)).toEqual(['satisfied']);
      expect((await inspectPortableRecovery(value.options)).targets.map((target) => target.observation)).toEqual(['satisfied']);
      expect(await fs.readFile(value.renderLog, 'utf8')).toBe(before);
    } finally { await userContext.dispose(); }
  }, 30_000);

  // Test Value Gate: current owned output can update without historical snapshots or generations, using its own bounded evidence.
  it('updates an owned copy after config changes and old weak generations are deleted', async () => {
    const value = await fixture('user');
    const original = await apply(value.options);
    const output = original.targets[0]!.physicalPath;
    await fs.remove(value.options.context.generationRoot);
    await value.setTone('second');
    const next = await preparePortableRecovery(value.options);
    expect(next.targets[0]).toMatchObject({ ownership: 'aw', observation: 'drifted', contentState: 'stale' });
    await apply(value.options, true);
    expect(await fs.readFile(path.join(output, 'SKILL.md'), 'utf8')).toContain('Tone: second');
  }, 30_000);

  // Test Value Gate: a pure config save is known drift, while missing candidates or damaged identity remain unknown; status must not render.
  it.each(['user', 'project'] as const)('reports %s owned config drift without preparing outputs or claiming unknown output is healthy', async (scope) => {
    const value = await fixture(scope);
    const location = { scope, cwd: value.options.context.executionCwd, env: value.options.env };
    await writeIntentFixture(location, { roots: [{ pluginId: value.options.selector }], targets: ['generic'] });
    const installed = await apply(value.options);
    const output = installed.targets[0]!.physicalPath;
    const skill = path.join(output, 'SKILL.md');
    const content = await fs.readFile(skill, 'utf8');
    const before = await fs.stat(skill);
    const rendered = await fs.readFile(value.renderLog, 'utf8');
    const invoke = async (args: string[]) => {
      const io = createCapturedCliIo();
      const exitCode = await runCli(args, { cwd: location.cwd, env: location.env,
        interactive: false, io: io.io });
      return { exitCode, value: JSON.parse(io.readStdout()) };
    };
    const status = () => invoke(['plugin', 'status', '--context', scope, '--json']);
    const baseline = await status();
    expect(baseline.exitCode, JSON.stringify(baseline.value)).toBe(0);
    expect(baseline.value.data.allSatisfied, JSON.stringify(baseline.value)).toBe(true);
    await fs.remove(value.options.context.generationRoot);
    const unavailable = await status();
    expect(unavailable.value.data.inventory[0].targetResults[0].content).toBe('unknown');
    expect(unavailable.value.data.allSatisfied).toBeNull();
    const saved = await invoke(['plugin', 'config', 'set', value.options.selector, 'tone',
      '--value-json', '"second"', '--json']);
    expect(saved.exitCode).toBe(0);
    const stale = await status();
    expect(stale.value.data.inventory[0].targetResults[0].content).toBe('drifted');
    expect(stale.value.data.allSatisfied).toBe(false);
    expect(stale.value).toMatchObject({ status: 'success', diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'needs-preparation', subject: expect.objectContaining({ pluginId: 'local/portable', target: 'generic' }) })]) });
    expect(await fs.readFile(skill, 'utf8')).toBe(content);
    expect((await fs.stat(skill)).mtimeMs).toBe(before.mtimeMs);
    await fs.writeFile(path.join(output, '.agent-workflows-owner.json'), '{invalid owner');
    const unknown = await status();
    expect(unknown.value.data.inventory[0].targetResults[0].content).toBe('unknown');
    expect(unknown.value.data.allSatisfied).toBeNull();
    expect(await fs.readFile(value.renderLog, 'utf8')).toBe(rendered);
    expect(await fs.pathExists(value.options.context.generationRoot)).toBe(false);
  }, 30_000);

  // Test Value Gate: a new Catalog version can remove its final Skill without leaving the old owned copy discoverable.
  it('removes the final owned Skill when the current plugin has no Skill candidates', async () => {
    const value = await fixture();
    const original = await apply(value.options);
    const manifestPath = path.join(value.pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.version = '1.0.1';
    delete manifest.artifacts;
    delete manifest.scripts;
    await fs.writeJson(manifestPath, manifest);
    await value.refreshCatalog();
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env: value.options.env });
    const prepared = await preparePortableRecovery(value.options);
    expect(prepared.blockers, JSON.stringify(prepared)).toEqual([]);
    expect(prepared.targets).toMatchObject([{ skill: 'alpha', disposition: 'remove' }]);
    await apply(value.options, true);
    expect(await fs.pathExists(original.targets[0]!.physicalPath)).toBe(false);
  }, 30_000);

  // Test Value Gate: cleanup must not execute a renderer or require current Catalog/schema when owned output is still verifiable.
  it('cleans offline after removing Catalog, generation and source without rerunning renderer', async () => {
    const value = await fixture();
    const installed = await apply(value.options);
    const before = await fs.readFile(value.renderLog, 'utf8');
    const store = resolveCatalogStoreLocation({ logicalIdentity: value.active.logicalIdentity,
      snapshotDigest: value.active.snapshotDigest, env: value.options.env });
    await fs.remove(store.entryDir);
    await fs.remove(value.sourceRoot);
    await fs.remove(value.options.context.generationRoot);
    const prepared = await preparePortableCleanup(value.options);
    expect(prepared.blockers, JSON.stringify(prepared)).toEqual([]);
    const result = await withAwHomeMutationLock({ env: value.options.env, action: (token) =>
      executePortableRecovery({ prepared, token, action: 'cleanup' }) });
    expect(result.execution).toBe('applied');
    expect(await fs.pathExists(installed.targets[0]!.physicalPath)).toBe(false);
    expect(await fs.readFile(value.renderLog, 'utf8')).toBe(before);
  }, 30_000);

  // Test Value Gate: matching unowned bytes and obsolete provider locks cannot authorize adoption; independent targets still apply.
  it('preserves a matching foreign Skill copy and applies an independent generic Skill', async () => {
    const value = await fixture('project', true);
    const first = await preparePortableRecovery(value.options);
    const foreign = first.targets[0]!.physicalPath;
    await fs.copy(path.join(first.generation, 'skills', 'alpha'), foreign);
    const oldLock = path.join(value.options.context.executionCwd, 'skills-lock.json');
    await fs.writeFile(oldLock, '{broken old provider lock');
    const options = value.options;
    const prepared = await preparePortableRecovery(options);
    expect(prepared.targets[0]).toMatchObject({ ownership: 'external', observation: 'conflict' });
    const result = await withAwHomeMutationLock({ env: options.env, action: (token) =>
      executePortableRecovery({ prepared, token, authorizeUpdate: true }) });
    expect(result.execution).toBe('partial');
    expect(result.targets.map((target) => [target.skill, target.execution])).toEqual([['alpha', 'not-run'], ['beta', 'applied']]);
    expect(await fs.pathExists(path.join(foreign, '.agent-workflows-owner.json'))).toBe(false);
    expect(await fs.readFile(oldLock, 'utf8')).toBe('{broken old provider lock');
  }, 30_000);
});
