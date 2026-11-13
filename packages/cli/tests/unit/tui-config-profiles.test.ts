import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { prepareRecovery, executeRecovery } from '../../src/recovery/coordinator.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { TuiController } from '../../src/tui/controller.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { configReferenceSelection } from '../../src/tui/config-references.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { readPluginConfigStore, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(withGenericSkill = false) {
  const isolation = getCurrentSourceTestIsolation();
  const sourceRoot = path.join(isolation.layout.fixtureCwd, 'config-profiles');
  if (withGenericSkill) {
    const skill = path.join(sourceRoot, 'plugins/demo/skills/example');
    await fs.outputFile(path.join(skill, 'SKILL.md'),
      '---\nname: example\ndescription: Configuration apply fixture\n---\nRun this fixture.\n');
    await fs.outputFile(path.join(skill, 'README.md'), 'Configuration apply fixture.\n');
    await fs.copy(path.join(sourceRoot, 'plugins/demo/skills'), path.join(sourceRoot, 'plugins/demo/generic/skills'));
  }
  await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'Configuration profiles', (manifest) => {
    if (withGenericSkill) { manifest.skills = './skills'; manifest.platforms = ['generic']; }
    manifest.config = {
      schemaVersion: 5,
      fields: {
        model: { type: 'string', default: 'common-default' },
        list: { type: 'array', items: { type: 'string' }, default: [] },
        enabled: { type: 'boolean', default: true },
        count: { type: 'number', default: 1 },
        token: { type: 'string', sensitive: true },
        registry: { type: 'array', validation: { uniqueBy: 'key' }, items: {
          type: 'object', properties: { key: { type: 'string', required: true }, label: { type: 'string' } },
        } },
        selected: { type: 'string', default: 'native', valueRef: {
          field: 'registry', key: 'key', label: 'label', include: ['native'],
        } },
      },
      platforms: {
        codex: { fields: { model: { type: 'string', default: 'codex-default', choices: {
          allowCustom: false, presets: [
            { id: 'default', title: 'Default', value: 'codex-default' },
            { id: 'stored', title: 'Stored', value: 'codex-stored' },
          ],
        } } } },
        claude: { fields: { model: { type: 'string', default: 'claude-default', choices: {
          allowCustom: false, presets: [{ id: 'default', title: 'Default', value: 'claude-default' }],
        } } } },
      },
    };
  });
  if (withGenericSkill) {
    const root = path.join(sourceRoot, 'plugins/demo');
    const plugin = await readPluginManifest(root, { mode: 'bundle' });
    await fs.outputJson(path.join(root, 'generic/skills/example/aw-plugin-requirements.json'),
      createAwPluginRequirementsReceipt({ name: 'demo', version: '1.0.0' }, plugin.manifest.requires?.aw.capabilities ?? []));
    const catalogPath = path.join(sourceRoot, 'catalog-manifest.json');
    await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath),
      entries: [await createCatalogManifestV7Entry(plugin, root)] });
  }
  const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
    { id: 'team', type: 'path', primary: true, path: sourceRoot },
  ] }, expectedDigest: initial.digest, env: isolation.env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
  const dependencies = createTuiControllerDependencies(createCliExecutionContext({
    cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false,
  }));
  const availability = await dependencies.getConfigResetAvailability!('team/demo', {}, new AbortController().signal);
  const identity = { sourceId: 'team', sourceIdentity: availability.sourceIdentity!, pluginName: 'demo',
    scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
  await writePluginConfigStore({ ...identity, values: {
    model: 'common-stored', list: ['first', 'second'], registry: [{ key: 'common', label: 'Common' }],
  } });
  await writePluginConfigStore({ ...identity, platform: 'codex', values: {
    model: 'codex-stored', list: ['only'], enabled: false, count: 0,
    token: 'private-profile-token', registry: [{ key: 'codex', label: 'Codex' }],
  } });
  await writePluginConfigStore({ ...identity, platform: 'claude', values: {
    list: [], registry: [{ key: 'claude', label: 'Claude' }],
  } });
  return { dependencies, identity };
}

