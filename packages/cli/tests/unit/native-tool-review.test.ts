import fs from 'fs-extra';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nativeToolFixture } from '../helpers/native-tools.js';
import { createIsolatedTestEnv } from '../helpers/test-isolation.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import { createRebuildIntegration, disposePreparedPlatformRebuildSession } from '../../src/commands/rebuild-integration.js';
import { executeRebuildOperation } from '../../src/commands/rebuild-operations.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import { buildOperationReviewProjection } from '../../src/tui/operation-review-planner.js';
import { buildRebuildReceiptJson } from '../../src/output/command-receipt.js';
import { prepareManagedCommandPackage } from '../../src/utils/managed-command-materialization.js';
import { syncManagedCommandPackage } from '../../src/utils/managed-command-store.js';
import type { CatalogResolution } from '../../src/types.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';

// Test Value Gate: actual producer preparation must expose added, changed and removed native execution
// authority through installation Review and the public receipt, even when the protocol is unchanged.
describe('native producer Review and receipt', () => {
  it.each(['package', 'skill'] as const)('shows complete %s native declarations and detects binding changes and removal', async (kind) => {
    installNativeTestQualification({ platforms: ['opencode'], discovery: true, trust: true });
    const isolated = await createIsolatedTestEnv();
    const sessions: Map<string, import('../../src/utils/plugin-scripts.js').PluginProcessResult>[] = [];
    try {
      const root = path.join(isolated.layout.fixtureCwd, 'plugin');
      const bin = path.join(isolated.layout.fixtureCwd, 'bin');
      await fs.outputFile(path.join(bin, `opencode${process.platform === 'win32' ? '.exe' : ''}`), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const env = { ...isolated.env, PATH: `${bin}${path.delimiter}${isolated.env.PATH ?? ''}` };
      const fixture = nativeToolFixture();
      const manifest: Record<string, any> = {
        schemaVersion: 4, name: 'native-review', version: '1.0.0', description: 'Native review fixture.', platforms: ['opencode'],
        requires: { aw: { capabilities: ['aw.managed-commands.v1', 'aw.native-tools.v2'] } },
        marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
        managedCommands: { packages: [{ key: 'tools', scope: 'user', platforms: ['opencode'], sourceDir: './tools' }],
          sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'tools' }, mode: 'static', entries: [{ key: 'run', runner: 'node', entry: 'run.mjs' }] }] },
        nativeTools: { definitions: [{ key: 'job', protocol: 'aw.windows-job.v1' }], consumers: structuredClone(fixture.closure.consumers) },
      };
      if (kind === 'skill') {
        manifest.skills = './skills';
        manifest.managedCommands = { sets: [{ set: 'tools', producer: { kind: 'static-skill', platform: 'opencode', skillKey: 'provider' },
          mode: 'static', entries: [{ key: 'run', runner: 'node', entry: 'run.mjs' }] }] };
        await fs.outputFile(path.join(root, 'skills/provider/SKILL.md'), '---\nname: provider\ndescription: Native tool Review fixture.\n---\nProvider.\n');
        await fs.outputFile(path.join(root, 'skills/provider/run.mjs'), 'process.exitCode = 0;\n');
      }
      const manifestPath = path.join(root, '.agents-plugin/plugin.json');
      await fs.outputJson(manifestPath, manifest);
      await fs.outputFile(path.join(root, 'tools/run.mjs'), 'process.exit(0);\n');
      async function prepare() {
        const plugin = { ...await readPluginManifest(root), sourceId: 'fixture', sourceIdentity: `sha256:${'b'.repeat(64)}`, pluginId: 'fixture/native-review' };
        const context = { ...createCommandExecutionContext({ env, nativeCliRunner: async () => ({ exitCode: 0, stdout: 'opencode 2.0.0', stderr: '' }) }), preparedArtifactRenderResults: new Map() };
        sessions.push(context.preparedArtifactRenderResults);
        const integration = createRebuildIntegration({ context });
        const target = await integration.buildTarget({ plugin, platform: 'opencode', scope: 'user', command: 'sync', cwd: isolated.layout.fixtureCwd,
          catalog: { rootDir: isolated.layout.fixtureCwd, source: 'local' } as CatalogResolution });
        await integration.sealMarketplaceGenerations([target]);
        const plan = createOperationPlan({ intentChanges: [], changes: [], warnings: [], actions: target.operationActions ?? [], nativeToolChanges: target.nativeToolChanges,
          deploymentPlans: target.platformDeployment?.plans, evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] } });
        const review = buildOperationReviewProjection({ intent: { kind: 'pluginWrite', action: 'sync', pluginId: plugin.pluginId, platform: 'opencode', scope: 'user' }, evidence: { catalog: { configDigest: 'fixture', compositeDigest: 'fixture' }, operationPlan: plan } });
        const receipt = buildRebuildReceiptJson('sync', { platforms: ['opencode'], plugins: [plugin.pluginId], warnings: [], overallState: 'succeeded', operationPlan: plan });
        return { plugin, plan, review, receipt, target, integration };
      }
      const added = await prepare();
      expect(added.receipt.nativeToolChanges).toEqual([{ producer: expect.objectContaining({ sourceId: 'fixture', pluginName: 'native-review' }), before: null, after: fixture.closure }]);
      expect(added.receipt.nativeToolChanges![0]!.producer.placementKey).toEqual(kind === 'package' ? null : expect.stringMatching(/^sha256:[0-9a-f]{64}$/u));
      const label = kind === 'package' ? 'tools' : 'provider';
      expect(added.review.changes).toContainEqual(expect.objectContaining({ title: `使用原生工具 · fixture/native-review · ${label}`, description: expect.stringContaining('aw.windows-job.v1') }));
      if (kind === 'package') {
        const candidate = await prepareManagedCommandPackage({ plugin: added.plugin, packageKey: 'tools', scope: 'user', cwd: isolated.layout.fixtureCwd, env });
        try { await syncManagedCommandPackage({ ...candidate, sourceDirectory: candidate.resourceRoot, env }); } finally { await candidate.cleanup(); }
      } else {
        expect(added.plan.actions.some((action) => action.kind === 'materializeNativeSkill' || action.kind === 'writeOwnedArtifact')).toBe(false);
        expect(added.plan.nativeToolChanges?.[0]?.producer.placementKey).toMatch(/^sha256:[0-9a-f]{64}$/u);
        const result = await executeRebuildOperation({ command: 'sync', target: added.target, driver: added.integration.driver });
        expect(result.status, JSON.stringify(result)).toBe('succeeded');
      }
      manifest.nativeTools.consumers[0].tools[0] = { key: 'job', platforms: ['win32'], policy: 'preferred', fallback: 'portable' };
      await fs.outputJson(manifestPath, manifest);
      const changed = await prepare();
      const change = changed.receipt.nativeToolChanges![0]!;
      expect(change.before!.definitions).toEqual(change.after!.definitions);
      expect(change.before!.consumers[0]!.tools[0]!.policy).toBe('required');
      expect(change.after!.consumers[0]!.tools[0]).toMatchObject({ policy: 'preferred', fallback: 'portable' });
      expect(changed.review.changes).toContainEqual(expect.objectContaining({ title: `撤销原生工具 · fixture/native-review · ${label}`, description: expect.stringContaining('required') }));
      expect(changed.review.changes).toContainEqual(expect.objectContaining({ title: `使用原生工具 · fixture/native-review · ${label}`, description: expect.stringContaining('preferred · fallback=portable') }));
      delete manifest.nativeTools;
      manifest.requires.aw.capabilities = ['aw.managed-commands.v1'];
      await fs.outputJson(manifestPath, manifest);
      const removed = await prepare();
      expect(removed.receipt.nativeToolChanges).toEqual([{ producer: change.producer, before: fixture.closure, after: null }]);
      expect(removed.review.changes).toContainEqual(expect.objectContaining({ title: `撤销原生工具 · fixture/native-review · ${label}` }));
    } finally { await Promise.all(sessions.map(disposePreparedPlatformRebuildSession)); await isolated.cleanup(); }
  });
});
