import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

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
  prepareCatalogPublicationInspection,
} from '../../src/commands/catalog-publication-inspection.js';
import { runCli } from '../../src/index.js';
import {
  apply,
  createPublisherFixture,
  execFileAsync,
  git,
  plan,
  pushPreparedRef,
} from '../helpers/catalog-publisher-fixture.js';

const { createWorkspace, temporaryRoot, isolatedPublisherCase } = createPublisherFixture();

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

describe('version-scoped Catalog publication journal', { timeout: 30_000 }, () => {
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
      'dev', 'catalog', 'publish', 'plan', '--workspace-root', root,
      '--remote', 'origin', '--branch', 'catalog/latest', '--json',
    ], {
      cwd: root,
      env: { ...process.env, AW_HOME: awHome },
      io: output.io,
    });

    expect(exitCode).toBe(1);
    const failure = JSON.parse(output.stdout()) as { diagnostics: Array<{ code: string; message: string }> };
    expect(failure).toMatchObject({
      schemaVersion: 2,
      status: 'failed',
      command: 'dev.catalog.publish.plan', diagnostics: [expect.objectContaining({ code: 'remoteReadFailed' })], data: {}
    });
    expect(failure.diagnostics[0]!.message).toMatch(
      /^Could not inspect the Catalog publication remote\. Git exited with code \d+: /u,
    );
    expect(failure.diagnostics[0]!.message).toContain('[remote]');
    const combined = `${output.stdout()}\n${output.stderr()}`;
    for (const sensitive of [root, awHome, credential, querySecret, hashSecret, remoteUrl]) {
      expect(combined).not.toContain(sensitive);
    }
    expect(output.stderr()).toBe(`remoteReadFailed: ${failure.diagnostics[0]!.message}\n`);

    const human = captureIo();
    expect(await runCli([
      'dev', 'catalog', 'publish', 'plan', '--workspace-root', root,
      '--remote', 'origin', '--branch', 'catalog/latest',
    ], {
      cwd: root,
      env: { ...process.env, AW_HOME: awHome },
      io: human.io,
    })).toBe(1);
    expect(human.stdout()).toContain('FAILED');
    expect(human.stderr()).toMatch(
      /^remoteReadFailed: Could not inspect the Catalog publication remote\. Git exited with code \d+: /u,
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
      'dev', 'catalog', 'publish', 'apply', '--workspace-root', root,
      '--remote', 'origin', '--branch', publication.branch,
      '--expected-plan-digest', publication.planDigest, '--yes', '--json',
    ], {
      cwd: root,
      env: { ...process.env, AW_HOME: awHome },
      interactive: false,
      io: output.io,
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output.stdout())).toMatchObject({ schemaVersion: 2, command: 'dev.catalog.publish.apply', status: 'failed', data: {}, diagnostics: [{ code: 'catalogPublicationFailed', message: 'Catalog publication identity changed. Increase the Catalog version and create a new plan.' }] });
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
      'catalogPublicationFailed: Catalog publication identity changed. Increase the Catalog version and create a new plan.\n',
    );
  });

  it('rejects a published branch from a different Workspace identity without local or remote writes', async ({ task }) => {
    await isolatedPublisherCase(task.name);
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

  it('leaves no formal version directory when plan creation fails before the final rename', async ({ task }) => {
    await isolatedPublisherCase(task.name);
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

    const output = captureIo();
    expect(await runCli([
      'dev', 'catalog', 'publish', 'apply', '--workspace-root', root,
      '--remote', 'origin', '--branch', publication.branch,
      '--expected-plan-digest', publication.planDigest, '--yes', '--json',
    ], { cwd: root, env: process.env, io: output.io })).toBe(4);
    expect(JSON.parse(output.stdout())).toMatchObject({
      schemaVersion: 2, command: 'dev.catalog.publish.apply', status: 'partial',
      data: {
        state: 'uncertain', journalState: 'uncertain',
        remoteWriteAttempted: true, remoteVerified: false,
        planDigest: publication.planDigest, expectedCommit: publication.expectedCommit,
        catalogVersion: publication.catalogVersion, branch: publication.branch, tag: publication.tag,
        confirmation: { required: true, provided: true, effects: [expect.objectContaining({ code: 'publishRemote' })] },
      },
      diagnostics: [expect.objectContaining({ code: 'catalogPublicationFailed' })],
    });
    expect(output.stdout().endsWith('\n')).toBe(true);
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

  it('allows a renamed remote alias when its fetch and push identity is unchanged', async ({ task }) => {
    await isolatedPublisherCase(task.name);
  });

  it.each(['remote identity', 'branch'] as const)(
    'rejects a changed %s during apply',
    async (changed) => isolatedPublisherCase(`rejects a changed ${changed} during apply`),
  );

  it.each(['journal', 'damaged journal', 'repository', 'damaged repository'] as const)(
    'stops when the pending %s is missing or damaged',
    async (missing) => isolatedPublisherCase(`stops when the pending ${missing} is missing or damaged`),
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
});
