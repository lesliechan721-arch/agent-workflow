import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { assertFirstPublication, findRecoveryArtifact, readRemoteCompletion } from './actions-inspection.mjs';
import { parseActionsArgs } from './actions-release.mjs';
import { captureCommand } from './common.mjs';

const candidate = { product: 'cli', version: '1.0.1-beta.2', candidateHead: 'a'.repeat(40), tag: 'release/cli/v1.0.1-beta.2' };
const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '12', GITHUB_RUN_ATTEMPT: '1' };
const run = { id: 12, event: 'push', head_sha: candidate.candidateHead, head_branch: candidate.tag, head_repository: { full_name: 'owner/repo' }, run_attempt: 1 };
const digest = `sha256:${'b'.repeat(64)}`;

function api(artifacts, jobs = [], runs = [run]) {
  return async (endpoint) => ({ json: async () => endpoint.includes('/jobs') ? { jobs }
    : endpoint.includes('/artifacts') ? { artifacts } : { workflow_runs: runs } });
}

test('release recovery chooses exact saved final identity and rejects expired or absent evidence', async () => {
  const artifacts = [
    { id: 1, name: `candidate-cli-${candidate.version}`, created_at: '2026-10-15T01:00:00Z', expired: false, workflow_run: { head_sha: candidate.candidateHead } },
    { id: 2, name: `final-cli-${candidate.version}-12-1`, created_at: '2026-10-15T02:00:00Z', expired: false, workflow_run: { head_sha: candidate.candidateHead } },
    { id: 3, name: `final-cli-${candidate.version}-12-2`, created_at: '2026-10-15T03:00:00Z', expired: false, workflow_run: { head_sha: 'c'.repeat(40) } },
  ];
  const result = await findRecoveryArtifact(candidate, { env, githubRequest: api(artifacts), readArtifactDigest: async (entry) => { assert.equal(entry.id, 2); return digest; } });
  assert.equal(result.recovery_artifact, '2');
  assert.equal(result.recovery_archive, 'final.tar');
  assert.equal(result.recovery_run, '12');
  assert.equal(result.recovery_digest, digest);
  artifacts[1].expired = true;
  await assert.rejects(findRecoveryArtifact(candidate, { env, githubRequest: api(artifacts) }), /expired/u);
  await assert.rejects(findRecoveryArtifact(candidate, { env: { ...env, GITHUB_RUN_ATTEMPT: '2' }, githubRequest: api([]) }), /no complete recovery artifact/u);
});

test('failed-job reruns cannot reuse a pre-write intent after a publisher started', async () => {
  await assert.rejects(assertFirstPublication(candidate, { env: { ...env, GITHUB_RUN_ATTEMPT: '2' }, githubRequest: api([], [{ name: 'Publish CLI', started_at: '2026-10-15T02:00:00Z' }]) }), /explicit repair/u);
  await assertFirstPublication(candidate, { env: { ...env, GITHUB_RUN_ATTEMPT: '2' }, githubRequest: api([], [{ name: 'Smoke Linux', started_at: '2026-10-15T02:00:00Z' }]) });
  await assert.rejects(assertFirstPublication(candidate, { env: {} }), /exact workflow run identity/u);
});

test('manual repairs contribute their final archive and block a later ordinary publication', async () => {
  const manual = { ...run, id: 13, event: 'workflow_dispatch', head_sha: 'd'.repeat(40), head_branch: 'main' };
  const artifacts = new Map([
    [12, [{ id: 1, name: `candidate-cli-${candidate.version}`, created_at: '2026-10-14T01:00:00Z', expired: false, workflow_run: { head_sha: candidate.candidateHead } }]],
    [13, [{ id: 2, name: `final-cli-${candidate.version}-13-1`, created_at: '2026-10-15T02:00:00Z', expired: false, workflow_run: { head_sha: manual.head_sha } }]],
  ]);
  const githubRequest = async (endpoint) => {
    if (endpoint.includes('/jobs')) return { json: async () => ({ jobs: endpoint.includes('/runs/13/')
      ? [{ name: 'Publish CLI', started_at: '2026-10-15T02:00:00Z' }] : [] }) };
    const artifactRun = /\/runs\/(\d+)\/artifacts/u.exec(endpoint);
    return { json: async () => artifactRun ? { artifacts: artifacts.get(Number(artifactRun[1])) ?? [] }
      : { workflow_runs: endpoint.includes('event=workflow_dispatch') ? [manual] : [run] } };
  };
  const options = { env: { ...env, GITHUB_RUN_ID: '14' }, githubRequest, readArtifactDigest: async (artifact) => { assert.equal(artifact.id, 2); return digest; } };
  const recovered = await findRecoveryArtifact(candidate, options);
  assert.equal(recovered.recovery_run, '13');
  assert.equal(recovered.recovery_artifact, '2');
  assert.equal(recovered.recovery_archive, 'final.tar');
  await assert.rejects(assertFirstPublication(candidate, options), /explicit repair/u);

  // Even if repair dies before its final upload, the saved pre-write artifact
  // identifies that candidate's manual attempt. It is not a replacement bundle.
  artifacts.get(13)[0].name = `write-intent-cli-${candidate.version}-13-1`;
  const initial = await findRecoveryArtifact(candidate, { ...options, readArtifactDigest: async () => digest });
  assert.equal(initial.recovery_run, '12');
  await assert.rejects(assertFirstPublication(candidate, options), /explicit repair/u);

  // Another candidate and a non-main dispatch must not occupy this candidate.
  artifacts.get(13)[0].name = 'write-intent-cli-9.9.9-13-1';
  await assertFirstPublication(candidate, { ...options, githubRequest: async (endpoint) => endpoint.includes('/jobs')
    ? { json: async () => ({ jobs: [] }) } : githubRequest(endpoint) });
  artifacts.get(13)[0].name = `write-intent-cli-${candidate.version}-13-1`;
  manual.head_branch = 'untrusted-branch';
  await assertFirstPublication(candidate, options);
});

