import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, expect, it } from 'vitest';

import { calculateCanonicalDigest } from '../../../../scripts/release/release-model.mjs';
import { prepareCatalogPublicationPlan } from '../../src/commands/catalog-publish.js';
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

async function runCase(
  axes: { cli: boolean; catalog: boolean },
  fail?: 'eval' | 'catalog' | 'catalog-retry',
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-entry-smoke-'));
  roots.push(root);
  const workspaceRoot = path.join(root, 'workspace');
  const preparedRoot = path.join(root, 'prepared');
  const artifacts = path.join(preparedRoot, 'artifacts');
  const remoteUrl = path.join(root, 'catalog.git');
  await Promise.all([
    fs.mkdir(artifacts, { recursive: true }),
    fs.mkdir(workspaceRoot, { recursive: true }),
    execFileAsync('git', ['init', '--bare', '--quiet', remoteUrl]),
  ]);
  await execFileAsync('git', ['init', '--quiet'], { cwd: workspaceRoot });
  await runCli([
    'catalog', 'init', '--workspace-root', workspaceRoot, '--catalog-version', '2.0.0',
    '--owner-url', 'https://catalog.example.com/release-smoke',
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
  if (fail === 'catalog' || fail === 'catalog-retry') {
    await fs.writeFile(path.join(remoteUrl, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }

  let catalog = null;
  if (axes.catalog) {
    const plan = await prepareCatalogPublicationPlan({
      workspaceRoot,
      remoteUrl,
      branch: 'catalog/latest',
      env: process.env,
    });
    catalog = {
      version: '2.0.0',
      publication: { planDigest: plan.planDigest },
    };
  }

  const evalBytes = Buffer.from('eval');
  const windowsX64Bytes = Buffer.from('windows-x64');
  const windowsArm64Bytes = Buffer.from('windows-arm64');
  const coreBytes = Buffer.from('core');
  const cliBytes = Buffer.from('cli');
  await Promise.all([
    fs.writeFile(path.join(artifacts, 'windows-x64.tgz'), windowsX64Bytes),
    fs.writeFile(path.join(artifacts, 'windows-arm64.tgz'), windowsArm64Bytes),
    fs.writeFile(path.join(artifacts, 'eval.tgz'), evalBytes),
    fs.writeFile(path.join(artifacts, 'core.tgz'), coreBytes),
    fs.writeFile(path.join(artifacts, 'cli.tgz'), cliBytes),
  ]);
  const targets = { schemaVersion: 2, cli: '1.0.0' };
  const descriptor = {
    schemaVersion: 1,
    source: {
      head: sourceHead,
      targetsDigest: axes.cli ? calculateCanonicalDigest(targets) : null,
    },
    channel: 'stable',
    axes,
    candidates: { cli: axes.cli ? '1.0.0' : null, catalog: axes.catalog ? '2.0.0' : null },
    build: { generationId: 'one', inputDigest: 'input', outputDigest: 'output', cliPackageDigest: 'cli' },
    npm: axes.cli ? {
      version: '1.0.0',
      packages: [
        { name: '@lesliechan721/aw-windows-job-win32-x64', path: 'artifacts/windows-x64.tgz', contentDigest: digest(windowsX64Bytes) },
        { name: '@lesliechan721/aw-windows-job-win32-arm64', path: 'artifacts/windows-arm64.tgz', contentDigest: digest(windowsArm64Bytes) },
        { name: '@lesliechan721/agent-skill-eval', path: 'artifacts/eval.tgz', contentDigest: digest(evalBytes) },
        { name: '@lesliechan721/aw-plugin-core', path: 'artifacts/core.tgz', contentDigest: digest(coreBytes) },
        { name: '@lesliechan721/aw', path: 'artifacts/cli.tgz', contentDigest: digest(cliBytes) },
      ],
      treeDigests: {
        '@lesliechan721/aw-windows-job-win32-x64': 'windows-x64-tree',
        '@lesliechan721/aw-windows-job-win32-arm64': 'windows-arm64-tree',
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
    fail,
  }));
  const child = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../support/release-publish-smoke-child.mjs',
  );
  const invoke = async () => {
    try {
      const { stdout } = await execFileAsync(process.execPath, [child, configPath]);
      return JSON.parse(stdout);
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      if (stdout) return JSON.parse(stdout);
      throw error;
    }
  };
  const first = await invoke();
  if (fail !== 'catalog-retry') return first;
  await fs.rm(path.join(remoteUrl, 'hooks', 'pre-receive'));
  await fs.writeFile(configPath, JSON.stringify({
    workspaceRoot,
    preparedRoot,
    attemptPath: path.join(root, 'attempted.json'),
    remoteUrl,
    targets,
    fail,
    entry: 'release',
  }));
  return { first, retry: await invoke() };
}

it('runs official release order and resumes an uncertain Catalog plan through runRelease', async () => {
  await expect(runCase({ cli: true, catalog: true })).resolves.toMatchObject({
    ok: true,
    events: ['windows-x64', 'windows-arm64', 'eval', 'core', 'cli', 'tag', 'catalog'],
    catalogJournal: 'published',
    releaseAttempt: { cli: '1.0.0' },
  });
  await expect(runCase({ cli: true, catalog: false })).resolves.toMatchObject({
    ok: true, events: ['windows-x64', 'windows-arm64', 'eval', 'core', 'cli', 'tag'],
  });
  await expect(runCase({ cli: false, catalog: true })).resolves.toMatchObject({
    ok: true, events: ['catalog'], catalogJournal: 'published', releaseAttempt: null,
  });
  await expect(runCase({ cli: true, catalog: true }, 'eval')).resolves.toMatchObject({
    ok: false,
    events: ['windows-x64', 'windows-arm64', 'eval'],
    error: expect.stringContaining('--cli-bump'),
    catalogJournal: 'prepared',
    releaseAttempt: { cli: '1.0.0' },
  });
  await expect(runCase({ cli: false, catalog: true }, 'catalog')).resolves.toMatchObject({
    ok: false, events: ['catalog'], error: expect.any(String),
    catalogJournal: 'uncertain',
  });
  await expect(runCase({ cli: false, catalog: true }, 'catalog-retry')).resolves.toMatchObject({
    first: { ok: false, events: ['catalog'], catalogJournal: 'uncertain' },
    retry: { ok: true, events: ['catalog'], catalogJournal: 'published' },
  });
});
