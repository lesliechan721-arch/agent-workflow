import * as fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommandPackageId, normalizeCommandDefinition, normalizeCommandLaunch, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';

import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';
import {
  COMMAND_PRODUCER_RECORD,
  copyManagedCommandDirectory,
  installUserCommand,
  listManagedCommands,
  publishManagedCommandBindings,
  readUserCommandDefinition,
  removeManagedCommandPackage,
  removeUserCommand,
  resolveManagedCommand,
  syncManagedCommandPackage,
  updateUserCommand,
  writeInstalledCommandProducer,
} from '../../src/utils/managed-command-store.js';
import { buildManagedCommandEnvironment, prepareManagedCommandRun } from '../../src/utils/managed-command-runtime.js';

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

  // Protects actual producer truth and offline removal after source identity or project location changes.
  it('runs from the installed package record and removes corrupt content by exact old package identity', async () => {
    const producer: ProducerIdentity = { sourceId: 'old-source', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginName: 'example', kind: 'package', key: 'tool', platform: null, scope: 'project', projectRoot: path.normalize(await fs.realpath(isolated.layout.fixtureCwd)) };
    const entry = normalizeCommandDefinition({ key: 'run', runner: 'node', entry: 'entry.mjs' });
    const synced = await syncManagedCommandPackage({ producer, sourceDirectory: source, sets: [{ set: 'tools', state: 'present', entries: [entry] }], env: isolated.env });
    expect(synced.id).toBe(getCommandPackageId(producer));
    const id = synced.commandIds[0]!;
    expect((await resolveManagedCommand(id, isolated.env)).launch.entry).toBe('entry.mjs');
    const recordPath = path.join(synced.resourceRoot, COMMAND_PRODUCER_RECORD);
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    record.sets[0].entries[0].args = ['current-installed-value'];
    await fs.writeFile(recordPath, JSON.stringify(record));
    expect((await resolveManagedCommand(id, isolated.env)).launch.args).toEqual(['current-installed-value']);
    await fs.writeFile(recordPath, '{broken');
    await expect(resolveManagedCommand(id, isolated.env)).rejects.toMatchObject({ code: 'commandBindingInvalid' });
    expect((await listManagedCommands(isolated.env)).packages[0]).toMatchObject({ id: synced.id, availability: 'unavailable' });
    const removed = await removeManagedCommandPackage(synced.id, isolated.env);
    expect(removed.removedCommandIds).toEqual([id]);
    await expect(resolveManagedCommand(id, isolated.env)).rejects.toMatchObject({ code: 'commandNotFound' });
    expect(await fs.readFile(path.join(source, 'entry.mjs'), 'utf8')).toContain('dependency.mjs');
  });

  // A digest collision must fail before changing either the producer or any
  // binding, including when both conflicting identities are new candidates.
  it('rejects digest collisions in publication and package sync without replacing existing state', async () => {
    const producer: ProducerIdentity = { sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginName: 'example', kind: 'package', key: 'tools', platform: null, scope: 'user', projectRoot: null };
    const entries = ['first', 'second'].map((key) => normalizeCommandDefinition({ key, runner: 'node', entry: 'entry.mjs' }));
    const recordPath = path.join(source, COMMAND_PRODUCER_RECORD);
    const bindings = path.join(isolated.layout.awHomeDir, 'commands', 'bindings');
    await writeInstalledCommandProducer(source, { schemaVersion: 1, producer, sets: [] });
    const before = await fs.readFile(recordPath, 'utf8');
    const createHash = crypto.createHash;
    const hashSpy = vi.spyOn(crypto, 'createHash').mockImplementation((algorithm, options) => {
      const hash = createHash(algorithm, options);
      // Natural SHA64 collisions are not practical test inputs. Replace only
      // the crypto digest; normalization, publication and real files stay live.
      vi.spyOn(hash, 'digest').mockReturnValue('a'.repeat(64));
      return hash;
    });
    syncBuiltinESMExports();
    try {
      const publish = (selected: typeof entries) => publishManagedCommandBindings({ producer, resourceRoot: source, sets: [{ set: 'tools', state: 'present', entries: selected }], env: isolated.env });
      await expect(publish(entries)).rejects.toMatchObject({ code: 'commandIdentityConflict' });
      expect(await fs.readFile(recordPath, 'utf8')).toBe(before);
      await expect(fs.lstat(bindings)).rejects.toMatchObject({ code: 'ENOENT' });
      const [id] = await publish(entries.slice(0, 1));
      const bindingPath = path.join(bindings, `${id}.json`);
      const bindingBefore = await fs.readFile(bindingPath, 'utf8');
      const recordBefore = await fs.readFile(recordPath, 'utf8');
      await expect(publish(entries.slice(1))).rejects.toMatchObject({ code: 'commandIdentityConflict' });
      expect(await fs.readFile(bindingPath, 'utf8')).toBe(bindingBefore);
      expect(await fs.readFile(recordPath, 'utf8')).toBe(recordBefore);
      const packageSource = path.join(isolated.layout.fixtureCwd, 'collision-package');
      await fs.mkdir(packageSource);
      await fs.writeFile(path.join(packageSource, 'entry.mjs'), '// Original package.\n');
      const sync = (selected: typeof entries) => syncManagedCommandPackage({ producer, sourceDirectory: packageSource, sets: [{ set: 'tools', state: 'present', entries: selected }], env: isolated.env });
      const installed = await sync(entries.slice(0, 1));
      const installedRecord = path.join(installed.resourceRoot, COMMAND_PRODUCER_RECORD);
      const installedBefore = await fs.readFile(installedRecord, 'utf8');
      const installedBindingBefore = await fs.readFile(bindingPath, 'utf8');
      await fs.writeFile(path.join(packageSource, 'entry.mjs'), '// Replacement package.\n');
      await expect(sync(entries.slice(1))).rejects.toMatchObject({ code: 'commandIdentityConflict' });
      expect(await fs.readFile(bindingPath, 'utf8')).toBe(installedBindingBefore);
      expect(await fs.readFile(installedRecord, 'utf8')).toBe(installedBefore);
      expect(await fs.readFile(path.join(installed.resourceRoot, 'entry.mjs'), 'utf8')).toBe('// Original package.\n');
    } finally {
      hashSpy.mockRestore();
      syncBuiltinESMExports();
    }
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
    expect(() => buildManagedCommandEnvironment({ launch: { ...definition, envFrom: { COPY: 'aw_command_host' } }, hostEnvironment: {}, host })).toThrowError(expect.objectContaining({ code: 'commandEnvironmentInvalid' }));
  });
});
