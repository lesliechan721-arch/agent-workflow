import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertManagedCommandPlatform, assertPluginManifestStructure, deriveAwCapabilitiesFromManifest, getAwCapabilityRegistry,
  getCommandPackageId, getManagedCommandArtifactTargets, isUserCommandId,
  normalizeCommandLaunch, normalizeCommandRoutesArtifact, normalizeCommandSelector,
  normalizeInstalledCommandProducer, normalizeUserCommandDefinition,
  parseManagedCommandPlaceholders, replaceManagedCommandPlaceholders,
  validateCommandEntryFiles, validateCommandEnvironment, validatePluginManifest, validateSourcePluginManifest,
  type ProducerIdentity,
} from '../../src/manifest.js';

const producer: ProducerIdentity = {
  sourceId: 'official', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginName: 'example-plugin',
};
const staticCommand = { sourceDir: './tools', mode: 'static', routes: {} };
const dynamicCommand = { sourceDir: './tools', mode: 'dynamic', refreshKeys: [] };
const scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
const launch = { runner: 'node', entry: 'bin/check.mjs' };
const userCommandId = 'cmdu_4ba70354-0867-4ecb-a927-120c1933f514';
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 4, name: 'example-plugin', version: '1.0.0', description: 'Test',
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    ...overrides,
  };
}

