import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/index.js';
import { materializePortableSkillsToDirectory, setPortableCommandTestHooksForTests } from '../../src/portable/commands.js';
import { createCatalogManifestV7, createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState, resolveCatalogGenerationStatePath } from '../../src/utils/catalog-generation-state.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { CatalogPreparationReadScope } from '../../src/utils/catalog-operation-context.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function configurePortableCatalog(options: {
  targetCapabilities?: string[];
  dependencyCapability?: string;
  dependencySkill?: boolean;
  unrelatedPlugin?: boolean;
  configurable?: boolean;
} = {}): Promise<{
  cwd: string;
  env: NodeJS.ProcessEnv;
  sourceRoot: string;
  pluginRoot: string;
}> {
  const isolation = getCurrentSourceTestIsolation();
  const sourceRoot = path.join(isolation.layout.fixtureCwd, 'portable-source');
  const configureManifest = (manifest: Parameters<NonNullable<Parameters<typeof createCatalogSnapshotFixture>[4]>>[0]) => {
    manifest.platforms = ['generic'];
    manifest.skills = './skills';
    manifest.extensions = undefined;
    if (options.configurable) manifest.config = { fields: { tone: { type: 'string', default: 'first' } } };
  };
  const hasDependency = Boolean(options.dependencyCapability || options.dependencySkill);
  if (hasDependency || options.unrelatedPlugin) {
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      {
        name: 'portable',
        ...(hasDependency ? { dependencies: ['future'] } : {}),
        requiredCapabilities: options.targetCapabilities,
        configureManifest,
      },
      ...(hasDependency ? [{
        name: 'future',
        requiredCapabilities: options.dependencyCapability ? [options.dependencyCapability] : [],
        configureManifest,
      }] : []),
      ...(options.unrelatedPlugin ? [{ name: 'unrelated', configureManifest }] : []),
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
      const skillRoot = path.join(root, 'generic', 'skills', name);
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
  const pluginNames = [
    ...(hasDependency ? ['future'] : []),
    'portable',
    ...(options.unrelatedPlugin ? ['unrelated'] : []),
  ];
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

  it.each([undefined, 'agent-skills', 'claude-code', 'unknown-platform', 'Generic', 'all'])(
    'rejects missing or invalid Portable platform %s before touching output', async (platform) => {
      const isolation = getCurrentSourceTestIsolation();
      const captured = createCapturedCliIo();
      const out = path.join(isolation.layout.fixtureCwd, 'must-stay-absent');
      const code = await runCli(['dev', 'skill', 'export', 'missing/plugin', '--scope', 'user', '--out', out,
        ...(platform === undefined ? [] : ['--platform', platform]), '--json'],
        { cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false, io: captured.io });
      expect(code).toBe(2);
      expect(JSON.parse(captured.readStdout())).toMatchObject({
        schemaVersion: 2,
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
        'dev', 'skill', 'export', '--platform', 'generic', 'portable', '--scope', 'project', '--out', out,
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
      profile: { kind: 'portable', id: 'generic-project', platform: 'generic', scope: 'project' },
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
      ['dev', 'skill', 'export', '--platform', 'generic', 'portable', '--scope', 'project', '--out', path.join(fixture.cwd, 'unknown-output'), '--skill', 'unknown', '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: unknownIo.io },
    )).toBe(1);
    expect(JSON.parse(unknownIo.readStdout())).toMatchObject({
      schemaVersion: 2,
      diagnostics: [{ code: 'portableNoSkillsSelected' }],
      data: {}
    });

    const secondIo = createCapturedCliIo();
    expect(await runCli(
      ['dev', 'skill', 'export', '--platform', 'generic', 'portable', '--scope', 'project', '--out', out, '--skill', 'beta', '--json'],
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
      ['dev', 'skill', 'export', '--platform', 'generic', 'portable', '--scope', 'project', '--out', path.join(fixture.cwd, 'future-output'), '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: io.io },
    )).toBe(3);
    expect(JSON.parse(io.readStdout())).toMatchObject({
      schemaVersion: 2,
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
      ['dev', 'skill', 'export', '--platform', 'generic', 'portable', '--scope', 'project', '--out', path.join(fixture.cwd, 'future-dependency-output'), '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: io.io },
    )).toBe(3);
    expect(JSON.parse(io.readStdout())).toMatchObject({
      schemaVersion: 2,
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
        ['dev', 'skill', 'export', '--platform', 'generic', 'portable', '--scope', 'project', '--out', target, '--json'],
        { cwd: fixture.cwd, env: fixture.env, io: io.io },
      )).toBe(3);
      expect(JSON.parse(io.readStdout())).toMatchObject({
        schemaVersion: 2,
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
        ['dev', 'skill', 'export', '--platform', 'generic', 'portable', '--scope', 'project', '--out', target, '--json'],
        { cwd: fixture.cwd, env, io: io.io },
      )).toBe(3);
      expect(JSON.parse(io.readStdout())).toMatchObject({
        schemaVersion: 2,
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
      ['dev', 'skill', 'export', '--platform', 'generic', 'portable', '--scope', 'project', '--out', target, '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: firstIo.io },
    )).toBe(0);
    const markerPath = path.join(target, '.aw-materialization.json');
    const marker = await fs.readJson(markerPath);
    marker.plugin.sourceIdentity = 'stale-source-identity';
    await fs.writeJson(markerPath, marker, { spaces: 2 });
    await fs.outputFile(path.join(target, 'old-sentinel.txt'), 'old-output\n');

    const secondIo = createCapturedCliIo();
    expect(await runCli(
      ['dev', 'skill', 'export', '--platform', 'generic', 'local/portable', '--scope', 'project', '--out', target, '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: secondIo.io },
    )).toBe(3);
    expect(JSON.parse(secondIo.readStdout())).toMatchObject({
      schemaVersion: 2,
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
      ['dev', 'skill', 'export', '--platform', 'generic', 'portable', '--scope', 'project', '--out', target, '--json'],
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
      ['dev', 'skill', 'export', '--platform', 'generic', 'portable', '--scope', 'project', '--out', target, '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: secondIo.io },
    )).toBe(3);
    expect(JSON.parse(secondIo.readStdout())).toMatchObject({
      schemaVersion: 2,
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
      ['dev', 'skill', 'export', '--platform', 'generic', 'portable', '--scope', 'project', '--out', target, '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: io.io },
    )).toBe(1);
    await expect(fs.pathExists(target)).resolves.toBe(false);
    expect(await fs.readdir(fixture.cwd)).not.toContainEqual(expect.stringContaining('.changed-source-output.aw-stage-'));
  });

  it('reports stale review and preserves old output when the healthy Active no longer contains the selected plugin', async () => {
    const fixture = await configurePortableCatalog({ unrelatedPlugin: true });
    const target = path.join(fixture.cwd, 'removed-plugin-output');
    const exportArgs = ['dev', 'skill', 'export', '--platform', 'generic', 'portable', '--scope', 'project', '--out', target, '--json'];
    const firstIo = createCapturedCliIo();
    expect(await runCli(exportArgs, { cwd: fixture.cwd, env: fixture.env, io: firstIo.io })).toBe(0);
    const oldMarker = await fs.readFile(path.join(target, '.aw-materialization.json'), 'utf8');
    const oldBinding = await fs.readFile(path.join(target, 'aw-source-binding.json'), 'utf8');
    const oldSkill = await fs.readFile(path.join(target, 'skills', 'beta', 'SKILL.md'), 'utf8');
    const originalActive = (await readCatalogGenerationState(fixture.env)).sources.local!.active!;
    setPortableCommandTestHooksForTests({
      beforeMaterializeOutputCommit: async () => {
        await fs.remove(fixture.pluginRoot);
        const manifestPath = path.join(fixture.sourceRoot, 'catalog-manifest.json');
        const manifest = await fs.readJson(manifestPath);
        manifest.catalogVersion = '1.0.1';
        manifest.entries = manifest.entries.filter((entry: { name: string }) => entry.name !== 'portable');
        await fs.writeJson(manifestPath, manifest);
        await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env: fixture.env, impactConfirmed: true });
      },
    });
    const secondIo = createCapturedCliIo();
    expect(await runCli([...exportArgs, '--skill', 'alpha'], {
      cwd: fixture.cwd, env: fixture.env, io: secondIo.io,
    }), secondIo.readStdout()).toBe(3);
    expect(JSON.parse(secondIo.readStdout())).toMatchObject({ diagnostics: [{ code: 'reviewStale' }] });
    const active = (await readCatalogGenerationState(fixture.env)).sources.local!.active!;
    expect(active.snapshotDigest).not.toBe(originalActive.snapshotDigest);
    expect(await fs.readFile(path.join(target, '.aw-materialization.json'), 'utf8')).toBe(oldMarker);
    expect(await fs.readFile(path.join(target, 'aw-source-binding.json'), 'utf8')).toBe(oldBinding);
    expect(await fs.readFile(path.join(target, 'skills', 'beta', 'SKILL.md'), 'utf8')).toBe(oldSkill);
    expect(await fs.readdir(fixture.cwd)).not.toContainEqual(expect.stringContaining('.removed-plugin-output.aw-stage-'));
  });

  it.each(['remove', 'remove-readd', 'rebind'])('reports stale review when a prepared qualified source is legally changed (%s)', async (change) => {
    const fixture = await configurePortableCatalog();
    const teamRoot = path.join(fixture.cwd, 'team-source');
    await fs.copy(fixture.sourceRoot, teamRoot);
    const runJson = async (args: string[], expectedCode: number) => {
      const io = createCapturedCliIo();
      expect(await runCli([...args, '--json'], { cwd: fixture.cwd, env: fixture.env, io: io.io }), io.readStdout()).toBe(expectedCode);
      return JSON.parse(io.readStdout());
    };
    await runJson(['source', 'add', 'team', '--path', teamRoot], 0);
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: fixture.env });
    const target = path.join(fixture.cwd, 'changed-qualified-source-output');
    const exportArgs = ['dev', 'skill', 'export', '--platform', 'generic', 'team/portable', '--scope', 'project', '--out', target];
    await runJson(exportArgs, 0);
    const outputFiles = ['.aw-materialization.json', 'aw-source-binding.json', 'skills/beta/SKILL.md'];
    const previous = await Promise.all(outputFiles.map((file) => fs.readFile(path.join(target, file), 'utf8')));
    setPortableCommandTestHooksForTests({
      beforeMaterializeOutputCommit: async () => {
        if (change !== 'rebind') {
          await runJson(['source', 'remove', 'team', '--yes'], 0);
          if (change === 'remove-readd') await runJson(['source', 'add', 'team', '--path', teamRoot], 0);
        } else {
          const reboundRoot = path.join(fixture.cwd, 'rebound-team-source');
          await fs.copy(teamRoot, reboundRoot);
          await runJson(['source', 'update', 'team', '--path', reboundRoot, '--yes'], 0);
        }
      },
    });
    expect(await runJson([...exportArgs, '--skill', 'alpha'], 3)).toMatchObject({ diagnostics: [{ code: 'reviewStale' }] });
    expect(await Promise.all(outputFiles.map((file) => fs.readFile(path.join(target, file), 'utf8')))).toEqual(previous);
    expect(await fs.readdir(fixture.cwd)).not.toContainEqual(expect.stringContaining('.changed-qualified-source-output.aw-stage-'));
    setPortableCommandTestHooksForTests(undefined);
    // Starting from the changed source is still a preparation failure, not a stale review.
    expect(await runJson([...exportArgs, '--skill', 'alpha'], 1)).toMatchObject({ diagnostics: [{ code: 'portableMaterializeFailed' }] });
  });

  it.each([
    { damage: 'invalid control', code: 'catalogGenerationStateInvalid' },
    { damage: 'inconsistent Active digest', code: 'catalogGenerationIdentityMismatch' },
  ])('preserves the original generation diagnosis for $damage at commit', async ({ damage, code }) => {
    const fixture = await configurePortableCatalog();
    const target = path.join(fixture.cwd, 'damaged-control-output');
    const statePath = resolveCatalogGenerationStatePath(fixture.env);
    const state = await readCatalogGenerationState(fixture.env);
    setPortableCommandTestHooksForTests({
      beforeMaterializeOutputCommit: async () => {
        if (damage === 'invalid control') {
          await fs.writeFile(statePath, 'invalid JSON');
        } else {
          state.sources.local!.active!.manifestDigest = `sha256:${'0'.repeat(64)}`;
          await fs.writeJson(statePath, state);
        }
      },
    });
    await expect(materializePortableSkillsToDirectory({
      selector: 'local/portable', platform: 'generic', scope: 'project', out: target,
      cwd: fixture.cwd, env: fixture.env, cliVersion: '1.0.0',
    })).rejects.toMatchObject({ code });
    await expect(fs.pathExists(target)).resolves.toBe(false);
    expect(await fs.readdir(fixture.cwd)).not.toContainEqual(expect.stringContaining('.damaged-control-output.aw-stage-'));
  });

  it.each([false, true])('does not publish a staged output after a dependency changes (read scope: %s)', async (scoped) => {
    const fixture = await configurePortableCatalog({ dependencySkill: true });
    const target = path.join(fixture.cwd, 'changed-dependency-output');
    const active = (await readCatalogGenerationState(fixture.env)).sources.local!.active!;
    const location = resolveCatalogStoreLocation({ ...active, env: fixture.env });
    setPortableCommandTestHooksForTests({
      beforeMaterializeOutputCommit: async () => fs.appendFile(
        path.join(location.snapshotRoot, 'plugins', 'future', 'README.md'), '\nchanged while staged\n'),
    });
    if (scoped) {
      const readScope = new CatalogPreparationReadScope({ env: fixture.env });
      const catalogOperationContext = await readScope.resolve({ sourceIds: ['local'] }, true);
      await expect(materializePortableSkillsToDirectory({
        selector: 'local/portable', platform: 'generic', scope: 'project', out: target,
        cwd: fixture.cwd, env: fixture.env, cliVersion: '1.0.0', catalogOperationContext,
      }, readScope)).rejects.toMatchObject({ code: 'catalogGenerationMetadataInvalid' });
    } else {
      const io = createCapturedCliIo();
      expect(await runCli(
        ['dev', 'skill', 'export', '--platform', 'generic', 'portable', '--scope', 'project', '--out', target, '--json'],
        { cwd: fixture.cwd, env: fixture.env, io: io.io },
      )).toBe(1);
    }
    await expect(fs.pathExists(target)).resolves.toBe(false);
    expect(await fs.readdir(fixture.cwd)).not.toContainEqual(expect.stringContaining('.changed-dependency-output.aw-stage-'));
  });

  it('rejects a staged output when effective plugin configuration changes', async () => {
    const fixture = await configurePortableCatalog({ configurable: true });
    const target = path.join(fixture.cwd, 'changed-config-output');
    const active = (await readCatalogGenerationState(fixture.env)).sources.local!.active!;
    setPortableCommandTestHooksForTests({
      beforeMaterializeOutputCommit: async () => {
        await writePluginConfigStore({
          sourceId: 'local', sourceIdentity: active.sourceIdentity, logicalIdentity: active.logicalIdentity,
          pluginName: 'portable', scope: 'user', cwd: fixture.cwd, env: fixture.env, values: { tone: 'second' },
        });
      },
    });
    await expect(materializePortableSkillsToDirectory({
      selector: 'local/portable', platform: 'generic', scope: 'project', out: target,
      cwd: fixture.cwd, env: fixture.env, cliVersion: '1.0.0',
    })).rejects.toMatchObject({ code: 'reviewStale' });
    await expect(fs.pathExists(target)).resolves.toBe(false);
    expect(await fs.readdir(fixture.cwd)).not.toContainEqual(expect.stringContaining('.changed-config-output.aw-stage-'));
  });

  it('does not revalidate an unrelated plugin at commit, but the next read window rejects its damage', async () => {
    const fixture = await configurePortableCatalog({ unrelatedPlugin: true });
    const target = path.join(fixture.cwd, 'unrelated-change-output');
    const active = (await readCatalogGenerationState(fixture.env)).sources.local!.active!;
    const location = resolveCatalogStoreLocation({ ...active, env: fixture.env });
    const unrelatedRoot = path.join(location.snapshotRoot, 'plugins', 'unrelated');
    const unrelatedReadme = path.join(unrelatedRoot, 'README.md');
    setPortableCommandTestHooksForTests({
      beforeMaterializeOutputCommit: async () => {
        await fs.appendFile(unrelatedReadme, '\nchanged while staged\n');
        vi.spyOn(fs, 'readFile');
        vi.spyOn(fs, 'readdir');
      },
    });
    const io = createCapturedCliIo();
    expect(await runCli(
      ['dev', 'skill', 'export', '--platform', 'generic', 'portable', '--scope', 'project', '--out', target, '--json'],
      { cwd: fixture.cwd, env: fixture.env, io: io.io },
    ), io.readStdout()).toBe(0);
    await expect(fs.readFile(path.join(target, 'skills', 'alpha', 'SKILL.md'), 'utf8')).resolves.toContain('Body.');
    expect(vi.mocked(fs.readFile).mock.calls.filter(([file]) => file === unrelatedReadme)).toHaveLength(0);
    expect(vi.mocked(fs.readdir).mock.calls.filter(([file]) => file === unrelatedRoot)).toHaveLength(0);
    const nextScope = new CatalogPreparationReadScope({ env: fixture.env });
    await expect(nextScope.resolve({ sourceIds: ['local'] }, true)).rejects.toMatchObject({
      code: 'catalogGenerationMetadataInvalid',
    });
    expect(vi.mocked(fs.readFile).mock.calls.filter(([file]) => file === unrelatedReadme).length).toBeGreaterThan(0);
    expect(vi.mocked(fs.readdir).mock.calls.filter(([file]) => file === unrelatedRoot).length).toBeGreaterThan(0);
  });
});
