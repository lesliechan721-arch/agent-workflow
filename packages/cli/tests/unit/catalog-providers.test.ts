import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CatalogSource, CatalogSourcesConfig } from '../../src/types.js';
import {
  calculateCatalogSourceIdentity,
  canonicalizeCatalogGitUrl,
} from '../../src/utils/catalog-source-identity.js';
import {
  catalogSourceCacheInternal,
} from '../../src/utils/catalog-source-cache.js';
import { validateCatalogSnapshot } from '../../src/utils/catalog-snapshot.js';
import { calculateCatalogSourcesConfigDigest } from '../../src/utils/catalog-sources.js';
import {
  catalogGitProviderInternal,
  setCatalogGitProviderTestHooksForTests,
} from '../../src/utils/git-catalog-provider.js';
import {
  CatalogLeaseEscapeError,
  formatPluginId,
  parsePluginId,
  preflightDesiredArtifactCollisions,
  withResolvedCatalogPlugin,
  withResolvedMultiSourceCatalog,
  type CatalogSourceProviderSet,
  type WithResolvedCatalogPluginOptions,
} from '../../src/utils/multi-source-catalog.js';
import {
  catalogPathProviderInternal,
  setCatalogPathProviderTestHooksForTests,
} from '../../src/utils/path-catalog-provider.js';
import {
  execFileNativeCliRunner,
  NativeCliError,
  setNativeCliRunnerOverrideForTests,
} from '../../src/utils/native-cli.js';
import { createCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const vitestCliPath = require.resolve('vitest/vitest.mjs');
const cliPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
  observeAndReserveCatalogSourceObservation,
  publishCatalogSourceCacheEntry,
  readCatalogSourceCache,
  reserveCatalogSourceObservationOrder,
  resolveCatalogSourceCacheLocation,
  withCatalogSourceCacheLock,
} = catalogSourceCacheInternal;
const resolveGitCatalogSource = catalogGitProviderInternal.resolve;
const resolvePathCatalogSource = catalogPathProviderInternal.resolve;

afterEach(() => {
  setCatalogGitProviderTestHooksForTests(undefined);
  setCatalogPathProviderTestHooksForTests(undefined);
  catalogSourceCacheInternal.setBeforeReleaseHookForTests(undefined);
  vi.restoreAllMocks();
});

function fixturePath(name: string): string {
  return path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
}

function selectorFileName(requestedRef: string): string {
  return `${crypto.createHash('sha256').update(JSON.stringify({ requestedRef })).digest('hex')}.json`;
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!await fs.pathExists(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => { resolve = done; }),
    resolve,
  };
}

