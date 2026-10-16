import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { bytesDigest } from './candidate-archive.mjs';
import { captureCommand, repoRoot as defaultRepoRoot, runReleaseGit } from './common.mjs';

const PACKAGE_NAMES = [
  '@lesliechan721/aw-windows-job-win32-x64', '@lesliechan721/aw-windows-job-win32-arm64',
  '@lesliechan721/agent-skill-eval', '@lesliechan721/aw-plugin-core', '@lesliechan721/aw',
];

export async function githubRequest(endpoint, options = {}) {
  const env = options.env ?? process.env;
  const response = await (options.fetch ?? fetch)(`${env.GITHUB_API_URL ?? 'https://api.github.com'}${endpoint}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      Authorization: `Bearer ${env.GH_TOKEN ?? env.GITHUB_TOKEN ?? ''}`,
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`GitHub release evidence query failed (${response.status}).`);
  return response;
}

async function pages(endpoint, field, options) {
  const entries = [];
  for (let page = 1; ; page += 1) {
    const response = await (options.githubRequest ?? githubRequest)(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`, options);
    const body = await response.json();
    if (!Array.isArray(body[field])) throw new Error('GitHub returned invalid release evidence.');
    entries.push(...body[field]);
    if (body[field].length < 100) return entries;
  }
}

function repository(options) {
  const value = (options.env ?? process.env).GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/u.test(value ?? '')) throw new Error('GITHUB_REPOSITORY is required to inspect release runs.');
  return value;
}

// Job names come from ci.yml. A renamed or missing check requires full release
// verification until this list is updated. The beta job itself can still run.
const REQUIRED_MAIN_CI_JOBS = [
  'Linux x64 / Node 22',
  'Linux x64 / Node 24 / release verification',
  'Linux x64 / Node 24 / plugin tests',
  'darwin arm64 / Node 24',
  'win32 x64 / Node 24 / integration 1 of 3',
  'win32 x64 / Node 24 / integration 2 of 3',
  'win32 x64 / Node 24 / integration 3 of 3',
];

export async function canReuseMainCi(candidate, options = {}) {
  const env = options.env ?? process.env;
  if (candidate.channel !== 'beta' || env.GITHUB_EVENT_NAME !== 'push') return false;
  try {
    const { stdout } = await (options.runGit ?? runReleaseGit)([
      'for-each-ref', '--format=%(objecttype)%0a%(contents)', `refs/tags/${candidate.tag}`,
    ], { ...options, cwd: options.repoRoot ?? defaultRepoRoot });
    const identity = /^tag\nAutomatic beta\n\nAW-CI: ([1-9]\d*)\/([1-9]\d*)$/u.exec(stdout.trim());
    if (!identity) return false;
    const [, runId, attempt] = identity;
    const repo = repository(options);
    const runs = await pages(`/repos/${repo}/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${candidate.sourceHead}`, 'workflow_runs', options);
    if (!runs.some((run) => String(run.id) === runId && String(run.run_attempt) === attempt
      && run.event === 'push' && run.head_branch === 'main' && run.head_sha === candidate.sourceHead
      && run.head_repository?.full_name === repo)) return false;
    const jobs = await pages(`/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs`, 'jobs', options);
    return REQUIRED_MAIN_CI_JOBS.every((name) => jobs.some((job) => job.name === name
      && job.status === 'completed' && job.conclusion === 'success'));
  } catch {
    (options.log ?? console.warn)('Main CI evidence is unavailable; full release verification is required.');
    return false;
  }
}

function candidateArtifactKind(artifact, candidate, run) {
  if (artifact.workflow_run?.head_sha !== run.head_sha) return null;
  const identity = `${candidate.product}-${candidate.version}`;
  if (artifact.name === `candidate-${identity}`) return 'initial';
  for (const kind of ['final', 'write-intent']) {
    const prefix = `${kind}-${identity}-${run.id}-`;
    if (artifact.name?.startsWith(prefix) && /^[1-9]\d*$/u.test(artifact.name.slice(prefix.length))) return kind;
  }
  return null;
}

