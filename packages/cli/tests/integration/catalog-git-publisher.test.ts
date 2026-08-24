import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CATALOG_CHANNEL_REFS,
  publishStagedCatalog,
} from '../../../../scripts/release/git-catalog-publisher.mjs';
import { captureCommand } from '../../../../scripts/release/common.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function git(args: string[], cwd?: string) {
  return captureCommand('git', args, { cwd });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-simple-catalog-publisher-'));
  roots.push(root);
  const remote = path.join(root, 'catalog.git');
  await git(['init', '--bare', '--quiet', '--object-format=sha1', remote]);
  return { root, remote };
}

async function stage(root: string, version: string) {
  const stagedRoot = path.join(root, `stage-${version}`);
  await fs.mkdir(stagedRoot);
  await fs.writeFile(path.join(stagedRoot, 'catalog-manifest.json'), JSON.stringify({
    catalogVersion: version,
    channel: version.includes('-') ? 'beta' : 'latest',
  }));
  await fs.writeFile(path.join(stagedRoot, 'plugin-release-ledger.json'), '{}');
  return stagedRoot;
}

function catalogModules(_mode?: 'latest' | 'beta', _version?: string) {
  return {
    catalogSnapshot: {
      validateCatalogSnapshot: async (root: string) => {
        const bytes = await fs.readFile(path.join(root, 'catalog-manifest.json'), 'utf8');
        const manifest = JSON.parse(bytes);
        return { manifest, snapshotDigest: `digest-${manifest.catalogVersion}` };
      },
    },
    pluginStaging: {
      validatePluginReleaseLedgerAgainstManifest: () => undefined,
    },
  };
}

describe('simple Catalog Git publisher', () => {
  it('publishes stable and beta as annotated immutable tags with independent channel refs', async () => {
    const { root, remote } = await fixture();
    const stableRoot = await stage(root, '2.0.0');
    const betaRoot = await stage(root, '2.1.0-beta.1');
    await publishStagedCatalog({
      mode: 'latest', catalogVersion: '2.0.0', stagedRoot: stableRoot,
    }, { remoteUrl: remote, catalogModules: catalogModules('latest', '2.0.0') });
    await publishStagedCatalog({
      mode: 'beta', catalogVersion: '2.1.0-beta.1', stagedRoot: betaRoot,
    }, { remoteUrl: remote, catalogModules: catalogModules('beta', '2.1.0-beta.1') });

    const latest = (await git(['--git-dir', remote, 'rev-parse', CATALOG_CHANNEL_REFS.latest])).stdout.trim();
    const beta = (await git(['--git-dir', remote, 'rev-parse', CATALOG_CHANNEL_REFS.beta])).stdout.trim();
    expect(latest).not.toBe(beta);
    expect((await git(['--git-dir', remote, 'cat-file', '-t', 'refs/tags/catalog-v2.0.0'])).stdout.trim())
      .toBe('tag');
    expect((await git(['--git-dir', remote, 'cat-file', '-t', 'refs/tags/catalog-v2.1.0-beta.1'])).stdout.trim())
      .toBe('tag');
    await expect(publishStagedCatalog({
      mode: 'latest', catalogVersion: '2.0.0', stagedRoot: stableRoot,
    }, { remoteUrl: remote, catalogModules: catalogModules('latest', '2.0.0') }))
      .rejects.toThrow('already exists');
  });

  it('does not offer recovery when an atomic push fails and requires a version bump', async () => {
    const { root, remote } = await fixture();
    const hook = path.join(remote, 'hooks', 'pre-receive');
    await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const stagedRoot = await stage(root, '3.0.0');
    await expect(publishStagedCatalog({
      mode: 'latest', catalogVersion: '3.0.0', stagedRoot,
    }, { remoteUrl: remote, catalogModules: catalogModules('latest', '3.0.0') }))
      .rejects.toThrow('Do not retry 3.0.0');
    await expect(git(['--git-dir', remote, 'rev-parse', CATALOG_CHANNEL_REFS.latest]))
      .rejects.toThrow();
    await expect(git(['--git-dir', remote, 'rev-parse', 'refs/tags/catalog-v3.0.0']))
      .rejects.toThrow();
  });

  it('publishes a second version on the same channel with the validated first commit as parent', async () => {
    const { root, remote } = await fixture();
    await publishStagedCatalog({
      mode: 'latest', catalogVersion: '4.0.0', stagedRoot: await stage(root, '4.0.0'),
    }, { remoteUrl: remote, catalogModules: catalogModules() });
    const first = (await git(['--git-dir', remote, 'rev-parse', CATALOG_CHANNEL_REFS.latest])).stdout.trim();
    await publishStagedCatalog({
      mode: 'latest', catalogVersion: '4.0.1', stagedRoot: await stage(root, '4.0.1'),
    }, { remoteUrl: remote, catalogModules: catalogModules() });
    const second = (await git(['--git-dir', remote, 'rev-parse', CATALOG_CHANNEL_REFS.latest])).stdout.trim();
    expect((await git(['--git-dir', remote, 'rev-parse', `${second}^`])).stdout.trim()).toBe(first);
  });

  it('ignores Git repository, object, config, namespace, ceiling, and template injection', async () => {
    const { root, remote } = await fixture();
    const injected = path.join(root, 'injected');
    await fs.mkdir(injected);
    const env = {
      ...process.env,
      GIT_DIR: injected,
      GIT_WORK_TREE: injected,
      GIT_OBJECT_DIRECTORY: injected,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: injected,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: injected,
      GIT_NAMESPACE: 'hostile',
      GIT_CEILING_DIRECTORIES: root,
      GIT_TEMPLATE_DIR: injected,
    };
    await publishStagedCatalog({
      mode: 'latest', catalogVersion: '4.2.0', stagedRoot: await stage(root, '4.2.0'),
    }, { remoteUrl: remote, catalogModules: catalogModules(), env });
    expect((await git(['--git-dir', remote, 'cat-file', '-t', 'refs/tags/catalog-v4.2.0'])).stdout.trim())
      .toBe('tag');
  });

  it('rejects a corrupt existing channel before creating a new tag', async () => {
    const { root, remote } = await fixture();
    const corrupt = path.join(root, 'corrupt');
    await git(['init', '--quiet', '--object-format=sha1', corrupt]);
    await fs.writeFile(path.join(corrupt, 'catalog-manifest.json'), '{broken');
    await fs.writeFile(path.join(corrupt, 'plugin-release-ledger.json'), '{}');
    await git(['add', '--all'], corrupt);
    await git(['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'corrupt'], corrupt);
    await git(['push', '--quiet', remote, `HEAD:${CATALOG_CHANNEL_REFS.latest}`], corrupt);
    await expect(publishStagedCatalog({
      mode: 'latest', catalogVersion: '5.0.0', stagedRoot: await stage(root, '5.0.0'),
    }, { remoteUrl: remote, catalogModules: catalogModules() })).rejects.toThrow();
    await expect(git(['--git-dir', remote, 'rev-parse', 'refs/tags/catalog-v5.0.0']))
      .rejects.toThrow();
  });
});
