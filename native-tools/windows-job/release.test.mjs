import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishWindowsJobCandidate, prepareWindowsJobPublication, assertNativeReleaseEvidence } from './release.mjs';
import { assertFreshNativePublication } from './actions-publication.mjs';

// Test Value Gate: native partial or uncertain npm writes must consume the
// independent version without touching the CLI attempt or permitting repair.
test('partial native publication consumes the version before either write and rejects retry', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aw-native-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attemptPath = path.join(root, 'attempted.json');
  const selected = { root, candidateDigest: `sha256:${'1'.repeat(64)}`, candidate: { version: '1.0.0', packages: [{ name: '@scope/windows-x64', arch: 'x64', path: 'x64.tgz' }, { name: '@scope/windows-arm64', arch: 'arm64', path: 'arm64.tgz' }] } };
  const writes = [];
  const options = { attemptPath, readCandidate: async () => selected, assertEvidence: async () => {}, isPublished: async () => false, registryUrl: 'https://registry.invalid/', assertPublished: async () => {}, runPublish: async (_command, args) => {
    assert.equal(JSON.parse(await readFile(attemptPath, 'utf8')).publicationStarted, true);
    writes.push(path.basename(args[1]));
    if (writes.length === 2) throw new Error('uncertain');
  } };
  const intent = await prepareWindowsJobPublication(options);
  assert.equal(JSON.parse(await readFile(attemptPath, 'utf8')).publicationStarted, false);
  await assert.rejects(publishWindowsJobCandidate({ ...options, initialAttemptDigest: intent.attemptDigest }), /bump the Windows Job version/);
  assert.deepEqual(writes, ['x64.tgz', 'arm64.tgz']);
  await assert.rejects(publishWindowsJobCandidate(options), /same-version repair is not supported/);
  await assert.rejects(publishWindowsJobCandidate({ ...options, initialAttemptDigest: intent.attemptDigest }), /same-version repair is not supported/);
  assert.equal(writes.length, 2);
});

test('missing real Windows source-candidate evidence blocks native publication', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aw-native-evidence-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const selected = { root, candidateDigest: 'candidate', candidate: { sourceDigest: 'source', goVersion: 'go1.25.7' } };
  await writeFile(path.join(root, 'reproducibility.json'), JSON.stringify({ kind: 'windows-job-reproducibility', status: 'passed', candidateDigest: 'candidate', sourceDigest: 'source', goVersion: 'go1.25.7', architectures: ['x64', 'arm64'] }));
  await writeFile(path.join(root, 'qualification-x64.json'), JSON.stringify({ schemaVersion: 1, kind: 'windows-job-qualification', status: 'passed', platform: 'darwin', arch: 'x64', mode: 'source-candidate', candidateDigest: 'candidate', sourceDigest: 'source', checks: [] }));
  await assert.rejects(assertNativeReleaseEvidence(selected), /Real Windows x64/);
});

test('Actions rejects same-version previous publisher starts and failed-job reruns', async () => {
  const request = async (suffix) => {
    if (suffix.startsWith('actions/workflows/')) return { workflow_runs: [{ id: 1, head_sha: 'a'.repeat(40) }] };
    if (suffix.startsWith('actions/runs/')) return { total_count: 1, jobs: [{ name: 'Windows Job / publish', started_at: '2026-11-02T00:00:00Z', conclusion: 'failure' }] };
    return { content: Buffer.from(JSON.stringify({ version: '1.0.0' })).toString('base64') };
  };
  await assert.rejects(assertFreshNativePublication({ version: '1.0.0', runId: 2, runAttempt: 1, request }), /previous publisher attempt/);
  await assert.rejects(assertFreshNativePublication({ version: '1.0.1', runId: 2, runAttempt: 2, request }), /cannot be rerun/);
  await assertFreshNativePublication({ version: '1.0.1', runId: 2, runAttempt: 1, request });
});
