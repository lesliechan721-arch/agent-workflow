import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import type { GeneratedArtifact, PluginManifestSource, PluginMeta } from '../../src/types.js';
import {
  LIFECYCLE_ACTIVE_METADATA_FILE,
  LifecycleActiveSnapshotError,
  discardLifecycleActiveSnapshot,
  prepareLifecycleActiveSnapshot as prepareLifecycleActiveSnapshotWithLoader,
  promoteLifecycleActiveSnapshot,
  readLifecycleActiveSnapshot,
  removeLifecycleActiveSnapshot,
  resolveLifecycleActiveTarget,
  restoreLifecycleActiveScriptInputs,
  setLifecycleActiveBeforePruneForTests,
} from '../../src/utils/lifecycle-active-store.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const loadPlugin = async (bundleRoot: string, manifestPath: string): Promise<PluginMeta> => {
  const plugin = await readPluginManifest(bundleRoot, { mode: 'bundle' });
  if (path.resolve(plugin.manifestPath) !== path.resolve(manifestPath)) {
    throw new Error('Formal loader manifest path mismatch.');
  }
  return plugin;
};

function prepareLifecycleActiveSnapshot(
  options: Omit<Parameters<typeof prepareLifecycleActiveSnapshotWithLoader>[0], 'loadPlugin'> & {
    loadPlugin?: typeof loadPlugin;
  },
) {
  return prepareLifecycleActiveSnapshotWithLoader({ ...options, loadPlugin: options.loadPlugin ?? loadPlugin });
}

function createManifest(options: {
  version?: string;
  events?: Array<'install' | 'upgrade' | 'uninstall'>;
} = {}): PluginManifestSource {
  const lifecycle = Object.fromEntries((options.events ?? ['uninstall']).map((event) => [
    event,
    {
      default: {
        runner: 'node',
        path: `./scripts/${event}.mjs`,
      },
    },
  ]));
  return {
    name: 'active-plugin',
    version: options.version ?? '1.0.0',
    description: 'Lifecycle active store fixture',
    compatibility: { aw: { minVersion: '0.1.0' } },
    marketplace: {
      category: 'test',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
    },
    scripts: {
      lifecycle,
    },
    config: {
      schema: {
        token: {
          type: 'string',
          sensitive: true,
        },
      },
    },
  };
}

async function writePlugin(options: {
  root: string;
  version?: string;
  events?: Array<'install' | 'upgrade' | 'uninstall'>;
  marker?: string;
}): Promise<PluginMeta> {
  const manifest = createManifest(options);
  const pluginRoot = path.join(options.root, `plugin-${manifest.version}`);
  await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest, { spaces: 2 });
  for (const event of options.events ?? ['uninstall']) {
    await fs.outputFile(
      path.join(pluginRoot, 'scripts', `${event}.mjs`),
      `export default ${JSON.stringify(`${options.marker ?? manifest.version}:${event}`)};\n`,
    );
  }
  await fs.outputFile(path.join(pluginRoot, 'runtime', 'helper.mjs'), 'export const helper = true;\n');
  return readPluginManifest(pluginRoot, { mode: 'bundle' });
}

async function createRepo(name: string): Promise<string> {
  const root = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
  await fs.ensureDir(path.join(root, '.git'));
  return root;
}

function targetOptions(cwd: string, scope: 'user' | 'project' = 'user') {
  return {
    pluginName: 'active-plugin',
    platform: 'codex' as const,
    scope,
    cwd,
    env: process.env,
    loadPlugin,
  };
}

async function stageAndPromote(options: {
  plugin: PluginMeta;
  cwd: string;
  scope?: 'user' | 'project';
  artifacts?: GeneratedArtifact[];
}) {
  const prepared = await prepareLifecycleActiveSnapshot({
    plugin: options.plugin,
    platform: 'codex',
    scope: options.scope ?? 'user',
    cwd: options.cwd,
    artifacts: options.artifacts,
    env: process.env,
    loadPlugin,
  });
  expect(prepared.status).toBe('staged');
  if (prepared.status !== 'staged') {
    throw new Error('Expected lifecycle active staging.');
  }
  const active = await promoteLifecycleActiveSnapshot(prepared);
  expect(active).not.toBeNull();
  return active!;
}

