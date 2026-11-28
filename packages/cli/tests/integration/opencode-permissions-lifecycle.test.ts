import { createHash } from 'node:crypto';
import path from 'node:path';

import { normalizePluginCommand } from '@lesliechan721/aw-plugin-core/manifest';
import fs from 'fs-extra';
import { expect, it, onTestFinished, vi } from 'vitest';

import cliPackage from '../../package.json' with { type: 'json' };
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { runCli } from '../../src/index.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { renderPublicResult, type CommandResult } from '../../src/output/public-result.js';
import * as registry from '../../src/platforms/registry.js';
import { createConsoleTuiV4Controller } from '../../src/tui/controller-runtime.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { addCatalogSource, readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import * as safeFiles from '../../src/utils/safe-fs.js';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

function shellRule(resource: string, effect: 'allow' | 'ask' | 'deny') {
  return { action: 'shell', resource, effect };
}

const owner = 'local/probe';
const otherOwner = 'local/second';
const sharedAllow = shellRule('aw-other report *', 'allow');
const manualAllow = shellRule('aw-other manual *', 'allow');
const managedAllow = shellRule('aw command run local/probe -- show *', 'allow');
const managedAsk = shellRule('aw command run local/probe -- confirm *', 'ask');
const managedDeny = shellRule('aw command run local/probe -- blocked *', 'deny');

async function createPermissionFixture(secondRestriction?: 'exact' | 'unrepresentable', withConfig = false, userBatch = false, extraPrefixes: string[] = []) {
  const { env, layout } = getCurrentSourceTestIsolation();
  const catalog = path.join(layout.fixtureCwd, 'catalog');
  const projectA = path.join(layout.fixtureCwd, 'project-a');
  const projectB = path.join(layout.fixtureCwd, 'project-b');
  const userRoot = path.join(layout.xdgConfigHomeDir, 'opencode');
  const userConfig = path.join(userRoot, 'opencode.json');
  const projectConfig = path.join(projectA, 'opencode.json');
  const ownershipRoot = path.join(layout.awHomeDir, 'platforms/opencode/permission-ownership');
  const failSecondPreApply = path.join(layout.fixtureCwd, 'fail-second-preapply');
  const getAdapter = registry.getAgentPluginAdapter;
  const discovery = vi.spyOn(registry, 'getAgentPluginAdapter').mockImplementation((platform) => {
    const adapter = getAdapter(platform);
    if (platform !== 'opencode') return adapter;
    return { ...adapter, discover: async () => ({
      platform, availability: 'available', diagnostics: [], installations: [{
        id: 'fixture-opencode', product: 'cli', version: '2.2.6', availability: 'available', reasonCodes: [],
        entry: { kind: 'cli', executable: path.join(layout.fixtureCwd, 'opencode'), configRoot: userRoot },
      }],
    }) };
  });
  onTestFinished(() => discovery.mockRestore());

  await Promise.all([
    fs.ensureDir(path.join(projectA, '.git')),
    fs.ensureDir(path.join(projectB, '.git')),
    fs.outputFile(path.join(catalog, 'plugins/probe/tools/report.mjs'), 'console.log("report");\n'),
    fs.outputFile(path.join(catalog, 'plugins/probe/skills/report/SKILL.md'),
      '---\nname: report\ndescription: Shows a harmless local report.\n---\nUse the report command.\n'),
    fs.outputFile(path.join(catalog, 'plugins/probe/skills/report/README.md'), 'Local report fixture.\n'),
  ]);
  if (userBatch) {
    await fs.outputFile(path.join(catalog, 'plugins/second/pre-apply.mjs'), [
      "import fs from 'node:fs';",
      `if (fs.existsSync(${JSON.stringify(failSecondPreApply)})) process.exit(17);`,
    ].join('\n'));
  }
  if (withConfig) {
    await fs.outputFile(path.join(catalog, 'plugins/second/render.mjs'), [
      "import fs from 'node:fs';",
      "const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
      "const text = '---\\nname: second-report\\ndescription: A fixture for a configurable User Skill.\\n---\\nFlag: ' + context.config.values.flag;",
      "const components = context.allowedOutputKinds.includes('skill') ? [{ id: 'report', kind: 'skill', name: 'second-report', content: { files: { 'SKILL.md': { text } } } }] : [];",
      "console.log(JSON.stringify({ version: 3, components, omitted: [], unmet: [] }));",
    ].join('\n'));
  }
  const writeCatalog = (restriction: typeof secondRestriction, upgrade = false) => createDependencyCatalogSnapshotFixture(catalog, [{
    name: 'probe', configureManifest(manifest) {
      manifest.platforms = ['opencode'];
      if (userBatch && upgrade) manifest.version = '1.0.1';
      manifest.skills = './skills';
      manifest.command = normalizePluginCommand({
        mode: 'static', sourceDir: './tools',
        routes: { subcommands: ['show', 'confirm', 'blocked'].map((name) => ({ name, runner: 'node', entry: 'report.mjs' })) },
      }, manifest);
      manifest.extensions = { permissions: [{
        name: 'approval', allow: [...(userBatch ? [] : ['aw-other report']), 'aw-other manual', { argsPrefix: ['show'] }],
        ask: [{ argsPrefix: ['confirm'] }], deny: [{ argsPrefix: ['blocked'] }, ...(userBatch && !upgrade ? ['aw-other report', ...extraPrefixes] : [])],
      }] };
    },
  }, {
    name: 'second', configureManifest(manifest) {
      manifest.platforms = ['opencode'];
      if (upgrade) manifest.version = '1.0.1';
      if (withConfig) {
        manifest.config = { schemaVersion: 5, fields: { flag: { type: 'boolean', default: false } } };
        manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
        manifest.artifacts = { configKeys: ['flag'], scopes: ['user'] };
      }
      if (userBatch) manifest.scripts = { ...manifest.scripts, preApply: { path: './pre-apply.mjs' } };
      manifest.extensions = { permissions: [userBatch && upgrade
        ? { name: 'report', deny: ['aw-other report'], allow: ['aw-other manual', 'aw-other second'] }
        : restriction
        ? { name: 'report', deny: [restriction === 'exact' ? 'aw-other report' : 'aw-other report #note'] }
        : { name: 'report', allow: ['aw-other report', 'aw-other manual', ...(userBatch ? ['aw-other second', ...extraPrefixes] : [])] }] };
    },
  }]);
  await writeCatalog(secondRestriction);

  async function cli(cwd: string, args: string[]) {
    const captured = createCapturedCliIo();
    const exitCode = await runCli([...args, '--json'], { cwd, env, io: captured.io, interactive: false });
    const result = JSON.parse(captured.readStdout()) as CommandResult;
    expect(result.schemaVersion).toBe(2);
    if (!result.diagnostics.length) expect(captured.readStderr()).toBe('');
    return { exitCode, result };
  }
  async function success(cwd: string, args: string[]) {
    const { exitCode, result } = await cli(cwd, args);
    expect({ exitCode, status: result.status }, JSON.stringify(result.diagnostics)).toEqual({ exitCode: 0, status: 'success' });
    return result;
  }
  return { catalog, env, projectA, projectB, userConfig, projectConfig, ownershipRoot, cli, success, writeCatalog, failSecondPreApply };
}

