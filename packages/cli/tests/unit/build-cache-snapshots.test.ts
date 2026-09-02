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
describe('build snapshots', () => {
  it('copies and verifies one stable generation with consumer paths', async () => {
    const repoRoot = await createRepo();
    const built = await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    const snapshot = await createBuildSnapshot(repoRoot, {
      build: () => writeBuildOutputs(repoRoot, 2),
    });

    expect(snapshot).toMatchObject({
      root: expect.stringContaining('.release/build-snapshots/build-'),
      generationId: built.generationId,
      outputDigest: built.outputDigest,
      inputDigest: built.inputDigest,
      cliPackageDigest: built.cliPackageDigest,
      cliPackageRoot: path.join(snapshot.root, 'packages', 'cli'),
      cliDistRoot: path.join(snapshot.root, 'packages', 'cli', 'dist'),
      catalogOutputRoot: path.join(snapshot.root, 'packages', 'cli', 'plugins-dist'),
    });
    await expect(fs.readFile(path.join(snapshot.cliPackageRoot, 'package.json'), 'utf8'))
      .resolves.toContain('@lesliechan721/aw');
    const [sourcePackageStats, snapshotPackageStats] = await Promise.all([
      fs.stat(path.join(repoRoot, 'packages', 'cli', 'package.json')),
      fs.lstat(path.join(snapshot.cliPackageRoot, 'package.json')),
    ]);
    expect(snapshotPackageStats.isFile()).toBe(true);
    expect(snapshotPackageStats.isSymbolicLink()).toBe(false);
    expect(snapshotPackageStats.mode & 0o777).toBe(sourcePackageStats.mode & 0o777);
    await expect(computeBuildOutputDigest(snapshot.root)).resolves.toBe(built.outputDigest);
    await expect(snapshot.cleanup()).resolves.toBeUndefined();
    await expect(fs.stat(snapshot.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('materializes a symlinked canonical package as generation-bound regular bytes', async () => {
    const repoRoot = await createRepo();
    const canonicalPackagePath = path.join(repoRoot, 'packages', 'cli', 'package.json');
    const externalPackagePath = path.join(repoRoot, 'external-cli-package.json');
    const originalContents = JSON.stringify({
      name: '@lesliechan721/aw',
      type: 'module',
      version: '1.2.3',
      files: ['dist/'],
      publishConfig: { registry: 'https://registry.example.test' },
    });
    await fs.writeFile(externalPackagePath, originalContents, { mode: 0o640 });
    await fs.rm(canonicalPackagePath);
    await fs.symlink(externalPackagePath, canonicalPackagePath);
    const build = () => writeBuildOutputs(repoRoot);

    const snapshot = await createBuildSnapshot(repoRoot, { build });
    const snapshotPackagePath = path.join(snapshot.cliPackageRoot, 'package.json');
    const snapshotStats = await fs.lstat(snapshotPackagePath);
    expect(snapshotStats.isFile()).toBe(true);
    expect(snapshotStats.isSymbolicLink()).toBe(false);
    expect(snapshotStats.mode & 0o777).toBe(0o640);
    await expect(fs.readFile(snapshotPackagePath, 'utf8')).resolves.toBe(originalContents);
    await expect(fs.stat(path.join(repoRoot, '.release', 'cache', 'build-stamp.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    await fs.writeFile(externalPackagePath, JSON.stringify({
      name: '@lesliechan721/aw',
      version: '9.9.9',
      files: ['changed/'],
    }));
    await expect(fs.readFile(snapshotPackagePath, 'utf8')).resolves.toBe(originalContents);
    await snapshot.cleanup();
  });

  it('rejects package and non-package input changes during snapshot copy and cleans', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    const snapshotsRoot = path.join(repoRoot, '.release', 'build-snapshots');
    const packageJsonPath = path.join(repoRoot, 'packages', 'cli', 'package.json');

    await expect(createBuildSnapshot(repoRoot, {
      __testCopyPath: async (source: string, target: string, options?: { recursive?: boolean }) => {
        await fs.cp(source, target, options);
        if (source.endsWith(path.join('packages', 'cli', 'dist'))) {
          await fs.writeFile(packageJsonPath, JSON.stringify({
            name: '@lesliechan721/aw',
            type: 'module',
            version: '2.0.0',
            files: ['dist/', 'changed/'],
            publishConfig: { registry: 'https://changed.invalid' },
          }));
        }
      },
    })).rejects.toThrow('CLI package metadata changed while snapshot generation');
    await expect(fs.readdir(snapshotsRoot).catch(() => [])).resolves.toEqual([]);

    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot, 2) });
    await expect(createBuildSnapshot(repoRoot, {
      __testCopyPath: async (source: string, target: string, options?: { recursive?: boolean }) => {
        await fs.cp(source, target, options);
        if (source.endsWith(path.join('packages', 'cli', 'dist'))) {
          await fs.writeFile(path.join(repoRoot, 'plugins', 'demo', 'SKILL.md'), 'changed\n');
        }
      },
    })).rejects.toThrow('Build inputs changed while snapshot generation');
    await expect(fs.readdir(snapshotsRoot).catch(() => [])).resolves.toEqual([]);
  });

  it('rejects a symlink referent change during snapshot copy and cleans', async () => {
    const repoRoot = await createRepo();
    const referentPath = path.join(repoRoot, 'external-runtime.md');
    await fs.writeFile(referentPath, 'referent-one\n');
    await fs.symlink(
      referentPath,
      path.join(repoRoot, 'plugins', 'demo', 'runtime.md'),
    );
    const snapshotsRoot = path.join(repoRoot, '.release', 'build-snapshots');

    await expect(createBuildSnapshot(repoRoot, {
      build: () => writeBuildOutputs(repoRoot),
      __testCopyPath: async (source: string, target: string, options?: { recursive?: boolean }) => {
        await fs.cp(source, target, options);
        if (source.endsWith(path.join('packages', 'cli', 'dist'))) {
          await fs.writeFile(referentPath, 'referent-two\n');
        }
      },
    })).rejects.toThrow('Build inputs changed while snapshot generation');
    await expect(fs.readdir(snapshotsRoot).catch(() => [])).resolves.toEqual([]);
  });

  it('rejects snapshot symlinks outside its dependency link and cleans', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    const snapshotsRoot = path.join(repoRoot, '.release', 'build-snapshots');

    await expect(createBuildSnapshot(repoRoot, {
      __testCopyPath: async (source: string, target: string, options?: { recursive?: boolean }) => {
        await fs.cp(source, target, options);
        if (source.endsWith(path.join('packages', 'cli', 'plugins-dist'))) {
          await fs.symlink('package.json', path.join(path.dirname(target), 'extra-link'));
        }
      },
    })).rejects.toThrow(
      'Build snapshot contains unsupported symlink packages/cli/extra-link',
    );
    await expect(fs.readdir(snapshotsRoot).catch(() => [])).resolves.toEqual([]);
  });

  it('resolves real ESM dependencies through the POSIX snapshot node_modules link', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const repoRoot = await createRepo();
    const dependencyRoot = path.join(
      repoRoot,
      'packages',
      'cli',
      'node_modules',
      'snapshot-dependency',
    );
    await fs.mkdir(dependencyRoot, { recursive: true });
    await fs.writeFile(path.join(dependencyRoot, 'package.json'), JSON.stringify({
      name: 'snapshot-dependency',
      type: 'module',
      exports: './index.js',
    }));
    await fs.writeFile(path.join(dependencyRoot, 'index.js'), "export const value = 'linked';\n");
    const build = async () => {
      await writeBuildOutputs(repoRoot);
      await fs.writeFile(
        path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js'),
        "export { value } from 'snapshot-dependency';\n",
      );
    };
    await buildWithCache(repoRoot, { build });

    const snapshot = await createBuildSnapshot(repoRoot, { build });
    const snapshotNodeModules = path.join(snapshot.cliPackageRoot, 'node_modules');
    await expect(fs.realpath(snapshotNodeModules)).resolves.toBe(
      await fs.realpath(path.join(repoRoot, 'packages', 'cli', 'node_modules')),
    );
    const imported = await import(
      `${pathToFileURL(path.join(snapshot.cliDistRoot, 'index.js')).href}?test=${Math.random()}`
    ) as { value: string };
    expect(imported.value).toBe('linked');
    await snapshot.cleanup();
    await expect(fs.readFile(path.join(dependencyRoot, 'index.js'), 'utf8'))
      .resolves.toContain('linked');
  });

  it('requests a Windows junction for the snapshot dependency link', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    const linkCalls: Array<{ source: string; target: string; type: string }> = [];
    const snapshot = await createBuildSnapshot(repoRoot, {
      __testSnapshotPlatform: 'win32',
      __testCreateDependencyLink: async (source: string, target: string, type: string) => {
        linkCalls.push({ source, target, type });
        await fs.symlink(source, target, 'dir');
      },
    });

    expect(linkCalls).toEqual([
      {
        source: path.join(repoRoot, 'packages', 'cli', 'node_modules'),
        target: path.join(snapshot.cliPackageRoot, 'node_modules'),
        type: 'junction',
      },
      {
        source: path.join(repoRoot, 'packages', 'agent-skill-eval', 'node_modules'),
        target: path.join(snapshot.evalPackageRoot, 'node_modules'),
        type: 'junction',
      },
      {
        source: path.join(repoRoot, 'packages', 'plugin-core', 'node_modules'),
        target: path.join(snapshot.corePackageRoot, 'node_modules'),
        type: 'junction',
      },
    ]);
    await snapshot.cleanup();
  });

  it('fails clearly and cleans its snapshot when canonical dependencies are missing', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    await fs.rm(path.join(repoRoot, 'packages', 'cli', 'node_modules'), {
      recursive: true,
      force: true,
    });

    await expect(createBuildSnapshot(repoRoot)).rejects.toThrow(
      `missing CLI dependencies at ${path.join(repoRoot, 'packages', 'cli', 'node_modules')}`,
    );
    const snapshotsRoot = path.join(repoRoot, '.release', 'build-snapshots');
    await expect(fs.readdir(snapshotsRoot).catch(() => [])).resolves.toEqual([]);
  });

  it('does not copy snapshots during an ordinary warm ensure', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    let copyCount = 0;
    await expect(buildWithCache(repoRoot, {
      build: () => writeBuildOutputs(repoRoot, 2),
      __testCopyPath: async () => {
        copyCount += 1;
      },
    })).resolves.toMatchObject({ reused: true });
    expect(copyCount).toBe(0);
  });

  it('holds the build lock through snapshot copy and preserves the old generation', async () => {
    const repoRoot = await createRepo();
    let generation = 1;
    const initial = await buildWithCache(repoRoot, {
      build: () => writeBuildOutputs(repoRoot, generation),
    });
    const copyPaused = createDeferred<void>();
    const continueCopy = createDeferred<void>();
    const snapshotPromise = createBuildSnapshot(repoRoot, {
      build: () => writeBuildOutputs(repoRoot, generation),
      __testCopyPath: async (source: string, target: string, options?: { recursive?: boolean }) => {
        await fs.cp(source, target, options);
        if (source.endsWith(path.join('packages', 'cli', 'dist'))) {
          copyPaused.resolve();
          await continueCopy.promise;
        }
      },
    });
    await copyPaused.promise;

    let forceSettled = false;
    const forced = buildWithCache(repoRoot, {
      build: async () => {
        generation = 2;
        await writeBuildOutputs(repoRoot, generation);
      },
      force: true,
      lockTimeoutMs: 1_000,
      pollIntervalMs: 5,
    }).finally(() => {
      forceSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(forceSettled).toBe(false);
    continueCopy.resolve();

    const snapshot = await snapshotPromise;
    await forced;
    expect(snapshot.generationId).toBe(initial.generationId);
    await expect(computeBuildOutputDigest(snapshot.root)).resolves.toBe(initial.outputDigest);
    await expect(fs.readFile(path.join(snapshot.cliDistRoot, 'index.js'), 'utf8'))
      .resolves.toContain('generation = 1');
    await expect(fs.readFile(path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js'), 'utf8'))
      .resolves.toContain('generation = 2');
    await snapshot.cleanup();
  });

  it('cleans only its own snapshot after copy failure or digest mismatch', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    const snapshotsRoot = path.join(repoRoot, '.release', 'build-snapshots');
    const siblingRoot = path.join(snapshotsRoot, 'consumer-owned');
    await fs.mkdir(siblingRoot, { recursive: true });

    await expect(createBuildSnapshot(repoRoot, {
      __testCopyPath: async (source: string, target: string, options?: { recursive?: boolean }) => {
        if (source.endsWith('plugins-dist')) {
          throw new Error('copy failed');
        }
        await fs.cp(source, target, options);
      },
    })).rejects.toThrow('copy failed');
    expect((await fs.readdir(snapshotsRoot)).sort()).toEqual(['consumer-owned']);

    await expect(createBuildSnapshot(repoRoot, {
      __testCopyPath: async (source: string, target: string, options?: { recursive?: boolean }) => {
        await fs.cp(source, target, options);
        if (source.endsWith(path.join('packages', 'cli', 'dist'))) {
          await fs.writeFile(path.join(target, 'index.js'), 'corrupt\n');
        }
      },
    })).rejects.toThrow('Build snapshot digest mismatch');
    expect((await fs.readdir(snapshotsRoot)).sort()).toEqual(['consumer-owned']);
  });

  it('does not delete an existing snapshot path for an explicit run token', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    const snapshotRunToken = '12345678-1234-4123-8123-123456789abc';
    const existingRoot = path.join(
      repoRoot,
      '.release',
      'build-snapshots',
      `build-${snapshotRunToken}`,
    );
    await fs.mkdir(existingRoot, { recursive: true });
    await fs.writeFile(path.join(existingRoot, 'foreign-owner.txt'), 'preserve\n');

    await expect(createBuildSnapshot(repoRoot, { snapshotRunToken }))
      .rejects.toMatchObject({ code: 'EEXIST' });
    await expect(fs.readFile(path.join(existingRoot, 'foreign-owner.txt'), 'utf8'))
      .resolves.toBe('preserve\n');
  });

  it('preserves a primary consumer error when snapshot cleanup also fails', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    let snapshotRoot = '';

    const error = await withBuildSnapshot(
      repoRoot,
      async (snapshot: { root: string }) => {
        snapshotRoot = snapshot.root;
        throw new Error('consumer failed');
      },
      {
        __testRemoveSnapshot: async () => {
          throw new Error('cleanup failed');
        },
      },
    ).then(() => null, (caught) => caught as AggregateError);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error?.message).toContain('consumer failed');
    expect(error?.message).toContain('cleanup failed');
    expect((error as AggregateError & { cause?: unknown }).cause).toMatchObject({
      message: 'consumer failed',
    });
    await expect(fs.stat(snapshotRoot)).resolves.toBeDefined();
    await fs.rm(snapshotRoot, { recursive: true, force: true });
  });

  it('preserves a copy error when failed snapshot cleanup also reports an error', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });

    const error = await createBuildSnapshot(repoRoot, {
      __testCopyPath: async () => {
        throw new Error('snapshot copy failed');
      },
      __testRemoveSnapshot: async () => {
        throw new Error('snapshot cleanup failed');
      },
    }).then(() => null, (caught) => caught as AggregateError);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error?.message).toContain('snapshot copy failed');
    expect(error?.message).toContain('snapshot cleanup failed');
    expect((error as AggregateError & { cause?: unknown }).cause).toMatchObject({
      message: 'snapshot copy failed',
    });
    await fs.rm(path.join(repoRoot, '.release', 'build-snapshots'), {
      recursive: true,
      force: true,
    });
  });

  it('does not hold the build lock while a consumer cleanup is pending', async () => {
    const repoRoot = await createRepo();
    let generation = 1;
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot, generation) });
    const cleanupStarted = createDeferred<void>();
    const continueCleanup = createDeferred<void>();
    const snapshot = await createBuildSnapshot(repoRoot, {
      __testRemoveSnapshot: async (target: string) => {
        cleanupStarted.resolve();
        await continueCleanup.promise;
        await fs.rm(target, { recursive: true, force: true });
      },
    });

    const cleanup = snapshot.cleanup();
    await cleanupStarted.promise;
    const forced = buildWithCache(repoRoot, {
      build: async () => {
        generation = 2;
        await writeBuildOutputs(repoRoot, generation);
      },
      force: true,
      lockTimeoutMs: 500,
      pollIntervalMs: 5,
    });
    await expect(forced).resolves.toMatchObject({ reused: false });
    continueCleanup.resolve();
    await expect(cleanup).resolves.toBeUndefined();
  });
});