export async function releaseRuns(candidate, options = {}) {
  const repo = repository(options);
  const endpoint = `/repos/${repo}/actions/workflows/release-${candidate.product}.yml/runs`;
  const [pushes, dispatches] = await Promise.all([
    pages(`${endpoint}?head_sha=${candidate.candidateHead}&event=push`, 'workflow_runs', options),
    pages(`${endpoint}?branch=main&event=workflow_dispatch`, 'workflow_runs', options),
  ]);
  const runs = pushes.filter((run) => run.event === 'push' && run.head_sha === candidate.candidateHead
    && run.head_branch === candidate.tag && run.head_repository?.full_name === repo);
  for (const run of dispatches) {
    if (run.event !== 'workflow_dispatch' || run.head_branch !== 'main' || run.head_repository?.full_name !== repo) continue;
    // A repair run's event SHA is main, even though its jobs check out C.
    // Its exact candidate artifact associates that trusted run with this version.
    const artifacts = await pages(`/repos/${repo}/actions/runs/${run.id}/artifacts`, 'artifacts', options);
    if (artifacts.some((artifact) => ['final', 'write-intent'].includes(candidateArtifactKind(artifact, candidate, run)))) {
      runs.push({ ...run, candidateArtifacts: artifacts });
    }
  }
  return runs;
}

