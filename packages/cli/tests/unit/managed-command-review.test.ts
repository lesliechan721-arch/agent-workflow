import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { normalizePluginCommand } from '@lesliechan721/aw-plugin-core/manifest';

import { createRebuildIntegration, disposePreparedPlatformRebuildSession, type RebuildExecutionContext } from '../../src/commands/rebuild-integration.js';
import { createCliExecutionContext, createCommandExecutionContext } from '../../src/commands/runtime.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { executeRecovery, prepareRecovery } from '../../src/recovery/coordinator.js';
import type { DeploymentBinding } from '../../src/platforms/contracts.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { getInvocationPolicyPath, getInvocationPolicyPhysicalKey } from '../../src/platforms/layout.js';
import { permissionComponent, previewOpenCodePermissions, updateHostPermissions } from '../../src/platforms/permission-ownership.js';
import { TuiController } from '../../src/tui/controller.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { buildOperationReviewProjection } from '../../src/tui/operation-review-planner.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveManagedCommand } from '../../src/utils/managed-command-store.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import type { CatalogResolution, PluginMeta } from '../../src/types.js';
import { createIsolatedTestEnv } from '../helpers/test-isolation.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { createCodexNativeTestRuntime } from '../helpers/codex-native-fixture.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';

// Review must use the same frozen routes, Skill substitutions, and host rules as execution.
describe('prepared managed command Review', () => {
  it.each(['codex', 'claude', 'opencode'] as const)('shows the %s permissions from prepared output and the actual dispatch entry', async (platform) => {
    installNativeTestQualification({ platforms: [platform], discovery: true });
    const isolated = await createIsolatedTestEnv();
    let context: RebuildExecutionContext | undefined;
    try {
      const cwd = isolated.layout.fixtureCwd;
      const pluginRoot = path.join(cwd, 'plugin');
      const reference = { argsPrefix: ['check'] };
      const capabilities = ['aw.managed-commands.v2', ...(platform === 'claude' ? ['aw.claude.sandbox-exclusions.v1'] : [])];
      await fs.outputJson(path.join(pluginRoot, '.agents-plugin/plugin.json'), {
        schemaVersion: 4, platforms: [platform], name: 'review-commands', version: '1.0.0', description: 'Prepared Review fixture.',
        requires: { aw: { capabilities } },
        marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
        skills: './skills',
        command: { sourceDir: './commands', mode: 'static',
          routes: { subcommands: [{ name: 'check', runner: 'node', entry: 'tool.mjs', args: ['--fixed', 'value'] }] } },
        extensions: { permissions: [{ name: 'commands', allow: [reference], ask: ['git status'], deny: [{ argsPrefix: ['unreachable'] }],
          ...(platform === 'claude' ? { agentOverrides: { claude: { sandbox: { excludedCommands: [reference] } } } } : {}) }] },
      });
      await fs.outputFile(path.join(pluginRoot, 'skills/provider/SKILL.md'),
        '---\nname: provider\ndescription: Review fixture.\n---\n{{aw.command}} check\n');
      await fs.outputFile(path.join(pluginRoot, 'skills/provider/README.md'), 'Review fixture.\n');
      await fs.outputFile(path.join(pluginRoot, 'commands/tool.mjs'), 'process.exit(0);\n');
      let plugin: PluginMeta = { ...await readPluginManifest(pluginRoot), sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginId: 'fixture/review-commands' };
      const bundleRoot = path.join(cwd, 'bundle');
      await bundleLocalPlugin(plugin, bundleRoot, { commandEnv: isolated.env });
      plugin = { ...await readPluginManifest(bundleRoot, { mode: 'bundle' }), sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, pluginId: plugin.pluginId };
      const external = platform === 'codex' ? await createCodexNativeTestRuntime(isolated)
        : platform === 'claude' ? await createClaudeNativeTestRuntime(isolated) : undefined;
      context = { ...createCommandExecutionContext({ env: isolated.env, nativeCliRunner: external?.nativeCliRunner }), preparedArtifactRenderResults: new Map() };
      const scope = platform === 'claude' ? 'project' : 'user';
      if (scope === 'project') await fs.ensureDir(path.join(cwd, '.git'));
      if (platform === 'opencode' && process.platform !== 'win32') {
        // The previous source generation owns a now-shadowed grant and a separate
        // live rule at the very same selector and host file used by the new one.
        const read = { env: isolated.env, cwd };
        const previous: DeploymentBinding = { id: 'previous', platform, route: 'opencode-directory', scope: { kind: 'user' },
          plugin: { pluginId: plugin.pluginId!, sourceId: 'fixture', sourceIdentity: 'sha256:' + 'b'.repeat(64), version: '1.0.0' },
          consumers: [{ id: 'cli', product: 'cli', availability: 'available', version: '2.2.6', reasonCodes: [],
            entry: { kind: 'directory', configRoot: resolvePlatformConfigRoot(platform, read) } }],
          physicalKey: '', activationKey: '', renderUnitIds: [] };
        const destination = await getInvocationPolicyPath(read, previous);
        const permissions = [{ name: 'old-generation', effect: 'allow' as const, tokens: ['git', 'status'] },
          { name: 'retained', effect: 'ask' as const, tokens: ['fixture', 'inspect'] }];
        const review = await previewOpenCodePermissions(read, previous, destination, permissions);
        const { locator } = permissionComponent(previous, destination, await getInvocationPolicyPhysicalKey(read, previous));
        await updateHostPermissions(read, locator, { kind: 'opencode-permissions', permissions, effective: review.effective, reviewDigest: review.reviewDigest });
      }
      const integration = createRebuildIntegration({ context });
      const target = await integration.buildTarget({ plugin, platform, scope, command: 'install', cwd,
        catalog: { rootDir: cwd, source: 'local' } as CatalogResolution });
      await integration.sealMarketplaceGenerations([target]);
      const operationPlan = createOperationPlan({ intentChanges: [], changes: [], warnings: [],
        actions: [...target.operationActions ?? []], deploymentPlans: target.platformDeployment!.plans,
        evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] } });
      const plans = operationPlan.deploymentPlans!;
      const projection = plans.flatMap((plan) => plan.projections).find((entry) => entry.bundle)!;
      const skillPath = path.join(projection.bundle!.stagingRoot, 'skills/provider/SKILL.md');
      expect(await fs.readFile(skillPath, 'utf8')).toContain('aw command run fixture/review-commands -- check');
      const contribution = plans.flatMap((plan) => plan.projections.flatMap((entry) => entry.supplements))
        .find((entry) => platform === 'codex' ? entry.destination.endsWith('.rules') : entry.mergeKey?.startsWith(`${platform}-permissions:`))!;
      const rules = await fs.readFile(contribution.stagingPath, 'utf8');
      expect(plans.flatMap((plan) => plan.evidence.managedCommandReview?.inactivePermissions ?? []))
        .toEqual([{ name: 'commands', action: 'deny', argsPrefix: ['unreachable'] }]);
      if (platform === 'codex') {
        await fs.appendFile(contribution.stagingPath, '# unreviewed bytes\n');
        await expect(target.platformDeployment!.verify()).rejects.toThrow('operationPlanStale');
      }
      await disposePreparedPlatformRebuildSession(context.preparedArtifactRenderResults!);
      expect(await fs.pathExists(contribution.stagingPath)).toBe(false);
      const review = buildOperationReviewProjection({
        intent: { kind: 'pluginWrite', action: 'install', pluginId: plugin.pluginId!, platform, scope },
        evidence: { catalog: { configDigest: 'fixture', compositeDigest: 'fixture' }, operationPlan },
      });
      expect(review.changes).toContainEqual(expect.objectContaining({ description: expect.stringMatching(/fixture\/review-commands -- check.*tool\.mjs.*--fixed/u) }));
      expect(review.changes).toContainEqual(expect.objectContaining({ description: expect.stringContaining('fixture/review-commands -- unreachable') }));
      if (platform === 'codex') {
        expect(rules).toContain('["aw","command","run","fixture/review-commands","--","check"]');
        for (const decision of ['allow', 'prompt', 'forbidden']) expect(rules).toContain(`decision = "${decision}"`);
        expect(review.changes).toContainEqual(expect.objectContaining({ description: rules.trim() }));
      } else if (platform === 'opencode') {
        const effective = JSON.parse(rules).effective as Array<{ action: string; resource: string; effect: string }>;
        expect(effective).toHaveLength(process.platform === 'win32' ? 0 : 4);
        if (process.platform !== 'win32') {
          expect(effective).toContainEqual({ action: 'shell', resource: 'fixture inspect *', effect: 'ask' });
          expect(effective.filter((rule) => rule.resource === 'git status *')).toEqual([{ action: 'shell', resource: 'git status *', effect: 'ask' }]);
          expect(review.changes.filter((change) => change.description?.startsWith('shell git status *'))).toHaveLength(1);
          expect(review.changes).toContainEqual(expect.objectContaining({ kind: 'warning', pluginId: plugin.pluginId,
            description: expect.stringContaining('permissions.old-generation') }));
        }
        for (const rule of effective) {
          expect(review.changes).toContainEqual(expect.objectContaining({ title: `OpenCode · ${rule.effect}`,
            description: `${rule.action} ${rule.resource} · ${contribution.destination}` }));
        }
      } else {
        const permissions = JSON.parse(rules).permissions as Record<string, string[]>;
        expect(permissions.allow).toEqual(['Bash(aw command run fixture/review-commands -- check *)']);
        for (const key of ['allow', 'ask', 'deny', 'excludedCommands']) {
          expect(review.changes).toContainEqual(expect.objectContaining({ description: permissions[key]!.join('；') }));
        }
      }
    } finally {
      if (context?.preparedArtifactRenderResults) await disposePreparedPlatformRebuildSession(context.preparedArtifactRenderResults);
      await isolated.cleanup();
    }
  });

  it('reviews the first saved-config apply through the real controller', async () => {
    installNativeTestQualification({ platforms: ['codex'], discovery: true });
    const isolated = await createIsolatedTestEnv();
    let controller: TuiController | undefined;
    try {
      const cwd = isolated.layout.fixtureCwd;
      const sourceRoot = path.join(cwd, 'catalog');
      const root = path.join(sourceRoot, 'plugins/demo');
      await fs.outputFile(path.join(root, 'skills/provider/SKILL.md'),
        '---\nname: provider\ndescription: Config Review fixture.\n---\n{{aw.command}} check\n');
      await fs.outputFile(path.join(root, 'commands/tool.mjs'), 'process.exit(0);\n');
      await fs.outputFile(path.join(root, 'render.mjs'), `
import fs from 'node:fs';
const c = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
console.log(JSON.stringify({ version: 2, artifacts: [{
  id: 'command-routes', target: 'aw.command-routes', kind: 'commandRoutes', refreshKeys: ['mode'],
  routes: { subcommands: [{ name: 'check', runner: 'node', entry: 'tool.mjs', args: [c.config.values.mode] }] },
}] }));
`);
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'Config Review fixture\n', (manifest) => {
        manifest.platforms = ['codex'];
        manifest.skills = './skills';
        manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: 'old' } } };
        manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
        manifest.command = normalizePluginCommand({ sourceDir: './commands', mode: 'dynamic', refreshKeys: ['mode'] }, manifest);
        manifest.extensions = { permissions: [{ name: 'run', allow: [{ argsPrefix: ['check'] }] }] };
      });
      const env = isolated.env;
      const before = await readCatalogSourcesConfigSnapshot(env);
      await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
        expectedDigest: before.digest, env });
      await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
      const external = await createCodexNativeTestRuntime(isolated);
      const options = { cwd, env, scope: 'user' as const, context: 'user' as const, cliVersion: '1.0.0' };
      const pluginId = 'team/demo';
      const resolve = () => resolveManagedCommand(pluginId, env, { args: ['check'] });
      await writeIntentFixture(options, { roots: [{ pluginId }], targets: ['codex'] });
      const runtime = createCliExecutionContext({ ...options, interactive: false, nativeCliRunner: external.nativeCliRunner });
      const install = await prepareRecovery('sync', [pluginId], options, runtime);
      const installed = await executeRecovery(install, { yes: true });
      expect(installed.ok, JSON.stringify(installed)).toBe(true);
      controller = new TuiController(createTuiControllerDependencies(runtime));
      await controller.load();
      const saved = await controller.saveConfigDraft({ kind: 'configSave', pluginId, context: 'user', apply: false, updates: { mode: 'saved' } });
      expect(saved.status).toBe('succeeded');
      expect((await resolve()).launch.args).toEqual(['old']);
      const review = await controller.buildOperationReview({ kind: 'configSave', pluginId, context: 'user', apply: true, retryApply: true, updates: {} });
      expect(review.changes).toContainEqual(expect.objectContaining({ description: expect.stringMatching(/team\/demo -- check.*"old".*"saved"/u) }));
      expect(review.changes).toContainEqual(expect.objectContaining({ description: expect.stringMatching(/codex allow.*team\/demo.*may apply/u) }));
      expect((await resolve()).launch.args).toEqual(['old']);
      const result = await controller.executeOperation(review.reviewToken);
      expect(result.state, JSON.stringify(result)).toBe('succeeded');
      expect((await resolve()).launch.args).toEqual(['saved']);
    } finally { controller?.dispose(); await isolated.cleanup(); }
  });
});
