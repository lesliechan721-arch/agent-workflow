import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCommandPackageId, normalizeCommandLaunch, normalizeCommandRoutes, type InstalledCommandProducer, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';

import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';
import {
  captureManagedCommandPackageEvidence,
  copyManagedCommandDirectory,
  installUserCommand,
  listManagedCommands,
  inspectManagedCommand,
  readManagedCommandPackageView,
  readUserCommandDefinition,
  removeManagedCommandPackage,
  removeUserCommand,
  resolveManagedCommand,
  syncManagedCommandPackage,
  updateUserCommand,
} from '../../src/utils/managed-command-store.js';
import { buildManagedCommandEnvironment, prepareManagedCommandRun } from '../../src/utils/managed-command-runtime.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { createDefaultCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { calculateManagedCommandResourceDigest } from '../../src/utils/managed-command-closure.js';
import type { CatalogSource } from '../../src/types.js';

describe('managed command store and run preparation', () => {
  let isolated: IsolatedTestEnvironment;
  let source: string;
  const launch = normalizeCommandLaunch({ runner: 'node', entry: 'entry.mjs', args: ['', '固定\n参数'], env: { LITERAL: 'configured' }, envFrom: { FROM_HOST: 'SOURCE_VALUE' } });
  beforeEach(async () => {
    isolated = await createIsolatedTestEnv();
    source = path.join(isolated.layout.fixtureCwd, 'tool');
    await fs.mkdir(path.join(source, 'lib'), { recursive: true });
    await fs.writeFile(path.join(source, 'entry.mjs'), 'import "./lib/dependency.mjs";\n');
    await fs.writeFile(path.join(source, 'lib', 'dependency.mjs'), 'export const value = 1;\n');
  });
  afterEach(async () => { await isolated.cleanup(); });

  async function producerFor(source: CatalogSource = createDefaultCatalogSourcesConfig().sources[0]!, pluginName = 'example'): Promise<ProducerIdentity> {
    return { sourceId: source.id, sourceIdentity: await calculateCatalogSourceIdentity(source), pluginName };
  }
  function makeRecord(producer: ProducerIdentity, routes: unknown): InstalledCommandProducer {
    return {
      schemaVersion: 2,
      producer,
      pluginVersion: '1.0.0',
      sourceContentDigest: `sha256:${'a'.repeat(64)}`,
      routes: normalizeCommandRoutes(routes),
      runtimeConfigPlatforms: [],
    };
  }
  function publish(record: InstalledCommandProducer, expectedPackage?: Awaited<ReturnType<typeof captureManagedCommandPackageEvidence>> | null) {
    return syncManagedCommandPackage({ producer: record.producer, record, sourceDirectory: source, env: isolated.env, expectedPackage });
  }
  function installedPackageRoot(id: string): string {
    return path.join(isolated.layout.awHomeDir, 'commands', 'packages', id);
  }
  async function saveCatalogSources(sources: CatalogSource[]) {
    await fs.writeFile(path.join(isolated.layout.awHomeDir, 'catalog-sources.json'), JSON.stringify({ schemaVersion: 2, sources }));
  }

  // Protects complete directory ownership and the strong definition switch on a rejected update.
  it('copies the complete tool, keeps its identity, and retains the old revision after an invalid update', async () => {
    const id = await installUserCommand({ sourceDirectory: source, name: '工具', launch, env: isolated.env });
    const before = await readUserCommandDefinition(id, isolated.env);
    const first = await resolveManagedCommand(id, isolated.env);
    await fs.rm(source, { recursive: true });
    expect(await fs.readFile(path.join(first.resourceRoot, 'lib', 'dependency.mjs'), 'utf8')).toContain('value = 1');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'other.mjs'), '');
    await expect(updateUserCommand({ id, sourceDirectory: source, env: isolated.env })).rejects.toMatchObject({ code: 'commandResourceInvalid' });
    expect(await readUserCommandDefinition(id, isolated.env)).toEqual(before);
    await fs.writeFile(path.join(source, 'entry.mjs'), 'process.exit(7);\n');
    await updateUserCommand({ id, sourceDirectory: source, launch: { args: [], env: {}, envFrom: {} }, env: isolated.env });
    const updated = await readUserCommandDefinition(id, isolated.env);
    expect(updated.id).toBe(id);
    expect(updated.packageRevision).not.toBe(before.packageRevision);
    expect(updated.launch.args).toEqual([]);
    expect(updated.launch.env).toEqual({});
    await expect(fs.lstat(first.resourceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Protects recovery from damaged strong content while retaining an independent ownership boundary.
  it('removes damaged definitions only when the independent owner marker is valid', async () => {
    const id = await installUserCommand({ sourceDirectory: source, name: 'owned', launch, env: isolated.env });
    const userRoot = path.join(isolated.layout.awHomeDir, 'commands', 'users', id);
    await fs.writeFile(path.join(userRoot, 'definition.json'), '{broken');
    const listed = await listManagedCommands(isolated.env);
    expect(listed.commands).toHaveLength(1);
    expect(listed.commands[0]).toMatchObject({ id, availability: 'unavailable', launch: null });
    await expect(updateUserCommand({ id, sourceDirectory: source, env: isolated.env })).rejects.toMatchObject({ code: 'commandDefinitionInvalid' });
    await fs.writeFile(path.join(userRoot, 'owner.json'), JSON.stringify({ schemaVersion: 1, owner: 'foreign', kind: 'user-command', id }));
    await expect(removeUserCommand(id, isolated.env)).rejects.toMatchObject({ code: 'commandOwnerMismatch' });
    expect(await fs.readFile(path.join(userRoot, 'definition.json'), 'utf8')).toBe('{broken');
    await fs.writeFile(path.join(userRoot, 'owner.json'), JSON.stringify({ schemaVersion: 1, owner: 'agent-workflows', kind: 'user-command', id }));
    await removeUserCommand(id, isolated.env);
    await expect(fs.lstat(userRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Protects the source copy boundary against live links, repository trees, and AW_HOME recursion.
  it('rejects symbolic links, .git, and protected copy ranges without changing source files', async () => {
    const target = path.join(isolated.layout.fixtureCwd, 'copy');
    await fs.symlink(path.join(source, 'entry.mjs'), path.join(source, 'link.mjs'));
    await expect(copyManagedCommandDirectory(source, target, isolated.env)).rejects.toMatchObject({ code: 'commandResourceInvalid' });
    await fs.unlink(path.join(source, 'link.mjs'));
    await fs.mkdir(path.join(source, '.git'));
    await expect(copyManagedCommandDirectory(source, target, isolated.env)).rejects.toMatchObject({ code: 'commandResourceInvalid' });
    await expect(copyManagedCommandDirectory(isolated.layout.rootDir, target, isolated.env)).rejects.toMatchObject({ code: 'commandResourceInvalid' });
    expect(await fs.readFile(path.join(source, 'entry.mjs'), 'utf8')).toContain('dependency.mjs');
  });

  // Protects the last healthy revision from invalid replacements and unreviewed changes.
  it('publishes complete revisions and preserves the last revision if staging or the review check fails', async () => {
    const producer = await producerFor();
    const selector = 'official/example';
    const beforeRecord = makeRecord(producer, { fallback: { runner: 'node', entry: 'entry.mjs', args: ['before'] } });
    const first = await publish(beforeRecord, null);
    expect(first.id).toBe(getCommandPackageId(producer));
    const review = await captureManagedCommandPackageEvidence(await readManagedCommandPackageView(first.id, isolated.env), isolated.env);
    const pointer = path.join(installedPackageRoot(first.id), 'current.json');
    const beforePointer = await fs.readFile(pointer, 'utf8');

    await expect(publish(makeRecord(producer, { fallback: { runner: 'node', entry: 'missing.mjs' } }), review))
      .rejects.toMatchObject({ code: 'commandResourceInvalid' });
    const expectedResourceDigest = await calculateManagedCommandResourceDigest(source);
    await fs.writeFile(path.join(source, 'entry.mjs'), '// Unreviewed source bytes.\n');
    await expect(syncManagedCommandPackage({ producer, record: beforeRecord, sourceDirectory: source, env: isolated.env,
      expectedPackage: review, expectedResourceDigest })).rejects.toMatchObject({ code: 'operationReviewStale' });
    expect(await fs.readFile(pointer, 'utf8')).toBe(beforePointer);
    expect(await resolveManagedCommand(selector, isolated.env)).toMatchObject({ resourceRoot: first.resourceRoot, launch: { args: ['before'] } });

    const next = await publish(makeRecord(producer, {}), review);
    expect(next.resourceRoot).not.toBe(first.resourceRoot);
    expect(await inspectManagedCommand(selector, isolated.env)).toMatchObject({ availability: 'empty', resourceRoot: next.resourceRoot });
    await expect(resolveManagedCommand(selector, isolated.env)).rejects.toMatchObject({ code: 'commandRouteNotFound' });
    await expect(fs.lstat(first.resourceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(publish(beforeRecord, review)).rejects.toMatchObject({ code: 'operationReviewStale' });
    await expect(removeManagedCommandPackage(first.id, isolated.env, { expectedPackage: review })).rejects.toMatchObject({ code: 'operationReviewStale' });
    expect(await inspectManagedCommand(selector, isolated.env)).toMatchObject({ availability: 'empty', resourceRoot: next.resourceRoot });
  });

  // Exercises no-lock readers across pointer switches with a real filesystem.
  it('never pairs the route from one publication with the entry file of another', async () => {
    const producer = await producerFor();
    async function putVersion(version: number): Promise<void> {
      await fs.writeFile(path.join(source, 'entry.mjs'), `// Version ${version}
`);
      await publish(makeRecord(producer, {
        subcommands: [{ name: 'read', runner: 'node', entry: 'entry.mjs', args: [String(version)] }],
      }));
    }
    async function observe(): Promise<boolean> {
      let invocation;
      try {
        invocation = await resolveManagedCommand('official/example', isolated.env, { args: ['read'] });
      } catch (error) {
        expect(error).toMatchObject({ code: expect.stringMatching(/^(commandUnavailable|commandResourceInvalid)$/u) });
        return false;
      }
      const script = await fs.readFile(path.join(invocation.resourceRoot, invocation.launch.entry), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (script === null) return false;
      expect(script).toBe(`// Version ${invocation.launch.args[0]}
`);
      return true;
    }

    await putVersion(0);
    expect(await observe()).toBe(true);
    await Promise.all([
      (async () => {
        for (let version = 1; version <= 4; version++) await putVersion(version);
      })(),
      (async () => {
        for (let attempt = 0; attempt < 24; attempt++) await observe();
      })(),
    ]);
    expect(await observe()).toBe(true);
  });

  // A source rebound to a different location must not inherit the old executable.
  it('separates same-name plugins from different sources and keeps rebound packages removable by ID', async () => {
    const oldSource: CatalogSource = { id: 'workspace', type: 'path', path: source, primary: true };
    const otherSource: CatalogSource = { id: 'other', type: 'path', path: path.join(source, 'lib'), primary: false };
    await fs.mkdir(isolated.layout.awHomeDir, { recursive: true });
    await saveCatalogSources([oldSource, otherSource]);
    const old = await publish(makeRecord(await producerFor(oldSource), { fallback: { runner: 'node', entry: 'entry.mjs', args: ['old'] } }));
    const other = await publish(makeRecord(await producerFor(otherSource), { fallback: { runner: 'node', entry: 'entry.mjs', args: ['other'] } }));

    expect(await resolveManagedCommand('workspace/example', isolated.env)).toMatchObject({ launch: { args: ['old'] } });
    expect(await resolveManagedCommand('other/example', isolated.env)).toMatchObject({ launch: { args: ['other'] } });

    await saveCatalogSources([{ ...oldSource, path: path.join(source, 'lib') }, otherSource]);
    await expect(resolveManagedCommand('workspace/example', isolated.env)).rejects.toMatchObject({ code: 'commandNotFound' });
    await expect(inspectManagedCommand('workspace/example', isolated.env)).rejects.toMatchObject({ code: 'commandNotFound' });
    expect(await listManagedCommands(isolated.env)).toMatchObject({
      packages: [{ packageId: other.id, availability: 'ready' }],
      orphanedPackages: [{ packageId: old.id, availability: 'unavailable', recoveryActions: [`aw command package remove ${old.id} --yes`] }],
    });
    await removeManagedCommandPackage(old.id, isolated.env);
    expect((await listManagedCommands(isolated.env)).orphanedPackages).toHaveLength(0);
  });

  // Invalid strong source config cannot enable either a fallback source or any old name mapping.
  it('fails closed on invalid source config and can recover an independently owned damaged package', async () => {
    const producer = await producerFor();
    const installed = await publish(makeRecord(producer, { fallback: { runner: 'node', entry: 'entry.mjs' } }));
    const packageRoot = installedPackageRoot(installed.id);
    const current = path.join(packageRoot, 'current.json');
    await fs.writeFile(path.join(isolated.layout.awHomeDir, 'catalog-sources.json'), '{broken');
    await expect(resolveManagedCommand('official/example', isolated.env)).rejects.toMatchObject({ code: 'catalogSourcesConfigInvalid' });
    await expect(inspectManagedCommand('official/example', isolated.env)).rejects.toMatchObject({ code: 'catalogSourcesConfigInvalid' });
    await fs.writeFile(current, JSON.stringify({ schemaVersion: 2, revision: '../../foreign' }));
    const list = await listManagedCommands(isolated.env);
    expect(list).toMatchObject({ packages: [], orphanedPackages: [{ packageId: installed.id }], errors: [{ code: 'catalogSourcesConfigInvalid' }] });
    const reviewed = await captureManagedCommandPackageEvidence(list.orphanedPackages[0]!, isolated.env);
    await expect(removeManagedCommandPackage(installed.id, isolated.env, { expectedPackage: reviewed })).rejects.toMatchObject({ code: 'commandPackageUnavailable' });

    const ownerFile = path.join(packageRoot, 'owner.json');
    const owner = await fs.readFile(ownerFile, 'utf8');
    await fs.writeFile(ownerFile, JSON.stringify({ ...JSON.parse(owner), producer: { ...producer, pluginName: 'foreign' } }));
    await expect(removeManagedCommandPackage(installed.id, isolated.env, { force: true })).rejects.toMatchObject({ code: 'commandOwnerMismatch' });
    expect(await fs.readFile(current, 'utf8')).toContain('../../foreign');
    await fs.writeFile(ownerFile, owner);
    const forcedReview = await captureManagedCommandPackageEvidence(list.orphanedPackages[0]!, isolated.env, { force: true });
    await removeManagedCommandPackage(installed.id, isolated.env, { force: true, expectedPackage: forcedReview });
    await expect(fs.lstat(packageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(source, 'entry.mjs'), 'utf8')).toContain('dependency.mjs');
  });

  // Force recovery still binds approval to the owner and pointer even if revision bytes are inaccessible.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('force removes unreadable revision files only with the reviewed pointer', async () => {
    const producer = await producerFor();
    const installed = await publish(makeRecord(producer, { fallback: { runner: 'node', entry: 'entry.mjs' } }));
    const entry = path.join(installed.resourceRoot, 'entry.mjs');
    await fs.chmod(entry, 0o000);
    const view = await readManagedCommandPackageView(installed.id, isolated.env);
    expect(view.availability).toBe('unavailable');
    await expect(captureManagedCommandPackageEvidence(view, isolated.env)).rejects.toMatchObject({ code: 'EACCES' });
    const approved = await captureManagedCommandPackageEvidence(view, isolated.env, { force: true });
    const pointer = path.join(installedPackageRoot(installed.id), 'current.json');
    await fs.writeFile(pointer, '{damaged');
    await expect(removeManagedCommandPackage(installed.id, isolated.env, { force: true, expectedPackage: approved }))
      .rejects.toMatchObject({ code: 'operationReviewStale' });
    const damaged = await readManagedCommandPackageView(installed.id, isolated.env);
    const retry = await captureManagedCommandPackageEvidence(damaged, isolated.env, { force: true });
    await removeManagedCommandPackage(installed.id, isolated.env, { force: true, expectedPackage: retry });
    await expect(fs.lstat(installedPackageRoot(installed.id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('retains ownership for a retry when revision files cannot be deleted', async () => {
    const producer = await producerFor();
    const installed = await publish(makeRecord(producer, {}));
    const locked = path.join(installed.resourceRoot, 'lib');
    await fs.chmod(locked, 0o500);
    try {
      await expect(removeManagedCommandPackage(installed.id, isolated.env, { force: true }))
        .rejects.toMatchObject({ code: 'commandPackageRemovalFailed' });
      const ownerFile = path.join(installedPackageRoot(installed.id), 'owner.json');
      expect(JSON.parse(await fs.readFile(ownerFile, 'utf8')).producer).toEqual(producer);
    } finally {
      await fs.chmod(locked, 0o700);
    }
    await removeManagedCommandPackage(installed.id, isolated.env, { force: true });
    await expect(fs.lstat(installedPackageRoot(installed.id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Protects byte-level argv composition and control environment precedence before transparent spawn.
  it('prepares exact argv and snapshots envFrom before binding environment overrides', async () => {
    const id = await installUserCommand({ sourceDirectory: source, name: 'tool', launch, env: isolated.env });
    const invocation = await prepareManagedCommandRun({ id, args: ['', '--json', '多行\n文本'], cwd: isolated.layout.fixtureCwd, cliEntry: path.join(isolated.layout.fixtureCwd, 'aw.js'), env: { ...isolated.env, SOURCE_VALUE: '', AW_PLUGIN_SECRET: 'remove', AW_COMMAND_HOST: 'old', AW_SUBAGENT_WORKER: 'keep' } });
    expect(invocation.executable).toBe(process.execPath);
    expect(invocation.args.slice(1)).toEqual(['', '固定\n参数', '', '--json', '多行\n文本']);
    expect(invocation.env.FROM_HOST).toBe('');
    expect(invocation.env.AW_SUBAGENT_WORKER).toBe('keep');
    expect(invocation.env.AW_PLUGIN_SECRET).toBeUndefined();
    expect(JSON.parse(invocation.env.AW_COMMAND_HOST!)).toMatchObject({ schemaVersion: 1, nodeExecutable: process.execPath, awHome: await fs.realpath(isolated.layout.awHomeDir) });
    await expect(prepareManagedCommandRun({ id, args: [], cwd: isolated.layout.fixtureCwd, cliEntry: path.join(source, 'aw.js'), env: isolated.env })).rejects.toMatchObject({ code: 'commandEnvironmentSourceMissing' });
  });

  // Protects Windows case-insensitive variable merge and platform-independent reserved names.
  it('merges Windows environment names once and refuses reserved environment source references', () => {
    const host = { schemaVersion: 1 as const, nodeExecutable: process.execPath, cliEntry: '/aw.js', awHome: '/isolated-aw' };
    const definition = normalizeCommandLaunch({ runner: 'node', entry: 'entry.mjs', env: { PATH: 'binding' }, envFrom: { COPY: 'Source' } });
    const env = buildManagedCommandEnvironment({ launch: definition, hostEnvironment: { Path: 'host', SOURCE: 'original' }, host, platform: 'win32' });
    expect(env.PATH).toBe('binding');
    expect(env.Path).toBeUndefined();
    expect(env.COPY).toBe('original');
    for (const overrides of [
      { env: { AW_COMMAND_RUNTIME_CONFIG: 'override' } },
      { envFrom: { COPY: 'aw_command_runtime_config' } },
    ]) {
      expect(() => buildManagedCommandEnvironment({ launch: { ...definition, ...overrides }, hostEnvironment: {}, host }))
        .toThrowError(expect.objectContaining({ code: 'commandEnvironmentInvalid' }));
    }
  });
});
