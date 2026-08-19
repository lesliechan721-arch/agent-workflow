import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CATALOG_CHANNEL_REFS,
  promoteCatalogTag,
  publishStagedCatalog,
  readCatalogPublicationHistory,
  runCatalogGit,
} from '../../../../scripts/release/git-catalog-publisher.mjs';
import { stageCatalogRelease } from '../../../../scripts/release/stage-catalog.mjs';
import * as pluginStaging from '../../scripts/plugin-staging.js';
import * as catalogSnapshot from '../../src/utils/catalog-snapshot.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const catalogModules = { pluginStaging, catalogSnapshot };

async function git(args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
    },
  });
  return String(result.stdout).trim();
}

async function fixtureRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

async function createBareRemote(root: string): Promise<string> {
  const remote = path.join(root, 'catalog.git');
  await git(['init', '--bare', '--quiet', remote]);
  return remote;
}

async function stage(
  root: string,
  catalogVersion: string,
  previousReleaseLedger: pluginStaging.PluginReleaseLedger,
  pluginVersion = '1.0.0',
  readme = 'demo\n',
) {
  const sourceRoot = path.join(root, `source-${catalogVersion}`);
  await createCatalogSnapshotFixture(
    sourceRoot,
    'demo',
    '0.0.0',
    readme,
    (manifest) => { manifest.version = pluginVersion; },
  );
  const publicationRoot = path.join(root, `publication-${catalogVersion}`);
  await fs.ensureDir(publicationRoot);
  const outputRoot = path.join(publicationRoot, '.release', 'catalog-staging', 'catalog');
  return stageCatalogRelease(
    ['--catalog-version', catalogVersion],
    {
      snapshot: {
        root,
        generationId: `generation-${catalogVersion}`,
        outputDigest: `output-${catalogVersion}`,
        cliPackageRoot: path.join(root, 'packages', 'cli'),
        cliDistRoot: path.join(root, 'packages', 'cli', 'dist'),
        catalogOutputRoot: sourceRoot,
      },
      internalOutputRoot: outputRoot,
      previousReleaseLedger,
      catalogModules,
    },
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.remove(directory)));
});

