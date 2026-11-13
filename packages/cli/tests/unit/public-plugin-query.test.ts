import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { runPublicPluginShow } from '../../src/commands/public-plugin-query.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

// Test Value Gate: public inspection must distinguish declared static inputs from an unknown dynamic set without executing author code.
describe('public plugin component query', () => {
  it('shows five static declaration kinds and leaves dynamic names and counts unprepared', async () => {
    const { env, layout } = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(layout.fixtureCwd, 'query-source');
    const pluginRoot = path.join(sourceRoot, 'plugins/demo');
    const marker = path.join(layout.fixtureCwd, 'renderer-ran');
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran'); throw new Error('inspection cannot render');`);
    await fs.outputJson(path.join(pluginRoot, 'mcp.json'), { mcpServers: { service: { type: 'stdio', command: 'node', args: ['--version'] } } });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'Public query fixture\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.mcpServers = './mcp.json';
      manifest.artifacts = { configKeys: ['mode'], scopes: ['user'] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
      manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: 'safe' }, token: { type: 'string', sensitive: true } } };
      manifest.extensions = {
        agents: [{ name: 'review', description: 'Review', prompt: 'Review the change.' }],
        instructions: [{ name: 'rules', title: 'Rules', content: 'Keep the files.', coverage: ['main'] }],
        hooks: [{ id: 'notice', event: 'before_tool', feedback: 'notify', command: 'echo ready' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: snapshot.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
    const active = (await readCatalogGenerationState(env)).sources.team!.active!;
    await writePluginConfigStore({ sourceId: 'team', sourceIdentity: active.sourceIdentity, pluginName: 'demo',
      scope: 'user', cwd: layout.fixtureCwd, env, values: { token: 'private-token-value' } });
    const result = await runPublicPluginShow('team/demo', { cwd: layout.fixtureCwd, env });
    expect(result.status).toBe('success');
    expect(result.data).toMatchObject({
      components: { skill: { staticDeclared: false }, mcp: { staticDeclared: true }, agent: { staticDeclarations: 1 },
        hook: { staticDeclarations: 1, nativeDeclarations: {} }, instruction: { staticDeclarations: 1 } },
      dynamicComponents: { declared: true, state: 'unprepared', kinds: null, names: null, count: null, configKeys: ['mode'], scopes: ['user'] },
    });
    expect(await fs.pathExists(marker)).toBe(false);
    const output = JSON.stringify(result);
    for (const removed of ['slashCommands', 'apps', 'artifacts']) expect(Object.keys((result.data as { components: object }).components)).not.toContain(removed);
    expect(output).not.toContain(env.AW_HOME!);
    expect(output).not.toContain('private-token-value');
  });
});
