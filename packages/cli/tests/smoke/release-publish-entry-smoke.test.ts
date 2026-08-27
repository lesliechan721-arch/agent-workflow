import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, expect, it } from 'vitest';

import { calculateCanonicalDigest } from '../../../../scripts/release/release-model.mjs';
import {
  disposeCatalogPublicationInspection,
  prepareCatalogPublicationInspection,
} from '../../src/commands/catalog-publication-inspection.js';
import { runCli } from '../../src/index.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function digest(value: Buffer) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function quietIo() {
  return { stdout: () => undefined, stderr: () => undefined };
}

async function runCase(axes: { cli: boolean; catalog: boolean }, fail?: 'eval' | 'catalog') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-entry-smoke-'));
  roots.push(root);
  const workspaceRoot = path.join(root, 'workspace');
  const preparedRoot = path.join(root, 'prepared');
  const artifacts = path.join(preparedRoot, 'artifacts');
  const catalogRoot = path.join(artifacts, 'catalog');
  const remoteUrl = path.join(root, 'catalog.git');
  await Promise.all([
    fs.mkdir(catalogRoot, { recursive: true }),
    fs.mkdir(workspaceRoot, { recursive: true }),
    execFileAsync('git', ['init', '--bare', '--quiet', remoteUrl]),
  ]);
  await execFileAsync('git', ['init', '--quiet'], { cwd: workspaceRoot });
  await runCli([
    'catalog', 'init', '--workspace-root', workspaceRoot, '--catalog-version', '2.0.0',
  ], { cwd: workspaceRoot, io: quietIo() });
  await runCli([
    'plugin', 'init', 'release-smoke', '--description', 'Release smoke.', '--no-skills',
    '--workspace-root', workspaceRoot,
  ], { cwd: workspaceRoot, io: quietIo() });
  await execFileAsync('git', ['add', '.'], { cwd: workspaceRoot });
  await execFileAsync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'source',
  ], { cwd: workspaceRoot });
  const sourceHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: workspaceRoot,
  })).stdout.trim();
  if (fail === 'catalog') {
    await fs.writeFile(path.join(remoteUrl, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }

  let catalog = null;
  if (axes.catalog) {
    const preparation = await prepareCatalogPublicationInspection({
      workspaceRoot,
      remoteUrl,
      branch: 'catalog/latest',
      catalogVersion: '2.0.0',
      env: process.env,
      failOnUnavailable: true,
    });
    try {
      await fs.cp(preparation.prepared.outputRoot, catalogRoot, { recursive: true });
      catalog = {
        version: '2.0.0',
        path: 'artifacts/catalog',
        snapshotDigest: preparation.descriptor.snapshotDigest,
        minCliVersion: preparation.descriptor.minCliVersion,
        ledgerDigest: preparation.descriptor.ledgerDigest,
        publication: preparation.descriptor,
      };
    } finally {
      await disposeCatalogPublicationInspection(preparation);
    }
  }

  const evalBytes = Buffer.from('eval');
  const coreBytes = Buffer.from('core');
  const cliBytes = Buffer.from('cli');
  await Promise.all([
    fs.writeFile(path.join(artifacts, 'eval.tgz'), evalBytes),
    fs.writeFile(path.join(artifacts, 'core.tgz'), coreBytes),
    fs.writeFile(path.join(artifacts, 'cli.tgz'), cliBytes),
  ]);
  const targets = { schemaVersion: 1, cli: '1.0.0', catalog: '2.0.0' };
  const descriptor = {
    schemaVersion: 1,
    source: { head: sourceHead, targetsDigest: calculateCanonicalDigest(targets) },
    channel: 'stable',
    axes,
    candidates: { cli: axes.cli ? '1.0.0' : null, catalog: axes.catalog ? '2.0.0' : null },
    build: { generationId: 'one', inputDigest: 'input', outputDigest: 'output', cliPackageDigest: 'cli' },
    npm: axes.cli ? {
      version: '1.0.0',
      packages: [
        { name: '@lesliechan721/agent-skill-eval', path: 'artifacts/eval.tgz', contentDigest: digest(evalBytes) },
        { name: '@lesliechan721/aw-plugin-core', path: 'artifacts/core.tgz', contentDigest: digest(coreBytes) },
        { name: '@lesliechan721/aw', path: 'artifacts/cli.tgz', contentDigest: digest(cliBytes) },
      ],
      treeDigests: {
        '@lesliechan721/agent-skill-eval': 'eval-tree',
        '@lesliechan721/aw-plugin-core': 'core-tree',
        '@lesliechan721/aw': 'cli-tree',
      },
    } : null,
    catalog,
  };
  await fs.writeFile(path.join(preparedRoot, 'descriptor.json'), JSON.stringify(descriptor));
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    workspaceRoot,
    preparedRoot,
    attemptPath: path.join(root, 'attempted.json'),
    remoteUrl,
    targets,
    publishedCliVersion: '1.0.0',
    fail,
  }));
  const child = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../support/release-publish-smoke-child.mjs',
  );
  try {
    const { stdout } = await execFileAsync(process.execPath, [child, configPath]);
    return JSON.parse(stdout);
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (stdout) return JSON.parse(stdout);
    throw error;
  }
}

it('runs official release order through the common Catalog publisher and unified attempt', async () => {
  await expect(runCase({ cli: true, catalog: true })).resolves.toMatchObject({
    ok: true,
    events: ['eval', 'core', 'cli', 'tag', 'catalog'],
    catalogAttempt: 'published',
    releaseAttempt: { cli: '1.0.0' },
  });
  await expect(runCase({ cli: true, catalog: false })).resolves.toMatchObject({
    ok: true, events: ['eval', 'core', 'cli', 'tag'],
  });
  await expect(runCase({ cli: false, catalog: true })).resolves.toMatchObject({
    ok: true, events: ['catalog'], catalogAttempt: 'published', releaseAttempt: null,
  });
  await expect(runCase({ cli: true, catalog: true }, 'eval')).resolves.toMatchObject({
    ok: false, events: ['eval'], error: expect.stringContaining('--cli-bump'),
  });
  await expect(runCase({ cli: false, catalog: true }, 'catalog')).resolves.toMatchObject({
    ok: false, events: ['catalog'], error: expect.stringContaining('version <higher>'),
    catalogAttempt: 'attempted',
  });
});
