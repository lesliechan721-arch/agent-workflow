import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { readGitBlobsBatch } from '../../authoring/scripts/lib/plugin-version-check.mjs';

const tempDirs: string[] = [];
const firstObjectId = '1'.repeat(40);
const secondObjectId = '2'.repeat(40);

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

async function createFakeGit(mode: string): Promise<NodeJS.ProcessEnv> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-git-batch-test-'));
  tempDirs.push(root);
  const binRoot = path.join(root, 'bin');
  await fs.ensureDir(binRoot);
  await fs.writeFile(path.join(binRoot, 'git'), [
    '#!/usr/bin/env node',
    "const chunks = [];",
    "for await (const chunk of process.stdin) chunks.push(chunk);",
    "const ids = Buffer.concat(chunks).toString('ascii').trim().split('\\n').filter(Boolean);",
    "const mode = process.env.AW_FAKE_GIT_BATCH_MODE;",
    "const write = (value) => process.stdout.write(value);",
    "if (mode !== 'silent') for (const [index, id] of ids.entries()) {",
    "  if (mode === 'missing') { write(`${id} missing\\n`); continue; }",
    "  if (mode === 'nonblob') { write(`${id} tree 0\\n\\n`); continue; }",
    "  if (mode === 'malformed') { write('malformed header\\n'); continue; }",
    "  if (mode === 'invalid-size') { write(`${id} blob nope\\n`); continue; }",
    "  if (mode === 'oversized') { write(`${id} blob 52428801\\n`); continue; }",
    "  if (mode === 'truncated') { write(`${id} blob 5\\nabc`); process.exit(0); }",
    "  if (mode === 'invalid-separator') { write(`${id} blob 3\\nabc!`); continue; }",
    "  const content = index === 0 ? Buffer.from([0x61, 0x0a, 0x00, 0x62]) : Buffer.alloc(256 * 1024 + 17, 0x63);",
    "  write(`${id} blob ${content.length}\\n`);",
    "  for (let offset = 0; offset < content.length; offset += 997) write(content.subarray(offset, offset + 997));",
    "  write('\\n');",
    "}",
    "if (mode === 'nonzero') { process.stderr.write('synthetic cat-file failure\\n'); process.exit(7); }",
    "if (mode === 'stderr') process.stderr.write('synthetic stderr\\n');",
    "if (mode === 'signal') process.kill(process.pid, 'SIGTERM');",
    "if (mode === 'silent' || mode === 'complete-no-exit') {",
    "  process.on('SIGTERM', () => {});",
    "  setTimeout(() => process.exit(98), 10000);",
    "  setInterval(() => {}, 1000);",
    "}",
  ].join('\n'), 'utf8');
  await fs.chmod(path.join(binRoot, 'git'), 0o755);
  return {
    ...process.env,
    AW_FAKE_GIT_BATCH_MODE: mode,
    PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ''}`,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('Git cat-file batch authoring source reader', () => {
  it('deduplicates object IDs and preserves binary and multi-chunk blob bytes', async () => {
    const result = await readGitBlobsBatch(repoRoot(), [
      firstObjectId,
      firstObjectId,
      secondObjectId,
    ], { env: await createFakeGit('success') });

    expect([...result.keys()]).toEqual([firstObjectId, secondObjectId]);
    expect(result.get(firstObjectId)).toEqual(Buffer.from([0x61, 0x0a, 0x00, 0x62]));
    expect(result.get(secondObjectId)).toEqual(Buffer.alloc(256 * 1024 + 17, 0x63));
  });

  it.each([
    ['missing', 'is missing'],
    ['nonblob', 'is not a blob'],
    ['malformed', 'malformed header'],
    ['invalid-size', 'invalid size'],
    ['oversized', 'exceeds the size limit'],
    ['truncated', 'ended during a blob'],
    ['invalid-separator', 'invalid separator'],
    ['nonzero', 'synthetic cat-file failure'],
    ['stderr', 'synthetic stderr'],
    ['signal', 'signal'],
  ])('fails closed without hanging for %s output', async (mode, message) => {
    const startedAt = Date.now();
    await expect(readGitBlobsBatch(repoRoot(), [firstObjectId], {
      env: await createFakeGit(mode),
    })).rejects.toThrow(message);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it.each(['silent', 'complete-no-exit'])(
    'bounds a %s cat-file child from spawn through exit',
    async (mode) => {
      const startedAt = Date.now();
      await expect(readGitBlobsBatch(repoRoot(), [firstObjectId], {
        env: await createFakeGit(mode),
        operationTimeoutMs: 50,
      })).rejects.toMatchObject({
        code: 'gitFailed',
        message: 'Git cat-file batch timed out.',
      });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    },
  );
});
