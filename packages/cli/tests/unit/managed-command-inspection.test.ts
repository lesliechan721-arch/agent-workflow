import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRebuildIntegration } from '../../src/commands/rebuild-integration.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import { executeRebuildOperation } from '../../src/commands/rebuild-operations.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { writeOwnedTextFile } from '../../src/utils/ownership.js';
import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';
import { git } from '../helpers/catalog-source-fixture.js';

describe('managed command read-only inspection', () => {
  let isolated: IsolatedTestEnvironment;
  beforeEach(async () => { isolated = await createIsolatedTestEnv(); });
  afterEach(async () => { await isolated.cleanup(); });

  // Protects component discovery and recovery from absent or damaged bindings without running renderer or synthesizing IDs.
  it.each(['missing', 'damaged'] as const)('discovers permission ownership and cleans project output with %s bindings', async (bindingState) => {
    await git(isolated.layout.fixtureCwd, ['init']);
    const root = path.join(isolated.layout.fixtureCwd, 'source');
    const sourceIdentity = `sha256:${'a'.repeat(64)}`;
    await fs.outputJson(path.join(root, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 3, name: 'inspection-commands', version: '1.0.0', description: 'Inspection fixture.',
      requires: { aw: { capabilities: ['aw.managed-commands.v1'] } },
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      artifacts: { targets: [{ id: 'provider', platform: 'codex', target: 'codex.skill', delivery: { mode: 'aw-extension' }, scopes: ['project'], states: ['present'], refreshKeys: [], skillKey: 'provider' }] },
      managedCommands: { sets: [{ set: 'tools', producer: { kind: 'artifact', artifactId: 'provider' }, mode: 'static', entries: [{ key: 'run', runner: 'node', entry: 'tool.mjs' }] }] },
      extensions: { permissions: [{ name: 'managed', allow: [{ command: { set: 'tools', key: 'run' }, argsPrefix: ['start'] }] }] },
    });
    await fs.outputFile(path.join(root, 'render.mjs'), 'throw new Error("Read-only inspection must not run the renderer.");\n');
    const plugin = { ...await readPluginManifest(root), sourceId: 'fixture', sourceIdentity, pluginId: 'fixture/inspection-commands' };
    const bindings = path.join(isolated.layout.awHomeDir, 'commands', 'bindings');
    const damagedPath = path.join(bindings, `cmdp_${'0'.repeat(16)}.json`);
    if (bindingState === 'damaged') await fs.outputFile(damagedPath, '{broken');
    const context = createCommandExecutionContext({ env: isolated.env, nativeCliRunner: async () => { throw new Error('Inspection must not invoke native CLI.'); } });
    const integration = createRebuildIntegration({ context });
    const common = { plugin, platform: 'codex' as const, scope: 'project' as const, cwd: isolated.layout.fixtureCwd,
      catalog: { rootDir: isolated.layout.fixtureCwd, source: 'local' as const } };
    const inspected = await integration.buildTarget({ ...common, command: 'install', readOnlyInspectionPlan: true });
    const permission = inspected.ownedComponents.find((component) => component.kind === 'owned-text-file' && component.path.endsWith('aw-inspection-commands-managed.rules'));
    if (permission?.kind !== 'owned-text-file') throw new Error('Missing real permission component.');
    expect(inspected.operationActions?.some((action) => action.kind === 'writeOwnedArtifact')).toBe(false);
    await writeOwnedTextFile({ path: permission.path, allowedRoot: permission.allowedRoot, identity: permission.identity, content: '# Previously installed rules\n' });
    const target = await integration.buildTarget({ ...common, command: 'cleanup' });
    const result = await executeRebuildOperation({ command: 'cleanup', target, driver: integration.driver });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(await fs.pathExists(permission.path)).toBe(false);
    if (bindingState === 'damaged') expect(await fs.readFile(damagedPath, 'utf8')).toBe('{broken');
    else expect(await fs.pathExists(bindings)).toBe(false);
  });
});