async function fixture(...args: Parameters<typeof createPermissionFixture>) {
  const setup = await createPermissionFixture(...args);
  const { catalog, projectA, success } = setup;
  await success(projectA, ['source', 'add', 'local', '--path', catalog, '--primary', '--no-auto-check', '--yes']);
  await success(projectA, ['source', 'sync', 'local', '--yes']);
  await success(projectA, ['target', 'set', 'opencode', '--context', 'user', '--force']);
  return setup;
}

async function preparePermissionMergeFixture(timing: ReturnType<typeof createCommandTestTiming>) {
  const setup = await timing.measure('fixture-step', 'catalog.snapshot', () => createPermissionFixture());
  const { catalog, env, projectA: cwd } = setup;
  // Source registration and target selection are prerequisites, not part of the permission lifecycle under test.
  await timing.measure('fixture-step', 'source.configure', async () => {
    const { config, digest } = await readCatalogSourcesConfigSnapshot(env);
    const nextConfig = await addCatalogSource(config, {
      id: 'local', type: 'path', path: catalog, primary: true, autoCheck: false,
    }, cwd);
    await replaceCatalogSourcesConfig({ config: nextConfig, expectedDigest: digest, env });
  });
  await timing.measure('fixture-step', 'source.sync', () => syncCatalogSourceGeneration({
    sourceId: 'local', cliVersion: cliPackage.version, cwd, env, impactConfirmed: true,
  }));
  await timing.measure('fixture-step', 'target.preferences', () => setTargets({ cwd, env, scope: 'user' }, ['opencode']));
  return setup;
}

// Public lifecycle must write strict host config in the selected scope and release only the retiring owner's rules.
it('merges two OpenCode owners and preserves manual rules through scoped sync and removal', async (test) => {
  const timing = createCommandTestTiming(test);
  const { projectA, projectB, userConfig, projectConfig, success } = await timing.measure(
    'fixture', 'opencode-permissions', () => preparePermissionMergeFixture(timing),
  );
  const run = (phase: string, args: string[]) => timing.measure('command', phase, () => success(projectA, args));
  const userRules = [shellRule('*', 'allow'), shellRule('aw-other personal', 'ask')];
  const initialProjectRules = [shellRule('aw-other first', 'ask'), manualAllow, shellRule('aw-other last', 'deny')];
  await fs.outputJson(userConfig, { permissions: userRules });
  await fs.outputJson(projectConfig, { permissions: initialProjectRules, snapshots: false });

  await run('user-install', ['plugin', 'install', otherOwner, '--scope', 'user', '--context', 'user', '--target', 'opencode', '--yes']);
  const personal = await fs.readJson(userConfig);
  expect(personal).toEqual({ permissions: [expect.anything(), expect.anything(), ...userRules] });
  expect(personal.permissions.slice(0, 2)).toEqual(expect.arrayContaining([sharedAllow, manualAllow]));
  const userBytes = await fs.readFile(userConfig);
  await run('project-install', ['plugin', 'install', owner, otherOwner, '--scope', 'project', '--context', 'project', '--target', 'opencode', '--yes']);
  const installed = await fs.readJson(projectConfig);
  expect(installed).toEqual({ permissions: [expect.anything(), expect.anything(), ...initialProjectRules, managedAsk, managedDeny], snapshots: false });
  const projectGrants = installed.permissions.slice(0, 2);
  expect(projectGrants).toEqual(expect.arrayContaining([sharedAllow, managedAllow]));
  expect(await fs.pathExists(path.join(projectB, 'opencode.json'))).toBe(false);
  expect(await fs.readFile(userConfig)).toEqual(userBytes);

  const extraRule = shellRule('aw-other extra', 'ask');
  await fs.writeJson(projectConfig, { ...installed, permissions: [extraRule, ...installed.permissions] });
  await run('project-sync-after-edit', ['plugin', 'sync', owner, otherOwner, '--context', 'project', '--target', 'opencode', '--yes']);
  const afterEdit = await fs.readJson(projectConfig);
  expect(afterEdit).toEqual({ permissions: [...projectGrants, extraRule, ...initialProjectRules, managedAsk, managedDeny], snapshots: false });
  const syncedBytes = await fs.readFile(projectConfig);
  const synced = await run('project-idempotent-sync', ['plugin', 'sync', owner, otherOwner, '--context', 'project', '--target', 'opencode', '--yes']);
  expect(await fs.readFile(projectConfig)).toEqual(syncedBytes);
  expect(synced.diagnostics.filter(({ code }) => code === 'hostPermissionAdditionalImpact')).toEqual([]);

  await run('project-remove-first', ['plugin', 'remove', owner, '--scope', 'project', '--context', 'project', '--yes']);
  expect(await fs.readJson(projectConfig)).toEqual({ permissions: [sharedAllow, extraRule, ...initialProjectRules], snapshots: false });
  await run('project-remove-second', ['plugin', 'remove', otherOwner, '--scope', 'project', '--context', 'project', '--yes']);
  expect(await fs.readJson(projectConfig)).toEqual({ permissions: [extraRule, ...initialProjectRules], snapshots: false });
  expect(await fs.readFile(userConfig)).toEqual(userBytes);
}, 25_000);

