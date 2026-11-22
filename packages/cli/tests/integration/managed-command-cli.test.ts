import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { nativeToolFixture } from '../helpers/native-tools.js';
import { runCli } from '../../src/index.js';
import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';
import type { CommandManagementResult } from '../../src/commands/managed-commands.js';
import type { CommandResult } from '../../src/output/public-result.js';
type ManagedResult = CommandResult<Pick<CommandManagementResult, 'commands' | 'packages' | 'orphanedPackages' | 'changes' | 'nativeToolChanges' | 'packageReview' | 'confirmation'>>;
import { resolveManagedCommand, syncManagedCommandPackage } from '../../src/utils/managed-command-store.js';
import { normalizeCommandRoutes, normalizePluginCommand, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';

import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { createDefaultCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';

describe('managed command CLI', () => {
  let isolated: IsolatedTestEnvironment;
  let source: string;
  beforeEach(async () => {
    isolated = await createIsolatedTestEnv();
    source = path.join(isolated.layout.fixtureCwd, 'source');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'entry.mjs'), 'import fs from "node:fs"; fs.writeFileSync(process.env.REPORT, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), host: JSON.parse(process.env.AW_COMMAND_HOST), source: process.env.COPY, worker: process.env.AW_SUBAGENT_WORKER, author: process.env.AW_PLUGIN_CONTEXT })); process.exit(17);\n');
  });
  afterEach(async () => { await isolated.cleanup(); });

  async function invokeCli(args: string[], extraEnvironment: NodeJS.ProcessEnv = {}): Promise<{ exitCode: number; stdout: string; stderr: string; receipt: ManagedResult }> {
    let stdout = '';
    let stderr = '';
    const exitCode = await runCli(args, { cwd: isolated.layout.fixtureCwd, env: { ...isolated.env, ...extraEnvironment }, interactive: false, io: { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } } });
    return { exitCode, stdout, stderr, receipt: stdout ? JSON.parse(stdout) : undefined };
  }
  const invoke = (args: string[], extraEnvironment?: NodeJS.ProcessEnv) => invokeCli(['command', ...args], extraEnvironment);

  function installedUserId(receipt: ManagedResult): string {
    const command = receipt.data.commands[0];
    if (!command || !('id' in command)) throw new Error('Expected a user command in the receipt.');
    return command.id;
  }

  async function installPackage({ producer, routes, nativeTools }: {
    producer: ProducerIdentity;
    routes: unknown;
    nativeTools?: ReturnType<typeof nativeToolFixture>['closure'];
  }) {
    return syncManagedCommandPackage({ producer, sourceDirectory: source,
      record: { schemaVersion: 2, producer, pluginVersion: '1.0.0', sourceContentDigest: `sha256:${'a'.repeat(64)}`,
        routes: normalizeCommandRoutes(routes), runtimeConfigPlatforms: [], ...(nativeTools ? { nativeTools } : {}) },
      env: isolated.env });
  }

  async function officialProducer(pluginName: string): Promise<ProducerIdentity> {
    const officialSource = createDefaultCatalogSourcesConfig().sources.find(({ id }) => id === 'official')!;
    return { sourceId: officialSource.id, sourceIdentity: await calculateCatalogSourceIdentity(officialSource), pluginName };
  }

  async function writeRoutingFixture(directory: string, report: string) {
    for (const [entry, exitCode] of [['export', 0], ['message', 17], ['fallback', 0]] as const) {
      await fs.writeFile(path.join(directory, `${entry}.mjs`), `import fs from "node:fs"; fs.writeFileSync(process.env.REPORT, JSON.stringify([${JSON.stringify(entry)}, ...process.argv.slice(2)])); process.exitCode=${exitCode};
`);
    }
    return {
      subcommands: [
        { name: 'export', runner: 'node', entry: 'export.mjs', args: ['fixed'], env: { REPORT: report } },
        { name: 'message', runner: 'node', entry: 'message.mjs', env: { REPORT: report } },
      ] as const,
      fallback: { runner: 'node', entry: 'fallback.mjs', env: { REPORT: report } },
    };
  }

  async function expectRouteDispatch(selector: string, report: string) {
    const cases = [
      { args: ['export', 'report.csv'], expected: ['export', 'fixed', 'report.csv'], exitCode: 0 },
      { args: ['export'], expected: ['export', 'fixed'], exitCode: 0 },
      { args: ['message', 'send', 'hello'], expected: ['message', 'send', 'hello'], exitCode: 17 },
      { args: ['export-all', 'report.csv'], expected: ['fallback', 'export-all', 'report.csv'], exitCode: 0 },
      { args: ['--help'], expected: ['fallback', '--help'], exitCode: 0 },
      { args: [], expected: ['fallback'], exitCode: 0 },
      { args: ['Export'], expected: ['fallback', 'Export'], exitCode: 0 },
      { flags: ['--no-fallback'], args: ['export', '', 'a b', '换行\n参数', '--'], expected: ['export', 'fixed', '', 'a b', '换行\n参数', '--'], exitCode: 0 },
    ];
    for (const { args, flags = [], expected, exitCode } of cases) {
      await fs.rm(report, { force: true });
      expect(await invoke(['run', selector, ...flags, '--', ...args])).toMatchObject({ exitCode, stdout: '', stderr: '' });
      expect(JSON.parse(await fs.readFile(report, 'utf8'))).toEqual(expected);
    }
  }

  async function expectExportInvocation(selector: string, report: string, expected: readonly string[]) {
    await fs.rm(report, { force: true });
    expect(await invoke(['run', selector, '--', 'export', 'quarterly report.csv', '--'])).toMatchObject({
      exitCode: 0, stdout: '', stderr: '',
    });
    expect(JSON.parse(await fs.readFile(report, 'utf8'))).toEqual([...expected, 'quarterly report.csv', '--']);
  }

  // Test Value Gate: the public process bridge must preserve the exact argv and route failures.
  it('dispatches exact routes without rewriting target arguments or retrying a failed launch', async () => {
    const report = path.join(isolated.layout.fixtureCwd, 'route.json');
    const routes = await writeRoutingFixture(source, report);
    const producer = await officialProducer('routing');
    const selector = 'official/routing';
    const [exportRoute, messageRoute] = routes.subcommands;
    const installed = await installPackage({ producer, routes });
    const listed = await invoke(['list', '--json']);
    expect(listed.receipt.data.packages).toEqual([expect.objectContaining({
      selector, packageId: installed.id, availability: 'ready', subcommands: ['export', 'message'], hasFallback: true,
    })]);
    expect((await invoke(['show', selector, '--json'])).receipt.data.commands).toEqual([expect.objectContaining({
      owner: { kind: 'plugin', producer }, selector, packageId: installed.id, pluginVersion: '1.0.0',
      sourceContentDigest: `sha256:${'a'.repeat(64)}`, availability: 'ready', resourceRoot: installed.resourceRoot,
      routes: { subcommands: [expect.objectContaining(exportRoute), expect.objectContaining(messageRoute)], fallback: expect.objectContaining({ entry: 'fallback.mjs' }) },
      runtimeConfigPlatforms: [], nativeTools: null, errors: [], recoveryActions: [],
    })]);
    await expectRouteDispatch(selector, report);
    await fs.rm(report);
    const absent = await invoke(['run', selector, '--no-fallback', '--', 'export-all']);
    expect(absent).toMatchObject({ exitCode: 2, stdout: '', stderr: expect.stringMatching(/commandRouteNotFound:.*export, message/u) });
    await fs.rm(path.join(installed.resourceRoot, 'export.mjs'));
    expect(await invoke(['run', selector, '--', 'export'])).toMatchObject({ exitCode: 1, stdout: '', stderr: expect.stringContaining('commandResourceInvalid') });
    await expect(fs.lstat(report)).rejects.toMatchObject({ code: 'ENOENT' });

    await installPackage({ producer, routes: { subcommands: [messageRoute] } });
    expect(await invoke(['run', selector, '--'])).toMatchObject({ exitCode: 2, stdout: '', stderr: expect.stringMatching(/commandRouteNotFound:.*message/u) });
    await installPackage({ producer, routes: {} });
    expect((await invoke(['show', selector, '--json'])).receipt.data.commands).toEqual([expect.objectContaining({ availability: 'empty' })]);
    expect(await invoke(['run', selector, '--', 'export'])).toMatchObject({ exitCode: 2, stdout: '', stderr: expect.stringMatching(/commandRouteNotFound:.*no enabled subcommands/u) });

    await fs.writeFile(path.join(isolated.layout.awHomeDir, 'catalog-sources.json'), '{broken');
    expect(await invoke(['run', selector, '--', 'export'])).toMatchObject({ exitCode: 1, stdout: '', stderr: expect.stringContaining('catalogSourcesConfigInvalid') });
    expect((await invoke(['show', selector, '--json'])).receipt.diagnostics).toEqual([expect.objectContaining({ code: 'catalogSourcesConfigInvalid' })]);
  });

  it.each([
    ['routing', '--'], ['official/routing'], ['official/routing', '--no-fallback', '--'],
    ['official/routing', '--unknown', '--'], ['official/routing', '-xh', '--'], ['official/route/extra', '--'],
    ['OFFICIAL/routing', '--'], ['official/Routing', '--'], ['official/routing', '--no-fallback=true', '--', 'export'],
    ['cmdu_12345678-1234-4234-8234-123456789abc', '--no-fallback', '--', 'export'],
  ].map((args) => ({ args })))('rejects invalid run arguments $args before looking up a package', async ({ args }) => {
    expect(await invoke(['run', ...args])).toMatchObject({ exitCode: 2, stdout: '', stderr: expect.stringContaining('aw: invalidArguments:') });
  });

  // Test Value Gate: a route update can change what an existing host approval runs.
  it('reviews route changes from Active, preserves host permissions, and keeps packages with withdrawn declarations', async () => {
    const selector = 'team/routes';
    const root = path.join(isolated.layout.fixtureCwd, 'catalog');
    const toolRoot = path.join(root, 'plugins', 'routes', 'commands');
    await fs.mkdir(toolRoot, { recursive: true });
    const report = path.join(isolated.layout.fixtureCwd, 'package-route.json');
    const routes = await writeRoutingFixture(toolRoot, report);
    async function snapshot(version: string, mode: 'named' | 'fallback' | 'none') {
      await createCatalogSnapshotFixture(root, 'routes', [], 'Route Review fixture\n', (manifest) => {
        manifest.version = version;
        manifest.platforms = ['codex', 'claude'];
        if (mode !== 'none') manifest.command = normalizePluginCommand({
          sourceDir: './commands',
          mode: 'static',
          routes: {
            subcommands: mode === 'named' ? [routes.subcommands[0]] : [],
            fallback: routes.fallback,
          },
        }, manifest);
      });
    }
    await snapshot('1.0.0', 'named');
    expect(await invokeCli(['source', 'add', 'team', '--path', root, '--no-auto-check', '--json'])).toMatchObject({ exitCode: 0 });
    expect(await invokeCli(['source', 'sync', 'team', '--json'])).toMatchObject({ exitCode: 0 });
    const sync = ['package', 'sync', selector];
    const created = await invoke([...sync, '--yes', '--json']);
    expect(created).toMatchObject({ exitCode: 0, receipt: { data: {
      changes: [{ kind: 'package', id: expect.stringMatching(/^pkg_\w{64}$/u), action: 'created' }],
      packages: [{ selector, subcommands: ['export'], hasFallback: true }],
    } } });
    const packageId = created.receipt.data.packages[0]!.packageId;
    await expectExportInvocation(selector, report, ['export', 'fixed']);

    const codex = path.join(isolated.layout.codexHomeDir, 'rules', 'demo.rules');
    const claude = path.join(isolated.layout.claudeHomeDir, 'settings.json');
    const prefix = ['aw', 'command', 'run', selector, '--', 'export'];
    const broadPrefix = ['aw', 'command', 'run'];
    const rules = [prefix, broadPrefix].map((tokens) => `prefix_rule(pattern = ${JSON.stringify(tokens)}, decision = "allow")\n`).join('');
    const settings = JSON.stringify({ permissions: { deny: [`Bash(${prefix.join(' ')} *)`], ask: [`Bash(${broadPrefix.join(' ')} *)`] } });
    await fs.mkdir(path.dirname(codex), { recursive: true });
    await fs.mkdir(path.dirname(claude), { recursive: true });
    await fs.writeFile(codex, rules);
    await fs.writeFile(claude, settings);
    const named = { route: 'subcommand', entry: 'export.mjs', args: ['fixed'] };
    const fallback = { route: 'fallback', entry: 'fallback.mjs', args: [] };
    for (const { version, mode, before, after, argvBefore, argvAfter, subcommands } of [
      { version: '2.0.0', mode: 'fallback', before: named, after: fallback,
        argvBefore: ['export', 'fixed'], argvAfter: ['fallback', 'export'], subcommands: [] },
      { version: '3.0.0', mode: 'named', before: fallback, after: named,
        argvBefore: ['fallback', 'export'], argvAfter: ['export', 'fixed'], subcommands: ['export'] },
    ] as const) {
      await snapshot(version, mode);
      expect(await invokeCli(['source', 'sync', 'team', '--yes', '--json'])).toMatchObject({ exitCode: 0 });
      const reviewed = await invoke([...sync, '--json']);
      expect(reviewed).toMatchObject({ exitCode: 3, receipt: { data: {
        confirmation: { required: true, provided: false },
        packageReview: {
          routeChanges: [{ argv: prefix, before, after }],
          affectedPermissions: expect.arrayContaining([
            { platform: 'codex', path: codex, action: 'allow', argvPrefix: prefix },
            { platform: 'claude', path: claude, action: 'deny', argvPrefix: prefix },
            { platform: 'codex', path: codex, action: 'allow', argvPrefix: broadPrefix },
            { platform: 'claude', path: claude, action: 'ask', argvPrefix: broadPrefix },
          ]),
          otherProjects: 'unobserved',
        },
      } } });
      await expectExportInvocation(selector, report, argvBefore);
      expect(await invoke([...sync, '--yes', '--json'])).toMatchObject({ exitCode: 0, receipt: { data: {
        changes: [{ kind: 'package', id: packageId, action: 'updated' }],
        packages: [{ selector, subcommands, hasFallback: true }],
      } } });
      await expectExportInvocation(selector, report, argvAfter);
      expect(await fs.readFile(codex, 'utf8')).toBe(rules);
      expect(await fs.readFile(claude, 'utf8')).toBe(settings);
    }

    await snapshot('4.0.0', 'none');
    expect(await invokeCli(['source', 'sync', 'team', '--yes', '--json'])).toMatchObject({ exitCode: 0 });
    expect((await invoke([...sync, '--yes', '--json'])).receipt.diagnostics).toEqual([expect.objectContaining({ code: 'commandPackageDeclarationMissing' })]);
    expect((await invoke(['show', selector, '--json'])).receipt.data.commands[0]).toMatchObject({ pluginVersion: '3.0.0' });
    expect(await invoke(['package', 'remove', selector, '--yes', '--json'])).toMatchObject({ exitCode: 0, receipt: { data: {
      changes: [{ kind: 'package', id: packageId, action: 'removed' }],
    } } });
    expect(await invoke(['run', selector, '--', 'export'])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('commandNotFound') });
  });

  // Test Value Gate: a saved config and an unconfirmed apply must leave the executed route intact.
  it('switches the executed dynamic route only after confirming config apply, without a platform deployment', async () => {
    const root = path.join(isolated.layout.fixtureCwd, 'dynamic-catalog');
    const pluginRoot = path.join(root, 'plugins', 'dynamic');
    const commands = path.join(pluginRoot, 'commands');
    await fs.mkdir(commands, { recursive: true });
    const report = path.join(isolated.layout.fixtureCwd, 'dynamic-route.json');
    const routes = await writeRoutingFixture(commands, report);
    await fs.writeFile(path.join(pluginRoot, 'render.mjs'), `
import fs from 'node:fs';
if (process.env.AW_PLUGIN_SURFACE !== 'managed-commands') throw new Error('Unexpected renderer surface');
const { config } = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
const routes = ${JSON.stringify(routes)};
if (!config.values.dedicated) routes.subcommands = routes.subcommands.filter(({ name }) => name !== 'export');
console.log(JSON.stringify({ version: 2, artifacts: [{
  id: 'command-routes', target: 'aw.command-routes', kind: 'commandRoutes', refreshKeys: ['dedicated'], routes,
}] }));`);
    await createCatalogSnapshotFixture(root, 'dynamic', [], 'Dynamic route fixture\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.config = { schemaVersion: 5, fields: { dedicated: { type: 'boolean', default: true } } };
      manifest.command = normalizePluginCommand({ sourceDir: './commands', mode: 'dynamic', refreshKeys: ['dedicated'] }, manifest);
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    });
    expect(await invokeCli(['source', 'add', 'team', '--path', root, '--no-auto-check', '--json'])).toMatchObject({ exitCode: 0 });
    expect(await invokeCli(['source', 'sync', 'team', '--json'])).toMatchObject({ exitCode: 0 });
    const selector = 'team/dynamic';
    const updated = await invoke(['package', 'sync', selector, '--yes', '--json']);
    expect(updated, JSON.stringify(updated.receipt.diagnostics)).toMatchObject({ exitCode: 0, receipt: { data: {
      packages: [{ selector, availability: 'ready', subcommands: ['export', 'message'], hasFallback: true }],
    } } });
    await expectRouteDispatch(selector, report);

    const named = { entry: '["export.mjs","fixed"]', argv: ['export', 'fixed'] };
    const fallback = { entry: '["fallback.mjs"]', argv: ['fallback', 'export'] };
    for (const { dedicated, before, after, subcommands } of [
      { dedicated: false, before: named, after: fallback, subcommands: ['message'] },
      { dedicated: true, before: fallback, after: named, subcommands: ['export', 'message'] },
    ]) {
      expect(await invokeCli(['plugin', 'config', 'set', selector, 'dedicated', '--context', 'user',
        '--value-json', String(dedicated), '--json'])).toMatchObject({ exitCode: 0 });
      await expectExportInvocation(selector, report, before.argv);
      const apply = ['plugin', 'config', 'apply', selector, '--context', 'user', '--json'];
      const preview = await invokeCli(apply);
      expect(preview).toMatchObject({ exitCode: 3, receipt: { data: { confirmation: { required: true, provided: false,
        effects: expect.arrayContaining([expect.objectContaining({ code: 'reviewCommandPackage',
          message: expect.stringContaining(`aw command run ${selector} -- export`) })]),
      } } } });
      const transition = preview.receipt.data.confirmation?.effects.find((effect) =>
        effect.message.startsWith(`aw command run ${selector} -- export`));
      const [from, to] = transition?.message.split('→') ?? [];
      expect(from).toContain(before.entry);
      expect(to).toContain(after.entry);
      await expectExportInvocation(selector, report, before.argv);
      expect(await invokeCli([...apply, '--yes'])).toMatchObject({ exitCode: 0, receipt: { data: { apply: {
        commandResults: [{ selector, action: 'updated', subcommands, hasFallback: true }],
      } } } });
      await expectExportInvocation(selector, report, after.argv);
    }
  });

  // Protects one-object JSON receipts, pre-write argument rejection, and the full public management path.
  it('validates before writes and requires confirmation for removal', async () => {
    const invalid = await invoke(['install', source, '--name', 'tool', '--runner', 'shell', '--entry', 'entry.mjs', '--yes', '--json']);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.receipt).toMatchObject({ schemaVersion: 2, command: 'command.install', status: 'failed', data: {}, diagnostics: [{ code: 'invalidArguments' }] });
    await expect(fs.lstat(path.join(isolated.layout.awHomeDir, 'commands'))).rejects.toMatchObject({ code: 'ENOENT' });
    const installed = await invoke(['install', source, '--name', '工具', '--runner', 'node', '--entry', 'entry.mjs', '--json']);
    expect(installed.exitCode).toBe(0);
    expect(installed.stderr).toBe('');
    expect(installed.stdout.endsWith('\n')).toBe(true);
    const id = installedUserId(installed.receipt);
    expect(installed.receipt.data.changes).toEqual([{ kind: 'command', id, action: 'created' }]);
    expect((await invoke(['list', '--json'])).receipt.data.commands).toEqual([expect.objectContaining({ id })]);
    expect((await invoke(['show', id, '--json'])).receipt.data.commands[0]).toMatchObject({ id, name: '工具', availability: 'ready', owner: { kind: 'user' } });
    const refused = await invoke(['remove', id, '--json']);
    expect(refused.exitCode).toBe(3);
    expect(refused.receipt).toMatchObject({ status: 'blocked', data: { changes: [], confirmation: { required: true, provided: false } }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })]) });
    expect((await invoke(['show', id, '--json'])).receipt.data.commands[0]).toMatchObject({ id, availability: 'ready' });
    const removed = await invoke(['remove', id, '--yes', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.receipt.data.commands).toEqual([]);
    expect(removed.receipt.data.changes).toEqual([{ kind: 'command', id, action: 'removed' }]);
    expect((await invoke(['list', '--json'])).receipt).toMatchObject({
      schemaVersion: 2,
      status: 'success',
      data: {
        commands: [],
        packages: []
      }
    });
    const missing = await invoke(['show', id, '--json']);
    expect(missing.exitCode).toBe(3);
    expect(missing.receipt.diagnostics[0]!.code).toBe('commandNotFound');
  });

  // Protects child argv/exit/environment through the real CLI bridge, without invoking any model or native host.
  it('requires the literal separator and forwards every following argument to a real short Node child', async () => {
    const report = path.join(isolated.layout.fixtureCwd, 'report.json');
    const installed = await invoke(['install', source, '--name', 'tool', '--runner', 'node', '--entry', 'entry.mjs', '--args-json', '[""]', '--env-json', JSON.stringify({ REPORT: report }), '--env-from-json', '{"COPY":"INPUT"}', '--cwd', 'resource', '--yes', '--json']);
    const id = installedUserId(installed.receipt);
    const invalid = await invoke(['run', id]);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stdout).toBe('');
    expect(invalid.stderr).toContain('aw: invalidArguments:');
    await expect(fs.lstat(report)).rejects.toMatchObject({ code: 'ENOENT' });
    const ran = await invoke(['run', id, '--', '--json', '-h', '', '换行\n参数'], { INPUT: '', AW_SUBAGENT_WORKER: 'preserved', AW_PLUGIN_CONTEXT: 'removed' });
    expect(ran.exitCode).toBe(17);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toBe('');
    const observed = JSON.parse(await fs.readFile(report, 'utf8'));
    expect(observed).toMatchObject({ args: ['', '--json', '-h', '', '换行\n参数'], cwd: (await resolveManagedCommand(id, isolated.env)).resourceRoot, source: '', worker: 'preserved', host: { schemaVersion: 1, nodeExecutable: process.execPath, awHome: await fs.realpath(isolated.layout.awHomeDir) } });
    expect(observed.author).toBeUndefined();
  });

  // Protects producer lifecycle ownership and visible unavailability instead of silently accepting damaged definitions.
  it('reports damaged user definitions as partial and keeps plugin IDs outside manual mutation', async () => {
    const installed = await invoke(['install', source, '--name', 'tool', '--runner', 'node', '--entry', 'entry.mjs', '--yes', '--json']);
    const id = installedUserId(installed.receipt);
    await fs.writeFile(path.join(isolated.layout.awHomeDir, 'commands', 'users', id, 'definition.json'), '{broken');
    const listed = await invoke(['list', '--json']);
    expect(listed.exitCode).toBe(4);
    expect(listed.receipt).toMatchObject({
      schemaVersion: 2,
      status: 'partial',
      data: { commands: [{ id, availability: 'unavailable' }] }
    });
    const pluginId = 'official/routing';
    const refused = await invoke(['remove', pluginId, '--yes', '--json']);
    expect(refused.exitCode).toBe(3);
    expect(refused.receipt.diagnostics[0]!.code).toBe('commandOwnerMismatch');
    expect((await invoke(['remove', id, '--force', '--yes', '--json'])).exitCode).toBe(0);
  });

  // Protects the public offline recovery selector after a project or source is no longer available.
  it('removes an exact package ID without Catalog access and rejects conflicting owner evidence', async () => {
    const producer: ProducerIdentity = { sourceId: 'retired', sourceIdentity: `sha256:${'b'.repeat(64)}`, pluginName: 'toolkit' };
    const installed = await installPackage({ producer, routes: { fallback: { runner: 'node', entry: 'entry.mjs' } } });
    const packageRoot = path.dirname(path.dirname(installed.resourceRoot));
    const listed = await invoke(['list', '--json']);
    expect(listed.receipt.data.packages).toEqual([]);
    expect(listed.receipt.data.orphanedPackages).toEqual([expect.objectContaining({ packageId: installed.id, selector: 'retired/toolkit',
      recoveryActions: [`aw command package remove ${installed.id} --yes`] })]);
    const ownerPath = path.join(packageRoot, 'owner.json');
    const owner = await fs.readFile(ownerPath, 'utf8');
    await fs.writeFile(path.join(installed.resourceRoot, '.aw-command-producer.json'), '{broken');
    const invalid = await invoke(['package', 'remove', installed.id, '--scope', 'project', '--yes', '--json']);
    expect(invalid.exitCode).toBe(2);
    await fs.writeFile(ownerPath, owner.replace('agent-workflows', 'foreign'));
    const blocked = await invoke(['package', 'remove', installed.id, '--force', '--yes', '--json']);
    expect(blocked.exitCode).toBe(3);
    expect(blocked.receipt.diagnostics[0]!.code).toBe('commandOwnerMismatch');
    await fs.writeFile(ownerPath, owner);
    const removed = await invoke(['package', 'remove', installed.id, '--force', '--yes', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.receipt.data.changes).toEqual([{ kind: 'package', id: installed.id, action: 'removed' }]);
    await expect(fs.lstat(packageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Protects the distributed CLI boundary: stdin/stdout/stderr bytes belong to the target.
  it('passes binary stdio through the built CLI without a receipt or progress envelope', async () => {
    await fs.writeFile(path.join(source, 'stdio.mjs'), 'const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk); process.stdout.write(Buffer.concat(chunks)); process.stderr.write(Buffer.from([101,114,114,0,255])); process.exitCode=19;\n');
    const installed = await invoke(['install', source, '--name', 'stdio', '--runner', 'node', '--entry', 'stdio.mjs', '--yes', '--json']);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../dist/index.js', import.meta.url)), 'command', 'run', installedUserId(installed.receipt), '--'], { cwd: isolated.layout.fixtureCwd, env: isolated.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const completion = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const bytes = Buffer.from([0, 255, 10, 65, 0, 13]);
    child.stdin.end(bytes);
    expect(await completion).toBe(19);
    expect(Buffer.concat(stdout)).toEqual(bytes);
    expect(Buffer.concat(stderr)).toEqual(Buffer.from([101, 114, 114, 0, 255]));
  });

  // Protects POSIX direct-child signal forwarding and matching wrapper termination.
  it.skipIf(process.platform === 'win32')('forwards SIGTERM and exits with the same child signal', async () => {
    const marker = path.join(isolated.layout.fixtureCwd, 'forwarded');
    await fs.writeFile(path.join(source, 'signal.mjs'), 'import fs from "node:fs"; process.once("SIGTERM",()=>{fs.writeFileSync(process.env.SIGNAL_MARKER,"forwarded"); process.kill(process.pid,"SIGTERM");}); const expiry=setTimeout(()=>process.exit(98),5000); process.stdout.write("ready\\n");\n');
    const installed = await invoke(['install', source, '--name', 'signal', '--runner', 'node', '--entry', 'signal.mjs', '--env-json', JSON.stringify({ SIGNAL_MARKER: marker }), '--yes', '--json']);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../dist/index.js', import.meta.url)), 'command', 'run', installedUserId(installed.receipt), '--'], { cwd: isolated.layout.fixtureCwd, env: isolated.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    const ready = new Promise<void>((resolve) => { child.stdout.on('data', (chunk) => { output += String(chunk); if (output.includes('ready\n')) resolve(); }); });
    child.stderr.on('data', (chunk) => { errors += String(chunk); });
    try {
      const first = await Promise.race([ready.then(() => 'ready' as const), closed]);
      expect(first, errors).toBe('ready');
      child.kill('SIGTERM');
      expect(await closed).toEqual({ code: null, signal: 'SIGTERM' });
      expect(await fs.readFile(marker, 'utf8')).toBe('forwarded');
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
  // Test Value Gate: offline exact removal must disclose the former native authority in its public receipt.
  it('includes the complete former native declaration when removing an exact package', async () => {
    const fixture = nativeToolFixture();
    for (const [relative, content] of Object.entries(fixture.files)) await fs.mkdir(path.dirname(path.join(source, relative)), { recursive: true }).then(() => fs.writeFile(path.join(source, relative), content));
    const producer: ProducerIdentity = { sourceId: 'retired', sourceIdentity: `sha256:${'b'.repeat(64)}`, pluginName: 'toolkit' };
    const installed = await installPackage({ producer, routes: { fallback: { runner: 'node', entry: 'entry.mjs' } }, nativeTools: fixture.closure });
    const removed = await invoke(['package', 'remove', installed.id, '--yes', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.receipt.data.nativeToolChanges).toEqual([{ producer, before: fixture.closure, after: null }]);
    await expect(fs.lstat(installed.resourceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

});
