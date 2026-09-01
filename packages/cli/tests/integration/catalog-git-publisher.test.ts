import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyCatalogPublicationPlan,
  prepareCatalogPublicationPlan,
  type CatalogPublishPlanReceipt,
} from '../../src/commands/catalog-publish.js';
import { runCli } from '../../src/index.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function quietIo() {
  return { stdout: () => undefined, stderr: () => undefined };
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).stdout.trim();
}

async function createWorkspace(version = '1.0.0'): Promise<{ root: string; remote: string }> {
  const root = await temporaryRoot('aw-catalog-journal-workspace-');
  const remote = await temporaryRoot('aw-catalog-journal-remote-');
  await execFileAsync('git', ['init', '--bare', '--quiet', remote]);
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  await runCli([
    'catalog', 'init', '--workspace-root', root, '--catalog-version', version,
    '--owner-url', 'https://catalog.example.com/journal-test',
  ], { cwd: root, io: quietIo() });
  await runCli([
    'plugin', 'init', 'journal-test', '--description', 'Journal test.', '--no-skills',
    '--workspace-root', root,
  ], { cwd: root, io: quietIo() });
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'initial',
  ], { cwd: root });
  await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });
  return { root, remote };
}

async function plan(root: string): Promise<CatalogPublishPlanReceipt> {
  return prepareCatalogPublicationPlan({
    workspaceRoot: root,
    remote: 'origin',
    branch: 'catalog/latest',
    env: process.env,
  });
}

async function apply(root: string, publication: CatalogPublishPlanReceipt) {
  return applyCatalogPublicationPlan({
    workspaceRoot: root,
    remote: 'origin',
    branch: 'catalog/latest',
    expectedPlanDigest: publication.planDigest,
    env: process.env,
  });
}

async function pushPreparedRef(
  publication: CatalogPublishPlanReceipt,
  ref: 'branch' | 'tag',
): Promise<void> {
  const repository = publication.repositoryPath!;
  const source = ref === 'branch'
    ? `${publication.expectedCommit}:refs/heads/${publication.branch}`
    : `refs/tags/${publication.tag}:refs/tags/${publication.tag}`;
  await execFileAsync('git', ['push', '--quiet', publication.pushUrl, source], { cwd: repository });
}

