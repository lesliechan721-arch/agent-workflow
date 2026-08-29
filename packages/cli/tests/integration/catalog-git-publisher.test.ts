import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CATALOG_CHANNEL_REFS,
  disposeCatalogRelease,
  prepareCatalogRelease,
  publishCatalogRelease,
} from '../../../../scripts/release/catalog-publication.mjs';
import * as inspectionService from '../../src/commands/catalog-publication-inspection.js';
import * as publicationService from '../../src/commands/catalog-publish.js';
import { runCli } from '../../src/index.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const service = { ...inspectionService, ...publicationService };
const placeholderDescriptorDigest = `sha256:${'0'.repeat(64)}`;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

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

async function createWorkspace(version = '0.1.0'): Promise<{ root: string; remote: string }> {
  const root = await temporaryRoot('aw-common-catalog-publisher-');
  const remote = await temporaryRoot('aw-common-catalog-remote-');
  await execFileAsync('git', ['init', '--bare', '--quiet', remote]);
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  await runCli([
    'catalog', 'init', '--workspace-root', root, '--catalog-version', version,
    '--owner-url', 'https://catalog.example.com/publisher-demo',
  ], { cwd: root, io: quietIo() });
  await runCli([
    'plugin', 'init', 'publisher-demo', '--description', 'Publisher demo.', '--no-skills',
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

async function commitCatalogVersion(root: string, version: string): Promise<void> {
  await runCli([
    'catalog', 'version', version, '--workspace-root', root,
  ], { cwd: root, io: quietIo() });
  await execFileAsync('git', ['add', 'plugins/marketplace-source.json'], { cwd: root });
  await execFileAsync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'catalog version',
  ], { cwd: root });
}

async function convertRemoteBranchToLegacyV4(remote: string, branch: string): Promise<string> {
  const checkout = await temporaryRoot('aw-legacy-catalog-parent-');
  await execFileAsync('git', ['clone', '--quiet', '--branch', branch, remote, checkout]);
  const manifestPath = path.join(checkout, 'catalog-manifest.json');
  const manifest = await fs.readJson(manifestPath);
  const compatibility = { aw: { minVersion: '0.0.0' } };
  const entries = manifest.entries.map((entry: Record<string, unknown>) => {
    const legacy = { ...entry };
    delete legacy.dependencies;
    delete legacy.requires;
    return { ...legacy, compatibility };
  });
  const contentDigest = sha256({
    schemaIdentity: { schemaVersion: 4 },
    marketplaceMetadata: {
      name: 'aw',
      owner: manifest.marketplace.owner,
      interface: manifest.marketplace.interface,
    },
    compatibility,
    plugins: entries.map((entry: Record<string, string>) => ({
      name: entry.name,
      targetVersion: entry.version.replace(/-beta\.[1-9]\d*$/u, ''),
      contentDigest: entry.contentDigest,
    })).sort((left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name)),
  });
  await fs.writeJson(manifestPath, {
    schemaVersion: 4,
    catalogVersion: manifest.catalogVersion,
    channel: manifest.channel,
    compatibility,
    marketplace: manifest.marketplace,
    release: { ...manifest.release, planId: contentDigest, contentDigest },
    entries,
  });
  await execFileAsync('git', ['add', 'catalog-manifest.json'], { cwd: checkout });
  await execFileAsync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'legacy v4 catalog parent',
  ], { cwd: checkout });
  await execFileAsync('git', ['push', '--quiet', 'origin', `HEAD:${branch}`], { cwd: checkout });
  return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim();
}

