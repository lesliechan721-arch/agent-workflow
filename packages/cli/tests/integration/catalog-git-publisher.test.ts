import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyCatalogPublicationPlan,
  catalogPublicationPlanDigest,
  CATALOG_PUBLICATION_CLEANUP_WARNING,
  persistCatalogPublicationPlan,
  prepareCatalogPublicationPlan,
  type CatalogPublishPlanReceipt,
} from '../../src/commands/catalog-publish.js';
import {
  CatalogPublicationInspectionError,
  disposeCatalogPublicationInspection,
  listCatalogPublicationVersions,
  readCatalogPublicationPluginHistory,
  prepareCatalogPublicationInspection,
} from '../../src/commands/catalog-publication-inspection.js';
import { runCli } from '../../src/index.js';
import { prepareCatalogRelease } from '../../../../scripts/release/catalog-publication.mjs';

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

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (text: string) => { stdout += text; },
      stderr: (text: string) => { stderr += text; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).stdout.trim();
}

async function createWorkspace(
  version = '1.0.0',
  existingRemote?: string,
): Promise<{ root: string; remote: string }> {
  const root = await temporaryRoot('aw-catalog-journal-workspace-');
  const remote = existingRemote ?? await temporaryRoot('aw-catalog-journal-remote-');
  if (existingRemote === undefined) {
    await execFileAsync('git', ['init', '--bare', '--quiet', remote]);
  }
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

async function plan(
  root: string,
  branch = 'catalog/latest',
): Promise<CatalogPublishPlanReceipt> {
  return prepareCatalogPublicationPlan({
    workspaceRoot: root,
    remote: 'origin',
    branch,
    env: process.env,
  });
}

async function apply(root: string, publication: CatalogPublishPlanReceipt) {
  return applyCatalogPublicationPlan({
    workspaceRoot: root,
    remote: 'origin',
    branch: publication.branch,
    expectedPlanDigest: publication.planDigest,
    env: process.env,
  });
}

async function commitAll(root: string, message: string): Promise<void> {
  await execFileAsync('git', ['add', '--all'], { cwd: root });
  await execFileAsync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', message,
  ], { cwd: root });
}

async function setCatalogVersion(root: string, version: string): Promise<void> {
  await runCli([
    'catalog', 'version', version, '--workspace-root', root,
  ], { cwd: root, io: quietIo() });
}

