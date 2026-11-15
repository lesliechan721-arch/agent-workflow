import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { createRebuildIntegration, disposePreparedPlatformRebuildSession, type RebuildExecutionContext } from '../../src/commands/rebuild-integration.js';
import { createCliExecutionContext, createCommandExecutionContext } from '../../src/commands/runtime.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { buildOperationReviewProjection } from '../../src/tui/operation-review-planner.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { TuiController } from '../../src/tui/controller.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { listManagedCommands, resolveManagedCommand } from '../../src/utils/managed-command-store.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { executeRecovery, prepareRecovery } from '../../src/recovery/coordinator.js';
import type { CatalogResolution, PluginMeta } from '../../src/types.js';
import { createIsolatedTestEnv } from '../helpers/test-isolation.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { createCodexNativeTestRuntime } from '../helpers/codex-native-fixture.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';

// Test Value Gate: real prepared files, command substitutions, and permission mutations must reach installation Review.
describe('prepared managed command Review', () => {
  it.each(['static-codex', 'static-claude', 'dynamic-codex', 'dynamic-claude'] as const)('shows %s commands and exact permission changes', async (kind) => {
    const platform = kind.endsWith('claude') ? 'claude' : 'codex';
    installNativeTestQualification({ platforms: [platform], discovery: true, trust: true });
    const isolated = await createIsolatedTestEnv();
    let context: RebuildExecutionContext | undefined;
    try {
      const native = kind.startsWith('static');
      const pluginRoot = path.join(isolated.layout.fixtureCwd, 'plugin');
      const reference = { command: { set: 'tools', key: 'run', variant: 'default' }, argsPrefix: ['check'] };
      const producer = native
        ? { kind: 'static-skill', platform, skillKey: 'provider' }
        : { kind: 'artifact', platform, artifactId: 'provider' };
      const files = {
        'SKILL.md': '---\nname: provider\ndescription: Review fixture.\n---\n{{aw.command:tools/run}} check\n',
        'README.md': '# Provider\n', 'scripts/tool.mjs': 'process.exit(0);\n',
        'agents/openai.yaml': 'policy:\n  allow_implicit_invocation: true\n',
      };
      await fs.outputJson(path.join(pluginRoot, '.agents-plugin/plugin.json'), {
        schemaVersion: 4, platforms: [platform], name: 'review-commands', version: '1.0.0', description: 'Prepared Review fixture.',
        requires: { aw: { capabilities: ['aw.managed-commands.v1'] } },
        marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
        ...(native ? { skills: './skills' } : {
          scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
          artifacts: { configKeys: [], scopes: ['user'] },
        }),
        managedCommands: { sets: [{ set: 'tools', producer, mode: 'static', entries: [{ key: 'run', runner: 'node', entry: 'scripts/tool.mjs', args: ['--fixed', 'value'] }] }] },
        extensions: { permissions: [{ name: 'commands', allow: [reference], ask: ['git status'], deny: ['git push'],
          ...(platform === 'claude' ? { agentOverrides: { claude: { sandbox: { excludedCommands: [reference] } } } } : {}) }] },
      });
      if (native) {
        for (const [relative, content] of Object.entries(files)) await fs.outputFile(path.join(pluginRoot, 'skills/provider', relative), content);
      } else {
        await fs.outputFile(path.join(pluginRoot, 'render.mjs'), `import fs from 'node:fs';const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));const files=${JSON.stringify(files)};console.log(JSON.stringify({version:3,components:c.allowedOutputKinds.includes('skill')?[{id:'provider',kind:'skill',name:'provider',content:{files:Object.fromEntries(Object.entries(files).map(([p,text])=>[p,{text}]))}}]:[],omitted:[],unmet:[]}));\n`);
      }
      let plugin: PluginMeta = { ...await readPluginManifest(pluginRoot), sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginId: 'fixture/review-commands' };
      const bundleRoot = path.join(isolated.layout.fixtureCwd, 'bundle');
      await bundleLocalPlugin(plugin, bundleRoot, { commandEnv: isolated.env });
      plugin = { ...await readPluginManifest(bundleRoot, { mode: 'bundle' }), sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, pluginId: plugin.pluginId };
      const external = platform === 'codex' ? await createCodexNativeTestRuntime(isolated) : await createClaudeNativeTestRuntime(isolated);
      context = { ...createCommandExecutionContext({ env: isolated.env, nativeCliRunner: external.nativeCliRunner }), preparedArtifactRenderResults: new Map() };
      const scope = kind === 'static-claude' ? 'project' : 'user';
      if (scope === 'project') await fs.ensureDir(path.join(isolated.layout.fixtureCwd, '.git'));
      const integration = createRebuildIntegration({ context });
      const target = await integration.buildTarget({ plugin, platform, scope,
        command: 'install', cwd: isolated.layout.fixtureCwd,
        catalog: { rootDir: isolated.layout.fixtureCwd, source: 'local' } as CatalogResolution });
      await integration.sealMarketplaceGenerations([target]);
      const operationPlan = createOperationPlan({ intentChanges: [], changes: [], warnings: [],
        actions: [...target.operationActions ?? []],
        deploymentPlans: target.platformDeployment!.plans, nativeToolChanges: target.nativeToolChanges,
        evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] } });
      expect(operationPlan.actions.some((action) => ['writeOwnedArtifact', 'materializeNativeSkill', 'updateSharedConfig'].includes(action.kind))).toBe(false);
      const plans = operationPlan.deploymentPlans!;
      const projection = plans.flatMap((plan) => plan.projections).find((entry) => entry.bundle)!;
      const skill = await fs.readFile(path.join(projection.bundle!.stagingRoot, 'skills/provider/SKILL.md'), 'utf8');
      const commandId = skill.match(/aw command run (cmdp_[0-9a-f]{16}) -- check/u)?.[1];
      expect(commandId).toBeDefined();
      const recordPath = path.join(projection.bundle!.stagingRoot, 'skills/provider/.aw-command-producer.json');
      const record = await fs.readJson(recordPath);
      expect(plans.flatMap((plan) => plan.evidence.managedCommandReview?.producers ?? [])).toEqual([record]);
      expect(record.producer.placementKey).toMatch(/^sha256:[a-f0-9]{64}$/u);
      const contribution = plans.flatMap((plan) => plan.projections.flatMap((entry) => entry.supplements))
        .find((entry) => platform === 'codex' ? entry.destination.endsWith('.rules') : entry.mergeKey?.startsWith('claude-permissions:'))!;
      const rules = await fs.readFile(contribution.stagingPath, 'utf8');
      if (kind === 'static-codex') {
        await fs.writeJson(recordPath, { ...record, sets: [{ ...record.sets[0], entries: [{ ...record.sets[0].entries[0], args: ['unreviewed'] }] }] });
        await expect(target.platformDeployment!.verify()).rejects.toThrow('operationPlanStale');
      }
      await disposePreparedPlatformRebuildSession(context.preparedArtifactRenderResults!);
      expect(await fs.pathExists(projection.bundle!.stagingRoot)).toBe(false);
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
      if (platform === 'codex') {
        expect(rules).toContain(commandId!);
        for (const decision of ['allow', 'prompt', 'forbidden']) expect(rules).toContain(`decision = "${decision}"`);
        expect(review.changes).toContainEqual(expect.objectContaining({ title: `Codex 权限规则 ${path.basename(contribution.destination)}`, description: rules.trim() }));
      } else {
        const permissions = JSON.parse(rules).permissions as Record<string, string[]>;
        expect(permissions.allow!.join('')).toContain(commandId!);
        for (const key of ['allow', 'ask', 'deny', 'excludedCommands']) expect(review.changes).toContainEqual(expect.objectContaining({
          title: key === 'excludedCommands' ? 'Claude sandbox.excludedCommands' : `Claude permissions.${key}`,
          description: permissions[key]!.join('；'),
        }));
      }
      const changed = structuredClone(operationPlan);
      changed.deploymentPlans![0]!.evidence.managedCommandReview!.producers[0]!.sets[0]!.entries[0]!.args = ['unreviewed'];
      expect(createOperationPlan(changed).planFingerprint).not.toBe(operationPlan.planFingerprint);
    } finally {
      if (context?.preparedArtifactRenderResults) await disposePreparedPlatformRebuildSession(context.preparedArtifactRenderResults);
      await isolated.cleanup();
    }
  });

  // The first update after saving uses the same saved-config preparation as retries.
  it('reviews the first saved-config apply through the real controller', async () => {
    installNativeTestQualification({ platforms: ['codex'], discovery: true, trust: true });
    const isolated = await createIsolatedTestEnv();
    let controller: TuiController | undefined;
    try {
      const cwd = isolated.layout.fixtureCwd;
      const sourceRoot = path.join(cwd, 'catalog');
      const root = path.join(sourceRoot, 'plugins/demo');
      await fs.outputFile(path.join(root, 'skills/provider/SKILL.md'), '---\nname: provider\ndescription: Config Review fixture.\n---\n{{aw.command:tools/run}} check\n');
      await fs.outputFile(path.join(root, 'skills/provider/tool.mjs'), 'process.exit(0);\n');
      await fs.outputFile(path.join(root, 'render.mjs'), [
        "import fs from 'node:fs';const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
        "console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>({id,target:'aw.command-set',kind:'commandSet',platform:'codex',state:'present',refreshKeys:['mode'],entries:[{key:'run',runner:'node',entry:'tool.mjs',args:[c.config.values.mode]}]}))}));",
      ].join('\n'));
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'Config Review fixture\n', (manifest) => {
        manifest.platforms = ['codex']; manifest.skills = './skills';
        manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: 'old' } } };
        manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
        manifest.managedCommands = { packages: [], sets: [{ set: 'tools', producer: { kind: 'static-skill', platform: 'codex', skillKey: 'provider' }, mode: 'dynamic', refreshKeys: ['mode'] }] };
        manifest.extensions = { permissions: [{ name: 'run', allow: [{ command: { set: 'tools', key: 'run' }, argsPrefix: ['check'] }] }] };
      });
      const before = await readCatalogSourcesConfigSnapshot(isolated.env);
      await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: before.digest, env: isolated.env });
      await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolated.env });
      const external = await createCodexNativeTestRuntime(isolated);
      const options = { cwd, env: isolated.env, scope: 'user' as const, context: 'user' as const, cliVersion: '1.0.0' };
      await writeIntentFixture(options, { roots: [{ pluginId: 'team/demo' }], targets: ['codex'] });
      const runtime = createCliExecutionContext({ ...options, interactive: false, nativeCliRunner: external.nativeCliRunner });
      const install = await prepareRecovery('sync', ['team/demo'], options, runtime);
      const installed = await executeRecovery(install, { yes: true });
      expect(installed.ok, JSON.stringify(installed)).toBe(true);
      const command = (await listManagedCommands(isolated.env)).commands[0]!;
      controller = new TuiController(createTuiControllerDependencies(runtime));
      await controller.load();
      const saved = await controller.saveConfigDraft({ kind: 'configSave', pluginId: 'team/demo', context: 'user', apply: false, updates: { mode: 'saved' } });
      expect(saved.status).toBe('succeeded');
      expect((await resolveManagedCommand(command.id, isolated.env)).launch.args).toEqual(['old']);
      const review = await controller.buildOperationReview({ kind: 'configSave', pluginId: 'team/demo', context: 'user', apply: true, retryApply: true, updates: {} });
      expect(review.changes).toContainEqual(expect.objectContaining({ title: 'tools/run/default', description: 'node · tool.mjs · 固定参数 ["saved"] · cwd=caller' }));
      expect(review.changes).toContainEqual(expect.objectContaining({ title: expect.stringMatching(/^Codex 权限规则 /u), description: expect.stringContaining(command.id) }));
      const result = await controller.executeOperation(review.reviewToken);
      expect(result.state, JSON.stringify(result)).toBe('succeeded');
      expect((await resolveManagedCommand(command.id, isolated.env)).launch.args).toEqual(['saved']);
    } finally { controller?.dispose(); await isolated.cleanup(); }
  });
});