async function processIsRunning(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') {
    try {
      const result = await execFileAsync('/bin/ps', ['-o', 'stat=', '-p', String(pid)]);
      const state = String(result.stdout).trim();
      return state !== '' && !state.startsWith('Z');
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessesClosed(pids: number[]): Promise<boolean> {
  const deadline = Date.now() + 1_000;
  while ((await Promise.all(pids.map(processIsRunning))).some(Boolean) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return !(await Promise.all(pids.map(processIsRunning))).some(Boolean);
}

async function createGitRemote(): Promise<{
  remote: string;
  commit: string;
}>;
async function createGitRemote(objectFormat: 'sha1' | 'sha256'): Promise<{
  remote: string;
  commit: string;
}>;
async function createGitRemote(objectFormat: 'sha1' | 'sha256' = 'sha1'): Promise<{
  remote: string;
  commit: string;
}> {
  const work = fixturePath('git-work');
  const remote = fixturePath('remote.git');
  await fs.ensureDir(work);
  await git(work, [
    'init',
    '--initial-branch=main',
    ...(objectFormat === 'sha256' ? ['--object-format=sha256'] : []),
  ]);
  await git(work, ['config', 'user.email', 'test@example.test']);
  await git(work, ['config', 'user.name', 'AW Test']);
  await createCatalogSnapshotFixture(path.join(work, 'catalog'));
  await git(work, ['add', '.']);
  await git(work, ['commit', '-m', 'catalog']);
  const commit = await git(work, ['rev-parse', 'HEAD']);
  await git(work, ['tag', '-a', 'release-tag', '-m', 'release']);
  await git(work, ['branch', 'release']);
  await git(work, ['tag', 'release']);
  await git(work, ['update-ref', 'refs/catalog/stable', commit]);
  await git(path.dirname(work), ['clone', '--bare', work, remote]);
  await git(remote, ['update-ref', 'refs/catalog/stable', commit]);
  return { remote, commit };
}

function gitSource(remote: string, ref: string) {
  return {
    id: 'official',
    type: 'git' as const,
    primary: true,
    url: remote,
    refPolicy: { type: 'explicit' as const, ref },
    subdir: 'catalog',
  };
}

describe('catalog snapshot schema 3 runtime validation', () => {
  it.each(['EPERM', 'EMFILE', 'EIO'])('propagates snapshot root lstat %s', async (code) => {
    const root = fixturePath(`snapshot-root-${code}`);
    const failure = Object.assign(new Error(`injected ${code}`), { code });
    const originalLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation(async (candidate) => {
      if (path.resolve(String(candidate)) === path.resolve(root)) throw failure;
      return originalLstat(candidate);
    });

    await expect(validateCatalogSnapshot(root)).rejects.toBe(failure);
  });

  it.each(['EPERM', 'EMFILE', 'EIO'])('propagates snapshot root realpath %s', async (code) => {
    const root = fixturePath(`snapshot-realpath-${code}`);
    await fs.ensureDir(root);
    const failure = Object.assign(new Error(`injected ${code}`), { code });
    const originalRealpath = fs.realpath.bind(fs);
    vi.spyOn(fs, 'realpath').mockImplementation(async (candidate) => {
      if (path.resolve(String(candidate)) === path.resolve(root)) throw failure;
      return originalRealpath(candidate);
    });

    await expect(validateCatalogSnapshot(root)).rejects.toBe(failure);
  });

  it('enforces the exact root layout and excludes only the publisher ledger from snapshotDigest', async () => {
    const root = fixturePath('snapshot-layout');
    await createCatalogSnapshotFixture(root);
    const baseline = await validateCatalogSnapshot(root);
    await fs.writeJson(path.join(root, 'plugin-release-ledger.json'), { records: ['one'] });
    const withLedger = await validateCatalogSnapshot(root);
    await fs.writeJson(path.join(root, 'plugin-release-ledger.json'), { records: ['two'] });
    const changedLedger = await validateCatalogSnapshot(root);

    expect(withLedger.snapshotDigest).toBe(baseline.snapshotDigest);
    expect(changedLedger.snapshotDigest).toBe(baseline.snapshotDigest);
    expect(withLedger.manifestDigest).toBe(baseline.manifestDigest);

    await fs.outputFile(path.join(root, 'unexpected.txt'), 'unexpected');
    await expect(validateCatalogSnapshot(root)).rejects.toThrow('unexpected [unexpected.txt]');
  });

  it('rejects empty directories that cannot be represented in a Git catalog commit', async () => {
    const root = fixturePath('snapshot-empty-directory');
    await createCatalogSnapshotFixture(root);
    await fs.ensureDir(path.join(root, 'plugins', 'demo', 'empty-runtime'));

    await expect(validateCatalogSnapshot(root)).rejects.toThrow(
      'Invalid catalog snapshot empty directory "plugins/demo/empty-runtime": Git cannot represent empty directories.',
    );
  });

  it('uses canonical Git modes for the snapshot digest', async () => {
    const root = fixturePath('snapshot-canonical-modes');
    await createCatalogSnapshotFixture(root);
    const baseline = await validateCatalogSnapshot(root);

    const applyRestrictiveCheckoutModes = async (current: string): Promise<void> => {
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await fs.chmod(entryPath, 0o700);
          await applyRestrictiveCheckoutModes(entryPath);
        } else {
          await fs.chmod(entryPath, 0o600);
        }
      }
    };
    await applyRestrictiveCheckoutModes(root);
    const restrictive = await validateCatalogSnapshot(root);
    expect(restrictive.snapshotDigest).toBe(baseline.snapshotDigest);

    await fs.chmod(path.join(root, '.agents', '.keep'), 0o700);
    const executable = await validateCatalogSnapshot(root);
    expect(executable.snapshotDigest).not.toBe(baseline.snapshotDigest);
  });

  it('allows contained relative symlinks and rejects absolute, escaping, and cyclic links', async () => {
    const root = fixturePath('snapshot-links');
    await createCatalogSnapshotFixture(root);
    await fs.symlink('../.claude-plugin', path.join(root, '.agents', 'safe'));
    await expect(validateCatalogSnapshot(root)).resolves.toMatchObject({
      rootDir: await fs.realpath(root),
    });

    await fs.remove(path.join(root, '.agents', 'safe'));
    await fs.symlink('/tmp', path.join(root, '.agents', 'absolute'));
    await expect(validateCatalogSnapshot(root)).rejects.toThrow('absolute targets');
    await fs.remove(path.join(root, '.agents', 'absolute'));
    await fs.symlink('../../../outside', path.join(root, '.agents', 'escape'));
    await expect(validateCatalogSnapshot(root)).rejects.toThrow('escapes');
    await fs.remove(path.join(root, '.agents', 'escape'));
    await fs.symlink('cycle-b', path.join(root, '.agents', 'cycle-a'));
    await fs.symlink('cycle-a', path.join(root, '.agents', 'cycle-b'));
    await expect(validateCatalogSnapshot(root)).rejects.toThrow('missing or cyclic');
  });

  it('rejects source boundary and all three entry digest mismatches', async () => {
    const root = fixturePath('snapshot-digests');
    await createCatalogSnapshotFixture(root);
    const manifestPath = path.join(root, 'catalog-manifest.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.entries[0].source = './plugins/other';
    await fs.writeJson(manifestPath, manifest);
    await expect(validateCatalogSnapshot(root)).rejects.toThrow('entry source');

    manifest.entries[0].source = './plugins/demo';
    manifest.entries[0].artifactDigest = `sha256:${'a'.repeat(64)}`;
    await fs.writeJson(manifestPath, manifest);
    await expect(validateCatalogSnapshot(root)).rejects.toThrow('artifactDigest');
    manifest.entries[0].artifactDigest = (await validateCatalogSnapshot(
      await (async () => {
        const clean = fixturePath('snapshot-digests-clean');
        await createCatalogSnapshotFixture(clean);
        return clean;
      })(),
    )).manifest.entries[0].artifactDigest;
    manifest.entries[0].manifestDigest = `sha256:${'b'.repeat(64)}`;
    await fs.writeJson(manifestPath, manifest);
    await expect(validateCatalogSnapshot(root)).rejects.toThrow('manifestDigest');
    const cleanManifest = await fs.readJson(path.join(fixturePath('snapshot-digests-clean'), 'catalog-manifest.json'));
    manifest.entries[0].manifestDigest = cleanManifest.entries[0].manifestDigest;
    manifest.entries[0].contentDigest = `sha256:${'c'.repeat(64)}`;
    await fs.writeJson(manifestPath, manifest);
    await expect(validateCatalogSnapshot(root)).rejects.toThrow('contentDigest');
  });

  it('rejects catalog entry fields that do not match the plugin manifest projection', async () => {
    for (const field of ['description', 'policy', 'compatibility'] as const) {
      const root = fixturePath(`snapshot-projection-${field}`);
      await createCatalogSnapshotFixture(root);
      const manifestPath = path.join(root, 'catalog-manifest.json');
      const manifest = await fs.readJson(manifestPath);
      manifest.compatibility.aw.minVersion = '2.0.0';
      if (field === 'description') manifest.entries[0].description = 'tampered description';
      if (field === 'policy') manifest.entries[0].policy.installation = 'TAMPERED';
      if (field === 'compatibility') manifest.entries[0].compatibility.aw.minVersion = '1.0.0';
      await fs.writeJson(manifestPath, manifest);

      await expect(validateCatalogSnapshot(root)).rejects.toThrow(`entry ${field}`);
    }
  });

  it('rejects a catalog compatibility floor below the plugin requirement', async () => {
    const root = fixturePath('snapshot-catalog-compatibility');
    await createCatalogSnapshotFixture(root, 'demo', '2.0.0');
    const manifestPath = path.join(root, 'catalog-manifest.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.compatibility.aw.minVersion = '1.0.0';
    await fs.writeJson(manifestPath, manifest);

    await expect(validateCatalogSnapshot(root)).rejects.toThrow('higher than catalog minimum');
  });
});

describe('Git and path catalog providers', () => {
  it('canonicalizes only the transport whitelist without merging scp-relative and ssh-absolute paths', () => {
    expect(canonicalizeCatalogGitUrl('https://Example.Test/repo.git/'))
      .toBe('https://example.test/repo.git');
    expect(canonicalizeCatalogGitUrl('ssh://git@Example.Test/repo.git'))
      .toBe('ssh://git@example.test/repo.git');
    expect(canonicalizeCatalogGitUrl('git@Example.Test:repo.git'))
      .toBe('scp-relative:git@example.test:repo.git');
    expect(canonicalizeCatalogGitUrl('git@Example.Test:/repo.git'))
      .toBe('scp-absolute:git@example.test:/repo.git');
    expect(canonicalizeCatalogGitUrl(pathToFileURL('/tmp/catalog.git').href))
      .toBe('file:///tmp/catalog.git');
    expect(() => canonicalizeCatalogGitUrl('http://example.test/repo.git')).toThrow('protocol');
    expect(() => canonicalizeCatalogGitUrl('https://user@example.test/repo.git')).toThrow('credentials');
  });

  it('clears command and config injection environments before invoking SSH', async () => {
    if (process.platform === 'win32') return;
    const sentinel = fixturePath('git-injection-sentinel');
    const command = fixturePath('git-injection-command.sh');
    await fs.writeFile(command, `#!/bin/sh\nprintf executed > '${sentinel}'\nexit 1\n`);
    await fs.chmod(command, 0o755);
    const env = {
      ...getCurrentSourceTestIsolation().env,
      GIT_SSH_COMMAND: command,
      GIT_SSH: command,
      GIT_EXEC_PATH: path.dirname(command),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.sshCommand',
      GIT_CONFIG_VALUE_0: command,
      GIT_CONFIG_PARAMETERS: `'core.sshCommand=${command}'`,
    };
    const source = gitSource('ssh://git@127.0.0.1:1/catalog.git', 'main');

    await expect(resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env,
    })).rejects.toThrow('Cannot resolve catalog Git source');
    await expect(fs.pathExists(sentinel)).resolves.toBe(false);
  });

  it('rejects global insteadOf rewrites that change the configured source identity', async () => {
    const { remote } = await createGitRemote();
    const env = getCurrentSourceTestIsolation().env;
    const configured = 'https://catalog-rewrite.example/repository.git';
    const rewritten = pathToFileURL(remote).href;
    await fs.outputFile(path.join(env.HOME!, '.gitconfig'), [
      `[url "${rewritten}"]`,
      `\tinsteadOf = ${configured}`,
      '',
    ].join('\n'));

    const error = await resolveGitCatalogSource(gitSource(configured, 'main'), {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env,
    }).catch((caught: unknown) => caught as Error);
    expect(error.message).toContain('insteadOf');
    let current: unknown = error;
    while (current instanceof Error) {
      expect(current.message).not.toContain(rewritten);
      current = current.cause;
    }
  });

  it('redacts the configured transport from the public error and its complete cause chain', async () => {
    const transport = fixturePath('secret-repository-token.git');
    const error = await resolveGitCatalogSource(gitSource(transport, 'main'), {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env: getCurrentSourceTestIsolation().env,
    }).catch((caught: unknown) => caught as Error);

    let current: unknown = error;
    while (current instanceof Error) {
      expect(current.message).not.toContain(transport);
      current = current.cause;
    }
  });

  it('terminates and closes a spawned Git descendant before releasing an aborted resolution', async () => {
    if (process.platform === 'win32') return;
    if (!await processIsRunning(process.pid)) return;
    const binDir = fixturePath('fake-git-bin');
    const marker = fixturePath('fake-git-processes');
    await fs.ensureDir(binDir);
    await fs.writeFile(path.join(binDir, 'git'), [
      '#!/bin/sh',
      'case "$*" in',
      '  *--get-url*) for argument in "$@"; do last="$argument"; done; printf "%s\\n" "$last"; exit 0 ;;',
      'esac',
      '/bin/sleep 30 &',
      'child=$!',
      `printf '%s %s' "$$" "$child" > '${marker}'`,
      'wait "$child"',
      '',
    ].join('\n'));
    await fs.chmod(path.join(binDir, 'git'), 0o755);
    const controller = new AbortController();
    const source = gitSource('https://process-tree.example/catalog.git', 'main');
    const env = {
      ...getCurrentSourceTestIsolation().env,
      PATH: `${binDir}:${getCurrentSourceTestIsolation().env.PATH}`,
    };
    const resolution = resolveGitCatalogSource(
      source,
      {
        cliVersion: '1.0.0',
        freshnessPolicy: 'forceRemote',
        env,
        signal: controller.signal,
      },
    );
    await waitForFile(marker);
    const pids = (await fs.readFile(marker, 'utf8')).split(' ').map(Number);
    controller.abort(new Error('stop fake Git tree'));

    await expect(resolution).rejects.toThrow('stop fake Git tree');
    expect(await waitForProcessesClosed(pids)).toBe(true);
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });
    await expect(withCatalogSourceCacheLock({
      location,
      name: 'objects',
      timeoutMs: 100,
      action: async () => undefined,
    })).resolves.toBeUndefined();
  });

  it('releases the object lock after the process runner confirms abort cleanup', async () => {
    const { remote } = await createGitRemote();
    const env = getCurrentSourceTestIsolation().env;
    const source = gitSource(remote, 'main');
    const controller = new AbortController();
    setNativeCliRunnerOverrideForTests(async (invocation) => {
      if (invocation.command === 'git' && invocation.args.includes('fetch')) {
        controller.abort(new Error('confirmed cleanup abort'));
        throw new NativeCliError({
          invocation,
          exitCode: 1,
          stdout: '',
          stderr: '',
          cause: controller.signal.reason,
          reason: 'aborted',
        });
      }
      return execFileNativeCliRunner(invocation);
    });
    try {
      await expect(resolveGitCatalogSource(source, {
        cliVersion: '1.0.0',
        freshnessPolicy: 'forceRemote',
        env,
        signal: controller.signal,
      })).rejects.toThrow('confirmed cleanup abort');

      const sourceIdentity = await calculateCatalogSourceIdentity(source);
      const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });
      await expect(withCatalogSourceCacheLock({
        location,
        name: 'objects',
        timeoutMs: 100,
        action: async () => undefined,
      })).resolves.toBeUndefined();
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }
  });

  it.each(['objects', 'publication'] as const)(
    'types repeated %s lock deadline races as the remote deadline',
    async (lockName) => {
    const { remote } = await createGitRemote();
    const source = gitSource(remote, 'main');
    const env = {
      ...getCurrentSourceTestIsolation().env,
      AW_CATALOG_REMOTE_TIMEOUT_MS: '100',
    };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });
    const acquired = deferred();
    const release = deferred();
    const holder = withCatalogSourceCacheLock({
      location,
      name: lockName,
      action: async () => {
        acquired.resolve();
        await release.promise;
      },
    });
    await acquired.promise;
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const error = await resolveGitCatalogSource(source, {
          cliVersion: '1.0.0',
          freshnessPolicy: 'forceRemote',
          env,
        }).catch((caught: unknown) => caught as Error);
        expect(error.message).toContain('AW_CATALOG_REMOTE_TIMEOUT_MS=100');
        expect(error.message).not.toContain('Timed out waiting for process lock');
      }
    } finally {
      release.resolve();
      await holder;
    }
  });

  it('uses a typed object-lock deadline for requireRemote cache fallback', async () => {
    const { remote } = await createGitRemote();
    const source = gitSource(remote, 'main');
    const baseEnv = getCurrentSourceTestIsolation().env;
    const warm = await resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'requireRemote',
      env: baseEnv,
    });
    const env = { ...baseEnv, AW_CATALOG_REMOTE_TIMEOUT_MS: '100' };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });
    const acquired = deferred();
    const release = deferred();
    const holder = withCatalogSourceCacheLock({
      location,
      name: 'objects',
      action: async () => {
        acquired.resolve();
        await release.promise;
      },
    });
    await acquired.promise;
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await expect(resolveGitCatalogSource(source, {
          cliVersion: '1.0.0',
          freshnessPolicy: 'requireRemote',
          env,
        })).resolves.toMatchObject({
          source: 'cache',
          cacheFallback: true,
          snapshotDigest: warm.snapshotDigest,
          remoteFailure: expect.stringContaining('AW_CATALOG_REMOTE_TIMEOUT_MS=100'),
        });
      }
    } finally {
      release.resolve();
      await holder;
    }
  });

  it('removes archive and staging files after a confirmed materialization abort', async () => {
    const { remote } = await createGitRemote();
    const env = getCurrentSourceTestIsolation().env;
    const source = gitSource(remote, 'main');
    const controller = new AbortController();
    setNativeCliRunnerOverrideForTests(async (invocation) => {
      if (invocation.command === 'tar') {
        controller.abort(new Error('confirmed materialization abort'));
        throw new NativeCliError({
          invocation,
          exitCode: 1,
          stdout: '',
          stderr: '',
          cause: controller.signal.reason,
          reason: 'aborted',
        });
      }
      return execFileNativeCliRunner(invocation);
    });
    try {
      await expect(resolveGitCatalogSource(source, {
        cliVersion: '1.0.0',
        freshnessPolicy: 'forceRemote',
        env,
        signal: controller.signal,
      })).rejects.toThrow('confirmed materialization abort');
      const sourceIdentity = await calculateCatalogSourceIdentity(source);
      const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });
      const leftovers = (await fs.readdir(location.rootDir))
        .filter((entry) => entry.startsWith('.archive-') || entry.startsWith('.materialize-'));
      expect(leftovers).toEqual([]);
      await expect(fs.pathExists(location.objectsFaultPath)).resolves.toBe(false);
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }
  });

  it.each([
    ['path', 'EBUSY'],
    ['git', 'EPERM'],
  ] as const)('keeps a published %s provider result when staging cleanup gets %s', async (provider, code) => {
    const env = getCurrentSourceTestIsolation().env;
    const cleanupPrefix = provider === 'path' ? '.path-' : '.materialize-';
    const originalRemove = fs.remove.bind(fs);
    vi.spyOn(fs, 'remove').mockImplementation(async (candidate) => {
      if (path.basename(String(candidate)).startsWith(cleanupPrefix)) {
        throw Object.assign(new Error(`injected ${code} staging cleanup failure`), { code });
      }
      return originalRemove(candidate);
    });
    vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    if (provider === 'path') {
      const root = fixturePath('path-postcommit-cleanup');
      await createCatalogSnapshotFixture(root);
      await expect(resolvePathCatalogSource({
        id: 'local', type: 'path', primary: true, path: root,
      }, {
        cliVersion: '1.0.0', freshnessPolicy: 'forceRemote', env,
      })).resolves.toMatchObject({ source: 'path', cacheFallback: false });
      return;
    }

    const { remote } = await createGitRemote();
    await expect(resolveGitCatalogSource(gitSource(remote, 'main'), {
      cliVersion: '1.0.0', freshnessPolicy: 'forceRemote', env,
    })).resolves.toMatchObject({ source: 'remote', cacheFallback: false });
  });

  it('retains archive and staging evidence only after fatal materialization cleanup', async () => {
    const { remote } = await createGitRemote();
    const env = getCurrentSourceTestIsolation().env;
    const source = gitSource(remote, 'main');
    setNativeCliRunnerOverrideForTests(async (invocation) => {
      if (invocation.command === 'tar') {
        throw new NativeCliError({
          invocation,
          exitCode: 1,
          stdout: '',
          stderr: '',
          cleanupError: new Error('injected tar cleanup uncertainty'),
          reason: 'aborted',
        });
      }
      return execFileNativeCliRunner(invocation);
    });
    try {
      await expect(resolveGitCatalogSource(source, {
        cliVersion: '1.0.0',
        freshnessPolicy: 'forceRemote',
        env,
      })).rejects.toThrow('Catalog Git process cleanup could not be confirmed');
      const sourceIdentity = await calculateCatalogSourceIdentity(source);
      const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });
      const leftovers = await fs.readdir(location.rootDir);
      expect(leftovers.some((entry) => entry.startsWith('.archive-'))).toBe(true);
      expect(leftovers.some((entry) => entry.startsWith('.materialize-'))).toBe(true);
      await expect(fs.pathExists(location.objectsFaultPath)).resolves.toBe(true);
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }
  });

  it('resolves full branches, peeled annotated tags, full commits, subdirs, and short-name ambiguity', async () => {
    const { remote, commit } = await createGitRemote();
    const options = {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote' as const,
      env: getCurrentSourceTestIsolation().env,
    };
    const branch = await resolveGitCatalogSource(gitSource(remote, 'refs/heads/main'), options);
    const tag = await resolveGitCatalogSource(gitSource(remote, 'refs/tags/release-tag'), options);
    const shortBranch = await resolveGitCatalogSource(gitSource(remote, 'main'), options);
    const shortTag = await resolveGitCatalogSource(gitSource(remote, 'release-tag'), options);
    const fullRef = await resolveGitCatalogSource(gitSource(remote, 'refs/catalog/stable'), options);
    const exactCommit = await resolveGitCatalogSource(gitSource(remote, commit), options);

    expect(branch.resolvedCommit).toBe(commit);
    expect(tag.resolvedCommit).toBe(commit);
    expect(shortBranch.resolvedCommit).toBe(commit);
    expect(shortTag.resolvedCommit).toBe(commit);
    expect(fullRef.resolvedCommit).toBe(commit);
    expect(exactCommit.resolvedCommit).toBe(commit);
    expect(await fs.pathExists(path.join(branch.rootDir, 'catalog'))).toBe(false);
    await expect(resolveGitCatalogSource(gitSource(remote, 'release'), options))
      .rejects.toThrow('ambiguous between a branch and tag');
  });

  it('serializes remote observation and order reservation before allowing a newer observation', async () => {
    const { remote, commit: oldCommit } = await createGitRemote();
    const env = getCurrentSourceTestIsolation().env;
    const source = gitSource(remote, 'main');
    const oldObserved = deferred();
    const allowOldReservation = deferred();
    const oldReserved = deferred();
    const releaseOld = deferred();
    const newObserved = deferred();
    const newerWaitingForObservationLock = deferred();
    let observationLockAttempts = 0;
    let pausedOldObservation = false;
    let pausedOldPublication = false;
    let sawNewObservation = false;
    setCatalogGitProviderTestHooksForTests({
      async beforeObservationLock() {
        observationLockAttempts += 1;
        if (observationLockAttempts === 2) newerWaitingForObservationLock.resolve();
      },
      async afterRemoteObservationBeforeReservation(observation) {
        if (!pausedOldObservation && observation.commit === oldCommit) {
          pausedOldObservation = true;
          oldObserved.resolve();
          await allowOldReservation.promise;
          return;
        }
        sawNewObservation = true;
        newObserved.resolve();
      },
      async afterObservation(observation) {
        if (!pausedOldPublication && observation.commit === oldCommit) {
          pausedOldPublication = true;
          oldReserved.resolve();
          await releaseOld.promise;
        }
      },
    });

    const olderResolution = resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env,
    });
    await oldObserved.promise;
    const work = fixturePath('git-work');
    await createCatalogSnapshotFixture(path.join(work, 'catalog'), 'demo', '0.0.0', 'new\n');
    await git(work, ['add', '.']);
    await git(work, ['commit', '-m', 'new catalog observation']);
    const newCommit = await git(work, ['rev-parse', 'HEAD']);
    await git(work, ['push', remote, 'HEAD:refs/heads/main']);

    const newerResolutionPromise = resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env,
    });
    await newerWaitingForObservationLock.promise;
    expect(sawNewObservation).toBe(false);
    allowOldReservation.resolve();
    await oldReserved.promise;
    await newObserved.promise;
    const newerResolution = await newerResolutionPromise;
    releaseOld.resolve();
    const completedOlderResolution = await olderResolution;
    const current = await resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'cacheFirst',
      env,
    });

    expect(completedOlderResolution.resolvedCommit).toBe(oldCommit);
    expect(newerResolution.resolvedCommit).toBe(newCommit);
    expect(current.resolvedCommit).toBe(newCommit);
  });

  it('keeps a fatal object fault closed after the faulting process exits', async () => {
    const { remote } = await createGitRemote();
    const env = getCurrentSourceTestIsolation().env;
    const source = gitSource(remote, 'main');
    await resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'requireRemote',
      env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });

    await execFileAsync(process.execPath, [
      vitestCliPath,
      'run',
      'tests/unit/fixtures/catalog-fault-child.test.ts',
      '--maxWorkers=1',
    ], {
      cwd: cliPackageRoot,
      env: {
        ...process.env,
        AW_CROSS_PROCESS_FAULT_REMOTE: remote,
        AW_CROSS_PROCESS_FAULT_HOME: location.awHomeDir,
        AW_CROSS_PROCESS_FAULT_USER_HOME: env.HOME,
      },
    });

    const fault = await fs.readJson(location.objectsFaultPath);
    expect(fault).toMatchObject({
      schemaVersion: 1,
      reason: 'Catalog Git process cleanup could not be confirmed.',
    });
    expect(Date.parse(fault.faultedAt)).not.toBeNaN();
    expect(JSON.stringify(fault)).not.toContain(remote);
    const ownerPath = path.join(location.locksDir, 'objects.lock', 'owner.json');
    const ownerBefore = await fs.readFile(ownerPath, 'utf8');

    await expect(resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'requireRemote',
      env,
    })).rejects.toThrow('persistent cleanup fault');
    await expect(withCatalogSourceCacheLock({
      location,
      name: 'objects',
      timeoutMs: 100,
      action: async () => undefined,
    })).rejects.toThrow('persistent fault marker');
    await expect(fs.readFile(ownerPath, 'utf8')).resolves.toBe(ownerBefore);
  });

  it('uses only a matching Git cache fallback for requireRemote and never for forceRemote', async () => {
    const { remote } = await createGitRemote();
    const env = getCurrentSourceTestIsolation().env;
    const source = gitSource(remote, 'refs/heads/main');
    const first = await resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'requireRemote',
      env,
    });
    const unavailable = `${remote}.unavailable`;
    await fs.move(remote, unavailable);
    try {
      const fallback = await resolveGitCatalogSource(source, {
        cliVersion: '1.0.0',
        freshnessPolicy: 'requireRemote',
        env,
      });
      expect(fallback).toMatchObject({
        source: 'cache',
        cacheFallback: true,
        snapshotDigest: first.snapshotDigest,
      });
      await expect(resolveGitCatalogSource(gitSource(remote, 'main'), {
        cliVersion: '1.0.0',
        freshnessPolicy: 'requireRemote',
        env,
      })).rejects.toThrow('Cannot resolve catalog Git source');
      const forceError = await resolveGitCatalogSource(source, {
        cliVersion: '1.0.0',
        freshnessPolicy: 'forceRemote',
        env,
      }).catch((error: unknown) => error as Error);
      expect(forceError.message).toContain('Cannot resolve catalog Git source');
      expect(forceError.message).not.toContain(remote);
    } finally {
      await fs.move(unavailable, remote);
    }
  });

  it('does not fall back when a refreshed snapshot is incompatible with the current CLI', async () => {
    const { remote } = await createGitRemote();
    const env = getCurrentSourceTestIsolation().env;
    const source = gitSource(remote, 'refs/heads/main');
    await resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'requireRemote',
      env,
    });
    const work = fixturePath('git-work');
    await createCatalogSnapshotFixture(path.join(work, 'catalog'), 'demo', '2.0.0');
    await git(work, ['add', '.']);
    await git(work, ['commit', '-m', 'require newer aw']);
    await git(work, ['push', remote, 'HEAD:refs/heads/main']);

    const error = await resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'requireRemote',
      env,
    }).catch((failure: unknown) => failure as Error & { code?: string; sourceId?: string });
    expect(error).toMatchObject({
      code: 'explicitCatalogIncompatible',
      sourceId: 'official',
    });
    expect(error.message).toContain('requires aw >= 2.0.0');
  });

  it('maps an incompatible CLI channel to awVersionTooLow', async () => {
    const { remote, commit } = await createGitRemote();
    const env = getCurrentSourceTestIsolation().env;
    await git(remote, ['update-ref', 'refs/heads/catalog/latest', commit]);
    const source = {
      ...gitSource(remote, 'unused'),
      refPolicy: { type: 'cliChannel' as const },
    };
    const work = fixturePath('git-work');
    await createCatalogSnapshotFixture(path.join(work, 'catalog'), 'demo', '2.0.0');
    await git(work, ['add', '.']);
    await git(work, ['commit', '-m', 'require newer channel aw']);
    await git(work, ['push', remote, 'HEAD:refs/heads/catalog/latest']);

    const error = await resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'requireRemote',
      env,
    }).catch((failure: unknown) => failure as Error & { code?: string; sourceId?: string });
    expect(error).toMatchObject({ code: 'awVersionTooLow', sourceId: 'official' });
    expect(error.message).toContain('requires aw >= 2.0.0');
  });

  it('does not return a warm fallback after the caller has already aborted', async () => {
    const { remote } = await createGitRemote();
    const env = getCurrentSourceTestIsolation().env;
    const source = gitSource(remote, 'main');
    await resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'requireRemote',
      env,
    });
    const controller = new AbortController();
    controller.abort(new Error('caller abort must win'));

    await expect(resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'requireRemote',
      env,
      signal: controller.signal,
    })).rejects.toThrow('caller abort must win');
  });

  it('retains the object lock and refuses fallback when process cleanup is unconfirmed', async () => {
    const { remote } = await createGitRemote();
    const env = getCurrentSourceTestIsolation().env;
    const source = gitSource(remote, 'main');
    await resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'requireRemote',
      env,
    });
    let cleanupFailed = false;
    let invokedAfterCleanupFailure = false;
    setNativeCliRunnerOverrideForTests(async (invocation) => {
      if (cleanupFailed) {
        invokedAfterCleanupFailure = true;
        throw new Error('Git was invoked after cleanup became unconfirmed.');
      }
      if (invocation.command === 'git' && invocation.args.includes('fetch')) {
        cleanupFailed = true;
        throw new NativeCliError({
          invocation,
          exitCode: 1,
          stdout: '',
          stderr: 'fetch cleanup failed',
          cleanupError: new Error('Native CLI cleanup unconfirmed: injected failure.'),
          reason: 'aborted',
        });
      }
      return execFileNativeCliRunner(invocation);
    });
    try {
      const error = await resolveGitCatalogSource(source, {
        cliVersion: '1.0.0',
        freshnessPolicy: 'requireRemote',
        env,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('Catalog Git process cleanup could not be confirmed');
      expect(invokedAfterCleanupFailure).toBe(false);

      const sourceIdentity = await calculateCatalogSourceIdentity(source);
      const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });
      await expect(withCatalogSourceCacheLock({
        location,
        name: 'objects',
        timeoutMs: 50,
        action: async () => undefined,
      })).rejects.toThrow('persistent fault marker');
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }
  });

  it('resolves a complete 64-hex commit from a SHA-256 repository', async () => {
    const { remote, commit } = await createGitRemote('sha256');
    expect(commit).toMatch(/^[0-9a-f]{64}$/);
    await expect(resolveGitCatalogSource(gitSource(remote, commit), {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env: getCurrentSourceTestIsolation().env,
    })).resolves.toMatchObject({ resolvedCommit: commit });
  });

  it('quarantines empty and wrong-format bare object caches before rebuilding them', async () => {
    const { remote } = await createGitRemote();
    const env = getCurrentSourceTestIsolation().env;
    const source = gitSource(remote, 'main');
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });
    await fs.ensureDir(location.objectsDir);

    await expect(resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env,
    })).resolves.toMatchObject({ source: 'remote' });
    await fs.remove(location.objectsDir);
    await git(path.dirname(location.objectsDir), [
      'init',
      '--bare',
      '--object-format=sha256',
      location.objectsDir,
    ]);
    await expect(resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env,
    })).resolves.toMatchObject({ source: 'remote' });
    expect((await fs.readdir(location.quarantineDir))
      .filter((entry) => entry.startsWith('objects-'))).toHaveLength(2);
  });

  it('quarantines a managed bare repo whose local config adds url.insteadOf', async () => {
    const { remote } = await createGitRemote();
    const env = getCurrentSourceTestIsolation().env;
    const source = gitSource(remote, 'main');
    await resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });
    const rewritten = pathToFileURL(fixturePath('local-config-rewrite.git')).href;
    await git(location.objectsDir, [
      'config',
      '--local',
      `url.${rewritten}.insteadOf`,
      remote,
    ]);

    await expect(resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env,
    })).resolves.toMatchObject({ source: 'remote' });
    expect((await fs.readdir(location.quarantineDir))
      .filter((entry) => entry.startsWith('objects-'))).toHaveLength(1);
  });

  it('isolates a broken objects.git symlink before rebuilding the managed bare repo', async () => {
    const { remote } = await createGitRemote();
    const env = getCurrentSourceTestIsolation().env;
    const source = gitSource(remote, 'main');
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });
    await fs.ensureDir(location.rootDir);
    await fs.symlink('missing-objects.git', location.objectsDir);

    await expect(resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env,
    })).resolves.toMatchObject({ source: 'remote' });
    expect((await fs.lstat(location.objectsDir)).isDirectory()).toBe(true);
    const quarantined = (await fs.readdir(location.quarantineDir))
      .find((entry) => entry.startsWith('objects-'));
    expect(quarantined).toBeDefined();
    expect((await fs.lstat(path.join(location.quarantineDir, quarantined!))).isSymbolicLink()).toBe(true);
  });

  it.each([
    ['objects directory symlink', 'objects'],
    ['pack symlink', 'pack'],
    ['loose object symlink', 'loose'],
    ['object alternates', 'alternates'],
  ] as const)('quarantines a managed bare repo with an unsafe %s', async (_label, kind) => {
    const { remote } = await createGitRemote();
    const env = getCurrentSourceTestIsolation().env;
    const source = gitSource(remote, 'main');
    await resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });
    const external = fixturePath(`bare-external-${kind}`);
    const marker = path.join(external, 'marker.txt');
    await fs.outputFile(marker, 'unchanged');

    if (kind === 'objects') {
      await fs.remove(path.join(location.objectsDir, 'objects'));
      await fs.symlink(external, path.join(location.objectsDir, 'objects'));
    } else if (kind === 'alternates') {
      await fs.outputFile(path.join(location.objectsDir, 'objects', 'info', 'alternates'), `${external}\n`);
    } else {
      const unsafePath = kind === 'pack'
        ? path.join(location.objectsDir, 'objects', 'pack', 'unsafe.pack')
        : path.join(location.objectsDir, 'objects', 'aa', 'a'.repeat(38));
      await fs.ensureDir(path.dirname(unsafePath));
      await fs.symlink(marker, unsafePath);
    }

    await expect(resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env,
    })).resolves.toMatchObject({ source: 'remote' });
    await expect(fs.readFile(marker, 'utf8')).resolves.toBe('unchanged');
    await expect(fs.readdir(external)).resolves.toEqual(['marker.txt']);
    expect((await fs.readdir(location.quarantineDir))
      .filter((entry) => entry.startsWith('objects-'))).toHaveLength(1);
  });

  it('forces files ref storage when global Git config requests reftable', async () => {
    const { remote } = await createGitRemote();
    const env = getCurrentSourceTestIsolation().env;
    await fs.outputFile(path.join(env.HOME!, '.gitconfig'), [
      '[init]',
      '\tdefaultRefFormat = reftable',
      '',
    ].join('\n'));
    const source = gitSource(remote, 'main');
    await expect(resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env,
    })).resolves.toMatchObject({ source: 'remote' });

    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });
    const localKeys = await git(location.objectsDir, [
      'config',
      '--local',
      '--name-only',
      '--list',
    ]);
    expect(localKeys.toLowerCase()).not.toContain('extensions.refstorage');
  });

  it('applies an already-aborted signal before starting Git remote work', async () => {
    const { remote } = await createGitRemote();
    const controller = new AbortController();
    controller.abort(new Error('caller stopped catalog resolution'));
    await expect(resolveGitCatalogSource(gitSource(remote, 'main'), {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env: getCurrentSourceTestIsolation().env,
      signal: controller.signal,
    })).rejects.toThrow('caller stopped catalog resolution');
  });

  it('copies each path observation into an immutable entry and never falls back after source loss', async () => {
    const root = fixturePath('path-source');
    await createCatalogSnapshotFixture(root);
    const source = { id: 'local', type: 'path' as const, primary: true, path: root };
    const options = {
      cliVersion: '1.0.0',
      freshnessPolicy: 'cacheFirst' as const,
      env: getCurrentSourceTestIsolation().env,
    };
    const resolution = await resolvePathCatalogSource(source, options);
    expect(resolution.rootDir).not.toBe(root);
    expect(resolution.source).toBe('path');
    await fs.remove(root);
    await expect(resolvePathCatalogSource(source, options)).rejects.toThrow();
    await expect(fs.pathExists(resolution.rootDir)).resolves.toBe(true);
  });

  it('serializes stable path observation and order reservation for the same source', async () => {
    const root = fixturePath('path-observation-source');
    await createCatalogSnapshotFixture(root, 'demo', '0.0.0', 'old\n');
    const source = { id: 'local', type: 'path' as const, primary: true, path: root };
    const env = getCurrentSourceTestIsolation().env;
    const oldObserved = deferred();
    const allowOldReservation = deferred();
    const oldReserved = deferred();
    const releaseOldPublication = deferred();
    const newerWaiting = deferred();
    const newObserved = deferred();
    let attempts = 0;
    let pausedOldObservation = false;
    let pausedOldPublication = false;
    let oldDigest = '';
    setCatalogPathProviderTestHooksForTests({
      async beforeObservationLock() {
        attempts += 1;
        if (attempts === 2) newerWaiting.resolve();
      },
      async afterStableObservationBeforeReservation(observation) {
        if (!pausedOldObservation) {
          pausedOldObservation = true;
          oldDigest = observation.snapshotDigest;
          oldObserved.resolve();
          await allowOldReservation.promise;
          return;
        }
        newObserved.resolve();
      },
      async afterObservation(observation) {
        if (!pausedOldPublication && observation.snapshotDigest === oldDigest) {
          pausedOldPublication = true;
          oldReserved.resolve();
          await releaseOldPublication.promise;
        }
      },
    });

    const older = resolvePathCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env,
    });
    await oldObserved.promise;
    await createCatalogSnapshotFixture(root, 'demo', '0.0.0', 'new\n');
    const newerPromise = resolvePathCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env,
    });
    await newerWaiting.promise;
    allowOldReservation.resolve();
    await oldReserved.promise;
    await newObserved.promise;
    const newer = await newerPromise;
    releaseOldPublication.resolve();
    const completedOlder = await older;

    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });
    const selected = await readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef: 'path',
      cliVersion: '1.0.0',
    });
    expect(completedOlder.snapshotDigest).toBe(oldDigest);
    expect(newer.snapshotDigest).not.toBe(oldDigest);
    expect(selected?.validation.snapshotDigest).toBe(newer.snapshotDigest);
  });
});