describe('version-scoped Catalog publication journal', { timeout: 30_000 }, () => {
  it('plans from committed HEAD and persists a reduced authorization identity and pending repo', async () => {
    const { root } = await createWorkspace('1.2.3');
    const publication = await plan(root);

    expect(publication).toMatchObject({
      command: 'catalog:publish:plan',
      state: 'prepared',
      catalogVersion: '1.2.3',
      branch: 'catalog/latest',
      tag: 'catalog-v1.2.3',
    });
    expect(Object.keys(publication.descriptor).sort()).toEqual([
      'branch', 'parent', 'remote', 'schemaVersion', 'snapshotDigest', 'sourceHead', 'tag',
      'workspaceIdentity',
    ]);
    await expect(fs.readJson(publication.journalPath)).resolves.toMatchObject({
      state: 'prepared',
      planDigest: publication.planDigest,
      expectedCommit: publication.expectedCommit,
      repository: '1.2.3.repo',
    });
    await expect(fs.pathExists(publication.repositoryPath!)).resolves.toBe(true);
    expect(await git(publication.repositoryPath!, ['remote'])).toBe('');
    expect(await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
    await expect(plan(root)).resolves.toMatchObject({
      state: 'prepared',
      planDigest: publication.planDigest,
      expectedCommit: publication.expectedCommit,
    });
  });

  it('rejects a dirty source before it creates publication state', async () => {
    const { root } = await createWorkspace();
    await fs.outputFile(path.join(root, 'dirty.txt'), 'dirty\n');

    await expect(plan(root)).rejects.toThrow(/clean|dirty/u);
    await expect(fs.pathExists(path.join(root, '.aw', 'publish'))).resolves.toBe(false);
  });

  it.each([
    ['both missing', [] as const, 'atomic'],
    ['both correct', ['branch', 'tag'] as const, 'already-remote'],
    ['tag missing', ['branch'] as const, 'tag'],
    ['branch missing', ['tag'] as const, 'branch'],
  ])('reconciles %s remote refs', async (_name, refs, reconciliation) => {
    const { root, remote } = await createWorkspace();
    const publication = await plan(root);
    for (const ref of refs) await pushPreparedRef(publication, ref);

    const result = await apply(root, publication);

    expect(result.reconciliation).toBe(reconciliation);
    expect(await git(remote, ['rev-parse', `refs/heads/${publication.branch}`]))
      .toBe(publication.expectedCommit);
    expect(await git(remote, ['rev-parse', `${publication.tag}^{commit}`]))
      .toBe(publication.expectedCommit);
    expect(await git(remote, ['cat-file', '-t', `refs/tags/${publication.tag}`])).toBe('tag');
    await expect(fs.readdir(path.dirname(publication.journalPath)))
      .resolves.toEqual(['1.0.0.json']);
    await expect(fs.readJson(publication.journalPath)).resolves.toMatchObject({
      state: 'published',
      repository: null,
      expectedCommit: publication.expectedCommit,
    });
  });

  it('rejects a remote ref conflict without changing the prepared journal', async () => {
    const { root } = await createWorkspace();
    const publication = await plan(root);
    await execFileAsync('git', [
      'push', '--quiet', 'origin', `HEAD:refs/heads/${publication.branch}`,
    ], { cwd: root });

    await expect(apply(root, publication)).rejects.toThrow(/conflict|Increase/u);
    await expect(fs.readJson(publication.journalPath)).resolves.toMatchObject({ state: 'prepared' });
    await expect(fs.pathExists(publication.repositoryPath!)).resolves.toBe(true);
  });

  it('writes uncertain before returning a remote failure, then retries the same plan', async () => {
    const { root, remote } = await createWorkspace();
    const publication = await plan(root);
    const hook = path.join(remote, 'hooks', 'pre-receive');
    await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    await expect(apply(root, publication)).rejects.toThrow('result is uncertain');
    await expect(fs.readJson(publication.journalPath)).resolves.toMatchObject({
      state: 'uncertain',
      planDigest: publication.planDigest,
    });
    await expect(fs.pathExists(publication.repositoryPath!)).resolves.toBe(true);

    await expect(plan(root)).resolves.toMatchObject({
      state: 'uncertain',
      planDigest: publication.planDigest,
    });

    await fs.remove(hook);
    const retried = await apply(root, publication);
    expect(retried.state).toBe('published');
    await expect(fs.pathExists(publication.repositoryPath!)).resolves.toBe(false);
  });

  it('returns the published result for the same plan and rejects a different authorization', async () => {
    const { root } = await createWorkspace();
    const publication = await plan(root);
    await apply(root, publication);

    await expect(applyCatalogPublicationPlan({
      workspaceRoot: root,
      remote: 'origin',
      branch: 'catalog/latest',
      expectedPlanDigest: `sha256:${'f'.repeat(64)}`,
      env: process.env,
    })).rejects.toThrow(/authorized|different plan/u);
    await expect(apply(root, publication)).resolves.toMatchObject({
      state: 'published',
      reconciliation: 'already-published',
    });
    await expect(prepareCatalogPublicationPlan({
      workspaceRoot: root,
      remote: 'origin',
      branch: 'catalog/beta',
      env: process.env,
    })).rejects.toThrow(/identity changed|Increase/u);
  });

  it('returns the published result when a stale pending repository is damaged', async () => {
    const { root } = await createWorkspace();
    const publication = await plan(root);
    await apply(root, publication);
    await fs.outputFile(path.join(publication.repositoryPath!, '.git', 'config'), '[damaged\n');

    await expect(apply(root, publication)).resolves.toMatchObject({
      state: 'published',
      reconciliation: 'already-published',
    });
  });

  it('rechecks the clean source immediately before the first remote write', async () => {
    const { root, remote } = await createWorkspace();
    const publication = await plan(root);

    await expect(applyCatalogPublicationPlan({
      workspaceRoot: root,
      remote: 'origin',
      branch: 'catalog/latest',
      expectedPlanDigest: publication.planDigest,
      env: process.env,
      beforeRemoteWrite: async () => {
        await fs.outputFile(path.join(root, 'late-drift.txt'), 'drift\n');
      },
    })).rejects.toThrow(/clean|dirty/u);
    await expect(fs.readJson(publication.journalPath)).resolves.toMatchObject({ state: 'prepared' });
    expect(await git(root, ['ls-remote', remote])).toBe('');
  });

  it.each(['journal', 'damaged journal', 'repository', 'damaged repository'] as const)(
    'stops when the pending %s is missing or damaged',
    async (missing) => {
      const { root } = await createWorkspace();
      const publication = await plan(root);
      if (missing === 'journal') await fs.remove(publication.journalPath);
      else if (missing === 'damaged journal') await fs.writeFile(publication.journalPath, '{ damaged');
      else if (missing === 'repository') await fs.remove(publication.repositoryPath!);
      else await fs.remove(path.join(publication.repositoryPath!, '.git', 'HEAD'));

      await expect(apply(root, publication)).rejects.toThrow(/missing|damaged|Increase/u);
    },
  );

  it('rejects a pending repository URL rewrite before any remote write', async () => {
    const { root, remote } = await createWorkspace();
    const evilRemote = await temporaryRoot('aw-catalog-journal-evil-remote-');
    await execFileAsync('git', ['init', '--bare', '--quiet', evilRemote]);
    const publication = await plan(root);
    await git(publication.repositoryPath!, [
      'config', `url.${evilRemote}.insteadOf`, publication.pushUrl,
    ]);

    await expect(apply(root, publication)).rejects.toThrow(/missing|damaged|Increase/u);
    expect(await git(root, ['ls-remote', remote])).toBe('');
    expect(await git(root, ['ls-remote', evilRemote])).toBe('');
    await expect(fs.readJson(publication.journalPath)).resolves.toMatchObject({ state: 'prepared' });
  });

  it('rechecks pending repository config immediately before the first remote write', async () => {
    const { root, remote } = await createWorkspace();
    const evilRemote = await temporaryRoot('aw-catalog-journal-late-evil-remote-');
    await execFileAsync('git', ['init', '--bare', '--quiet', evilRemote]);
    const publication = await plan(root);

    await expect(applyCatalogPublicationPlan({
      workspaceRoot: root,
      remote: 'origin',
      branch: 'catalog/latest',
      expectedPlanDigest: publication.planDigest,
      env: process.env,
      beforeRemoteWrite: async () => {
        await git(publication.repositoryPath!, [
          'config', `url.${evilRemote}.insteadOf`, publication.pushUrl,
        ]);
      },
    })).rejects.toThrow(/missing|damaged|Increase/u);
    expect(await git(root, ['ls-remote', remote])).toBe('');
    expect(await git(root, ['ls-remote', evilRemote])).toBe('');
    await expect(fs.readJson(publication.journalPath)).resolves.toMatchObject({ state: 'prepared' });
  });

  it.each(['config symlink', 'object alternates'] as const)(
    'rejects pending repository %s before any remote write',
    async (damage) => {
      const { root, remote } = await createWorkspace();
      const publication = await plan(root);
      const gitRoot = path.join(publication.repositoryPath!, '.git');
      if (damage === 'config symlink') {
        const originalConfig = path.join(gitRoot, 'config.original');
        await fs.rename(path.join(gitRoot, 'config'), originalConfig);
        await fs.symlink(originalConfig, path.join(gitRoot, 'config'));
      } else {
        await fs.outputFile(path.join(gitRoot, 'objects', 'info', 'alternates'), `${root}\n`);
      }

      await expect(apply(root, publication)).rejects.toThrow(/missing|damaged|Increase/u);
      expect(await git(root, ['ls-remote', remote])).toBe('');
    },
  );

  it('does not reuse an immutable tag when its published journal is missing', async () => {
    const { root } = await createWorkspace();
    const publication = await plan(root);
    await pushPreparedRef(publication, 'tag');
    await fs.remove(publication.journalPath);
    await fs.remove(publication.repositoryPath!);

    await expect(plan(root)).rejects.toThrow(/tag|version/u);
  });

  it('does not rebuild a plan when a partial branch write lost its journal and repo', async () => {
    const { root } = await createWorkspace();
    const publication = await plan(root);
    await pushPreparedRef(publication, 'branch');
    await fs.remove(publication.journalPath);
    await fs.remove(publication.repositoryPath!);

    await expect(plan(root)).rejects.toThrow(/without its journal|Increase/u);
    await expect(apply(root, publication)).rejects.toThrow(/missing|occupied|Increase/u);
  });
});
