import path from 'node:path';

import { preparePublishedCatalogWorkspace, validatePublishedCatalogSnapshot } from '@lesliechan721/aw-plugin-core';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { bundleLocalPlugin, createCatalogRuntimeImportResolver } from '../../scripts/plugin-staging.js';
import {
  prepareCatalogPublicationPlan,
  type CatalogPublishPlanReceipt,
} from '../../src/commands/catalog-publish.js';
import {
  readCatalogPublicationBranchState,
  readCatalogPublicationPluginHistory,
} from '../../src/commands/catalog-publication-inspection.js';
import { runCli } from '../../src/index.js';
import { CLI_RESERVED_IMPORTS } from '../../src/utils/manifest.js';
import {
  calculateCatalogEntryArtifactDigest,
  calculateCatalogEntryContentDigest,
  calculateCatalogEntryManifestDigest,
} from '../../src/utils/catalog-digests.js';
import { prepareCatalogRelease } from '../../../../scripts/release/catalog-publication.mjs';
import {
  apply,
  createPublisherFixture,
  execFileAsync,
  git,
  plan,
  pushPreparedRef,
  quietIo,
} from '../helpers/catalog-publisher-fixture.js';

const { createWorkspace, temporaryRoot, isolatedPublisherCase } = createPublisherFixture();

async function commitAll(root: string, message: string): Promise<void> {
  await execFileAsync('git', ['add', '--all'], { cwd: root });
  await execFileAsync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', message,
  ], { cwd: root });
}

async function setCatalogVersion(root: string, version: string): Promise<void> {
  await runCli([
    'dev', 'catalog', 'version', version, '--workspace-root', root,
  ], { cwd: root, io: quietIo() });
}

async function setPluginVersion(root: string, version: string): Promise<void> {
  const manifestPath = path.join(root, 'plugins', 'journal-test', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
  await fs.writeJson(manifestPath, { ...manifest, version }, { spaces: 2 });
}

async function addHistoryKeeperPlugin(root: string): Promise<void> {
  await runCli([
    'dev', 'plugin', 'create', 'history-keeper', '--description', 'History keeper.', '--no-skills',
    '--workspace-root', root,
  ], { cwd: root, io: quietIo() });
}

async function publishedPluginVersion(
  publication: Pick<CatalogPublishPlanReceipt, 'repositoryPath'>,
): Promise<string | undefined> {
  const manifest = await fs.readJson(
    path.join(publication.repositoryPath!, 'catalog-manifest.json'),
  ) as { entries: Array<{ name: string; version: string }> };
  return manifest.entries.find((entry) => entry.name === 'journal-test')?.version;
}

// History tests need valid published snapshots and Git ancestry, without repeating journal apply coverage.
async function publishHistoryFixture(options: {
  root: string;
  remote: string;
  branch?: string;
  previous?: { repositoryPath: string; commit: string };
  parent?: string;
  mutateSnapshot?: (snapshotRoot: string) => Promise<void>;
}): Promise<{ repositoryPath: string; commit: string }> {
  const prepared = await preparePublishedCatalogWorkspace({
    workspaceRoot: options.root,
    sourceHead: await git(options.root, ['rev-parse', 'HEAD']),
    previousSnapshotRoot: options.previous?.repositoryPath,
    reservedImports: CLI_RESERVED_IMPORTS,
    adapter: {
      async build(build) {
        await bundleLocalPlugin(build.plugin, build.outputRoot, {
          buildMode: 'staging',
          runtimeResolver: createCatalogRuntimeImportResolver(build.plugins),
        });
      },
    },
  });
  const repository = await temporaryRoot('aw-catalog-history-fixture-');
  await options.mutateSnapshot?.(prepared.outputRoot);
  await git(repository, ['init', '--quiet']);
  const parent = options.parent ?? options.previous?.commit;
  if (parent !== undefined) {
    await git(repository, ['fetch', '--quiet', '--no-tags', options.remote, parent]);
    await git(repository, ['reset', '--soft', 'FETCH_HEAD']);
  }
  await fs.copy(prepared.outputRoot, repository);
  await git(repository, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'add', '--all']);
  const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid'];
  await git(repository, [...identity, 'commit', '--quiet', '-m', `Catalog history ${prepared.catalogVersion}`]);
  const tag = `catalog-v${prepared.catalogVersion}`;
  await git(repository, [...identity, 'tag', '--annotate', tag, '--message', tag]);
  await git(repository, [
    'push', '--quiet', '--atomic', options.remote,
    `HEAD:refs/heads/${options.branch ?? 'catalog/latest'}`,
    `refs/tags/${tag}:refs/tags/${tag}`,
  ]);
  return { repositoryPath: prepared.outputRoot, commit: await git(repository, ['rev-parse', 'HEAD']) };
}