describe('TUI user configuration profiles', () => {
  it('projects compiled schema, whole values and same-profile references without exposing secrets', async () => {
    const { dependencies } = await fixture();
    const signal = new AbortController().signal;
    const codex = await dependencies.getConfigPage!('team/demo', { platform: 'codex' }, signal);
    const claude = await dependencies.getConfigPage!('team/demo', { platform: 'claude' }, signal);
    const common = await dependencies.getConfigPage!('team/demo', {}, signal);
    await expect(dependencies.getConfigPage!('team/demo', { context: 'project' }, signal))
      .rejects.toThrow('projectRootUnavailable');
    const fields = codex.groups.flatMap((group) => group.fields);
    expect(codex).toMatchObject({ profile: 'codex', context: 'user', layer: { profile: 'codex' } });
    expect(fields.find((field) => field.key === 'model')).toMatchObject({
      effectiveValue: 'codex-stored', defaultValue: 'codex-default', fallbackSourceLabel: '公共配置',
      fallbackDisplayValue: '值无效；保存可成功，但应用会被阻止',
    });
    expect(fields.find((field) => field.key === 'list')?.effectiveValue).toEqual(['only']);
    expect(fields.find((field) => field.key === 'enabled')?.effectiveValue).toBe(false);
    expect(fields.find((field) => field.key === 'count')?.effectiveValue).toBe(0);
    expect(claude.groups.flatMap((group) => group.fields).find((field) => field.key === 'list')?.effectiveValue).toEqual([]);
    expect(claude.groups.flatMap((group) => group.fields).find((field) => field.key === 'model')).toMatchObject({
      defaultValue: 'claude-default', invalidOverrideOwnedByLayer: false, effectiveSourceLabel: '公共配置',
    });
    expect(common.groups.flatMap((group) => group.fields).find((field) => field.key === 'list')?.effectiveValue).toEqual(['first', 'second']);
    expect(JSON.stringify(codex)).not.toContain('private-profile-token');
    expect(codex.editEvidence?.schemaIdentity).not.toBe(claude.editEvidence?.schemaIdentity);
    const scalar = fields.find((field) => field.key === 'selected')!.definition;
    if (scalar.type !== 'string') throw new Error('Expected the reference scalar.');
    const codexReferences = await dependencies.getConfigReferenceContext!('team/demo', { platform: 'codex' }, { updates: {}, removes: [] }, signal);
    const claudeReferences = await dependencies.getConfigReferenceContext!('team/demo', { platform: 'claude' }, { updates: {}, removes: [] }, signal);
    expect(configReferenceSelection(codexReferences, scalar).choices.map((choice) => choice.value).sort()).toEqual(['codex', 'native']);
    expect(configReferenceSelection(claudeReferences, scalar).choices.map((choice) => choice.value).sort()).toEqual(['claude', 'native']);
  });

  it('saves a user profile in place and rejects changes made after the editor read', async () => {
    const { dependencies, identity } = await fixture();
    const controller = new TuiController(dependencies);
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'team/demo' });
    controller.beginConfigFlow('team/demo', { platform: 'codex' });
    const before = controller.snapshot.router;
    const page = await controller.getConfigPage('team/demo', { platform: 'codex' });
    const saved = await controller.saveConfigDraft({
      kind: 'configSave', pluginId: 'team/demo', platform: 'codex', context: 'user', apply: false,
      updates: { token: 'new-private-token', list: [] }, sensitiveKeys: ['token'],
      editEvidence: { list: page.editEvidence! },
    });
    expect(saved).toEqual({ status: 'succeeded', savedProfiles: ['codex'], failedProfiles: [] });
    expect(controller.snapshot.router).toEqual(before);
    expect(controller.snapshot.activeReview).toBeUndefined();
    expect(JSON.stringify(controller.snapshot)).not.toContain('new-private-token');
    expect((await readPluginConfigStore({ ...identity, platform: 'codex' })).values.list).toEqual([]);
    expect((await readPluginConfigStore(identity)).values.list).toEqual(['first', 'second']);
    const next = await controller.getConfigPage('team/demo', { platform: 'codex' });
    await writePluginConfigStore({ ...identity, platform: 'claude', values: { list: ['outside'] } });
    await expect(controller.saveConfigDraft({
      kind: 'configSave', pluginId: 'team/demo', platform: 'codex', apply: false,
      updates: { count: 10 }, editEvidence: { count: next.editEvidence! },
    })).rejects.toMatchObject({ code: 'operationReviewStale' });
    expect((await readPluginConfigStore({ ...identity, platform: 'codex' })).values.count).toBe(0);
    controller.dispose();
  });

  it('saves multiple profiles in one document without invalidating the next profile evidence', async () => {
    const { dependencies, identity } = await fixture();
    const controller = new TuiController(dependencies);
    await controller.load();
    const common = await controller.getConfigPage('team/demo', {});
    const codex = await controller.getConfigPage('team/demo', { platform: 'codex' });
    const saved = await controller.saveConfigDraft({
      kind: 'configSaveBatch', pluginId: 'team/demo', context: 'user', apply: false,
      groups: [
        { updates: { count: 3 }, editEvidence: { count: common.editEvidence! } },
        { platform: 'codex', updates: { count: 4 }, editEvidence: { count: codex.editEvidence! } },
      ],
    });
    expect(saved).toEqual({ status: 'succeeded', savedProfiles: ['common', 'codex'], failedProfiles: [] });
    expect((await readPluginConfigStore(identity)).values.count).toBe(3);
    expect((await readPluginConfigStore({ ...identity, platform: 'codex' })).values.count).toBe(4);
    expect((await readPluginConfigStore({ ...identity, platform: 'claude' })).values.list).toEqual([]);
    controller.dispose();
  });

  it('reviews only existing generic outputs and refreshes them without a second config write', async () => {
    const { dependencies, identity } = await fixture(true);
    const isolation = getCurrentSourceTestIsolation();
    const options = { scope: 'user' as const, context: 'user' as const,
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0' };
    await writeIntentFixture(options, {
      roots: [{ pluginId: 'team/demo' }], targets: ['generic', 'cursor', 'codex'],
      exclusions: [{ plugin: 'team/demo', target: 'codex' }],
    });
    const install = await prepareRecovery('sync', ['team/demo'], options, createCliExecutionContext(options));
    const installed = await executeRecovery(install, { yes: true });
    expect(installed.ok, JSON.stringify({ blockers: installed.blockers, errors: installed.errors,
      targets: installed.targetResults }, null, 2)).toBe(true);
    const controller = new TuiController(dependencies);
    await controller.load();
    const originalIntent = await observeIntent(options);
    await controller.saveConfigDraft({
      kind: 'configSave', pluginId: 'team/demo', platform: 'generic', context: 'user',
      apply: false, updates: { count: 2 },
    });
    const store = await readPluginConfigStore({ ...identity, platform: 'generic' });
    const review = await controller.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', context: 'user',
      apply: true, retryApply: true,
    });
    expect(review.configImpact?.affectedTargetCount).toBe(1);
    expect(review.changes.some((change) => change.title.includes('Generic'))).toBe(true);
    const result = await controller.executeOperation(review.reviewToken);
    expect(result.state, JSON.stringify(result)).toBe('succeeded');
    if (!('summary' in result) || !result.summary) throw new Error('Expected the configuration apply result.');
    expect(result.summary.configTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'generic', scope: 'user', state: 'completed' }),
    ]));
    expect(result.summary.configTargets).toHaveLength(1);
    expect((await readPluginConfigStore({ ...identity, platform: 'generic' })).rawDigest).toBe(store.rawDigest);
    expect(await observeIntent(options)).toEqual(originalIntent);
    controller.dispose();
  });
});
