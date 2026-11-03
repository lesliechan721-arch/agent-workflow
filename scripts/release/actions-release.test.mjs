import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeBuildInputDigest, computeBuildOutputDigest, computeCliPackageDigest } from '../build/build-cache.mjs';
import { runActionsRelease } from './actions-release.mjs';
import { bytesDigest, extractCandidate, verifyCandidateDirectory } from './candidate-archive.mjs';
import { captureCommand } from './common.mjs';

const packages = [
  ['agent-skill-eval', '@lesliechan721/agent-skill-eval'],
  ['plugin-core', '@lesliechan721/aw-plugin-core'],
  ['cli', '@lesliechan721/aw'],
  ['aw-windows-job-win32-x64', '@lesliechan721/aw-windows-job-win32-x64'],
  ['aw-windows-job-win32-arm64', '@lesliechan721/aw-windows-job-win32-arm64'],
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
      ...(index >= 3 ? { os: ['win32'], cpu: [index === 3 ? 'x64' : 'arm64'] } : {}),
      ...(index === 0 ? { optionalDependencies: Object.fromEntries(packages.slice(3).map(([, name]) => [name, `workspace:${base}`])) } : {}),
      ...(index === 2 ? { dependencies: {
        [packages[0][1]]: `workspace:${base}`, [packages[1][1]]: `workspace:${base}`,
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
    '  packages/agent-skill-eval:', '    optionalDependencies:',
    ...packages.slice(3).flatMap(([, name]) => [`      '${name}':`, `        specifier: workspace:${base}`, '        version: link:../fixture']),
    '  packages/cli:', '    dependencies:',
    ...packages.slice(0, 2).flatMap(([, name]) => [`      '${name}':`, `        specifier: workspace:${base}`, '        version: link:../fixture']),
    '',
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
    evalPackageRoot: packageRoots[0], corePackageRoot: packageRoots[1], cliPackageRoot: packageRoots[2],
  };
  const pack = (index) => async ({ destination }) => {
    const manifest = JSON.parse(await fs.readFile(path.join(packageRoots[index], 'package.json'), 'utf8'));
    if (index >= 3) manifest.version = version;
    await json(path.join(packageRoots[index], 'package/package.json'), manifest);
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
    prepareWindowsJobTarballs: async ({ destination }) => {
      const root = path.join(temporary, 'native');
      await fs.mkdir(root, { recursive: true });
      for (const file of ['candidate.json', 'reproducibility.json', 'qualification-x64.json', 'qualification-arm64.json']) await fs.writeFile(path.join(root, file), '{}');
      return { root, tarballPaths: await Promise.all([pack(3)({ destination }), pack(4)({ destination })]) };
    },
    assertWindowsJobCandidateEvidence: async () => {},
    packEval: pack(0), packCore: pack(1), packCli: pack(2),
  });
  const archive = path.join(temporary, 'candidate.tar');
  await fs.copyFile(path.join(repoRoot, '.release/actions/candidate.tar'), archive);
  assert.equal(bytesDigest(await fs.readFile(archive)), prepared.bundle_digest);
  const publisher = path.join(temporary, 'publisher');
  await value.git(temporary, 'clone', value.remote, publisher);
  assert.equal(await fs.stat(path.join(publisher, '.release')).catch(() => null), null);
  const original = JSON.parse(await fs.readFile(path.join(repoRoot, '.release/prepared/descriptor.json'), 'utf8'));
  // A new repair run has no native artifact of its own. Its plugin job must
  // consume this exact old CLI archive, even if the first run failed plugins.
  const oldRun = { id: 42, event: 'push', head_sha: value.sourceHead, head_branch: tag,
    head_repository: { full_name: 'owner/repo' }, run_attempt: 1 };
  const oldArtifact = { id: 84, name: `candidate-cli-${version}`, created_at: '2026-10-15T01:00:00Z',
    expired: false, workflow_run: { head_sha: value.sourceHead } };
  const recovery = await runActionsRelease(['inspect', '--product', 'cli', '--tag', tag], {
    repoRoot: publisher, log() {},
    env: { ...process.env, GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '99', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'workflow_dispatch' },
    githubRequest: async (endpoint) => ({ json: async () => endpoint.includes('/artifacts')
      ? { artifacts: endpoint.includes('/runs/42/') ? [oldArtifact] : [] }
      : { workflow_runs: endpoint.includes('event=push') ? [oldRun] : [] } }),
    readArtifactDigest: async (artifact) => { assert.equal(artifact.id, 84); return prepared.bundle_digest; },
  });
  assert.equal(recovery.recovery_run, '42');
  assert.equal(recovery.recovery_artifact, '84');
  assert.equal(recovery.reuse_main_ci, 'false');
  assert.equal(recovery.recovery_archive, 'candidate.tar');
  await runActionsRelease(['unpack', '--archive', archive, '--digest', recovery.recovery_digest], { repoRoot: publisher });
  const pluginCandidate = path.join(publisher, '.release/actions/candidate');
  await verifyCandidateDirectory(pluginCandidate, { product: 'cli', candidateHead: value.sourceHead });
  const pluginDescriptor = JSON.parse(await fs.readFile(path.join(pluginCandidate, 'cli/prepared/descriptor.json'), 'utf8'));
  assert.deepEqual(pluginDescriptor, original);
  assert.equal(pluginDescriptor.npm.packages.length, 5);
  assert.equal(pluginDescriptor.npm.nativeEvidence.length, 4);
  const writes = [];
  const published = new Set();
  const options = {
    assertPublishedCliArtifactsMatch: async (_root, descriptor) => { assert.equal(published.size, 5); assert.equal(descriptor.npm.packages.length, 5); },
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
  assert.deepEqual(writes, [...packages.slice(3), ...packages.slice(0, 3)].map(([, name]) => name));
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

// Test Value Gate: a deferred Catalog source tag must not trigger publication
// until the exact same-batch CLI completion tag and all five packages exist.
test('same-batch Catalog starts only after the exact CLI has completed', async (t) => {
  const value = await fixture(t);
  const { repoRoot, git, sourceHead } = value;
  const catalogVersion = '4.5.6-beta.2';
  const catalogTag = `release/catalog/v${catalogVersion}`;
  const catalogBranch = `release-source/catalog/${catalogVersion}`;
  await json(path.join(repoRoot, 'plugins/marketplace-source.json'), { catalog: { version: catalogVersion } });
  await git(repoRoot, 'add', '.');
  await git(repoRoot, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Catalog source');
  const head = (await git(repoRoot, 'rev-parse', 'HEAD')).stdout.trim();
  await git(repoRoot, 'tag', '-d', tag);
  await git(repoRoot, 'push', 'origin', `:refs/tags/${tag}`);
  await git(repoRoot, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'tag.gpgsign=false', 'tag', '-a', '-m', `Release batch\n\nAW-Catalog: ${catalogTag}`, tag);
  await git(repoRoot, 'branch', catalogBranch);
  await git(repoRoot, 'push', 'origin', 'main', `refs/tags/${tag}`, `refs/heads/${catalogBranch}`);
  const options = { repoRoot, log() {}, readPackageVersions: async () => [version] };
  await assert.rejects(runActionsRelease(['complete-batch', '--product', 'cli', '--tag', tag], options), /must complete/u);
  assert.equal((await git(repoRoot, 'ls-remote', 'origin', `refs/tags/${catalogTag}`)).stdout.trim(), '');
  await git(repoRoot, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'tag.gpgsign=false', 'tag', '-a', '-m', 'CLI complete', `cli-v${version}`, head);
  await git(repoRoot, 'push', 'origin', `refs/tags/cli-v${version}`);
  await runActionsRelease(['complete-batch', '--product', 'cli', '--tag', tag], options);
  const created = (await git(repoRoot, 'ls-remote', 'origin', `refs/tags/${catalogTag}^{}`)).stdout;
  assert.equal(created.trim(), `${head}\trefs/tags/${catalogTag}^{}`);
  assert.notEqual(head, sourceHead);
  assert.match((await git(repoRoot, 'for-each-ref', '--format=%(contents)', `refs/tags/${catalogTag}`)).stdout, new RegExp(`AW-CLI: ${tag}`));
});
