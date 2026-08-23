import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, expect, it } from 'vitest';

import { calculateCanonicalDigest } from '../../../../scripts/release/release-model.mjs';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function digest(value: Buffer) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

async function runCase(axes: { cli: boolean; catalog: boolean }, fail?: 'eval' | 'catalog') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-entry-smoke-'));
  roots.push(root);
  const preparedRoot = path.join(root, 'prepared');
  const artifacts = path.join(preparedRoot, 'artifacts');
  const catalogRoot = path.join(artifacts, 'catalog');
  const remoteUrl = path.join(root, 'catalog.git');
  await Promise.all([fs.mkdir(catalogRoot, { recursive: true }), fs.mkdir(path.join(root, 'empty'))]);
  await execFileAsync('git', ['init', '--bare', '--quiet', remoteUrl]);
  if (fail === 'catalog') {
    await fs.writeFile(path.join(remoteUrl, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }
  const evalBytes = Buffer.from('eval');
  const cliBytes = Buffer.from('cli');
  await Promise.all([
    fs.writeFile(path.join(artifacts, 'eval.tgz'), evalBytes),
    fs.writeFile(path.join(artifacts, 'cli.tgz'), cliBytes),
    fs.writeFile(path.join(catalogRoot, 'catalog-manifest.json'), JSON.stringify({
      catalogVersion: '2.0.0', channel: 'latest',
    })),
    fs.writeFile(path.join(catalogRoot, 'plugin-release-ledger.json'), '{}'),
  ]);
  const targets = { schemaVersion: 1, cli: '1.0.0', catalog: '2.0.0' };
  const descriptor = {
    schemaVersion: 1,
    source: { head: 'a'.repeat(40), targetsDigest: calculateCanonicalDigest(targets) },
    channel: 'stable', axes,
    candidates: { cli: axes.cli ? '1.0.0' : null, catalog: axes.catalog ? '2.0.0' : null },
    build: { generationId: 'one', inputDigest: 'input', outputDigest: 'output', cliPackageDigest: 'cli' },
    npm: axes.cli ? {
      version: '1.0.0',
      packages: [
        { name: '@lesliechan721/agent-skill-eval', path: 'artifacts/eval.tgz', contentDigest: digest(evalBytes) },
        { name: '@lesliechan721/aw', path: 'artifacts/cli.tgz', contentDigest: digest(cliBytes) },
      ],
      treeDigests: { '@lesliechan721/agent-skill-eval': 'eval-tree', '@lesliechan721/aw': 'cli-tree' },
    } : null,
    catalog: axes.catalog ? {
      version: '2.0.0', path: 'artifacts/catalog', snapshotDigest: 'catalog-snapshot',
      minCliVersion: '1.0.0', ledgerDigest: calculateCanonicalDigest({}),
    } : null,
  };
  await fs.writeFile(path.join(preparedRoot, 'descriptor.json'), JSON.stringify(descriptor));
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
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
  const { stdout } = await execFileAsync(process.execPath, [child, configPath]);
  return JSON.parse(stdout);
}

it('spawns the public publisher orchestration for all axes and uncertain failures', async () => {
  await expect(runCase({ cli: true, catalog: true })).resolves.toMatchObject({
    ok: true, events: ['eval', 'cli', 'catalog'],
  });
  await expect(runCase({ cli: true, catalog: false })).resolves.toMatchObject({
    ok: true, events: ['eval', 'cli'],
  });
  await expect(runCase({ cli: false, catalog: true })).resolves.toMatchObject({
    ok: true, events: ['catalog'],
  });
  await expect(runCase({ cli: true, catalog: true }, 'eval')).resolves.toMatchObject({
    ok: false, events: ['eval'], error: expect.stringContaining('bump both npm package versions'),
  });
  await expect(runCase({ cli: false, catalog: true }, 'catalog')).resolves.toMatchObject({
    ok: false, events: ['catalog'], error: expect.stringContaining('bump the Catalog version'),
  });
});
