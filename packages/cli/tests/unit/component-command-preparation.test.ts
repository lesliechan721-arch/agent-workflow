import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { normalizeInstalledCommandProducer } from '@lesliechan721/aw-plugin-core/manifest';

import { getAuthoringPlatformCapabilities } from '../../src/review/platform-profile.js';
import { preparePlatformComponents, resolveArtifactRenderConfig } from '../../src/utils/artifact-renderer.js';
import { finalizePlatformSkillProducers } from '../../src/utils/component-command-preparation.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { createIsolatedTestEnv } from '../helpers/test-isolation.js';

// The same frozen routes govern Markdown substitutions and host grants, including empty packages.
describe('component command preparation', () => {
  it.each([true, false])('binds Skills and permissions against the provided routes (active: %s)', async (active) => {
    const isolated = await createIsolatedTestEnv();
    try {
      const cwd = isolated.layout.fixtureCwd;
      const root = path.join(cwd, 'plugin');
      const trace = path.join(cwd, 'render-trace');
      const manifest = {
        schemaVersion: 4, name: 'command-profile', version: '1.0.0', description: 'Command fixture.',
        platforms: ['claude'], skills: './skills',
        marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
        requires: { aw: { capabilities: ['aw.managed-commands.v2', 'aw.claude.sandbox-exclusions.v1'] } },
        scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
        command: { sourceDir: './commands', mode: 'dynamic', refreshKeys: [] },
        extensions: { permissions: [{ name: 'run', allow: [{ argsPrefix: [] }, { argsPrefix: ['check-all'] }],
          ask: [{ argsPrefix: ['missing'] }], deny: [{ argsPrefix: ['check', 'hidden'] }],
          agentOverrides: { claude: { sandbox: { excludedCommands: [{ argsPrefix: ['check'] }, { argsPrefix: ['Check'] }] } } } }] },
      };
      await fs.outputJson(path.join(root, '.agents-plugin', 'plugin.json'), manifest);
      await fs.outputFile(path.join(root, 'render.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(trace)}, 'unexpected'); process.exitCode = 2;`);
      await fs.outputFile(path.join(root, 'commands', 'check.mjs'), 'process.exitCode = 0;\n');
      for (const [name, text] of [['dependent', '{{aw.command}} check'], ['independent', 'Read this.']]) {
        await fs.outputFile(path.join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Example Skill.\n---\n${text}\n`);
      }
      const plugin = { ...await readPluginManifest(root), sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}`,
        pluginId: 'fixture/command-profile' };
      const capabilities = getAuthoringPlatformCapabilities('claude', 'user');
      capabilities.kinds.skill = { status: 'supported', reasonCodes: [], delivery: ['native-package'] };
      const config = await resolveArtifactRenderConfig({ pluginName: plugin.manifest.name, manifest: plugin.manifest,
        platform: 'claude', scope: 'user', cwd, env: isolated.env });
      const prepared = await preparePlatformComponents({ plugin, platform: 'claude', renderScope: 'user', kinds: ['skill'],
        capabilities, config, cwd, commandEnv: isolated.env });
      const commandRecord = normalizeInstalledCommandProducer({
        schemaVersion: 2, producer: { sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, pluginName: plugin.manifest.name },
        pluginVersion: manifest.version, sourceContentDigest: `sha256:${'c'.repeat(64)}`, runtimeConfigPlatforms: [], dynamicRefreshKeys: [],
        routes: { subcommands: active ? [{ name: 'check', runner: 'node', entry: 'check.mjs', args: [], env: {}, envFrom: {}, cwd: 'caller' }] : [] },
      });
      const finalized = await finalizePlatformSkillProducers({ plugin, platform: 'claude', prepared, commandRecord,
        renderUnit: { renderScope: { kind: 'user' }, kinds: ['skill'] },
        skillWorkRoot: path.join(cwd, 'skill-candidates'), cwd, env: isolated.env });
      const independent = finalized.skills.find(({ componentId }) => componentId === 'skill:independent');
      expect(independent?.tree.files['SKILL.md']?.toString('utf8')).toContain('Read this.');
      const dependent = finalized.skills.find(({ componentId }) => componentId === 'skill:dependent');
      if (active) {
        expect(dependent?.tree.files['SKILL.md']?.toString('utf8')).toContain('aw command run fixture/command-profile -- check');
        expect(finalized.prepared.expected.unmet).toEqual([]);
      } else {
        expect(dependent).toBeUndefined();
        expect(finalized.prepared.expected.unmet).toContainEqual(expect.objectContaining({
          id: 'skill:dependent', reasonCode: 'command-route-unreachable',
        }));
      }
      expect(finalized.invocationPolicy.policy.permissions).toEqual([{ name: 'run',
        allow: active ? [{ argsPrefix: [] }] : [], ask: [{ argsPrefix: ['missing'] }], deny: [{ argsPrefix: ['check', 'hidden'] }],
        ...(active ? { sandbox: { excludedCommands: [{ argsPrefix: ['check'] }] } } : {}) }]);
      expect(finalized.invocationPolicy.inactivePermissions).toEqual([
        { name: 'run', action: 'ask', argsPrefix: ['missing'] },
        ...(active ? [] : [{ name: 'run', action: 'deny', argsPrefix: ['check', 'hidden'] }]),
      ]);
      expect(finalized.invocationPolicy.diagnostics).toMatchObject([{ code: 'invocationPolicyNotApplied',
        subject: { field: 'permissions.run' }, detail: { reasonCode: 'command-route-unreachable', skippedPermissionActions: ['allow', 'sandbox'] } }]);
      expect(await fs.pathExists(trace)).toBe(false);
    } finally { await isolated.cleanup(); }
  });
});
