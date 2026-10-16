import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { archiveCandidate, bytesDigest, extractCandidate, sealCandidateDirectory, verifyCandidateDirectory } from './candidate-archive.mjs';

async function fixture(t, product = 'cli') {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-candidate-archive-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'candidate');
  const write = async (relative, bytes, mode = 0o644) => {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), bytes, { mode });
  };
  if (product === 'cli') {
    await write('cli/prepared/descriptor.json', '{}');
    await write('cli/attempted.json', '{}');
    for (let index = 0; index < 5; index += 1) await write(`cli/prepared/artifacts/package-${index}.tgz`, `package-${index}`);
  } else {
    await write('catalog/publication/journal.json', '{}');
    await write('catalog/publication/repository/.git/HEAD', 'ref: refs/heads/catalog/beta\n');
    await write('catalog/publication/repository/runner.mjs', '#!/usr/bin/env node\n', 0o755);
    for (let index = 0; index < 5; index += 1) await write(`tools/package-${index}.tgz`, `package-${index}`);
  }
  const metadata = { product, version: '1.0.1-beta.1', sourceHead: '1'.repeat(40), candidateHead: '2'.repeat(40) };
  await sealCandidateDirectory(root, metadata);
  return { temporary, root, metadata, write, archive: path.join(temporary, 'candidate.tar'), unpacked: path.join(temporary, 'unpacked') };
}

test('candidate archives preserve exact files, hidden Git state, and executable mode across locations', async (t) => {
  const f = await fixture(t, 'catalog');
  const digest = await archiveCandidate(f.root, f.archive);
  await extractCandidate(f.archive, f.unpacked, digest);
  const imported = await verifyCandidateDirectory(f.unpacked, f.metadata);
  assert.equal(imported.files.length, 8);
  assert.equal(await fs.readFile(path.join(f.unpacked, 'catalog/publication/repository/.git/HEAD'), 'utf8'), 'ref: refs/heads/catalog/beta\n');
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.unpacked, 'catalog/publication/repository/runner.mjs'))).mode & 0o777, 0o755);
});

test('changed bytes, missing recovery files, and wrong source identity fail before consumption', async (t) => {
  const f = await fixture(t);
  const digest = await archiveCandidate(f.root, f.archive);
  await assert.rejects(extractCandidate(f.archive, f.unpacked, `sha256:${'0'.repeat(64)}`), /digest does not match/u);
  await assert.rejects(verifyCandidateDirectory(f.root, { candidateHead: '3'.repeat(40) }), /candidateHead/u);
  await fs.rm(path.join(f.root, 'cli/attempted.json'));
  await assert.rejects(verifyCandidateDirectory(f.root), /files changed|missing/u);
  await fs.appendFile(f.archive, 'changed');
  await assert.rejects(extractCandidate(f.archive, f.unpacked, digest), /digest does not match/u);
});

test('a matching archive digest cannot authorize traversal, links, or extra files', async (t) => {
  const f = await fixture(t);
  await archiveCandidate(f.root, f.archive);
  const bytes = await fs.readFile(f.archive);
  bytes.fill(0, 0, 100);
  bytes.write('../escape');
  bytes.fill(32, 148, 156);
  bytes.write(`${bytes.subarray(0, 512).reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  await fs.writeFile(f.archive, bytes);
  await assert.rejects(extractCandidate(f.archive, f.unpacked, bytesDigest(bytes)), /unsafe path/u);
  await f.write('cli/unlisted-secret', 'not a release file');
  await assert.rejects(sealCandidateDirectory(f.root, f.metadata), /inventory is invalid/u);
});
