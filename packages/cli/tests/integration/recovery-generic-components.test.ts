import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { executeRecovery, prepareRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { materializePortableSkillsToDirectory } from '../../src/portable/commands.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('generic complete component expectations', () => {
  const plans: Awaited<ReturnType<typeof prepareRecovery>>[] = [];
  afterEach(async () => { await Promise.all(plans.splice(0).map((plan) => plan.context.dispose())); });
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
const skill = (id, text) => ({id, kind:'skill', name:id, content:{files:{
  'SKILL.md':{text:'---\\nname: '+id+'\\ndescription: Fixture skill.\\n---\\n'+text+'\\n'},
  'README.md':{text:'Fixture skill.\\n'}
}}});
const gap = id => ({id, kind:'skill', name:id, requiredFeatures:[{feature:'skill.execution',values:['isolated-context']}], reasonCode:'interface-unsupported'});
const mode = context.config.values.mode;
console.log(JSON.stringify({version:3,
  components: mode === 'initial' ? [skill('tool','Original tool.'),skill('keeper','Original keeper.')] : mode === 'mixed' ? [skill('fresh','New independent skill.')] : [],
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