it('reports a missing final OpenCode restriction even when the same manual rule still exists', async () => {
  const { projectA, userConfig, success } = await fixture('exact');
  const deny = shellRule('aw-other report *', 'deny');
  const weak = shellRule('*', 'allow');
  await fs.outputJson(userConfig, { permissions: [deny, weak] });
  await success(projectA, ['plugin', 'install', otherOwner, '--scope', 'user', '--context', 'user', '--target', 'opencode', '--yes']);
  expect((await fs.readJson(userConfig)).permissions).toEqual([deny, weak, deny]);
  const args = ['plugin', 'status', otherOwner, '--context', 'user'];
  const inspect = () => success(projectA, args);
  expect((await inspect()).diagnostics).not.toContainEqual(expect.objectContaining({ code: 'componentOutputMissing' }));
  await fs.writeJson(userConfig, { permissions: [deny, weak] });
  const drift = await inspect();
  expect(drift.diagnostics).toContainEqual(expect.objectContaining({ code: 'componentOutputMissing', detail: expect.objectContaining({ path: userConfig }) }));
  await fs.writeJson(userConfig, { permissions: [weak, deny, shellRule('unrelated *', 'allow')] });
  expect((await inspect()).diagnostics).not.toContainEqual(expect.objectContaining({ code: 'componentOutputMissing' }));
});

// A stricter existing rule must keep its effect and the CLI must report the action it skipped.
it('reports an OpenCode grant withheld by an existing ask rule', async () => {
  const { projectA, projectConfig, success } = await fixture();
  const manualRestriction = shellRule('*', 'ask');
  await fs.outputJson(projectConfig, { permissions: [manualRestriction] });
  const installed = await success(projectA, ['plugin', 'install', owner, '--scope', 'project', '--context', 'project', '--target', 'opencode', '--yes']);
  expect(installed.diagnostics).toContainEqual(expect.objectContaining({
    code: 'invocationPolicyNotApplied',
    subject: expect.objectContaining({ pluginId: owner, target: 'opencode', scope: 'project', field: 'permissions.approval' }),
    detail: expect.objectContaining({ reasonCode: 'permission-rule-conflict', skippedPermissionActions: ['allow'] }),
  }));
  const impacts = installed.diagnostics.filter(({ code }) => code === 'hostPermissionAdditionalImpact');
  expect(impacts.map(({ severity, detail }) => [severity, detail?.permissionAction, detail?.permissionResource]))
    .toEqual(expect.arrayContaining([['warning', 'ask', managedAsk.resource], ['warning', 'deny', managedDeny.resource]]));
  expect(impacts.every(({ detail }) => detail?.permissionAction !== 'allow')).toBe(true);
  expect(await fs.readJson(projectConfig)).toEqual({ permissions: [manualRestriction, managedAsk, managedDeny] });
});

it('requires confirmation for a User restriction that changes a previously installed Project grant', async () => {
  const { projectA, projectB, projectConfig, userConfig, cli, success } = await fixture('exact');
  await success(projectA, ['plugin', 'install', owner, '--scope', 'project', '--context', 'project', '--target', 'opencode', '--yes']);
  const original = await fs.readJson(projectConfig);
  expect(original.permissions).toContainEqual(sharedAllow);

  const install = ['plugin', 'install', otherOwner, '--scope', 'user', '--context', 'user', '--target', 'opencode'];
  const { exitCode, result } = await cli(projectB, install);
  expect(exitCode).toBe(3);
  expect(result.data).toMatchObject({ confirmation: { required: true, provided: false, effects: expect.arrayContaining([
    expect.objectContaining({ code: 'changeRelatedProjectPermissions', impact: 'shared', message: expect.stringContaining(projectConfig) }),
    expect.objectContaining({ code: 'hostPermissionAdditionalImpact', message: expect.stringContaining('unquoted words separated by single spaces') }),
  ]) } });
  expect(await fs.readJson(projectConfig)).toEqual(original);
  expect(await fs.pathExists(userConfig)).toBe(false);

  await success(projectB, [...install, '--yes']);
  expect((await fs.readJson(userConfig)).permissions).toContainEqual(shellRule(sharedAllow.resource, 'deny'));
  expect(await fs.readJson(projectConfig)).toEqual({ ...original,
    permissions: original.permissions.filter((item: unknown) => JSON.stringify(item) !== JSON.stringify(sharedAllow)) });
  expect(await fs.pathExists(path.join(projectB, 'opencode.json'))).toBe(false);

  const remove = ['plugin', 'remove', otherOwner, '--scope', 'user', '--context', 'user'];
  const removal = await cli(projectB, remove);
  expect(removal.exitCode).toBe(3);
  expect(removal.result.data).toMatchObject({ confirmation: { required: true, provided: false, effects: expect.arrayContaining([
    expect.objectContaining({ code: 'changeRelatedProjectPermissions', impact: 'shared', message: expect.stringContaining(projectConfig) }),
  ]) } });
  await success(projectB, [...remove, '--yes']);
  expect(await fs.readJson(projectConfig)).toEqual(original);
});