describe('version-scoped Catalog publication journal', { timeout: 30_000 }, () => {
  it('rejects damaged historical snapshot content before creating a new publication plan', async () => {
    const { root, remote } = await createWorkspace();
    const previous = await publishHistoryFixture({ root, remote,
      mutateSnapshot: async (snapshotRoot) => {
        await fs.writeFile(path.join(snapshotRoot, 'plugins', 'journal-test', 'README.md'), 'damaged history\n');
      },
    });
    await setCatalogVersion(root, '1.0.1');
    await commitAll(root, 'advance over damaged history');
    await expect(plan(root)).rejects.toMatchObject({ code: 'remoteSnapshotInvalid',
      message: expect.stringContaining('does not match its plugin bundle') });
    expect(await git(root, ['ls-remote', remote, 'refs/heads/catalog/latest']))
      .toBe(`${previous.commit}\trefs/heads/catalog/latest`);
    await expect(fs.pathExists(path.join(root, '.aw', 'publish', '1.0.1'))).resolves.toBe(false);
  });

  it('publishes a new Catalog over a legacy plugin snapshot without revalidating its plugin contract', async () => {
    const { root, remote } = await createWorkspace();
    const previous = await publishHistoryFixture({ root, remote,
      mutateSnapshot: async (snapshotRoot) => {
        const pluginRoot = path.join(snapshotRoot, 'plugins', 'journal-test');
        const pluginPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
        const plugin = await fs.readJson(pluginPath);
        plugin.marketplace.policy.products = ['CODEX', 'CLAUDE'];
        await fs.writeJson(pluginPath, plugin, { spaces: 2 });
        const manifestPath = path.join(snapshotRoot, 'catalog-manifest.json');
        const manifest = await fs.readJson(manifestPath);
        Object.assign(manifest.entries[0], {
          artifactDigest: await calculateCatalogEntryArtifactDigest(pluginRoot),
          contentDigest: await calculateCatalogEntryContentDigest(pluginRoot),
          manifestDigest: calculateCatalogEntryManifestDigest(plugin),
        });
        await fs.writeJson(manifestPath, manifest, { spaces: 2 });
        await expect(validatePublishedCatalogSnapshot(snapshotRoot)).rejects.toThrow('/marketplace/policy');
      },
    });
    await expect(readCatalogPublicationBranchState({
      workspaceRoot: root, remote: 'origin', branch: 'catalog/latest', env: process.env,
    })).resolves.toMatchObject({ commit: previous.commit, version: '1.0.0' });

    await setCatalogVersion(root, '1.0.1');
    await setPluginVersion(root, '0.1.1');
    await commitAll(root, 'advance the Catalog and migrate the plugin contract');
    const publication = await plan(root);
    expect(publication.parent).toBe(previous.commit);
    await expect(apply(root, publication)).resolves.toMatchObject({ state: 'published' });
    await expect(readCatalogPublicationBranchState({
      workspaceRoot: root, remote: 'origin', branch: publication.branch, env: process.env,
    })).resolves.toMatchObject({ commit: publication.expectedCommit, version: '1.0.1' });
  });

  it('preserves snapshot bytes when user Git settings enable CRLF conversion', async () => {
    await fs.ensureDir(process.env.HOME!);
    await execFileAsync('git', ['config', '--global', 'core.autocrlf', 'true']);
    const { root } = await createWorkspace();
    const manifestPath = path.join(root, 'plugins', 'journal-test', '.agents-plugin', 'plugin.json');
    await fs.remove(manifestPath);
    await git(root, ['checkout', 'HEAD', '--', 'plugins/journal-test/.agents-plugin/plugin.json']);
    expect(await fs.readFile(manifestPath, 'utf8')).toContain('\r\n');
    const publication = await plan(root);
    await expect(apply(root, publication)).resolves.toMatchObject({ state: 'published' });
    await expect(readCatalogPublicationBranchState({
      workspaceRoot: root,
      remote: 'origin',
      branch: publication.branch,
      env: process.env,
    })).resolves.toMatchObject({
      commit: publication.expectedCommit,
      snapshotDigest: publication.snapshotDigest,
    });
    await expect(readCatalogPublicationPluginHistory({
      workspaceRoot: root,
      remote: 'origin',
      branches: [publication.branch],
      env: process.env,
    })).resolves.toMatchObject([{ name: 'journal-test', version: '0.1.0' }]);
    await setCatalogVersion(root, '1.0.1');
    await commitAll(root, 'advance Catalog under CRLF checkout settings');
    await expect(plan(root)).resolves.toMatchObject({ parent: publication.expectedCommit });
  });

  it('uses both official channel histories without changing the publication parent', async () => {
    const { root, remote } = await createWorkspace();
    await addHistoryKeeperPlugin(root);
    await setPluginVersion(root, '1.0.0');
    await commitAll(root, 'prepare official stable plugins');
    const service = { prepareCatalogPublicationPlan, readCatalogPublicationPluginHistory };
    async function officialPlan(mode: 'latest' | 'beta') {
      return prepareCatalogRelease(mode, {
        repoRoot: root, remoteUrl: remote, catalogPublicationService: service,
      }) as Promise<CatalogPublishPlanReceipt>;
    }
    async function changePlugin(name: string, description: string) {
      const manifestPath = path.join(root, 'plugins', name, '.agents-plugin', 'plugin.json');
      const manifest = await fs.readJson(manifestPath);
      await fs.writeJson(manifestPath, { ...manifest, description }, { spaces: 2 });
    }
    // Publish prepared history directly; the promotion below still exercises apply.
    const stable = await officialPlan('latest');
    await pushPreparedRef(stable, 'both');

    await setCatalogVersion(root, '1.0.1-beta.1');
    await changePlugin('history-keeper', 'Changed Q after first stable.');
    await commitAll(root, 'change only Q');
    const firstBeta = await officialPlan('beta');
    expect(firstBeta.parent).toBeNull();
    expect(await publishedPluginVersion(firstBeta)).toBe('1.0.0');
    await pushPreparedRef(firstBeta, 'both');

    await setCatalogVersion(root, '1.0.1-beta.2');
    await changePlugin('journal-test', 'Changed P after first stable.');
    await commitAll(root, 'change P');
    const changedP = await officialPlan('beta');
    expect(changedP.parent).toBe(firstBeta.expectedCommit);
    expect(await publishedPluginVersion(changedP)).toBe('1.0.1-beta.1');
    await pushPreparedRef(changedP, 'both');

    await setCatalogVersion(root, '1.0.1');
    await commitAll(root, 'promote official plugins');
    const promoted = await officialPlan('latest');
    expect(promoted.parent).toBe(stable.expectedCommit);
    expect(await publishedPluginVersion(promoted)).toBe('1.0.1');
    await apply(root, promoted);

    await setCatalogVersion(root, '1.0.2-beta.1');
    await changePlugin('history-keeper', 'Changed Q after promotion.');
    await commitAll(root, 'change only Q after promotion');
    const laterBeta = await officialPlan('beta');
    expect(laterBeta.parent).toBe(changedP.expectedCommit);
    expect(await publishedPluginVersion(laterBeta)).toBe('1.0.1');
    await pushPreparedRef(laterBeta, 'both');

    const backup = path.join(await temporaryRoot('aw-official-plugin-backup-'), 'journal-test');
    await fs.copy(path.join(root, 'plugins', 'journal-test'), backup);
    await fs.remove(path.join(root, 'plugins', 'journal-test'));
    await setCatalogVersion(root, '1.0.2-beta.2');
    await commitAll(root, 'remove P');
    const removed = await officialPlan('beta');
    await pushPreparedRef(removed, 'both');
    await fs.copy(backup, path.join(root, 'plugins', 'journal-test'));
    await setCatalogVersion(root, '1.0.2-beta.3');
    await commitAll(root, 'restore unchanged P');
    const restored = await officialPlan('beta');
    expect(restored.parent).toBe(removed.expectedCommit);
    expect(await publishedPluginVersion(restored)).toBe('1.0.1');
  }, 90_000);

  // Test Value Gate: multi-publication history checks must settle their process
  // tree before timeout cleanup removes the bare remote on Windows.
  it('rejects stable Plugin identity reuse and downgrade after a deletion without remote or formal state writes', async ({ task }) => {
    await isolatedPublisherCase(task.name);
  }, process.platform === 'win32' ? 60_000 : 30_000);

  it('reuses unchanged beta Plugin identity after deletion', async ({ task }) => {
    await isolatedPublisherCase(task.name);
  }, process.platform === 'win32' ? 60_000 : 30_000);

  it('continues beta Plugin identity after repeated deletion and restoration', async () => {
    const { root, remote } = await createWorkspace('1.0.0-beta.1');
    const pluginRoot = path.join(root, 'plugins', 'journal-test');
    await addHistoryKeeperPlugin(root);
    await fs.writeFile(path.join(pluginRoot, 'README.md'), '# Original\n');
    await commitAll(root, 'prepare original beta plugin');
    const backupRoot = await temporaryRoot('aw-catalog-beta-plugin-backup-');
    const pluginBackup = path.join(backupRoot, 'journal-test');
    await fs.copy(pluginRoot, pluginBackup);

    const first = await publishHistoryFixture({ root, remote, branch: 'catalog/beta' });
    expect(await publishedPluginVersion(first)).toBe('0.1.0-beta.1');
    await fs.remove(pluginRoot);
    await setCatalogVersion(root, '1.0.0-beta.2');
    await commitAll(root, 'remove beta plugin');
    const removed = await publishHistoryFixture({ root, remote, branch: 'catalog/beta', previous: first });

    await fs.copy(pluginBackup, pluginRoot);
    await setCatalogVersion(root, '1.0.0-beta.3');
    await commitAll(root, 'readd unchanged beta plugin');
    // Reuse the last present Plugin baseline while keeping the deleted snapshot as Git parent.
    const restored = await publishHistoryFixture({
      root, remote, branch: 'catalog/beta', previous: first, parent: removed.commit,
    });
    expect(await publishedPluginVersion(restored)).toBe('0.1.0-beta.1');

    await fs.remove(pluginRoot);
    await setCatalogVersion(root, '1.0.0-beta.4');
    await commitAll(root, 'remove beta plugin again');
    const removedAgain = await publishHistoryFixture({
      root, remote, branch: 'catalog/beta', previous: restored,
    });
    expect((await git(remote, ['rev-list', '--first-parent', 'refs/heads/catalog/beta'])).split('\n'))
      .toEqual([removedAgain.commit, restored.commit, removed.commit, first.commit]);

    await fs.copy(pluginBackup, pluginRoot);
    await fs.writeFile(path.join(pluginRoot, 'README.md'), '# Different\n');
    await setCatalogVersion(root, '1.0.0-beta.5');
    await commitAll(root, 'readd changed beta plugin');
    const changed = await plan(root, 'catalog/beta');
    expect(changed.parent).toBe(removedAgain.commit);
    expect(await publishedPluginVersion(changed)).toBe('0.1.0-beta.2');
    await expect(apply(root, changed)).resolves.toMatchObject({ state: 'published' });
  });

  it('rejects a regular historical manifest blob with a non-canonical Plugin source before formal or remote writes', async () => {
    const { root, remote } = await createWorkspace('1.0.0');
    const pluginRoot = path.join(root, 'plugins', 'journal-test');
    await addHistoryKeeperPlugin(root);
    await commitAll(root, 'prepare historical plugin');
    const pluginBackup = path.join(await temporaryRoot('aw-catalog-history-source-backup-'), 'journal-test');
    await fs.copy(pluginRoot, pluginBackup);

    const first = await publishHistoryFixture({ root, remote });
    await fs.remove(pluginRoot);
    await setCatalogVersion(root, '1.1.0');
    await commitAll(root, 'remove historical plugin');
    const removed = await publishHistoryFixture({ root, remote, previous: first });

    const rewrite = await temporaryRoot('aw-catalog-history-source-rewrite-');
    await git(path.dirname(rewrite), ['clone', '--quiet', remote, rewrite]);
    await git(rewrite, ['config', 'user.email', 'test@example.invalid']);
    await git(rewrite, ['config', 'user.name', 'AW Test']);
    await git(rewrite, ['checkout', '--quiet', '--detach', first.commit]);
    const historyManifestPath = path.join(rewrite, 'catalog-manifest.json');
    const historyManifest = await fs.readJson(historyManifestPath) as {
      entries: Array<Record<string, unknown>>;
    } & Record<string, unknown>;
    await fs.writeJson(historyManifestPath, {
      ...historyManifest,
      entries: historyManifest.entries.map((entry) => entry.name === 'journal-test'
        ? { ...entry, source: './plugins/history-keeper' }
        : entry),
    }, { spaces: 2 });
    await commitAll(rewrite, 'publish non-canonical historical metadata');
    await git(rewrite, ['read-tree', '--reset', '-u', removed.commit]);
    await commitAll(rewrite, 'restore removed snapshot tree');
    await git(rewrite, ['push', '--quiet', '--force', 'origin', 'HEAD:refs/heads/catalog/latest']);

    await fs.copy(pluginBackup, pluginRoot);
    await setCatalogVersion(root, '1.2.0');
    await commitAll(root, 'readd plugin after invalid history');
    const remoteBefore = await git(remote, ['show-ref']);

    await expect(plan(root)).rejects.toThrow(/source.*does not match its plugin bundle/u);
    await expect(readCatalogPublicationPluginHistory({
      workspaceRoot: root, remoteUrl: remote, branches: ['catalog/latest', 'catalog/beta'], env: process.env,
    })).rejects.toThrow(/source.*does not match its plugin bundle/u);
    await expect(fs.pathExists(path.join(root, '.aw', 'publish', '1.2.0'))).resolves.toBe(false);
    await expect(git(remote, ['show-ref'])).resolves.toBe(remoteBefore);
  });

  it('uses only the first-parent Catalog history when a merge second parent has a misleading Plugin entry', async ({ task }) => {
    await isolatedPublisherCase(task.name);
  }, 90_000);
});
