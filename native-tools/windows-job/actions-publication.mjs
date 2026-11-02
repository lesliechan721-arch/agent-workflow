import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Native publication has no same-version repair. Actions history provides the
// same prior-attempt boundary that the local version-scoped attempt file owns.
export async function assertFreshNativePublication({ version, runId, runAttempt, request }) {
  if (Number(runAttempt) !== 1) throw new Error('A native publisher job cannot be rerun. Bump the tool version.');
  for (let page = 1; page <= 10; page += 1) {
    const response = await request(`actions/workflows/windows-job.yml/runs?per_page=100&page=${page}`);
    if (!Array.isArray(response.workflow_runs)) throw new Error('Native publication history is unavailable. Bump the tool version.');
    for (const run of response.workflow_runs) {
      if (String(run.id) === String(runId)) continue;
      const jobs = await request(`actions/runs/${run.id}/jobs?filter=all&per_page=100`);
      if (!Array.isArray(jobs.jobs) || jobs.total_count > 100) throw new Error('Native publication history is incomplete. Bump the tool version.');
      if (!jobs.jobs.some((job) => job.name === 'Windows Job / publish' && job.started_at && job.conclusion !== 'skipped')) continue;
      if (!/^[a-f0-9]{40,64}$/u.test(run.head_sha ?? '')) throw new Error('Native publication source identity is unavailable.');
      const source = await request(`contents/native-tools/windows-job/tool.json?ref=${run.head_sha}`);
      let tool;
      try { tool = JSON.parse(Buffer.from(source.content, 'base64').toString('utf8')); }
      catch { throw new Error('Native publication version history is unavailable. Bump the tool version.'); }
      if (tool.version === version) throw new Error('This native version has a previous publisher attempt. Bump the tool version.');
    }
    if (response.workflow_runs.length < 100) return;
  }
  throw new Error('Native publication history exceeds the inspection bound. Use a new tool version.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const repository = process.env.GITHUB_REPOSITORY;
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? '') || !process.env.GITHUB_TOKEN) throw new Error('GitHub publication identity is required.');
    const tool = JSON.parse(await readFile(new URL('./tool.json', import.meta.url), 'utf8'));
    await assertFreshNativePublication({ version: tool.version, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, request: async (suffix) => {
      const response = await fetch(`https://api.github.com/repos/${repository}/${suffix}`, { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error('GitHub native publication history could not be verified.');
      return response.json();
    } });
    console.log('Native publication has no earlier publisher attempt for this version.');
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
