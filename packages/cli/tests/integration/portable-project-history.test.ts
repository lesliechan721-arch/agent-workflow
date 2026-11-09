import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { createScopeContext } from '../../src/intent/scope-context.js';
import { runCli } from '../../src/index.js';
import { executePortableRecovery, inspectPortableRecovery, preparePortableCleanup, preparePortableRecovery } from '../../src/portable/recovery.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import { createCatalogManifestV7, createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(scope: 'user' | 'project' = 'project') {
  const isolated = getCurrentSourceTestIsolation();
  const cwd = isolated.layout.fixtureCwd;
  await fs.ensureDir(path.join(cwd, '.git'));
  const sourceRoot = path.join(cwd, 'catalog');
  const pluginRoot = path.join(sourceRoot, 'plugins', 'portable');
  await createCatalogSnapshotFixture(sourceRoot, 'portable', [], 'Portable writer fixture', (manifest) => {
    manifest.platforms = ['antigravity', 'cursor', 'pi'];
    manifest.config = { fields: { tone: { type: 'string', default: 'first' } } };
    manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
    manifest.artifacts = { targets: (['antigravity', 'cursor', 'pi'] as const).map((platform) => ({
      id: `alpha-${platform}`, platform, distribution: 'agent-skills', target: 'agent-skills.skill',
      kind: 'skill', scopes: ['project', 'user'], states: ['present'], refreshKeys: ['tone'], skillKey: 'alpha',
    })) };
  });
  const renderLog = path.join(cwd, 'render-log');
  await fs.outputFile(path.join(pluginRoot, 'scripts/render.mjs'), [
    "import fs from 'node:fs';",
    "const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
    `fs.appendFileSync(${JSON.stringify(renderLog)}, context.platform + '\\n');`,
    "console.log(JSON.stringify({version:2,artifacts:[{id:context.requestedArtifactIds[0],platform:context.platform,distribution:'agent-skills',target:'agent-skills.skill',kind:'skill',state:'present',skillKey:'alpha',refreshKeys:['tone'],content:{files:{'SKILL.md':'---\\nname: alpha\\ndescription: alpha\\n---\\nTone: '+context.config.values.tone+' Platform: '+context.platform,'README.md':'Alpha readme','references/guide.md':'Complete local guide.','.hidden':'retain hidden bytes'}}}]}));",
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
  const options = { scope, context, selector: 'local/portable', agents: ['cursor' as const], env: context.env, cliVersion: '1.0.0' };
  const active = (await readCatalogGenerationState(options.env)).sources.local!.active!;
  const setTone = async (tone: string, platform?: 'cursor' | 'pi') => writePluginConfigStore({
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
  // Test Value Gate: concrete platforms must select their own effective config and final content through the production chain.
  it('materializes and installs separate Cursor and Pi content using platform values', async () => {
    const value = await fixture();
    await value.setTone('CURSOR-SETTING', 'cursor');
    await value.setTone('PI-SETTING', 'pi');
    const options = { ...value.options, agents: ['cursor', 'pi'] as ('cursor' | 'pi')[] };
    const prepared = await apply(options);
    const [cursor, pi] = prepared.targets;
    expect(cursor!.physicalPath).toContain(path.join('.cursor', 'skills', 'alpha'));
    expect(pi!.physicalPath).toContain(path.join('.pi', 'skills', 'alpha'));
    expect(await fs.readFile(path.join(cursor!.physicalPath, 'SKILL.md'), 'utf8')).toContain('Tone: CURSOR-SETTING Platform: cursor');
    expect(await fs.readFile(path.join(pi!.physicalPath, 'SKILL.md'), 'utf8')).toContain('Tone: PI-SETTING Platform: pi');
    expect(cursor!.configDigest).not.toBe(pi!.configDigest);
    expect(prepared.generations?.cursor).not.toBe(prepared.generations?.pi);
    const before = await fs.readFile(value.renderLog, 'utf8');
    expect((await inspectPortableRecovery(options)).targets.map((target) => target.observation)).toEqual(['satisfied', 'satisfied']);
    expect(await fs.readFile(value.renderLog, 'utf8')).toBe(before);
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
    await writeIntentFixture(location, { roots: [{ pluginId: value.options.selector }], targets: ['cursor'] });
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
    expect(baseline.exitCode).toBe(0);
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
    expect(stale.value).toMatchObject({ status: 'success', diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'needs-preparation', subject: expect.objectContaining({ pluginId: 'local/portable', target: 'cursor' }) })]) });
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
  it('preserves a matching foreign Cursor copy and applies independent Pi output', async () => {
    const value = await fixture();
    const first = await preparePortableRecovery(value.options);
    const foreign = first.targets[0]!.physicalPath;
    await fs.copy(path.join(first.generation, 'skills', 'alpha'), foreign);
    const oldLock = path.join(value.options.context.executionCwd, 'skills-lock.json');
    await fs.writeFile(oldLock, '{broken old provider lock');
    const options = { ...value.options, agents: ['cursor', 'pi'] as ('cursor' | 'pi')[] };
    const prepared = await preparePortableRecovery(options);
    expect(prepared.targets[0]).toMatchObject({ ownership: 'external', observation: 'conflict' });
    const result = await withAwHomeMutationLock({ env: options.env, action: (token) =>
      executePortableRecovery({ prepared, token, authorizeUpdate: true }) });
    expect(result.execution).toBe('partial');
    expect(result.targets.map((target) => [target.agent, target.execution])).toEqual([['cursor', 'not-run'], ['pi', 'applied']]);
    expect(await fs.pathExists(path.join(foreign, '.agent-workflows-owner.json'))).toBe(false);
    expect(await fs.readFile(oldLock, 'utf8')).toBe('{broken old provider lock');
  }, 30_000);
});
