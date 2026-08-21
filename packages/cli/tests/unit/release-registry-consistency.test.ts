import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertCurrentReleaseIdentity,
  assertReleaseWorktreeClean,
  captureCommand,
  runReleaseGit,
  runCommand,
  resolveCliPublicationGate,
  resolvePublishedCliVersion,
  resolveRegistryUrl,
  withReleaseBuildSnapshot,
} from '../../../../scripts/release/common.mjs';
import {
  computeBuildInputDigest,
  computeCliPackageDigest,
} from '../../../../scripts/build/build-cache.mjs';

const tempRoots: string[] = [];
const execFileAsync = promisify(execFile);

async function createReleaseFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-dirty-tree-'));
  tempRoots.push(root);
  const rootManifest = {
    name: 'release-root',
    scripts: { release: 'node release.mjs' },
  };
  const evalManifest = {
    name: '@example/eval',
    version: '0.9.0',
  };
  const cliManifest = {
    name: '@example/cli',
    version: '0.9.0',
    bin: { aw: 'dist/index.js' },
    files: ['dist'],
    publishConfig: { access: 'public' },
  };
  const releaseScript = 'export function publishRelease() { return true; }\n';
  await fs.mkdir(path.join(root, 'packages', 'agent-skill-eval'), { recursive: true });
  await fs.mkdir(path.join(root, 'packages', 'cli'), { recursive: true });
  await fs.mkdir(path.join(root, 'release'), { recursive: true });
  await fs.mkdir(path.join(root, 'scripts', 'release'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(root, 'README.md'), 'clean\n'),
    fs.writeFile(path.join(root, 'package.json'), `${JSON.stringify(rootManifest, null, 2)}\n`),
    fs.writeFile(
      path.join(root, 'packages', 'agent-skill-eval', 'package.json'),
      `${JSON.stringify(evalManifest, null, 2)}\n`,
    ),
    fs.writeFile(
      path.join(root, 'packages', 'cli', 'package.json'),
      `${JSON.stringify(cliManifest, null, 2)}\n`,
    ),
    fs.writeFile(
      path.join(root, 'scripts', 'release', 'publish-release.mjs'),
      releaseScript,
    ),
    fs.writeFile(
      path.join(root, 'release', 'version-targets.json'),
      `${JSON.stringify({ schemaVersion: 1, cli: '0.9.0', catalog: '0.9.0' }, null, 2)}\n`,
    ),
  ]);
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  await execFileAsync('git', ['add', '--all'], { cwd: root });
  await execFileAsync('git', [
    '-c', 'user.name=Release Test',
    '-c', 'user.email=release-test@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ], { cwd: root });
  return { root, rootManifest, evalManifest, cliManifest };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('CLI release registry URL', () => {
  it('keeps standalone CLI verification on the local Git fetch smoke', async () => {
    const manifest = JSON.parse(
      await fs.readFile(new URL('../../../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const steps = manifest.scripts?.['release:verify:cli']?.split(' && ') ?? [];

    // Static contract exception: standalone CLI verification must include the local bare-Git publish/fetch/provider smoke; behavior test is not suitable because running the public gate executes the full release suite and package-manager subprocesses.
    expect(steps).toContain('pnpm test:smoke:fetch');
    expect(steps.indexOf('pnpm test:smoke:fetch'))
      .toBeGreaterThan(steps.indexOf('pnpm test:smoke:pack:cli'));
  });

  it('allows only explicit version-sync manifests in the combined release precheck', async () => {
    const { root, evalManifest, cliManifest } = await createReleaseFixture();

    await expect(assertReleaseWorktreeClean({ cwd: root })).resolves.toEqual([]);

    await Promise.all([
      fs.writeFile(
        path.join(root, 'packages', 'agent-skill-eval', 'package.json'),
        `${JSON.stringify({ ...evalManifest, version: '1.0.0' }, null, 2)}\n`,
      ),
      fs.writeFile(
        path.join(root, 'packages', 'cli', 'package.json'),
        `${JSON.stringify({ ...cliManifest, version: '1.0.0' }, null, 2)}\n`,
      ),
    ]);
    await expect(assertReleaseWorktreeClean({ cwd: root, allowVersionSync: true }))
      .resolves.toEqual(['packages/agent-skill-eval/package.json', 'packages/cli/package.json']);
    await expect(assertReleaseWorktreeClean({ cwd: root }))
      .rejects.toThrow('Unexpected changes:\n- packages/agent-skill-eval/package.json\n- packages/cli/package.json');

    await fs.writeFile(path.join(root, 'README.md'), 'dirty\n');
    await expect(assertReleaseWorktreeClean({ cwd: root, allowVersionSync: true }))
      .rejects.toThrow('Unexpected changes:\n- README.md');
  });

  it('rejects semantic manifest drift, staged manifests, deletion, rename, and symlinks', async () => {
    const semantic = await createReleaseFixture();
    await fs.writeFile(path.join(semantic.root, 'packages', 'agent-skill-eval', 'package.json'), `${JSON.stringify({
      ...semantic.evalManifest,
      version: '1.0.0',
      exports: { '.': './changed.js' },
    }, null, 2)}\n`);
    await expect(assertReleaseWorktreeClean({ cwd: semantic.root, allowVersionSync: true }))
      .rejects.toThrow('top-level version value');

    const staged = await createReleaseFixture();
    await fs.writeFile(path.join(staged.root, 'packages', 'agent-skill-eval', 'package.json'), `${JSON.stringify({
      ...staged.evalManifest,
      version: '1.0.0',
    }, null, 2)}\n`);
    await execFileAsync('git', ['add', 'packages/agent-skill-eval/package.json'], { cwd: staged.root });
    await expect(assertReleaseWorktreeClean({ cwd: staged.root, allowVersionSync: true }))
      .rejects.toThrow('must be an unstaged regular-file modification');

    const deleted = await createReleaseFixture();
    await fs.rm(path.join(deleted.root, 'packages', 'agent-skill-eval', 'package.json'));
    await expect(assertReleaseWorktreeClean({ cwd: deleted.root, allowVersionSync: true }))
      .rejects.toThrow('must be an unstaged regular-file modification');

    const renamed = await createReleaseFixture();
    await fs.rename(
      path.join(renamed.root, 'packages', 'agent-skill-eval', 'package.json'),
      path.join(renamed.root, 'packages', 'agent-skill-eval', 'package-renamed.json'),
    );
    await expect(assertReleaseWorktreeClean({ cwd: renamed.root, allowVersionSync: true }))
      .rejects.toThrow('Unexpected changes');

    const symlinked = await createReleaseFixture();
    await fs.rm(path.join(symlinked.root, 'packages', 'agent-skill-eval', 'package.json'));
    await fs.symlink('../cli/package.json', path.join(symlinked.root, 'packages', 'agent-skill-eval', 'package.json'));
    await expect(assertReleaseWorktreeClean({ cwd: symlinked.root, allowVersionSync: true }))
      .rejects.toThrow('registered release input contains a symlink: packages/agent-skill-eval/package.json');
  });

  it('ignores repository-redirecting Git environment and verifies the canonical worktree', async () => {
    const fixture = await createReleaseFixture();
    const redirected = await createReleaseFixture();
    await fs.writeFile(path.join(fixture.root, 'README.md'), 'dirty\n');

    const injectedEnv = {
      ...process.env,
      GIT_DIR: path.join(redirected.root, '.git'),
      GIT_WORK_TREE: redirected.root,
      GIT_INDEX_FILE: path.join(redirected.root, '.git', 'index'),
      GIT_COMMON_DIR: path.join(redirected.root, '.git'),
      GIT_NAMESPACE: 'redirected',
    };
    await expect(assertReleaseWorktreeClean({
      cwd: fixture.root,
      env: injectedEnv,
    })).rejects.toThrow('Unexpected changes:\n- README.md');
    await expect(runReleaseGit(['rev-parse', '--show-toplevel'], {
      cwd: fixture.root,
      env: injectedEnv,
    })).resolves.toMatchObject({ stdout: expect.stringContaining(fixture.root) });
  });

  it('rejects assume-unchanged and skip-worktree flags on registered release inputs', async () => {
    const assumed = await createReleaseFixture();
    await execFileAsync(
      'git',
      ['update-index', '--assume-unchanged', 'packages/cli/package.json'],
      { cwd: assumed.root },
    );
    await fs.writeFile(path.join(assumed.root, 'packages', 'cli', 'package.json'), '{}\n');
    await expect(assertReleaseWorktreeClean({ cwd: assumed.root }))
      .rejects.toThrow('assume-unchanged: packages/cli/package.json');

    const skipped = await createReleaseFixture();
    await execFileAsync(
      'git',
      ['update-index', '--skip-worktree', 'package.json'],
      { cwd: skipped.root },
    );
    await fs.writeFile(path.join(skipped.root, 'package.json'), '{}\n');
    await expect(assertReleaseWorktreeClean({ cwd: skipped.root }))
      .rejects.toThrow('skip-worktree: package.json');
  });

  it.each([
    ['--assume-unchanged', 'assume-unchanged'],
    ['--skip-worktree', 'skip-worktree'],
  ])('rejects a hidden modification to publish-release.mjs with %s', async (flag, label) => {
    const fixture = await createReleaseFixture();
    const releaseScriptPath = path.join(
      fixture.root,
      'scripts',
      'release',
      'publish-release.mjs',
    );
    await execFileAsync(
      'git',
      ['update-index', flag, 'scripts/release/publish-release.mjs'],
      { cwd: fixture.root },
    );
    await fs.writeFile(releaseScriptPath, 'export function publishRelease() { return false; }\n');

    await expect(assertReleaseWorktreeClean({ cwd: fixture.root }))
      .rejects.toThrow(`${label}: scripts/release/publish-release.mjs`);
  });

  it('uses the isolated release Git runner when checking hidden index flags', async () => {
    const fixture = await createReleaseFixture();
    const redirected = await createReleaseFixture();
    await execFileAsync(
      'git',
      ['update-index', '--assume-unchanged', 'packages/cli/package.json'],
      { cwd: fixture.root },
    );

    await expect(assertReleaseWorktreeClean({
      cwd: fixture.root,
      env: {
        ...process.env,
        GIT_DIR: path.join(redirected.root, '.git'),
        GIT_WORK_TREE: redirected.root,
        GIT_INDEX_FILE: path.join(redirected.root, '.git', 'index'),
      },
    })).rejects.toThrow('assume-unchanged: packages/cli/package.json');
  });

  it('rejects ignored files that can enter build inputs but permits explicit report outputs', async () => {
    const fixture = await createReleaseFixture();
    await fs.mkdir(path.join(fixture.root, 'packages', 'cli', 'src'), { recursive: true });
    await fs.appendFile(
      path.join(fixture.root, '.git', 'info', 'exclude'),
      'packages/cli/src/ignored-release.ts\nplugins/demo/reports/private.json\n',
    );
    await fs.writeFile(
      path.join(fixture.root, 'packages', 'cli', 'src', 'ignored-release.ts'),
      'export const injected = true;\n',
    );
    await fs.mkdir(path.join(fixture.root, 'plugins', 'demo', 'reports'), { recursive: true });
    await fs.writeFile(
      path.join(fixture.root, 'plugins', 'demo', 'reports', 'private.json'),
      '{}\n',
    );

    await expect(assertReleaseWorktreeClean({ cwd: fixture.root }))
      .rejects.toThrow('Unexpected changes:\n- packages/cli/src/ignored-release.ts');
    await fs.rm(path.join(fixture.root, 'packages', 'cli', 'src', 'ignored-release.ts'));
    await expect(assertReleaseWorktreeClean({ cwd: fixture.root })).resolves.toEqual([]);
  });

  it('rejects clean registered source symlinks before a release snapshot can read their referents', async () => {
    const fixture = await createReleaseFixture();
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-outside-source-'));
    tempRoots.push(outsideRoot);
    await fs.mkdir(path.join(outsideRoot, 'cli', 'src'), { recursive: true });
    await fs.copyFile(
      path.join(fixture.root, 'packages', 'cli', 'package.json'),
      path.join(outsideRoot, 'cli', 'package.json'),
    );
    await fs.writeFile(
      path.join(outsideRoot, 'cli', 'src', 'injected.ts'),
      'export const injected = true;\n',
    );
    await fs.rm(path.join(fixture.root, 'packages'), { recursive: true });
    await fs.symlink(outsideRoot, path.join(fixture.root, 'packages'));
    await execFileAsync('git', ['add', '--all'], { cwd: fixture.root });
    await execFileAsync('git', [
      '-c', 'user.name=Release Test',
      '-c', 'user.email=release-test@example.invalid',
      'commit', '--quiet', '-m', 'track external source link',
    ], { cwd: fixture.root });

    await expect(assertReleaseWorktreeClean({ cwd: fixture.root }))
      .rejects.toThrow('registered release input contains a symlink: packages');

    const snapshotBuilder = vi.fn();
    await expect(withReleaseBuildSnapshot(async () => undefined, {
      repoRoot: fixture.root,
      withBuildSnapshot: snapshotBuilder,
    })).rejects.toThrow('registered release input contains a symlink: packages');
    expect(snapshotBuilder).not.toHaveBeenCalled();
  });

  it('rejects a snapshot that captured transient dirty bytes before the worktree reverted', async () => {
    const { root, cliManifest } = await createReleaseFixture();
    const cliManifestPath = path.join(root, 'packages', 'cli', 'package.json');
    const cleanContents = await fs.readFile(cliManifestPath, 'utf8');
    await fs.writeFile(cliManifestPath, `${JSON.stringify({
      ...cliManifest,
      scripts: { injected: 'node injected.mjs' },
    }, null, 2)}\n`);
    const [inputDigest, cliPackageDigest] = await Promise.all([
      computeBuildInputDigest(root),
      computeCliPackageDigest(root),
    ]);
    await fs.writeFile(cliManifestPath, cleanContents);
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
    const identity = {
      generationId: 'transient-dirty-generation',
      outputDigest: 'snapshot-output',
      inputDigest,
      cliPackageDigest,
      headCommit: stdout.trim(),
    };
    const snapshot = { ...identity };

    await expect(assertCurrentReleaseIdentity(snapshot, identity, {
      repoRoot: root,
      allowVersionSync: false,
    })).rejects.toThrow('live inputDigest');
    await expect(assertReleaseWorktreeClean({ cwd: root })).resolves.toEqual([]);
  });

  it('uses one strict monotonic gate for exact, lower, and same-precedence candidates', () => {
    expect(resolveCliPublicationGate({
      mode: 'latest', candidateVersion: '1.0.0', publishedVersion: '1.0.0',
    })).toEqual({ status: 'already-published', version: '1.0.0' });
    expect(() => resolveCliPublicationGate({
      mode: 'latest', candidateVersion: '0.9.0', publishedVersion: '1.0.0',
    })).toThrow('must be higher than the published latest CLI');
    expect(() => resolveCliPublicationGate({
      mode: 'latest',
      candidateVersion: '1.0.0+candidate',
      publishedVersion: '1.0.0+published',
    })).toThrow('same SemVer precedence but a different version string');
  });
  it('uses the explicit environment registry before package publishConfig', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-registry-'));
    tempRoots.push(root);
    const packageJsonPath = path.join(root, 'package.json');
    await fs.writeFile(packageJsonPath, JSON.stringify({
      publishConfig: { registry: 'https://package.example.test' },
    }));

    await expect(resolveRegistryUrl(packageJsonPath, {
      AW_RELEASE_NPM_REGISTRY_URL: ' https://env.example.test/team ',
    })).resolves.toBe('https://env.example.test/team/');
  });

  it('normalizes package publishConfig and keeps the npmjs default', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-registry-'));
    tempRoots.push(root);
    const configured = path.join(root, 'configured.json');
    const fallback = path.join(root, 'fallback.json');
    await Promise.all([
      fs.writeFile(configured, JSON.stringify({
        publishConfig: { registry: ' https://package.example.test/team ' },
      })),
      fs.writeFile(fallback, '{}'),
    ]);

    await expect(resolveRegistryUrl(configured, {})).resolves.toBe('https://package.example.test/team/');
    await expect(resolveRegistryUrl(fallback, {})).resolves.toBe('https://registry.npmjs.org/');
  });

  it.each([
    {
      source: 'AW_RELEASE_NPM_REGISTRY_URL',
      secret: 'env-registry-secret',
      env: (secret: string) => ({
        AW_RELEASE_NPM_REGISTRY_URL: `https://release-user:${secret}@registry.example.test/team`,
      }),
    },
    {
      source: 'npm_config_registry',
      secret: 'lowercase-registry-secret',
      env: (secret: string) => ({
        npm_config_registry: `http://release-user:${secret}@registry.example.test/team`,
      }),
    },
    {
      source: 'NPM_CONFIG_REGISTRY',
      secret: 'uppercase-registry-secret',
      env: (secret: string) => ({
        NPM_CONFIG_REGISTRY: `https://release-user:${secret}@registry.example.test/team`,
      }),
    },
  ])('rejects credentials in $source without exposing the secret', async ({ secret, env }) => {
    let failure;
    try {
      await resolveRegistryUrl('/tmp/release-package.json', env(secret));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain('npm config');
    expect(failure.message).not.toContain(secret);
  });

  it('rejects credentials in package publishConfig without exposing the secret', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-registry-'));
    tempRoots.push(root);
    const secret = 'publish-config-registry-secret';
    const packageJsonPath = path.join(root, 'package.json');
    await fs.writeFile(packageJsonPath, JSON.stringify({
      publishConfig: {
        registry: `https://release-user:${secret}@registry.example.test/team`,
      },
    }));

    let failure;
    try {
      await resolveRegistryUrl(packageJsonPath, {});
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain('npm config');
    expect(failure.message).not.toContain(secret);
  });

  it.each([
    ['ftp://registry.example.test/team', 'ftp:'],
    ['file:///tmp/npm-registry', 'file:'],
  ])('rejects the unsupported registry URL %s', async (registryUrl, protocol) => {
    let failure;
    try {
      await resolveRegistryUrl('/tmp/release-package.json', {
        AW_RELEASE_NPM_REGISTRY_URL: registryUrl,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain('HTTP(S)');
    expect(failure.message).toContain(protocol);
  });

  it('rejects userinfo before an unsupported registry protocol without exposing it', async () => {
    const secret = 'ftp-registry-secret';
    let failure;
    try {
      await resolveRegistryUrl('/tmp/release-package.json', {
        AW_RELEASE_NPM_REGISTRY_URL: `ftp://release-user:${secret}@registry.example.test/team`,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain('npm config');
    expect(failure.message).not.toContain('ftp:');
    expect(failure.message).not.toContain(secret);
  });

  it('rejects an invalid registry URL without retaining its secret input', async () => {
    const secret = 'invalid-registry-secret';
    let failure;
    try {
      await resolveRegistryUrl('/tmp/release-package.json', {
        AW_RELEASE_NPM_REGISTRY_URL: `https://release-user:${secret}@`,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain('valid HTTP(S) URL');
    expect(failure.message).not.toContain(secret);
    expect(failure).not.toHaveProperty('cause');
  });

  it('redacts registry URL userinfo from failed command diagnostics', async () => {
    const secret = 'command-registry-secret';
    const registryUrl = `https://release-user:${secret}@registry.example.test/team`;
    const stderr = `request failed for ${registryUrl}\n`;
    const script = `process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 7;`;

    let captureFailure;
    try {
      await captureCommand(process.execPath, ['-e', script, registryUrl], { stdio: 'ignore' });
    } catch (error) {
      captureFailure = error;
    }
    expect(captureFailure).toBeInstanceOf(Error);
    expect(captureFailure.message).toContain('Command failed');
    expect(captureFailure.message).not.toContain(secret);
    expect(captureFailure.message).toContain('https://<redacted>@registry.example.test/team');

    let runFailure;
    try {
      await runCommand(process.execPath, ['-e', 'process.exitCode = 7;', registryUrl], {
        stdio: 'ignore',
      });
    } catch (error) {
      runFailure = error;
    }
    expect(runFailure).toBeInstanceOf(Error);
    expect(runFailure.message).toContain('Command failed');
    expect(runFailure.message).not.toContain(secret);
    expect(runFailure.message).toContain('https://<redacted>@registry.example.test/team');

    const childStderrScript = `process.stderr.write(${JSON.stringify(`${registryUrl}\n`)})`;
    const runnerScript = [
      `import { runCommand } from ${JSON.stringify(new URL('../../../../scripts/release/common.mjs', import.meta.url).href)};`,
      `await runCommand(process.execPath, ['-e', ${JSON.stringify(childStderrScript)}]);`,
    ].join('\n');
    const streamResult = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', runnerScript],
    );
    expect(streamResult.stderr).not.toContain(secret);
    expect(streamResult.stderr).toContain('https://<redacted>@registry.example.test/team');
  });

  it('redacts userinfo for every URL protocol in failed command diagnostics', async () => {
    const secret = 'ftp-command-registry-secret';
    const registryUrl = `ftp://release-user:${secret}@registry.example.test/team`;
    const script = `process.stderr.write(${JSON.stringify(registryUrl)}); process.exitCode = 7;`;

    let captureFailure;
    try {
      await captureCommand(process.execPath, ['-e', script, registryUrl]);
    } catch (error) {
      captureFailure = error;
    }
    expect(captureFailure).toBeInstanceOf(Error);
    expect(captureFailure.message).not.toContain(secret);
    expect(captureFailure.message).toContain('ftp://<redacted>@registry.example.test/team');

    let runFailure;
    try {
      await runCommand(process.execPath, ['-e', 'process.exitCode = 7;', registryUrl], {
        stdio: 'ignore',
      });
    } catch (error) {
      runFailure = error;
    }
    expect(runFailure).toBeInstanceOf(Error);
    expect(runFailure.message).not.toContain(secret);
    expect(runFailure.message).toContain('ftp://<redacted>@registry.example.test/team');
  });

  it.each([
    { mode: 'beta' as const, version: '2.0.0-beta.3' },
    { mode: 'latest' as const, version: '2.0.0+published-build' },
  ])('resolves the current published $mode version from the configured registry', async ({
    mode,
    version,
  }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-registry-'));
    tempRoots.push(root);
    const packageJsonPath = path.join(root, 'package.json');
    await fs.writeFile(packageJsonPath, JSON.stringify({
      publishConfig: { registry: 'https://registry.example.test/team' },
    }));
    const captureCommand = vi.fn(async () => ({ stdout: `${JSON.stringify(version)}\n`, stderr: '' }));

    await expect(resolvePublishedCliVersion(mode, {
      packageJsonPath,
      env: {},
      captureCommand,
    })).resolves.toBe(version);
    expect(captureCommand).toHaveBeenCalledWith('pnpm', [
      'view',
      '@lesliechan721/aw',
      `dist-tags.${mode}`,
      '--json',
      '--registry',
      'https://registry.example.test/team/',
    ], expect.any(Object));
    expect(captureCommand.mock.calls[0]![2]).toMatchObject({
      timeoutMs: expect.any(Number),
    });
  });

  it.each([
    { name: 'a missing dist-tag', stdout: 'null', message: 'did not return' },
    { name: 'invalid JSON', stdout: 'not-json', message: 'invalid JSON' },
    { name: 'a non-strict version', stdout: '"01.0.0"', message: 'Invalid version' },
    { name: 'a stable beta version', stdout: '"1.0.0"', message: 'Expected a prerelease version' },
  ])('fails closed for $name', async ({ stdout, message }) => {
    const captureCommand = vi.fn(async () => ({ stdout, stderr: '' }));
    await expect(resolvePublishedCliVersion('beta', {
      env: {},
      captureCommand,
    })).rejects.toThrow(message);
  });

  it('propagates registry lookup errors', async () => {
    const captureCommand = vi.fn(async () => {
      throw new Error('registry unavailable');
    });
    await expect(resolvePublishedCliVersion('latest', {
      env: {},
      captureCommand,
    })).rejects.toThrow('registry unavailable');
  });
});
