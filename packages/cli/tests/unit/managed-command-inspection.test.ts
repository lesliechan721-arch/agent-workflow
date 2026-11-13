import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRebuildIntegration, disposePreparedPlatformRebuildSession } from '../../src/commands/rebuild-integration.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import { executeRebuildOperation } from '../../src/commands/rebuild-operations.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';

describe('managed command read-only inspection', () => {
  let isolated: IsolatedTestEnvironment;
  const prepared = new Map<string, import('../../src/utils/plugin-scripts.js').PluginProcessResult>();
  beforeEach(async () => { isolated = await createIsolatedTestEnv(); });
  afterEach(async () => { await disposePreparedPlatformRebuildSession(prepared); prepared.clear(); await isolated.cleanup(); });

  // Test Value Gate: missing or damaged command bindings cannot block owner inspection or safe offline package cleanup.
  it.each(['missing', 'damaged'] as const)('cleans a proven owned package with %s bindings without running the renderer', async (bindingState) => {
    const root = path.join(isolated.layout.fixtureCwd, 'source');
    const bin = path.join(isolated.layout.fixtureCwd, 'bin');
    await fs.outputFile(path.join(bin, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = { ...isolated.env, PATH: `${bin}${path.delimiter}${isolated.env.PATH ?? ''}` };
    await fs.outputJson(path.join(root, '.agents-plugin/plugin.json'), {
      schemaVersion: 4, name: 'inspection-commands', version: '1.0.0', description: 'Inspection fixture.',
      platforms: ['opencode'], requires: { aw: { capabilities: ['aw.managed-commands.v1'] } },
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      artifacts: { configKeys: [] },
      managedCommands: { sets: [{ set: 'tools', producer: { kind: 'artifact', platform: 'opencode', artifactId: 'provider' }, mode: 'static', entries: [{ key: 'run', runner: 'node', entry: 'tool.mjs' }] }] },
    });
    await fs.outputFile(path.join(root, 'render.mjs'), 'throw new Error("Inspection and cleanup must not run the renderer.");\n');
    const plugin = { ...await readPluginManifest(root), sourceId: 'fixture',
      sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginId: 'fixture/inspection-commands' };
    const bindings = path.join(isolated.layout.awHomeDir, 'commands/bindings');
    const damagedPath = path.join(bindings, `cmdp_${'0'.repeat(16)}.json`);
    if (bindingState === 'damaged') await fs.outputFile(damagedPath, '{broken');
    const context = { ...createCommandExecutionContext({ env, nativeCliRunner: async () => ({ exitCode: 0, stdout: 'opencode 2.0.0', stderr: '' }) }),
      preparedArtifactRenderResults: prepared };
    const integration = createRebuildIntegration({ context });
    const common = { plugin, platform: 'opencode' as const, scope: 'user' as const,
      cwd: isolated.layout.fixtureCwd, catalog: { rootDir: root, source: 'local' as const } };
    const inspected = await integration.buildTarget({ ...common, command: 'install', readOnlyInspectionPlan: true });
    const component = inspected.ownedComponents[0];
    if (component?.kind !== 'owned-directory') throw new Error('Missing package ownership component.');
    expect(inspected.operationActions).toBeUndefined();
    await fs.outputFile(path.join(component.path, 'plugin.js'), 'export default {};\n');
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity });
    const target = await integration.buildTarget({ ...common, command: 'cleanup' });
    await integration.sealMarketplaceGenerations([target]);
    const result = await executeRebuildOperation({ command: 'cleanup', target, driver: integration.driver });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(await fs.pathExists(component.path)).toBe(false);
    if (bindingState === 'damaged') expect(await fs.readFile(damagedPath, 'utf8')).toBe('{broken');
    else expect(await fs.pathExists(bindings)).toBe(false);
  });
});
