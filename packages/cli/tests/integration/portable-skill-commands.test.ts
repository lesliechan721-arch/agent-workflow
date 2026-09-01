import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/index.js';
import {
  installPortableSkills,
  preparePortableInstall,
  setPortableCommandTestHooksForTests,
} from '../../src/portable/commands.js';
import { createCatalogManifestV7, createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import {
  createAwPluginRequirementsReceipt,
  readPluginManifest,
} from '../../src/utils/manifest.js';
import {
  createCatalogSnapshotFixture,
  createDependencyCatalogSnapshotFixture,
} from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function configurePortableCatalog(options: {
  targetCapabilities?: string[];
  dependencyCapability?: string;
} = {}): Promise<{
  cwd: string;
  env: NodeJS.ProcessEnv;
  sourceRoot: string;
  pluginRoot: string;
}> {
  const isolation = getCurrentSourceTestIsolation();
  const sourceRoot = path.join(isolation.layout.fixtureCwd, 'portable-source');
  const configureManifest = (manifest: Parameters<NonNullable<Parameters<typeof createCatalogSnapshotFixture>[4]>>[0]) => {
    manifest.extensions = { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] };
    manifest.distributions = { agentSkills: { skills: './agent-skills/skills' } };
  };
  if (options.dependencyCapability) {
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      {
        name: 'portable',
        dependencies: ['future'],
        requiredCapabilities: options.targetCapabilities,
        configureManifest,
      },
      { name: 'future', requiredCapabilities: [options.dependencyCapability] },
    ]);
  } else {
    await createCatalogSnapshotFixture(
      sourceRoot,
      'portable',
      options.targetCapabilities ?? [],
      'portable\n',
      configureManifest,
    );
  }
  const pluginRoot = path.join(sourceRoot, 'plugins', 'portable');
  const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
  const receipt = createAwPluginRequirementsReceipt(
    { name: plugin.manifest.name, version: plugin.manifest.version },
    plugin.manifest.requires?.aw.capabilities ?? [],
  );
  for (const name of ['alpha', 'beta']) {
    await fs.outputFile(
      path.join(pluginRoot, 'agent-skills', 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} description\n---\nBody.\n`,
    );
    await fs.outputFile(
      path.join(pluginRoot, 'agent-skills', 'skills', name, 'README.md'),
      `# ${name}\n`,
    );
    await fs.outputJson(
      path.join(pluginRoot, 'agent-skills', 'skills', name, 'aw-plugin-requirements.json'),
      receipt,
      { spaces: 2 },
    );
  }
  const pluginNames = options.dependencyCapability ? ['future', 'portable'] : ['portable'];
  const entries = await Promise.all(pluginNames.map(async (name) => {
    const root = path.join(sourceRoot, 'plugins', name);
    return createCatalogManifestV7Entry(await readPluginManifest(root, { mode: 'bundle' }), root);
  }));
  await fs.writeJson(path.join(sourceRoot, 'catalog-manifest.json'), createCatalogManifestV7({
    catalogVersion: '1.0.0',
    channel: 'latest',
    marketplace: {
      owner: { name: 'Fixture Owner', url: 'https://example.invalid/fixture' },
      interface: { displayName: 'Fixture Marketplace' },
    },
    schemaVersion: 7,
    requires: { aw: { capabilities: ['aw.catalog-snapshot.v7'] } },
    release: { state: 'development' },
    entries,
  }));
  const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }],
    },
    expectedDigest: snapshot.digest,
    env: isolation.env,
  });
  await syncCatalogSourceGeneration({
    sourceId: 'local', cliVersion: '1.0.0', env: isolation.env,
  });
  return { cwd: isolation.layout.fixtureCwd, env: isolation.env, sourceRoot, pluginRoot };
}