describe('strict catalog source cache', () => {
  it.each(['EACCES', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'EPERM'])(
    'propagates selector read %s without quarantining the selector or entry',
    async (code) => {
      const root = fixturePath(`cache-selector-read-${code}`);
      await createCatalogSnapshotFixture(root);
      const validation = await validateCatalogSnapshot(root);
      const source = { id: 'local', type: 'path' as const, primary: true, path: root };
      const sourceIdentity = await calculateCatalogSourceIdentity(source);
      const location = resolveCatalogSourceCacheLocation({
        sourceId: source.id,
        sourceIdentity,
        env: getCurrentSourceTestIsolation().env,
      });
      const requestedRef = 'refs/heads/main';
      const observationOrder = await reserveCatalogSourceObservationOrder({ location });
      const entry = await publishCatalogSourceCacheEntry({
        location,
        sourceId: source.id,
        sourceIdentity,
        requestedRef,
        resolvedCommit: '1'.repeat(40),
        snapshotRoot: root,
        validation,
        observationOrder,
      });
      const indexPath = path.join(location.selectorsDir, selectorFileName(requestedRef));
      const originalReadJson = fs.readJson.bind(fs);
      vi.spyOn(fs, 'readJson').mockImplementation(async (...args: Parameters<typeof fs.readJson>) => {
        if (path.resolve(String(args[0])) === path.resolve(indexPath)) {
          throw Object.assign(new Error(`injected ${code}`), { code });
        }
        return originalReadJson(...args);
      });

      await expect(readCatalogSourceCache({
        location,
        sourceId: source.id,
        sourceIdentity,
        requestedRef,
        cliVersion: '1.0.0',
      })).rejects.toMatchObject({ code });
      await expect(fs.pathExists(indexPath)).resolves.toBe(true);
      await expect(fs.pathExists(entry.entryDir)).resolves.toBe(true);
      await expect(fs.pathExists(location.quarantineDir)).resolves.toBe(false);
    },
  );

  it.each(['EACCES', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'EPERM'])(
    'propagates entry metadata read %s without quarantining the selector or entry',
    async (code) => {
      const root = fixturePath(`cache-entry-read-${code}`);
      await createCatalogSnapshotFixture(root);
      const validation = await validateCatalogSnapshot(root);
      const source = { id: 'local', type: 'path' as const, primary: true, path: root };
      const sourceIdentity = await calculateCatalogSourceIdentity(source);
      const location = resolveCatalogSourceCacheLocation({
        sourceId: source.id,
        sourceIdentity,
        env: getCurrentSourceTestIsolation().env,
      });
      const requestedRef = 'refs/heads/main';
      const observationOrder = await reserveCatalogSourceObservationOrder({ location });
      const entry = await publishCatalogSourceCacheEntry({
        location,
        sourceId: source.id,
        sourceIdentity,
        requestedRef,
        resolvedCommit: '1'.repeat(40),
        snapshotRoot: root,
        validation,
        observationOrder,
      });
      const indexPath = path.join(location.selectorsDir, selectorFileName(requestedRef));
      const metadataPath = path.join(entry.entryDir, 'metadata.json');
      const originalReadJson = fs.readJson.bind(fs);
      vi.spyOn(fs, 'readJson').mockImplementation(async (...args: Parameters<typeof fs.readJson>) => {
        if (path.resolve(String(args[0])) === path.resolve(metadataPath)) {
          throw Object.assign(new Error(`injected ${code}`), { code });
        }
        return originalReadJson(...args);
      });

      await expect(readCatalogSourceCache({
        location,
        sourceId: source.id,
        sourceIdentity,
        requestedRef,
        cliVersion: '1.0.0',
      })).rejects.toMatchObject({ code });
      await expect(fs.pathExists(indexPath)).resolves.toBe(true);
      await expect(fs.pathExists(entry.entryDir)).resolves.toBe(true);
      await expect(fs.pathExists(location.quarantineDir)).resolves.toBe(false);
    },
  );

  it.each([1, 2])('retries %s transient publication lock release failures', async (failures) => {
    const root = fixturePath(`cache-release-retry-${failures}`);
    await createCatalogSnapshotFixture(root);
    const validation = await validateCatalogSnapshot(root);
    const source = { id: 'local', type: 'path' as const, primary: true, path: root };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({
      sourceId: source.id,
      sourceIdentity,
      env: getCurrentSourceTestIsolation().env,
    });
    const observationOrder = await reserveCatalogSourceObservationOrder({ location });
    const attempts: number[] = [];
    catalogSourceCacheInternal.setBeforeReleaseHookForTests(async (lockPath, attempt) => {
      if (!lockPath.endsWith(`${path.sep}publication.lock`)) return;
      attempts.push(attempt);
      if (attempt <= failures) throw Object.assign(new Error('transient release'), { code: 'EBUSY' });
    });

    await expect(publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef: 'refs/heads/main',
      resolvedCommit: '1'.repeat(40),
      snapshotRoot: root,
      validation,
      observationOrder,
    })).resolves.toMatchObject({ metadata: { sourceId: source.id } });
    expect(attempts).toEqual(Array.from({ length: failures + 1 }, (_, index) => index + 1));
  });

  it.each([
    ['counter', (location: ReturnType<typeof resolveCatalogSourceCacheLocation>) =>
      path.join(location.rootDir, 'observation-order.json')],
    ['snapshot', (_location: ReturnType<typeof resolveCatalogSourceCacheLocation>, entry: Awaited<ReturnType<typeof publishCatalogSourceCacheEntry>>) =>
      path.join(entry.snapshotRoot, 'catalog-manifest.json')],
  ] as const)(
    'propagates Windows EPERM from the %s read without quarantining cache state',
    async (_label, targetPath) => {
      const root = fixturePath(`cache-operational-${_label}`);
      await createCatalogSnapshotFixture(root);
      const validation = await validateCatalogSnapshot(root);
      const source = { id: 'local', type: 'path' as const, primary: true, path: root };
      const sourceIdentity = await calculateCatalogSourceIdentity(source);
      const location = resolveCatalogSourceCacheLocation({
        sourceId: source.id,
        sourceIdentity,
        env: getCurrentSourceTestIsolation().env,
      });
      const requestedRef = 'refs/heads/main';
      const observationOrder = await reserveCatalogSourceObservationOrder({ location });
      const entry = await publishCatalogSourceCacheEntry({
        location,
        sourceId: source.id,
        sourceIdentity,
        requestedRef,
        resolvedCommit: '1'.repeat(40),
        snapshotRoot: root,
        validation,
        observationOrder,
      });
      const protectedPath = targetPath(location, entry);
      const originalReadJson = fs.readJson.bind(fs);
      vi.spyOn(fs, 'readJson').mockImplementation(async (...args: Parameters<typeof fs.readJson>) => {
        if (path.resolve(String(args[0])) === path.resolve(protectedPath)) {
          throw Object.assign(new Error('injected EPERM'), { code: 'EPERM' });
        }
        return originalReadJson(...args);
      });

      await expect(readCatalogSourceCache({
        location,
        sourceId: source.id,
        sourceIdentity,
        requestedRef,
        cliVersion: '1.0.0',
      })).rejects.toMatchObject({ code: 'EPERM' });
      await expect(fs.pathExists(path.join(
        location.selectorsDir,
        selectorFileName(requestedRef),
      ))).resolves.toBe(true);
      await expect(fs.pathExists(entry.entryDir)).resolves.toBe(true);
      await expect(fs.pathExists(location.quarantineDir)).resolves.toBe(false);
    },
  );

  it('propagates snapshot root EPERM without quarantining strict cache state', async () => {
    const root = fixturePath('cache-snapshot-root-operational');
    await createCatalogSnapshotFixture(root);
    const validation = await validateCatalogSnapshot(root);
    const source = { id: 'local', type: 'path' as const, primary: true, path: root };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({
      sourceId: source.id,
      sourceIdentity,
      env: getCurrentSourceTestIsolation().env,
    });
    const requestedRef = 'refs/heads/main';
    const observationOrder = await reserveCatalogSourceObservationOrder({ location });
    const entry = await publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      resolvedCommit: '1'.repeat(40),
      snapshotRoot: root,
      validation,
      observationOrder,
    });
    const failure = Object.assign(new Error('injected snapshot root EPERM'), { code: 'EPERM' });
    const originalLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation(async (candidate) => {
      if (path.resolve(String(candidate)) === path.resolve(entry.snapshotRoot)) throw failure;
      return originalLstat(candidate);
    });

    await expect(readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      cliVersion: '1.0.0',
    })).rejects.toBe(failure);
    await expect(fs.pathExists(entry.entryDir)).resolves.toBe(true);
    await expect(fs.pathExists(location.quarantineDir)).resolves.toBe(false);
  });

  it('propagates snapshot directory EPERM without quarantining strict cache state', async () => {
    const root = fixturePath('cache-snapshot-directory-operational');
    await createCatalogSnapshotFixture(root);
    const validation = await validateCatalogSnapshot(root);
    const source = { id: 'local', type: 'path' as const, primary: true, path: root };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({
      sourceId: source.id,
      sourceIdentity,
      env: getCurrentSourceTestIsolation().env,
    });
    const requestedRef = 'refs/heads/main';
    const observationOrder = await reserveCatalogSourceObservationOrder({ location });
    const entry = await publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      resolvedCommit: '1'.repeat(40),
      snapshotRoot: root,
      validation,
      observationOrder,
    });
    const protectedDirectory = path.join(entry.snapshotRoot, 'plugins', 'demo');
    const failure = Object.assign(new Error('injected snapshot directory EPERM'), { code: 'EPERM' });
    const originalReaddir = fs.readdir.bind(fs);
    let protectedReadCount = 0;
    vi.spyOn(fs, 'readdir').mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      if (path.resolve(String(args[0])) === path.resolve(protectedDirectory)) {
        protectedReadCount += 1;
        if (protectedReadCount === 2) throw failure;
      }
      return originalReaddir(...args);
    });

    await expect(readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      cliVersion: '1.0.0',
    })).rejects.toBe(failure);
    await expect(fs.pathExists(entry.entryDir)).resolves.toBe(true);
    await expect(fs.pathExists(location.quarantineDir)).resolves.toBe(false);
  });

  it('propagates snapshot symlink realpath EPERM without quarantining strict cache state', async () => {
    const root = fixturePath('cache-snapshot-symlink-operational');
    await createCatalogSnapshotFixture(root);
    await fs.symlink('../.claude-plugin', path.join(root, '.agents', 'safe'));
    const validation = await validateCatalogSnapshot(root);
    const source = { id: 'local', type: 'path' as const, primary: true, path: root };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({
      sourceId: source.id,
      sourceIdentity,
      env: getCurrentSourceTestIsolation().env,
    });
    const requestedRef = 'refs/heads/main';
    const observationOrder = await reserveCatalogSourceObservationOrder({ location });
    const entry = await publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      resolvedCommit: '1'.repeat(40),
      snapshotRoot: root,
      validation,
      observationOrder,
    });
    const protectedLink = path.join(entry.snapshotRoot, '.agents', 'safe');
    const failure = Object.assign(new Error('injected snapshot symlink EPERM'), { code: 'EPERM' });
    const originalRealpath = fs.realpath.bind(fs);
    vi.spyOn(fs, 'realpath').mockImplementation(async (candidate) => {
      if (path.resolve(String(candidate)) === path.resolve(protectedLink)) throw failure;
      return originalRealpath(candidate);
    });

    await expect(readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      cliVersion: '1.0.0',
    })).rejects.toBe(failure);
    await expect(fs.pathExists(entry.entryDir)).resolves.toBe(true);
    await expect(fs.pathExists(location.quarantineDir)).resolves.toBe(false);
  });

  it.each([1, 2])('retries %s transient root lock release failures', async (failures) => {
    const root = fixturePath(`cache-root-release-retry-${failures}`);
    await createCatalogSnapshotFixture(root);
    const source = { id: 'local', type: 'path' as const, primary: true, path: root };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({
      sourceId: source.id,
      sourceIdentity,
      env: getCurrentSourceTestIsolation().env,
    });
    const attempts: number[] = [];
    catalogSourceCacheInternal.setBeforeReleaseHookForTests(async (lockPath, attempt) => {
      if (lockPath.endsWith(`${path.sep}publication.lock`)) return;
      attempts.push(attempt);
      if (attempt <= failures) throw Object.assign(new Error('transient release'), { code: 'EPERM' });
    });

    await expect(catalogSourceCacheInternal.withCatalogSourceCacheLease({
      env: { ...getCurrentSourceTestIsolation().env, AW_HOME: location.awHomeDir },
      action: async () => 'committed',
    })).resolves.toBe('committed');
    expect(attempts).toEqual(Array.from({ length: failures + 1 }, (_, index) => index + 1));
  });

  it('fails an ordinary cache read when root lock release stays busy and remains reusable', async () => {
    const sourceIdentity = `sha256:${'b'.repeat(64)}`;
    const location = resolveCatalogSourceCacheLocation({
      sourceId: 'local',
      sourceIdentity,
      env: getCurrentSourceTestIsolation().env,
    });
    const warnings: Array<{ message: string; code?: string }> = [];
    let rootLockPath = '';
    vi.spyOn(process, 'emitWarning').mockImplementation((message, options) => {
      warnings.push({
        message: String(message),
        ...(typeof options === 'object' && options && 'code' in options
          ? { code: String(options.code) }
          : {}),
      });
    });
    catalogSourceCacheInternal.setBeforeReleaseHookForTests(async (lockPath) => {
      if (lockPath.endsWith(`${path.sep}publication.lock`)) return;
      rootLockPath = lockPath;
      throw Object.assign(new Error('persistent root busy release'), { code: 'EBUSY' });
    });

    await expect(catalogSourceCacheInternal.withCatalogSourceCacheLease({
      env: { ...getCurrentSourceTestIsolation().env, AW_HOME: location.awHomeDir },
      action: async () => 'read-result',
    })).rejects.toThrow('persistent root busy release');
    expect(warnings).toEqual([]);
    catalogSourceCacheInternal.setBeforeReleaseHookForTests(undefined);
    await expect(catalogSourceCacheInternal.withCatalogSourceCacheLease({
      env: { ...getCurrentSourceTestIsolation().env, AW_HOME: location.awHomeDir },
      action: async () => 'next-read',
    })).resolves.toBe('next-read');
    await expect(fs.pathExists(rootLockPath)).resolves.toBe(false);
  });

  it('keeps the action error primary when root lock release also fails', async () => {
    const sourceIdentity = `sha256:${'c'.repeat(64)}`;
    const location = resolveCatalogSourceCacheLocation({
      sourceId: 'local',
      sourceIdentity,
      env: getCurrentSourceTestIsolation().env,
    });
    class CacheFallbackError extends Error {
      readonly code = 'catalogRemoteUnavailable';
      readonly cacheFallback = true;
    }
    const primary = new CacheFallbackError('primary root action failure');
    let rootLockPath = '';
    catalogSourceCacheInternal.setBeforeReleaseHookForTests(async (lockPath) => {
      if (lockPath.endsWith(`${path.sep}publication.lock`)) return;
      rootLockPath = lockPath;
      throw Object.assign(new Error('secondary root release failure'), { code: 'EPERM' });
    });

    const error = await catalogSourceCacheInternal.withCatalogSourceCacheLease({
      env: { ...getCurrentSourceTestIsolation().env, AW_HOME: location.awHomeDir },
      action: async () => { throw primary; },
    }).catch((caught: unknown) => caught);

    expect(error).toBe(primary);
    expect(error).toMatchObject({ code: 'catalogRemoteUnavailable', cacheFallback: true });
    catalogSourceCacheInternal.setBeforeReleaseHookForTests(undefined);
    await fs.remove(rootLockPath);
  });

  it('keeps a committed selector successful when publication lock release stays busy', async () => {
    const privateReleasePath = '/Users/private/catalog/publication.lock';
    const root = fixturePath('cache-release-committed');
    await createCatalogSnapshotFixture(root);
    const validation = await validateCatalogSnapshot(root);
    const source = { id: 'local', type: 'path' as const, primary: true, path: root };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({
      sourceId: source.id,
      sourceIdentity,
      env: getCurrentSourceTestIsolation().env,
    });
    const observationOrder = await reserveCatalogSourceObservationOrder({ location });
    const warnings: Array<{ message: string; code?: string }> = [];
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation((message, options) => {
      warnings.push({
        message: String(message),
        ...(typeof options === 'object' && options && 'code' in options
          ? { code: String(options.code) }
          : {}),
      });
    });
    catalogSourceCacheInternal.setBeforeReleaseHookForTests(async (lockPath) => {
      if (lockPath.endsWith(`${path.sep}publication.lock`)) {
        throw Object.assign(new Error(`persistent busy release ${privateReleasePath}`), { code: 'EBUSY' });
      }
    });

    await expect(publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef: 'refs/heads/main',
      resolvedCommit: '1'.repeat(40),
      snapshotRoot: root,
      validation,
      observationOrder,
    })).resolves.toMatchObject({ metadata: { sourceId: source.id } });
    expect(warnings).toEqual([expect.objectContaining({
      code: 'AW_CATALOG_CACHE_LOCK_RELEASE_FAILED',
      message: expect.stringContaining('committed selector'),
    })]);
    expect(JSON.stringify(warnings)).not.toContain(privateReleasePath);
    await expect(fs.pathExists(path.join(
      location.selectorsDir,
      selectorFileName('refs/heads/main'),
    ))).resolves.toBe(true);
    warning.mockRestore();
    catalogSourceCacheInternal.setBeforeReleaseHookForTests(undefined);
    await fs.remove(path.join(location.locksDir, 'publication.lock'));
  });

  it('keeps a committed selector successful when the outer root release stays busy', async () => {
    const privateReleasePath = '/Users/private/catalog/root.lock';
    const root = fixturePath('cache-root-release-committed');
    await createCatalogSnapshotFixture(root);
    const validation = await validateCatalogSnapshot(root);
    const source = { id: 'local', type: 'path' as const, primary: true, path: root };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({
      sourceId: source.id,
      sourceIdentity,
      env: getCurrentSourceTestIsolation().env,
    });
    const observationOrder = await reserveCatalogSourceObservationOrder({ location });
    catalogSourceCacheInternal.setBeforeReleaseHookForTests(async (lockPath) => {
      if (!lockPath.endsWith(`${path.sep}publication.lock`)) {
        throw Object.assign(new Error(`persistent root release failure ${privateReleasePath}`), { code: 'EPERM' });
      }
    });
    const warnings: unknown[] = [];
    vi.spyOn(process, 'emitWarning').mockImplementation((message, options) => {
      warnings.push({ message, options });
    });

    await expect(publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef: 'refs/heads/main',
      resolvedCommit: '1'.repeat(40),
      snapshotRoot: root,
      validation,
      observationOrder,
    })).resolves.toMatchObject({ metadata: { sourceId: source.id } });
    await expect(fs.pathExists(path.join(
      location.selectorsDir,
      selectorFileName('refs/heads/main'),
    ))).resolves.toBe(true);
    expect(warnings).toEqual([expect.objectContaining({
      message: expect.stringContaining('root lock'),
      options: expect.objectContaining({ code: 'AW_CATALOG_CACHE_ROOT_LOCK_RELEASE_FAILED' }),
    })]);
    expect(JSON.stringify(warnings)).not.toContain(privateReleasePath);
  });

  it('fails an ordinary publication read on permanent release failure and remains reusable', async () => {
    const location = resolveCatalogSourceCacheLocation({
      sourceId: 'local',
      sourceIdentity: `sha256:${'d'.repeat(64)}`,
      env: getCurrentSourceTestIsolation().env,
    });
    catalogSourceCacheInternal.setBeforeReleaseHookForTests(async (lockPath) => {
      if (lockPath.endsWith(`${path.sep}publication.lock`)) {
        throw Object.assign(new Error('persistent publication release failure'), { code: 'EBUSY' });
      }
    });

    await expect(withCatalogSourceCacheLock({
      location,
      name: 'publication',
      action: async () => 'read-result',
    })).rejects.toThrow('persistent publication release failure');
    catalogSourceCacheInternal.setBeforeReleaseHookForTests(undefined);
    await expect(withCatalogSourceCacheLock({
      location,
      name: 'publication',
      action: async () => 'next-read',
    })).resolves.toBe('next-read');
  });

  it('keeps the action error primary when publication lock release also fails', async () => {
    const sourceIdentity = `sha256:${'a'.repeat(64)}`;
    const location = resolveCatalogSourceCacheLocation({
      sourceId: 'local',
      sourceIdentity,
      env: getCurrentSourceTestIsolation().env,
    });
    const primary = Object.assign(new Error('primary cache action failure'), { code: 'EIO' });
    catalogSourceCacheInternal.setBeforeReleaseHookForTests(async (lockPath) => {
      if (lockPath.endsWith(`${path.sep}publication.lock`)) {
        throw Object.assign(new Error('secondary release failure'), { code: 'EBUSY' });
      }
    });

    const error = await withCatalogSourceCacheLock({
      location,
      name: 'publication',
      action: async () => { throw primary; },
    }).catch((caught: unknown) => caught);

    expect(error).toBe(primary);
    expect(error).toMatchObject({ code: 'EIO' });
    catalogSourceCacheInternal.setBeforeReleaseHookForTests(undefined);
    await fs.remove(path.join(location.locksDir, 'publication.lock'));
  });

  it('treats a valid entry that needs a newer CLI as a non-destructive cache miss', async () => {
    const root = fixturePath('cache-cli-compatibility');
    await createCatalogSnapshotFixture(root, 'demo', '2.0.0');
    const validation = await validateCatalogSnapshot(root);
    const source = { id: 'local', type: 'path' as const, primary: true, path: root };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({
      sourceId: source.id,
      sourceIdentity,
      env: getCurrentSourceTestIsolation().env,
    });
    const requestedRef = 'refs/heads/main';
    const observationOrder = await reserveCatalogSourceObservationOrder({ location });
    const entry = await publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      resolvedCommit: '2'.repeat(40),
      snapshotRoot: root,
      validation,
      observationOrder,
    });
    const selectorPath = path.join(location.selectorsDir, selectorFileName(requestedRef));
    const metadataPath = path.join(entry.entryDir, 'metadata.json');
    const completePath = path.join(entry.entryDir, 'complete.json');
    const before = await Promise.all([
      fs.readFile(selectorPath),
      fs.readFile(metadataPath),
      fs.readFile(completePath),
    ]);

    await expect(readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      cliVersion: '1.0.0',
    })).resolves.toBeNull();
    await expect(Promise.all([
      fs.readFile(selectorPath),
      fs.readFile(metadataPath),
      fs.readFile(completePath),
    ])).resolves.toEqual(before);
    await expect(fs.pathExists(entry.entryDir)).resolves.toBe(true);

    await expect(readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      cliVersion: '2.0.0',
    })).resolves.toMatchObject({
      metadata: { entryKey: entry.metadata.entryKey },
    });
  });

  it('does not share the observation lock across different sources', async () => {
    const firstRoot = fixturePath('observation-source-first');
    const secondRoot = fixturePath('observation-source-second');
    await Promise.all([fs.ensureDir(firstRoot), fs.ensureDir(secondRoot)]);
    const firstSource = { id: 'first', type: 'path' as const, primary: true, path: firstRoot };
    const secondSource = { id: 'second', type: 'path' as const, primary: false, path: secondRoot };
    const env = getCurrentSourceTestIsolation().env;
    const firstLocation = resolveCatalogSourceCacheLocation({
      sourceId: firstSource.id,
      sourceIdentity: await calculateCatalogSourceIdentity(firstSource),
      env,
    });
    const secondLocation = resolveCatalogSourceCacheLocation({
      sourceId: secondSource.id,
      sourceIdentity: await calculateCatalogSourceIdentity(secondSource),
      env,
    });
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const first = observeAndReserveCatalogSourceObservation({
      location: firstLocation,
      observe: async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
        return 'first';
      },
    });
    await firstStarted.promise;

    await expect(observeAndReserveCatalogSourceObservation({
      location: secondLocation,
      observe: async () => 'second',
    })).resolves.toMatchObject({ observation: 'second' });
    releaseFirst.resolve();
    await expect(first).resolves.toMatchObject({ observation: 'first' });
  });

  it('publishes complete immutable entries, isolates corrupt entries, and prevents older observations from winning', async () => {
    const root = fixturePath('cache-source');
    await createCatalogSnapshotFixture(root);
    const validation = await validateCatalogSnapshot(root);
    const source = { id: 'local', type: 'path' as const, primary: true, path: root };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({
      sourceId: source.id,
      sourceIdentity,
      env: getCurrentSourceTestIsolation().env,
    });
    const fixedNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    const orders = await Promise.all([
      reserveCatalogSourceObservationOrder({ location }),
      reserveCatalogSourceObservationOrder({ location }),
    ]).finally(() => clock.mockRestore());
    expect(new Set(orders).size).toBe(2);
    const [olderOrder, newerOrder] = [...orders].sort((left, right) => left - right);
    const [newer] = await Promise.all([publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef: 'refs/heads/main',
      resolvedCommit: '2'.repeat(40),
      snapshotRoot: root,
      validation,
      observationOrder: newerOrder,
    }), publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef: 'refs/heads/main',
      resolvedCommit: '1'.repeat(40),
      snapshotRoot: root,
      validation,
      observationOrder: olderOrder,
    })]);
    const selected = await readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef: 'refs/heads/main',
      cliVersion: '1.0.0',
    });
    expect(selected?.metadata.entryKey).toBe(newer.metadata.entryKey);

    await fs.outputFile(path.join(newer.snapshotRoot, 'plugins', 'demo', 'README.md'), 'corrupt');
    await expect(readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef: 'refs/heads/main',
      cliVersion: '1.0.0',
    })).resolves.toBeNull();
    expect((await fs.readdir(location.quarantineDir)).length).toBeGreaterThan(0);
  });

  it('binds each selector order to an immutable observation record', async () => {
    const firstRoot = fixturePath('cache-observation-first');
    const secondRoot = fixturePath('cache-observation-second');
    await Promise.all([
      createCatalogSnapshotFixture(firstRoot, 'demo', '0.0.0', 'first\n'),
      createCatalogSnapshotFixture(secondRoot, 'demo', '0.0.0', 'second\n'),
    ]);
    const [firstValidation, secondValidation] = await Promise.all([
      validateCatalogSnapshot(firstRoot),
      validateCatalogSnapshot(secondRoot),
    ]);
    const source = { id: 'local', type: 'path' as const, primary: true, path: firstRoot };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({
      sourceId: source.id,
      sourceIdentity,
      env: getCurrentSourceTestIsolation().env,
    });
    const requestedRef = 'refs/heads/main';
    const firstOrder = await reserveCatalogSourceObservationOrder({ location });
    const first = await publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      resolvedCommit: '1'.repeat(40),
      snapshotRoot: firstRoot,
      validation: firstValidation,
      observationOrder: firstOrder,
    });
    const secondOrder = await reserveCatalogSourceObservationOrder({ location });
    const second = await publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      resolvedCommit: '2'.repeat(40),
      snapshotRoot: secondRoot,
      validation: secondValidation,
      observationOrder: secondOrder,
    });
    const indexPath = path.join(location.selectorsDir, selectorFileName(requestedRef));
    const tampered = await fs.readJson(indexPath);
    tampered.entryKey = first.metadata.entryKey;
    await fs.writeJson(indexPath, tampered);

    await expect(readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      cliVersion: '1.0.0',
    })).resolves.toBeNull();
    expect((await fs.readdir(location.quarantineDir))
      .filter((entry) => entry.startsWith('selector-'))).toHaveLength(1);

    const repeatedOrder = await reserveCatalogSourceObservationOrder({ location });
    const repeated = await publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      resolvedCommit: '2'.repeat(40),
      snapshotRoot: secondRoot,
      validation: secondValidation,
      observationOrder: repeatedOrder,
    });
    expect(repeated.metadata.entryKey).toBe(second.metadata.entryKey);
    await expect(readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      cliVersion: '1.0.0',
    })).resolves.toMatchObject({ metadata: { entryKey: second.metadata.entryKey } });
    await expect(fs.readJson(path.join(location.observationsDir, `${repeatedOrder}.json`)))
      .resolves.toMatchObject({ entryKey: second.metadata.entryKey, observationOrder: repeatedOrder });

    await fs.remove(path.join(location.observationsDir, `${repeatedOrder}.json`));
    await expect(readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      cliVersion: '1.0.0',
    })).resolves.toBeNull();

    const corruptOrder = await reserveCatalogSourceObservationOrder({ location });
    await publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      resolvedCommit: '2'.repeat(40),
      snapshotRoot: secondRoot,
      validation: secondValidation,
      observationOrder: corruptOrder,
    });
    await fs.writeJson(path.join(location.observationsDir, `${corruptOrder}.json`), {});
    await expect(readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      cliVersion: '1.0.0',
    })).resolves.toBeNull();
    expect((await fs.readdir(location.quarantineDir))
      .filter((entry) => entry.startsWith('selector-'))).toHaveLength(3);
    expect((await fs.readdir(location.quarantineDir))
      .filter((entry) => entry.startsWith('observation-'))).toHaveLength(1);
  });

  it('quarantines a broken cache entry symlink', async () => {
    const root = fixturePath('cache-broken-entry');
    await createCatalogSnapshotFixture(root);
    const validation = await validateCatalogSnapshot(root);
    const source = { id: 'local', type: 'path' as const, primary: true, path: root };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({
      sourceId: source.id,
      sourceIdentity,
      env: getCurrentSourceTestIsolation().env,
    });
    const requestedRef = 'refs/heads/main';
    const observationOrder = await reserveCatalogSourceObservationOrder({ location });
    const entry = await publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      resolvedCommit: '1'.repeat(40),
      snapshotRoot: root,
      validation,
      observationOrder,
    });
    await fs.remove(entry.entryDir);
    await fs.symlink('missing-entry', entry.entryDir);

    await expect(readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      cliVersion: '1.0.0',
    })).resolves.toBeNull();
    await expect(fs.lstat(entry.entryDir)).rejects.toMatchObject({ code: 'ENOENT' });
    const quarantined = (await fs.readdir(location.quarantineDir))
      .find((name) => name.startsWith(`${entry.metadata.entryKey}-`));
    expect(quarantined).toBeDefined();
    expect((await fs.lstat(path.join(location.quarantineDir, quarantined!))).isSymbolicLink()).toBe(true);
  });

  it('isolates MAX_SAFE, identity-mismatched, and dangling selectors before replacement', async () => {
    const root = fixturePath('cache-malicious-selector');
    await createCatalogSnapshotFixture(root);
    const validation = await validateCatalogSnapshot(root);
    const source = { id: 'local', type: 'path' as const, primary: true, path: root };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({
      sourceId: source.id,
      sourceIdentity,
      env: getCurrentSourceTestIsolation().env,
    });
    const requestedRef = 'refs/heads/main';
    const firstOrder = await reserveCatalogSourceObservationOrder({ location });
    const first = await publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      resolvedCommit: '1'.repeat(40),
      snapshotRoot: root,
      validation,
      observationOrder: firstOrder,
    });
    const indexPath = path.join(location.selectorsDir, selectorFileName(requestedRef));
    await fs.writeJson(indexPath, {
      schemaVersion: 1,
      sourceId: source.id,
      sourceIdentity: `sha256:${'f'.repeat(64)}`,
      requestedRef,
      entryKey: first.metadata.entryKey,
      observationOrder: Number.MAX_SAFE_INTEGER,
    });
    await expect(readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      cliVersion: '1.0.0',
    })).resolves.toBeNull();
    const secondOrder = await reserveCatalogSourceObservationOrder({ location });
    const second = await publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      resolvedCommit: '2'.repeat(40),
      snapshotRoot: root,
      validation,
      observationOrder: secondOrder,
    });
    await fs.writeJson(indexPath, {
      schemaVersion: 1,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      entryKey: 'f'.repeat(64),
      observationOrder: Number.MAX_SAFE_INTEGER,
    });
    await expect(readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      cliVersion: '1.0.0',
    })).resolves.toBeNull();
    const thirdOrder = await reserveCatalogSourceObservationOrder({ location });
    const third = await publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      resolvedCommit: '3'.repeat(40),
      snapshotRoot: root,
      validation,
      observationOrder: thirdOrder,
    });

    const selected = await readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      cliVersion: '1.0.0',
    });
    expect(selected?.metadata.entryKey).toBe(third.metadata.entryKey);
    expect(second.metadata.entryKey).not.toBe(first.metadata.entryKey);
    expect((await fs.readdir(location.quarantineDir))
      .filter((entry) => entry.startsWith('selector-'))).toHaveLength(2);
  });

  it.each([0, -1])(
    'isolates selector observationOrder=%s before a valid publication replaces it',
    async (invalidOrder) => {
      const root = fixturePath(`cache-invalid-order-${invalidOrder}`);
      await createCatalogSnapshotFixture(root);
      const validation = await validateCatalogSnapshot(root);
      const source = { id: 'local', type: 'path' as const, primary: true, path: root };
      const sourceIdentity = await calculateCatalogSourceIdentity(source);
      const location = resolveCatalogSourceCacheLocation({
        sourceId: source.id,
        sourceIdentity,
        env: getCurrentSourceTestIsolation().env,
      });
      const requestedRef = 'refs/heads/main';
      const firstOrder = await reserveCatalogSourceObservationOrder({ location });
      const first = await publishCatalogSourceCacheEntry({
        location,
        sourceId: source.id,
        sourceIdentity,
        requestedRef,
        resolvedCommit: '1'.repeat(40),
        snapshotRoot: root,
        validation,
        observationOrder: firstOrder,
      });
      const indexPath = path.join(location.selectorsDir, selectorFileName(requestedRef));
      await fs.writeJson(indexPath, {
        schemaVersion: 1,
        sourceId: source.id,
        sourceIdentity,
        requestedRef,
        entryKey: first.metadata.entryKey,
        observationOrder: invalidOrder,
      });

      await expect(readCatalogSourceCache({
        location,
        sourceId: source.id,
        sourceIdentity,
        requestedRef,
        cliVersion: '1.0.0',
      })).resolves.toBeNull();
      await expect(fs.pathExists(indexPath)).resolves.toBe(false);
      expect((await fs.readdir(location.quarantineDir))
        .filter((entry) => entry.startsWith('selector-'))).toHaveLength(1);

      const nextOrder = await reserveCatalogSourceObservationOrder({ location });
      const replacement = await publishCatalogSourceCacheEntry({
        location,
        sourceId: source.id,
        sourceIdentity,
        requestedRef,
        resolvedCommit: '2'.repeat(40),
        snapshotRoot: root,
        validation,
        observationOrder: nextOrder,
      });
      await expect(readCatalogSourceCache({
        location,
        sourceId: source.id,
        sourceIdentity,
        requestedRef,
        cliVersion: '1.0.0',
      })).resolves.toMatchObject({
        metadata: { entryKey: replacement.metadata.entryKey },
      });
    },
  );

  it('isolates cache roots by both source ID and source identity', async () => {
    const first = fixturePath('cache-identity-first');
    const second = fixturePath('cache-identity-second');
    await Promise.all([createCatalogSnapshotFixture(first), createCatalogSnapshotFixture(second)]);
    const firstIdentity = await calculateCatalogSourceIdentity({
      id: 'same', type: 'path', primary: true, path: first,
    });
    const secondIdentity = await calculateCatalogSourceIdentity({
      id: 'same', type: 'path', primary: true, path: second,
    });
    const env = getCurrentSourceTestIsolation().env;
    const firstLocation = resolveCatalogSourceCacheLocation({ sourceId: 'same', sourceIdentity: firstIdentity, env });
    const secondLocation = resolveCatalogSourceCacheLocation({ sourceId: 'same', sourceIdentity: secondIdentity, env });
    const otherIdLocation = resolveCatalogSourceCacheLocation({ sourceId: 'other', sourceIdentity: firstIdentity, env });
    expect(new Set([firstLocation.rootDir, secondLocation.rootDir, otherIdLocation.rootDir]).size).toBe(3);
  });

  it('rejects symlinked cache state directories before publication', async () => {
    const root = fixturePath('cache-symlink-source');
    const outside = fixturePath('cache-symlink-outside');
    await Promise.all([createCatalogSnapshotFixture(root), fs.ensureDir(outside)]);
    const validation = await validateCatalogSnapshot(root);
    const source = { id: 'local', type: 'path' as const, primary: true, path: root };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({
      sourceId: source.id,
      sourceIdentity,
      env: getCurrentSourceTestIsolation().env,
    });
    await fs.ensureDir(location.rootDir);
    await fs.symlink(outside, location.entriesDir);
    await expect(publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef: 'refs/heads/main',
      resolvedCommit: '1'.repeat(40),
      snapshotRoot: root,
      validation,
      observationOrder: 1,
    })).rejects.toThrow('regular directory');
  });
});

