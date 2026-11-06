import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommandPackageId, getPluginCommandId, normalizeCommandDefinition, normalizeCommandLaunch, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';

import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';
import {
  COMMAND_PRODUCER_RECORD,
  assertManagedCommandBindingIdentities,
  captureManagedCommandBindingRecoveryEvidence,
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

  async function installedNativeProducer() {
    const sourceIdentity = `sha256:${'a'.repeat(64)}`;
    const producer: ProducerIdentity = { sourceId: 'fixture', sourceIdentity, pluginName: 'example', kind: 'static-skill', key: 'guide', platform: 'codex', scope: 'user', projectRoot: null };
    const marketplaceRoot = path.join(isolated.layout.awHomeDir, 'marketplaces', producer.sourceId);
    const pluginRoot = path.join(marketplaceRoot, 'plugins', producer.pluginName);
    const resourceRoot = path.join(pluginRoot, 'codex', 'skills', producer.key);
    await fs.mkdir(resourceRoot, { recursive: true });
    await fs.cp(source, resourceRoot, { recursive: true });
    for (const [relativePath, value] of [
      ['config.json', { schemaVersion: 2, sourceId: producer.sourceId, sourceIdentity, marketplaceName: 'aw' }],
      ['.agents/plugins/marketplace.json', { name: 'aw', plugins: [{ name: producer.pluginName, source: `./plugins/${producer.pluginName}` }] }],
      [`plugins/${producer.pluginName}/.agents-plugin/plugin.json`, { name: producer.pluginName, version: '1.0.0', skills: './skills' }],
      [`plugins/${producer.pluginName}/.codex-plugin/plugin.json`, { name: producer.pluginName, version: '1.0.0', skills: './codex/skills' }],
    ] as const) {
      const filePath = path.join(marketplaceRoot, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(value));
    }
    await fs.writeFile(path.join(resourceRoot, 'SKILL.md'), '# Native Guide\n');
    const sets = [{ set: 'tools', state: 'present' as const, entries: [normalizeCommandDefinition({ key: 'run', runner: 'node', entry: 'entry.mjs' })] }];
    const [id] = await publishManagedCommandBindings({ producer, resourceRoot, sets, env: isolated.env });
    const bindingPath = path.join(isolated.layout.awHomeDir, 'commands', 'bindings', `${id!}.json`);
    return { producer, resourceRoot, sets, id: id!, bindingPath };
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

  // A damaged weak index can be rebuilt from independently verified installed Native bytes, including after cleanup.
  it('rebuilds a damaged binding only from its previously verified installed Native producer', async () => {
    const installed = await installedNativeProducer();
    const evidence = await captureManagedCommandBindingRecoveryEvidence({ ...installed, env: isolated.env });
    await fs.writeFile(installed.bindingPath, '{broken');
    await fs.unlink(path.join(installed.resourceRoot, COMMAND_PRODUCER_RECORD));
    const sets = [{ ...installed.sets[0]!, entries: [{ ...installed.sets[0]!.entries[0]!, args: ['rebuilt'] }] }];
    const options = { ...installed, sets, env: isolated.env, bindingRecoveryEvidence: [evidence] };
    await assertManagedCommandBindingIdentities({ producers: [options], env: isolated.env, bindingRecoveryEvidence: [evidence] });
    expect(await fs.readFile(installed.bindingPath, 'utf8')).toBe('{broken');
    expect(await publishManagedCommandBindings(options)).toEqual([installed.id]);
    expect((await resolveManagedCommand(installed.id, isolated.env)).launch.args).toEqual(['rebuilt']);
  });

  // New candidates and another command or producer cannot claim a damaged binding from its filename.
  it.each(['none', 'source', 'platform', 'producer', 'command'] as const)('rejects damaged binding recovery with %s evidence identity', async (difference) => {
    const installed = await installedNativeProducer();
    const evidence = await captureManagedCommandBindingRecoveryEvidence({ ...installed, env: isolated.env });
    const producer = { ...installed.producer,
      ...(difference === 'source' ? { sourceIdentity: `sha256:${'b'.repeat(64)}` } : {}),
      ...(difference === 'platform' ? { platform: 'claude' as const } : {}),
      ...(difference === 'producer' ? { key: 'other-guide' } : {}),
    };
    const entry = { ...installed.sets[0]!.entries[0]!, ...(difference === 'command' ? { key: 'other' } : {}) };
    const sets = [{ ...installed.sets[0]!, entries: [entry] }];
    const id = getPluginCommandId({ schemaVersion: 1, producer, set: sets[0]!.set, key: entry.key, variant: entry.variant });
    const bindingPath = path.join(path.dirname(installed.bindingPath), `${id}.json`);
    await fs.writeFile(bindingPath, '{broken');
    const before = await fs.readFile(path.join(installed.resourceRoot, COMMAND_PRODUCER_RECORD), 'utf8');
    await expect(publishManagedCommandBindings({ producer, resourceRoot: installed.resourceRoot, sets, env: isolated.env, ...(difference !== 'none' ? { bindingRecoveryEvidence: [evidence] } : {}) })).rejects.toMatchObject({ code: 'commandBindingInvalid' });
    expect(await fs.readFile(bindingPath, 'utf8')).toBe('{broken');
    expect(await fs.readFile(path.join(installed.resourceRoot, COMMAND_PRODUCER_RECORD), 'utf8')).toBe(before);
  });

  // Recovery evidence never overrides a readable foreign identity or follows a link to a different file.
  it.each(['foreign', 'symlink'] as const)('retains %s binding evidence during Native rebuild', async (kind) => {
    const installed = await installedNativeProducer();
    const evidence = await captureManagedCommandBindingRecoveryEvidence({ ...installed, env: isolated.env });
    const before = await fs.readFile(installed.bindingPath, 'utf8');
    if (kind === 'foreign') {
      const foreign = JSON.parse(before);
      foreign.identity.producer.sourceIdentity = `sha256:${'b'.repeat(64)}`;
      await fs.writeFile(installed.bindingPath, JSON.stringify(foreign));
    } else {
      await fs.unlink(installed.bindingPath);
      await fs.symlink(path.join(source, 'entry.mjs'), installed.bindingPath);
    }
    await expect(publishManagedCommandBindings({ ...installed, env: isolated.env, bindingRecoveryEvidence: [evidence] })).rejects.toMatchObject({ code: kind === 'foreign' ? 'commandIdentityConflict' : 'commandResourceInvalid' });
    if (kind === 'foreign') expect(JSON.parse(await fs.readFile(installed.bindingPath, 'utf8')).identity.producer.sourceIdentity).toBe(`sha256:${'b'.repeat(64)}`);
    else expect((await fs.lstat(installed.bindingPath)).isSymbolicLink()).toBe(true);
  });

  // Filesystem failures must stop the write; unreadable content is not proof of a damaged index.
  it.each(['EACCES', 'EIO'] as const)('does not rebuild a binding after a %s read failure', async (code) => {
    const installed = await installedNativeProducer();
    const evidence = await captureManagedCommandBindingRecoveryEvidence({ ...installed, env: isolated.env });
    const before = await fs.readFile(installed.bindingPath, 'utf8');
    const readFile = fs.readFile;
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation((...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === installed.bindingPath) return Promise.reject(Object.assign(new Error('Cannot read binding'), { code }));
      return readFile(...args);
    });
    syncBuiltinESMExports();
    try {
      await expect(publishManagedCommandBindings({ ...installed, env: isolated.env, bindingRecoveryEvidence: [evidence] })).rejects.toMatchObject({ code });
    } finally {
      readSpy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(await fs.readFile(installed.bindingPath, 'utf8')).toBe(before);
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
