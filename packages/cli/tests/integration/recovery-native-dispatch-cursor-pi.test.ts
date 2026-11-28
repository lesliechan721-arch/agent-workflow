import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { executeRecovery, prepareRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { runPublicPluginStatus } from '../../src/commands/public-plugin-query.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import type { CommandResult } from '../../src/output/public-result.js';
import type { LifecycleData } from '../../src/commands/public-lifecycle-result.js';
import { useEmptyGitRepositoryFixture } from '../helpers/git-repository-fixture.js';

const createEmptyGitRepository = useEmptyGitRepositoryFixture();

describe('Cursor and Pi native recovery', () => {
  // The preview is read-only; a new client at execution must stop both intent and output writes.
  it('blocks a reviewed static Cursor batch before saving intent when discovery changes', async () => {
    const { env: isolatedEnv, layout } = getCurrentSourceTestIsolation();
    const cwd = layout.fixtureCwd;
    const catalog = path.join(cwd, 'catalog');
    const bin = path.join(cwd, 'bin');
    const env = { ...isolatedEnv, PATH: bin };
    const names = ['guide', 'check'];
    await createEmptyGitRepository(cwd);
    await fs.outputFile(path.join(bin, process.platform === 'win32' ? 'cursor-agent.exe' : 'cursor-agent'), 'fixture entry', { mode: 0o755 });
    await Promise.all(names.flatMap((name) => {
      const skill = path.join(catalog, 'plugins', name, 'skills', name);
      return [
        fs.outputFile(path.join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: A fixture skill.\n---\nUse the fixture.\n`),
        fs.outputFile(path.join(skill, 'README.md'), 'A fixture skill.\n'),
      ];
    }));
    await createDependencyCatalogSnapshotFixture(catalog, names.map((name) => ({ name, configureManifest(manifest) {
      manifest.platforms = ['cursor'];
      manifest.skills = './skills';
    } })));
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: catalog }] }, expectedDigest: config.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    await setTargets({ cwd, env, scope: 'user' }, ['cursor']);

    const scope = 'project' as const;
    const options = { cwd, env, scope, context: scope, targets: ['cursor' as const], cliVersion: '1.0.0', yes: true };
    let version = '2026.11.05-86047df';
    const nativeCliRunner = async ({ args }: NativeCliInvocation) => {
      expect(args).toEqual(['--version']);
      return { exitCode: 0, stderr: '', stdout: 'Cursor Agent ' + version };
    };
    const plan = await prepareRecovery('install', names.map((name) => 'local/' + name), options, { nativeCliRunner });
    try {
      expect(plan.receipt.blockers).toEqual([]);
      expect(plan.receipt.targetResults.map(({ pluginId }) => pluginId).sort()).toEqual(['local/check', 'local/guide']);
      expect((await observeIntent(options)).state).toBe('absent');

      version = '2026.11.06-86047df';
      expect(await executeRecovery(plan)).toMatchObject({ ok: false, outputsMayHaveChanged: false,
        blockers: expect.arrayContaining([expect.objectContaining({ code: 'operationReviewStale' })]) });
      expect((await observeIntent(options)).state).toBe('absent');
      expect(await fs.pathExists(path.join(cwd, '.cursor'))).toBe(false);
    } finally { await plan.context.dispose(); }
  });

  // Test Value Gate: a concrete Agent failure must not fall back to scattered Skills or block the independent generic writer.
  it('keeps an unavailable Cursor native target separate from a successful generic output', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = path.join(isolation.layout.fixtureCwd, 'project');
    const source = path.join(isolation.layout.fixtureCwd, 'catalog');
    const pluginRoot = path.join(source, 'plugins', 'demo');
    const content = '---\nname: demo\ndescription: Fixture skill.\n---\nRun the fixture.\n';
    await fs.ensureDir(cwd);
    await createEmptyGitRepository(cwd);
    await fs.outputFile(path.join(pluginRoot, 'skills', 'demo', 'SKILL.md'), content);
    await fs.outputFile(path.join(pluginRoot, 'skills', 'demo', 'README.md'), 'Fixture skill.\n');
    await createCatalogSnapshotFixture(source, 'demo', [], 'Fixture.\n', (manifest) => {
      manifest.schemaVersion = 4;
      manifest.platforms = ['cursor', 'generic'];
      manifest.skills = './skills';
    });
    const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    const receipt = createAwPluginRequirementsReceipt({ name: 'demo', version: '1.0.0' }, plugin.manifest.requires?.aw.capabilities ?? []);
    for (const platform of ['cursor', 'generic']) {
      await fs.outputJson(path.join(pluginRoot, platform, 'skills', 'demo', 'aw-plugin-requirements.json'), receipt);
    }
    const catalogPath = path.join(source, 'catalog-manifest.json');
    await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries: [await createCatalogManifestV7Entry(plugin, pluginRoot)] });
    const config = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: source }] },
    expectedDigest: config.digest, env: isolation.env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env: isolation.env });
    await writeIntentFixture({ scope: 'project', cwd, env: isolation.env }, {
      roots: [{ pluginId: 'local/demo' }], targets: ['cursor', 'generic'],
    });
    await setTargets({ scope: 'user', cwd, env: isolation.env }, ['cursor', 'generic']);
    const result = await runRecovery('sync', [], { scope: 'project', context: 'project', cwd,
      env: isolation.env, cliVersion: '1.0.0', yes: true }, {
      nativeCliRunner: async () => { throw new Error('fixture client unavailable'); },
    });
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'cursor', delivery: { kind: 'native', platform: 'cursor' },
        observation: 'unknown', blockers: expect.any(Array) }),
      expect.objectContaining({ agent: 'generic', delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'generic' },
        execution: 'applied', content: 'satisfied' }),
    ]));
    expect(result.ok).toBe(false);
    expect(await fs.readFile(path.join(cwd, '.agents', 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe(content);
    expect(await fs.pathExists(path.join(cwd, '.cursor', 'skills'))).toBe(false);
  });

  // A renderer-only gap must survive a fresh public status read, beside zero or one real output.
  it.each([false, true])('converges native and generic renderer gaps with a delivered Skill: %s', async (mixed) => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const source = path.join(cwd, 'catalog');
    const bin = path.join(cwd, 'bin');
    const env = { ...isolation.env, PATH: bin };
    await createEmptyGitRepository(cwd);
    await fs.outputFile(path.join(bin, process.platform === 'win32' ? 'cursor-agent.exe' : 'cursor-agent'), 'fixture entry', { mode: 0o755 });
    const gap = { id: 'before', kind: 'hook', requiredFeatures: [{ feature: 'hook.common.before_tool', values: ['notify'] }],
      reasonCode: 'interface-unsupported' };
    const skill = { id: 'use-guide', kind: 'skill', name: 'guide', content: { files: {
      'SKILL.md': { text: '---\nname: guide\ndescription: Read the guide.\n---\nGuide.\n' },
      'README.md': { text: 'Guide.\n' },
    } } };
    await fs.outputFile(path.join(source, 'plugins/demo/render.mjs'), `
      import fs from 'node:fs';
      const { allowedOutputKinds } = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
      console.log(JSON.stringify({version: 3, components: allowedOutputKinds.includes('skill') ? ${JSON.stringify(mixed ? [skill] : [])} : [],
        omitted: [], unmet: allowedOutputKinds.includes('hook') ? [${JSON.stringify(gap)}] : []}));
    `);
    await createCatalogSnapshotFixture(source, 'demo', [], 'Renderer gaps.', (manifest) => {
      manifest.platforms = ['generic', 'cursor'];
      manifest.artifacts = { configKeys: [] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    });
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    await setTargets({ cwd, env, scope: 'user' }, ['cursor', 'generic']);
    const nativeCliRunner = async ({ args }: NativeCliInvocation) => {
      if (args.includes('--version')) return { exitCode: 0, stdout: 'Cursor Agent 2026.11.05-86047df', stderr: '' };
      throw new Error('Unexpected native operation');
    };
    const aw = async (...args: string[]) => {
      const result = await runCliEntry(['plugin', ...args, '--json'], { cwd, env, nativeCliRunner, interactive: false });
      const value = result.parseJsonStdout<CommandResult>();
      expect(result.exitCode, JSON.stringify(value)).toBe(0);
      return value;
    };
    const targets = ['cursor', 'generic'].map((target) => expect.objectContaining({ target,
      satisfaction: mixed ? 'installed' : 'not-applicable', installedComponentCount: mixed ? 1 : 0,
      installedComponentIds: mixed ? ['use-guide'] : [], componentGaps: [expect.objectContaining(gap)] }));
    const install = await aw('install', 'local/demo', '--scope', 'project', '--yes');
    expect(install.data, JSON.stringify(install)).toMatchObject({ remainingTargets: [], targetResults: expect.arrayContaining(targets) });
    const status = await aw('status', '--context', 'project');
    expect(status.data, JSON.stringify(status)).toMatchObject({ counts: { pending: 0 }, inSync: true, allSatisfied: true,
      inventory: [{ targetResults: expect.arrayContaining(targets) }] });
    const selected = await runPublicPluginStatus([], { targets: ['cursor'], context: 'project', cwd, env }, { nativeCliRunner });
    expect(selected.data).toMatchObject({ counts: { pending: 0 }, inSync: null, allSatisfied: null });
    const sync = await aw('sync', 'local/demo', '--context', 'project', '--yes');
    expect(sync.data, JSON.stringify(sync)).toMatchObject({ remainingTargets: [], changes: { outputs: 'none' },
      targetResults: expect.arrayContaining(targets) });
    if (mixed) {
      const packageHome = path.join(cwd, '.cursor', 'aw-plugins');
      const [installed] = await fs.readdir(packageHome);
      await fs.remove(path.join(packageHome, installed!, 'skills', 'guide', 'SKILL.md'));
      await fs.remove(path.join(cwd, '.agents', 'skills', 'guide'));
      const lost = await aw('status', '--context', 'project');
      expect(lost.data, JSON.stringify(lost)).toMatchObject({ counts: { pending: 2 }, allSatisfied: false, inSync: false });
    } else {
      const file = path.join(cwd, '.cursor', 'hooks.json');
      const quote = process.platform === 'win32' ? '"' : "'";
      const unrelated = { command: 'echo keep' };
      const command = `aw internal cursor-workspace-open --scope project --project-root ${quote}${cwd}${quote} --plugin-id ${quote}local/demo${quote}`;
      const hooks = { version: 1, hooks: { workspaceOpen: [unrelated, { command }] } };
      await fs.outputJson(file, hooks);
      const retained = await runPublicPluginStatus([], { cwd, env, context: 'project' }, { nativeCliRunner });
      expect(retained.data).toMatchObject({ allSatisfied: false, inSync: false });
      expect(retained.diagnostics).toContainEqual(expect.objectContaining({ code: 'previousDeploymentRetained' }));
      expect(await fs.readJson(file)).toEqual(hooks);
      await fs.outputJson(file, { version: 1, hooks: { workspaceOpen: [unrelated] } });
      expect((await aw('status', '--context', 'project')).data).toMatchObject({ allSatisfied: true });
    }
  });

  // A generated extension must not stale the next install or hide a missing role consumer. External drift still invalidates Review.
  it.each([
    { scope: 'user', foreignRegistration: false }, { scope: 'project', foreignRegistration: false },
    { scope: 'project', foreignRegistration: true },
  ] as const)('validates Pi $scope batch evidence (external registration: $foreignRegistration)', async ({ scope, foreignRegistration }) => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const source = path.join(cwd, 'pi-batch-catalog');
    const bin = path.join(cwd, 'bin');
    const env = { ...isolation.env, PATH: bin };
    await createEmptyGitRepository(cwd);
    await fs.outputFile(path.join(bin, process.platform === 'win32' ? 'pi.exe' : 'pi'), 'fixture entry', { mode: 0o755 });
    await createDependencyCatalogSnapshotFixture(source, [
      { name: 'guide', configureManifest: (manifest) => { manifest.platforms = ['pi']; } },
      { name: 'roles', dependencies: ['guide'], configureManifest(manifest) {
        manifest.platforms = ['pi'];
        manifest.extensions = { agents: [{ name: 'reviewer', description: 'Review the work.', prompt: 'Check the work.' }] };
      } },
    ]);
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    await setTargets({ cwd, env, scope: 'user' }, ['pi']);
    const userRoot = resolvePlatformConfigRoot('pi', { cwd, env });
    const root = scope === 'user' ? userRoot : path.join(cwd, '.pi');
    const settings = path.join(root, 'settings.json');
    if (scope === 'project') await fs.outputJson(path.join(userRoot, 'settings.json'), { defaultProjectTrust: 'always' });
    const externalSource = './external-package';
    if (foreignRegistration) await fs.outputJson(path.join(root, externalSource, 'package.json'), { name: 'external-package', pi: { extensions: [] } });
    const nativeCliRunner = async ({ args, cwd: nativeCwd }: NativeCliInvocation) => {
      const reply = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
      if (args.includes('--version')) return reply('1.5.0');
      if (args.includes('--help')) return reply('Pi coding agent');
      const current = await fs.readJson(settings, { throws: false }).catch(() => null) ?? {};
      const packages: string[] = current.packages ?? [];
      if (args[0] === 'list') return reply(packages.length && (scope === 'user' || nativeCwd === cwd) ? [scope === 'user' ? 'User packages:' : 'Project packages:',
        ...packages.flatMap((item) => [`  ${item}`, `    ${path.join(root, item)}`]), ''].join('\n') : 'No packages installed.\n');
      const installedPath = args.at(-1)!;
      if (args[0] !== 'install' || args.includes('--local') !== (scope === 'project') || !path.isAbsolute(installedPath)) {
        throw new Error('Unexpected Pi operation');
      }
      const registration = path.relative(root, installedPath).split(path.sep).join('/');
      const sources = [...packages, registration, ...(foreignRegistration ? [externalSource] : [])];
      await fs.outputJson(settings, { ...current, packages: [...new Set(sources)] });
      return reply(`Installed ${installedPath}`);
    };

    const result = await runCliEntry(['plugin', 'install', 'local/guide', 'local/roles', '--scope', scope, '--context', scope, '--yes', '--json'],
      { cwd, env, nativeCliRunner, interactive: false });
    const install = result.parseJsonStdout<CommandResult<LifecycleData>>();
    const guide = path.join(root, 'aw-packages', 'aw-local-guide');
    const roles = path.join(root, 'aw-packages', 'aw-local-roles');
    expect(await fs.readJson(path.join(guide, 'package.json'))).toMatchObject({ pi: { extensions: ['./index.mjs'] } });
    if (foreignRegistration) {
      expect(result.exitCode, JSON.stringify(install)).toBe(4);
      expect(install.data).toMatchObject({ remainingTargets: [{ pluginId: 'local/roles', target: 'pi', scope }], targetResults: [
        { pluginId: 'local/guide', execution: 'applied' }, { pluginId: 'local/roles', blockerCodes: ['operationPlanStale'] },
      ] });
      expect(await fs.pathExists(roles)).toBe(false);
      expect(await fs.readJson(settings)).toMatchObject({ packages: expect.arrayContaining([externalSource]) });
      return;
    }
    expect(result.exitCode, JSON.stringify(install)).toBe(0);
    expect(install.data).toMatchObject({ remainingTargets: [], targetResults: [
      { pluginId: 'local/guide', execution: 'applied', observation: 'verified' },
      { pluginId: 'local/roles', execution: 'applied', observation: 'verified' },
    ] });
    expect(install.diagnostics).toContainEqual(expect.objectContaining({ code: 'piAgentConsumerUnavailable',
      subject: expect.objectContaining({ pluginId: 'local/roles' }), detail: { reasonCode: 'piAgentConsumerMissing' } }));
    expect(await fs.readdir(path.join(roles, 'agents'))).toHaveLength(1);

    const reviewed = await prepareRecovery('sync', ['local/roles'], { cwd, env, scope, context: scope, yes: true, cliVersion: '1.0.0' }, { nativeCliRunner });
    try {
      expect(reviewed.receipt.blockers).toEqual([]);
      const extension = path.join(guide, 'index.mjs');
      const changed = 'export default function register(pi) { pi.registerTool({ name: "user-tool" }); }\n';
      await fs.writeFile(extension, changed);
      const status = await readRecoveryStatus({ context: scope, cwd, env, nativeCliRunner });
      for (const pluginId of ['local/guide', 'local/roles']) {
        const target = status.inventory?.find((item) => item.pluginId === pluginId)?.targetResults[0];
        expect(target?.deploymentObservations?.[0]?.after.prerequisites.agentConsumers).toMatchObject({
          observation: 'unknown', reasonCodes: ['agentConsumerDiscoveryUnverified'],
        });
      }
      expect(await executeRecovery(reviewed)).toMatchObject({ ok: false, outputsMayHaveChanged: false,
        blockers: expect.arrayContaining([expect.objectContaining({ code: 'operationReviewStale' })]) });
      expect(await fs.readFile(extension, 'utf8')).toBe(changed);
    } finally { await reviewed.context.dispose(); }
  });

  it('keeps installed Pi roles current while the execution extension changes', async () => {
    // Test Value Gate: check live notices and no-op sync without masking a lost role file.
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const source = path.join(cwd, 'pi-roles-catalog');
    const bin = path.join(cwd, 'bin');
    const env = { ...isolation.env, PATH: bin };
    await fs.outputFile(path.join(bin, process.platform === 'win32' ? 'pi.exe' : 'pi'), 'fixture entry', { mode: 0o755 });
    const skill = { id: 'review-guide', name: 'review-guide', kind: 'skill', requires: [{ feature: 'component.kind.agent' }],
      content: { files: { 'SKILL.md': { text: '---\nname: review-guide\ndescription: Use the installed reviewer.\n---\nReview the work.\n' },
        'README.md': { text: 'Use the reviewer.' } } } };
    await fs.outputFile(path.join(source, 'plugins/roles/render.mjs'), `import fs from 'node:fs';
const { allowedOutputKinds } = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
console.log(JSON.stringify({version:3,components:allowedOutputKinds.includes('skill') ? [${JSON.stringify(skill)}] : [],omitted:[],unmet:[]}));`);
    await createCatalogSnapshotFixture(source, 'roles', [], 'Pi roles.', (manifest) => {
      manifest.platforms = ['pi'];
      manifest.artifacts = { configKeys: [] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
      manifest.extensions = { agents: [{ name: 'reviewer', description: 'Review the work.', prompt: 'Check the work.' }] };
    });
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    await setTargets({ cwd, env, scope: 'user' }, ['pi']);
    const root = resolvePlatformConfigRoot('pi', { cwd, env });
    const settings = path.join(root, 'settings.json');
    const extension = 'npm:@tintinweb/pi-subagents@0.22.0';
    const extensionRoot = path.join(root, 'npm', 'node_modules', '@tintinweb', 'pi-subagents');
    const registration = 'aw-packages/aw-local-roles';
    const packageRoot = path.join(root, registration);
    let installs = 0;
    const nativeCliRunner = async ({ args }: NativeCliInvocation) => {
      const reply = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
      if (args.includes('--version')) return reply('Pi coding agent 1.5.0');
      const packages: Array<string | { source: string }> = (await fs.readJson(settings, { throws: false }).catch(() => null))?.packages ?? [];
      if (args[0] === 'list') return reply(packages.length ? ['User packages:',
        ...packages.flatMap((entry) => {
          const name = typeof entry === 'string' ? entry : entry.source;
          return [`  ${name}`, `    ${name === extension ? extensionRoot : packageRoot}`];
        }), ''].join('\n') : 'No packages installed.\n');
      if (args[0] !== 'install' || args.includes('--local') || args.at(-1) !== packageRoot) throw new Error('Unexpected Pi operation');
      installs++;
      await fs.outputJson(settings, { packages: [registration] });
      return reply(`Installed ${packageRoot}`);
    };
    const aw = async (...args: string[]) => {
      const result = await runCliEntry(['plugin', ...args, '--context', 'user', '--json'], { cwd, env, nativeCliRunner, interactive: false });
      return { exitCode: result.exitCode, value: result.parseJsonStdout<CommandResult>() };
    };
    const role = { target: 'pi', scope: 'user', satisfaction: 'installed', installedComponentCount: 2,
      installedComponentIds: expect.arrayContaining(['agent:reviewer', 'review-guide']) };
    const notice = (reasonCode: string) => expect.objectContaining({ code: 'piAgentConsumerUnavailable', severity: 'warning', detail: { reasonCode } });
    const install = await aw('install', 'local/roles', '--scope', 'user', '--yes');
    expect(install, JSON.stringify(install)).toMatchObject({ exitCode: 0, value: { diagnostics: expect.arrayContaining([notice('piAgentConsumerMissing')]),
      data: { remainingTargets: [], targetResults: [role] } } });
    expect(await fs.readFile(path.join(packageRoot, 'skills/review-guide/SKILL.md'), 'utf8')).toContain('Review the work.');
    const agentRoot = path.join(packageRoot, 'agents');
    const [agentFile] = await fs.readdir(agentRoot);
    const rolePath = path.join(agentRoot, agentFile!);
    const roleBytes = await fs.readFile(rolePath);
    const untouchedTimestamp = new Date('2020-01-01T00:00:00Z');
    await fs.utimes(rolePath, untouchedTimestamp, untouchedTimestamp);
    const assertStatus = async () => {
      const status = await aw('status');
      expect(status, JSON.stringify(status)).toMatchObject({ exitCode: 0, value: { data: { counts: { pending: 0 }, allSatisfied: true,
        inSync: true, inventory: [{ targetResults: [role] }] } } });
      expect(status.value.diagnostics.map(({ code }) => code)).not.toContain('platformInputDrift');
      expect(status.value.nextActions).toEqual([]);
      return status.value.diagnostics;
    };
    expect(await assertStatus()).toContainEqual(notice('piAgentConsumerMissing'));
    await fs.outputJson(path.join(extensionRoot, 'package.json'), { name: '@tintinweb/pi-subagents', version: '0.22.0', pi: { extensions: ['./index.ts'] } });
    await fs.outputFile(path.join(extensionRoot, 'index.ts'), 'export default function () {}\n');
    await fs.outputJson(settings, { packages: [registration, { source: extension, extensions: [] }] });
    expect(await assertStatus()).toContainEqual(notice('piAgentConsumerDisabled'));
    await fs.outputJson(settings, { packages: [registration, extension] });
    expect((await assertStatus()).map(({ code }) => code)).not.toContain('piAgentConsumerUnavailable');
    const extensionSettings = path.join(root, 'subagents.json');
    await fs.outputJson(extensionSettings, { packageAgents: false });
    expect(await assertStatus()).toContainEqual(notice('piAgentPackageAccessDenied'));
    await fs.writeFile(extensionSettings, '{');
    const unreadable = await assertStatus();
    expect(unreadable.map(({ code }) => code)).toContain('piConfigurationUnconfirmed');
    expect(unreadable).toContainEqual(notice('piConfigurationUnconfirmed'));
    await fs.writeJson(extensionSettings, {});
    const sync = await aw('sync', 'local/roles', '--yes');
    expect(sync, JSON.stringify(sync)).toMatchObject({ exitCode: 0, value: { data: { remainingTargets: [], changes: { outputs: 'none' } } } });
    expect(installs).toBe(1);
    await expect(fs.readFile(rolePath)).resolves.toEqual(roleBytes);
    expect((await fs.stat(rolePath)).mtimeMs).toBe(untouchedTimestamp.getTime());

    await fs.remove(rolePath);
    const missing = await aw('status');
    expect(missing.value.data, JSON.stringify(missing)).toMatchObject({ counts: { pending: 1 }, allSatisfied: false, inSync: false });
    expect(missing.value.diagnostics).toContainEqual(expect.objectContaining({ code: 'componentOutputMissing' }));
  });

  it('verifies a zero-output Pi Project against current registration and the skipped Hook script', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const source = path.join(cwd, 'pi-catalog');
    const pluginRoot = path.join(source, 'plugins/demo');
    const script = path.join(pluginRoot, 'pi/scripts/guard.mjs');
    const bin = path.join(cwd, 'bin');
    const env = { ...isolation.env, PATH: bin };
    await createEmptyGitRepository(cwd);
    await fs.outputFile(path.join(bin, process.platform === 'win32' ? 'pi.exe' : 'pi'), 'fixture entry', { mode: 0o755 });
    await fs.outputFile(script, 'export {};\n');
    await createCatalogSnapshotFixture(source, 'demo', [], 'Pi Project Hook.', (manifest) => {
      manifest.platforms = ['pi'];
      manifest.extensions = { hooks: [{ id: 'guard', event: 'before_tool', feedback: 'block', command: 'node ./scripts/guard.mjs' }] };
    });
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    await setTargets({ cwd, env, scope: 'user' }, ['pi']);
    let list = 'No packages installed.\n';
    let listReadable = true;
    const nativeCliRunner = async ({ args }: NativeCliInvocation) => {
      if (args.includes('--version')) return { exitCode: 0, stdout: 'Pi coding agent 1.5.0', stderr: '' };
      if (args[0] === 'list') return { exitCode: listReadable ? 0 : 1, stdout: listReadable ? list : '', stderr: '' };
      throw new Error('A skipped Hook needs no Pi mutation.');
    };
    const aw = async (...args: string[]) => {
      const result = await runCliEntry(['plugin', ...args, '--json'], { cwd, env, nativeCliRunner, interactive: false });
      return { exitCode: result.exitCode, value: result.parseJsonStdout<CommandResult>() };
    };
    const target = { target: 'pi', scope: 'project', satisfaction: 'not-applicable', installedComponentCount: 0,
      componentGaps: [expect.objectContaining({ kind: 'hook', requiredFeatures: [{ feature: 'hook.common.before_tool', values: ['block'] }] })] };
    const install = await aw('install', 'local/demo', '--scope', 'project', '--yes');
    expect(install, JSON.stringify(install)).toMatchObject({ exitCode: 0, value: { data: { remainingTargets: [], targetResults: [target] } } });
    const status = () => aw('status', '--context', 'project');
    const clean = await status();
    expect(clean, JSON.stringify(clean)).toMatchObject({ exitCode: 0, value: { data: { counts: { pending: 0 }, allSatisfied: true,
      inSync: true, inventory: [{ targetResults: [{ ...target, deploymentObservations: [{ after: { registration: 'unknown' } }] }] }] } } });
    const sync = await aw('sync', 'local/demo', '--context', 'project', '--yes');
    expect(sync, JSON.stringify(sync)).toMatchObject({ exitCode: 0, value: { data: { remainingTargets: [], changes: { outputs: 'none' } } } });

    listReadable = false;
    const unreadable = await status();
    expect(unreadable.exitCode).not.toBe(0);
    expect(unreadable.value.data).toMatchObject({ allSatisfied: null, inSync: null });
    listReadable = true;
    const packageRoot = path.join(cwd, '.pi', 'aw-packages', 'aw-local-demo');
    list = `Project packages:\n  npm:foreign-source\n    ${packageRoot}\n`;
    expect((await status()).value.data).toMatchObject({ allSatisfied: null, inSync: null });
    list = 'No packages installed.\n';
    await fs.outputJson(path.join(cwd, '.pi', 'settings.json'), { packages: ['./aw-packages/aw-local-demo'] });
    expect((await status()).value.data).toMatchObject({ allSatisfied: false, inSync: false });

    await fs.outputJson(path.join(cwd, '.pi', 'settings.json'), {});
    const updateSource = async () => {
      const catalogPath = path.join(source, 'catalog-manifest.json');
      const changed = await readPluginManifest(pluginRoot, { mode: 'bundle' });
      await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries: [await createCatalogManifestV7Entry(changed, pluginRoot)] });
      await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    };
    await fs.appendFile(script, '// updated input\n');
    await updateSource();
    expect((await status()).value.data).toMatchObject({ allSatisfied: null, inSync: null });
    expect((await aw('sync', 'local/demo', '--context', 'project', '--yes')).exitCode).toBe(0);
    expect((await status()).value.data).toMatchObject({ allSatisfied: true, inSync: true });
    await fs.remove(script);
    await updateSource();
    const damaged = await aw('sync', 'local/demo', '--context', 'project', '--yes');
    expect(damaged.exitCode).not.toBe(0);
    const afterDamage = await status();
    expect(afterDamage.exitCode).not.toBe(0);
    expect(afterDamage.value.data).toMatchObject({ allSatisfied: null, inSync: null,
      inventory: [{ targetResults: [{ content: 'unknown', satisfaction: 'unknown', blockerCodes: expect.arrayContaining(['componentResourceMissing']) }] }] });
  });

  // Test Value Gate: an executed empty set must remain current through read-only status, until its source inputs change.
  it('persists an intentional empty native set without mutations and invalidates changed inputs', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = path.join(isolation.layout.fixtureCwd, 'empty-project');
    const source = path.join(isolation.layout.fixtureCwd, 'empty-catalog');
    const pluginRoot = path.join(source, 'plugins', 'empty');
    const bin = path.join(isolation.layout.fixtureCwd, 'bin');
    const rendererCalls = path.join(isolation.layout.fixtureCwd, 'empty-renderer-calls');
    await fs.ensureDir(cwd);
    await createEmptyGitRepository(cwd);
    await fs.outputFile(path.join(bin, 'cursor-agent'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'),
      `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(rendererCalls)}, 'render\\n');\nprocess.stdout.write(JSON.stringify({ version: 3, components: [], omitted: [], unmet: [] }));\n`);
    await createCatalogSnapshotFixture(source, 'empty', [], 'Empty fixture.\n', (manifest) => {
      manifest.schemaVersion = 4;
      manifest.platforms = ['cursor'];
      manifest.artifacts = { configKeys: [] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    });
    const env = { ...isolation.env, PATH: bin };
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: source }] },
    expectedDigest: config.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    await writeIntentFixture({ scope: 'project', cwd, env }, { roots: [{ pluginId: 'local/empty' }], targets: ['cursor'] });
    const nativeCliRunner = async ({ args }: { args: string[] }) => {
      if (args.includes('--version')) return { exitCode: 0, stdout: 'Cursor Agent 2026.11.05-86047df', stderr: '' };
      throw new Error('The empty fixture must not execute native mutations.');
    };
    const result = await runRecovery('sync', [], { scope: 'project', context: 'project', cwd, env,
      cliVersion: '1.0.0', yes: true }, { nativeCliRunner });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const target = result.targetResults.find((entry) => entry.agent === 'cursor')!;
    expect(target).toMatchObject({ execution: 'no-op', content: 'satisfied',
      deploymentReceipts: [expect.objectContaining({ effects: [], unmet: [],
        products: [expect.objectContaining({ product: 'cli', version: '2026.11.05-86047df' })] })],
    });
    expect(result.outputsMayHaveChanged).toBe(false);
    expect(await fs.pathExists(path.join(cwd, '.cursor', 'aw-plugins'))).toBe(false);
    const callsAfterExecute = await fs.readFile(rendererCalls, 'utf8');
    const matched = await readRecoveryStatus({ context: 'project', cwd, env, nativeCliRunner, targets: ['cursor'] });
    expect(matched.allSatisfied, JSON.stringify(matched)).toBe(true);
    expect(await fs.readFile(rendererCalls, 'utf8')).toBe(callsAfterExecute);

    await fs.appendFile(path.join(pluginRoot, 'render.mjs'), '// Changed renderer input.\n');
    const changedPlugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    const catalogPath = path.join(source, 'catalog-manifest.json');
    await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries: [await createCatalogManifestV7Entry(changedPlugin, pluginRoot)] });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    const drifted = await readRecoveryStatus({ context: 'project', cwd, env, nativeCliRunner, targets: ['cursor'] });
    expect(drifted.allSatisfied).not.toBe(true);
    expect(drifted.inventory?.flatMap((entry) => entry.targetResults)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'cursor', content: 'unknown', blockers: [], reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'dynamicExpectationUnconfirmed' }),
      ]) }),
    ]));
    expect(await fs.readFile(rendererCalls, 'utf8')).toBe(callsAfterExecute);
  });
});