// Applying an existing User output after a Catalog update must preview cross-project permission changes.
it('requires configuration apply confirmation to update a known OpenCode Project', async () => {
  const { env, projectA, projectB, projectConfig, userConfig, cli, success, writeCatalog } = await fixture('exact', true);
  await success(projectB, ['plugin', 'install', otherOwner, '--scope', 'user', '--context', 'user', '--target', 'opencode', '--yes']);
  await success(projectA, ['plugin', 'install', owner, '--scope', 'project', '--context', 'project', '--target', 'opencode', '--yes']);
  const userBefore = await fs.readFile(userConfig);
  const projectBefore = await fs.readJson(projectConfig);
  expect(projectBefore.permissions).not.toContainEqual(sharedAllow);
  await writeCatalog(undefined, true);
  await success(projectB, ['source', 'sync', 'local', '--yes']);

  const apply = ['plugin', 'config', 'apply', otherOwner, '--context', 'user', '--target', 'opencode'];
  const set = ['plugin', 'config', 'set', otherOwner, 'flag', '--context', 'user', '--value-json', 'true', '--apply'];
  const confirmation = { required: true, provided: false,
    effects: expect.arrayContaining([
      expect.objectContaining({ code: 'changeRelatedProjectPermissions',
        message: expect.stringContaining(`${projectConfig}\nAdd allow shell ${sharedAllow.resource}`) }),
      expect.objectContaining({ code: 'hostPermissionAdditionalImpact', subject: { pluginId: owner, target: 'opencode', scope: 'project', field: 'permissions.approval' },
        message: expect.stringContaining(projectConfig) }),
    ]),
  };
  const preview = await cli(projectB, apply);
  expect(preview).toMatchObject({ exitCode: 3, result: { data: { confirmation } } });
  expect(renderPublicResult(preview.result)).toContain(`Warning: allow ${sharedAllow.resource} · ${projectConfig}`);
  expect(await cli(projectB, set)).toMatchObject({ exitCode: 3, result: { data: { confirmation, configWrite: 'notStarted' } } });
  const controller = createConsoleTuiV4Controller(createCliExecutionContext({ cwd: projectB, env, interactive: false }));
  await controller.load();
  const tui = await controller.buildOperationReview({ kind: 'configSave', pluginId: otherOwner, context: 'user',
    apply: true, retryApply: true, targets: ['opencode'] });
  expect(tui.requiresConfirmation).toBe(true);
  expect(tui.changes).toContainEqual(expect.objectContaining({ kind: 'change', description: expect.stringContaining(projectConfig) }));
  expect(tui.changes).toContainEqual(expect.objectContaining({ kind: 'warning', description: expect.stringContaining('unquoted words separated by single spaces') }));
  const tuiSave = await controller.buildOperationReview({ kind: 'configSave', pluginId: otherOwner, context: 'user',
    apply: true, updates: { flag: true } });
  expect(tuiSave.requiresConfirmation).toBe(true);
  expect(tuiSave.changes).toContainEqual(expect.objectContaining({ kind: 'change', description: expect.stringContaining(projectConfig) }));
  expect(await fs.readFile(userConfig)).toEqual(userBefore);
  expect(await fs.readJson(projectConfig)).toEqual(projectBefore);
  const applied = await success(projectB, [...apply, '--yes']);
  expect(applied.diagnostics).toContainEqual(expect.objectContaining({ code: 'hostPermissionAdditionalImpact', severity: 'warning',
    subject: expect.objectContaining({ pluginId: owner, target: 'opencode', scope: 'project' }),
    detail: expect.objectContaining({ path: projectConfig, permissionResource: sharedAllow.resource, permissionAction: 'allow' }),
  }));
  expect((await fs.readJson(projectConfig)).permissions).toContainEqual(sharedAllow);
}, 25_000);