async function archiveDigest(artifact, options) {
  const repo = repository(options);
  const response = await (options.githubRequest ?? githubRequest)(`/repos/${repo}/actions/artifacts/${artifact.id}/zip`, options);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!/^sha256:[0-9a-f]{64}$/u.test(artifact.digest ?? '') || bytesDigest(bytes) !== artifact.digest) {
    throw new Error('Saved Actions artifact digest does not match. Use a new version.');
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-artifact-'));
  try {
    const zip = path.join(temporary, 'artifact.zip');
    await fs.writeFile(zip, bytes);
    const { stdout } = await (options.captureCommand ?? captureCommand)('unzip', ['-p', zip, 'digest.txt']);
    const value = stdout.trim();
    if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error('Saved candidate archive digest is missing.');
    return value;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function findRecoveryArtifact(candidate, options = {}) {
  const env = options.env ?? process.env;
  const runs = options.runs ?? await releaseRuns(candidate, options);
  const artifacts = [];
  for (const run of runs) {
    const files = run.candidateArtifacts ?? await pages(`/repos/${repository(options)}/actions/runs/${run.id}/artifacts`, 'artifacts', options);
    for (const artifact of files) {
      const kind = candidateArtifactKind(artifact, candidate, run);
      const final = kind === 'final';
      if (kind === 'initial' || final) {
        artifacts.push({ ...artifact, runId: run.id, final });
      }
    }
  }
  artifacts.sort((left, right) => Number(right.final) - Number(left.final)
    || Date.parse(right.created_at) - Date.parse(left.created_at));
  const selected = artifacts[0];
  if (selected) {
    if (selected.expired) throw new Error('The exact candidate artifact expired. Publish a new version.');
    const digest = await (options.readArtifactDigest ?? archiveDigest)(selected, options);
    return { recovery_run: String(selected.runId), recovery_artifact: String(selected.id), recovery_digest: digest, recovery_final: String(selected.final), recovery_archive: selected.final ? 'final.tar' : 'candidate.tar' };
  }
  const previous = env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    || Number(env.GITHUB_RUN_ATTEMPT ?? 1) > 1
    || runs.some((run) => String(run.id) !== env.GITHUB_RUN_ID);
  if (previous) throw new Error('A previous candidate run has no complete recovery artifact. Publish a new version.');
  return { recovery_run: '', recovery_artifact: '', recovery_digest: '', recovery_final: 'false', recovery_archive: 'candidate.tar' };
}

export async function readRemoteCompletion(candidate, options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const ref = `refs/tags/${candidate.product === 'cli' ? 'cli' : 'catalog'}-v${candidate.version}`;
  const branchRef = candidate.product === 'catalog'
    ? `refs/heads/catalog/${candidate.channel === 'stable' ? 'latest' : 'beta'}` : null;
  const { stdout } = await (options.runGit ?? runReleaseGit)([
    'ls-remote', options.remote ?? 'origin', ref, `${ref}^{}`, ...branchRef ? [branchRef] : [],
  ], { ...options, cwd: repoRoot });
  const refs = new Map(stdout.trim().split('\n').filter(Boolean).map((line) => line.split(/\s+/u).reverse()));
  if (!refs.has(ref)) return false;
  const commit = refs.get(`${ref}^{}`);
  if (!commit) throw new Error('Release completion tag must be annotated.');
  if (candidate.product === 'cli') {
    if (commit !== candidate.candidateHead) throw new Error('CLI completion tag conflicts with the selected source candidate.');
    for (const name of PACKAGE_NAMES) {
      const versions = await (options.readPackageVersions ?? (async (packageName) => {
        const result = await (options.captureCommand ?? captureCommand)('npm', ['view', packageName, 'versions', '--json'], { cwd: repoRoot, env: options.env });
        return JSON.parse(result.stdout);
      }))(name);
      if (!Array.isArray(versions) || !versions.includes(candidate.version)) throw new Error('CLI completion tag exists without all five published packages.');
    }
    return true;
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-complete-'));
  try {
    const run = (args) => (options.captureCommand ?? captureCommand)('git', args, { cwd: temporary, env: options.env });
    await run(['init', '--bare', '--template=']);
    const remote = await (options.runGit ?? runReleaseGit)(['remote', 'get-url', options.remote ?? 'origin'], { ...options, cwd: repoRoot });
    await run(['fetch', '--no-tags', remote.stdout.trim(), `${ref}:${ref}`]);
    const manifest = JSON.parse((await run(['show', `${ref}:catalog-manifest.json`])).stdout);
    if (manifest.schemaVersion !== 7 || manifest.catalogVersion !== candidate.version
      || manifest.channel !== (candidate.channel === 'stable' ? 'latest' : 'beta')
      || manifest.release?.state !== 'published' || manifest.release.sourceHead !== candidate.candidateHead) {
      throw new Error('Catalog completion tag conflicts with the selected candidate.');
    }
    if (!refs.has(branchRef)) return false;
    await run(['fetch', '--no-tags', remote.stdout.trim(), `${branchRef}:${branchRef}`]);
    const branchCommit = (await run(['rev-parse', branchRef])).stdout.trim();
    if (branchCommit !== refs.get(branchRef)) throw new Error('Catalog channel changed during completion inspection. Retry inspection.');
    const bases = (await run(['merge-base', '--all', commit, branchCommit])).stdout.trim().split('\n');
    if (bases.length === 1 && bases[0] === commit) return true;
    if (bases.length === 1 && bases[0] === branchCommit) return false;
    throw new Error('Catalog channel conflicts with the saved publication history.');
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

// A rerun of only the failed publish job does not execute inspect again. Check
// the previous attempts here too, before granting the saved initial write intent.
export async function assertFirstPublication(candidate, options = {}) {
  const env = options.env ?? process.env;
  if (!env.GITHUB_RUN_ID) {
    if (options.allowLocalPublication === true) return;
    throw new Error('Actions publication requires the exact workflow run identity.');
  }
  const runs = await releaseRuns(candidate, options);
  for (const run of runs) {
    const current = String(run.id) === env.GITHUB_RUN_ID;
    const previousAttempts = current ? Number(env.GITHUB_RUN_ATTEMPT ?? 1) - 1 : Number(run.run_attempt ?? 1);
    for (let attempt = 1; attempt <= previousAttempts; attempt += 1) {
      const jobs = await pages(`/repos/${repository(options)}/actions/runs/${run.id}/attempts/${attempt}/jobs`, 'jobs', options);
      if (jobs.some((job) => /publish/iu.test(job.name) && job.started_at !== null && job.started_at !== undefined)) {
        throw new Error('This candidate entered publication in a previous attempt. Use explicit repair with its unchanged artifact, or publish a new version.');
      }
    }
  }
}
