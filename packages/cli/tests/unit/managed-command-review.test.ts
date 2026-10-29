import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { createRebuildIntegration, type RebuildExecutionContext } from '../../src/commands/rebuild-integration.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { buildOperationReviewProjection } from '../../src/tui/operation-review-planner.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { SYSTEM_CODEX_MANAGER } from '../../src/utils/native-cli.js';
import type { CatalogResolution, PluginMeta } from '../../src/types.js';
import { createIsolatedTestEnv } from '../helpers/test-isolation.js';

// Test Value Gate: real prepared files, command substitutions, and permission mutations must reach installation Review.
describe('prepared managed command Review', () => {
  it.each(['static-native', 'static-claude', 'owned-codex', 'owned-claude'] as const)('shows %s commands and exact permission changes', async (kind) => {
    const isolated = await createIsolatedTestEnv();
    try {
      const platform = kind.endsWith('claude') ? 'claude' : 'codex';
      const native = kind.startsWith('static');
      const pluginRoot = path.join(isolated.layout.fixtureCwd, 'plugin');
      const reference = { command: { set: 'tools', key: 'run', variant: 'default' }, argsPrefix: ['check'] };
      const producer = native
        ? { kind: 'static-skill', platform, skillKey: 'provider' }
        : { kind: 'artifact', artifactId: 'provider' };
      const files = {
        'SKILL.md': '---\nname: provider\ndescription: Review fixture.\n---\n{{aw.command:tools/run}} check\n',
        'README.md': '# Provider\n', 'scripts/tool.mjs': 'process.exit(0);\n',
        'agents/openai.yaml': 'policy:\n  allow_implicit_invocation: true\n',
      };
      await fs.outputJson(path.join(pluginRoot, '.agents-plugin/plugin.json'), {
        schemaVersion: 3, name: 'review-commands', version: '1.0.0', description: 'Prepared Review fixture.',
        requires: { aw: { capabilities: ['aw.managed-commands.v1'] } },
        marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
        ...(native ? { skills: './skills' } : {
          scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
          artifacts: { targets: [{ id: 'provider', target: `${platform}.skill`, platform, scopes: ['user'],
            ...(platform === 'codex' ? { delivery: { mode: 'aw-extension' } } : {}),
            states: ['present'], refreshKeys: [], skillKey: 'provider' }] },
        }),
        managedCommands: { sets: [{ set: 'tools', producer, mode: 'static', entries: [{ key: 'run', runner: 'node', entry: 'scripts/tool.mjs', args: ['--fixed', 'value'] }] }] },
        extensions: { permissions: [{ name: 'commands', allow: [reference], ask: ['git status'], deny: ['git push'],
          ...(platform === 'claude' ? { agentOverrides: { claude: { sandbox: { excludedCommands: [reference] } } } } : {}) }] },
      });
      if (native) {
        for (const [relative, content] of Object.entries(files)) await fs.outputFile(path.join(pluginRoot, 'skills/provider', relative), content);
      } else {
        await fs.outputFile(path.join(pluginRoot, 'render.mjs'), `const files=${JSON.stringify(files)}; console.log(JSON.stringify({version:2,artifacts:[{id:'provider',target:'${platform}.skill',kind:'skill',platform:'${platform}',state:'present',skillKey:'provider',refreshKeys:[],content:{files}}]}));\n`);
      }
      let plugin: PluginMeta = { ...await readPluginManifest(pluginRoot), sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginId: 'fixture/review-commands' };
      if (native) {
        const bundleRoot = path.join(isolated.layout.fixtureCwd, 'bundle');
        await bundleLocalPlugin(plugin, bundleRoot, { commandEnv: isolated.env });
        plugin = { ...await readPluginManifest(bundleRoot, { mode: 'bundle' }), sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, pluginId: plugin.pluginId };
      }
      const context: RebuildExecutionContext = { ...createCommandExecutionContext({ env: isolated.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: '{"installed":[],"available":[]}', stderr: '' }) }), codexManager: SYSTEM_CODEX_MANAGER };
      const scope = kind === 'static-claude' ? 'project' : 'user';
      const target = await createRebuildIntegration({ context }).buildTarget({ plugin, platform, scope,
        command: 'install', cwd: isolated.layout.fixtureCwd,
        catalog: { rootDir: isolated.layout.fixtureCwd, source: 'local' } as CatalogResolution });
      const operationPlan = createOperationPlan({ intentChanges: [], changes: [], warnings: [],
        actions: [...target.operationActions ?? []],
        evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] } });
      const review = buildOperationReviewProjection({
        intent: { kind: 'pluginWrite', action: 'install', pluginId: plugin.pluginId!, platform, scope },
        evidence: { catalog: { configDigest: 'fixture', compositeDigest: 'fixture' }, operationPlan },
      });
      expect(review.changes).toContainEqual(expect.objectContaining({ title: 'tools/run/default',
        description: 'node · scripts/tool.mjs · 固定参数 ["--fixed","value"] · cwd=caller' }));
      expect(review.changes).toContainEqual(expect.objectContaining({ title: '命令生产者 provider',
        description: expect.stringContaining('fixture/review-commands') }));
      if (kind === 'static-claude') expect(review.changes).toContainEqual(expect.objectContaining({ title: '命令生产者 provider',
        description: expect.stringContaining('所有项目 · Claude Code · 更新会影响全部引用者') }));
      const skillAction = operationPlan.actions.find((entry) => (entry.kind === 'writeOwnedArtifact'
        || entry.kind === 'materializeNativeSkill') && entry.files?.some((file) => file.relativePath === 'SKILL.md'))!;
      if (skillAction.kind !== 'writeOwnedArtifact' && skillAction.kind !== 'materializeNativeSkill') throw new Error('Missing prepared Skill.');
      const skill = Buffer.from(skillAction.files!.find((file) => file.relativePath === 'SKILL.md')!.contentBase64, 'base64').toString('utf8');
      const commandId = skill.match(/aw command run (cmdp_[0-9a-f]{64}) -- check/u)?.[1];
      expect(commandId).toBeDefined();
      if (platform === 'codex') {
        const action = operationPlan.actions.find((entry) => entry.kind === 'writeOwnedArtifact' && entry.path.endsWith('.rules'))!;
        if (action.kind !== 'writeOwnedArtifact') throw new Error('Missing prepared Codex permission.');
        expect(action.sourceContent).toContain(commandId!);
        expect(action.sourceContent).toContain('decision = "allow"');
        expect(action.sourceContent).toContain('decision = "prompt"');
        expect(action.sourceContent).toContain('decision = "forbidden"');
        expect(review.changes).toContainEqual(expect.objectContaining({ title: `Codex 权限规则 ${path.basename(action.path)}`, description: action.sourceContent!.trim() }));
      } else {
        const action = operationPlan.actions.find((entry) => entry.kind === 'updateSharedConfig' && entry.mutation.kind === 'claude-permissions')!;
        if (action.kind !== 'updateSharedConfig' || action.mutation.kind !== 'claude-permissions') throw new Error('Missing prepared Claude permissions.');
        const permissions = action.mutation.permissions as Record<string, string[]>;
        expect(permissions.allow!.join('')).toContain(commandId!);
        for (const key of ['allow', 'ask', 'deny', 'excludedCommands']) expect(review.changes).toContainEqual(expect.objectContaining({
          title: key === 'excludedCommands' ? 'Claude sandbox.excludedCommands' : `Claude permissions.${key}`,
          description: permissions[key]!.join('；'),
        }));
      }
    } finally { await isolated.cleanup(); }
  });
});