it.each([false, true])('reports and recovers an unfinished Project after User removal (outputs only %s)', async (outputsOnly) => {
  const { projectA, projectB, projectConfig, userConfig, cli, success } = await fixture('exact');
  await success(projectA, ['plugin', 'install', owner, '--scope', 'project', '--context', 'project', '--target', 'opencode', '--yes']);
  const original = await fs.readJson(projectConfig);
  await success(projectB, ['plugin', 'install', otherOwner, '--scope', 'user', '--context', 'user', '--target', 'opencode', '--yes']);
  const replace = safeFiles.atomicReplaceSafeFile;
  const fail = vi.spyOn(safeFiles, 'atomicReplaceSafeFile').mockImplementation((options) => {
    if (options.filePath === projectConfig) throw new Error('Injected Project permission write failure');
    return replace(options);
  });
  onTestFinished(() => fail.mockRestore());
  const removal = await cli(projectB, ['plugin', 'remove', otherOwner, '--scope', 'user', '--context', 'user', '--yes',
    ...(outputsOnly ? ['--only', 'outputs', '--target', 'opencode'] : [])]);
  expect({ exitCode: removal.exitCode, status: removal.result.status }).toEqual({ exitCode: 4, status: 'partial' });
  expect(removal.result.diagnostics).toContainEqual(expect.objectContaining({ code: 'permissionRelatedProjectUpdateIncomplete',
    subject: expect.objectContaining({ target: 'opencode', scope: 'project' }),
    detail: expect.objectContaining({ path: projectConfig }) }));
  expect(removal.result.nextActions).toContainEqual(expect.objectContaining({ kind: 'manual',
    message: expect.stringContaining(outputsOnly ? 'Project OpenCode location' : 'aw plugin sync --context project --target opencode') }));
  expect((await fs.readJson(userConfig)).permissions).toEqual([]);
  expect((await fs.readJson(projectConfig)).permissions).not.toContainEqual(sharedAllow);
  fail.mockRestore();
  await success(projectA, ['plugin', 'sync', ...(outputsOnly ? [owner] : []), '--context', 'project', '--target', 'opencode', '--yes']);
  expect(await fs.readJson(projectConfig)).toEqual(original);
});

// A damaged or lost ownership file must never let offline cleanup delete existing rules.
it.each(['missing', 'corrupt'] as const)('preserves the OpenCode configuration with %s ownership during cleanup', async (damage) => {
  const { projectA, projectConfig, ownershipRoot, cli, success } = await fixture();
  const handWritten = shellRule('aw-other keep', 'ask');
  await fs.outputJson(projectConfig, { permissions: [handWritten] });
  await success(projectA, ['plugin', 'install', owner, '--scope', 'project', '--context', 'project', '--target', 'opencode', '--yes']);
  const configBytes = await fs.readFile(projectConfig);
  expect(await fs.readJson(projectConfig)).toMatchObject({ permissions: expect.arrayContaining([handWritten, managedAllow, managedAsk, managedDeny]) });
  const entries = await fs.readdir(ownershipRoot);
  expect(entries).toHaveLength(1);
  const ownership = path.join(ownershipRoot, entries[0]!);
  if (damage === 'missing') await fs.unlink(ownership);
  else await fs.writeFile(ownership, '{broken');

  const packageRoot = path.join(projectA, '.opencode', 'plugins');
  const [installedPackage] = await fs.readdir(packageRoot);
  const { result } = await cli(projectA, ['plugin', 'remove', owner, '--only', 'outputs', '--scope', 'project',
    '--context', 'project', '--target', 'opencode', '--yes']);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'permissionOwnershipDegraded',
    subject: expect.objectContaining({ pluginId: owner, target: 'opencode', scope: 'project' }),
  }));
  expect(await fs.readFile(projectConfig)).toEqual(configBytes);
  expect(installedPackage).toBeDefined();
  expect(await fs.pathExists(path.join(packageRoot, installedPackage!)), JSON.stringify(result)).toBe(false);
});


it.each([false, true])('reviews the strongest shared prefix for both installation orders (%s)', async (reverse) => {
  const { projectA, projectConfig, cli, success } = await fixture('exact');
  const plugins = reverse ? [otherOwner, owner] : [owner, otherOwner];
  const args = ['plugin', 'install', ...plugins, '--scope', 'project', '--context', 'project', '--target', 'opencode'];
  const { result } = await cli(projectA, args);
  const review = (result.data as { confirmation: { effects: Array<{ code: string; message: string; subject: { pluginId: string } }> } }).confirmation;
  const rules = review.effects.filter((effect) => effect.code === 'changeHostPermissions');
  expect(rules.filter((effect) => effect.subject.pluginId === owner).map((item) => item.message).join('\n')).not.toContain('allow shell aw-other report *');
  expect(rules.filter((effect) => effect.subject.pluginId === otherOwner).map((item) => item.message).join('\n')).toContain('deny shell aw-other report *');
  expect(review.effects).toContainEqual(expect.objectContaining({ code: 'invocationPolicyNotApplied', subject: expect.objectContaining({ pluginId: owner }) }));
  expect(await fs.pathExists(projectConfig)).toBe(false);
  const applied = await success(projectA, [...args, '--yes']);
  expect(applied.diagnostics).toContainEqual(expect.objectContaining({ code: 'invocationPolicyNotApplied', subject: expect.objectContaining({ pluginId: owner }),
    detail: expect.objectContaining({ skippedPermissionActions: ['allow'] }) }));
  const { permissions } = await fs.readJson(projectConfig);
  expect(permissions).toContainEqual(shellRule('aw-other report *', 'deny'));
  expect(permissions).not.toContainEqual(sharedAllow);
});

