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
describe('build cache lock ownership', () => {
  it('removes its own canonical lock when diagnostic owner writing fails', async () => {
    const repoRoot = await createRepo();
    const lockPath = path.join(repoRoot, '.release', 'cache', 'build.lock');
    await expect(acquireBuildLock(repoRoot, {
      __testWriteBuildOwner: async () => {
        throw new Error('diagnostic write failed');
      },
    })).rejects.toThrow('diagnostic write failed');
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns a rejected Promise and removes only its intent when sync owner write fails', async () => {
    const repoRoot = await createRepo();
    let buildCalled = false;
    const result = buildWithCache(repoRoot, {
      build: async () => {
        buildCalled = true;
      },
      force: true,
      writeForceOwnerSync: () => {
        throw new Error('force owner write failed');
      },
    });

    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toThrow('force owner write failed');
    expect(buildCalled).toBe(false);
    const intentRoot = path.join(repoRoot, '.release', 'cache', 'build.force');
    expect(await fs.readdir(intentRoot)).toEqual([]);
  });

  it('fails fast when the recorded build lock owner is not running', async () => {
    const repoRoot = await createRepo();
    const lockPath = path.join(repoRoot, '.release', 'cache', 'build.lock');
    const owner = JSON.stringify({ pid: 999_999, token: 'dead' });
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(path.join(lockPath, 'owner.json'), owner);
    const startedAt = Date.now();

    const error = await acquireBuildLock(repoRoot, {
      lockTimeoutMs: 10_000,
      pollIntervalMs: 5,
    }).then(() => null, (caught) => caught as Error);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(error?.message).toContain('Build lock owner PID 999999 is not running');
    expect(error?.message).toContain(owner);
    expect(error?.message).toContain('not recovered automatically');
    expect(error?.message).toContain('remove the lock offline');
    await expect(fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')).resolves.toBe(owner);
  });

  it('reports once while waiting and never steals invalid-owner or live locks', async () => {
    const repoRoot = await createRepo();
    const lockPath = path.join(repoRoot, '.release', 'cache', 'build.lock');
    const cases = [
      { name: 'invalid owner', owner: '{invalid' },
      { name: 'PID reuse', owner: JSON.stringify({ pid: process.pid, token: 'reused' }) },
    ];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      for (const testCase of cases) {
        await fs.rm(lockPath, { recursive: true, force: true });
        await fs.mkdir(lockPath, { recursive: true });
        await fs.writeFile(path.join(lockPath, 'owner.json'), testCase.owner);
        const oldTime = new Date(Date.now() - 60_000);
        await fs.utimes(lockPath, oldTime, oldTime);

        const error = await acquireBuildLock(repoRoot, {
          lockTimeoutMs: 25,
          pollIntervalMs: 5,
        }).then(() => null, (caught) => caught as Error);
        expect(error?.message, testCase.name).toContain(lockPath);
        expect(error?.message, testCase.name).toContain('not recovered automatically');
        expect(error?.message, testCase.name).toContain('remove the lock offline');
        await expect(fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'))
          .resolves.toBe(testCase.owner);
      }
      expect(consoleError).toHaveBeenCalledTimes(cases.length);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps an ownerless force intent active and never recovers it automatically', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    const intentPath = path.join(
      repoRoot,
      '.release',
      'cache',
      'build.force',
      '00000000-0000-4000-8000-000000000001',
    );
    await fs.mkdir(intentPath, { recursive: true });

    await expect(buildWithCache(repoRoot, {
      build: () => writeBuildOutputs(repoRoot, 2),
      lockTimeoutMs: 30,
      pollIntervalMs: 5,
    })).rejects.toThrow('Intents are not recovered automatically');
    await expect(fs.stat(intentPath)).resolves.toBeDefined();
  });

  it('serializes concurrent ensure calls with one build owner', async () => {
    const repoRoot = await createRepo();
    let buildCount = 0;
    let activeBuilds = 0;
    let maxActiveBuilds = 0;
    const build = async () => {
      buildCount += 1;
      activeBuilds += 1;
      maxActiveBuilds = Math.max(maxActiveBuilds, activeBuilds);
      await new Promise((resolve) => setTimeout(resolve, 40));
      await writeBuildOutputs(repoRoot, buildCount);
      activeBuilds -= 1;
    };

    const results = await Promise.all(Array.from({ length: 4 }, () =>
      buildWithCache(repoRoot, { build, lockTimeoutMs: 15_000, pollIntervalMs: 2 })
    ));
    expect(buildCount).toBe(1);
    expect(maxActiveBuilds).toBe(1);
    expect(results.filter((result) => result.reused)).toHaveLength(3);
  });

  it('makes an ensure caller wait for a concurrent forced build and then reuse it', async () => {
    const repoRoot = await createRepo();
    let startBuild: (() => void) | undefined;
    const buildStarted = new Promise<void>((resolve) => {
      startBuild = resolve;
    });
    let buildCount = 0;
    const build = async () => {
      buildCount += 1;
      startBuild?.();
      await new Promise((resolve) => setTimeout(resolve, 60));
      await writeBuildOutputs(repoRoot, buildCount);
    };

    let intentVisibleBeforeOwnerWrite = false;
    const forced = buildWithCache(repoRoot, {
      build,
      force: true,
      pollIntervalMs: 5,
      onForceIntentVisible: ({ intentPath }: { intentPath: string }) => {
        intentVisibleBeforeOwnerWrite = fsSync.existsSync(intentPath) &&
          !fsSync.existsSync(path.join(intentPath, 'owner.json'));
      },
      writeForceOwnerSync: (ownerPath: string, contents: string) => {
        fsSync.writeFileSync(ownerPath, contents, { flag: 'wx' });
      },
    });
    expect(intentVisibleBeforeOwnerWrite).toBe(true);
    await buildStarted;
    const ensured = buildWithCache(repoRoot, { build, pollIntervalMs: 5 });
    const [forcedResult, ensuredResult] = await Promise.all([forced, ensured]);

    expect(buildCount).toBe(1);
    expect(forcedResult).toMatchObject({ reused: false, reason: 'forced build' });
    expect(ensuredResult).toMatchObject({ reused: true });
  });

  it('does not let a warm ensure pass a force intent queued behind another lock owner', async () => {
    const repoRoot = await createRepo();
    let generation = 0;
    const build = async () => {
      generation += 1;
      await writeBuildOutputs(repoRoot, generation);
    };
    await buildWithCache(repoRoot, { build });
    const blocker = await acquireBuildLock(repoRoot);

    const forced = buildWithCache(repoRoot, {
      build,
      force: true,
      lockTimeoutMs: 1_000,
      pollIntervalMs: 5,
    });
    const intentRoot = path.join(repoRoot, '.release', 'cache', 'build.force');
    let intentOwnerPath = '';
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const intentNames = await fs.readdir(intentRoot).catch(() => []);
      const intentName = intentNames.find((entryName) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entryName)
      );
      if (intentName) {
        intentOwnerPath = path.join(intentRoot, intentName, 'owner.json');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await expect(fs.stat(intentOwnerPath)).resolves.toBeDefined();

    let ensureSettled = false;
    const ensured = buildWithCache(repoRoot, {
      build,
      lockTimeoutMs: 1_000,
      pollIntervalMs: 5,
    }).finally(() => {
      ensureSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ensureSettled).toBe(false);

    await blocker.release();
    const [forcedResult, ensuredResult] = await Promise.all([forced, ensured]);
    expect(generation).toBe(2);
    expect(forcedResult).toMatchObject({ reused: false, reason: 'forced build' });
    expect(ensuredResult).toMatchObject({ reused: true });
    await expect(fs.readFile(path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js'), 'utf8'))
      .resolves.toContain('generation = 2');
  });

  it('lets a warm ensure linearize before a force registered after its intent check', async () => {
    const repoRoot = await createRepo();
    let generation = 0;
    const build = async () => {
      generation += 1;
      await writeBuildOutputs(repoRoot, generation);
    };
    const initial = await buildWithCache(repoRoot, { build });
    const checked = createDeferred<void>();
    const continueWarm = createDeferred<void>();
    const warm = buildWithCache(repoRoot, {
      build,
      pollIntervalMs: 5,
      __testAfterForceIntentCheck: async ({ forceActive }: { forceActive: boolean }) => {
        if (!forceActive) {
          checked.resolve();
          await continueWarm.promise;
        }
      },
    });
    await checked.promise;

    const forceBuildStarted = createDeferred<void>();
    const finishForceBuild = createDeferred<void>();
    const forced = buildWithCache(repoRoot, {
      build: async () => {
        forceBuildStarted.resolve();
        await finishForceBuild.promise;
        await build();
      },
      force: true,
      lockTimeoutMs: 1_000,
      pollIntervalMs: 5,
    });
    continueWarm.resolve();
    const warmResult = await warm;
    expect(warmResult).toMatchObject({
      reused: true,
      generationId: initial.generationId,
    });
    await forceBuildStarted.promise;
    finishForceBuild.resolve();
    await expect(forced).resolves.toMatchObject({ reused: false, reason: 'forced build' });
  });

  it('keeps multiple ensures behind every synchronously registered force intent', async () => {
    const repoRoot = await createRepo();
    let generation = 0;
    const build = async () => {
      generation += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      await writeBuildOutputs(repoRoot, generation);
    };
    await buildWithCache(repoRoot, { build });
    const blocker = await acquireBuildLock(repoRoot);
    const forces = Array.from({ length: 2 }, () => buildWithCache(repoRoot, {
      build,
      force: true,
      lockTimeoutMs: 10_000,
      pollIntervalMs: 2,
    }));
    const ensures = Array.from({ length: 2 }, () => buildWithCache(repoRoot, {
      build,
      lockTimeoutMs: 10_000,
      pollIntervalMs: 2,
    }));
    await blocker.release();

    const [forceResults, ensureResults] = await Promise.all([
      Promise.all(forces),
      Promise.all(ensures),
    ]);
    expect(generation).toBe(3);
    expect(forceResults.every((result) => !result.reused)).toBe(true);
    expect(ensureResults.every((result) => result.reused)).toBe(true);
    expect(new Set(ensureResults.map((result) => result.generationId)).size).toBe(1);
  });
});
