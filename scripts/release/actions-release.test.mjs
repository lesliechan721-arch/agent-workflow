import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeBuildInputDigest, computeBuildOutputDigest, computeCliPackageDigest } from '../build/build-cache.mjs';
import { runActionsRelease } from './actions-release.mjs';
import { bytesDigest, extractCandidate } from './candidate-archive.mjs';
import { captureCommand } from './common.mjs';

const packages = [
  ['aw-windows-job-win32-x64', '@lesliechan721/aw-windows-job-win32-x64'],
  ['aw-windows-job-win32-arm64', '@lesliechan721/aw-windows-job-win32-arm64'],
  ['agent-skill-eval', '@lesliechan721/agent-skill-eval'],
  ['plugin-core', '@lesliechan721/aw-plugin-core'],
  ['cli', '@lesliechan721/aw'],
];
const base = '1.2.3';
const version = `${base}-beta.7`;
const tag = `release/cli/v${version}`;

async function json(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-actions-release-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const repoRoot = path.join(temporary, 'source');
  const remote = path.join(temporary, 'remote.git');
  const git = (root, ...args) => captureCommand('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root });
  await git(temporary, 'init', '--initial-branch=main', repoRoot);
  await git(temporary, 'init', '--bare', '--initial-branch=main', remote);
  const packageRoots = [];
  for (const [index, [directory, name]] of packages.entries()) {
    const manifest = {
      name, version: base,
      ...(index === 2 ? { optionalDependencies: {
        [packages[0][1]]: `workspace:${base}`, [packages[1][1]]: `workspace:${base}`,
      } } : {}),
      ...(index === 4 ? { dependencies: {
        [packages[2][1]]: `workspace:${base}`, [packages[3][1]]: `workspace:${base}`,
      } } : {}),
    };
    await json(path.join(repoRoot, 'packages', directory, 'package.json'), manifest);
    const staged = path.join(temporary, 'snapshot', directory);
    await json(path.join(staged, 'package.json'), manifest);
    await fs.mkdir(path.join(staged, 'package'));
    await fs.writeFile(path.join(staged, 'package', 'index.js'), `export const packageIndex = ${index};\n`);
    packageRoots.push(staged);
  }
  await json(path.join(repoRoot, 'release/version-targets.json'), { schemaVersion: 2, cli: base });
  await json(path.join(repoRoot, 'package.json'), { name: 'actions-release-fixture', private: true });
  await fs.writeFile(path.join(repoRoot, '.gitignore'), '.release/\n');
  await fs.writeFile(path.join(repoRoot, 'pnpm-lock.yaml'), [
    "lockfileVersion: '9.0'", 'importers:',
    '  packages/cli:', '    dependencies:',
    ...packages.slice(2, 4).flatMap(([, name]) => [`      '${name}':`, `        specifier: workspace:${base}`, '        version: link:../fixture']),
    '  packages/agent-skill-eval:', '    optionalDependencies:',
    ...packages.slice(0, 2).flatMap(([, name]) => [`      '${name}':`, `        specifier: workspace:${base}`, '        version: link:../fixture']), '',
  ].join('\n'));
  await git(repoRoot, 'add', '.');
  await git(repoRoot, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'source');
  await git(repoRoot, 'remote', 'add', 'origin', remote);
  await git(repoRoot, '-c', 'tag.gpgsign=false', 'tag', tag);
  await git(repoRoot, 'push', 'origin', 'main', `refs/tags/${tag}`);
  const sourceHead = (await git(repoRoot, 'rev-parse', 'HEAD')).stdout.trim();
  const snapshot = {
    generationId: crypto.randomUUID(),
    inputDigest: await computeBuildInputDigest(repoRoot),
    outputDigest: await computeBuildOutputDigest(repoRoot),
    cliPackageDigest: await computeCliPackageDigest(repoRoot),
    windowsX64PackageRoot: packageRoots[0], windowsArm64PackageRoot: packageRoots[1],
    evalPackageRoot: packageRoots[2], corePackageRoot: packageRoots[3], cliPackageRoot: packageRoots[4],
  };
  const pack = (index) => async ({ destination }) => {
    await fs.copyFile(path.join(packageRoots[index], 'package.json'), path.join(packageRoots[index], 'package/package.json'));
    const target = path.join(destination, `${packages[index][0]}.tgz`);
    await captureCommand('tar', ['-czf', target, '-C', packageRoots[index], 'package']);
    return target;
  };
  return { temporary, repoRoot, remote, sourceHead, git, snapshot, pack };
}

// Test Value Gate: the public Actions entry must carry the same candidate from
// preparation to a fresh checkout, without rebuilding or granting another write intent.
test('Actions hands the exact CLI archive to a fresh publisher and saves its consumed intent', async (t) => {
  const value = await fixture(t);
  const { repoRoot, temporary, snapshot, pack } = value;
  const prepared = await runActionsRelease(['prepare', '--product', 'cli', '--tag', tag], {
    repoRoot, log() {}, withSnapshot: async (callback) => callback(snapshot),
    packWindowsJobX64: pack(0), packWindowsJobArm64: pack(1), packEval: pack(2), packCore: pack(3), packCli: pack(4),
  });
  const archive = path.join(temporary, 'candidate.tar');
  await fs.copyFile(path.join(repoRoot, '.release/actions/candidate.tar'), archive);
  assert.equal(bytesDigest(await fs.readFile(archive)), prepared.bundle_digest);
  const publisher = path.join(temporary, 'publisher');
  await value.git(temporary, 'clone', value.remote, publisher);
  assert.equal(await fs.stat(path.join(publisher, '.release')).catch(() => null), null);
  const original = JSON.parse(await fs.readFile(path.join(repoRoot, '.release/prepared/descriptor.json'), 'utf8'));
  const writes = [];
  const published = new Set();
  const options = {
    repoRoot: publisher, registryUrl: 'https://registry.example.invalid/', log() {},
    env: { ...process.env, GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '12', GITHUB_RUN_ATTEMPT: '1' },
    withSnapshot: async () => { throw new Error('Publication must consume the saved candidate without building.'); },
    readPackageVersions: async (name) => published.has(name) ? [version] : [],
    readPackageChannelVersion: async (name) => published.has(name) ? version : null,
    githubRequest: async () => ({ json: async () => ({ workflow_runs: [{
      id: 12, event: 'push', head_sha: value.sourceHead, head_branch: tag,
      head_repository: { full_name: 'owner/repo' }, run_attempt: 1,
    }] }) }),
    runNpmCommand: async (command, args) => {
      assert.equal(command, 'npm');
      assert.equal(args[0], 'publish');
      assert.equal(args[args.indexOf('--tag') + 1], 'beta');
      const manifest = JSON.parse((await captureCommand('tar', ['-xOf', args[1], 'package/package.json'])).stdout);
      const saved = original.npm.packages.find((entry) => entry.name === manifest.name);
      assert.equal(manifest.version, version);
      assert.equal(bytesDigest(await fs.readFile(args[1])), saved.contentDigest);
      const attempt = JSON.parse(await fs.readFile(path.join(publisher, '.release/attempted.json'), 'utf8'));
      assert.equal(attempt.publicationStarted, true);
      published.add(manifest.name);
      writes.push(manifest.name);
    },
  };
  const args = ['publish', '--product', 'cli', '--tag', tag, '--archive', archive, '--digest', prepared.bundle_digest];
  await runActionsRelease(args, options);
  assert.deepEqual(writes, packages.map(([, name]) => name));
  assert.equal((await value.git(publisher, 'ls-remote', 'origin', `refs/tags/cli-v${version}^{}`)).stdout.trim(), `${value.sourceHead}\trefs/tags/cli-v${version}^{}`);
  assert.equal((await value.git(publisher, 'ls-remote', 'origin', 'refs/heads/main')).stdout.trim(), `${value.sourceHead}\trefs/heads/main`);
  const final = path.join(publisher, '.release/actions/final.tar');
  const finalDigest = (await fs.readFile(path.join(publisher, '.release/actions/final/digest.txt'), 'utf8')).trim();
  const restored = path.join(temporary, 'restored-final');
  await extractCandidate(final, restored, finalDigest);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(restored, 'cli/prepared/descriptor.json'), 'utf8')), original);
  assert.equal(JSON.parse(await fs.readFile(path.join(restored, 'cli/attempted.json'), 'utf8')).publicationStarted, true);
  await assert.rejects(runActionsRelease(args, options), /attempt|repair/iu);
  assert.equal(writes.length, 5);
});
