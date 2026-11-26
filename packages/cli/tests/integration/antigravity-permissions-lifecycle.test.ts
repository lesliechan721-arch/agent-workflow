import path from 'node:path';
import { normalizePluginCommand } from '@lesliechan721/aw-plugin-core/manifest';
import fs from 'fs-extra';
import { expect, it, onTestFinished, vi } from 'vitest';

import { runCli } from '../../src/index.js';
import type { CommandResult, Confirmation } from '../../src/output/public-result.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import * as registry from '../../src/platforms/registry.js';
import * as safeFiles from '../../src/utils/safe-fs.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const user = ['--scope', 'user', '--context', 'user', '--target', 'antigravity'];
const project = ['--scope', 'project', '--context', 'project', '--target', 'antigravity'];
const sharedAllow = 'command(aw-fixture text)';
const manualAllow = 'command(aw-fixture manual)';
const managedAllow = 'command(aw command run local/probe/antigravity -- show)';
const managedAsk = 'command(aw command run local/probe/antigravity -- confirm)';
const managedDeny = 'command(aw command run local/probe/antigravity -- blocked)';
const inactiveDeny = 'command(aw command run local/probe/antigravity -- future)';

async function fixture(extraPermission?: { name: string; ask: string[] }) {
  const { env, layout } = getCurrentSourceTestIsolation();
  const catalog = path.join(layout.fixtureCwd, 'catalog');
  const projectA = path.join(layout.fixtureCwd, 'project-a');
  const projectB = path.join(layout.fixtureCwd, 'project-b');
  const host = resolvePlatformConfigRoot('antigravity', { cwd: projectA, env });
  const global = path.join(path.dirname(host), 'antigravity-cli', 'settings.json');
  const discoverySettings = path.join(host, 'settings.json');
  const sharedCandidate = path.join(path.dirname(host), 'settings.json');
  const ownership = path.join(layout.awHomeDir, 'platforms/antigravity/permission-ownership');
  const nativeCopies = path.join(host, 'plugins');

  const getAdapter = registry.getAgentPluginAdapter;
  let product: 'cli' | 'app' | 'missing' = 'cli';
  const discovered = vi.spyOn(registry, 'getAgentPluginAdapter').mockImplementation((platform) => {
    const adapter = getAdapter(platform);
    if (platform !== 'antigravity') return adapter;
    return { ...adapter, async discover() {
      return { platform, diagnostics: [], availability: product === 'missing' ? 'missing' : 'available', installations: product === 'missing' ? [] : [{
        id: 'controlled:antigravity', product, version: '1.5.14', availability: 'available', reasonCodes: [],
        entry: product === 'cli' ? { kind: 'cli', executable: process.execPath, configRoot: host } : { kind: 'directory', configRoot: host },
      }] };
    } };
  });
  onTestFinished(() => discovered.mockRestore());
  const copies = new Map<string, { name: string; version: string; path: string; enabled: boolean; source: string; skills: string[] }>();
  const nativeCliRunner = async ({ args }: NativeCliInvocation) => {
    const [command, action, resource] = args;
    expect(command).toBe('plugin');
    if (action === 'list') return { exitCode: 0, stderr: '', stdout: JSON.stringify([...copies.values()]) };
    if (action === 'install') {
      const { name, version } = await fs.readJson(path.join(resource!, '.antigravity-plugin/plugin.json'));
      const destination = path.join(nativeCopies, name);
      await fs.remove(destination);
      await fs.copy(resource!, destination);
      copies.set(name, { name, version, path: destination, enabled: true, source: 'antigravity',
        skills: await fs.readdir(path.join(destination, 'skills')).catch(() => []) });
    } else if (action === 'uninstall') {
      await fs.remove(copies.get(resource!)!.path);
      copies.delete(resource!);
    } else if (action === 'enable' || action === 'disable') {
      copies.get(resource!)!.enabled = action === 'enable';
    } else throw new Error('Unexpected fixture invocation.');
    return { exitCode: 0, stderr: '', stdout: '' };
  };

  await Promise.all([
    fs.ensureDir(path.join(projectA, '.git')),
    fs.ensureDir(path.join(projectB, '.git')),
    fs.outputFile(path.join(catalog, 'plugins/probe/tools/report.mjs'), 'console.log("report");\n'),
  ]);
  await createDependencyCatalogSnapshotFixture(catalog, [{
    name: 'probe', configureManifest(manifest) {
      manifest.platforms = ['antigravity'];
      manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: 'report' } } };
      manifest.command = normalizePluginCommand({
        mode: 'static', sourceDir: './tools', runtimeConfig: { keys: ['mode'] },
        routes: { subcommands: ['show', 'confirm', 'blocked'].map((name) => ({ name, runner: 'node', entry: 'report.mjs' })) },
      }, manifest);
      manifest.extensions!.permissions = [{
        name: 'approval', allow: ['aw-fixture text', 'aw-fixture manual', { argsPrefix: ['show'] }],
        ask: [{ argsPrefix: ['confirm'] }], deny: [{ argsPrefix: ['blocked'] }, { argsPrefix: ['future'] }],
      }, ...(extraPermission ? [extraPermission] : [])];
    },
  }, {
    name: 'second', configureManifest(manifest) {
      manifest.platforms = ['antigravity'];
      manifest.extensions!.permissions = [{
        name: 'shared', allow: ['aw-fixture text', 'aw-fixture manual'], ask: ['aw-fixture second'],
      }];
    },
  }]);

  async function cli(args: string[], cwd = projectA) {
    const captured = createCapturedCliIo();
    const exitCode = await runCli([...args, '--json'], { cwd, env, io: captured.io, interactive: false, nativeCliRunner });
    return { exitCode, result: JSON.parse(captured.readStdout()) as CommandResult };
  }
  async function success(args: string[], cwd?: string) {
    const { exitCode, result } = await cli(args, cwd);
    expect({ exitCode, status: result.status }, JSON.stringify(result.diagnostics)).toEqual({ exitCode: 0, status: 'success' });
    return result;
  }
  await success(['source', 'add', 'local', '--path', catalog, '--primary', '--no-auto-check', '--yes']);
  await success(['source', 'sync', 'local', '--yes']);
  await success(['target', 'set', 'antigravity', '--context', 'user', '--force']);
  return { global, discoverySettings, sharedCandidate, ownership, nativeCopies, projectA, projectB, cli, success,
    useProduct(next: typeof product) { product = next; } };
}

