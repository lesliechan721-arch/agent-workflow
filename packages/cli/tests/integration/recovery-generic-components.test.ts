import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { executeRecovery, prepareRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { materializePortableSkillsToDirectory, setPortableCommandTestHooksForTests } from '../../src/portable/commands.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { CatalogPreparationReadScope } from '../../src/utils/catalog-operation-context.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('generic complete component expectations', () => {
  const plans: Awaited<ReturnType<typeof prepareRecovery>>[] = [];
  afterEach(async () => { await Promise.all(plans.splice(0).map((plan) => plan.context.dispose())); });
  // Shared dependency rendering must not launch one subprocess per requested root.
  it('prepares one render per dependency batch across generic install roots', async () => {
    const { layout, env } = getCurrentSourceTestIsolation();
    const cwd = layout.fixtureCwd;
    const source = path.join(cwd, 'shared-renderer-catalog');
    const calls = path.join(cwd, 'shared-renderer-calls.jsonl');
    await fs.outputFile(path.join(source, 'plugins/provider/render.mjs'), `import fs from 'node:fs';
const c = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
const skill = c.allowedOutputKinds.includes('skill');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({skill, hasToken: Object.hasOwn(c.config.values, 'token')}) + '\\n');
console.log(JSON.stringify({version:3, components: skill ? [{
  id:'provider', name:'provider', kind:'skill', content:{files:{
    'SKILL.md':{text:'---\\nname: provider\\ndescription: Provider fixture.\\n---\\nProvider body.\\n'},
    'README.md':{text:'Provider fixture.'}
  }}
}] : [], omitted:[], unmet:[]}));
`);
    for (const name of ['left', 'right']) {
      await fs.outputFile(path.join(source, 'plugins', name, 'skills', name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Fixture ${name}.\n---\nConsumer body.\n`);
      await fs.outputFile(path.join(source, 'plugins', name, 'skills', name, 'README.md'), `Fixture ${name}.`);
    }
    await createDependencyCatalogSnapshotFixture(source, ['provider', 'left', 'right'].map((name) => ({
      name, ...(name === 'provider' ? {} : { dependencies: ['provider'] }),
      configureManifest: (manifest) => {
        manifest.platforms = ['generic'];
        delete manifest.extensions;
        if (name === 'provider') {
          manifest.artifacts = { configKeys: ['token'] };
          manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
          manifest.config = { schemaVersion: 5, fields: { token: { type: 'string', sensitive: true } } };
        } else manifest.skills = './skills';
      },
    })));
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    const active = (await readCatalogGenerationState(env)).sources.local!.active!;
    await writePluginConfigStore({ sourceId: 'local', sourceIdentity: active.sourceIdentity,
      pluginName: 'provider', scope: 'user', cwd, env, values: { token: 'fixture-private-token' } });
    await setTargets({ cwd, env, scope: 'user' }, ['generic']);
    const plan = await prepareRecovery('install', ['local/left', 'local/right'], {
      context: 'user', cwd, env, cliVersion: '1.0.0', targets: ['generic'], yes: true,
    });
    plans.push(plan);
    expect(await fs.pathExists(calls), JSON.stringify(plan.receipt)).toBe(true);
    const records = (await fs.readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records).toEqual([{ skill: true, hasToken: false }, { skill: false, hasToken: true }]);
    const receipt = await executeRecovery(plan, { yes: true });
    expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
    for (const name of ['left', 'right', 'provider']) {
      await expect(fs.readFile(path.join(env.HOME!, '.agents/skills', name, 'SKILL.md'), 'utf8')).resolves.toContain(`name: ${name}`);
    }
    expect((await fs.readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(2);

    // A reused render result does not authorize a second generation commit.
    // Give both export requests one preparation read window, then mutate the
    // dependency on disk after the cached render has produced the staged bytes.
    const readScope = new CatalogPreparationReadScope({ env });
    const catalogOperationContext = await readScope.resolve({ sourceIds: ['local'] }, true);
    const exportOptions = { platform: 'generic' as const, scope: 'user' as const, cwd, env,
      cliVersion: '1.0.0', allowUnmet: true, preparedResults: new Map(), catalogOperationContext };
    const firstOutput = path.join(cwd, 'left-export');
    const secondOutput = path.join(cwd, 'right-export');
    await materializePortableSkillsToDirectory({ ...exportOptions, selector: 'local/left', out: firstOutput }, readScope);
    const location = resolveCatalogStoreLocation({ ...active, env });
    setPortableCommandTestHooksForTests({
      beforeMaterializeOutputCommit: async () => fs.appendFile(
        path.join(location.snapshotRoot, 'plugins/provider/render.mjs'), '\n// changed while staged\n'),
    });
    try {
      await expect(materializePortableSkillsToDirectory({ ...exportOptions, selector: 'local/right', out: secondOutput }, readScope))
        .rejects.toMatchObject({ code: 'catalogGenerationMetadataInvalid' });
    } finally { setPortableCommandTestHooksForTests(undefined); }
    expect((await fs.readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(4);
    await expect(fs.pathExists(secondOutput)).resolves.toBe(false);
    await expect(fs.readFile(path.join(firstOutput, 'skills/provider/SKILL.md'), 'utf8')).resolves.toContain('Provider body.');

  });

  // Test Value Gate: valid capability gaps must preserve old owned bytes, allow independent supported work,
  // and remain visible through Review, execution and read-only status; only intentional empty permits removal.
  it('keeps unmet Skills distinct from supported work and intentional empty output', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = path.join(isolation.layout.fixtureCwd, 'caller');
    const source = path.join(isolation.layout.fixtureCwd, 'catalog');
    const pluginRoot = path.join(source, 'plugins/demo');
    const calls = path.join(isolation.layout.fixtureCwd, 'renderer-calls');
    await fs.ensureDir(cwd);
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), `import fs from 'node:fs';
const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
fs.appendFileSync(${JSON.stringify(calls)}, 'render\\n');
if (!context.allowedOutputKinds.includes('skill')) {
  const role = {id:'reviewer', name:'reviewer', kind:'agent', content:{description:'Review',prompt:'Review the change.'}};
  console.log(JSON.stringify({version:3,components:context.config.values.mode === 'role' ? [role] : [],omitted:[],unmet:[]})); process.exit(0);
}
const skill = (id, text, policy = '') => ({id, kind:'skill', name:id, content:{files:{
  'SKILL.md':{text:'---\\nname: '+id+'\\ndescription: Fixture skill.\\n'+policy+'---\\n'+text+'\\n'},
  'README.md':{text:'Fixture skill.\\n'}
}}});
const gap = id => ({id, kind:'skill', name:id, requiredFeatures:[{feature:'skill.execution',values:['isolated-context']}], reasonCode:'interface-unsupported'});
const mode = context.config.values.mode;
console.log(JSON.stringify({version:3,
  components: mode === 'initial' ? [skill('tool','Original tool.'),skill('keeper','Original keeper.')] : mode === 'mixed' ? [skill('fresh','New independent skill.')]
    : mode === 'manual' ? [skill('fresh','New independent skill.'), skill('tool','Now delivered by explicit request.',
      'user-invocable: true\\ndisable-model-invocation: true\\n')] : [],
  omitted:[], unmet: mode === 'unmet' ? [gap('tool'),gap('keeper')] : mode === 'mixed' ? [gap('tool')] : []}));
`);
    await createCatalogSnapshotFixture(source, 'demo', [], 'Generic components fixture.', (manifest) => {
      manifest.schemaVersion = 4;
      manifest.platforms = ['generic'];
      manifest.artifacts = { configKeys: ['mode'] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
      manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: 'initial' } } };
    });
    const env = isolation.env;
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    const active = (await readCatalogGenerationState(env)).sources.local!.active!;
    await writeIntentFixture({ scope: 'user', cwd, env }, { roots: [{ pluginId: 'local/demo' }], targets: ['generic'] });
    const options = { scope: 'user' as const, context: 'user' as const, cwd, env, cliVersion: '1.0.0', yes: true };
    const prepare = async () => {
      const plan = await prepareRecovery('sync', [], options);
      plans.push(plan);
      return plan;
    };
    const initial = await runRecovery('sync', [], options);
    expect(initial.ok, JSON.stringify(initial)).toBe(true);
    const output = path.join(env.HOME!, '.agents/skills');
    const oldTool = await fs.readFile(path.join(output, 'tool/SKILL.md'));
    const oldKeeper = await fs.readFile(path.join(output, 'keeper/SKILL.md'));
    const configure = async (mode: string) => writePluginConfigStore({ sourceId: 'local', sourceIdentity: active.sourceIdentity,
      pluginName: 'demo', platform: 'generic', scope: 'user', cwd, env, values: { mode } });
    const groupTargets = (plan: Awaited<ReturnType<typeof prepareRecovery>>) =>
      (plan.joint?.children ?? [plan]).flatMap((child) => child.portableGroups).flatMap((group) => group.targets);
    const read = async () => {
      const before = await fs.readFile(calls, 'utf8');
      const status = await readRecoveryStatus({ context: 'user', cwd, env });
      expect(await fs.readFile(calls, 'utf8')).toBe(before);
      return status;
    };

    await configure('unmet');
    const blocked = await prepare();
    expect(groupTargets(blocked).some((target) => target.disposition === 'remove')).toBe(false);
    expect(blocked.changes.join('\n')).toContain('skill.execution: isolated-context');
    const unmetExport = path.join(cwd, 'unmet-export');
    await expect(materializePortableSkillsToDirectory({ selector: 'local/demo', platform: 'generic', scope: 'user', cwd, env,
      cliVersion: '1.0.0', out: unmetExport })).rejects.toMatchObject({ code: 'portableComponentsUnmet' });
    expect(await fs.pathExists(unmetExport)).toBe(false);
    const unmet = await executeRecovery(blocked, { yes: true });
    expect(unmet.ok).toBe(false);
    expect(unmet.targetResults).toEqual(expect.arrayContaining([expect.objectContaining({ agent: 'generic', execution: 'not-run',
      componentGaps: expect.arrayContaining([expect.objectContaining({ id: 'tool', providerPluginId: 'local/demo',
        requiredFeatures: [{ feature: 'skill.execution', values: ['isolated-context'] }] })]) })]));
    expect(await fs.readFile(path.join(output, 'tool/SKILL.md'))).toEqual(oldTool);
    expect(await fs.readFile(path.join(output, 'keeper/SKILL.md'))).toEqual(oldKeeper);
    const unmetStatus = await read();
    expect(unmetStatus.allSatisfied).not.toBe(true);
    expect(unmetStatus.inventory![0]!.targetResults[0]!.componentGaps).toHaveLength(2);

    await configure('mixed');
    const partial = await prepare();
    expect(groupTargets(partial).filter((target) => target.skill === 'tool').every((target) => target.disposition === 'retain')).toBe(true);
    const mixedExport = path.join(cwd, 'mixed-export');
    await expect(materializePortableSkillsToDirectory({ selector: 'local/demo', platform: 'generic', scope: 'user', cwd, env,
      cliVersion: '1.0.0', out: mixedExport })).rejects.toMatchObject({ code: 'portableComponentsUnmet' });
    expect(await fs.pathExists(mixedExport)).toBe(false);
    const mixed = await executeRecovery(partial, { yes: true });
    expect(mixed.ok).toBe(false);
    expect(mixed.targetResults).toEqual(expect.arrayContaining([expect.objectContaining({ agent: 'generic', execution: 'partial',
      componentGaps: [expect.objectContaining({ id: 'tool' })] })]));
    expect(await fs.readFile(path.join(output, 'tool/SKILL.md'))).toEqual(oldTool);
    expect(await fs.readFile(path.join(output, 'fresh/SKILL.md'), 'utf8')).toContain('New independent skill.');
    const partialStatus = await read();
    expect(partialStatus.allSatisfied).not.toBe(true);
    expect(partialStatus.inventory![0]!.targetResults[0]!.componentGaps).toEqual([expect.objectContaining({ id: 'tool' })]);

    // Recover an existing installation with retained old bytes when its new
    // revision can be delivered and only the host invocation policy is unknown.
    await configure('manual');
    const upgraded = await runRecovery('sync', [], options);
    expect(upgraded.ok, JSON.stringify(upgraded)).toBe(true);
    expect(upgraded.targetResults).toContainEqual(expect.objectContaining({ agent: 'generic', execution: 'applied', content: 'satisfied' }));
    const updated = await fs.readFile(path.join(output, 'tool/SKILL.md'), 'utf8');
    expect(updated).toContain('Now delivered by explicit request.');
    expect(updated).toContain('skill.invocation.model');
    expect(await fs.readFile(path.join(output, 'fresh/SKILL.md'), 'utf8')).toContain('New independent skill.');
    expect((await read()).allSatisfied).toBe(true);

    // The old owner marker still identifies the directory after a user adds a file.
    // A new complete declaration may retire only the other, unmodified Skill.
    const personalNote = path.join(output, 'tool', 'notes.txt');
    await fs.writeFile(personalNote, 'Personal notes.');
    await configure('role');
    const withUserFile = await prepare();
    expect(groupTargets(withUserFile)).toEqual(expect.arrayContaining([
      expect.objectContaining({ skill: 'tool', disposition: 'retain', blocker: 'previousDeploymentRetained' }),
      expect.objectContaining({ skill: 'fresh', disposition: 'remove' }),
    ]));
    expect((await executeRecovery(withUserFile, { yes: true })).ok).toBe(false);
    expect(await fs.readFile(personalNote, 'utf8')).toBe('Personal notes.');
    expect(await fs.pathExists(path.join(output, 'fresh'))).toBe(false);
    await fs.unlink(personalNote);

    await configure('empty');
    const empty = await prepare();
    expect(groupTargets(empty).length).toBeGreaterThan(0);
    expect(groupTargets(empty).every((target) => target.disposition === 'remove')).toBe(true);
    const cleared = await executeRecovery(empty, { yes: true });
    expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
    expect(cleared.targetResults).toEqual(expect.arrayContaining([expect.objectContaining({ agent: 'generic', execution: 'applied', content: 'satisfied' })]));
    expect(await fs.pathExists(path.join(output, 'tool'))).toBe(false);
    expect(await fs.pathExists(path.join(output, 'fresh'))).toBe(false);
    expect((await read()).allSatisfied).toBe(true);
  });
});