function createProviderResolution(source: CatalogSource) {
  const digest = `sha256:${source.id.charCodeAt(0).toString(16).padStart(2, '0').repeat(32)}`;
  return {
    sourceId: source.id,
    sourceIdentity: `sha256:${'a'.repeat(64)}`,
    requestedRef: 'path',
    resolvedCommit: `path:${source.id}`,
    rootDir: source.type === 'path' ? source.path : fixturePath(source.id),
    manifest: {
      schemaVersion: 3 as const,
      catalogVersion: '1.0.0',
      channel: 'latest' as const,
      compatibility: { aw: { minVersion: '0.0.0' } },
      entries: [],
    },
    manifestDigest: digest,
    snapshotDigest: digest,
    cacheEntryKey: 'b'.repeat(64),
    source: (source.type === 'path' ? 'path' : 'remote') as 'path' | 'remote',
    cacheFallback: false,
  };
}

describe('multi-source catalog resolver and selector APIs', () => {
  it('propagates the original abort while cacheFirst waits for the publication lock', async () => {
    const { remote } = await createGitRemote();
    const source = gitSource(remote, 'main');
    const env = getCurrentSourceTestIsolation().env;
    await resolveGitCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });
    const acquired = deferred();
    const release = deferred();
    const holder = withCatalogSourceCacheLock({
      location,
      name: 'publication',
      action: async () => {
        acquired.resolve();
        await release.promise;
      },
    });
    await acquired.promise;

    const config: CatalogSourcesConfig = { schemaVersion: 1, sources: [source] };
    const reason = new Error('caller cancelled blocked cache read');
    const controller = new AbortController();
    let consumeCalled = false;
    let settled = false;
    const pending = withResolvedMultiSourceCatalog({
      cliVersion: '1.0.0',
      freshnessPolicy: 'cacheFirst',
      configSnapshot: {
        config,
        digest: calculateCatalogSourcesConfigDigest(config),
        materialized: true,
      },
      env,
      signal: controller.signal,
      consume: () => {
        consumeCalled = true;
        return { ok: true };
      },
    });
    const outcome = pending.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    ).finally(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    controller.abort(reason);
    release.resolve();
    await holder;

    await expect(outcome).resolves.toEqual({ status: 'rejected', error: reason });
    expect(consumeCalled).toBe(false);
  });

  it('cancels the whole worker pool when one source observes caller abort', async () => {
    const sources: CatalogSource[] = Array.from({ length: 7 }, (_, index) => ({
      id: `source-${index}`,
      type: 'path',
      primary: index === 0,
      path: fixturePath(`abort-source-${index}`),
    }));
    const config: CatalogSourcesConfig = { schemaVersion: 1, sources };
    const controller = new AbortController();
    const reason = new Error('one worker cancelled the catalog');
    const allStarted = deferred();
    const releaseWorkers = deferred();
    const invoked: string[] = [];
    const resolve = async (source: CatalogSource) => {
      invoked.push(source.id);
      if (invoked.length === 4) allStarted.resolve();
      await releaseWorkers.promise;
      if (source.id === 'source-0') {
        controller.abort(reason);
        throw reason;
      }
      controller.signal.throwIfAborted();
      return createProviderResolution(source);
    };
    let consumeCalled = false;
    const pending = withResolvedMultiSourceCatalog({
      cliVersion: '1.0.0',
      freshnessPolicy: 'cacheFirst',
      configSnapshot: {
        config,
        digest: calculateCatalogSourcesConfigDigest(config),
        materialized: true,
      },
      signal: controller.signal,
      providers: { git: resolve, path: resolve } as CatalogSourceProviderSet,
      consume: () => {
        consumeCalled = true;
        return { ok: true };
      },
    });
    await allStarted.promise;
    releaseWorkers.resolve();

    await expect(pending).rejects.toBe(reason);
    expect(invoked).toEqual(['source-0', 'source-1', 'source-2', 'source-3']);
    expect(consumeCalled).toBe(false);
  });

  it('rejects direct and nested protected paths while allowing projected plain data', async () => {
    const source: CatalogSource = {
      id: 'local',
      type: 'path',
      primary: true,
      path: fixturePath('lease-escape-source'),
    };
    const config = { schemaVersion: 1 as const, sources: [source] };
    const configSnapshot = {
      config,
      digest: calculateCatalogSourcesConfigDigest(config),
      materialized: true,
    };
    const resolve = async (input: CatalogSource) => createProviderResolution(input);
    const common = {
      cliVersion: '1.0.0',
      freshnessPolicy: 'cacheFirst' as const,
      configSnapshot,
      providers: { git: resolve, path: resolve } as CatalogSourceProviderSet,
    };

    await expect(withResolvedMultiSourceCatalog({
      ...common,
      consume: (value) => value,
    })).rejects.toBeInstanceOf(CatalogLeaseEscapeError);
    await expect(withResolvedMultiSourceCatalog({
      ...common,
      consume: (value) => ({ nested: { path: value.sources[0]!.resolution!.rootDir } }),
    })).rejects.toBeInstanceOf(CatalogLeaseEscapeError);
    await expect(withResolvedMultiSourceCatalog({
      ...common,
      consume: (value) => ({ evidence: pathToFileURL(value.sources[0]!.resolution!.rootDir) }),
    })).rejects.toBeInstanceOf(CatalogLeaseEscapeError);
    await expect(withResolvedMultiSourceCatalog({
      ...common,
      consume: (value) => ({
        sourceIds: value.sources.map((item) => item.sourceId),
        digest: value.compositeDigest,
        ok: true,
      }),
    })).resolves.toMatchObject({ sourceIds: ['local'], ok: true });
  });

  it('uses exactly four workers and makes compositeDigest independent of config order', async () => {
    const sources: CatalogSource[] = Array.from({ length: 7 }, (_, index) => ({
      id: `source-${index}`,
      type: 'path',
      primary: index === 0,
      path: fixturePath(`source-${index}`),
    }));
    let active = 0;
    let maxActive = 0;
    const resolve = async (source: CatalogSource) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((done) => setTimeout(done, 20));
      active -= 1;
      return createProviderResolution(source);
    };
    const providers = { git: resolve, path: resolve } as CatalogSourceProviderSet;
    const config = { schemaVersion: 1 as const, sources };
    const digest = calculateCatalogSourcesConfigDigest(config);
    const first = await withResolvedMultiSourceCatalog({
      cliVersion: '1.0.0',
      freshnessPolicy: 'cacheFirst',
      configSnapshot: { config, digest, materialized: true },
      providers,
      consume: (resolution) => ({
        sourceIds: resolution.sources.map((item) => item.sourceId),
        compositeDigest: resolution.compositeDigest,
      }),
    });
    const reversed: CatalogSourcesConfig = { schemaVersion: 1, sources: [...sources].reverse() };
    const second = await withResolvedMultiSourceCatalog({
      cliVersion: '1.0.0',
      freshnessPolicy: 'cacheFirst',
      configSnapshot: { config: reversed, digest, materialized: true },
      providers,
      consume: (resolution) => ({ compositeDigest: resolution.compositeDigest }),
    });
    expect(maxActive).toBe(4);
    expect(first.sourceIds).toEqual([...first.sourceIds].sort());
    expect(second.compositeDigest).toBe(first.compositeDigest);
  });

  it('requires all sources for bare-name uniqueness and only the named source for qualified selection', async () => {
    const first = fixturePath('selector-first');
    const second = fixturePath('selector-second');
    await Promise.all([createCatalogSnapshotFixture(first), createCatalogSnapshotFixture(second)]);
    const config: CatalogSourcesConfig = {
      schemaVersion: 1,
      sources: [
        { id: 'first', type: 'path', primary: true, path: first },
        { id: 'second', type: 'path', primary: false, path: second },
      ],
    };
    const configSnapshot = {
      config,
      digest: calculateCatalogSourcesConfigDigest(config),
      materialized: true,
    };
    const common = {
      cliVersion: '1.0.0',
      freshnessPolicy: 'cacheFirst' as const,
      configSnapshot,
      env: getCurrentSourceTestIsolation().env,
    };
    await expect(withResolvedCatalogPlugin({
      ...common,
      selector: 'demo',
      sourceIds: ['second'],
      consume: () => undefined,
    } as unknown as WithResolvedCatalogPluginOptions<void>)).rejects.toThrow('ambiguous across sources');
    await expect(withResolvedCatalogPlugin({ ...common, selector: 'demo', consume: () => undefined }))
      .rejects.toThrow('ambiguous across sources');
    await fs.remove(first);
    await expect(withResolvedCatalogPlugin({ ...common, selector: 'demo', consume: () => undefined }))
      .rejects.toThrow('Cannot resolve required catalog sources: first');
    await expect(withResolvedCatalogPlugin({
      ...common,
      selector: 'second/demo',
      consume: ({ pluginId, plugin }) => ({ pluginId, pluginName: plugin.manifest.name }),
    })).resolves.toEqual({ pluginId: 'second/demo', pluginName: 'demo' });
    await expect(withResolvedCatalogPlugin({
      ...common,
      selector: 'second/demo',
      consume: (value) => value,
    })).rejects.toBeInstanceOf(CatalogLeaseEscapeError);
    await expect(withResolvedCatalogPlugin({
      ...common,
      selector: 'second/demo',
      consume: ({ plugin }) => ({ evidence: { path: plugin.manifestPath } }),
    })).rejects.toBeInstanceOf(CatalogLeaseEscapeError);
    await expect(withResolvedCatalogPlugin({
      ...common,
      selector: 'second/demo',
      consume: async ({ plugin }) => ({ evidence: await fs.realpath(plugin.rootDir) }),
    })).rejects.toBeInstanceOf(CatalogLeaseEscapeError);
    await expect(withResolvedCatalogPlugin({
      ...common,
      selector: 'second/demo',
      consume: async ({ plugin }) => ({
        evidence: pathToFileURL(await fs.realpath(plugin.manifestPath)),
      }),
    })).rejects.toBeInstanceOf(CatalogLeaseEscapeError);
  });

  it('parses canonical plugin IDs and reports same-target artifact-key collisions', () => {
    expect(parsePluginId('demo')).toEqual({ pluginName: 'demo' });
    expect(parsePluginId('official/demo')).toEqual({ sourceId: 'official', pluginName: 'demo' });
    expect(formatPluginId({ sourceId: 'official', pluginName: 'demo' })).toBe('official/demo');
    expect(() => parsePluginId('official/demo/extra')).toThrow();
    expect(preflightDesiredArtifactCollisions([
      { pluginId: 'first/demo', targetKey: 'codex:project:/repo', artifactKeys: ['skill:review'] },
      { pluginId: 'second/demo', targetKey: 'codex:project:/repo', artifactKeys: ['skill:review'] },
      { pluginId: 'third/demo', targetKey: 'claude:project:/repo', artifactKeys: ['skill:review'] },
    ])).toEqual([{
      targetKey: 'codex:project:/repo',
      artifactKey: 'skill:review',
      pluginIds: ['first/demo', 'second/demo'],
    }]);
  });
});
