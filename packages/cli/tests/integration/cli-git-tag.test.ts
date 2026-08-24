import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertCliTagAvailable,
  cliTagName,
  ensureCliTag,
} from '../../../../scripts/release/cli-git-tag.mjs';
import { captureCommand } from '../../../../scripts/release/common.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function git(args: string[], cwd?: string) {
  return captureCommand('git', args, { cwd });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-tag-test-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  await fs.mkdir(repo);
  await git(['init', '--quiet', '--object-format=sha1'], repo);
  await fs.writeFile(path.join(repo, 'source.txt'), 'source\n');
  await git(['add', 'source.txt'], repo);
  await git(['-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'source'], repo);
  await git(['init', '--bare', '--quiet', '--object-format=sha1', remote]);
  await git(['remote', 'add', 'origin', remote], repo);
  const head = (await git(['rev-parse', 'HEAD'], repo)).stdout.trim();
  return { repo, remote, head };
}

describe('CLI source tags', () => {
  it('publishes an annotated tag for the prepared source commit and is idempotent', async () => {
    const { repo, remote, head } = await fixture();
    const version = '0.1.0-beta.1';
    await expect(assertCliTagAvailable(version, { repoRoot: repo })).resolves.toBeUndefined();

    await expect(ensureCliTag(version, head, { repoRoot: repo })).resolves.toMatchObject({
      status: 'published', version, sourceHead: head,
    });
    expect((await git([
      '--git-dir', remote, 'cat-file', '-t', `refs/tags/${cliTagName(version)}`,
    ])).stdout.trim()).toBe('tag');
    expect((await git([
      '--git-dir', remote, 'rev-parse', `refs/tags/${cliTagName(version)}^{commit}`,
    ])).stdout.trim()).toBe(head);
    await expect(ensureCliTag(version, head, { repoRoot: repo })).resolves.toMatchObject({
      status: 'already-published',
    });
  });

  it('rejects an existing tag that points to another source commit', async () => {
    const { repo, remote, head } = await fixture();
    await fs.writeFile(path.join(repo, 'source.txt'), 'other\n');
    await git(['add', 'source.txt'], repo);
    await git(['-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '-m', 'other'], repo);
    const other = (await git(['rev-parse', 'HEAD'], repo)).stdout.trim();
    const version = '0.1.0-beta.2';
    await git(['tag', cliTagName(version), other], repo);
    await git(['push', 'origin', `refs/tags/${cliTagName(version)}`], repo);

    await expect(ensureCliTag(version, head, { repoRoot: repo }))
      .rejects.toThrow('does not point to the prepared source commit');
    expect((await git([
      '--git-dir', remote, 'rev-parse', `refs/tags/${cliTagName(version)}^{commit}`,
    ])).stdout.trim()).toBe(other);
  });
});