async function setPluginVersion(root: string, version: string): Promise<void> {
  const manifestPath = path.join(root, 'plugins', 'journal-test', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
  await fs.writeJson(manifestPath, { ...manifest, version }, { spaces: 2 });
}

async function addHistoryKeeperPlugin(root: string): Promise<void> {
  await runCli([
    'plugin', 'init', 'history-keeper', '--description', 'History keeper.', '--no-skills',
    '--workspace-root', root,
  ], { cwd: root, io: quietIo() });
}

async function publishedPluginVersion(publication: CatalogPublishPlanReceipt): Promise<string | undefined> {
  const manifest = await fs.readJson(
    path.join(publication.repositoryPath!, 'catalog-manifest.json'),
  ) as { entries: Array<{ name: string; version: string }> };
  return manifest.entries.find((entry) => entry.name === 'journal-test')?.version;
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
    const stable = await officialPlan('latest');
    await apply(root, stable);

    await setCatalogVersion(root, '1.0.1-beta.1');
    await changePlugin('history-keeper', 'Changed Q after first stable.');
    await commitAll(root, 'change only Q');
    const firstBeta = await officialPlan('beta');
    expect(firstBeta.parent).toBeNull();
    expect(await publishedPluginVersion(firstBeta)).toBe('1.0.0');
    await apply(root, firstBeta);

    await setCatalogVersion(root, '1.0.1-beta.2');
    await changePlugin('journal-test', 'Changed P after first stable.');
    await commitAll(root, 'change P');
    const changedP = await officialPlan('beta');
    expect(changedP.parent).toBe(firstBeta.expectedCommit);
    expect(await publishedPluginVersion(changedP)).toBe('1.0.1-beta.1');
    await apply(root, changedP);

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
    await apply(root, laterBeta);

    const backup = path.join(await temporaryRoot('aw-official-plugin-backup-'), 'journal-test');
    await fs.copy(path.join(root, 'plugins', 'journal-test'), backup);
    await fs.remove(path.join(root, 'plugins', 'journal-test'));
    await setCatalogVersion(root, '1.0.2-beta.2');
    await commitAll(root, 'remove P');
    const removed = await officialPlan('beta');
    await apply(root, removed);
    await fs.copy(backup, path.join(root, 'plugins', 'journal-test'));
    await setCatalogVersion(root, '1.0.2-beta.3');
    await commitAll(root, 'restore unchanged P');
    const restored = await officialPlan('beta');
    expect(restored.parent).toBe(removed.expectedCommit);
    expect(await publishedPluginVersion(restored)).toBe('1.0.1');
  }, 90_000);

  it('shows bounded safe Git details for release Catalog version inspection', async () => {
    const root = await temporaryRoot('aw-catalog-version-inspection-');
    const sshFailure = path.join(root, 'ssh-failure.mjs');
    const remoteUrl = 'token@private-release.example:private/repository.git';
    const longDetail = 'x'.repeat(2_500);
    await fs.writeFile(sshFailure, [
      `process.stderr.write('\\u001b[31mCould not resolve hostname private-release.example\\u001b[0m\\u0007\\n');`,
      `process.stderr.write('token=remote-token-secret password\\u0007=control-secret private/repository.git ${longDetail}\\nsecond line\\n');`,
      'process.exit(42);',
    ].join('\n'));

    let failure: unknown;
    try {
      await listCatalogPublicationVersions({
        workspaceRoot: root,
        remoteUrl,
        env: {
          ...process.env,
          GIT_SSH_COMMAND: `"${process.execPath}" "${sshFailure}"`,
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CatalogPublicationInspectionError);
    const error = failure as CatalogPublicationInspectionError;
    expect(error.code).toBe('remoteReadFailed');
    expect(error.message).toMatch(
      /^Could not inspect Catalog publication versions\. Git exited with code \d+: /u,
    );
    expect(error.message).toContain('[remote]');
    expect(error.message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(error.message.length).toBeLessThanOrEqual(
      'Could not inspect Catalog publication versions. Git exited with code 128: '.length + 2_000,
    );
    for (const sensitive of [
      root,
      sshFailure,
      remoteUrl,
      'remote-token-secret',
      'control-secret',
      'token@private-release.example',
      'private-release.example',
      'private/repository.git',
    ]) {
      expect(error.message).not.toContain(sensitive);
    }
  });

  it('returns one typed and sanitized JSON failure from the real publish plan CLI', async () => {
    const { root } = await createWorkspace();
    const credential = 'plan-remote-password';
    const querySecret = 'plan-query-secret';
    const hashSecret = 'plan-hash-secret';
    const remoteUrl = `https://publisher:${credential}@127.0.0.1:1/catalog.git?access_token=${querySecret}#${hashSecret}`;
    await git(root, ['remote', 'set-url', 'origin', remoteUrl]);
    const awHome = path.join(root, 'private-aw-home');
    const output = captureIo();

    const exitCode = await runCli([
      'catalog', 'publish', 'plan', '--workspace-root', root,
      '--remote', 'origin', '--branch', 'catalog/latest', '--json',
    ], {
      cwd: root,
      env: { ...process.env, AW_HOME: awHome },
      io: output.io,
    });

    expect(exitCode).toBe(1);
    const failure = JSON.parse(output.stdout()) as { ok: boolean; code: string; message: string };
    expect(failure).toMatchObject({
      ok: false,
      code: 'remoteReadFailed',
    });
    expect(failure.message).toMatch(
      /^Could not inspect the Catalog publication remote\. Git exited with code \d+: /u,
    );
    expect(failure.message).toContain('[remote]');
    const combined = `${output.stdout()}\n${output.stderr()}`;
    for (const sensitive of [root, awHome, credential, querySecret, hashSecret, remoteUrl]) {
      expect(combined).not.toContain(sensitive);
    }
    expect(output.stderr()).toBe(`${failure.message}\n`);

    const human = captureIo();
    expect(await runCli([
      'catalog', 'publish', 'plan', '--workspace-root', root,
      '--remote', 'origin', '--branch', 'catalog/latest',
    ], {
      cwd: root,
      env: { ...process.env, AW_HOME: awHome },
      io: human.io,
    })).toBe(1);
    expect(human.stdout()).toBe('');
    expect(human.stderr()).toMatch(
      /^Could not inspect the Catalog publication remote\. Git exited with code \d+: /u,
    );
    for (const sensitive of [root, awHome, credential, querySecret, hashSecret, remoteUrl]) {
      expect(human.stderr()).not.toContain(sensitive);
    }
  });

  it('uses the stable fallback code and sanitized message for the real publish apply CLI', async () => {
    const { root } = await createWorkspace();
    const publication = await plan(root);
    const credential = 'apply-remote-password';
    const querySecret = 'apply-query-secret';
    const hashSecret = 'apply-hash-secret';
    const remoteUrl = `https://publisher:${credential}@127.0.0.1:1/catalog.git?access_token=${querySecret}#${hashSecret}`;
    await git(root, ['remote', 'set-url', 'origin', remoteUrl]);
    const awHome = path.join(root, 'private-aw-home');
    const output = captureIo();

    const exitCode = await runCli([
      'catalog', 'publish', 'apply', '--workspace-root', root,
      '--remote', 'origin', '--branch', publication.branch,
      '--expected-plan-digest', publication.planDigest, '--yes', '--json',
    ], {
      cwd: root,
      env: { ...process.env, AW_HOME: awHome },
      interactive: false,
      io: output.io,
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output.stdout())).toEqual({
      ok: false,
      code: 'catalogPublicationFailed',
      message: 'Catalog publication identity changed. Increase the Catalog version and create a new plan.',
    });
    const combined = `${output.stdout()}\n${output.stderr()}`;
    for (const sensitive of [
      root,
      awHome,
      publication.repositoryPath!,
      credential,
      querySecret,
      hashSecret,
      remoteUrl,
    ]) {
      expect(combined).not.toContain(sensitive);
    }
    expect(output.stderr()).toBe(
      'Catalog publication identity changed. Increase the Catalog version and create a new plan.\n',
    );
  });

  it('rejects a published branch from a different Workspace identity without local or remote writes', async () => {
    const { root: firstRoot, remote } = await createWorkspace('1.0.0');
    const firstPublication = await plan(firstRoot);
    await apply(firstRoot, firstPublication);
    const remoteRefsBefore = await git(remote, ['show-ref']);

    const { root: secondRoot } = await createWorkspace('1.0.1', remote);
    const [firstMarker, secondMarker] = await Promise.all([
      fs.readJson(path.join(firstRoot, '.aw-workspace.json')) as Promise<Record<string, unknown>>,
      fs.readJson(path.join(secondRoot, '.aw-workspace.json')) as Promise<Record<string, unknown>>,
    ]);
    expect(secondMarker.workspaceIdentity).not.toBe(firstMarker.workspaceIdentity);

    await expect(plan(secondRoot)).rejects.toThrow(/different Workspace identity/u);
    await expect(fs.pathExists(path.join(secondRoot, '.aw', 'publish', '1.0.1'))).resolves.toBe(false);
    await expect(git(remote, ['show-ref'])).resolves.toBe(remoteRefsBefore);
  });

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
    expect(publication.planDigest)
      .toBe(catalogPublicationPlanDigest(publication.descriptor, publication.expectedCommit));
    const canonicalRoot = await fs.realpath(root);
    expect(publication.journalPath)
      .toBe(path.join(canonicalRoot, '.aw', 'publish', '1.2.3', 'journal.json'));
    expect(publication.repositoryPath)
      .toBe(path.join(canonicalRoot, '.aw', 'publish', '1.2.3', 'repository'));
    await expect(fs.readJson(publication.journalPath)).resolves.toMatchObject({
      schemaVersion: 2,
      state: 'prepared',
      planDigest: publication.planDigest,
      expectedCommit: publication.expectedCommit,
      repository: 'repository',
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

  it('binds the snapshot marker identity even though the marker is outside the snapshot digest', async () => {
    const { root } = await createWorkspace();
    const preparation = await prepareCatalogPublicationInspection({
      workspaceRoot: root,
      remote: 'origin',
      branch: 'catalog/latest',
      env: process.env,
    });
    try {
      const markerPath = path.join(preparation.prepared.outputRoot, '.aw-generated.json');
      const marker = await fs.readJson(markerPath) as Record<string, unknown>;
      marker.workspaceIdentity = 'rewritten-workspace';
      await fs.writeJson(markerPath, marker, { spaces: 2 });

      await expect(persistCatalogPublicationPlan({ preparation }))
        .rejects.toThrow(/identity|binding|changed/u);
      await expect(fs.pathExists(path.join(root, '.aw', 'publish', '1.0.0')))
        .resolves.toBe(false);
    } finally {
      await disposeCatalogPublicationInspection(preparation);
    }
  });

  it('leaves no formal version directory when plan creation fails before the final rename', async () => {
    const { root } = await createWorkspace();

    await expect(prepareCatalogPublicationPlan({
      workspaceRoot: root,
      remote: 'origin',
      branch: 'catalog/latest',
      env: process.env,
      beforeFinalRename: async () => {
        throw new Error('injected pre-rename failure');
      },
    })).rejects.toThrow('injected pre-rename failure');
    await expect(fs.pathExists(path.join(root, '.aw', 'publish', '1.0.0')))
      .resolves.toBe(false);
    await expect(plan(root)).resolves.toMatchObject({ state: 'prepared', catalogVersion: '1.0.0' });
  });

  it('rechecks source cleanliness before the plan version directory becomes formal', async () => {
    const { root } = await createWorkspace();

    await expect(prepareCatalogPublicationPlan({
      workspaceRoot: root,
      remote: 'origin',
      branch: 'catalog/latest',
      env: process.env,
      beforeFinalRename: async () => {
        await fs.outputFile(path.join(root, 'late-plan-drift.txt'), 'drift\n');
      },
    })).rejects.toThrow(/clean|dirty/u);
    await expect(fs.pathExists(path.join(root, '.aw', 'publish', '1.0.0')))
      .resolves.toBe(false);
  });

  it('returns the same plan when another writer atomically installs an equivalent version directory', async () => {
    const { root } = await createWorkspace();
    const publication = await prepareCatalogPublicationPlan({
      workspaceRoot: root,
      remote: 'origin',
      branch: 'catalog/latest',
      env: process.env,
      beforeFinalRename: async ({ temporaryStateRoot, finalStateRoot }) => {
        await fs.copy(temporaryStateRoot, finalStateRoot, { dereference: false, errorOnExist: true });
      },
    });

    expect(publication).toMatchObject({ state: 'prepared', catalogVersion: '1.0.0' });
    await expect(fs.pathExists(publication.repositoryPath!)).resolves.toBe(true);
  });

  it('rejects a concurrent version directory that contains a different valid plan', async () => {
    const { root } = await createWorkspace();

    await expect(prepareCatalogPublicationPlan({
      workspaceRoot: root,
      remote: 'origin',
      branch: 'catalog/latest',
      env: process.env,
      beforeFinalRename: async ({ temporaryStateRoot, finalStateRoot }) => {
        await fs.copy(temporaryStateRoot, finalStateRoot, { dereference: false, errorOnExist: true });
        const journalPath = path.join(finalStateRoot, 'journal.json');
        const journal = await fs.readJson(journalPath) as {
          descriptor: CatalogPublishPlanReceipt['descriptor'];
          expectedCommit: string;
          planDigest: string;
        };
        journal.descriptor.remote.name = 'other-remote';
        journal.planDigest = catalogPublicationPlanDigest(journal.descriptor, journal.expectedCommit);
        await fs.writeJson(journalPath, journal, { spaces: 2 });
      },
    })).rejects.toThrow(/different publication plan|Increase/u);
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
      .resolves.toEqual(['journal.json']);
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

  it('rejects the original digest after expectedCommit and the pending repository are rewritten together', async () => {
    const { root, remote } = await createWorkspace();
    const publication = await plan(root);
    await git(publication.repositoryPath!, ['tag', '--delete', publication.tag]);
    await git(publication.repositoryPath!, [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--amend', '--quiet', '-m', 'rewritten prepared commit',
    ]);
    const rewrittenCommit = await git(publication.repositoryPath!, ['rev-parse', 'HEAD']);
    await git(publication.repositoryPath!, [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'tag', '--annotate', publication.tag, '--message', 'rewritten prepared tag',
    ]);
    const journal = await fs.readJson(publication.journalPath) as Record<string, unknown>;
    journal.expectedCommit = rewrittenCommit;
    await fs.writeJson(publication.journalPath, journal, { spaces: 2 });

    await expect(apply(root, publication)).rejects.toThrow(/damaged|authorized|digest/u);
    expect(await git(root, ['ls-remote', remote])).toBe('');
  });

  it('returns the published result when a stale pending repository is damaged', async () => {
    const { root } = await createWorkspace();
    const publication = await plan(root);
    await apply(root, publication);
    await fs.outputFile(path.join(publication.repositoryPath!, '.git', 'config'), '[damaged\n');

    await expect(apply(root, publication)).resolves.toMatchObject({
      state: 'published',
      reconciliation: 'already-published',
      warnings: [CATALOG_PUBLICATION_CLEANUP_WARNING],
    });
  });

  it('returns published success and a stable warning when repository cleanup fails', async () => {
    const { root } = await createWorkspace();
    const publication = await plan(root);

    const result = await applyCatalogPublicationPlan({
      workspaceRoot: root,
      remote: 'origin',
      branch: 'catalog/latest',
      expectedPlanDigest: publication.planDigest,
      env: process.env,
      removeRepository: async () => {
        await expect(fs.readJson(publication.journalPath)).resolves.toMatchObject({ state: 'published' });
        throw new Error('injected cleanup failure');
      },
    });

    expect(result).toMatchObject({
      state: 'published',
      warnings: [CATALOG_PUBLICATION_CLEANUP_WARNING],
    });
    await expect(fs.readJson(publication.journalPath)).resolves.toMatchObject({ state: 'published' });
    await expect(fs.pathExists(publication.repositoryPath!)).resolves.toBe(true);
    await expect(apply(root, publication)).resolves.toMatchObject({ warnings: [] });
    await expect(fs.pathExists(publication.repositoryPath!)).resolves.toBe(false);
  });

  it('applies after the current source HEAD, dirty state, and metadata version change', async () => {
    const { root, remote } = await createWorkspace();
    const publication = await plan(root);
    const metadataPath = path.join(root, 'plugins', 'marketplace-source.json');
    const metadata = await fs.readJson(metadataPath) as { catalog: { version: string } };
    metadata.catalog.version = '1.0.1';
    await fs.writeJson(metadataPath, metadata, { spaces: 2 });
    await execFileAsync('git', ['add', 'plugins/marketplace-source.json'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '-m', 'move source head',
    ], { cwd: root });
    await fs.outputFile(path.join(root, 'late-drift.txt'), 'drift\n');

    await expect(apply(root, publication)).resolves.toMatchObject({
      state: 'published',
      catalogVersion: '1.0.0',
    });
    expect(await git(remote, ['rev-parse', `refs/heads/${publication.branch}`]))
      .toBe(publication.expectedCommit);
  });

  it('allows a renamed remote alias when its fetch and push identity is unchanged', async () => {
    const { root, remote } = await createWorkspace();
    const publication = await plan(root);
    await git(root, ['remote', 'add', 'renamed', remote]);
    await git(root, ['remote', 'remove', 'origin']);

    await expect(applyCatalogPublicationPlan({
      workspaceRoot: root,
      remote: 'renamed',
      branch: 'catalog/latest',
      expectedPlanDigest: publication.planDigest,
      env: process.env,
    })).resolves.toMatchObject({ state: 'published', remote: 'renamed' });
  });

  it.each(['remote identity', 'branch'] as const)(
    'rejects a changed %s during apply',
    async (changed) => {
      const { root, remote } = await createWorkspace();
      const publication = await plan(root);
      const evilRemote = await temporaryRoot('aw-catalog-journal-changed-remote-');
      await execFileAsync('git', ['init', '--bare', '--quiet', evilRemote]);
      if (changed === 'remote identity') await git(root, ['remote', 'set-url', 'origin', evilRemote]);

      await expect(applyCatalogPublicationPlan({
        workspaceRoot: root,
        remote: 'origin',
        branch: changed === 'branch' ? 'catalog/beta' : 'catalog/latest',
        expectedPlanDigest: publication.planDigest,
        env: process.env,
      })).rejects.toThrow(/identity changed|Increase/u);
      expect(await git(root, ['ls-remote', remote])).toBe('');
      expect(await git(root, ['ls-remote', evilRemote])).toBe('');
    },
  );

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

  it('fails closed when the authorized digest appears in multiple schema v2 journal files', async () => {
    const { root, remote } = await createWorkspace();
    const publication = await plan(root);
    await fs.copy(
      path.dirname(publication.journalPath),
      path.join(root, '.aw', 'publish', '9.9.9'),
      { dereference: false, errorOnExist: true },
    );

    await expect(apply(root, publication)).rejects.toThrow(/Multiple|Increase/u);
    expect(await git(root, ['ls-remote', remote])).toBe('');
  });

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

  it('rejects stable Plugin identity reuse and downgrade after a deletion without remote or formal state writes', async () => {
    const { root, remote } = await createWorkspace('1.0.0');
    const pluginRoot = path.join(root, 'plugins', 'journal-test');
    await addHistoryKeeperPlugin(root);
    await setPluginVersion(root, '0.2.0');
    await fs.writeFile(path.join(pluginRoot, 'README.md'), '# Original\n');
    await commitAll(root, 'prepare original plugin');
    const backupRoot = await temporaryRoot('aw-catalog-plugin-backup-');
    const pluginBackup = path.join(backupRoot, 'journal-test');
    await fs.copy(pluginRoot, pluginBackup);

    const first = await plan(root);
    await apply(root, first);
    await fs.remove(pluginRoot);
    await setCatalogVersion(root, '1.1.0');
    await commitAll(root, 'remove plugin');
    const removed = await plan(root);
    await apply(root, removed);

    await fs.copy(pluginBackup, pluginRoot);
    await fs.writeFile(path.join(pluginRoot, 'README.md'), '# Different\n');
    await setCatalogVersion(root, '1.2.0');
    await commitAll(root, 'readd changed plugin at reused version');
    const remoteBeforeReuse = await git(remote, ['show-ref']);
    await expect(plan(root)).rejects.toThrow(/maps to different content/u);
    await expect(fs.pathExists(path.join(root, '.aw', 'publish', '1.2.0'))).resolves.toBe(false);
    await expect(git(remote, ['show-ref'])).resolves.toBe(remoteBeforeReuse);

    await setPluginVersion(root, '0.1.0');
    await commitAll(root, 'lower readded plugin version');
    const remoteBeforeDowngrade = await git(remote, ['show-ref']);
    await expect(plan(root)).rejects.toThrow(/must not be lower than previous/u);
    await expect(fs.pathExists(path.join(root, '.aw', 'publish', '1.2.0'))).resolves.toBe(false);
    await expect(git(remote, ['show-ref'])).resolves.toBe(remoteBeforeDowngrade);
  });

  it('continues beta Plugin identity after deletion and reuses unchanged historical content', async () => {
    const { root } = await createWorkspace('1.0.0-beta.1');
    const pluginRoot = path.join(root, 'plugins', 'journal-test');
    await addHistoryKeeperPlugin(root);
    await fs.writeFile(path.join(pluginRoot, 'README.md'), '# Original\n');
    await commitAll(root, 'prepare original beta plugin');
    const backupRoot = await temporaryRoot('aw-catalog-beta-plugin-backup-');
    const pluginBackup = path.join(backupRoot, 'journal-test');
    await fs.copy(pluginRoot, pluginBackup);

    const first = await plan(root, 'catalog/beta');
    expect(await publishedPluginVersion(first)).toBe('0.1.0-beta.1');
    await apply(root, first);
    await fs.remove(pluginRoot);
    await setCatalogVersion(root, '1.0.0-beta.2');
    await commitAll(root, 'remove beta plugin');
    const removed = await plan(root, 'catalog/beta');
    await apply(root, removed);

    await fs.copy(pluginBackup, pluginRoot);
    await setCatalogVersion(root, '1.0.0-beta.3');
    await commitAll(root, 'readd unchanged beta plugin');
    const unchanged = await plan(root, 'catalog/beta');
    expect(await publishedPluginVersion(unchanged)).toBe('0.1.0-beta.1');
    await apply(root, unchanged);

    await fs.remove(pluginRoot);
    await setCatalogVersion(root, '1.0.0-beta.4');
    await commitAll(root, 'remove beta plugin again');
    const removedAgain = await plan(root, 'catalog/beta');
    await apply(root, removedAgain);

    await fs.copy(pluginBackup, pluginRoot);
    await fs.writeFile(path.join(pluginRoot, 'README.md'), '# Different\n');
    await setCatalogVersion(root, '1.0.0-beta.5');
    await commitAll(root, 'readd changed beta plugin');
    const changed = await plan(root, 'catalog/beta');
    expect(await publishedPluginVersion(changed)).toBe('0.1.0-beta.2');
    await apply(root, changed);
  });

  it('rejects a regular historical manifest blob with a non-canonical Plugin source before formal or remote writes', async () => {
    const { root, remote } = await createWorkspace('1.0.0');
    const pluginRoot = path.join(root, 'plugins', 'journal-test');
    await addHistoryKeeperPlugin(root);
    await commitAll(root, 'prepare historical plugin');
    const pluginBackup = path.join(await temporaryRoot('aw-catalog-history-source-backup-'), 'journal-test');
    await fs.copy(pluginRoot, pluginBackup);

    const first = await plan(root);
    await apply(root, first);
    await fs.remove(pluginRoot);
    await setCatalogVersion(root, '1.1.0');
    await commitAll(root, 'remove historical plugin');
    const removed = await plan(root);
    await apply(root, removed);

    const rewrite = await temporaryRoot('aw-catalog-history-source-rewrite-');
    await git(path.dirname(rewrite), ['clone', '--quiet', remote, rewrite]);
    await git(rewrite, ['config', 'user.email', 'test@example.invalid']);
    await git(rewrite, ['config', 'user.name', 'AW Test']);
    await git(rewrite, ['checkout', '--quiet', '--detach', first.expectedCommit]);
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
    await git(rewrite, ['read-tree', '--reset', '-u', removed.expectedCommit]);
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

  it('uses only the first-parent Catalog history when a merge second parent has a misleading Plugin entry', async () => {
    const { root, remote } = await createWorkspace('1.0.0');
    const pluginRoot = path.join(root, 'plugins', 'journal-test');
    await addHistoryKeeperPlugin(root);
    await setPluginVersion(root, '0.2.0');
    await fs.writeFile(path.join(pluginRoot, 'README.md'), '# First parent\n');
    await commitAll(root, 'prepare first-parent plugin');
    const backupRoot = await temporaryRoot('aw-catalog-first-parent-backup-');
    const pluginBackup = path.join(backupRoot, 'journal-test');
    await fs.copy(pluginRoot, pluginBackup);

    const first = await plan(root);
    await apply(root, first);
    await fs.remove(pluginRoot);
    await setCatalogVersion(root, '1.1.0');
    await commitAll(root, 'remove first-parent plugin');
    const removed = await plan(root);
    await apply(root, removed);

    await fs.copy(pluginBackup, pluginRoot);
    await setPluginVersion(root, '9.9.0');
    await fs.writeFile(path.join(pluginRoot, 'README.md'), '# Misleading second parent\n');
    await setCatalogVersion(root, '9.0.0');
    await commitAll(root, 'prepare misleading branch');
    const misleading = await plan(root, 'catalog/misleading');
    await apply(root, misleading);

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
    const readded = await plan(root);
    expect(readded.parent).toBe(mergeCommit);
    expect(await publishedPluginVersion(readded)).toBe('0.2.0');
    const officialHistory = await readCatalogPublicationPluginHistory({
      workspaceRoot: root, remoteUrl: remote, branches: ['catalog/latest', 'catalog/beta'], env: process.env,
    });
    expect(officialHistory.filter((entry) => entry.name === 'journal-test').map((entry) => entry.version))
      .toEqual(['0.2.0']);
    await apply(root, readded);
  }, 90_000);
});