test('a manual recovery without its saved candidate cannot prepare the version again', async () => {
  await assert.rejects(findRecoveryArtifact(candidate, {
    env: { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }, githubRequest: api([], [], []),
  }), /no complete recovery artifact/u);
});

test('a CLI completion tag requires the exact source and all five remote packages', async () => {
  const runGit = async () => ({ stdout: `tag-object\trefs/tags/cli-v${candidate.version}\n${candidate.candidateHead}\trefs/tags/cli-v${candidate.version}^{}\n` });
  const names = [];
  assert.equal(await readRemoteCompletion(candidate, { runGit, readPackageVersions: async (name) => { names.push(name); return [candidate.version]; } }), true);
  assert.equal(names.length, 5);
  await assert.rejects(readRemoteCompletion(candidate, { runGit, readPackageVersions: async () => [] }), /all five/u);
  await assert.rejects(readRemoteCompletion({ ...candidate, candidateHead: 'd'.repeat(40) }, { runGit }), /conflicts/u);
});

test('Catalog completion requires both the immutable tag and its channel publication', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-completion-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const remote = path.join(temporary, 'remote.git');
  const root = path.join(temporary, 'source');
  await captureCommand('git', ['init', '--bare', '--initial-branch=main', remote]);
  await captureCommand('git', ['init', '--initial-branch=main', root]);
  const git = (args) => captureCommand('git', args, { cwd: root });
  const save = async (version) => {
    await fs.writeFile(path.join(root, 'catalog-manifest.json'), JSON.stringify({ schemaVersion: 7, channel: 'beta', catalogVersion: version, release: { state: 'published', sourceHead: candidate.candidateHead } }));
    await git(['add', '.']);
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', version]);
  };
  await git(['remote', 'add', 'origin', remote]);
  await save('1.0.1-beta.1');
  const parent = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await save(candidate.version);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'tag.gpgsign=false', 'tag', '--annotate', `catalog-v${candidate.version}`, '--message', 'Candidate']);
  await git(['push', 'origin', `refs/tags/catalog-v${candidate.version}`]);
  const catalog = { ...candidate, product: 'catalog', channel: 'beta' };
  assert.equal(await readRemoteCompletion(catalog, { repoRoot: root }), false);
  await git(['push', 'origin', `${parent}:refs/heads/catalog/beta`]);
  assert.equal(await readRemoteCompletion(catalog, { repoRoot: root }), false);
  await git(['push', 'origin', 'HEAD:refs/heads/catalog/beta']);
  assert.equal(await readRemoteCompletion(catalog, { repoRoot: root }), true);
  await save('1.0.1-beta.3');
  await git(['push', 'origin', 'HEAD:refs/heads/catalog/beta']);
  assert.equal(await readRemoteCompletion(catalog, { repoRoot: root }), true);
});

test('release entry rejects ambiguous arguments before performing work', () => {
  assert.throws(() => parseActionsArgs(['publish', '--product', 'catalog', '--repair-cli']), /only the CLI/u);
  assert.throws(() => parseActionsArgs(['source', '--product', 'cli', '--product', 'catalog']), /duplicate/u);
  assert.deepEqual(parseActionsArgs(['unpack', '--archive', '/tmp/candidate.tar', '--digest', digest]), { command: 'unpack', archive: '/tmp/candidate.tar', digest });
});
