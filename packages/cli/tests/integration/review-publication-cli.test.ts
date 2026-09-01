import { execFile } from 'node:child_process';
import os from 'node:os';
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
      digest: 'sha256:5d309d6438300806b9a51b4587627ef066fe0b00244066caef20fa2a69c58a98',
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
  await fs.outputFile(path.join(repoRoot, 'skills', 'reviewer', 'SKILL.md'), '# Workflow component\n');
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
  await fs.outputFile(
    path.join(repoRoot, 'custom-plugins', 'custom-plugin', 'skills', 'custom-skill', 'SKILL.md'),
    [
      '---',
      'name: custom-skill',
      'description: Review one custom plugin.',
      '---',
      '# Custom skill',
      '',
    ].join('\n'),
  );
  await fs.outputFile(
    path.join(repoRoot, 'custom-plugins', 'custom-plugin', 'skills', 'custom-skill', 'README.md'),
    '# Custom skill\n',
  );
  await fs.outputJson(path.join(repoRoot, 'custom-plugins', 'custom-plugin', '.agents-plugin', 'plugin.json'), {
    name: 'custom-plugin',
    version: '0.1.0',
    description: 'Custom plugin root fixture.',
    schemaVersion: 3,
    skills: './skills',
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    },
    buildConfig: {
      skillRuntimeFiles: [{
        skill: 'custom-skill',
        target: 'references/provider.txt',
        import: { plugin: 'runtime-provider', export: 'standard' },
      }],
    },
  }, { spaces: 2 });
  await fs.outputJson(
    path.join(repoRoot, 'custom-plugins', 'runtime-provider', '.agents-plugin', 'plugin.json'),
    {
      name: 'runtime-provider',
      version: '0.1.0',
      description: 'Runtime provider fixture.',
      schemaVersion: 3,
      skills: './skills',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
      buildConfig: { runtimeExports: [{
        name: 'standard', source: './standard.txt',
        requires: { aw: { capabilities: [] } },
      }] },
    },
    { spaces: 2 },
  );
  await fs.outputFile(
    path.join(repoRoot, 'custom-plugins', 'runtime-provider', 'skills', 'provider-skill', 'SKILL.md'),
    '---\nname: provider-skill\ndescription: Provide runtime bytes.\n---\n# Provider\n',
  );
  await fs.outputFile(
    path.join(repoRoot, 'custom-plugins', 'runtime-provider', 'skills', 'provider-skill', 'README.md'),
    '# Provider\n',
  );
  await fs.outputFile(
    path.join(repoRoot, 'custom-plugins', 'runtime-provider', 'standard.txt'),
    'provider bytes\n',
  );
  await fs.outputFile(
    path.join(repoRoot, 'plugins', 'unrelated-broken', '.agents-plugin', 'plugin.json'),
    '{ broken default plugin',
  );
  await fs.outputFile(
    path.join(repoRoot, 'custom-plugins', 'unrelated-broken', '.agents-plugin', 'plugin.json'),
    '{ broken sibling plugin',
  );

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
    for (const command of ['digest', 'publish', 'verify', 'list', 'show']) {
      expect(reviewHelp.stdout).toContain(command);
    }

    const digested = await invoke(repoRoot, [
      'review', 'digest', 'skills/reviewer', '--json',
    ]);
    expect(digested.exitCode, digested.stderr).toBe(0);
    expect(digested.stdout.endsWith('\n')).toBe(true);
    const digestPayload = JSON.parse(digested.stdout) as {
      schemaVersion: number;
      command: string;
      ok: boolean;
      path: string;
      digest: string;
    };
    expect(digestPayload).toEqual({
      schemaVersion: 1,
      command: 'review:digest',
      ok: true,
      path: 'skills/reviewer',
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    const digestText = await invoke(repoRoot, ['review', 'digest', 'skills/reviewer']);
    expect(digestText).toEqual({
      exitCode: 0,
      stdout: `${digestPayload.path}: ${digestPayload.digest}\n`,
      stderr: '',
    });
    const scopeDocument = workflowScope('review-flow');
    (scopeDocument.components as Array<Record<string, unknown>>)[0] = {
      kind: 'skill',
      id: 'reviewer',
      path: digestPayload.path,
      digest: digestPayload.digest,
    };
    await fs.writeJson(path.join(repoRoot, 'workflow-scope.json'), scopeDocument);

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

  it('publishes and verifies a custom AW plugin root and rejects unsafe identities', async () => {
    const repoRoot = await createReviewRepository();
    const published = await invoke(repoRoot, [
      'review', 'publish',
      '--kind', 'aw-plugin',
      '--target', 'custom-plugins/custom-plugin',
      '--report', 'report.md',
      '--json',
    ]);
    expect(published.exitCode, published.stderr).toBe(0);
    const payload = JSON.parse(published.stdout) as {
      recordDir: string;
      manifest: { target: { kind: string; id: string; digest: string } };
    };
    expect(payload.manifest.target).toMatchObject({ kind: 'aw-plugin', id: 'custom-plugin' });
    expect(payload.manifest.target.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const verified = await invoke(repoRoot, ['review', 'verify', payload.recordDir, '--json']);
    expect(verified.exitCode, verified.stderr).toBe(0);

    const manifestPath = path.join(
      repoRoot, 'custom-plugins', 'custom-plugin', '.agents-plugin', 'plugin.json',
    );
    const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
    manifest.buildConfig = {
      skillRuntimeFiles: [{
        skill: 'custom-skill',
        target: 'references/provider.txt',
        import: { plugin: 'missing-provider', export: 'standard' },
      }],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    const missingProvider = await invoke(repoRoot, [
      'review', 'publish', '--kind', 'aw-plugin',
      '--target', 'custom-plugins/custom-plugin', '--report', 'report.md',
    ]);
    expect(missingProvider.exitCode).toBe(1);
    expect(missingProvider.stderr).toContain('provider plugin "missing-provider" is unavailable');

    await fs.outputJson(
      path.join(repoRoot, 'custom-plugins', 'broken-provider', '.agents-plugin', 'plugin.json'),
      {
        name: 'broken-provider',
        version: 'broken',
        description: 'Broken required provider.',
        schemaVersion: 3,
        skills: './skills',
      },
    );
    (manifest.buildConfig as { skillRuntimeFiles: Array<{
      import: { plugin: string; export: string };
    }> }).skillRuntimeFiles[0]!.import.plugin = 'broken-provider';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    const brokenProvider = await invoke(repoRoot, [
      'review', 'publish', '--kind', 'aw-plugin',
      '--target', 'custom-plugins/custom-plugin', '--report', 'report.md',
    ]);
    expect(brokenProvider.exitCode).toBe(1);
    expect(brokenProvider.stderr).toContain('strict SemVer');

    manifest.name = 'wrong-plugin';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    const wrongName = await invoke(repoRoot, [
      'review', 'publish', '--kind', 'aw-plugin',
      '--target', 'custom-plugins/custom-plugin', '--report', 'report.md',
    ]);
    expect(wrongName.exitCode).toBe(1);
    expect(wrongName.stderr).toContain('match target id');

    const escaped = await invoke(repoRoot, [
      'review', 'publish', '--kind', 'aw-plugin',
      '--target', path.dirname(repoRoot), '--report', 'report.md',
    ]);
    expect(escaped.exitCode).toBe(1);
    expect(escaped.stderr).toContain('escapes');
  });

  it('rejects a direct provider reached through a symlinked plugins ancestor', async () => {
    const repoRoot = await createReviewRepository();
    const externalPlugins = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-cli-provider-'));
    try {
      await fs.copy(
        path.join(repoRoot, 'custom-plugins', 'runtime-provider'),
        path.join(externalPlugins, 'runtime-provider'),
      );
      await fs.remove(path.join(repoRoot, 'plugins'));
      await fs.symlink(externalPlugins, path.join(repoRoot, 'plugins'));

      const published = await invoke(repoRoot, [
        'review', 'publish', '--kind', 'aw-plugin',
        '--target', 'custom-plugins/custom-plugin', '--report', 'report.md',
      ]);
      expect(published.exitCode).toBe(1);
      expect(published.stdout).toBe('');
      expect(published.stderr).toContain('symlink');
      expect(await fs.pathExists(path.join(repoRoot, 'reports', 'reviews'))).toBe(false);
    } finally {
      await fs.remove(externalPlugins);
    }
  });
});
