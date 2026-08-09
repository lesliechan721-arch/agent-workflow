import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';
import { writeNodeScriptFixture } from '../support/plugin-scripts-node-fixture.js';
import {
  activateSmokeBuildSnapshot,
  cleanupSmokeBuildSnapshot,
  createSmokeBuildSnapshot,
  type SmokeBuildSnapshot,
} from '../support/smoke-build-snapshot.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
let buildSnapshot: SmokeBuildSnapshot | null = null;

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

function registerSmokeWritableRoot(rootPath: string, source: string): string {
  return registerCurrentTestWritableStateRoot(rootPath, source);
}

function stripCorepackBootstrapNoise(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => (
      line.trim() !== '' &&
      !line.startsWith('! Corepack is about to download ') &&
      line !== "$ pnpm --filter @yiliang/aw plugin:test -- git-commit --test-name 'staged smoke generated test'" &&
      line !== "$ tsc -p tsconfig.json && node dist/scripts/test-plugin-scripts.js -- git-commit --test-name 'staged smoke generated test'"
    ))
    .join('\n');
}

async function makeTempRepo(): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-scripts-smoke-'));
  tempDirs.push(tempRoot);
  registerSmokeWritableRoot(tempRoot, 'plugin scripts smoke temp root');
  const tempRepo = path.join(tempRoot, 'repo');
  registerSmokeWritableRoot(tempRepo, 'plugin scripts smoke repo root');
  await fs.copy(fixturePath('repo-template'), tempRepo);
  return tempRepo;
}

async function requireBuildSnapshot(): Promise<SmokeBuildSnapshot> {
  if (!buildSnapshot) {
    throw new Error('Plugin scripts smoke snapshot is not initialized.');
  }
  return activateSmokeBuildSnapshot(buildSnapshot);
}

beforeAll(async () => {
  buildSnapshot = await createSmokeBuildSnapshot(repoRoot());
});

afterAll(async () => {
  await cleanupSmokeBuildSnapshot(buildSnapshot);
  buildSnapshot = null;
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin scripts staging smoke', () => {
  it('runs real scripts.node staging through the snapshot compiled entry', async () => {
    const root = repoRoot();
    const snapshot = await requireBuildSnapshot();
    const tempRepo = await makeTempRepo();
    await writeNodeScriptFixture(tempRepo);

    const result = await execFileAsync(
      process.execPath,
      [
        path.join(snapshot.cliDistRoot, 'scripts', 'test-plugin-scripts.js'),
        'git-commit',
        '--test-name',
        'staged smoke generated test',
      ],
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
    expect(stripCorepackBootstrapNoise(result.stderr)).toBe('');

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
