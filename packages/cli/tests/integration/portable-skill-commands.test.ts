import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/index.js';
import { setPortableCommandTestHooksForTests } from '../../src/portable/commands.js';
import { createCatalogManifestV7, createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function configurePortableCatalog(options: {
  targetCapabilities?: string[];
  dependencyCapability?: string;
  dependencySkill?: boolean;
} = {}): Promise<{
  cwd: string;
  env: NodeJS.ProcessEnv;
  sourceRoot: string;
  pluginRoot: string;
}> {
  const isolation = getCurrentSourceTestIsolation();
  const sourceRoot = path.join(isolation.layout.fixtureCwd, 'portable-source');
  const configureManifest = (manifest: Parameters<NonNullable<Parameters<typeof createCatalogSnapshotFixture>[4]>>[0]) => {
    manifest.platforms = ['cursor'];
    manifest.skills = './skills';
    manifest.extensions = undefined;
  };
  if (options.dependencyCapability || options.dependencySkill) {
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      {
        name: 'portable',
        dependencies: ['future'],
        requiredCapabilities: options.targetCapabilities,
        configureManifest,
      },
      {
        name: 'future',
        requiredCapabilities: options.dependencyCapability ? [options.dependencyCapability] : [],
        configureManifest,
      },
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
  const writeSkills = async (pluginName: string, names: string[]): Promise<void> => {
    const root = path.join(sourceRoot, 'plugins', pluginName);
    const plugin = await readPluginManifest(root, { mode: 'bundle' });
    const receipt = createAwPluginRequirementsReceipt(
      { name: plugin.manifest.name, version: plugin.manifest.version },
      plugin.manifest.requires?.aw.capabilities ?? [],
    );
    for (const name of names) {
      const skillRoot = path.join(root, 'cursor', 'skills', name);
      await fs.outputFile(
        path.join(skillRoot, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name} description\n---\nBody.\n`,
      );
      await fs.outputFile(path.join(skillRoot, 'README.md'), `# ${name}\n`);
      await fs.outputJson(path.join(skillRoot, 'aw-plugin-requirements.json'), receipt, { spaces: 2 });
    }
  };
  await writeSkills('portable', ['alpha', 'beta']);
  if (options.dependencySkill) await writeSkills('future', ['dependency-skill']);
  const pluginNames = options.dependencyCapability || options.dependencySkill
    ? ['future', 'portable']
    : ['portable'];
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

// Test Value Gate: public materialization must preserve safe output ownership and immutable source boundaries.
describe('portable Skill export CLI', () => {
  afterEach(() => { setPortableCommandTestHooksForTests(undefined); vi.restoreAllMocks(); });

  it.each([undefined, 'agent-skills', 'claude-code', 'gemini', 'codex', 'claude'])(
    'rejects missing or invalid Portable platform %s before touching output', async (platform) => {
      const isolation = getCurrentSourceTestIsolation();
      const captured = createCapturedCliIo();
      const out = path.join(isolation.layout.fixtureCwd, 'must-stay-absent');
      const code = await runCli(['dev', 'skill', 'export', 'missing/plugin', '--scope', 'user', '--out', out,
        ...(platform === undefined ? [] : ['--platform', platform]), '--json'],
        { cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false, io: captured.io });
      expect(code).toBe(2);
      expect(JSON.parse(captured.readStdout())).toMatchObject({
        schemaVersion: 1,
        status: 'failed',
        diagnostics: [{ code: platform === undefined ? 'invalidArguments' : 'invalidOptionValue' }],
        data: {}
      });
      expect(await fs.pathExists(out)).toBe(false);
    });

  it('materializes a filtered tree at a long path and safely replaces matching marked output', async () => {
    // Test Value Gate: real staging and replacement must work beyond Windows MAX_PATH.
    const fixture = await configurePortableCatalog({ dependencySkill: true });
    const out = path.join(fixture.cwd, 'long-output-parent'.repeat(6), 'a'.repeat(64), 'b'.repeat(64));
    expect(out.length).toBeGreaterThan(260);
    const firstIo = createCapturedCliIo();
    expect(await runCli(
      [
        'dev', 'skill', 'export', '--platform', 'cursor', 'portable', '--scope', 'project', '--out', out,
        '--skill', 'alpha', 'dependency-skill', '--json',
      ],
      { cwd: fixture.cwd, env: fixture.env, io: firstIo.io },
    ), firstIo.readStdout()).toBe(0);
    const receipt = JSON.parse(firstIo.readStdout());
    expect(receipt.data.out).toBe(out);
    expect(receipt.data.selectedSkills).toMatchObject([
      { name: 'alpha', providerPluginId: 'local/portable' },
      { name: 'dependency-skill', providerPluginId: 'local/future' },
    ]);
    expect(receipt.data.sourceBindingPath).toBe(path.join(receipt.data.out, 'aw-source-binding.json'));
    await expect(fs.pathExists(path.join(out, 'skills', 'alpha', 'SKILL.md'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(out, 'skills', 'dependency-skill', 'SKILL.md'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(out, 'skills', 'beta'))).resolves.toBe(false);
    expect(await fs.readJson(path.join(out, '.aw-materialization.json'))).toMatchObject({
      schemaVersion: 1,
      plugin: { id: 'local/portable', version: '1.0.0' },
      scope: 'project',
    });
    await expect(fs.readJson(receipt.data.sourceBindingPath)).resolves.toMatchObject({
      schemaVersion: 2,
      kind: 'aw-source-binding',
      source: {
        kind: 'catalog-snapshot',
        sourceId: 'local',
        snapshotDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        workspaceIdentity: expect.any(String),
        workspaceSourceIdentity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
      subject: { plugin: 'portable' },
      profile: { kind: 'portable', id: 'cursor-project', platform: 'cursor', scope: 'project' },
      artifacts: [
        {
          kind: 'portable-skill', plugin: 'portable', skill: 'alpha', path: 'skills/alpha',
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
        {
          kind: 'portable-skill', plugin: 'future', skill: 'dependency-skill',
          path: 'skills/dependency-skill',
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
      ],
    });

    const unknownIo = createCapturedCliIo();
    expect(await runCli(
      ['dev', 'skill', 'export', '--platform', 'cursor', 'portable', '--scope', 'project', '--out', path.join(fixture.cwd, 'unknown-output'), '--skill', 'unknown', '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: unknownIo.io },
    )).toBe(1);
    expect(JSON.parse(unknownIo.readStdout())).toMatchObject({
      schemaVersion: 1,
      diagnostics: [{ code: 'portableNoSkillsSelected' }],
      data: {}
    });

    const secondIo = createCapturedCliIo();
    expect(await runCli(
      ['dev', 'skill', 'export', '--platform', 'cursor', 'portable', '--scope', 'project', '--out', out, '--skill', 'beta', '--json'],
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
      ['dev', 'skill', 'export', '--platform', 'cursor', 'portable', '--scope', 'project', '--out', path.join(fixture.cwd, 'future-output'), '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: io.io },
    )).toBe(3);
    expect(JSON.parse(io.readStdout())).toMatchObject({
      schemaVersion: 1,
      diagnostics: [{
        code: 'awCapabilityUnsupported',
        subject: { pluginId: 'local/portable' },
      }],
      data: { compatibility: { missingCapabilities: ['aw.future-portable.v1'], availableCapabilities: expect.arrayContaining(['aw.catalog-snapshot.v7']) } }
    });
  });

  it('preserves transitive dependency capability diagnostics in materialize JSON', async () => {
    const fixture = await configurePortableCatalog({
      dependencyCapability: 'aw.future-dependency.v1',
    });
    const io = createCapturedCliIo();
    expect(await runCli(
      ['dev', 'skill', 'export', '--platform', 'cursor', 'portable', '--scope', 'project', '--out', path.join(fixture.cwd, 'future-dependency-output'), '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: io.io },
    )).toBe(3);
    expect(JSON.parse(io.readStdout())).toMatchObject({
      schemaVersion: 1,
      diagnostics: [{
        code: 'awCapabilityUnsupported',
        subject: { pluginId: 'local/future' },
      }],
      data: { compatibility: { missingCapabilities: ['aw.future-dependency.v1'], availableCapabilities: expect.arrayContaining(['aw.catalog-snapshot.v7']) } }
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
        ['dev', 'skill', 'export', '--platform', 'cursor', 'portable', '--scope', 'project', '--out', target, '--json'],
        { cwd: fixture.cwd, env: fixture.env, io: io.io },
      )).toBe(3);
      expect(JSON.parse(io.readStdout())).toMatchObject({
        schemaVersion: 1,
        diagnostics: [{ code: 'portableOutputConflict' }],
        data: {}
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
      CLAUDE_CONFIG_DIR: claudeHome,
    };
    delete env.CODEX_HOME;

    for (const target of [codexHome, claudeHome]) {
      const io = createCapturedCliIo();
      expect(await runCli(
        ['dev', 'skill', 'export', '--platform', 'cursor', 'portable', '--scope', 'project', '--out', target, '--json'],
        { cwd: fixture.cwd, env, io: io.io },
      )).toBe(3);
      expect(JSON.parse(io.readStdout())).toMatchObject({
        schemaVersion: 1,
        diagnostics: [{ code: 'portableOutputConflict' }],
        data: {}
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
      ['dev', 'skill', 'export', '--platform', 'cursor', 'portable', '--scope', 'project', '--out', target, '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: firstIo.io },
    )).toBe(0);
    const markerPath = path.join(target, '.aw-materialization.json');
    const marker = await fs.readJson(markerPath);
    marker.plugin.sourceIdentity = 'stale-source-identity';
    await fs.writeJson(markerPath, marker, { spaces: 2 });
    await fs.outputFile(path.join(target, 'old-sentinel.txt'), 'old-output\n');

    const secondIo = createCapturedCliIo();
    expect(await runCli(
      ['dev', 'skill', 'export', '--platform', 'cursor', 'local/portable', '--scope', 'project', '--out', target, '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: secondIo.io },
    )).toBe(3);
    expect(JSON.parse(secondIo.readStdout())).toMatchObject({
      schemaVersion: 1,
      diagnostics: [{ code: 'portableOutputConflict' }],
      data: {}
    });
    await expect(fs.readFile(path.join(target, 'old-sentinel.txt'), 'utf8')).resolves.toBe('old-output\n');
    expect((await fs.readJson(markerPath)).plugin.sourceIdentity).toBe('stale-source-identity');
  });

  it('revalidates a renamed output and preserves a replacement owned by another plugin', async () => {
    const fixture = await configurePortableCatalog();
    const target = path.join(fixture.cwd, 'raced-output');
    const firstIo = createCapturedCliIo();
    expect(await runCli(
      ['dev', 'skill', 'export', '--platform', 'cursor', 'portable', '--scope', 'project', '--out', target, '--json'],
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
      ['dev', 'skill', 'export', '--platform', 'cursor', 'portable', '--scope', 'project', '--out', target, '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: secondIo.io },
    )).toBe(3);
    expect(JSON.parse(secondIo.readStdout())).toMatchObject({
      schemaVersion: 1,
      diagnostics: [{ code: 'portableOutputConflict' }],
      data: {}
    });
    await expect(fs.readFile(path.join(target, 'foreign.txt'), 'utf8')).resolves.toBe('preserve me');
    await expect(fs.readJson(path.join(target, '.aw-materialization.json')))
      .resolves.toMatchObject({ plugin: { id: 'local/other-plugin' } });
  });

  it('does not publish a staged output after the validated Catalog snapshot changes', async () => {
    const fixture = await configurePortableCatalog();
    const target = path.join(fixture.cwd, 'changed-source-output');
    const state = await readCatalogGenerationState(fixture.env);
    const active = state.sources.local!.active!;
    const location = resolveCatalogStoreLocation({
      logicalIdentity: active.logicalIdentity,
      snapshotDigest: active.snapshotDigest,
      env: fixture.env,
    });
    setPortableCommandTestHooksForTests({
      beforeMaterializeOutputCommit: async () => fs.appendFile(
        path.join(location.snapshotRoot, 'plugins', 'portable', 'README.md'),
        '\nchanged while staged\n',
      ),
    });
    const io = createCapturedCliIo();
    expect(await runCli(
      ['dev', 'skill', 'export', '--platform', 'cursor', 'portable', '--scope', 'project', '--out', target, '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: io.io },
    )).toBe(1);
    await expect(fs.pathExists(target)).resolves.toBe(false);
  });
});
