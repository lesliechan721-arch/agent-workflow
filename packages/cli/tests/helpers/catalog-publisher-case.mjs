import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { preparePublishedCatalogWorkspace } from '@lesliechan721/aw-plugin-core';

import { runCli } from '../../dist/src/index.js';
import { bundleLocalPlugin, createCatalogRuntimeImportResolver } from '../../dist/scripts/plugin-staging.js';
import { CLI_RESERVED_IMPORTS } from '../../dist/src/utils/manifest.js';
import { applyCatalogPublicationPlan, prepareCatalogPublicationPlan } from '../../dist/src/commands/catalog-publish.js';
import { readCatalogPublicationPluginHistory } from '../../dist/src/commands/catalog-publication-inspection.js';
import { setTestPathFenceHookForTests } from '../../dist/src/utils/test-path-fence.js';
import { execFileNativeCliRunner, setNativeCliRunnerOverrideForTests } from '../../dist/src/utils/native-cli.js';
import { setCodexDiscoveryOverridesForTests } from '../../dist/src/utils/codex-executable-discovery.js';

// These cases need a process boundary so cancellation cannot race fixture removal.
// Use the built product without starting a second Vitest and source module graph.
const [testName, childRoot] = process.argv.slice(2);
assert.ok(testName && childRoot && path.isAbsolute(childRoot));
const execFileAsync = promisify(execFile);
const roots = [];
function canonicalPath(candidate) {
  let ancestor = path.resolve(candidate);
  const missing = [];
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) {
    missing.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  return path.join(fs.realpathSync.native(ancestor), ...missing);
}

const inside = (root, candidate) => {
  const relative = path.relative(canonicalPath(root), canonicalPath(candidate));
  return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
};
assert.ok(inside(childRoot, os.tmpdir()));
assert.ok(inside(childRoot, process.cwd()));
for (const key of ['HOME', 'USERPROFILE', 'AW_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
  assert.ok(process.env[key] && inside(childRoot, process.env[key]), `Unisolated ${key}`);
}
setTestPathFenceHookForTests((check) => {
  assert.ok(inside(childRoot, check.path), `Unsafe ${check.access} from ${check.source}: ${check.path}`);
});
globalThis.fetch = async () => { throw new Error('Network fetch is disabled in publisher tests.'); };
setCodexDiscoveryOverridesForTests({
  macApplicationsDirectories: [],
  queryRunner: async () => ({ exitCode: 0, stdout: '[]', stderr: '' }),
});
setNativeCliRunnerOverrideForTests(async (invocation) => {
  const command = path.basename(invocation.command).toLowerCase().replace(/\.(cmd|exe)$/u, '');
  if (invocation.agentKind !== undefined || ['codex', 'claude'].includes(command)) {
    if (invocation.args.length === 1 && invocation.args[0] === '--version') {
      return { exitCode: 0, stdout: command === 'codex' ? 'codex-cli 0.155.0' : command === 'claude' ? '2.1.292 (Claude Code)' : '0.0.0', stderr: '' };
    }
    throw new Error(`Real native CLI is disabled in publisher tests: ${command}`);
  }
  return execFileNativeCliRunner(invocation);
});

async function stage(label, run) {
  const started = Date.now();
  process.stderr.write(`[catalog-publisher] ${testName}: ${label} start\n`);
  try {
    return await run();
  } finally {
    process.stderr.write(`[catalog-publisher] ${testName}: ${label} end (${Date.now() - started}ms)\n`);
  }
}

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p-'));
  roots.push(root);
  return root;
}

async function git(cwd, args) {
  return (await execFileAsync('git', args, { cwd })).stdout.trim();
}

const quietIo = () => ({ stdout: () => undefined, stderr: () => undefined });

async function createWorkspace(version = '1.0.0', existingRemote) {
  const root = await temporaryRoot();
  const remote = existingRemote ?? await temporaryRoot();
  if (existingRemote === undefined) {
    await git(root, ['init', '--bare', '--quiet', remote]);
  }
  await git(root, ['init', '--quiet']);
  await runCli([
    'dev', 'catalog', 'create', '--workspace-root', root, '--catalog-version', version,
    '--owner-url', 'https://catalog.example.com/journal-test',
  ], { cwd: root, io: quietIo() });
  await runCli([
    'dev', 'plugin', 'create', 'journal-test', '--description', 'Journal test.', '--no-skills',
    '--workspace-root', root,
  ], { cwd: root, io: quietIo() });
  await commitAll(root, 'initial');
  await git(root, ['remote', 'add', 'origin', remote]);
  return { root, remote };
}

