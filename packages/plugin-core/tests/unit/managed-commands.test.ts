import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertPluginManifestStructure, deriveAwCapabilitiesFromManifest, getCommandPackageId,
  getManagedCommandArtifactTargets, getPluginCommandId, isManagedCommandId, normalizeCommandDefinition,
  normalizeCommandIdentity, normalizeCommandLaunch, normalizeManagedCommands,
  normalizeInstalledCommandProducer, normalizeUserCommandDefinition,
  parseManagedCommandPlaceholders, replaceManagedCommandPlaceholders,
  validateCommandEntryFiles, validateCommandEnvironment, validateManagedCommandSources, validatePluginManifest, validateSourcePluginManifest,
  type CommandIdentity, type ProducerIdentity,
} from '../../src/manifest.js';

const producer: ProducerIdentity = {
  sourceId: 'official', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginName: 'example-plugin',
  kind: 'package', key: 'tools', platform: null, scope: 'user', projectRoot: null,
};
const identity: CommandIdentity = { schemaVersion: 1, producer, set: 'tools', key: 'check', variant: 'default' };
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3, name: 'example-plugin', version: '1.0.0', description: 'Test',
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    ...overrides,
  };
}
const packages = [{ key: 'tools', scope: 'user', platforms: ['codex', 'claude'], sourceDir: './tools' }];