describe('common Catalog publisher used by official release', () => {
  it('prepares identical public and official snapshots and publishes an official channel', async () => {
    const { root, remote } = await createWorkspace('2.0.0');
    const publicPreparation = await inspectionService.prepareCatalogPublicationInspection({
      workspaceRoot: root,
      remoteUrl: remote,
      branch: 'catalog/latest',
      env: process.env,
      failOnUnavailable: true,
    });
    const officialPreparation = await prepareCatalogRelease('latest', {
      repoRoot: root,
      remoteUrl: remote,
      catalogPublicationService: service,
    });
    try {
      expect(officialPreparation.descriptor).toEqual(publicPreparation.descriptor);
      await expect(fs.readFile(path.join(
        officialPreparation.prepared.outputRoot,
        'catalog-manifest.json',
      ))).resolves.toEqual(await fs.readFile(path.join(
        publicPreparation.prepared.outputRoot,
        'catalog-manifest.json',
      )));
      await expect(fs.readFile(path.join(
        officialPreparation.prepared.outputRoot,
        'plugin-release-ledger.json',
      ))).resolves.toEqual(await fs.readFile(path.join(
        publicPreparation.prepared.outputRoot,
        'plugin-release-ledger.json',
      )));

      const published = await publishCatalogRelease({
        descriptor: officialPreparation.descriptor,
        stagedRoot: officialPreparation.prepared.outputRoot,
      }, {
        repoRoot: root,
        remoteUrl: remote,
        catalogPublicationService: service,
      });
      const branchCommit = (await execFileAsync('git', [
        '--git-dir', remote, 'rev-parse', CATALOG_CHANNEL_REFS.latest,
      ])).stdout.trim();
      expect(branchCommit).toBe(published.commit);
      expect((await execFileAsync('git', [
        '--git-dir', remote, 'cat-file', '-t', 'refs/tags/catalog-v2.0.0',
      ])).stdout.trim()).toBe('tag');
      await expect(fs.readJson(path.join(root, '.aw', 'publish', 'attempts', '2.0.0.json')))
        .resolves.toMatchObject({
          state: 'published',
          workspaceIdentity: officialPreparation.descriptor.workspaceIdentity,
          branch: 'catalog/latest',
          parent: null,
          planId: officialPreparation.descriptor.planId,
        });

      const blocked = quietIo();
      expect(await runCli([
        'catalog', 'publish', '--workspace-root', root, '--branch', 'catalog/latest',
        '--expected-descriptor-digest', placeholderDescriptorDigest,
        '--yes', '--json',
      ], { cwd: root, interactive: false, io: blocked })).toBe(1);

      await commitCatalogVersion(root, '2.0.1');
      const updatedSourceHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
      })).stdout.trim();
      const update = await prepareCatalogRelease('latest', {
        repoRoot: root,
        remoteUrl: remote,
        catalogPublicationService: service,
      });
      try {
        expect(update.descriptor.sourceHead).toBe(updatedSourceHead);
        expect(update.descriptor.catalogVersion).toBe('2.0.1');
        const updated = await publishCatalogRelease({
          descriptor: update.descriptor,
          stagedRoot: update.prepared.outputRoot,
        }, {
          repoRoot: root,
          remoteUrl: remote,
          catalogPublicationService: service,
        });
        expect((await execFileAsync('git', [
          '--git-dir', remote, 'show', '-s', '--format=%P', updated.commit,
        ])).stdout.trim()).toBe(branchCommit);
      } finally {
        await disposeCatalogRelease(update, { catalogPublicationService: service });
      }
    } finally {
      await inspectionService.disposeCatalogPublicationInspection(publicPreparation);
      await disposeCatalogRelease(officialPreparation, { catalogPublicationService: service });
    }
  });

  it.each([
    ['latest', 'catalog/latest', '3.0.0'],
    ['beta', 'catalog/beta', '3.1.0-beta.1'],
  ] as const)('publishes %s through the same branch-parameterized service', async (mode, branch, version) => {
    const { root, remote } = await createWorkspace(version);
    const preparation = await prepareCatalogRelease(mode, {
      repoRoot: root,
      remoteUrl: remote,
      catalogPublicationService: service,
    });
    try {
      expect(preparation.descriptor.branch).toBe(branch);
      const published = await publishCatalogRelease({
        descriptor: preparation.descriptor,
        stagedRoot: preparation.prepared.outputRoot,
      }, {
        repoRoot: root,
        remoteUrl: remote,
        catalogPublicationService: service,
      });
      expect((await execFileAsync('git', [
        '--git-dir', remote, 'rev-parse', `refs/heads/${branch}`,
      ])).stdout.trim()).toBe(published.commit);
    } finally {
      await disposeCatalogRelease(preparation, { catalogPublicationService: service });
    }
  });

  it('prepares a v5 beta publication from a validated v4 remote parent', async () => {
    const { root, remote } = await createWorkspace('0.1.0-beta.1');
    const initial = await prepareCatalogRelease('beta', {
      repoRoot: root,
      remoteUrl: remote,
      catalogPublicationService: service,
    });
    try {
      await publishCatalogRelease({
        descriptor: initial.descriptor,
        stagedRoot: initial.prepared.outputRoot,
      }, {
        repoRoot: root,
        remoteUrl: remote,
        catalogPublicationService: service,
      });
    } finally {
      await disposeCatalogRelease(initial, { catalogPublicationService: service });
    }
    const legacyParent = await convertRemoteBranchToLegacyV4(remote, 'catalog/beta');
    await commitCatalogVersion(root, '0.1.0-beta.2');

    const update = await prepareCatalogRelease('beta', {
      repoRoot: root,
      remoteUrl: remote,
      catalogPublicationService: service,
    });
    try {
      expect(update.descriptor).toMatchObject({
        parent: legacyParent,
        catalogVersion: '0.1.0-beta.2',
      });
      await expect(fs.readJson(path.join(update.prepared.outputRoot, 'catalog-manifest.json')))
        .resolves.toMatchObject({
          schemaVersion: 5,
          entries: [{ version: '0.1.0-beta.1' }],
        });
      await expect(fs.readJson(path.join(update.prepared.outputRoot, 'plugin-release-ledger.json')))
        .resolves.toMatchObject({ schemaVersion: 2 });
    } finally {
      await disposeCatalogRelease(update, { catalogPublicationService: service });
    }
  });

  it('blocks an official release after a public publication result is uncertain', async () => {
    const { root, remote } = await createWorkspace('3.2.0');
    await fs.writeFile(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', {
      mode: 0o755,
    });

    const inspection = await inspectionService.prepareCatalogPublicationInspection({
      workspaceRoot: root,
      branch: 'catalog/latest',
      env: process.env,
    });
    try {
      expect(await runCli([
        'catalog', 'publish', '--workspace-root', root, '--branch', 'catalog/latest',
        '--expected-descriptor-digest', publicationService.catalogPublicationDescriptorDigest(
          inspection.descriptor,
        ),
        '--yes', '--json',
      ], { cwd: root, interactive: false, io: quietIo() })).toBe(1);
    } finally {
      await inspectionService.disposeCatalogPublicationInspection(inspection);
    }
    await expect(fs.readJson(path.join(root, '.aw', 'publish', 'attempts', '3.2.0.json')))
      .resolves.toMatchObject({ state: 'attempted', branch: 'catalog/latest' });
    await expect(prepareCatalogRelease('latest', {
      repoRoot: root,
      remoteUrl: remote,
      catalogPublicationService: service,
    })).rejects.toThrow('attempted publication record');
  });

  it.each(['descriptor', 'snapshot', 'source'] as const)(
    'rejects prepared %s drift before an attempt or remote write',
    async (drift) => {
      const { root, remote } = await createWorkspace('4.0.0');
      const preparation = await prepareCatalogRelease('latest', {
        repoRoot: root,
        remoteUrl: remote,
        catalogPublicationService: service,
      });
      try {
        const descriptor = drift === 'descriptor'
          ? { ...preparation.descriptor, planId: `sha256:${'f'.repeat(64)}` }
          : preparation.descriptor;
        if (drift === 'snapshot') {
          await fs.outputFile(path.join(preparation.prepared.outputRoot, 'tampered.txt'), 'tampered\n');
        }
        if (drift === 'source') await fs.outputFile(path.join(root, 'dirty.txt'), 'dirty\n');

        await expect(publishCatalogRelease({
          descriptor,
          stagedRoot: preparation.prepared.outputRoot,
        }, {
          repoRoot: root,
          remoteUrl: remote,
          catalogPublicationService: service,
        })).rejects.toThrow(drift === 'source' ? 'worktree to be clean' : /descriptor|snapshot|identity/iu);
        await expect(fs.pathExists(path.join(root, '.aw', 'publish', 'attempts', '4.0.0.json')))
          .resolves.toBe(false);
        expect((await execFileAsync('git', ['ls-remote', remote])).stdout).toBe('');
      } finally {
        await disposeCatalogRelease(preparation, { catalogPublicationService: service });
      }
    },
  );

  it('rejects a prepared descriptor that changes the official channel branch', async () => {
    const { root, remote } = await createWorkspace('4.1.0');
    const preparation = await prepareCatalogRelease('latest', {
      repoRoot: root,
      remoteUrl: remote,
      catalogPublicationService: service,
    });
    try {
      await expect(publishCatalogRelease({
        descriptor: { ...preparation.descriptor, branch: 'catalog/unexpected' },
        stagedRoot: preparation.prepared.outputRoot,
      }, {
        repoRoot: root,
        remoteUrl: remote,
        catalogPublicationService: service,
      })).rejects.toThrow('official channel branch');
      await expect(fs.pathExists(path.join(root, '.aw', 'publish', 'attempts', '4.1.0.json')))
        .resolves.toBe(false);
      expect((await execFileAsync('git', ['ls-remote', remote])).stdout).toBe('');
    } finally {
      await disposeCatalogRelease(preparation, { catalogPublicationService: service });
    }
  });

  it('rejects a branch parent that disappears after the final remote check', async () => {
    const { root, remote } = await createWorkspace('5.0.0');
    const initial = await prepareCatalogRelease('latest', {
      repoRoot: root,
      remoteUrl: remote,
      catalogPublicationService: service,
    });
    try {
      await publishCatalogRelease({
        descriptor: initial.descriptor,
        stagedRoot: initial.prepared.outputRoot,
      }, {
        repoRoot: root,
        remoteUrl: remote,
        catalogPublicationService: service,
      });
    } finally {
      await disposeCatalogRelease(initial, { catalogPublicationService: service });
    }

    await commitCatalogVersion(root, '5.0.1');
    const update = await prepareCatalogRelease('latest', {
      repoRoot: root,
      remoteUrl: remote,
      catalogPublicationService: service,
    });
    try {
      expect(update.descriptor.parent).not.toBeNull();
      await expect(publishCatalogRelease({
        descriptor: update.descriptor,
        stagedRoot: update.prepared.outputRoot,
      }, {
        repoRoot: root,
        remoteUrl: remote,
        catalogPublicationService: service,
        beforeRemoteWrite: async () => {
          await execFileAsync('git', [
            '--git-dir', remote, 'update-ref', '-d', CATALOG_CHANNEL_REFS.latest,
          ]);
        },
      })).rejects.toThrow('uncertain');
      await expect(fs.readJson(path.join(root, '.aw', 'publish', 'attempts', '5.0.1.json')))
        .resolves.toMatchObject({ state: 'attempted', parent: update.descriptor.parent });
      await expect(execFileAsync('git', [
        '--git-dir', remote, 'rev-parse', '--verify', CATALOG_CHANNEL_REFS.latest,
      ])).rejects.toBeDefined();
      await expect(execFileAsync('git', [
        '--git-dir', remote, 'rev-parse', '--verify', 'refs/tags/catalog-v5.0.1',
      ])).rejects.toBeDefined();
    } finally {
      await disposeCatalogRelease(update, { catalogPublicationService: service });
    }
  });
});