async function plan(root, branch = 'catalog/latest') {
  return prepareCatalogPublicationPlan({ workspaceRoot: root, remote: 'origin', branch, env: process.env });
}

async function apply(root, publication) {
  return applyCatalogPublicationPlan({
    workspaceRoot: root, remote: 'origin', branch: publication.branch,
    expectedPlanDigest: publication.planDigest, env: process.env,
  });
}

async function commitAll(root, message) {
  await git(root, ['add', '--all']);
  await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', message]);
}

async function setCatalogVersion(root, version) {
  await runCli(['dev', 'catalog', 'version', version, '--workspace-root', root], { cwd: root, io: quietIo() });
}

async function setPluginVersion(root, version) {
  const manifestPath = path.join(root, 'plugins', 'journal-test', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  await fs.writeJson(manifestPath, { ...manifest, version }, { spaces: 2 });
}

async function addHistoryKeeperPlugin(root) {
  await runCli([
    'dev', 'plugin', 'create', 'history-keeper', '--description', 'History keeper.', '--no-skills',
    '--workspace-root', root,
  ], { cwd: root, io: quietIo() });
}

async function publishedPluginVersion(publication) {
  const manifest = await fs.readJson(path.join(publication.repositoryPath, 'catalog-manifest.json'));
  return manifest.entries.find((entry) => entry.name === 'journal-test')?.version;
}

// Build valid history snapshots without repeating the journal apply contract.
async function publishHistoryFixture({ root, remote, branch = 'catalog/latest', previous }) {
  const prepared = await stage('history.build', async () => preparePublishedCatalogWorkspace({
    workspaceRoot: root, sourceHead: await git(root, ['rev-parse', 'HEAD']),
    previousSnapshotRoot: previous?.repositoryPath, reservedImports: CLI_RESERVED_IMPORTS,
    adapter: { async build(build) {
      await bundleLocalPlugin(build.plugin, build.outputRoot, {
        buildMode: 'staging', runtimeResolver: createCatalogRuntimeImportResolver(build.plugins),
      });
    } },
  }));
  return stage('history.publish', async () => {
    const repository = await temporaryRoot();
    await git(repository, ['init', '--quiet']);
    if (previous) {
      await git(repository, ['fetch', '--quiet', '--no-tags', remote, previous.commit]);
      await git(repository, ['reset', '--soft', 'FETCH_HEAD']);
    }
    await fs.copy(prepared.outputRoot, repository);
    await git(repository, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'add', '--all']);
    const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid'];
    await git(repository, [...identity, 'commit', '--quiet', '-m', `Catalog history ${prepared.catalogVersion}`]);
    const tag = `catalog-v${prepared.catalogVersion}`;
    await git(repository, [...identity, 'tag', '--annotate', tag, '--message', tag]);
    await git(repository, ['push', '--quiet', '--atomic', remote,
      `HEAD:refs/heads/${branch}`, `refs/tags/${tag}:refs/tags/${tag}`]);
    return { repositoryPath: prepared.outputRoot, commit: await git(repository, ['rev-parse', 'HEAD']) };
  });
}

