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
import type { CatalogResolution } from '../../src/types.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';

// Test Value Gate: actual producer preparation must expose added, changed and removed native execution
// authority through installation Review and the public receipt, even when the protocol is unchanged.
describe('native producer Review and receipt', () => {
  it('shows added, changed and removed native requirements for the shared command package', async () => {
    installNativeTestQualification({ platforms: ['opencode'], discovery: true });
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
        requires: { aw: { capabilities: ['aw.managed-commands.v2', 'aw.native-tools.v3'] } },
        marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
        command: { sourceDir: './tools', mode: 'static', routes: { fallback: { runner: 'node', entry: 'run.mjs' } } },
        nativeTools: { definitions: [{ key: 'job', protocol: 'aw.windows-job.v1' }], consumers: structuredClone(fixture.closure.consumers) },
      };
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
        const plan = createOperationPlan({ intentChanges: [], changes: [], warnings: [], actions: target.operationActions ?? [],
          deploymentPlans: target.platformDeployment?.plans, evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] } });
        const review = buildOperationReviewProjection({ intent: { kind: 'pluginWrite', action: 'sync', pluginId: plugin.pluginId, platform: 'opencode', scope: 'user' }, evidence: { catalog: { configDigest: 'fixture', compositeDigest: 'fixture' }, operationPlan: plan } });
        const receipt = buildRebuildReceiptJson('sync', { platforms: ['opencode'], plugins: [plugin.pluginId], warnings: [], overallState: 'succeeded', operationPlan: plan });
        return { plugin, plan, review, receipt, target, integration };
      }
      const added = await prepare();
      expect(added.receipt.nativeToolChanges).toEqual([{ producer: expect.objectContaining({ sourceId: 'fixture', pluginName: 'native-review' }), before: null, after: fixture.closure }]);
      expect(added.review.changes).toContainEqual(expect.objectContaining({ description: expect.stringContaining('aw.windows-job.v1') }));
      const result = await executeRebuildOperation({ command: 'sync', target: added.target, driver: added.integration.driver });
      expect(result.status, JSON.stringify(result)).toBe('succeeded');
      manifest.nativeTools.consumers[0].tools[0] = { key: 'job', platforms: ['win32'], policy: 'preferred', fallback: 'portable' };
      await fs.outputJson(manifestPath, manifest);
      const changed = await prepare();
      const change = changed.receipt.nativeToolChanges![0]!;
      expect(change.before!.definitions).toEqual(change.after!.definitions);
      expect(change.before!.consumers[0]!.tools[0]!.policy).toBe('required');
      expect(change.after!.consumers[0]!.tools[0]).toMatchObject({ policy: 'preferred', fallback: 'portable' });
      expect(changed.review.changes).toContainEqual(expect.objectContaining({ title: `撤销原生工具 · fixture/native-review`, description: expect.stringContaining('required') }));
      expect(changed.review.changes).toContainEqual(expect.objectContaining({ title: `使用原生工具 · fixture/native-review`, description: expect.stringContaining('preferred · fallback=portable') }));
      delete manifest.nativeTools;
      manifest.requires.aw.capabilities = ['aw.managed-commands.v2'];
      await fs.outputJson(manifestPath, manifest);
      const removed = await prepare();
      expect(removed.receipt.nativeToolChanges).toEqual([{ producer: change.producer, before: fixture.closure, after: null }]);
      expect(removed.review.changes).toContainEqual(expect.objectContaining({ title: `撤销原生工具 · fixture/native-review` }));
    } finally { await Promise.all(sessions.map(disposePreparedPlatformRebuildSession)); await isolated.cleanup(); }
  });
});