async function editMetadata(
  activeRoot: string,
  edit: (metadata: Record<string, unknown>) => void,
): Promise<void> {
  const metadataPath = path.join(activeRoot, LIFECYCLE_ACTIVE_METADATA_FILE);
  const metadata = await fs.readJson(metadataPath) as Record<string, unknown>;
  edit(metadata);
  await fs.writeJson(metadataPath, metadata, { spaces: 2 });
}

describe('lifecycle active store', () => {
  it('uses one fixed user location and isolates canonical project roots', async () => {
    const repoA = await createRepo('repo-a');
    const nestedA = path.join(repoA, 'packages', 'app');
    const repoB = await createRepo('repo-b');
    await fs.ensureDir(nestedA);

    const userA = await resolveLifecycleActiveTarget(targetOptions(repoA));
    const userB = await resolveLifecycleActiveTarget(targetOptions(repoB));
    const projectA = await resolveLifecycleActiveTarget(targetOptions(repoA, 'project'));
    const nestedProjectA = await resolveLifecycleActiveTarget(targetOptions(nestedA, 'project'));
    const projectB = await resolveLifecycleActiveTarget(targetOptions(repoB, 'project'));

    expect(userA.locationKey).toBe('user');
    expect(userB.targetRoot).toBe(userA.targetRoot);
    expect(projectA.projectKey).toBe(await fs.realpath(repoA));
    expect(nestedProjectA.targetRoot).toBe(projectA.targetRoot);
    expect(projectB.targetRoot).not.toBe(projectA.targetRoot);
    expect(path.relative(projectA.awHome, projectA.targetRoot)).toMatch(
      /^lifecycle-active\/codex\/project\/project-[^/]+\/active-plugin$/,
    );
  });

  it.each(['EPERM', 'EBUSY', 'EMFILE'])('propagates project realpath %s instead of changing its location key', async (code) => {
    const repo = await createRepo(`project-realpath-${code}`);
    const failure = Object.assign(new Error(`injected project realpath ${code}`), { code });
    const originalRealpath = fs.realpath.bind(fs);
    vi.spyOn(fs, 'realpath').mockImplementation(async (candidate) => {
      if (path.resolve(String(candidate)) === path.resolve(repo)) throw failure;
      return originalRealpath(candidate);
    });

    await expect(resolveLifecycleActiveTarget(targetOptions(repo, 'project'))).rejects.toBe(failure);
  });

  it('does not stage install-only or upgrade-only bundles and removes an older active on promote', async () => {
    const repo = await createRepo('repo');
    const root = getCurrentSourceTestIsolation().layout.fixtureCwd;
    const uninstallPlugin = await writePlugin({ root, version: '1.0.0', events: ['uninstall'] });
    await stageAndPromote({ plugin: uninstallPlugin, cwd: repo });

    const installOnly = await writePlugin({ root, version: '2.0.0', events: ['install', 'upgrade'] });
    const prepared = await prepareLifecycleActiveSnapshot({
      plugin: installOnly,
      platform: 'codex',
      scope: 'user',
      cwd: repo,
      env: process.env,
      loadPlugin,
    });
    expect(prepared.status).toBe('not-required');
    await expect(promoteLifecycleActiveSnapshot(prepared)).resolves.toBeNull();
    await expect(readLifecycleActiveSnapshot(targetOptions(repo))).resolves.toBeNull();
  });

  it('stages, promotes, reads, restores context inputs, and removes a full bundle closure', async () => {
    const repo = await createRepo('repo');
    const root = getCurrentSourceTestIsolation().layout.fixtureCwd;
    const plugin = await writePlugin({ root, events: ['install', 'uninstall'] });
    const artifactPath = path.join(repo, '.codex', 'skills', 'fixture');
    const canonicalArtifactPath = path.join(await fs.realpath(repo), '.codex', 'skills', 'fixture');
    const prepared = await prepareLifecycleActiveSnapshot({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd: repo,
      artifacts: [{
        kind: 'skill',
        path: artifactPath,
        platform: 'codex',
        artifactKey: 'fixture',
        configDigest: 'must-not-persist',
        disabledReason: 'must-not-persist',
      }],
      env: process.env,
    });
    expect(prepared.status).toBe('staged');
    if (prepared.status !== 'staged') {
      throw new Error('Expected lifecycle active staging.');
    }
    expect(await fs.pathExists(path.join(prepared.stageRoot, 'runtime', 'helper.mjs'))).toBe(false);
    expect(await fs.pathExists(path.join(prepared.stageRoot, 'bundle', 'runtime', 'helper.mjs'))).toBe(true);

    const promoted = await promoteLifecycleActiveSnapshot(prepared);
    expect(promoted?.plugin.manifest.name).toBe('active-plugin');
    expect(promoted?.metadata.events).toEqual(['install', 'uninstall']);
    expect(promoted?.artifacts).toEqual([{
      kind: 'skill',
      path: canonicalArtifactPath,
      platform: 'codex',
      artifactKey: 'fixture',
    }]);
    expect(restoreLifecycleActiveScriptInputs(promoted!)).toEqual({
      currentPlugin: promoted!.plugin,
      artifacts: promoted!.artifacts,
    });
    expect(await fs.readJson(path.join(promoted!.activeRoot, LIFECYCLE_ACTIVE_METADATA_FILE))).toEqual(
      expect.not.objectContaining({ config: expect.anything() }),
    );
    expect(await fs.readFile(path.join(promoted!.activeRoot, LIFECYCLE_ACTIVE_METADATA_FILE), 'utf8'))
      .not.toContain('must-not-persist');

    await removeLifecycleActiveSnapshot(targetOptions(repo, 'project'));
    await expect(readLifecycleActiveSnapshot(targetOptions(repo, 'project'))).resolves.toBeNull();
  });

  it.each([
    ['schema', (metadata: Record<string, unknown>) => { metadata.schemaVersion = 2; }],
    ['fingerprint version', (metadata: Record<string, unknown>) => { metadata.fingerprintVersion = 1; }],
    ['manifest digest', (metadata: Record<string, unknown>) => { metadata.sourceManifestDigest = `sha256:${'0'.repeat(64)}`; }],
    ['bundle fingerprint', (metadata: Record<string, unknown>) => { metadata.bundleFingerprint = `sha256:${'0'.repeat(64)}`; }],
    ['plugin version', (metadata: Record<string, unknown>) => { metadata.pluginVersion = '9.9.9'; }],
    ['events', (metadata: Record<string, unknown>) => { metadata.events = ['uninstall', 'install']; }],
  ])('fails explicitly for corrupt %s metadata', async (_label, corrupt) => {
    const repo = await createRepo('repo');
    const plugin = await writePlugin({
      root: getCurrentSourceTestIsolation().layout.fixtureCwd,
      events: ['install', 'uninstall'],
    });
    const active = await stageAndPromote({ plugin, cwd: repo });
    await editMetadata(active.activeRoot, corrupt);

    await expect(readLifecycleActiveSnapshot(targetOptions(repo))).rejects.toBeInstanceOf(
      LifecycleActiveSnapshotError,
    );
  });

  it('does not skip an active snapshot when an existence probe hides an operational error', async () => {
    const repo = await createRepo('authoritative-read-repo');
    const plugin = await writePlugin({
      root: getCurrentSourceTestIsolation().layout.fixtureCwd,
      events: ['uninstall'],
    });
    const active = await stageAndPromote({ plugin, cwd: repo });
    const originalPathExists = fs.pathExists.bind(fs);
    const pathExists = vi.spyOn(fs, 'pathExists').mockImplementation(async (candidate) => {
      if (path.resolve(String(candidate)) === path.resolve(active.activeRoot)) return false;
      return originalPathExists(candidate);
    });

    try {
      await expect(readLifecycleActiveSnapshot(targetOptions(repo))).resolves.not.toBeNull();
    } finally {
      pathExists.mockRestore();
    }
  });

  it.each(['EPERM', 'EBUSY'])('propagates lifecycle active root %s instead of skipping uninstall state', async (code) => {
    const repo = await createRepo(`operational-read-${code}`);
    const plugin = await writePlugin({
      root: getCurrentSourceTestIsolation().layout.fixtureCwd,
      events: ['uninstall'],
    });
    const active = await stageAndPromote({ plugin, cwd: repo });
    const failure = Object.assign(new Error(`injected ${code}`), { code });
    const originalLstat = fs.lstat.bind(fs);
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async (candidate) => {
      if (path.resolve(String(candidate)) === path.resolve(active.activeRoot)) throw failure;
      return originalLstat(candidate);
    });

    try {
      await expect(readLifecycleActiveSnapshot(targetOptions(repo))).rejects.toBe(failure);
    } finally {
      lstat.mockRestore();
    }
  });

  it('detects bundle fingerprint drift', async () => {
    const repo = await createRepo('repo');
    const plugin = await writePlugin({ root: getCurrentSourceTestIsolation().layout.fixtureCwd });
    const active = await stageAndPromote({ plugin, cwd: repo });
    await fs.writeFile(path.join(active.bundleRoot, 'runtime', 'helper.mjs'), 'tampered\n');

    await expect(readLifecycleActiveSnapshot(targetOptions(repo))).rejects.toThrow(
      'bundle fingerprint',
    );
  });

  it('rejects symlinks and path traversal without following them', async () => {
    const repo = await createRepo('repo');
    const plugin = await writePlugin({ root: getCurrentSourceTestIsolation().layout.fixtureCwd });
    const active = await stageAndPromote({ plugin, cwd: repo });
    const helperPath = path.join(active.bundleRoot, 'runtime', 'helper.mjs');
    const outsidePath = path.join(repo, 'outside.mjs');
    await fs.writeFile(outsidePath, 'outside\n');
    await fs.remove(helperPath);
    await fs.symlink(outsidePath, helperPath);
    await expect(readLifecycleActiveSnapshot(targetOptions(repo))).rejects.toThrow('symbolic link');

    await fs.remove(helperPath);
    await fs.writeFile(helperPath, 'export const helper = true;\n');
    await editMetadata(active.activeRoot, (metadata) => {
      metadata.artifacts = [{
        kind: 'skill',
        platform: 'codex',
        artifactKey: 'escape',
        path: '../../outside',
        owner: {
          pluginName: 'active-plugin',
          platform: 'codex',
          scope: 'user',
          projectKey: null,
        },
      }];
    });
    await expect(readLifecycleActiveSnapshot(targetOptions(repo))).rejects.toThrow(
      /absolute normalized path|outside the lifecycle target output roots/,
    );
    await expect(resolveLifecycleActiveTarget({
      ...targetOptions(repo),
      pluginName: '../escape',
    })).rejects.toThrow('Invalid lifecycle active plugin name');

    await fs.remove(active.target.targetRoot);
    const outsideTarget = path.join(repo, 'outside-target');
    await fs.ensureDir(outsideTarget);
    await fs.ensureDir(path.dirname(active.target.targetRoot));
    await fs.symlink(outsideTarget, active.target.targetRoot);
    await expect(readLifecycleActiveSnapshot(targetOptions(repo))).rejects.toThrow('symbolic link');
  });

  it('removes active and staging paths idempotently without running scripts', async () => {
    const repo = await createRepo('repo');
    const plugin = await writePlugin({ root: getCurrentSourceTestIsolation().layout.fixtureCwd });
    const prepared = await prepareLifecycleActiveSnapshot({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: repo,
      env: process.env,
    });
    expect(prepared.status).toBe('staged');
    const target = prepared.target;

    await discardLifecycleActiveSnapshot(prepared);
    await removeLifecycleActiveSnapshot(targetOptions(repo));
    await removeLifecycleActiveSnapshot(targetOptions(repo));
    expect(await fs.pathExists(target.targetRoot)).toBe(false);
  });

  it('keeps the same plugin isolated across multiple projects', async () => {
    const repoA = await createRepo('repo-a');
    const repoB = await createRepo('repo-b');
    const plugin = await writePlugin({ root: getCurrentSourceTestIsolation().layout.fixtureCwd });
    const activeA = await stageAndPromote({ plugin, cwd: repoA, scope: 'project' });
    const activeB = await stageAndPromote({ plugin, cwd: repoB, scope: 'project' });

    expect(activeA.activeRoot).not.toBe(activeB.activeRoot);
    expect((await readLifecycleActiveSnapshot(targetOptions(repoA, 'project')))?.metadata.projectKey)
      .toBe(await fs.realpath(repoA));
    expect((await readLifecycleActiveSnapshot(targetOptions(repoB, 'project')))?.metadata.projectKey)
      .toBe(await fs.realpath(repoB));
  });

  it('replaces the old active bundle without retaining history', async () => {
    const repo = await createRepo('repo');
    const root = getCurrentSourceTestIsolation().layout.fixtureCwd;
    const first = await writePlugin({ root, version: '1.0.0', marker: 'old' });
    const oldActive = await stageAndPromote({ plugin: first, cwd: repo });
    const targetRoot = oldActive.target.targetRoot;
    const second = await writePlugin({ root, version: '2.0.0', marker: 'new' });
    const newActive = await stageAndPromote({ plugin: second, cwd: repo });

    expect(newActive.metadata.pluginVersion).toBe('2.0.0');
    expect(await fs.readFile(path.join(newActive.bundleRoot, 'scripts', 'uninstall.mjs'), 'utf8'))
      .toContain('new:uninstall');
    expect((await fs.readdir(targetRoot)).sort()).toEqual(['active']);
    expect(await fs.pathExists(path.join(targetRoot, 'history'))).toBe(false);
  });

  it('materializes an explicitly allowed pnpm package link as regular bundle bytes', async () => {
    const repo = await createRepo('repo');
    const root = getCurrentSourceTestIsolation().layout.fixtureCwd;
    const plugin = await writePlugin({ root });
    const closureRoot = path.join(
      plugin.rootDir,
      'scripts',
      'node_modules',
      '.pnpm',
      'fixture@1.0.0',
      'node_modules',
    );
    const packageRoot = path.join(closureRoot, 'fixture');
    await fs.outputJson(path.join(packageRoot, 'package.json'), { name: 'fixture', version: '1.0.0' });
    await fs.outputFile(path.join(packageRoot, 'index.js'), 'export const value = 1;\n');
    await fs.ensureDir(path.join(plugin.rootDir, 'scripts', 'node_modules'));
    await fs.symlink(
      path.join('.pnpm', 'fixture@1.0.0', 'node_modules', 'fixture'),
      path.join(plugin.rootDir, 'scripts', 'node_modules', 'fixture'),
    );

    const prepared = await prepareLifecycleActiveSnapshot({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: repo,
      env: process.env,
    });
    expect(prepared.status).toBe('staged');
    if (prepared.status !== 'staged') {
      throw new Error('Expected lifecycle active staging.');
    }
    const materializedPackage = path.join(
      prepared.stageRoot,
      'bundle',
      'scripts',
      'node_modules',
      'fixture',
    );
    expect((await fs.lstat(materializedPackage)).isDirectory()).toBe(true);
    expect((await fs.lstat(path.join(materializedPackage, 'index.js'))).isSymbolicLink()).toBe(false);
    await promoteLifecycleActiveSnapshot(prepared);
  });

  it('rejects bundle link cycles and permits a later valid prepare', async () => {
    const repo = await createRepo('repo');
    const plugin = await writePlugin({ root: getCurrentSourceTestIsolation().layout.fixtureCwd });
    const outside = path.join(repo, 'outside.js');
    await fs.writeFile(outside, 'outside\n');
    await fs.symlink(outside, path.join(plugin.rootDir, 'escape.js'));
    await expect(prepareLifecycleActiveSnapshot({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: repo,
      env: process.env,
    })).rejects.toThrow('allowed closure roots');
    await fs.remove(path.join(plugin.rootDir, 'escape.js'));

    await fs.symlink(plugin.rootDir, path.join(plugin.rootDir, 'cycle'));
    await expect(prepareLifecycleActiveSnapshot({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: repo,
      env: process.env,
    })).rejects.toThrow('directory link cycle');
    await fs.remove(path.join(plugin.rootDir, 'cycle'));

    const prepared = await prepareLifecycleActiveSnapshot({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: repo,
      env: process.env,
    });
    await discardLifecycleActiveSnapshot(prepared);
  });

  it('preserves complete non-sensitive artifact identity and detects metadata tampering', async () => {
    const repo = await createRepo('repo');
    const canonicalRepo = await fs.realpath(repo);
    const plugin = await writePlugin({ root: getCurrentSourceTestIsolation().layout.fixtureCwd });
    const artifactPath = path.join(repo, '.codex', 'agents', 'reviewer.toml');
    const configPath = path.join(repo, '.codex', 'config.toml');
    const active = await stageAndPromote({
      plugin,
      cwd: repo,
      scope: 'project',
      artifacts: [{
        path: artifactPath,
        paths: [configPath, artifactPath],
        kind: 'agent',
        platform: 'codex',
        artifactKey: 'reviewer',
        hookGroups: [{ event: 'SessionStart', matcher: 'review', command: 'node hook.mjs' }],
        id: 'reviewer-id',
        target: 'codex.agentRole',
        state: 'present',
        refreshKeys: ['model'],
        roleKey: 'reviewer',
        configDigest: 'must-not-persist',
        contentDigest: 'must-not-persist',
      }],
    });
    expect(active.artifacts).toEqual([{
      path: path.join(canonicalRepo, '.codex', 'agents', 'reviewer.toml'),
      paths: [
        path.join(canonicalRepo, '.codex', 'config.toml'),
        path.join(canonicalRepo, '.codex', 'agents', 'reviewer.toml'),
      ],
      kind: 'agent',
      platform: 'codex',
      artifactKey: 'reviewer',
      hookGroups: [{ event: 'SessionStart', matcher: 'review', command: 'node hook.mjs' }],
      id: 'reviewer-id',
      target: 'codex.agentRole',
      state: 'present',
      refreshKeys: ['model'],
      roleKey: 'reviewer',
    }]);
    const serialized = await fs.readFile(
      path.join(active.activeRoot, LIFECYCLE_ACTIVE_METADATA_FILE),
      'utf8',
    );
    expect(serialized).not.toContain('must-not-persist');

    await editMetadata(active.activeRoot, (metadata) => {
      const artifacts = metadata.artifacts as Array<Record<string, unknown>>;
      artifacts[0]!.roleKey = 'tampered';
    });
    await expect(readLifecycleActiveSnapshot(targetOptions(repo, 'project')))
      .rejects.toThrow('metadata integrity digest');
  });

  it('rejects artifact paths outside the target output roots and duplicate identities', async () => {
    const repo = await createRepo('repo');
    const plugin = await writePlugin({ root: getCurrentSourceTestIsolation().layout.fixtureCwd });
    await expect(prepareLifecycleActiveSnapshot({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd: repo,
      artifacts: [{
        path: path.join(path.dirname(await fs.realpath(repo)), 'outside', 'skill'),
        kind: 'skill',
        platform: 'codex',
        artifactKey: 'outside',
      }],
      env: process.env,
    })).rejects.toThrow('outside the lifecycle target output roots');

    const inside = path.join(repo, '.codex', 'skills');
    await expect(prepareLifecycleActiveSnapshot({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd: repo,
      artifacts: [
        { path: path.join(inside, 'one'), kind: 'skill', platform: 'codex', artifactKey: 'same' },
        { path: path.join(inside, 'two'), kind: 'skill', platform: 'codex', artifactKey: 'same' },
      ],
      env: process.env,
    })).rejects.toThrow('duplicates another lifecycle artifact identity');
  });

  it('rejects extra snapshot top-level entries', async () => {
    const repo = await createRepo('repo');
    const plugin = await writePlugin({ root: getCurrentSourceTestIsolation().layout.fixtureCwd });
    const active = await stageAndPromote({ plugin, cwd: repo });
    await fs.writeFile(path.join(active.activeRoot, 'extra'), 'unexpected\n');
    await expect(readLifecycleActiveSnapshot(targetOptions(repo))).rejects.toThrow(
      'only bundle and metadata.json',
    );
  });

  it('cleans valid orphan stages and makes discard idempotent before and after promote', async () => {
    const repo = await createRepo('repo');
    const plugin = await writePlugin({ root: getCurrentSourceTestIsolation().layout.fixtureCwd });
    const target = await resolveLifecycleActiveTarget(targetOptions(repo));
    const orphan = path.join(target.stagingRoot, `stage-${'a'.repeat(24)}`);
    await fs.outputFile(path.join(orphan, 'partial'), 'orphan\n');

    const discarded = await prepareLifecycleActiveSnapshot({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: repo,
      env: process.env,
    });
    expect(await fs.pathExists(orphan)).toBe(false);
    await discardLifecycleActiveSnapshot(discarded);
    await discardLifecycleActiveSnapshot(discarded);

    const promoted = await prepareLifecycleActiveSnapshot({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: repo,
      env: process.env,
    });
    await promoteLifecycleActiveSnapshot(promoted);
    await discardLifecycleActiveSnapshot(promoted);
    await discardLifecycleActiveSnapshot(promoted);
    await expect(readLifecycleActiveSnapshot(targetOptions(repo))).resolves.not.toBeNull();
  });

  it('fails closed on target ancestor symlinks for remove and not-required promotion', async () => {
    const repo = await createRepo('repo');
    const outside = path.join(repo, 'outside-target');
    const sentinel = path.join(outside, 'sentinel');
    await fs.outputFile(sentinel, 'keep\n');
    const target = await resolveLifecycleActiveTarget(targetOptions(repo));
    await fs.ensureDir(path.dirname(path.dirname(target.targetRoot)));
    await fs.symlink(outside, path.dirname(target.targetRoot));
    await expect(removeLifecycleActiveSnapshot(targetOptions(repo))).rejects.toThrow('symbolic link');
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('keep\n');

    await fs.remove(path.dirname(target.targetRoot));
    const installOnly = await writePlugin({
      root: getCurrentSourceTestIsolation().layout.fixtureCwd,
      version: '2.0.0',
      events: ['install'],
    });
    const prepared = await prepareLifecycleActiveSnapshot({
      plugin: installOnly,
      platform: 'codex',
      scope: 'user',
      cwd: repo,
      env: process.env,
    });
    await fs.remove(prepared.target.targetRoot);
    await fs.symlink(outside, prepared.target.targetRoot);
    await expect(promoteLifecycleActiveSnapshot(prepared)).rejects.toThrow('symbolic link');
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('keep\n');
  });

  it('keeps the newly validated active when staging prune housekeeping fails', async () => {
    const repo = await createRepo('repo');
    const root = getCurrentSourceTestIsolation().layout.fixtureCwd;
    await stageAndPromote({
      plugin: await writePlugin({ root, version: '1.0.0', marker: 'old' }),
      cwd: repo,
    });
    const prepared = await prepareLifecycleActiveSnapshot({
      plugin: await writePlugin({ root, version: '2.0.0', marker: 'new' }),
      platform: 'codex',
      scope: 'user',
      cwd: repo,
      env: process.env,
    });
    setLifecycleActiveBeforePruneForTests(async () => {
      throw new Error('simulated staging rmdir failure');
    });
    try {
      await expect(promoteLifecycleActiveSnapshot(prepared)).resolves.not.toBeNull();
    } finally {
      setLifecycleActiveBeforePruneForTests(undefined);
    }
    expect((await readLifecycleActiveSnapshot(targetOptions(repo)))?.metadata.pluginVersion).toBe('2.0.0');
  });

  it.each(['EBUSY', 'EPERM'])('keeps the newly validated active when old backup cleanup partially gets %s', async (code) => {
    const repo = await createRepo(`backup-cleanup-${code}`);
    const root = getCurrentSourceTestIsolation().layout.fixtureCwd;
    await stageAndPromote({
      plugin: await writePlugin({ root, version: '1.0.0', marker: 'old' }),
      cwd: repo,
    });
    const prepared = await prepareLifecycleActiveSnapshot({
      plugin: await writePlugin({ root, version: '2.0.0', marker: 'new' }),
      platform: 'codex',
      scope: 'user',
      cwd: repo,
      env: process.env,
    });
    const actualRemove = fs.remove.bind(fs);
    const privateCleanupSentinel = path.join(repo, 'private', 'backup-cleanup-sentinel');
    const remove = vi.spyOn(fs, 'remove').mockImplementation(async (candidate) => {
      if (path.basename(String(candidate)).startsWith('backup-')) {
        await actualRemove(path.join(String(candidate), LIFECYCLE_ACTIVE_METADATA_FILE));
        throw Object.assign(new Error(`${privateCleanupSentinel}: simulated backup cleanup ${code}`), { code });
      }
      return actualRemove(candidate);
    });
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    await expect(promoteLifecycleActiveSnapshot(prepared)).resolves.toMatchObject({
      metadata: { pluginVersion: '2.0.0' },
    });
    const backupPath = (await fs.readdir(prepared.target.targetRoot))
      .map((entry) => path.join(prepared.target.targetRoot, entry))
      .find((entry) => path.basename(entry).startsWith('backup-'));
    expect(backupPath).toBeDefined();
    await expect(fs.pathExists(path.join(prepared.target.activeRoot, LIFECYCLE_ACTIVE_METADATA_FILE)))
      .resolves.toBe(true);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(privateCleanupSentinel);
    expect(warning).toHaveBeenCalledWith(
      'Lifecycle active promote committed, but old backup cleanup failed.',
      expect.objectContaining({ code: 'AW_LIFECYCLE_HOUSEKEEPING_FAILED' }),
    );

    remove.mockRestore();
    warning.mockRestore();
    const nextPrepared = await prepareLifecycleActiveSnapshot({
      plugin: await writePlugin({ root, version: '3.0.0', marker: 'next' }),
      platform: 'codex',
      scope: 'user',
      cwd: repo,
      env: process.env,
    });
    await discardLifecycleActiveSnapshot(nextPrepared);
    await expect(fs.pathExists(backupPath!)).resolves.toBe(false);
    await expect(readLifecycleActiveSnapshot(targetOptions(repo))).resolves.toMatchObject({
      metadata: { pluginVersion: '2.0.0' },
    });
  });

  it('rejects project artifact paths whose existing ancestor symlink escapes the project', async () => {
    const repo = await createRepo('repo');
    const outside = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'outside-artifacts');
    await fs.ensureDir(outside);
    await fs.symlink(outside, path.join(repo, 'linked-output'));
    const plugin = await writePlugin({ root: getCurrentSourceTestIsolation().layout.fixtureCwd });
    await expect(prepareLifecycleActiveSnapshot({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd: repo,
      artifacts: [{
        path: path.join(repo, 'linked-output', 'skill'),
        kind: 'skill',
        platform: 'codex',
        artifactKey: 'linked',
      }],
      env: process.env,
    })).rejects.toThrow('outside the lifecycle target output roots');
  });

  it('rejects artifact paths that cross a dangling intermediate symlink', async () => {
    const repo = await createRepo('repo');
    await fs.symlink(path.join(repo, 'missing-target'), path.join(repo, 'dangling-output'));
    const plugin = await writePlugin({ root: getCurrentSourceTestIsolation().layout.fixtureCwd });
    await expect(prepareLifecycleActiveSnapshot({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd: repo,
      artifacts: [{
        path: path.join(repo, 'dangling-output', 'skill'),
        kind: 'skill',
        platform: 'codex',
        artifactKey: 'dangling',
      }],
      env: process.env,
    })).rejects.toThrow('dangling symbolic link');
  });

});
