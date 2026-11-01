import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CatalogPublicationInspectionError,
  publicationGit,
  publicationGitExit,
  readCatalogPublicationPluginHistory,
} from '../../src/commands/catalog-publication-inspection.js';
import { createCatalogManifestV7 } from '../../src/utils/catalog-manifest-v7.js';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function publishedHistory(): Promise<{ root: string; remote: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-history-test-'));
  roots.push(root);
  const remote = path.join(root, 'remote');
  const workspaceIdentity = 'fixture:catalog-history';
  await fs.outputJson(path.join(root, '.aw-workspace.json'), {
    schemaVersion: 1, kind: 'aw-catalog-workspace', workspaceIdentity,
  });
  await fs.ensureDir(remote);
  await fs.writeJson(path.join(remote, '.aw-generated.json'), {
    schemaVersion: 1, kind: 'catalog', workspaceIdentity,
    sourceIdentity: `sha256:${crypto.createHash('sha256').update('fixture').digest('hex')}`,
  });
  await fs.writeJson(path.join(remote, 'catalog-manifest.json'), createCatalogManifestV7({
    catalogVersion: '1.0.0', channel: 'latest',
    requires: { aw: { capabilities: ['aw.catalog-snapshot.v7'] } },
    marketplace: {
      owner: { name: 'Fixture Owner', url: 'https://example.invalid/fixture' },
      interface: { displayName: 'Fixture Catalog' },
    },
    release: { state: 'published', sourceHead: '1'.repeat(40) }, entries: [],
  }));
  await execFileAsync('git', ['init', '--quiet', '--initial-branch=catalog/latest'], { cwd: remote });
  await execFileAsync('git', ['add', '--all'], { cwd: remote });
  await execFileAsync('git', [
    '-c', 'user.name=AW Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'published metadata',
  ], { cwd: remote });
  return { root, remote };
}

afterEach(async () => {
  const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  vi.mocked(spawn).mockReset().mockImplementation(original.spawn);
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('Catalog publication history Git failures', () => {
  it('finishes fetch maintenance before returning and removing its temporary repository', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-maintenance-test-'));
    roots.push(root);
    const source = path.join(root, 'source');
    await fs.ensureDir(source);
    await execFileAsync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: source });
    // Both blobs land in Git's sampled loose-object bucket, triggering old GC and geometric maintenance.
    for (const value of [26, 44]) {
      const filename = `sample-${value}.txt`;
      await fs.writeFile(path.join(source, filename), `sample-${value}\n`);
      const blob = await execFileAsync('git', ['hash-object', filename], { cwd: source });
      expect(blob.stdout).toMatch(/^17/u);
    }
    await execFileAsync('git', ['add', '--all'], { cwd: source });
    await execFileAsync('git', [
      '-c', 'user.name=AW Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'sampled loose objects',
    ], { cwd: source });
    const commit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim();

    for (const [index, run] of [publicationGit, publicationGitExit].entries()) {
      const repository = path.join(root, `inspection-${index}`);
      await fs.ensureDir(repository);
      await execFileAsync('git', ['init', '--quiet'], { cwd: repository });
      // GC and geometric maintenance use separate thresholds across Git versions.
      for (const [key, value] of [
        ['gc.auto', '1'], ['maintenance.geometric-repack.auto', '1'],
        ['gc.autoDetach', 'true'], ['maintenance.autoDetach', 'true'],
      ]) {
        await execFileAsync('git', ['config', key, value], { cwd: repository });
      }
      const infoRefs = path.join(repository, '.git', 'info', 'refs');
      expect(await fs.pathExists(infoRefs)).toBe(false);
      const result = await run(repository, [
        'fetch', '--quiet', '--no-tags', source, 'refs/heads/main:refs/heads/fetched',
      ], process.env, 'remoteReadFailed', 'Could not fetch the fixture.');
      expect(result).not.toBe(false);
      // update-server-info runs during real repacking, not an empty maintenance check.
      expect(await fs.readFile(infoRefs, 'utf8')).toBe(`${commit}\trefs/heads/fetched\n`);
      await fs.remove(repository);
      expect(await fs.pathExists(repository)).toBe(false);
    }
  });

  it('returns a typed and bounded sanitized failure when the blob reader fails', async () => {
    const { root, remote } = await publishedHistory();
    const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const detail = `synthetic blob read failed \u001b[31mtoken=history-secret ${root}\nsecond line\u0007 ${'x'.repeat(2_500)}`;
    const script = [
      'const chunks = [];',
      'for await (const chunk of process.stdin) chunks.push(chunk);',
      "const ids = Buffer.concat(chunks).toString('ascii').trim().split('\\n');",
      "for (const id of ids) process.stdout.write(`${id} blob 0\\n\\n`);",
      `process.stderr.write(${JSON.stringify(detail)});`,
      'process.exit(23);',
    ].join('\n');
    vi.mocked(spawn).mockImplementationOnce((_command, _args, options) => {
      const child = original.spawn(process.execPath, ['--input-type=module', '-e', script], options);
      // Deliver stderr after exit so cleanup cannot replace the known exit status with a signal.
      child.stderr!.pause();
      child.once('exit', () => child.stderr!.resume());
      return child;
    });

    let failure: unknown;
    try {
      await readCatalogPublicationPluginHistory({
        workspaceRoot: root, remoteUrl: remote, branches: ['catalog/latest'], env: process.env,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CatalogPublicationInspectionError);
    const error = failure as CatalogPublicationInspectionError;
    expect(error.code).toBe('remoteBranchInvalid');
    expect(error.message).toContain('Could not read published Catalog history.');
    expect(error.message).toContain('synthetic blob read failed');
    expect(error.message).toContain('exit code 23');
    expect(error.message).not.toContain('history-secret');
    expect(error.message).not.toContain(root);
    expect(error.message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(error.message.length).toBeLessThanOrEqual(
      'Could not read published Catalog history. '.length + 2_000,
    );
  });
});
