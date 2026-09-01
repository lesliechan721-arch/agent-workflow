import {
  acquireBuildLock,
  afterEach,
  buildCacheContract,
  buildWithCache,
  computeBuildInputDigest,
  computeBuildOutputDigest,
  createBuildSnapshot,
  createDeferred,
  createRepo,
  describe,
  expect,
  fs,
  fsSync,
  inspectBuildCache,
  it,
  originalNpmExecPath,
  originalNpmUserAgent,
  os,
  path,
  pathToFileURL,
  resolvePnpmInvocation,
  tempDirs,
  vi,
  withBuildSnapshot,
  writeBuildOutputs,
  writeRequiredOutputs,
} from './build-cache.test-helper.js';
describe('build cache output binding', () => {
  it('rejects required and non-required CLI dist symlinks for builds and snapshots', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    const indexPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
    const referentPath = path.join(repoRoot, 'external-index.js');
    await fs.writeFile(referentPath, 'export const external = 1;\n');
    await fs.rm(indexPath);
    await fs.symlink(referentPath, indexPath);
    let buildCount = 0;
    const symlinkBuild = async () => {
      buildCount += 1;
      await writeRequiredOutputs(repoRoot, buildCount);
    };

    await expect(buildWithCache(repoRoot, { build: symlinkBuild }))
      .rejects.toThrow('Build output contains unsupported symlink packages/cli/dist/index.js');
    await fs.writeFile(referentPath, 'export const external = 2;\n');
    await expect(createBuildSnapshot(repoRoot, { build: symlinkBuild }))
      .rejects.toThrow('Build output contains unsupported symlink packages/cli/dist/index.js');
    expect(buildCount).toBe(2);

    await writeBuildOutputs(repoRoot, 3);
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot, 3) });
    const nonrequiredPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'src', 'nonrequired.js');
    await fs.rm(nonrequiredPath);
    await fs.symlink(referentPath, nonrequiredPath);
    await expect(buildWithCache(repoRoot, { build: () => writeRequiredOutputs(repoRoot, 4) }))
      .rejects.toThrow('Build output contains unsupported symlink packages/cli/dist/src/nonrequired.js');
    await expect(fs.stat(path.join(repoRoot, '.release', 'cache', 'build-stamp.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reuses and snapshots catalog symlinks with their relative target unchanged', async () => {
    const repoRoot = await createRepo();
    const linkTarget = 'targets/runtime.js';
    const linkPath = path.join(
      repoRoot,
      'packages',
      'cli',
      'plugins-dist',
      'plugins',
      'demo',
      'runtime.js',
    );
    const build = async () => {
      await writeBuildOutputs(repoRoot);
      await fs.mkdir(path.join(path.dirname(linkPath), 'targets'), { recursive: true });
      await fs.writeFile(path.join(path.dirname(linkPath), linkTarget), 'export {}\n');
      await fs.symlink(linkTarget, linkPath);
    };

    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({ reused: false });
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({ reused: true });

    const snapshot = await createBuildSnapshot(repoRoot, { build });
    const snapshotLink = path.join(
      snapshot.catalogOutputRoot,
      'plugins',
      'demo',
      'runtime.js',
    );
    expect((await fs.lstat(snapshotLink)).isSymbolicLink()).toBe(true);
    await expect(fs.readlink(snapshotLink)).resolves.toBe(linkTarget);
    await snapshot.cleanup();
  });

  it('rebuilds after JS/JSON mutation and any output tree deletion or addition', async () => {
    const repoRoot = await createRepo();
    let buildCount = 0;
    const build = async () => {
      buildCount += 1;
      await writeBuildOutputs(repoRoot, buildCount);
    };

    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({ reused: false });
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: true,
      reason: 'stamp and output tree match',
    });

    await fs.writeFile(path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js'), 'export const tampered = true;\n');
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'outputDigest changed',
    });

    const marketplacePath = path.join(
      repoRoot,
      'packages',
      'cli',
      'plugins-dist',
      '.claude-plugin',
      'marketplace.json',
    );
    const marketplace = JSON.parse(await fs.readFile(marketplacePath, 'utf8'));
    await fs.writeFile(marketplacePath, JSON.stringify({ ...marketplace, tampered: true }));
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'outputDigest changed',
    });

    await fs.rm(path.join(repoRoot, 'packages', 'cli', 'dist', 'src', 'nonrequired.js'));
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'outputDigest changed',
    });

    await fs.writeFile(path.join(repoRoot, 'packages', 'cli', 'dist', 'src', 'added.js'), 'export {};\n');
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'outputDigest changed',
    });
    expect(buildCount).toBe(5);
  });

  it('rebuilds for input changes, missing required output, and a bad stamp', async () => {
    const repoRoot = await createRepo();
    let buildCount = 0;
    const build = async () => {
      buildCount += 1;
      await writeBuildOutputs(repoRoot, buildCount);
    };
    await buildWithCache(repoRoot, { build });

    await fs.writeFile(path.join(repoRoot, 'plugins', 'demo', 'SKILL.md'), 'changed\n');
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'inputDigest changed',
    });

    await fs.rm(path.join(repoRoot, buildCacheContract.requiredOutputs[0]));
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: expect.stringContaining('missing output'),
    });

    await fs.writeFile(path.join(repoRoot, '.release', 'cache', 'build-stamp.json'), '{bad');
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'invalid stamp',
    });
    expect(buildCount).toBe(4);
  });

  it('refuses warm reuse when inputs change during cache inspection', async () => {
    const repoRoot = await createRepo();
    let generation = 0;
    const build = async () => {
      generation += 1;
      await writeBuildOutputs(repoRoot, generation);
    };
    await buildWithCache(repoRoot, { build });

    const inputInspection = await inspectBuildCache(repoRoot, {
      __testBeforeFinalInputCheck: async () => {
        await fs.writeFile(path.join(repoRoot, 'plugins', 'demo', 'SKILL.md'), 'changed\n');
      },
    });
    expect(inputInspection).toMatchObject({
      reusable: false,
      reason: 'inputDigest changed',
    });

    await buildWithCache(repoRoot, { build });
    const cliPackageInspection = await inspectBuildCache(repoRoot, {
      __testBeforeFinalInputCheck: async () => {
        await fs.writeFile(
          path.join(repoRoot, 'packages', 'cli', 'package.json'),
          JSON.stringify({ name: '@lesliechan721/aw', type: 'module', version: '9.9.9' }),
        );
      },
    });
    expect(cliPackageInspection).toMatchObject({
      reusable: false,
      reason: 'cliPackageDigest changed',
    });
  });

  it('refuses warm reuse when outputs change during final cache inspection', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });

    const inspection = await inspectBuildCache(repoRoot, {
      __testBeforeFinalOutputCheck: async () => {
        await fs.writeFile(
          path.join(repoRoot, 'packages', 'cli', 'dist', 'src', 'nonrequired.js'),
          'export const changedDuringInspection = true;\n',
        );
      },
    });
    expect(inspection).toMatchObject({
      reusable: false,
      reason: 'outputDigest changed',
    });
  });

  it('forces a new build and refreshes a warm stamp', async () => {
    const repoRoot = await createRepo();
    let buildCount = 0;
    const build = async () => {
      buildCount += 1;
      await writeBuildOutputs(repoRoot, buildCount);
    };
    await buildWithCache(repoRoot, { build });
    const stampPath = path.join(repoRoot, '.release', 'cache', 'build-stamp.json');
    const before = JSON.parse(await fs.readFile(stampPath, 'utf8'));
    const warm = await buildWithCache(repoRoot, { build });
    expect(warm).toMatchObject({ reused: true, generationId: before.generationId });

    await expect(buildWithCache(repoRoot, { build, force: true })).resolves.toMatchObject({
      reused: false,
      reason: 'forced build',
    });
    const after = JSON.parse(await fs.readFile(stampPath, 'utf8'));
    expect(buildCount).toBe(2);
    expect(after.outputDigest).not.toBe(before.outputDigest);
    expect(after.generationId).not.toBe(before.generationId);
    await expect(fs.readFile(path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js'), 'utf8'))
      .resolves.toContain('generation = 2');
  });

  it('does not write a stamp after a failed build and releases the lock', async () => {
    const repoRoot = await createRepo();
    const stampPath = path.join(repoRoot, '.release', 'cache', 'build-stamp.json');
    const lockPath = path.join(repoRoot, '.release', 'cache', 'build.lock');

    await expect(buildWithCache(repoRoot, {
      build: async () => {
        throw new Error('build failed');
      },
    })).rejects.toThrow('build failed');
    await expect(fs.stat(stampPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