async function installFakeSkills(env: NodeJS.ProcessEnv, root: string, options: {
  before?: unknown;
  after?: unknown;
  addExit?: number;
  addWrites?: boolean;
  listExitAfterAdd?: number;
  version?: string;
} = {}): Promise<{ env: NodeJS.ProcessEnv; log: string }> {
  const bin = path.join(root, 'fake-skills-bin');
  const executable = path.join(bin, 'skills');
  const log = path.join(root, 'skills-calls.jsonl');
  const added = path.join(root, 'skills-added');
  const attempted = path.join(root, 'skills-attempted');
  await fs.ensureDir(bin);
  await fs.writeFile(executable, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.FAKE_SKILLS_LOG, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd()}) + '\\n');",
    "if (process.argv[2] === '--version') { console.log(process.env.FAKE_SKILLS_VERSION); process.exit(0); }",
    "if (process.argv[2] === 'add') { fs.writeFileSync(process.env.FAKE_SKILLS_ATTEMPTED, '1'); if (process.env.FAKE_SKILLS_ADD_WRITES === '1') fs.writeFileSync(process.env.FAKE_SKILLS_ADDED, '1'); if (Number(process.env.FAKE_SKILLS_ADD_EXIT || '0')) process.exit(Number(process.env.FAKE_SKILLS_ADD_EXIT)); fs.writeFileSync(process.env.FAKE_SKILLS_ADDED, '1'); process.exit(0); }",
    "if (process.argv[2] === 'list') { if (fs.existsSync(process.env.FAKE_SKILLS_ATTEMPTED) && Number(process.env.FAKE_SKILLS_LIST_EXIT_AFTER_ADD || '0')) process.exit(Number(process.env.FAKE_SKILLS_LIST_EXIT_AFTER_ADD)); console.log(fs.existsSync(process.env.FAKE_SKILLS_ADDED) ? process.env.FAKE_SKILLS_AFTER : process.env.FAKE_SKILLS_BEFORE); process.exit(0); }",
    'process.exit(2);',
  ].join('\n'));
  await fs.chmod(executable, 0o755);
  return {
    log,
    env: {
      ...env,
      PATH: `${bin}${path.delimiter}${env.PATH ?? ''}`,
      FAKE_SKILLS_LOG: log,
      FAKE_SKILLS_ADDED: added,
      FAKE_SKILLS_ATTEMPTED: attempted,
      FAKE_SKILLS_ADD_WRITES: options.addWrites ? '1' : '0',
      FAKE_SKILLS_LIST_EXIT_AFTER_ADD: String(options.listExitAfterAdd ?? 0),
      FAKE_SKILLS_VERSION: options.version ?? '1.5.23',
      FAKE_SKILLS_BEFORE: JSON.stringify(options.before ?? []),
      FAKE_SKILLS_AFTER: JSON.stringify(options.after ?? [
        { name: 'alpha', agents: ['Codex'], scope: 'project', path: '/agent/alpha' },
        { name: 'beta', agents: ['Codex'], scope: 'project', path: '/agent/beta' },
      ]),
      FAKE_SKILLS_ADD_EXIT: String(options.addExit ?? 0),
    },
  };
}