async function runCase() {
  const stableReuse = testName === 'rejects stable Plugin identity reuse and downgrade after a deletion without remote or formal state writes';
  const betaReuse = testName === 'reuses unchanged beta Plugin identity after deletion';
  if (stableReuse || betaReuse) {
    const branch = stableReuse ? 'catalog/latest' : 'catalog/beta';
    const { root, remote } = await stage('createWorkspace', () => createWorkspace(stableReuse ? '1.0.0' : '1.0.0-beta.1'));
    const pluginRoot = path.join(root, 'plugins', 'journal-test');
    const pluginBackup = path.join(await temporaryRoot(), 'journal-test');
    await stage('prepare.original', async () => {
      await addHistoryKeeperPlugin(root);
      if (stableReuse) await setPluginVersion(root, '0.2.0');
      await fs.writeFile(path.join(pluginRoot, 'README.md'), '# Original\n');
      await commitAll(root, 'prepare original plugin');
      await fs.copy(pluginRoot, pluginBackup);
    });
    const first = await stage('publish.original', () => publishHistoryFixture({ root, remote, branch }));
    if (betaReuse) assert.equal(await publishedPluginVersion(first), '0.1.0-beta.1');
    await stage('remove.plugin', async () => {
      await fs.remove(pluginRoot);
      await setCatalogVersion(root, stableReuse ? '1.1.0' : '1.0.0-beta.2');
      await commitAll(root, 'remove plugin');
    });
    const removed = await stage('publish.removed', () => publishHistoryFixture({ root, remote, branch, previous: first }));
    await stage('restore.plugin', async () => {
      await fs.copy(pluginBackup, pluginRoot);
      if (stableReuse) await fs.writeFile(path.join(pluginRoot, 'README.md'), '# Different\n');
      await setCatalogVersion(root, stableReuse ? '1.2.0' : '1.0.0-beta.3');
      await commitAll(root, 'restore plugin');
    });
    if (stableReuse) {
      await stage('reject.reused.version', async () => {
        const before = await git(remote, ['show-ref']);
        await assert.rejects(plan(root), /maps to different content/u);
        assert.equal(await fs.pathExists(path.join(root, '.aw', 'publish', '1.2.0')), false);
        assert.equal(await git(remote, ['show-ref']), before);
      });
      await stage('reject.downgrade', async () => {
        await setPluginVersion(root, '0.1.0');
        await commitAll(root, 'lower readded plugin version');
        const before = await git(remote, ['show-ref']);
        await assert.rejects(plan(root), /must not be lower than previous/u);
        assert.equal(await fs.pathExists(path.join(root, '.aw', 'publish', '1.2.0')), false);
        assert.equal(await git(remote, ['show-ref']), before);
      });
    } else {
      const unchanged = await stage('plan.restored', () => plan(root, branch));
      assert.equal(unchanged.parent, removed.commit);
      assert.equal(await publishedPluginVersion(unchanged), '0.1.0-beta.1');
      assert.equal((await stage('apply.restored', () => apply(root, unchanged))).state, 'published');
    }
    return;
  }
  if (testName === 'rejects a published branch from a different Workspace identity without local or remote writes') {
    const { root: firstRoot, remote } = await stage('createWorkspace.first', () => createWorkspace('1.0.0'));
    const firstPublication = await stage('plan.first', () => plan(firstRoot));
    await stage('apply.first', () => apply(firstRoot, firstPublication));
    const remoteRefsBefore = await stage('read refs', () => git(remote, ['show-ref']));

    const { root: secondRoot } = await stage('createWorkspace.second', () => createWorkspace('1.0.1', remote));
    await stage('verify identities', async () => {
      const [firstMarker, secondMarker] = await Promise.all([
        fs.readJson(path.join(firstRoot, '.aw-workspace.json')),
        fs.readJson(path.join(secondRoot, '.aw-workspace.json')),
      ]);
      assert.notEqual(secondMarker.workspaceIdentity, firstMarker.workspaceIdentity);
    });
    await stage('plan.reject', () => assert.rejects(plan(secondRoot), /different Workspace identity/u));
    await stage('verify no writes', async () => {
      assert.equal(await fs.pathExists(path.join(secondRoot, '.aw', 'publish', '1.0.1')), false);
      assert.equal(await git(remote, ['show-ref']), remoteRefsBefore);
    });
    return;
  }
  if (testName === 'allows a renamed remote alias when its fetch and push identity is unchanged') {
    const { root, remote } = await stage('createWorkspace', () => createWorkspace());
    const publication = await stage('plan', () => plan(root));
    await stage('mutation', async () => {
      await git(root, ['remote', 'add', 'renamed', remote]);
      await git(root, ['remote', 'remove', 'origin']);
    });
    await stage('apply', async () => {
      const result = await applyCatalogPublicationPlan({
        workspaceRoot: root, remote: 'renamed', branch: 'catalog/latest',
        expectedPlanDigest: publication.planDigest, env: process.env,
      });
      assert.equal(result.state, 'published');
      assert.equal(result.remote, 'renamed');
    });
    return;
  }
  const changed = /^rejects a changed (remote identity|branch) during apply$/u.exec(testName)?.[1];
  if (changed) {
    const { root, remote } = await stage('createWorkspace', () => createWorkspace());
    const publication = await stage('plan', () => plan(root));
    const evilRemote = await stage('mutation', async () => {
      if (changed !== 'remote identity') return undefined;
      const alternative = await temporaryRoot();
      await git(root, ['init', '--bare', '--quiet', alternative]);
      await git(root, ['remote', 'set-url', 'origin', alternative]);
      return alternative;
    });
    await stage('apply', () => assert.rejects(applyCatalogPublicationPlan({
      workspaceRoot: root, remote: 'origin', branch: changed === 'branch' ? 'catalog/beta' : 'catalog/latest',
      expectedPlanDigest: publication.planDigest, env: process.env,
    }), /identity changed|Increase/u));
    await stage('verify refs', async () => {
      assert.equal(await git(root, ['ls-remote', remote]), '');
      if (evilRemote !== undefined) assert.equal(await git(root, ['ls-remote', evilRemote]), '');
    });
    return;
  }
  const missing = /^stops when the pending (journal|damaged journal|repository|damaged repository) is missing or damaged$/u.exec(testName)?.[1];
  if (missing) {
    const { root } = await stage('createWorkspace', () => createWorkspace());
    const publication = await stage('plan', () => plan(root));
    await stage('mutation', async () => {
      if (missing === 'journal') await fs.remove(publication.journalPath);
      else if (missing === 'damaged journal') await fs.writeFile(publication.journalPath, '{ damaged');
      else if (missing === 'repository') await fs.remove(publication.repositoryPath);
      else await fs.remove(path.join(publication.repositoryPath, '.git', 'HEAD'));
    });
    await stage('apply', () => assert.rejects(apply(root, publication), /missing|damaged|Increase/u));
    return;
  }
  assert.equal(testName, 'uses only the first-parent Catalog history when a merge second parent has a misleading Plugin entry');
  const { root, remote } = await stage('createWorkspace', () => createWorkspace('1.0.0'));
  const pluginRoot = path.join(root, 'plugins', 'journal-test');
  await addHistoryKeeperPlugin(root);
  await setPluginVersion(root, '0.2.0');
  await fs.writeFile(path.join(pluginRoot, 'README.md'), '# First parent\n');
  await commitAll(root, 'prepare first-parent plugin');
  const backupRoot = await temporaryRoot();
  const pluginBackup = path.join(backupRoot, 'journal-test');
  await fs.copy(pluginRoot, pluginBackup);

  const first = await stage('plan.first', () => plan(root));
  await stage('apply.first', () => apply(root, first));
  await fs.remove(pluginRoot);
  await setCatalogVersion(root, '1.1.0');
  await commitAll(root, 'remove first-parent plugin');
  const removed = await stage('plan.removed', () => plan(root));
  await stage('apply.removed', () => apply(root, removed));

  await fs.copy(pluginBackup, pluginRoot);
  await setPluginVersion(root, '9.9.0');
  await fs.writeFile(path.join(pluginRoot, 'README.md'), '# Misleading second parent\n');
  await setCatalogVersion(root, '9.0.0');
  await commitAll(root, 'prepare misleading branch');
  const misleading = await stage('plan.misleading', () => plan(root, 'catalog/misleading'));
  await stage('apply.misleading', () => apply(root, misleading));

  const firstParent = await git(remote, ['rev-parse', 'refs/heads/catalog/latest']);
  const secondParent = await git(remote, ['rev-parse', 'refs/heads/catalog/misleading']);
  const firstParentTree = await git(remote, ['rev-parse', `${firstParent}^{tree}`]);
  const mergeCommit = await git(remote, [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit-tree', firstParentTree,
    '-p', firstParent,
    '-p', secondParent,
    '-m', 'merge misleading publication history',
  ]);
  await git(remote, [
    'update-ref', 'refs/heads/catalog/latest', mergeCommit, firstParent,
  ]);

  await fs.remove(pluginRoot);
  await fs.copy(pluginBackup, pluginRoot);
  await setCatalogVersion(root, '1.2.0');
  await commitAll(root, 'readd from first-parent history');
  const readded = await stage('plan.readded', () => plan(root));
  assert.equal(readded.parent, mergeCommit);
  assert.equal(await publishedPluginVersion(readded), '0.2.0');
  const officialHistory = await stage('history.read', () => readCatalogPublicationPluginHistory({
    workspaceRoot: root, remoteUrl: remote, branches: ['catalog/latest', 'catalog/beta'], env: process.env,
  }));
  assert.deepEqual(officialHistory.filter((entry) => entry.name === 'journal-test').map((entry) => entry.version), ['0.2.0']);
  await stage('apply.readded', () => apply(root, readded));
}

try {
  await runCase();
} finally {
  // Cancellation terminates this process tree first; the outer scope then removes childRoot.
  await stage('cleanup', () => Promise.all(roots.map((root) => fs.remove(root))));
}
