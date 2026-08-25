import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);

function workflowScope(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'workflow',
    id,
    userOutcome: 'Publish one immutable review record.',
    entry: 'skills/reviewer/SKILL.md',
    components: [{
      kind: 'skill',
      id: 'reviewer',
      path: 'skills/reviewer',
      digest: `sha256:${'1'.repeat(64)}`,
    }],
    representativePaths: ['inspect -> review -> publish'],
    externalDependencies: [],
    excluded: [],
  };
}

async function createReviewRepository(): Promise<string> {
  const isolation = getCurrentSourceTestIsolation();
  const repoRoot = isolation.layout.fixtureCwd;
  await fs.outputFile(path.join(repoRoot, '.agents', 'skills', 'static-skill', 'SKILL.md'), '# Static skill\n');
  await fs.outputFile(path.join(repoRoot, '.agents', 'skills', 'static-skill', 'README.md'), '# Static skill\n');
  await fs.outputFile(path.join(repoRoot, 'report.md'), '# Review\n\nreport-body-sentinel\n');
  await fs.writeJson(path.join(repoRoot, 'check.json'), { passed: true });
  await fs.writeJson(path.join(repoRoot, 'evidence.json'), { observed: true });
  await fs.writeJson(path.join(repoRoot, 'result.json'), { verdict: 'pass' });
  await fs.writeJson(path.join(repoRoot, 'release-check.json'), { ready: true });
  await fs.writeJson(path.join(repoRoot, 'workflow-scope.json'), workflowScope('review-flow'));
  await fs.writeJson(path.join(repoRoot, 'bad-scope.json'), {
    ...workflowScope('bad-flow'),
    unexpected: true,
  });
  await fs.outputFile(path.join(repoRoot, '.agents', 'reports', 'keep.txt'), 'keep static reports\n');
  await fs.outputFile(path.join(repoRoot, 'plugins', 'demo-plugin', 'reports', 'keep.txt'), 'keep plugin reports\n');

  await execFileAsync('git', ['init', '-q'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.email', 'test@example.test'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.name', 'Review CLI Test'], { cwd: repoRoot });
  await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
  await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
  return repoRoot;
}

async function invoke(repoRoot: string, argv: string[]) {
  const isolation = getCurrentSourceTestIsolation();
  const captured = createCapturedCliIo();
  const exitCode = await runCli(argv, {
    cwd: repoRoot,
    env: isolation.env,
    interactive: false,
    io: captured.io,
  });
  return {
    exitCode,
    stdout: captured.readStdout(),
    stderr: captured.readStderr(),
  };
}

