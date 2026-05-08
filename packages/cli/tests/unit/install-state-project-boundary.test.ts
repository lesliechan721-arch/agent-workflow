import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertProjectArtifactIdentityPathVisible,
  assertProjectSharedConfigPathVisible,
  classifyProjectBoundaryPath,
  ensureProjectPrivateStateIgnore,
} from '../../src/install-state/project-boundary.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

async function initRepo(root: string): Promise<string> {
  const repoRoot = path.join(root, 'repo');
  await fs.ensureDir(repoRoot);
  await execFileAsync('git', ['init', '-q'], { cwd: repoRoot });
  return repoRoot;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('install-state project boundary helpers', () => {
  it('ensures private local config is ignored and classifies receipt surfaces', async () => {
    const root = await makeTempRoot('aw-project-boundary-');
    const repoRoot = await initRepo(root);
    const cwd = path.join(repoRoot, 'packages', 'app');
    await fs.ensureDir(cwd);
    const localConfigPath = path.join(
      repoRoot,
      '.agent-workflows',
      'plugin-config.local',
      'demo',
      'config.json',
    );

    const first = await ensureProjectPrivateStateIgnore({
      cwd,
      targetPath: localConfigPath,
    });
    expect(first.status).toBe('added');
    await expect(fs.readFile(path.join(repoRoot, '.gitignore'), 'utf8')).resolves.toContain(
      '.agent-workflows/plugin-config.local/',
    );

    const second = await ensureProjectPrivateStateIgnore({
      cwd,
      targetPath: localConfigPath,
    });
    expect(second.status).toBe('alreadyIgnored');

    expect(classifyProjectBoundaryPath({
      repoRoot,
      path: path.join(repoRoot, '.gitignore'),
    }).category).toBe('ignoredState');
    expect(classifyProjectBoundaryPath({
      repoRoot,
      path: localConfigPath,
    }).category).toBe('projectLocalConfig');
    expect(classifyProjectBoundaryPath({
      repoRoot,
      path: localConfigPath,
    }).category).not.toBe('repoVisibleArtifacts');
    expect(classifyProjectBoundaryPath({
      repoRoot,
      path: path.join(repoRoot, '.agent-workflows', 'plugin-config', 'demo', 'config.json'),
    }).category).toBe('projectSharedConfig');
    expect(classifyProjectBoundaryPath({
      repoRoot,
      path: path.join(repoRoot, '.agent-workflows', 'project-artifacts', 'codex', 'demo.json'),
    }).category).toBe('repoVisibleArtifacts');
    expect(classifyProjectBoundaryPath({
      repoRoot,
      path: path.join(repoRoot, '.codex', '.agent-workflows', 'records', 'demo.json'),
    }).category).toBe('privateState');
    expect(classifyProjectBoundaryPath({
      repoRoot,
      path: path.join(repoRoot, '.codex', '.agent-workflows', 'records', 'demo.json'),
    }).category).not.toBe('repoVisibleArtifacts');
  });

  it('ensures all project private state patterns without hiding shared project surfaces', async () => {
    const root = await makeTempRoot('aw-project-boundary-');
    const repoRoot = await initRepo(root);
    const cwd = path.join(repoRoot, 'packages', 'app');
    await fs.ensureDir(cwd);

    const privatePaths = [
      path.join(repoRoot, '.claude', '.agent-workflows', 'records', 'demo.json'),
      path.join(repoRoot, '.codex', '.agent-workflows', 'records', 'demo.json'),
      path.join(repoRoot, '.agent-workflows', 'plugin-config.local', 'demo', 'config.json'),
    ];
    for (const targetPath of privatePaths) {
      await expect(ensureProjectPrivateStateIgnore({
        cwd,
        targetPath,
      })).resolves.toMatchObject({
        status: 'added',
      });
    }

    const gitignore = await fs.readFile(path.join(repoRoot, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.claude/.agent-workflows/');
    expect(gitignore).toContain('.codex/.agent-workflows/');
    expect(gitignore).toContain('.agent-workflows/plugin-config.local/');
    expect(gitignore).not.toContain('.agent-workflows/plugin-config/');
    expect(gitignore).not.toContain('.agent-workflows/project-artifacts/');
    expect(gitignore).not.toContain('.codex/config.toml');

    await expect(assertProjectSharedConfigPathVisible({
      cwd,
      pluginName: 'demo',
    })).resolves.toBeUndefined();
    await expect(assertProjectArtifactIdentityPathVisible({
      cwd,
      pluginName: 'demo',
      platform: 'codex',
    })).resolves.toBeUndefined();
  });

  it('returns a structured warning when .gitignore cannot be safely updated', async () => {
    const root = await makeTempRoot('aw-project-boundary-');
    const repoRoot = await initRepo(root);
    const cwd = repoRoot;
    await fs.ensureDir(path.join(repoRoot, '.gitignore'));
    const localConfigPath = path.join(
      repoRoot,
      '.agent-workflows',
      'plugin-config.local',
      'demo',
      'config.json',
    );

    const result = await ensureProjectPrivateStateIgnore({
      cwd,
      targetPath: localConfigPath,
    });

    expect(result.status).toBe('warning');
    expect(result.warning).toMatchObject({
      code: 'projectPrivateStateIgnoreNotEnsured',
      targetRelativePath: '.agent-workflows/plugin-config.local/demo/config.json',
      suggestedPatterns: ['.agent-workflows/plugin-config.local/'],
    });
  });

  it('fails shared config and shared identity writes when repo-visible paths are ignored', async () => {
    const root = await makeTempRoot('aw-project-boundary-');
    const repoRoot = await initRepo(root);
    const cwd = path.join(repoRoot, 'packages', 'app');
    await fs.ensureDir(cwd);
    await fs.writeFile(path.join(repoRoot, '.gitignore'), '.agent-workflows/\n', 'utf8');

    await expect(assertProjectSharedConfigPathVisible({
      cwd,
      pluginName: 'demo',
    })).rejects.toMatchObject({
      code: 'projectSharedConfigIgnored',
      matchedPattern: '.agent-workflows/',
      targetRelativePath: '.agent-workflows/plugin-config/demo/config.json',
    });

    await expect(assertProjectArtifactIdentityPathVisible({
      cwd,
      pluginName: 'demo',
      platform: 'codex',
    })).rejects.toMatchObject({
      code: 'projectArtifactIdentityIgnored',
      matchedPattern: '.agent-workflows/',
    });
  });
});