it.each(['none', 'preApply', 'project write', 'sidecar write'] as const)('reconciles a reviewed OpenCode User batch (%s failure)', async (failure) => {
  const localized = './工具/report';
  const privateLocation = '/Users/test-private-directory/report';
  const extraPrefixes = failure === 'sidecar write' ? [localized, privateLocation] : [];
  const { projectA, projectB, projectConfig, userConfig, ownershipRoot, cli, success, failSecondPreApply } =
    await fixture(undefined, false, true, extraPrefixes);
  const manual = shellRule('aw-other keep', 'ask');
  await fs.outputJson(projectConfig, { permissions: [manual], snapshots: false });
  await success(projectA, ['plugin', 'install', otherOwner, '--scope', 'project', '--context', 'project', '--target', 'opencode', '--yes']);
  const original = await fs.readJson(projectConfig);
  expect(original.permissions).toContainEqual(sharedAllow);
  const secondProjectConfig = path.join(projectB, 'opencode.json');
  if (failure === 'project write') {
    await success(projectB, ['plugin', 'install', otherOwner, '--scope', 'project', '--context', 'project', '--target', 'opencode', '--yes']);
    expect((await fs.readJson(secondProjectConfig)).permissions).toContainEqual(sharedAllow);
  }

  const args = ['plugin', 'install', owner, otherOwner, '--scope', 'user', '--context', 'user', '--target', 'opencode'];
  const preview = await cli(projectB, args);
  expect(preview).toMatchObject({ exitCode: 3, result: { data: { confirmation: { effects: expect.arrayContaining([
    expect.objectContaining({ code: 'changeRelatedProjectPermissions', message: expect.stringContaining(projectConfig) }),
    ...(failure === 'project write' ? [expect.objectContaining({
      code: 'changeRelatedProjectPermissions', message: expect.stringContaining(secondProjectConfig),
    })] : []),
  ]) } } } });
  expect(await fs.readJson(projectConfig)).toEqual(original);

  if (failure !== 'none') await fs.outputFile(failSecondPreApply, '');
  const originalReplace = safeFiles.atomicReplaceSafeFile;
  const projectSidecar = path.join(ownershipRoot, createHash('sha256').update(projectConfig).digest('hex') + '.json');
  const replace = vi.spyOn(safeFiles, 'atomicReplaceSafeFile').mockImplementation((options) => {
    if (failure === 'project write' && options.filePath === projectConfig) throw new Error('Injected Project permission write failure');
    if (failure === 'sidecar write' && options.filePath === projectSidecar) throw new Error('Injected Project ownership write failure');
    return originalReplace(options);
  });
  onTestFinished(() => replace.mockRestore());
  const applied = await cli(projectB, [...args, '--yes']);
  expect({ exitCode: applied.exitCode, status: applied.result.status, diagnostics: applied.result.diagnostics })
    .toMatchObject(failure === 'none' ? { exitCode: 0, status: 'success' } : { exitCode: 4, status: 'partial' });
  const userRules = (await fs.readJson(userConfig)).permissions;
  const secondRule = shellRule('aw-other second *', 'allow');
  expect(userRules).toContainEqual(shellRule(sharedAllow.resource, 'deny'));
  if (failure === 'none') expect(userRules).toContainEqual(secondRule);
  else expect(userRules).not.toContainEqual(secondRule);
  const linked = applied.result.diagnostics.flatMap(({ code, detail }) =>
    code === 'permissionRelatedProjectUpdateIncomplete' && detail?.path ? [detail.path] : []);
  const updatedProjects = applied.result.diagnostics.filter(({ code }) => code === 'permissionRelatedProjectUpdated');
  expect(updatedProjects).toEqual([expect.objectContaining({ severity: 'info',
    detail: expect.objectContaining({ path: failure === 'project write' ? secondProjectConfig : projectConfig,
      permissionChanges: expect.arrayContaining([{ change: 'remove', effect: 'allow', resource: sharedAllow.resource }]) }),
    message: expect.stringContaining(`Remove allow shell ${sharedAllow.resource}`),
  })]);
  const withdrawnResources = new Set([sharedAllow.resource, ...extraPrefixes.map((prefix) => prefix + ' *')]);
  const updated = { ...original, permissions: original.permissions.filter((rule: { resource: string }) => !withdrawnResources.has(rule.resource)) };
  if (failure === 'project write' || failure === 'sidecar write') {
    expect(linked).toEqual([projectConfig]);
    expect(applied.result.nextActions).toContainEqual(expect.objectContaining({ kind: 'manual',
      message: expect.stringContaining('Retry the failed User OpenCode targets first.') }));
    expect(applied.result.nextActions).toContainEqual(expect.objectContaining({ kind: 'manual',
      message: expect.stringContaining('aw plugin sync --context project --target opencode') }));
    expect(await fs.readJson(projectConfig)).toEqual(failure === 'project write' ? original : updated);
    if (failure === 'project write') {
      expect((await fs.readJson(secondProjectConfig)).permissions).not.toContainEqual(sharedAllow);
    } else {
      expect(updatedProjects[0]?.detail?.permissionChanges).toEqual(expect.arrayContaining([
        { change: 'remove', effect: 'allow', resource: localized + ' *' },
        { change: 'remove', effect: 'allow', resource: '[local path] *' },
      ]));
      expect(updatedProjects[0]?.message).toContain(`Remove allow shell ${localized} *`);
      expect(updatedProjects[0]?.message).not.toContain(privateLocation);
    }
    replace.mockRestore();
    await fs.remove(failSecondPreApply);
    await success(projectB, ['plugin', 'sync', otherOwner, '--context', 'user', '--target', 'opencode', '--yes']);
    await success(projectA, ['plugin', 'sync', otherOwner, '--context', 'project', '--target', 'opencode', '--yes']);
  } else {
    expect(linked).toEqual([]);
    if (failure === 'preApply') {
      expect(applied.result.diagnostics).toContainEqual(expect.objectContaining({ code: 'preApplyFailed',
        subject: expect.objectContaining({ pluginId: otherOwner, scope: 'user' }) }));
      await fs.remove(failSecondPreApply);
      await success(projectB, ['plugin', 'sync', otherOwner, '--context', 'user', '--target', 'opencode', '--yes']);
      expect((await fs.readJson(userConfig)).permissions).toContainEqual(secondRule);
    }
  }
  expect(await fs.readJson(projectConfig)).toEqual(updated);
}, 30_000);