describe('review publication public CLI', () => {
  it('publishes, verifies, lists, and shows immutable review records through the public entry', async () => {
    const repoRoot = await createReviewRepository();

    const rootHelp = await invoke(repoRoot, ['--help']);
    expect(rootHelp.exitCode).toBe(0);
    expect(rootHelp.stdout).toContain('review');

    const reviewHelp = await invoke(repoRoot, ['review', '--help']);
    expect(reviewHelp.exitCode).toBe(0);
    for (const command of ['publish', 'verify', 'list', 'show']) {
      expect(reviewHelp.stdout).toContain(command);
    }

    const publishArgs = [
      'review', 'publish',
      '--kind', 'skill',
      '--target', 'static-skill',
      '--report', 'report.md',
      '--result', 'result.json',
      '--check', 'machine-check=check.json',
      '--check', 'release-gate=release-check.json',
      '--evidence', 'trace=evidence.json',
      '--release-check', 'release-check.json',
      '--json',
    ];
    const published = await invoke(repoRoot, publishArgs);
    expect(published.exitCode, published.stderr).toBe(0);
    expect(published.stdout.endsWith('\n')).toBe(true);
    const publishedPayload = JSON.parse(published.stdout) as {
      schemaVersion: number;
      command: string;
      ok: boolean;
      existing: boolean;
      recordDir: string;
      manifest: { reviewId: string; target: { kind: string; id: string }; checks: Array<{ kind: string }> };
    };
    expect(publishedPayload).toMatchObject({
      schemaVersion: 1,
      command: 'review:publish',
      ok: true,
      existing: false,
      recordDir: expect.stringMatching(/^reports\/reviews\/skill\/id-/u),
      manifest: {
        target: { kind: 'skill', id: 'static-skill' },
        checks: [{ kind: 'machine-check' }, { kind: 'release-gate' }],
      },
    });
    expect(publishedPayload.recordDir).not.toContain('\\');

    const workflowPublished = await invoke(repoRoot, [
      'review', 'publish',
      '--kind', 'workflow',
      '--target', 'review-flow',
      '--scope', 'workflow-scope.json',
      '--report', 'report.md',
    ]);
    expect(workflowPublished.exitCode, workflowPublished.stderr).toBe(0);
    const workflowMatch = /^Published review ([^:]+): (reports\/reviews\/workflow\/\S+)\n$/u.exec(workflowPublished.stdout);
    expect(workflowMatch).not.toBeNull();
    const workflowRecordDir = workflowMatch![2]!;

    const verified = await invoke(repoRoot, ['review', 'verify', workflowRecordDir, '--json']);
    expect(verified.exitCode, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'review:verify',
      ok: true,
      recordDir: workflowRecordDir,
      manifest: { target: { kind: 'workflow', id: 'review-flow' } },
    });

    const filtered = await invoke(repoRoot, [
      'review', 'list', '--kind', 'skill', '--target', 'static-skill', '--json',
    ]);
    expect(filtered.exitCode, filtered.stderr).toBe(0);
    expect(JSON.parse(filtered.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'review:list',
      ok: true,
      records: [{
        recordDir: publishedPayload.recordDir,
        manifest: { reviewId: publishedPayload.manifest.reviewId },
      }],
    });

    const listed = await invoke(repoRoot, ['review', 'list']);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(
      `${publishedPayload.manifest.reviewId} skill static-skill`,
    );
    expect(listed.stdout).toContain(' workflow review-flow ');

    const shown = await invoke(repoRoot, [
      'review', 'show', publishedPayload.manifest.reviewId, '--json',
    ]);
    expect(shown.exitCode, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'review:show',
      ok: true,
      recordDir: publishedPayload.recordDir,
      manifest: { reviewId: publishedPayload.manifest.reviewId },
    });

    const shownText = await invoke(repoRoot, ['review', 'show', publishedPayload.manifest.reviewId]);
    expect(shownText.exitCode, shownText.stderr).toBe(0);
    expect(shownText.stdout).toContain(`Review: ${publishedPayload.manifest.reviewId}`);
    expect(shownText.stdout).toContain('Target: skill static-skill');
    expect(shownText.stdout).toContain('Published:');
    expect(shownText.stdout).toContain('Report: report.md');
    expect(shownText.stdout).toContain('Supersedes: none');
    expect(shownText.stdout).not.toContain('report-body-sentinel');

    const existing = await invoke(repoRoot, publishArgs);
    expect(existing.exitCode, existing.stderr).toBe(0);
    expect(JSON.parse(existing.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'review:publish',
      ok: true,
      existing: true,
      recordDir: publishedPayload.recordDir,
      manifest: { reviewId: publishedPayload.manifest.reviewId },
    });

    expect(await fs.readdir(path.join(repoRoot, 'reports'))).toEqual(['reviews']);
    expect(await fs.readdir(path.join(repoRoot, '.agents', 'reports'))).toEqual(['keep.txt']);
    expect(await fs.readdir(path.join(repoRoot, 'plugins', 'demo-plugin', 'reports'))).toEqual(['keep.txt']);
  });

  it('fails closed for invalid scope, kind, and attachment input', async () => {
    const repoRoot = await createReviewRepository();
    const cases = [
      [
        'review', 'publish', '--kind', 'workflow', '--target', 'bad-flow',
        '--scope', 'bad-scope.json', '--report', 'report.md',
      ],
      [
        'review', 'publish', '--kind', 'unknown', '--target', 'static-skill', '--report', 'report.md',
      ],
      [
        'review', 'publish', '--kind', 'skill', '--target', 'static-skill', '--report', 'report.md',
        '--check', 'Not-kebab=check.json',
      ],
    ];

    for (const argv of cases) {
      const result = await invoke(repoRoot, argv);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toBe('');
    }
    expect(await fs.pathExists(path.join(repoRoot, 'reports', 'reviews'))).toBe(false);
  });
});
