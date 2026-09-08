import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_REVIEW_TTL_MS,
  resolveReviewTtl,
} from '../skills/decision-prototype/scripts/review-config.mjs';

const testRoot = await mkdtemp(path.join(os.tmpdir(), 'ask-me-review-config-'));
const binRoot = path.join(testRoot, 'bin');
const projectRoot = path.join(testRoot, 'project');
const nestedRoot = path.join(projectRoot, 'nested');
const prototypePath = path.join(projectRoot, 'prototype.json');
const invocationPath = path.join(testRoot, 'invocation.json');
const originalPath = process.env.PATH;
const originalReceipt = process.env.ASK_ME_FAKE_RECEIPT;
const originalInvocation = process.env.ASK_ME_FAKE_INVOCATION;
const originalHang = process.env.ASK_ME_FAKE_HANG;

await mkdir(binRoot);
await mkdir(nestedRoot, { recursive: true });
await writeFile(prototypePath, '{}\n');
await writeFile(path.join(binRoot, 'aw'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.ASK_ME_FAKE_INVOCATION, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
if (process.env.ASK_ME_FAKE_HANG === '1') {
  process.stderr.write('private timeout output: secret-789\\n');
  setTimeout(() => {}, 60_000);
} else {
process.stdout.write(process.env.ASK_ME_FAKE_RECEIPT || '');
}
`);
await chmod(path.join(binRoot, 'aw'), 0o755);

function receipt({
  minutes = 30,
  selector = 'ask-me',
  pluginId = 'official/ask-me',
  sourceId = 'official',
  valueState = 'default',
  sourceLayer = 'default',
  valid = true,
  issues = [],
  key = 'reviewSessionTtlMinutes',
  ok = true,
  command = 'config:get',
} = {}) {
  return {
    ok,
    command,
    configSchemaVersion: 4,
    plugin: selector,
    pluginName: selector,
    pluginId,
    sourceId,
    key: 'reviewSessionTtlMinutes',
    scope: 'effective',
    fields: [{
      key,
      valueState,
      effectiveValue: minutes,
      sourceLayer,
      valid,
      issues,
    }],
  };
}

async function configureFakeAw(value) {
  process.env.PATH = `${binRoot}${path.delimiter}${originalPath || ''}`;
  process.env.ASK_ME_FAKE_RECEIPT = JSON.stringify(value);
  process.env.ASK_ME_FAKE_INVOCATION = invocationPath;
  await rm(invocationPath, { force: true });
}

test.after(async () => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalReceipt === undefined) delete process.env.ASK_ME_FAKE_RECEIPT;
  else process.env.ASK_ME_FAKE_RECEIPT = originalReceipt;
  if (originalInvocation === undefined) delete process.env.ASK_ME_FAKE_INVOCATION;
  else process.env.ASK_ME_FAKE_INVOCATION = originalInvocation;
  if (originalHang === undefined) delete process.env.ASK_ME_FAKE_HANG;
  else process.env.ASK_ME_FAKE_HANG = originalHang;
  await rm(testRoot, { recursive: true, force: true });
});

test('explicit --ttl takes priority and does not run AW', async () => {
  process.env.PATH = binRoot;
  process.env.ASK_ME_FAKE_INVOCATION = invocationPath;
  await rm(invocationPath, { force: true });

  assert.equal(await resolveReviewTtl({
    prototypePath: path.join(testRoot, 'missing.json'),
    ttlMs: MAX_REVIEW_TTL_MS,
    pluginSelector: 'another-plugin',
  }), MAX_REVIEW_TTL_MS);
  await assert.rejects(readFile(invocationPath), { code: 'ENOENT' });
  for (const invalid of [0, -1, MAX_REVIEW_TTL_MS + 1, 1.5, Number.NaN]) {
    await assert.rejects(resolveReviewTtl({ prototypePath, ttlMs: invalid }), /--ttl/);
  }
});

test('effective config uses the public AW command in the physical prototype directory', async () => {
  await configureFakeAw(receipt({
    minutes: 45,
    valueState: 'configured',
    sourceLayer: 'project',
  }));

  assert.equal(await resolveReviewTtl({
    prototypePath: path.join(nestedRoot, '..', 'prototype.json'),
  }), 2_700_000);
  const invocation = JSON.parse((await readFile(invocationPath, 'utf8')).trim());
  assert.deepEqual(invocation.argv, [
    'config', 'get', 'ask-me', 'reviewSessionTtlMinutes', '--json',
  ]);
  assert.equal(invocation.cwd, path.dirname(await realpath(prototypePath)));
});

test('a source-qualified selector must match the returned Ask Me identity', async () => {
  await configureFakeAw(receipt({
    minutes: 240,
    selector: 'team/ask-me',
    pluginId: 'team/ask-me',
    sourceId: 'team',
    valueState: 'configured',
    sourceLayer: 'user',
  }));
  assert.equal(await resolveReviewTtl({ prototypePath, pluginSelector: 'team/ask-me' }), MAX_REVIEW_TTL_MS);

  await configureFakeAw(receipt({
    minutes: 60,
    pluginId: 'team/ask-me',
    sourceId: 'team',
    valueState: 'configured',
    sourceLayer: 'project',
  }));
  assert.equal(await resolveReviewTtl({ prototypePath, pluginSelector: 'team/ask-me' }), 3_600_000);

  await configureFakeAw(receipt({ pluginId: 'official/ask-me', sourceId: 'official' }));
  await assert.rejects(
    resolveReviewTtl({ prototypePath, pluginSelector: 'team/ask-me' }),
    /--ttl/,
  );
  await assert.rejects(
    resolveReviewTtl({ prototypePath, pluginSelector: 'other' }),
    /selector must identify ask-me/,
  );
});

test('invalid AW receipts fail without exposing receipt content', async () => {
  const invalidReceipts = [
    receipt({ ok: false }),
    receipt({ command: 'config:list' }),
    { ...receipt(), configSchemaVersion: 3 },
    { ...receipt(), scope: 'user' },
    { ...receipt(), pluginName: 'other' },
    { ...receipt(), key: 'otherField' },
    receipt({ pluginId: 'official/foreign', sourceId: 'official' }),
    receipt({ key: 'otherField' }),
    receipt({ valid: false, issues: [{ message: 'private value: secret-123' }] }),
    receipt({ minutes: 0 }),
    receipt({ minutes: 241 }),
    receipt({ minutes: 2.5 }),
    receipt({ valueState: 'configured', sourceLayer: 'default' }),
  ];

  for (const invalidReceipt of invalidReceipts) {
    await configureFakeAw(invalidReceipt);
    await assert.rejects(
      resolveReviewTtl({ prototypePath }),
      (error) => {
        assert.match(error.message, /--ttl/);
        assert.doesNotMatch(error.message, /secret-123/);
        return true;
      },
    );
  }
});

test('missing AW and malformed output fail without a silent default', async () => {
  process.env.PATH = path.join(testRoot, 'empty-bin');
  await mkdir(process.env.PATH);
  await assert.rejects(resolveReviewTtl({ prototypePath }), /--ttl/);

  await configureFakeAw(undefined);
  process.env.ASK_ME_FAKE_RECEIPT = 'not-json secret-456';
  await assert.rejects(
    resolveReviewTtl({ prototypePath }),
    (error) => {
      assert.match(error.message, /invalid config receipt/);
      assert.doesNotMatch(error.message, /secret-456/);
      return true;
    },
  );
});

test('a hung AW config read fails within a fixed bound without exposing process output', async () => {
  await configureFakeAw(receipt());
  process.env.ASK_ME_FAKE_HANG = '1';
  const startedAt = Date.now();

  await assert.rejects(
    resolveReviewTtl({ prototypePath }),
    (error) => {
      assert.match(error.message, /--ttl/);
      assert.doesNotMatch(error.message, /secret-789/);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 8_000, 'AW config read must have a bounded timeout');
  delete process.env.ASK_ME_FAKE_HANG;
});