describe('Git catalog publisher', () => {
  it('creates orphan channel roots, one-parent fast-forward commits, independent channels, and annotated tags', async () => {
    const root = await fixtureRoot('aw-catalog-publisher-');
    const remoteUrl = await createBareRemote(root);

    const firstHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const firstStage = await stage(root, '1.0.0', firstHistory.mergedLedger);
    const first = await publishStagedCatalog(firstHistory, firstStage.outputRoot);
    expect((await git(['--git-dir', remoteUrl, 'rev-list', '--parents', '-n', '1', first.commit])).split(' '))
      .toHaveLength(1);
    expect(await git(['--git-dir', remoteUrl, 'cat-file', '-t', 'refs/tags/catalog-v1.0.0']))
      .toBe('tag');

    const secondHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.1.0', remoteUrl, catalogModules,
    });
    const secondStage = await stage(root, '1.1.0', secondHistory.mergedLedger, '1.1.0', 'demo two\n');
    const second = await publishStagedCatalog(secondHistory, secondStage.outputRoot);
    expect((await git(['--git-dir', remoteUrl, 'rev-list', '--parents', '-n', '1', second.commit])).split(' '))
      .toEqual([second.commit, first.commit]);

    const betaHistory = await readCatalogPublicationHistory({
      mode: 'beta', catalogVersion: '2.0.0-beta.1', remoteUrl, catalogModules,
    });
    expect(betaHistory.mergedLedger.records).toHaveLength(2);
    const betaStage = await stage(root, '2.0.0-beta.1', betaHistory.mergedLedger, '2.0.0', 'demo beta\n');
    const beta = await publishStagedCatalog(betaHistory, betaStage.outputRoot);
    expect((await git(['--git-dir', remoteUrl, 'rev-list', '--parents', '-n', '1', beta.commit])).split(' '))
      .toHaveLength(1);
    expect(await git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_CHANNEL_REFS.latest]))
      .toBe(second.commit);
    expect(await git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_CHANNEL_REFS.beta]))
      .toBe(beta.commit);
  });

  it('reuses an identical immutable tag and promotes it with a fast-forward', async () => {
    const root = await fixtureRoot('aw-catalog-tag-retry-');
    const remoteUrl = await createBareRemote(root);
    const history = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const staged = await stage(root, '1.0.0', history.mergedLedger);
    const tagged = await publishStagedCatalog(history, staged.outputRoot, { publicationMode: 'tag' });
    await expect(git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_CHANNEL_REFS.latest]))
      .rejects.toThrow();

    const retryHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const retryStage = await stage(root, '1.0.0', retryHistory.mergedLedger);
    const retry = await publishStagedCatalog(retryHistory, retryStage.outputRoot, { publicationMode: 'tag' });
    expect(retry.idempotent).toBe(true);
    expect(retry.commit).toBe(tagged.commit);
    const promotion = await promoteCatalogTag({
      mode: 'latest',
      catalogVersion: '1.0.0',
      currentCliVersion: '1.0.0',
      remoteUrl,
      catalogModules,
    });
    expect(promotion.promoted).toBe(true);
    expect(await git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_CHANNEL_REFS.latest]))
      .toBe(tagged.commit);
  });

  it('rejects same-version channel drift and existing tag runtime drift', async () => {
    const root = await fixtureRoot('aw-catalog-content-drift-');
    const remoteUrl = await createBareRemote(root);
    const history = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const staged = await stage(root, '1.0.0', history.mergedLedger);
    await publishStagedCatalog(history, staged.outputRoot);

    const retryHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const drifted = await stage(
      root,
      '1.0.0',
      { schemaVersion: 1, records: [] },
      '1.1.0',
      'different runtime\n',
    );
    await expect(publishStagedCatalog(retryHistory, drifted.outputRoot))
      .rejects.toThrow('already published with different runtime content');

    const tagOnlyRoot = await fixtureRoot('aw-catalog-tag-content-drift-');
    const tagOnlyRemote = await createBareRemote(tagOnlyRoot);
    const tagHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '2.0.0', remoteUrl: tagOnlyRemote, catalogModules,
    });
    const tagStage = await stage(tagOnlyRoot, '2.0.0', tagHistory.mergedLedger);
    await publishStagedCatalog(tagHistory, tagStage.outputRoot, { publicationMode: 'tag' });
    const taggedHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '2.0.0', remoteUrl: tagOnlyRemote, catalogModules,
    });
    const tagDrift = await stage(
      tagOnlyRoot,
      '2.0.0',
      { schemaVersion: 1, records: [] },
      '2.0.0',
      'different tagged runtime\n',
    );
    await expect(publishStagedCatalog(taggedHistory, tagDrift.outputRoot, { publicationMode: 'tag' }))
      .rejects.toThrow('maps to different runtime content');
  });

  it('does not publish either ref when the remote does not support atomic push', async () => {
    const root = await fixtureRoot('aw-catalog-no-atomic-');
    const remoteUrl = await createBareRemote(root);
    await git(['--git-dir', remoteUrl, 'config', 'receive.advertiseAtomic', 'false']);
    const history = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const staged = await stage(root, '1.0.0', history.mergedLedger);
    await expect(publishStagedCatalog(history, staged.outputRoot))
      .rejects.toThrow('did not fall back to sequential pushes');
    await expect(git(['--git-dir', remoteUrl, 'show-ref']))
      .rejects.toThrow();
  });

  it('rejects channel rollback and a lightweight catalog tag', async () => {
    const root = await fixtureRoot('aw-catalog-monotonic-');
    const remoteUrl = await createBareRemote(root);
    const initialHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const initialStage = await stage(root, '1.0.0', initialHistory.mergedLedger);
    const initial = await publishStagedCatalog(initialHistory, initialStage.outputRoot);

    const rollbackHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '0.9.0', remoteUrl, catalogModules,
    });
    const rollbackStage = await stage(root, '0.9.0', rollbackHistory.mergedLedger);
    await expect(publishStagedCatalog(rollbackHistory, rollbackStage.outputRoot))
      .rejects.toThrow('must not be lower than published 1.0.0');

    await git(['--git-dir', remoteUrl, 'tag', 'catalog-v1.1.0', initial.commit]);
    await expect(readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.1.0', remoteUrl, catalogModules,
    })).rejects.toThrow('is not an annotated tag');
  });

  it('fails closed when the channel advances after history is read', async () => {
    const root = await fixtureRoot('aw-catalog-concurrency-');
    const remoteUrl = await createBareRemote(root);
    const initialHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const initialStage = await stage(root, '1.0.0', initialHistory.mergedLedger);
    await publishStagedCatalog(initialHistory, initialStage.outputRoot);

    const staleHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.1.0', remoteUrl, catalogModules,
    });
    const staleStage = await stage(root, '1.1.0', staleHistory.mergedLedger, '1.1.0');
    const competing = path.join(root, 'competing');
    await git(['clone', '--quiet', '--branch', 'catalog/latest', remoteUrl, competing]);
    await git(['-C', competing, 'config', 'user.name', 'Concurrent Publisher']);
    await git(['-C', competing, 'config', 'user.email', 'concurrent@example.invalid']);
    await fs.outputFile(path.join(competing, 'concurrent-marker.txt'), 'advanced\n');
    await git(['-C', competing, 'add', 'concurrent-marker.txt']);
    await git(['-C', competing, 'commit', '--quiet', '-m', 'concurrent advance']);
    await git(['-C', competing, 'push', '--quiet', 'origin', `HEAD:${CATALOG_CHANNEL_REFS.latest}`]);
    const concurrentHead = await git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_CHANNEL_REFS.latest]);

    await expect(publishStagedCatalog(staleHistory, staleStage.outputRoot))
      .rejects.toThrow('advanced after release history was read');
    expect(await git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_CHANNEL_REFS.latest]))
      .toBe(concurrentHead);
    await expect(git(['--git-dir', remoteUrl, 'rev-parse', 'refs/tags/catalog-v1.1.0']))
      .rejects.toThrow();
  });

  it('keeps temporary Git metadata inside the publisher repository under injected Git paths', async () => {
    const root = await fixtureRoot('aw-catalog-git-env-');
    const remoteUrl = await createBareRemote(root);
    const externalWorktree = path.join(root, 'external-worktree');
    await git(['init', '--quiet', externalWorktree]);
    await git(['-C', externalWorktree, 'config', 'user.name', 'External Repository']);
    await git(['-C', externalWorktree, 'config', 'user.email', 'external@example.invalid']);
    await fs.outputFile(path.join(externalWorktree, 'sentinel.txt'), 'external\n');
    await git(['-C', externalWorktree, 'add', 'sentinel.txt']);
    await git(['-C', externalWorktree, 'commit', '--quiet', '-m', 'external sentinel']);
    const externalGitDir = path.join(externalWorktree, '.git');
    const refsBefore = await git(['--git-dir', externalGitDir, 'show-ref']);
    const objectsBefore = (await fs.readdir(path.join(externalGitDir, 'objects'), { recursive: true }))
      .sort();
    const injectedEnv = {
      ...process.env,
      GIT_COMMON_DIR: externalGitDir,
      GIT_WORK_TREE: externalWorktree,
      GIT_INDEX_FILE: path.join(externalGitDir, 'index'),
      GIT_OBJECT_DIRECTORY: path.join(externalGitDir, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(externalGitDir, 'objects'),
      GIT_NAMESPACE: 'external-namespace',
    };
    const temporaryGitPaths: string[][] = [];
    const executeRealGit = async (command: string, args: string[], options: Parameters<typeof execFileAsync>[2]) => {
      const result = await execFileAsync(command, args, options);
      if (args[0] === 'init') {
        const paths = await Promise.all([
          ['rev-parse', '--path-format=absolute', '--git-common-dir'],
          ['rev-parse', '--path-format=absolute', '--git-path', 'objects'],
          ['rev-parse', '--path-format=absolute', '--git-path', 'refs'],
        ].map(async (gitArgs) => String((await execFileAsync('git', gitArgs, options)).stdout).trim()));
        temporaryGitPaths.push(paths);
      }
      return result;
    };
    const runGit = (args: string[], options: { cwd?: string } = {}) => runCatalogGit(args, {
      ...options,
      env: injectedEnv,
      execFile: executeRealGit,
    });

    const releaseHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules, runGit,
    });
    const staged = await stage(root, '1.0.0', releaseHistory.mergedLedger);
    await publishStagedCatalog(releaseHistory, staged.outputRoot, { runGit });

    expect(temporaryGitPaths).toHaveLength(2);
    for (const paths of temporaryGitPaths) {
      for (const gitPath of paths) {
        expect(gitPath).toContain(`${path.sep}aw-catalog-publish-`);
        expect(gitPath.startsWith(externalGitDir)).toBe(false);
      }
    }
    expect(await git(['--git-dir', externalGitDir, 'show-ref'])).toBe(refsBefore);
    expect((await fs.readdir(path.join(externalGitDir, 'objects'), { recursive: true })).sort())
      .toEqual(objectsBefore);
  });

  it('rejects embedded HTTPS credentials and invokes Git without a shell in non-interactive mode', async () => {
    const credential = 'catalog-secret-value';
    const credentialError = await readCatalogPublicationHistory({
      mode: 'latest',
      catalogVersion: '1.0.0',
      remoteUrl: `https://publisher:${credential}@example.com/catalog.git`,
      catalogModules,
    }).catch((error) => error);
    expect(credentialError).toBeInstanceOf(Error);
    expect(credentialError.message).toContain('must not contain an embedded token or password');
    expect(credentialError.message).not.toContain(credential);

    const execute = vi.fn(async (_command, _args, options) => {
      expect(options).not.toHaveProperty('shell');
      expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(options.env.GCM_INTERACTIVE).toBe('Never');
      expect(options.env).not.toHaveProperty('GIT_DIR');
      expect(options.env).not.toHaveProperty('GIT_COMMON_DIR');
      expect(options.env).not.toHaveProperty('GIT_NAMESPACE');
      expect(options.env.HOME).toBe('/credential-home');
      expect(options.env.SSH_AUTH_SOCK).toBe('/credential-agent.sock');
      return { stdout: '', stderr: '' };
    });
    await runCatalogGit(['status'], {
      execFile: execute,
      env: {
        ...process.env,
        GIT_DIR: '/tmp/injected',
        GIT_COMMON_DIR: '/tmp/injected-common',
        GIT_NAMESPACE: 'injected',
        HOME: '/credential-home',
        SSH_AUTH_SOCK: '/credential-agent.sock',
      },
    });
    expect(execute).toHaveBeenCalledWith('git', ['status'], expect.any(Object));
  });
});