it.each([false, true])('writes CLI Global command rules while preserving manual settings (strict %s)', async (strict) => {
  const { global, discoverySettings, sharedCandidate, ownership, projectB, cli, success } = await fixture();
  const rules = { ask: ['command(aw-fixture personal)'], allow: ['read_file(report)', manualAllow],
    deny: ['command(aw-fixture text protected)', 'write_file(private)'] };
  const initial = { permissions: rules, telemetry: false, ...(strict ? { toolPermission: 'strict' } : {}) };
  await fs.outputJson(global, initial);
  for (const file of [discoverySettings, sharedCandidate]) await fs.outputJson(file, { marker: true });
  const unrelated = await Promise.all([discoverySettings, sharedCandidate].map((file) => fs.readFile(file)));
  const initialBytes = await fs.readFile(global);
  const install = ['plugin', 'install', 'local/probe', ...user];
  const { result: review, exitCode } = await cli(install);
  expect(exitCode).toBe(3);
  const confirmation = (review.data as { confirmation: Confirmation }).confirmation;
  expect(confirmation.effects).toContainEqual(expect.objectContaining({ code: 'changeHostPermissions' }));
  expect(await fs.readFile(global)).toEqual(initialBytes);

  const installed = await success([...install, '--yes']);
  const strictNotice = expect.objectContaining({
    code: 'invocationPolicyNotApplied', subject: expect.objectContaining({ scope: 'user', target: 'antigravity', field: 'permissions.approval' }),
    detail: expect.objectContaining({ reasonCode: 'antigravity-strict-mode', skippedPermissionActions: ['allow'] }),
  });
  if (strict) expect(installed.diagnostics).toContainEqual(strictNotice);
  else expect(installed.diagnostics).not.toContainEqual(strictNotice);
  expect(await fs.readJson(global)).toEqual({
    ...initial,
    permissions: {
      allow: [...rules.allow, ...(strict ? [] : [managedAllow, sharedAllow])],
      ask: [...rules.ask, managedAsk],
      deny: [...rules.deny, managedDeny, inactiveDeny],
    },
  });
  expect(await fs.readdir(ownership)).toHaveLength(1);
  const status = await success(['plugin', 'status', 'local/probe', '--context', 'user']);
  expect(status.data).toMatchObject({ inventory: expect.arrayContaining([expect.objectContaining({ pluginId: 'local/probe',
    targetResults: expect.arrayContaining([expect.objectContaining({ target: 'antigravity', scope: 'user', content: 'satisfied' })]) })]) });
  const syncedBytes = await fs.readFile(global);
  await success(['plugin', 'sync', 'local/probe', '--context', 'user', '--target', 'antigravity', '--yes'], projectB);
  expect(await fs.readFile(global)).toEqual(syncedBytes);
  // agy rewrites valid settings to its own format on startup.
  await fs.writeJson(global, await fs.readJson(global), { spaces: 4 });
  expect(await fs.readFile(global)).not.toEqual(syncedBytes);
  if (!strict) {
    const normalized = await fs.readJson(global);
    await fs.writeJson(global, { ...normalized, toolPermission: 'strict' });
    const updated = await success(['plugin', 'sync', 'local/probe', '--context', 'user', '--target', 'antigravity', '--yes']);
    expect(updated.diagnostics).toContainEqual(strictNotice);
    expect((await fs.readJson(global)).permissions).toEqual({ ...normalized.permissions, allow: rules.allow });
  }
  await success(['plugin', 'remove', 'local/probe', '--scope', 'user', '--context', 'user', '--yes']);
  expect(await fs.readJson(global)).toEqual({ ...initial, toolPermission: 'strict' });
  expect(await Promise.all([discoverySettings, sharedCandidate].map((file) => fs.readFile(file)))).toEqual(unrelated);
  expect(await fs.readdir(ownership)).toEqual([]);
});