describe('managed commands author contract', () => {
  it('normalizes static command definitions without changing argv or environment values', () => {
    const command = normalizeCommandDefinition({ key: 'check', runner: 'node', entry: 'bin/check.mjs', args: ['', ' 中\n文 '], env: { TOKEN: '' }, envFrom: { OTHER: 'HOST_TOKEN' } });
    expect(command).toEqual({ key: 'check', variant: 'default', runner: 'node', entry: 'bin/check.mjs', args: ['', ' 中\n文 '], env: { TOKEN: '' }, envFrom: { OTHER: 'HOST_TOKEN' }, cwd: 'caller' });
    expect(normalizeManagedCommands({})).toEqual({ packages: [], sets: [] });
    expect(() => normalizeManagedCommands({ sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'tools' }, mode: 'static', entries: [command, { key: 'check', runner: 'node', entry: 'other.mjs' }] }] })).toThrow(/duplicate/u);
  });

  it.each([
    { runner: 'node', entry: '../escape.mjs' },
    { runner: 'node', entry: './entry.mjs' },
    { runner: 'node', entry: 'a//entry.mjs' },
    { runner: 'node', entry: 'C:/entry.mjs' },
    { runner: 'node', entry: 'entry.mjs', args: ['\ud800'] },
    { runner: 'node', entry: 'entry.mjs', args: ['\0'] },
    { runner: 'node', entry: 'entry.mjs', args: Array(129).fill('') },
    { runner: 'node', entry: 'entry.mjs', env: { aw_home: '/other' } },
    { runner: 'node', entry: 'entry.mjs', envFrom: { TOKEN: 'Aw_Command_host' } },
    { runner: 'node', entry: 'entry.mjs', owner: 'foreign' },
    { runner: 'node', entry: 'entry.mjs', args: null },
  ])('rejects unsafe launch input %#', (input) => {
    expect(() => normalizeCommandLaunch(input)).toThrow();
  });

  it('checks Windows environment collisions independently of host OS', () => {
    expect(() => validateCommandEnvironment({ Token: 'literal' }, { TOKEN: 'SOURCE' }, 'win32')).toThrow(/duplicate/u);
    expect(() => validateCommandEnvironment({ Token: 'literal' }, { TOKEN: 'SOURCE' }, 'linux')).not.toThrow();
  });

  it('requires complete installed launch records while source definitions can use defaults', () => {
    const entry = normalizeCommandDefinition({ key: 'check', runner: 'node', entry: 'check.mjs' });
    const record = { schemaVersion: 1, producer, sets: [{ set: 'tools', state: 'present', entries: [entry] }] };
    expect(normalizeInstalledCommandProducer(record)).toEqual(record);
    expect(() => normalizeInstalledCommandProducer({ ...record, sets: [{ set: 'tools', state: 'present', entries: [{ key: 'check', runner: 'node', entry: 'check.mjs' }] }] })).toThrow(/defaults/u);
    expect(() => normalizeUserCommandDefinition({ schemaVersion: 1, id: 'cmdu_4ba70354-0867-4ecb-a927-120c1933f514', name: 'Check', packageRevision: '4ba70354-0867-4ecb-a927-120c1933f514', launch: { runner: 'node', entry: 'check.mjs' } })).toThrow(/defaults/u);
  });

  it('projects one AW package target and one AW command set from their only declaration', () => {
    const normalized = validatePluginManifest('/test/plugin', manifest({
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      managedCommands: { packages: [{ ...packages[0], render: true }], sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'tools' }, mode: 'dynamic', refreshKeys: [] }] },
    }));
    expect(getManagedCommandArtifactTargets(normalized)).toMatchObject([
      { id: 'command-package.tools', target: 'aw.command-package', kind: 'commandPackage', surface: { kind: 'aw', name: 'managed-commands' }, scopes: ['user'], states: ['present'] },
      { id: 'command-set.tools', target: 'aw.command-set', kind: 'commandSet', surface: { kind: 'aw', name: 'managed-commands' }, scopes: ['user'], states: ['present', 'disabled'] },
    ]);
    expect(getManagedCommandArtifactTargets(normalized).every((target) => target.platform === undefined)).toBe(true);
    expect(deriveAwCapabilitiesFromManifest(normalized)).toContain('aw.managed-commands.v1');
  });

  it.each(['static', 'dynamic'] as const)('checks static Skill producer platform support for %s sets through source validation', async (mode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-core-command-platform-'));
    try {
      await fs.mkdir(path.join(root, 'skills', 'review'), { recursive: true });
      await fs.writeFile(path.join(root, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review files.\n---\nReview files.\n');
      await fs.writeFile(path.join(root, 'render.mjs'), '');
      const raw = manifest({
        skills: './skills',
        marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CLAUDE'] } },
        scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
        managedCommands: { sets: [{ set: 'review', producer: { kind: 'static-skill', platform: 'codex', skillKey: 'review' }, mode, ...(mode === 'static' ? { entries: [] } : { refreshKeys: [] }) }] },
      });
      await expect(validateSourcePluginManifest(root, raw)).rejects.toThrow(/support/u);
      for (const products of [['CODEX'], undefined]) {
        const normalized = await validateSourcePluginManifest(root, { ...raw, marketplace: {
          category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', ...(products ? { products } : {}) },
        } });
        expect(getManagedCommandArtifactTargets(normalized)).toMatchObject(mode === 'static' ? [] : [
          { id: 'command-set.review', platform: 'codex', surface: { kind: 'platform', platform: 'codex' }, scopes: ['user'] },
        ]);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('uses shared user requests for native static sets while Claude owned Skill sets keep their declared scope', () => {
    const normalized = validatePluginManifest('/test/plugin', manifest({
      skills: './skills',
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      artifacts: { targets: [{ id: 'owned', platform: 'claude', target: 'claude.skill', skillKey: 'owned', scopes: ['project'], states: ['present'], refreshKeys: [] }] },
      managedCommands: { sets: [
        ...(['codex', 'claude'] as const).map((platform) => ({ set: `${platform}-native`, producer: { kind: 'static-skill', platform, skillKey: 'review' }, mode: 'dynamic', refreshKeys: [] })),
        { set: 'owned', producer: { kind: 'artifact', artifactId: 'owned' }, mode: 'dynamic', refreshKeys: [] },
      ] },
    }));
    expect(getManagedCommandArtifactTargets(normalized)).toMatchObject([
      { id: 'command-set.codex-native', platform: 'codex', scopes: ['user'] },
      { id: 'command-set.claude-native', platform: 'claude', scopes: ['user'] },
      { id: 'command-set.owned', platform: 'claude', scopes: ['project'] },
    ]);
  });

  it('rejects unknown fields and invalid cross-declaration inputs at the public manifest boundary', () => {
    for (const managedCommands of [
      { packages: [{ ...packages[0], render: false }] },
      { packages: [{ ...packages[0], extra: true }] },
      { packages: [{ ...packages[0], sourceDir: './codex/tools' }] },
      { packages: [packages[0], packages[0]] },
      { packages, sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'missing' }, mode: 'static', entries: [] }] },
      { packages, sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'tools' }, mode: 'dynamic' }] },
      { packages: [{ ...packages[0], refreshKeys: ['secret'] }] },
    ]) expect(() => validatePluginManifest('/test/plugin', manifest({ managedCommands }))).toThrow();
    expect(() => validatePluginManifest('/test/plugin', manifest({ managedCommands: { packages, sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'tools' }, mode: 'dynamic', refreshKeys: [] }] } }))).toThrow(/render/u);
    expect(() => validatePluginManifest('/test/plugin', manifest({
      config: { schemaVersion: 4, fields: { secret: { type: 'string', sensitive: true } } },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      managedCommands: { packages, sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'tools' }, mode: 'dynamic', refreshKeys: ['secret'] }] },
    }))).toThrow(/sensitive/u);
  });

  it('accepts structured permissions and only Claude sandbox exclusions', () => {
    const permission = { command: { set: 'tools', key: 'check' }, argsPrefix: ['wait'] };
    const normalized = validatePluginManifest('/test/plugin', manifest({ extensions: { permissions: [{ name: 'tools', allow: ['git status', permission], agentOverrides: { claude: { sandbox: { excludedCommands: [permission] } } } }] } }));
    expect(normalized.extensions?.permissions?.[0]?.allow).toEqual(['git status', { command: { set: 'tools', key: 'check', variant: 'default' }, argsPrefix: ['wait'] }]);
    expect(deriveAwCapabilitiesFromManifest(normalized)).toEqual(expect.arrayContaining(['aw.managed-commands.v1', 'aw.claude.sandbox-exclusions.v1']));
    for (const entry of [
      { name: 'bad', allow: [{ command: { set: 'tools', key: 'check' }, argsPrefix: ['wait *'] }] },
      { name: 'bad', agentOverrides: { claude: { sandbox: { excludedCommands: ['aw command run anything'] } } } },
      { name: 'bad', agentOverrides: { codex: { sandbox: { excludedCommands: [permission] } } } },
    ]) expect(() => assertPluginManifestStructure(manifest({ extensions: { permissions: [entry] } }))).toThrow();
  });

  it('uses the first 64 hash bits and preserves source, scope and key case distinctions', () => {
    // Golden values were computed independently from the normative canonical JSON with Python hashlib.
    expect(getPluginCommandId(identity)).toBe('cmdp_3b4519b3e3a1a542');
    expect(isManagedCommandId('cmdp_3b4519b3e3a1a542')).toBe(true);
    for (const invalid of ['cmdp_3B4519B3E3A1A542', `cmdp_${'a'.repeat(15)}`, `cmdp_${'a'.repeat(17)}`, `cmdp_${'a'.repeat(64)}`]) {
      expect(isManagedCommandId(invalid)).toBe(false);
    }
    expect(getCommandPackageId(producer)).toBe('pkg_32d3b599e9e009f6dccdbab521941d838d1ec5ae75ba3fc2a7b8b3a7ad68e6c4');
    expect(getPluginCommandId({ variant: 'default', key: 'check', set: 'tools', producer: { ...producer }, schemaVersion: 1 })).toBe(getPluginCommandId(identity));
    for (const changed of [{ ...producer, sourceId: 'renamed' }, { ...producer, sourceIdentity: `sha256:${'b'.repeat(64)}` }, { ...producer, scope: 'project' as const, projectRoot: path.resolve('/project') }]) {
      expect(getPluginCommandId({ ...identity, producer: changed })).not.toBe(getPluginCommandId(identity));
    }
    expect(getPluginCommandId({ ...identity, key: 'Check' })).not.toBe(getPluginCommandId(identity));
    expect(() => normalizeCommandIdentity({ ...identity, version: '2.0.0' })).toThrow(/unknown/u);
    expect(() => normalizeCommandIdentity({ ...identity, variant: undefined })).toThrow();
  });

  it('parses and expands the only placeholder grammar with normalized references', () => {
    const input = 'Run `{{aw.command:tools/check}}`\n{{aw.command:tools/check/fast}} wait';
    expect(parseManagedCommandPlaceholders(input).map((entry) => entry.reference.variant)).toEqual(['default', 'fast']);
    expect(replaceManagedCommandPlaceholders(input, () => getPluginCommandId(identity))).toContain(`aw command run ${getPluginCommandId(identity)} --`);
    for (const value of ['{{aw.command:tools}}', '{{aw.command:tools/check', '{{aw.command:tools/check/}}']) expect(() => parseManagedCommandPlaceholders(value)).toThrow(/commandReferenceInvalid/u);
  });

  it('requires a real producer file and rejects symlink entries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-core-command-'));
    try {
      const entry = normalizeCommandDefinition({ key: 'check', runner: 'node', entry: 'check.mjs' });
      await fs.writeFile(path.join(root, 'check.mjs'), '');
      await expect(validateCommandEntryFiles(root, [entry])).resolves.toBeUndefined();
      await fs.unlink(path.join(root, 'check.mjs'));
      await fs.symlink('missing.mjs', path.join(root, 'check.mjs'));
      await expect(validateCommandEntryFiles(root, [entry])).rejects.toThrow(/without links/u);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('rejects dependency trees and reserved owner evidence from command package inputs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-core-command-source-'));
    try {
      const normalized = validatePluginManifest(root, manifest({ managedCommands: { packages, sets: [] } }));
      await fs.mkdir(path.join(root, 'tools'));
      await expect(validateManagedCommandSources(root, normalized)).resolves.toBeUndefined();
      await fs.writeFile(path.join(root, 'tools', '.agent-workflows-owner.json'), '{}');
      await expect(validateManagedCommandSources(root, normalized)).rejects.toThrow(/protected/u);
      await fs.unlink(path.join(root, 'tools', '.agent-workflows-owner.json'));
      await fs.mkdir(path.join(root, 'tools', 'node_modules'));
      await expect(validateManagedCommandSources(root, normalized)).rejects.toThrow(/protected/u);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
