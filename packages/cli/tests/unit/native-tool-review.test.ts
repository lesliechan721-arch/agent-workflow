import fs from 'fs-extra';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nativeToolFixture } from '../helpers/native-tools.js';
import { createIsolatedTestEnv } from '../helpers/test-isolation.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import { createRebuildIntegration } from '../../src/commands/rebuild-integration.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import { buildOperationReviewProjection } from '../../src/tui/operation-review-planner.js';
import { buildRebuildReceiptJson } from '../../src/output/command-receipt.js';
import { prepareManagedCommandPackage } from '../../src/utils/managed-command-materialization.js';
import { syncManagedCommandPackage } from '../../src/utils/managed-command-store.js';
import type { CatalogResolution } from '../../src/types.js';

// Test Value Gate: actual producer preparation must expose added, changed and removed native execution
// authority through installation Review and the public receipt, even when the descriptor is unchanged.
describe('native producer Review and receipt', () => {
  it('shows complete native declarations and detects binding changes and removal', async () => {
    const isolated = await createIsolatedTestEnv();
    try {
      const root = path.join(isolated.layout.fixtureCwd, 'plugin');
      const fixture = nativeToolFixture();
      const manifest: Record<string, any> = {
        schemaVersion: 3, name: 'native-review', version: '1.0.0', description: 'Native review fixture.',
        requires: { aw: { capabilities: ['aw.managed-commands.v1', 'aw.native-tools.v1'] } },
        marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
        extensions: { permissions: [{ name: 'tool', allow: ['echo hello'] }] },
        managedCommands: { packages: [{ key: 'tools', scope: 'user', platforms: ['claude'], sourceDir: './tools' }],
          sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'tools' }, mode: 'static', entries: [{ key: 'run', runner: 'node', entry: 'run.mjs' }] }] },
        nativeTools: { definitions: [{ key: 'job', protocol: 'fixture.job.v1', descriptor: './job.lock.json' }], consumers: structuredClone(fixture.closure.consumers) },
      };
      const manifestPath = path.join(root, '.agents-plugin/plugin.json');
      await fs.outputJson(manifestPath, manifest);
      await fs.outputJson(path.join(root, 'job.lock.json'), fixture.closure.definitions[0]!.descriptor);
      await fs.outputFile(path.join(root, 'tools/run.mjs'), 'process.exit(0);\n');
      async function prepare() {
        const plugin = { ...await readPluginManifest(root), sourceId: 'fixture', sourceIdentity: `sha256:${'b'.repeat(64)}`, pluginId: 'fixture/native-review' };
        const context = createCommandExecutionContext({ env: isolated.env, nativeCliRunner: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }) });
        const target = await createRebuildIntegration({ context }).buildTarget({ plugin, platform: 'claude', scope: 'user', command: 'sync', cwd: isolated.layout.fixtureCwd,
          catalog: { rootDir: isolated.layout.fixtureCwd, source: 'local' } as CatalogResolution });
        const plan = createOperationPlan({ intentChanges: [], changes: [], warnings: [], actions: target.operationActions ?? [], evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] } });
        const review = buildOperationReviewProjection({ intent: { kind: 'pluginWrite', action: 'sync', pluginId: plugin.pluginId, platform: 'claude', scope: 'user' }, evidence: { catalog: { configDigest: 'fixture', compositeDigest: 'fixture' }, operationPlan: plan } });
        const receipt = buildRebuildReceiptJson('sync', { platforms: ['claude'], plugins: [plugin.pluginId], warnings: [], overallState: 'succeeded', operationPlan: plan });
        return { plugin, plan, review, receipt };
      }
      const added = await prepare();
      expect(added.receipt.nativeToolChanges).toEqual([{ producer: expect.objectContaining({ sourceId: 'fixture', pluginName: 'native-review' }), before: null, after: fixture.closure }]);
      expect(added.review.changes).toContainEqual(expect.objectContaining({ title: '使用原生工具 · fixture/native-review · tools', description: expect.stringContaining('@fixture/job-win32-x64@1.0.0') }));
      const candidate = await prepareManagedCommandPackage({ plugin: added.plugin, packageKey: 'tools', scope: 'user', cwd: isolated.layout.fixtureCwd, env: isolated.env });
      try { await syncManagedCommandPackage({ ...candidate, sourceDirectory: candidate.resourceRoot, env: isolated.env }); } finally { await candidate.cleanup(); }
      manifest.nativeTools.consumers[0].tools[0] = { key: 'job', platforms: ['win32'], policy: 'preferred', fallback: 'portable' };
      await fs.outputJson(manifestPath, manifest);
      const changed = await prepare();
      const change = changed.receipt.nativeToolChanges![0]!;
      expect(change.before!.definitions).toEqual(change.after!.definitions);
      expect(change.before!.consumers[0]!.tools[0]!.policy).toBe('required');
      expect(change.after!.consumers[0]!.tools[0]).toMatchObject({ policy: 'preferred', fallback: 'portable' });
      expect(changed.review.changes).toContainEqual(expect.objectContaining({ title: '撤销原生工具 · fixture/native-review · tools', description: expect.stringContaining('required') }));
      expect(changed.review.changes).toContainEqual(expect.objectContaining({ title: '使用原生工具 · fixture/native-review · tools', description: expect.stringContaining('preferred · fallback=portable') }));
      delete manifest.nativeTools;
      manifest.requires.aw.capabilities = ['aw.managed-commands.v1'];
      await fs.outputJson(manifestPath, manifest);
      const removed = await prepare();
      expect(removed.receipt.nativeToolChanges).toEqual([{ producer: change.producer, before: fixture.closure, after: null }]);
      expect(removed.review.changes).toContainEqual(expect.objectContaining({ title: '撤销原生工具 · fixture/native-review · tools' }));
    } finally { await isolated.cleanup(); }
  });
});