it('keeps the shared rule until its last AW owner is removed and leaves manual grants in place', async () => {
  const { global, success } = await fixture();
  await fs.outputJson(global, { permissions: { allow: ['read_file(report)', manualAllow], ask: [], deny: [] } });
  await success(['plugin', 'install', 'local/probe', 'local/second', ...user, '--yes']);
  expect((await fs.readJson(global)).permissions.allow).toEqual(['read_file(report)', manualAllow, managedAllow, sharedAllow]);
  await success(['plugin', 'remove', 'local/probe', '--scope', 'user', '--context', 'user', '--yes']);
  expect((await fs.readJson(global)).permissions).toEqual({
    allow: ['read_file(report)', manualAllow, sharedAllow], ask: ['command(aw-fixture second)'], deny: [],
  });
  await success(['plugin', 'remove', 'local/second', '--scope', 'user', '--context', 'user', '--yes']);
  expect((await fs.readJson(global)).permissions).toEqual({ allow: ['read_file(report)', manualAllow], ask: [], deny: [] });
});

it('reviews expanded command matches and retracts every owned native form on removal', async () => {
  const { global, cli, success } = await fixture({
    name: 'terminal', ask: ['env LANG=C aw-fixture report', 'aw-fixture literal?'],
  });
  await fs.outputJson(global, { permissions: { ask: ['read_file(report)'] } });
  const initial = await fs.readFile(global);
  const install = ['plugin', 'install', 'local/probe', ...user];
  const { result: review, exitCode } = await cli(install);
  expect(exitCode).toBe(3);
  const confirmation = (review.data as { confirmation: Confirmation }).confirmation;
  expect(confirmation.effects).toContainEqual(expect.objectContaining({
    code: 'hostPermissionAdditionalImpact',
    message: expect.stringContaining('invoked directly'),
  }));
  expect(await fs.readFile(global)).toEqual(initial);

  const applied = await success([...install, '--yes']);
  expect(applied.diagnostics).toContainEqual(expect.objectContaining({
    code: 'hostPermissionAdditionalImpact',
    detail: expect.objectContaining({ permissionAction: 'ask', permissionResource: 'command(aw-fixture report)' }),
  }));
  const projected = (await fs.readJson(global)).permissions.ask;
  expect(projected).toEqual(expect.arrayContaining([
    'read_file(report)', 'command(aw-fixture report)', 'command(aw-fixture literal?)',
    expect.stringMatching(/^command\(regex:/u),
  ]));
  const installed = await fs.readFile(global);
  await success(['plugin', 'sync', 'local/probe', '--context', 'user', '--target', 'antigravity', '--yes']);
  expect(await fs.readFile(global)).toEqual(installed);
  await success(['plugin', 'remove', 'local/probe', '--scope', 'user', '--context', 'user', '--yes']);
  expect((await fs.readJson(global)).permissions.ask).toEqual(['read_file(report)']);
});

it('preserves a user-adopted rule with a different JSON spelling through another install and removal', async () => {
  const { global, success } = await fixture();
  await success(['plugin', 'install', 'local/second', ...user, '--yes']);
  const literal = String.raw`command(aw-fixture \u0073econd)`;
  const installed = await fs.readFile(global, 'utf8');
  expect(installed).toContain('command(aw-fixture second)');
  await fs.writeFile(global, installed.replace('command(aw-fixture second)', literal));
  const added = await success(['plugin', 'install', 'local/probe', ...user, '--yes']);
  expect(added.diagnostics).toContainEqual(expect.objectContaining({ code: 'permissionOwnershipDegraded' }));
  expect(await fs.readFile(global, 'utf8')).toContain(literal);
  for (const plugin of ['local/probe', 'local/second']) {
    await success(['plugin', 'remove', plugin, '--scope', 'user', '--context', 'user', '--yes']);
  }
  expect(await fs.readFile(global, 'utf8')).toContain(literal);
  expect((await fs.readJson(global)).permissions.ask).toEqual(['command(aw-fixture second)']);
});

it.each(['missing', 'corrupt'] as const)('retains Antigravity settings during cleanup with %s ownership', async (damage) => {
  const { global, ownership, nativeCopies, cli, success } = await fixture();
  await fs.outputJson(global, { permissions: { allow: [manualAllow] } });
  await success(['plugin', 'install', 'local/probe', ...user, '--yes']);
  const [installedPackage] = await fs.readdir(nativeCopies);
  expect(installedPackage).toBeDefined();
  const [stateFile] = await fs.readdir(ownership);
  expect(stateFile).toBeDefined();
  if (damage === 'missing') await fs.unlink(path.join(ownership, stateFile!));
  else await fs.writeFile(path.join(ownership, stateFile!), '{');
  const original = await fs.readFile(global);
  const { result } = await cli(['plugin', 'remove', 'local/probe', ...user, '--only', 'outputs', '--yes']);
  expect(result.status).toBe('success');
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: 'permissionOwnershipDegraded', detail: expect.objectContaining({ path: global }),
  }));
  expect(await fs.readFile(global)).toEqual(original);
  expect(await fs.pathExists(path.join(nativeCopies, installedPackage!))).toBe(false);
});