it.each([false, true])('reports unsettled Project permissions when User owners replace a restriction (preApply failure %s)', async (fail) => {
  const { projectA, projectB, projectConfig, userConfig, cli, success, writeCatalog, failSecondPreApply } = await fixture(undefined, false, true);
  const user = ['--scope', 'user', '--context', 'user', '--target', 'opencode'];
  await success(projectA, ['plugin', 'install', otherOwner, '--scope', 'project', '--context', 'project', '--target', 'opencode', '--yes']);
  await success(projectB, ['plugin', 'install', owner, otherOwner, ...user, '--yes']);
  const before = await fs.readJson(projectConfig);
  expect(before.permissions).not.toContainEqual(sharedAllow);
  await writeCatalog(undefined, true);
  await success(projectB, ['source', 'sync', 'local', '--yes']);

  const sync = ['plugin', 'sync', owner, otherOwner, '--context', 'user', '--target', 'opencode'];
  const preview = await cli(projectB, sync);
  expect(preview.exitCode).toBe(3);
  const effects = (preview.result.data as { confirmation: { effects: { code: string }[] } }).confirmation.effects;
  expect(effects.some(({ code }) => code === 'changeRelatedProjectPermissions')).toBe(false);
  if (fail) await fs.outputFile(failSecondPreApply, '');
  const applied = await cli(projectB, [...sync, '--yes']);
  expect({ exitCode: applied.exitCode, status: applied.result.status, diagnostics: applied.result.diagnostics })
    .toMatchObject(fail ? { exitCode: 4, status: 'partial' } : { exitCode: 0, status: 'success' });
  expect(await fs.readJson(projectConfig)).toEqual(before);
  const pendingPaths = applied.result.diagnostics.flatMap(({ code, detail }) =>
    code === 'permissionRelatedProjectUpdateIncomplete' && detail?.path ? [detail.path] : []);
  expect(pendingPaths).toEqual(fail ? [projectConfig] : []);
  const sharedDeny = shellRule(sharedAllow.resource, 'deny');
  if (fail) {
    expect((await fs.readJson(userConfig)).permissions).not.toContainEqual(sharedDeny);
    expect(applied.result.nextActions).toContainEqual(expect.objectContaining({ kind: 'manual',
      message: expect.stringContaining('aw plugin sync --context project --target opencode') }));
    await fs.remove(failSecondPreApply);
    await success(projectB, ['plugin', 'sync', otherOwner, '--context', 'user', '--target', 'opencode', '--yes']);
  }
  expect((await fs.readJson(userConfig)).permissions).toContainEqual(sharedDeny);
  expect(await fs.readJson(projectConfig)).toEqual(before);
}, 30_000);

it('reports the owner whose installed grant is withdrawn for a new unrepresentable restriction', async () => {
  const { projectA, projectConfig, cli, success } = await fixture('unrepresentable');
  const args = ['--scope', 'project', '--context', 'project', '--target', 'opencode'];
  await success(projectA, ['plugin', 'install', owner, ...args, '--yes']);
  expect((await fs.readJson(projectConfig)).permissions).toContainEqual(sharedAllow);
  const { result: review } = await cli(projectA, ['plugin', 'install', otherOwner, ...args]);
  expect((review.data as { confirmation: { effects: unknown[] } }).confirmation.effects).toContainEqual(expect.objectContaining({
    code: 'invocationPolicyNotApplied', subject: expect.objectContaining({ pluginId: owner, field: 'permissions.approval' }) }));
  const result = await success(projectA, ['plugin', 'install', otherOwner, ...args, '--yes']);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'invocationPolicyNotApplied',
    subject: expect.objectContaining({ pluginId: owner, field: 'permissions.approval' }), detail: expect.objectContaining({ skippedPermissionActions: ['allow'] }) }));
  expect((await fs.readJson(projectConfig)).permissions).not.toContainEqual(sharedAllow);
});

// The project target remains at the repository root while native permission precedence follows the invocation directory.
it('protects a nested project rule during public install', async () => {
  const { projectA, projectConfig, success } = await fixture();
  const nested = path.join(projectA, 'packages', 'demo');
  const higherFile = path.join(nested, '.opencode/opencode.json');
  await fs.outputJson(higherFile, { permissions: [shellRule(managedAllow.resource, 'ask')] });
  const original = await fs.readFile(higherFile);
  const receipt = await success(nested, ['plugin', 'install', owner, '--scope', 'project', '--context', 'project', '--target', 'opencode', '--yes']);
  expect(receipt.diagnostics).toContainEqual(expect.objectContaining({ code: 'invocationPolicyNotApplied',
    detail: expect.objectContaining({ reasonCode: 'permission-rule-conflict', skippedPermissionActions: ['allow'] }) }));
  const projected = await fs.readJson(projectConfig);
  expect(projected.permissions).not.toContainEqual(managedAllow);
  expect(projected.permissions).toContainEqual(managedAsk);
  expect(await fs.readFile(higherFile)).toEqual(original);
});

