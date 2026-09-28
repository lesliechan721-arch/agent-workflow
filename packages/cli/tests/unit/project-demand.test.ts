import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import type { NormalizedPluginManifest } from '../../src/types.js';
import { readProjectDemand, readNativeIntentProjection, resolveProjectDelivery } from '../../src/project/project-demand.js';
import { readProjectStatus, projectStatusFromObservations } from '../../src/project/project-status.js';
import { inventoryCatalogSourceReferences } from '../../src/utils/catalog-source-references.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

function manifest(): NormalizedPluginManifest {
  return {
    schemaVersion: 3, name: 'demo', version: '1.0.0', description: 'demo', skills: './skills',
    marketplace: { category: 'workflow', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    distributions: { agentSkills: { skills: './portable' } },
  };
}
async function fixture(value: unknown) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = path.join(isolation.layout.fixtureCwd, 'demand-project');
  await fs.ensureDir(path.join(cwd, '.git'));
  const filename = path.join(cwd, '.agent-workflows', 'plugin-intents.json');
  await fs.outputJson(filename, value);
  return { cwd, env: isolation.env, filename };
}
const declaration = {
  schemaVersion: 3, kind: 'aw-plugin-intents',
  sources: { team: { logicalIdentity: 'team' }, unused: { logicalIdentity: 'unused' } },
  roots: [{ pluginId: 'team/demo' }],
};

describe('project demand semantic readers', () => {
  // Test Value Gate: selected Native read/config errors fail status, but unsupported delivery is a blocker.
  it.each([
    ['configReadFailed', false], ['configInvalid', false], ['componentInspectionFailed', false],
    ['codexNativeObservationFailed', false], ['codexNativeKindUnsupported', true],
  ])('separates the Native %s diagnostic from ordinary blockers', async (code, ok) => {
    const options = await fixture(declaration);
    const demand = await readProjectDemand(options);
    demand.roots = [{ pluginId: 'team/demo', sourceId: 'team', sourceState: 'ready', blockers: [],
      plugin: { rootDir: options.cwd, manifestPath: '', manifest: manifest() } }];
    const nativeDiagnostic = { code, message: `${code}: safe diagnostic` };
    const status = await projectStatusFromObservations({
      ...options, cliVersion: '1.0.0', targets: ['codex'], demand,
      nativeObservations: [
        { pluginId: 'team/demo', platform: 'codex', content: 'unknown', blockers: [nativeDiagnostic] },
        { pluginId: 'team/demo', platform: 'claude', content: 'unknown',
          blockers: [{ code: 'nativeStateUnreadable', message: 'unselected target' }] },
      ],
    });
    expect(status.ok).toBe(ok);
    expect(status.errors).toEqual(ok ? [] : [nativeDiagnostic]);
    expect(status.allSatisfied).toBe(ok ? false : null);
    expect(status.inventory?.[0]?.targetResults[0]?.blockers).toEqual([nativeDiagnostic]);
  });

  // Test Value Gate: an empty project is a successful no-op without Catalog or consumer setup.
  it('reports a valid empty project as satisfied without creating output directories', async () => {
    const options = await fixture({ ...declaration, roots: [] });
    expect(await readProjectStatus(options)).toMatchObject({
      ok: true, inventory: [], allSatisfied: true, errors: [],
    });
    expect(await fs.pathExists(path.join(options.cwd, '.agents'))).toBe(false);
    expect(await fs.pathExists(path.join(options.cwd, '.claude'))).toBe(false);
  });

  // Test Value Gate: delivery determines which backend can mutate user files.
  it('prefers eligible Native and only uses explicit Portable', () => {
    const plugin = manifest();
    expect(resolveProjectDelivery(plugin, 'codex')).toEqual({ kind: 'native', platform: 'codex' });
    expect(resolveProjectDelivery(plugin, 'claude-code')).toEqual({ kind: 'native', platform: 'claude' });
    expect(resolveProjectDelivery(plugin, 'cursor')).toEqual({ kind: 'agent-skills', provider: 'skills-cli', agentId: 'cursor' });
    plugin.slashCommands = './commands';
    expect(resolveProjectDelivery(plugin, 'codex')?.kind).toBe('agent-skills');
    delete plugin.distributions;
    expect(resolveProjectDelivery(plugin, 'codex')).toBeUndefined();
    expect(resolveProjectDelivery(plugin, 'cursor')).toBeUndefined();
  });
  // Test Value Gate: source removal must see uninstalled roots without targets or Active.
  it('keeps unselected roots and source references but ignores unused bindings', async () => {
    const options = await fixture(declaration);
    const before = await fs.readFile(options.filename);
    const demand = await readProjectDemand(options);
    expect(demand.roots).toEqual([expect.objectContaining({ pluginId: 'team/demo', sourceState: 'missing', blockers: ['sourceMissing'] })]);
    expect((await readNativeIntentProjection(options)).roots).toEqual([{ pluginId: 'team/demo', platforms: ['codex', 'claude'] }]);
    const inventory = await inventoryCatalogSourceReferences(options);
    expect(inventory.references.filter((entry) => entry.kind === 'namespacedLifecycle')).toEqual([
      expect.objectContaining({ sourceId: 'team', pluginName: 'demo', scope: 'project' }),
    ]);
    expect(await fs.readFile(options.filename)).toEqual(before);
    const status = await projectStatusFromObservations({ ...options, cliVersion: '1.0.0', demand, nativeObservations: [] });
    expect(status).toMatchObject({ ok: true, allSatisfied: null, errors: [], selection: { agents: [] } });
    expect(status.inventory?.[0]?.blockers.map((entry) => entry.code)).toContain('localTargetsRequired');
  });
  // Test Value Gate: invalid strong config must not authorize cleanup as an empty project.
  it('retains invalid declarations as unknown and rejects Native projection', async () => {
    const options = await fixture({ ...declaration, roots: [{ pluginId: 'team/demo', platforms: ['codex'] }] });
    const demand = await readProjectDemand(options);
    expect(demand.intent.state).toBe('invalid');
    expect(demand.roots).toBeNull();
    await expect(readNativeIntentProjection(options)).rejects.toThrow('pluginIntentStateInvalid');
    expect((await inventoryCatalogSourceReferences(options)).errors.length).toBeGreaterThan(0);
    const status = await projectStatusFromObservations({ ...options, cliVersion: '1.0.0', demand, nativeObservations: [] });
    expect(status).toMatchObject({ ok: false, allSatisfied: null, inventory: null });
  });
  // Test Value Gate: aggregate status must preserve failures ahead of unknown targets.
  it('reports unsupported targets as false while retaining an unknown root', async () => {
    const options = await fixture(declaration);
    const demand = await readProjectDemand(options);
    const plugin = manifest();
    delete plugin.distributions;
    demand.roots!.push({ pluginId: 'team/unsupported', sourceId: 'team', sourceState: 'ready', blockers: [], plugin: {
      rootDir: options.cwd, manifestPath: '', manifest: plugin,
    } });
    const status = await projectStatusFromObservations({ ...options, cliVersion: '1.0.0', targets: ['cursor'], demand, nativeObservations: [] });
    expect(status.allSatisfied).toBe(false);
    expect(status.inventory).toHaveLength(2);
    expect(status.inventory?.[1]?.targetResults[0]?.blockers).toEqual([expect.objectContaining({ code: 'deliveryUnsupported' })]);
  });
});
