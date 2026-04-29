import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { writeNodeScriptFixture } from '../support/plugin-scripts-node-fixture.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeTempRepo(): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-scripts-smoke-'));
  tempDirs.push(tempRoot);
  const tempRepo = path.join(tempRoot, 'repo');
  await fs.copy(fixturePath('repo-template'), tempRepo);
  return tempRepo;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin scripts staging smoke', () => {
  it('runs real scripts.node staging through the package plugin:test entry', async () => {
    const root = repoRoot();
    const tempRepo = await makeTempRepo();
    await writeNodeScriptFixture(tempRepo);

    const result = await execFileAsync(
      'pnpm',
      ['plugin:test', 'git-commit', '--platform', 'auto', '--test-name', 'staged smoke generated test'],
      {
        cwd: root,
        env: {
          ...process.env,
          AW_PLUGIN_TEST_REPO_ROOT: tempRepo,
          NO_COLOR: '1',
        },
        maxBuffer: 30 * 1024 * 1024,
        timeout: 120_000,
      },
    );

    expect(result.stdout).toContain('git-commit / codex: passed');
    expect(result.stdout).not.toContain('git-commit / claude');
    expect(result.stderr).toBe('');

    await expect(
      fs.pathExists(path.join(tempRepo, 'plugins', 'git-commit', 'scripts', 'generated.test.mjs')),
    ).resolves.toBe(false);
    await expect(
      fs.readJson(path.join(tempRepo, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      description: expect.not.stringContaining('Built smoke description'),
      marketplace: {
        policy: {
          products: ['CLAUDE'],
        },
      },
      scripts: {
        tests: {
          node: ['./scripts/source-only.test.mjs'],
        },
      },
    });
  }, 120_000);
});