describe('portable skill public commands', () => {
  afterEach(() => {
    setPortableCommandTestHooksForTests(undefined);
    vi.restoreAllMocks();
  });

  it('rejects stale TUI evidence inside the mutation lock before skills add', async () => {
    const fixture = await configurePortableCatalog();
    const fake = await installFakeSkills(fixture.env, fixture.cwd);
    const prepared = await preparePortableInstall({
      selector: 'portable', scope: 'project', cwd: fixture.cwd, env: fake.env, cliVersion: '0.1.0',
    });
    await expect(installPortableSkills({
      selector: 'portable', scope: 'project', cwd: fixture.cwd, env: fake.env, cliVersion: '0.1.0',
      yes: true, expectedEvidenceDigest: `${prepared.evidenceDigest}:stale`,
    })).rejects.toMatchObject({ code: 'reviewStale' });
    expect((await fs.readFile(fake.log, 'utf8'))).not.toContain('"add"');
  });

  it('reports the real prepare, add, and verify stages around the fake Skills CLI', async () => {
    const fixture = await configurePortableCatalog();
    const fake = await installFakeSkills(fixture.env, fixture.cwd);
    const stages: string[] = [];
    const receipt = await installPortableSkills({
      selector: 'portable', scope: 'project', cwd: fixture.cwd, env: fake.env, cliVersion: '0.1.0',
      yes: true, onProgress: (stage) => { stages.push(stage); },
    });
    expect(receipt.status).toBe('succeeded');
    expect(stages).toEqual(['prepare', 'add', 'verify']);
  });

  it.each(['root symlink', 'direct file', 'direct symlink'] as const)(
    'keeps consuming the previous Active snapshot when an explicit sync rejects a %s',
    async (malformedNode) => {
      const fixture = await configurePortableCatalog();
      const skillsRoot = path.join(fixture.pluginRoot, 'agent-skills', 'skills');
      const externalRoot = path.join(fixture.cwd, 'catalog-private-content');
      await fs.outputFile(
        path.join(externalRoot, 'leaked-skill', 'SKILL.md'),
        '---\nname: leaked-skill\ndescription: must stay private\n---\nprivate-catalog-sentinel\n',
      );
      await fs.outputFile(path.join(externalRoot, 'leaked-skill', 'README.md'), '# Private\n');
      const plugin = await readPluginManifest(fixture.pluginRoot, { mode: 'bundle' });
      const entry = await createCatalogManifestV7Entry(plugin, fixture.pluginRoot);
      if (malformedNode === 'root symlink') {
        await fs.remove(skillsRoot);
        await fs.symlink(externalRoot, skillsRoot, 'dir');
      } else if (malformedNode === 'direct file') {
        await fs.outputFile(path.join(skillsRoot, 'invalid.txt'), 'private-catalog-sentinel\n');
      } else {
        await fs.symlink(
          path.join(externalRoot, 'leaked-skill'),
          path.join(skillsRoot, 'leaked-skill'),
          'dir',
        );
      }
      await fs.writeJson(path.join(fixture.sourceRoot, 'catalog-manifest.json'), createCatalogManifestV7({
        catalogVersion: '1.0.0',
        channel: 'latest',
        marketplace: {
          owner: { name: 'Fixture Owner', url: 'https://example.invalid/fixture' },
          interface: { displayName: 'Fixture Marketplace' },
        },
        schemaVersion: 7,
        requires: { aw: { capabilities: ['aw.catalog-snapshot.v7'] } },
        release: { state: 'development' },
        entries: [entry],
      }));
      await expect(syncCatalogSourceGeneration({
        sourceId: 'local', cliVersion: '1.0.0', env: fixture.env,
      })).rejects.toBeDefined();
      const fake = await installFakeSkills(fixture.env, fixture.cwd);
      const installIo = createCapturedCliIo();
      expect(await runCli(
        ['skill', 'install', 'portable', '--scope', 'project', '--yes', '--json'],
        { cwd: fixture.cwd, env: fake.env, io: installIo.io },
      )).toBe(0);
      expect(await fs.pathExists(fake.log)).toBe(true);

      const out = path.join(fixture.cwd, `malformed-${malformedNode.replace(' ', '-')}`);
      const materializeIo = createCapturedCliIo();
      expect(await runCli(
        ['skill', 'materialize', 'portable', '--scope', 'project', '--out', out, '--json'],
        { cwd: fixture.cwd, env: fixture.env, io: materializeIo.io },
      )).toBe(0);
      expect(await fs.pathExists(out)).toBe(true);
      expect(`${installIo.readStdout()}${installIo.readStderr()}${materializeIo.readStdout()}${materializeIo.readStderr()}`)
        .not.toContain('private-catalog-sentinel');
    },
  );

  it('publishes help and requires the scope and output parameters', async () => {
    const fixture = await configurePortableCatalog();
    const helpIo = createCapturedCliIo();
    expect(await runCli(['skill', 'install', '--help'], {
      cwd: fixture.cwd, env: fixture.env, io: helpIo.io,
    })).toBe(0);
    expect(helpIo.readStdout()).toContain('Usage: aw skill install');
    expect(helpIo.readStdout()).toContain('--scope <scope>');

    const installIo = createCapturedCliIo();
    expect(await runCli(['skill', 'install', 'portable'], {
      cwd: fixture.cwd, env: fixture.env, io: installIo.io,
    })).toBe(1);
    expect(installIo.readStderr()).toContain("required option '-s, --scope <scope>' not specified");

    const materializeIo = createCapturedCliIo();
    expect(await runCli(['skill', 'materialize', 'portable', '--scope', 'project'], {
      cwd: fixture.cwd, env: fixture.env, io: materializeIo.io,
    })).toBe(1);
    expect(materializeIo.readStderr()).toContain("required option '--out <dir>' not specified");
  });

  it('requires --yes with JSON and emits exactly one receipt without invoking skills', async () => {
    const fixture = await configurePortableCatalog();
    const io = createCapturedCliIo();
    const exitCode = await runCli(
      ['skill', 'install', 'portable', '--scope', 'project', '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: io.io },
    );
    expect(exitCode).toBe(1);
    expect(JSON.parse(io.readStdout())).toMatchObject({
      receiptSchemaVersion: 5,
      command: 'skill:install',
      failures: [{ code: 'confirmationRequired' }],
    });
  });

  it('confirms an interactive Review once and re-confirms changed execution evidence', async () => {
    const fixture = await configurePortableCatalog();
    const fake = await installFakeSkills(fixture.env, fixture.cwd);
    const io = createCapturedCliIo();
    const confirm = vi.fn(async () => ({ action: 'select' as const, cancelled: false, value: true }));
    expect(await runCli(
      ['skill', 'install', 'portable', '--scope', 'project'],
      {
        cwd: fixture.cwd,
        env: fake.env,
        io: io.io,
        interactive: true,
        prompt: { confirm },
      },
    )).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(1);

    const stale = await installFakeSkills(fixture.env, path.join(fixture.cwd, 'stale'));
    const staleIo = createCapturedCliIo();
    const staleConfirm = vi.fn(async () => {
      if (staleConfirm.mock.calls.length === 1) {
        stale.env.FAKE_SKILLS_VERSION = '1.5.24';
        return { action: 'select' as const, cancelled: false, value: true };
      }
      return { action: 'select' as const, cancelled: false, value: false };
    });
    expect(await runCli(
      ['skill', 'install', 'portable', '--scope', 'project'],
      {
        cwd: fixture.cwd,
        env: stale.env,
        io: staleIo.io,
        interactive: true,
        prompt: { confirm: staleConfirm },
      },
    )).toBe(1);
    expect(staleConfirm).toHaveBeenCalledTimes(2);
    expect(staleIo.readStderr()).toContain('reviewStale');
    expect((await fs.readFile(stale.log, 'utf8'))).not.toContain('"add"');
  });

  it('installs all candidates by default, reports collisions, and verifies automatic mode', async () => {
    const fixture = await configurePortableCatalog();
    const fake = await installFakeSkills(fixture.env, fixture.cwd, {
      before: [{ name: 'alpha', agents: ['Claude Code'], scope: 'project', path: '/old/alpha' }],
    });
    const io = createCapturedCliIo();
    const exitCode = await runCli(
      ['skill', 'install', 'portable', '--scope', 'project', '--yes', '--json'],
      { cwd: fixture.cwd, env: fake.env, io: io.io },
    );
    expect(exitCode, io.readStderr()).toBe(0);
    const receipt = JSON.parse(io.readStdout());
    expect(receipt).toMatchObject({
      receiptSchemaVersion: 5,
      ok: true,
      status: 'succeeded',
      agentMode: 'automatic',
      collisions: [{ name: 'alpha', agents: ['Claude Code'] }],
    });
    expect(io.readStdout()).not.toContain('/old/alpha');
    expect(receipt.selectedSkills.map((entry: { name: string }) => entry.name)).toEqual(['alpha', 'beta']);
    const calls = (await fs.readFile(fake.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.find((call) => call.args[0] === 'add').args.slice(0, 5)).toEqual([
      'add', expect.any(String), '--skill', 'alpha', 'beta',
    ]);
    expect(calls.find((call) => call.args[0] === 'add').cwd).toBe(await fs.realpath(fixture.cwd));
  });

  it('whitelists public list evidence in human output and JSON receipts', async () => {
    const fixture = await configurePortableCatalog();
    const unsafeRecord = {
      name: 'alpha',
      agents: ['Codex'],
      scope: 'project',
      path: '/tmp/aw-portable-operation-secret/materialized/skills/alpha',
      source: 'https://user:credential@example.invalid/private.git',
      sourceUrl: 'https://token@example.invalid/private.git',
      sourceType: 'git',
      unknownField: 'unknown-sensitive-value',
    };
    const human = await installFakeSkills(fixture.env, path.join(fixture.cwd, 'whitelist-human'), {
      before: [unsafeRecord],
      after: [unsafeRecord],
    });
    const humanIo = createCapturedCliIo();
    expect(await runCli(
      ['skill', 'install', 'portable', '--scope', 'project', '--skill', 'alpha', '--yes'],
      { cwd: fixture.cwd, env: human.env, io: humanIo.io },
    )).toBe(0);

    const json = await installFakeSkills(fixture.env, path.join(fixture.cwd, 'whitelist-json'), {
      before: [unsafeRecord],
      after: [unsafeRecord],
    });
    const jsonIo = createCapturedCliIo();
    expect(await runCli(
      ['skill', 'install', 'portable', '--scope', 'project', '--skill', 'alpha', '--yes', '--json'],
      { cwd: fixture.cwd, env: json.env, io: jsonIo.io },
    )).toBe(0);
    expect(JSON.parse(jsonIo.readStdout())).toMatchObject({
      collisions: [{ name: 'alpha', scope: 'project', agents: ['Codex'] }],
      verification: { records: [{ name: 'alpha', scope: 'project', agents: ['Codex'] }] },
    });
    const output = `${humanIo.readStdout()}\n${humanIo.readStderr()}\n${jsonIo.readStdout()}\n${jsonIo.readStderr()}`;
    for (const secret of [
      'aw-portable-operation-secret',
      'credential@example.invalid',
      'token@example.invalid',
      'unknown-sensitive-value',
      'sourceUrl',
      'sourceType',
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it('uses post-failure verification evidence without rollback or private upstream data', async () => {
    const fixture = await configurePortableCatalog();
    const partialRecord = {
      name: 'alpha', agents: ['Codex'], scope: 'user',
      path: '/private/upstream/materialized/alpha',
      sourceUrl: 'https://secret@example.invalid/private.git',
    };
    const failed = await installFakeSkills(fixture.env, fixture.cwd, {
      addExit: 7, addWrites: true, after: [partialRecord],
    });
    const failedIo = createCapturedCliIo();
    expect(await runCli(
      ['skill', 'install', 'portable', '--scope', 'user', '--yes', '--json'],
      { cwd: fixture.cwd, env: failed.env, io: failedIo.io },
    )).toBe(1);
    expect(JSON.parse(failedIo.readStdout())).toMatchObject({
      status: 'partial',
      verification: {
        records: [{ name: 'alpha', scope: 'user', agents: ['Codex'] }],
        missing: [{ skill: 'beta' }],
      },
      failures: [{ code: 'portableSkillsCliInstallFailed' }],
    });
    expect(`${failedIo.readStdout()}${failedIo.readStderr()}`).not.toMatch(/private\/upstream|secret@example/u);

    const allMissing = await installFakeSkills(fixture.env, path.join(fixture.cwd, 'all-missing'), {
      addExit: 7, after: [],
    });
    const allMissingIo = createCapturedCliIo();
    expect(await runCli(
      ['skill', 'install', 'portable', '--scope', 'project', '--yes', '--json'],
      { cwd: fixture.cwd, env: allMissing.env, io: allMissingIo.io },
    )).toBe(1);
    expect(JSON.parse(allMissingIo.readStdout())).toMatchObject({
      status: 'failed',
      verification: { records: [], missing: [{ skill: 'alpha' }, { skill: 'beta' }] },
      failures: [{ code: 'portableSkillsCliInstallFailed' }],
    });

    const unknown = await installFakeSkills(fixture.env, path.join(fixture.cwd, 'unknown'), {
      addExit: 7, listExitAfterAdd: 9,
    });
    const unknownIo = createCapturedCliIo();
    expect(await runCli(
      ['skill', 'install', 'portable', '--scope', 'project', '--yes', '--json'],
      { cwd: fixture.cwd, env: unknown.env, io: unknownIo.io },
    )).toBe(1);
    expect(JSON.parse(unknownIo.readStdout())).toMatchObject({
      status: 'partial',
      verification: { records: [], missing: [] },
      warnings: [expect.stringContaining('无法确认')],
      failures: [
        { code: 'portableSkillsCliInstallFailed' },
        { code: 'portableSkillsCliVerificationFailed' },
      ],
    });
    expect((await fs.readFile(unknown.log, 'utf8'))).not.toContain('remove');

    const partialRoot = path.join(fixture.cwd, 'partial');
    await fs.ensureDir(partialRoot);
    const partial = await installFakeSkills(fixture.env, partialRoot, { after: [] });
    const partialIo = createCapturedCliIo();
    expect(await runCli(
      ['skill', 'install', 'portable', '--scope', 'project', '--skill', 'alpha', '--yes', '--json'],
      { cwd: fixture.cwd, env: partial.env, io: partialIo.io },
    )).toBe(1);
    expect(JSON.parse(partialIo.readStdout())).toMatchObject({
      status: 'partial',
      failures: [{ code: 'portableSkillsCliVerificationFailed' }],
    });
    expect((await fs.readFile(partial.log, 'utf8'))).not.toContain('remove');
  });

  it.each([
    ['automatic', []],
    ['explicit multi-agent', ['codex', 'cursor']],
  ] as const)('reports successful add with failed verification as unknown for %s selection', async (
    _label,
    agents,
  ) => {
    const fixture = await configurePortableCatalog();
    const fake = await installFakeSkills(fixture.env, fixture.cwd, { listExitAfterAdd: 9 });
    const io = createCapturedCliIo();
    expect(await runCli([
      'skill', 'install', 'portable', '--scope', 'project', '--yes', '--json',
      ...(agents.length > 0 ? ['--agent', ...agents] : []),
    ], { cwd: fixture.cwd, env: fake.env, io: io.io })).toBe(1);

    const receipt = JSON.parse(io.readStdout());
    expect(receipt).toMatchObject({
      status: 'partial',
      verification: { records: [], missing: [] },
      warnings: [expect.stringContaining('无法确认')],
      failures: [{
        code: 'portableSkillsCliVerificationFailed',
        message: expect.stringContaining('unknown'),
      }],
    });
    expect(`${io.readStdout()}${io.readStderr()}`).not.toContain('目标缺失');
  });

  it('prints deduplicated safe recovery guidance for a non-JSON partial install', async () => {
    const fixture = await configurePortableCatalog();
    const fake = await installFakeSkills({
      ...fixture.env,
      PORTABLE_TOKEN: 'credential=top-secret',
      PRIVATE_SOURCE_URL: 'https://user:secret@example.test/private',
    }, fixture.cwd, { addExit: 7, addWrites: true, listExitAfterAdd: 9 });
    const io = createCapturedCliIo();
    expect(await runCli(
      ['skill', 'install', 'portable', '--scope', 'project', '--yes'],
      { cwd: fixture.cwd, env: fake.env, io: io.io },
    )).toBe(1);
    const output = io.readStderr();
    expect(output).toContain('警告：');
    expect(output).toContain('aw skill install');
    expect(output).toContain('skills remove');
    expect(output.match(/^恢复：/gmu)).toHaveLength(1);
    expect(output).not.toMatch(/top-secret|user:secret|example\.test|\/private/u);
  });

  it('materializes a filtered tree and safely replaces only matching marked output', async () => {
    const fixture = await configurePortableCatalog();
    const out = path.join(fixture.cwd, 'portable-output');
    const firstIo = createCapturedCliIo();
    expect(await runCli(
      ['skill', 'materialize', 'portable', '--scope', 'project', '--out', out, '--skill', 'alpha', '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: firstIo.io },
    ), firstIo.readStdout()).toBe(0);
    const receipt = JSON.parse(firstIo.readStdout());
    expect(receipt.selectedSkills).toMatchObject([{ name: 'alpha', providerPluginId: 'local/portable' }]);
    await expect(fs.pathExists(path.join(out, 'skills', 'alpha', 'SKILL.md'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(out, 'skills', 'beta'))).resolves.toBe(false);
    expect(await fs.readJson(path.join(out, '.aw-materialization.json'))).toMatchObject({
      schemaVersion: 1,
      plugin: { id: 'local/portable', version: '1.0.0' },
      scope: 'project',
    });

    const unknownIo = createCapturedCliIo();
    expect(await runCli(
      ['skill', 'materialize', 'portable', '--scope', 'project', '--out', path.join(fixture.cwd, 'unknown-output'), '--skill', 'unknown', '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: unknownIo.io },
    )).toBe(1);
    expect(JSON.parse(unknownIo.readStdout())).toMatchObject({
      errors: [{ code: 'portableNoSkillsSelected' }],
    });

    const secondIo = createCapturedCliIo();
    expect(await runCli(
      ['skill', 'materialize', 'portable', '--scope', 'project', '--out', out, '--skill', 'beta', '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: secondIo.io },
    )).toBe(0);
    await expect(fs.pathExists(path.join(out, 'skills', 'alpha'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(out, 'skills', 'beta', 'SKILL.md'))).resolves.toBe(true);
  });

  it('preserves target capability diagnostics in materialize JSON', async () => {
    const fixture = await configurePortableCatalog({
      targetCapabilities: ['aw.future-portable.v1'],
    });
    const io = createCapturedCliIo();
    expect(await runCli(
      ['skill', 'materialize', 'portable', '--scope', 'project', '--out', path.join(fixture.cwd, 'future-output'), '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: io.io },
    )).toBe(1);
    expect(JSON.parse(io.readStdout())).toMatchObject({
      errors: [{
        code: 'awCapabilityUnsupported',
        plugin: 'local/portable',
        missingCapabilities: ['aw.future-portable.v1'],
        availableCapabilities: expect.arrayContaining(['aw.catalog-snapshot.v7']),
      }],
    });
  });

  it('preserves transitive dependency capability diagnostics in materialize JSON', async () => {
    const fixture = await configurePortableCatalog({
      dependencyCapability: 'aw.future-dependency.v1',
    });
    const io = createCapturedCliIo();
    expect(await runCli(
      ['skill', 'materialize', 'portable', '--scope', 'project', '--out', path.join(fixture.cwd, 'future-dependency-output'), '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: io.io },
    )).toBe(1);
    expect(JSON.parse(io.readStdout())).toMatchObject({
      errors: [{
        code: 'awCapabilityUnsupported',
        plugin: 'local/future',
        missingCapabilities: ['aw.future-dependency.v1'],
        availableCapabilities: expect.arrayContaining(['aw.catalog-snapshot.v7']),
      }],
    });
  });

  it('rejects foreign, mismatched, and symlink output without changing the existing target', async () => {
    const fixture = await configurePortableCatalog();
    for (const [name, prepare] of [
      ['foreign', async (target: string) => fs.outputFile(path.join(target, 'keep.txt'), 'keep')],
      ['mismatch', async (target: string) => fs.outputJson(path.join(target, '.aw-materialization.json'), {
        schemaVersion: 1, plugin: { id: 'other/plugin' }, scope: 'project',
      })],
      ['symlink', async (target: string) => {
        const victim = path.join(fixture.cwd, 'victim');
        await fs.ensureDir(victim);
        await fs.symlink(victim, target);
      }],
    ] as const) {
      const target = path.join(fixture.cwd, name);
      await prepare(target);
      const io = createCapturedCliIo();
      expect(await runCli(
        ['skill', 'materialize', 'portable', '--scope', 'project', '--out', target, '--json'],
        { cwd: fixture.cwd, env: fixture.env, io: io.io },
      )).toBe(1);
      expect(JSON.parse(io.readStdout())).toMatchObject({
        errors: [{ code: 'portableOutputConflict' }],
      });
    }
    await expect(fs.readFile(path.join(fixture.cwd, 'foreign', 'keep.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('rejects default Codex and overridden Claude homes before writing existing or missing output', async () => {
    const fixture = await configurePortableCatalog();
    const userHome = path.join(fixture.cwd, 'isolated-user-home');
    const codexHome = path.join(userHome, '.codex');
    const claudeHome = path.join(fixture.cwd, 'isolated-claude-home');
    vi.spyOn(os, 'homedir').mockReturnValue(userHome);
    await fs.outputFile(path.join(codexHome, 'agent-owned.txt'), 'preserve these bytes\n');
    const originalCodexBytes = await fs.readFile(path.join(codexHome, 'agent-owned.txt'));
    const env: NodeJS.ProcessEnv = {
      ...fixture.env,
      AW_CLAUDE_HOME: claudeHome,
    };
    delete env.AW_CODEX_HOME;

    for (const target of [codexHome, claudeHome]) {
      const io = createCapturedCliIo();
      expect(await runCli(
        ['skill', 'materialize', 'portable', '--scope', 'project', '--out', target, '--json'],
        { cwd: fixture.cwd, env, io: io.io },
      )).toBe(1);
      expect(JSON.parse(io.readStdout())).toMatchObject({
        errors: [{ code: 'portableOutputConflict' }],
      });
    }

    await expect(fs.readFile(path.join(codexHome, 'agent-owned.txt'))).resolves.toEqual(originalCodexBytes);
    await expect(fs.pathExists(claudeHome)).resolves.toBe(false);
  });

  it('preserves an old materialization when its source identity no longer matches', async () => {
    const fixture = await configurePortableCatalog();
    const target = path.join(fixture.cwd, 'identity-output');
    const firstIo = createCapturedCliIo();
    expect(await runCli(
      ['skill', 'materialize', 'portable', '--scope', 'project', '--out', target, '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: firstIo.io },
    )).toBe(0);
    const markerPath = path.join(target, '.aw-materialization.json');
    const marker = await fs.readJson(markerPath);
    marker.plugin.sourceIdentity = 'stale-source-identity';
    await fs.writeJson(markerPath, marker, { spaces: 2 });
    await fs.outputFile(path.join(target, 'old-sentinel.txt'), 'old-output\n');

    const secondIo = createCapturedCliIo();
    expect(await runCli(
      ['skill', 'materialize', 'local/portable', '--scope', 'project', '--out', target, '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: secondIo.io },
    )).toBe(1);
    expect(JSON.parse(secondIo.readStdout())).toMatchObject({
      errors: [{ code: 'portableOutputConflict' }],
    });
    await expect(fs.readFile(path.join(target, 'old-sentinel.txt'), 'utf8')).resolves.toBe('old-output\n');
    expect((await fs.readJson(markerPath)).plugin.sourceIdentity).toBe('stale-source-identity');
  });

  it('revalidates a renamed output and preserves a replacement owned by another plugin', async () => {
    const fixture = await configurePortableCatalog();
    const target = path.join(fixture.cwd, 'raced-output');
    const firstIo = createCapturedCliIo();
    expect(await runCli(
      ['skill', 'materialize', 'portable', '--scope', 'project', '--out', target, '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: firstIo.io },
    )).toBe(0);
    const displaced = path.join(fixture.cwd, 'displaced-output');
    setPortableCommandTestHooksForTests({
      beforeMaterializeOutputCommit: async () => {
        await fs.rename(target, displaced);
        await fs.ensureDir(target);
        const marker = await fs.readJson(path.join(displaced, '.aw-materialization.json'));
        marker.plugin.id = 'local/other-plugin';
        await fs.writeJson(path.join(target, '.aw-materialization.json'), marker);
        await fs.writeFile(path.join(target, 'foreign.txt'), 'preserve me');
      },
    });
    const secondIo = createCapturedCliIo();
    expect(await runCli(
      ['skill', 'materialize', 'portable', '--scope', 'project', '--out', target, '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: secondIo.io },
    )).toBe(1);
    expect(JSON.parse(secondIo.readStdout())).toMatchObject({
      errors: [{ code: 'portableOutputConflict' }],
    });
    await expect(fs.readFile(path.join(target, 'foreign.txt'), 'utf8')).resolves.toBe('preserve me');
    await expect(fs.readJson(path.join(target, '.aw-materialization.json')))
      .resolves.toMatchObject({ plugin: { id: 'local/other-plugin' } });
  });
});