it('installs and cleans user permission rules at the effective global configuration root', async () => {
  const { projectA, userConfig, success } = await fixture();
  const { env, layout } = getCurrentSourceTestIsolation();
  const override = path.join(layout.fixtureCwd, 'opencode-global');
  env.OPENCODE_CONFIG_DIR = override;
  const effective = path.join(override, 'opencode.json');
  const manual = shellRule('aw-other personal *', 'deny');
  await fs.outputJson(effective, { permissions: [manual] });
  const restricted = [shellRule('*', 'ask')];
  await fs.outputJson(userConfig, { permissions: restricted });
  await success(projectA, ['plugin', 'install', owner, '--scope', 'user', '--context', 'user', '--target', 'opencode', '--yes']);
  expect((await fs.readJson(effective)).permissions).toContainEqual(managedAllow);
  expect(await fs.readJson(userConfig)).toEqual({ permissions: restricted });
  await success(projectA, ['plugin', 'remove', owner, '--only', 'outputs', '--scope', 'user', '--context', 'user', '--target', 'opencode', '--yes']);
  expect(await fs.readJson(effective)).toEqual({ permissions: [manual] });
  expect(await fs.readJson(userConfig)).toEqual({ permissions: restricted });
});

it('retains permissions without blocking other cleanup when the configured global root is ambiguous', async () => {
  const { projectA, projectConfig, success, cli } = await fixture();
  await success(projectA, ['plugin', 'install', owner, '--scope', 'project', '--context', 'project', '--target', 'opencode', '--yes']);
  const previous = await fs.readFile(projectConfig);
  const packages = path.join(projectA, '.opencode/plugins');
  const [bundle] = await fs.readdir(packages);
  getCurrentSourceTestIsolation().env.OPENCODE_CONFIG_DIR = 'relative-config';
  const { result } = await cli(projectA, ['plugin', 'remove', owner, '--only', 'outputs', '--scope', 'project', '--context', 'project', '--target', 'opencode', '--yes']);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'permissionOwnershipDegraded',
    detail: expect.objectContaining({ reasonCode: 'permission-config-path-unconfirmed' }) }));
  expect(await fs.readFile(projectConfig)).toEqual(previous);
  expect(await fs.pathExists(path.join(packages, bundle!))).toBe(false);
});

it.each([false, true])('reports a partial permission removal to the public caller (outputs only %s)', async (onlyOutputs) => {
  const { projectA, projectConfig, ownershipRoot, cli, success } = await fixture();
  await success(projectA, ['plugin', 'install', owner, otherOwner, '--scope', 'project', '--context', 'project', '--target', 'opencode', '--yes']);
  expect((await fs.readJson(projectConfig)).permissions).toContainEqual(managedAsk);
  const replace = safeFiles.atomicReplaceSafeFile;
  const fail = vi.spyOn(safeFiles, 'atomicReplaceSafeFile').mockImplementation(async (options) => {
    if (path.dirname(options.filePath) === ownershipRoot) throw new Error('Injected sidecar update failure');
    return replace(options);
  });
  onTestFinished(() => fail.mockRestore());
  const { result } = await cli(projectA, ['plugin', 'remove', owner, ...(onlyOutputs ? ['--only', 'outputs', '--target', 'opencode'] : []),
    '--scope', 'project', '--context', 'project', '--yes']);
  expect((await fs.readJson(projectConfig)).permissions, JSON.stringify(result.diagnostics)).not.toContainEqual(managedAsk);
  expect(result.diagnostics, JSON.stringify(result)).toContainEqual(expect.objectContaining({
    code: 'permissionOwnershipWriteFailed', detail: expect.objectContaining({ path: projectConfig }),
  }));
});

// Both public removal modes must disclose a remaining owner's restored grant before changing the host file.
it.each(['regular removal', 'outputs-only cleanup'] as const)(
  'reviews and reports a remaining OpenCode grant restored by %s', async (mode) => {
    const { projectA, projectConfig, cli, success } = await fixture('exact');
    const scope = ['--scope', 'project', '--context', 'project'];
    const install = [...scope, '--target', 'opencode', '--yes'];
    const manual = shellRule('aw-other keep', 'ask');
    await fs.outputJson(projectConfig, { permissions: [manual], snapshots: false });
    await success(projectA, ['plugin', 'install', owner, ...install]);
    const original = await fs.readJson(projectConfig);
    expect(original.permissions).toContainEqual(sharedAllow);

    await success(projectA, ['plugin', 'install', otherOwner, ...install]);
    const restrictedBytes = await fs.readFile(projectConfig);
    const restricted = JSON.parse(restrictedBytes.toString('utf8'));
    expect(restricted.permissions).toContainEqual(shellRule(sharedAllow.resource, 'deny'));
    expect(restricted.permissions).not.toContainEqual(sharedAllow);

    const remove = ['plugin', 'remove', otherOwner, ...scope,
      ...(mode === 'outputs-only cleanup' ? ['--only', 'outputs', '--target', 'opencode'] : [])];
    const restoration = {
      code: 'hostPermissionRestored',
      subject: expect.objectContaining({ pluginId: owner, target: 'opencode', scope: 'project' }),
      message: expect.stringContaining('allow shell aw-other report *'),
    };
    const { exitCode, result: review } = await cli(projectA, remove);
    expect({ exitCode, status: review.status }).toEqual({ exitCode: 3, status: 'blocked' });
    expect(review.data).toMatchObject({ confirmation: { required: true, provided: false,
      effects: expect.arrayContaining([expect.objectContaining(restoration)]),
    } });
    expect(await fs.readFile(projectConfig)).toEqual(restrictedBytes);

    const removed = await success(projectA, [...remove, '--yes']);
    expect(removed.diagnostics).toContainEqual(expect.objectContaining({ ...restoration,
      detail: expect.objectContaining({ path: projectConfig }),
    }));
    expect(await fs.readJson(projectConfig)).toEqual(original);
  },
);