it('keeps malformed settings and rejects concurrent edits until a safe retry', async () => {
  const { global, cli, success } = await fixture();
  const broken = '{"permissions":{"allow":[],"allow":[]}}';
  await fs.outputFile(global, broken);
  const install = ['plugin', 'install', 'local/probe', ...user, '--yes'];
  const diagnostic = expect.objectContaining({ code: 'permissionConfigurationConflict' });
  expect((await cli(install)).result.diagnostics).toContainEqual(diagnostic);
  expect(await fs.readFile(global, 'utf8')).toBe(broken);

  await fs.writeJson(global, { permissions: { allow: [manualAllow] } });
  const write = safeFiles.atomicReplaceSafeFile;
  const external = { permissions: { allow: [manualAllow], deny: ['command(aw-fixture user)'] } };
  const intercepted = vi.spyOn(safeFiles, 'atomicReplaceSafeFile').mockImplementation((options) =>
    options.filePath === global ? write({
      ...options,
      async beforeRename(target, temporary) {
        await fs.writeJson(global, external);
        await options.beforeRename?.(target, temporary);
      },
    }) : write(options));
  onTestFinished(() => intercepted.mockRestore());
  expect((await cli(install)).result.diagnostics).toContainEqual(diagnostic);
  expect(await fs.readJson(global)).toEqual(external);
  intercepted.mockRestore();

  await success(install);
  expect((await fs.readJson(global)).permissions).toMatchObject({
    allow: [manualAllow, managedAllow, sharedAllow],
    deny: ['command(aw-fixture user)', managedDeny, inactiveDeny],
  });
});

it('reports unavailable actions for Project and for desktop-only installs while retaining their settings', async () => {
  const { global, discoverySettings, sharedCandidate, projectA, success, useProduct } = await fixture();
  const inputs = [global, discoverySettings, sharedCandidate, path.join(projectA, '.agents', 'settings.json')];
  for (const file of inputs) await fs.outputJson(file, { marker: path.basename(path.dirname(file)) });
  const original = await Promise.all(inputs.map((file) => fs.readFile(file)));
  const notice = (scope: 'user' | 'project') => expect.objectContaining({
    code: 'invocationPolicyNotApplied', subject: expect.objectContaining({ scope, target: 'antigravity', field: 'permissions.approval' }),
    detail: expect.objectContaining({ reasonCode: 'antigravity-cli-global-only', skippedPermissionActions: ['allow', 'ask', 'deny'] }),
  });
  const installed = await success(['plugin', 'install', 'local/probe', ...project, '--yes']);
  expect(installed.diagnostics).toContainEqual(notice('project'));
  useProduct('app');
  const desktop = await success(['plugin', 'install', 'local/probe', ...user, '--yes']);
  expect(desktop.diagnostics).toContainEqual(notice('user'));
  expect(await Promise.all(inputs.map((file) => fs.readFile(file)))).toEqual(original);
});