describe('shared plugin command author contract', () => {
  it('normalizes static routes with case-sensitive names and preserves launch values', () => {
    const routes = { subcommands: [
      { name: 'check', ...launch, args: ['', ' 中\n文 '], env: { TOKEN: '' }, envFrom: { OTHER: 'HOST_TOKEN' } },
      { name: 'Check', ...launch },
    ], fallback: { ...launch, cwd: 'resource' } };
    const normalized = validatePluginManifest('/plugin', manifest({
      command: { ...staticCommand, routes }, platforms: ['generic', 'codex', 'claude'],
    }));
    expect(normalized.command).toEqual({ ...staticCommand, platforms: ['codex', 'claude'], routes: {
      subcommands: [
        { ...routes.subcommands[0], cwd: 'caller' },
        { name: 'Check', ...launch, args: [], env: {}, envFrom: {}, cwd: 'caller' },
      ],
      fallback: { ...launch, args: [], env: {}, envFrom: {}, cwd: 'resource' },
    } });
    expect(getManagedCommandArtifactTargets(normalized)).toEqual([]);
    expect(deriveAwCapabilitiesFromManifest(normalized)).toContain('aw.managed-commands.v2');
    expect(() => validatePluginManifest('/plugin', manifest({
      command: { ...staticCommand, routes: { subcommands: [routes.subcommands[0], routes.subcommands[0]] } },
    }))).toThrow(/duplicate command name/u);
  });

  it.each([
    { ...staticCommand, refreshKeys: [] },
    { ...dynamicCommand, routes: {} },
    { ...dynamicCommand, refreshKeys: undefined },
    { ...staticCommand, routes: undefined },
    { ...staticCommand, scope: 'project' },
    { ...staticCommand, render: true },
    { ...staticCommand, platforms: ['generic'] },
    { ...staticCommand, platforms: [] },
    { ...staticCommand, sourceDir: './codex/tools' },
    { ...staticCommand, sourceDir: './.aw/tools' },
    { ...staticCommand, runtimeConfig: { keys: [] } },
    { ...staticCommand, runtimeConfig: { keys: ['setting', 'setting'] } },
    { ...staticCommand, routes: { subcommands: [{ name: 'path/name', ...launch }] } },
  ])('rejects invalid command declaration %#', (command) => {
    expect(() => validatePluginManifest('/plugin', manifest({ command, scripts }))).toThrow();
  });

  it('requires plugin-supported Native platforms and rejects all legacy declaration structure', () => {
    expect(() => validatePluginManifest('/plugin', manifest({ platforms: ['generic'], command: staticCommand }))).toThrow(/Native platforms/u);
    expect(() => validatePluginManifest('/plugin', manifest({
      platforms: ['claude'], command: { ...staticCommand, platforms: ['codex'] },
    }))).toThrow(/command.platforms/u);
    expect(() => assertPluginManifestStructure(manifest({ managedCommands: { packages: [], sets: [] } }))).toThrow();
    expect(getAwCapabilityRegistry()).not.toContain('aw.managed-commands.v1');
    expect(getAwCapabilityRegistry()).not.toContain('aw.native-tools.v2');
  });

  it('creates one shared user renderer request and validates complete replacement output', () => {
    const normalized = validatePluginManifest('/plugin', manifest({ command: dynamicCommand, scripts }));
    expect(getManagedCommandArtifactTargets(normalized)).toEqual([{
      id: 'command-routes', target: 'aw.command-routes', kind: 'commandRoutes',
      surface: { kind: 'aw', name: 'managed-commands' }, scopes: ['user'], refreshKeys: [],
    }]);
    expect(() => validatePluginManifest('/plugin', manifest({ command: dynamicCommand }))).toThrow(/scripts.artifacts.render/u);
    const response = { id: 'command-routes', target: 'aw.command-routes', kind: 'commandRoutes', refreshKeys: [], routes: {} };
    expect(normalizeCommandRoutesArtifact(response).routes).toEqual({ subcommands: [] });
    for (const invalid of [
      { id: 'extra' }, { target: 'aw.command-package' }, { kind: 'commandSet' }, { state: 'present' },
      { platform: 'codex' }, { routes: { fallback: { ...launch, entry: '../escape.mjs' } } },
      { routes: { fallback: { ...launch, entry: '.aw/native-tool-reader.mjs' } } },
    ]) expect(() => normalizeCommandRoutesArtifact({ ...response, ...invalid })).toThrow();
  });

  it('allows dynamic refresh keys from public common fields only', () => {
    const input = manifest({
      platforms: ['codex', 'claude'], scripts,
      config: { schemaVersion: 5, fields: { mode: { type: 'string' }, secret: { type: 'string', sensitive: true } }, platforms: {
        codex: { fields: { mode: { type: 'string', sensitive: true }, codexOnly: { type: 'boolean' } } },
      } },
    });
    expect(() => validatePluginManifest('/plugin', {
      ...input, command: { ...dynamicCommand, refreshKeys: ['mode'] },
    })).not.toThrow();
    for (const [key, error] of [['secret', /sensitive/u], ['codexOnly', /unknown config key/u]] as const) {
      expect(() => validatePluginManifest('/plugin', {
        ...input, command: { ...dynamicCommand, refreshKeys: [key] },
      })).toThrow(error);
    }
  });

  it('checks runtime snapshot keys in every effective platform profile', () => {
    const input = manifest({
      platforms: ['codex', 'claude', 'generic'],
      config: { schemaVersion: 5, fields: { mode: { type: 'string' } }, platforms: {
        codex: { fields: { mode: { type: 'string', sensitive: true } } },
        claude: { fields: { claudeOnly: { type: 'boolean' } } },
      } },
    });
    expect(() => validatePluginManifest('/plugin', {
      ...input, command: { ...staticCommand, runtimeConfig: { keys: ['mode'] } },
    })).toThrow(/runtimeConfig.keys for codex.*sensitive/u);
    expect(() => validatePluginManifest('/plugin', {
      ...input, command: { ...staticCommand, runtimeConfig: { keys: ['claudeOnly'] } },
    })).toThrow(/runtimeConfig.keys for codex.*unknown/u);
    expect(() => validatePluginManifest('/plugin', {
      ...input, command: { ...staticCommand, platforms: ['claude'], runtimeConfig: { keys: ['mode', 'claudeOnly'] } },
    })).not.toThrow();
  });

  it('requires a command on each effective platform using managed permissions or Claude sandbox exclusions', () => {
    const permission = { argsPrefix: ['wait', '--platform', 'claude'] };
    const extensions = {
      permissions: [{ name: 'tools', allow: ['git status'], agentOverrides: {
        claude: { allow: [{ argsPrefix: [] }], sandbox: { excludedCommands: [permission] } },
      } }],
    };
    const platformManifest = { extensions, platforms: ['codex', 'claude', 'generic'] };
    const normalized = validatePluginManifest('/plugin', manifest({
      ...platformManifest, command: { ...staticCommand, platforms: ['claude'] },
    }));
    expect(normalized.extensions?.permissions?.[0]?.agentOverrides?.claude).toEqual(extensions.permissions[0]?.agentOverrides.claude);
    expect(deriveAwCapabilitiesFromManifest(normalized)).toEqual(expect.arrayContaining([
      'aw.managed-commands.v2', 'aw.claude.sandbox-exclusions.v1',
    ]));
    expect(() => validatePluginManifest('/plugin', manifest(platformManifest))).toThrow(/requires a command declaration/u);
    expect(() => validatePluginManifest('/plugin', manifest({
      ...platformManifest, command: { ...staticCommand, platforms: ['codex'] },
    }))).toThrow(/claude.*outside command.platforms/u);
    for (const action of [{}, { argsPrefix: ['wait *'] }, { command: { set: 'tools', key: 'wait' }, argsPrefix: [] }]) {
      expect(() => assertPluginManifestStructure(manifest({
        extensions: { permissions: [{ name: 'tools', allow: [action] }] },
      }))).toThrow();
    }
    for (const agent of [{ claude: { sandbox: { excludedCommands: [{}] } } },
      { claude: { sandbox: { excludedCommands: ['aw command run official/tools'] } } },
      { codex: { sandbox: { excludedCommands: [permission] } } }]) {
      expect(() => assertPluginManifestStructure(manifest({
        extensions: { permissions: [{ name: 'tools', agentOverrides: agent }] },
      }))).toThrow();
    }
  });

  it('expands exact Skill placeholders using source/plugin and rejects old and unavailable references', () => {
    const input = 'Run `{{aw.command}}`\n{{aw.command}} wait';
    expect(parseManagedCommandPlaceholders(input).map(({ start, end }) => input.slice(start, end)))
      .toEqual(['{{aw.command}}', '{{aw.command}}']);
    expect(replaceManagedCommandPlaceholders(input, 'official/example-plugin')).toBe(
      'Run `aw command run official/example-plugin --`\naw command run official/example-plugin -- wait',
    );
    for (const malformed of ['{{aw.command:tools/check}}', '{{aw.command.tools.check.default}}', '{{aw.command}']) {
      expect(() => parseManagedCommandPlaceholders(malformed)).toThrow(/commandReferenceInvalid/u);
    }
    const normalized = validatePluginManifest('/plugin', manifest({ command: { ...staticCommand, platforms: ['codex'] } }));
    expect(() => assertManagedCommandPlatform(normalized, 'codex', 'Skill')).not.toThrow();
    expect(() => assertManagedCommandPlatform(normalized, 'claude', 'Skill')).toThrow(/outside command.platforms/u);
    expect(() => assertManagedCommandPlatform({}, 'codex', 'Skill')).toThrow(/requires a command declaration/u);
  });

  it('reserves injected .aw content and requires the chosen entry to be an ordinary source file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-core-command-'));
    try {
      const entryPath = path.join(root, 'tools', 'bin', 'check.mjs');
      await fs.mkdir(path.dirname(entryPath), { recursive: true });
      await fs.writeFile(entryPath, '');
      const input = manifest({ command: { ...staticCommand, routes: { fallback: launch } } });
      await expect(validateSourcePluginManifest(root, input)).resolves.toHaveProperty('command');
      await fs.mkdir(path.join(root, 'tools', 'bin', '.AW'));
      await expect(validateSourcePluginManifest(root, input)).rejects.toThrow(/protected.*\.AW/u);
      await fs.rmdir(path.join(root, 'tools', 'bin', '.AW'));
      await fs.unlink(entryPath);
      await expect(validateCommandEntryFiles(path.join(root, 'tools'), [normalizeCommandLaunch(launch)])).rejects.toThrow(/regular file/u);
      await fs.symlink('missing.mjs', entryPath);
      await expect(validateCommandEntryFiles(path.join(root, 'tools'), [normalizeCommandLaunch(launch)])).rejects.toThrow(/without links/u);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe('command launches and installed records', () => {
  it.each([
    { entry: '../escape.mjs' },
    { entry: './entry.mjs' },
    { entry: 'a//entry.mjs' },
    { entry: 'C:/entry.mjs' },
    { args: ['\ud800'] },
    { args: ['\0'] },
    { args: Array(129).fill('') },
    { env: { aw_home: '/other' } },
    { envFrom: { TOKEN: 'Aw_Command_host' } },
    { owner: 'foreign' },
    { args: null },
  ])('rejects unsafe launch inputs %#', (input) => {
    expect(() => normalizeCommandLaunch({ ...launch, ...input })).toThrow();
  });

  it('checks Windows environment collisions independently of host OS', () => {
    expect(() => validateCommandEnvironment({ Token: 'literal' }, { TOKEN: 'SOURCE' }, 'win32')).toThrow(/duplicate/u);
    expect(() => validateCommandEnvironment({ Token: 'literal' }, { TOKEN: 'SOURCE' }, 'linux')).not.toThrow();
  });

  it('derives one stable v2 package ID from verified source and plugin fields', () => {
    expect(normalizeCommandSelector('official/example-plugin')).toEqual({ sourceId: 'official', pluginName: 'example-plugin' });
    for (const invalid of ['example-plugin', 'official/example/plugin', 'Official/example-plugin', 'official/Example']) {
      expect(() => normalizeCommandSelector(invalid)).toThrow();
    }
    // Independently computed from sorted-key v2 JSON and Python hashlib.
    expect(getCommandPackageId(producer)).toBe('pkg_1d983762f47f5e7fe5f0bda59ac1ce2cc1764a50a095511bbd019a4ff6b9ea63');
    expect(getCommandPackageId({ pluginName: producer.pluginName, sourceIdentity: producer.sourceIdentity, sourceId: producer.sourceId }))
      .toBe(getCommandPackageId(producer));
    for (const changed of [{ sourceId: 'other' }, { sourceIdentity: `sha256:${'b'.repeat(64)}` }, { pluginName: 'example-other' }]) {
      expect(getCommandPackageId({ ...producer, ...changed })).not.toBe(getCommandPackageId(producer));
    }
    expect(() => getCommandPackageId({ ...producer, kind: 'package' } as ProducerIdentity)).toThrow(/unknown field/u);
  });

  it('requires normalized installed launch records and the snapshot allowlist when snapshots exist', () => {
    const record = {
      schemaVersion: 2, producer, pluginVersion: '1.0.0', sourceContentDigest: `sha256:${'b'.repeat(64)}`,
      routes: { subcommands: [], fallback: normalizeCommandLaunch(launch) }, runtimeConfigPlatforms: ['claude'],
      runtimeConfigKeys: ['mode'],
    };
    expect(normalizeInstalledCommandProducer(record)).toEqual(record);
    expect(() => normalizeInstalledCommandProducer({ ...record, schemaVersion: 1 })).toThrow(/expected 2/u);
    expect(() => normalizeInstalledCommandProducer({ ...record, runtimeConfigKeys: undefined })).toThrow(/allowed keys/u);
    expect(() => normalizeInstalledCommandProducer({ ...record, routes: { subcommands: [], fallback: launch } })).toThrow(/defaults/u);
  });

  it('preserves the v1 installed user command format and its UUID', () => {
    const userDefinition = {
      schemaVersion: 1, id: userCommandId, name: 'Check', packageRevision: userCommandId.slice(5),
      launch: normalizeCommandLaunch(launch),
    };
    expect(isUserCommandId(userCommandId)).toBe(true);
    expect(isUserCommandId('cmdp_fef82b56d2543a37')).toBe(false);
    expect(normalizeUserCommandDefinition(userDefinition)).toEqual(userDefinition);
    expect(() => normalizeUserCommandDefinition({ ...userDefinition, launch })).toThrow(/defaults/u);
  });
});
