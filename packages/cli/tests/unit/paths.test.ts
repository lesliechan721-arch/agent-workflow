import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveClaudeProjectKey,
  resolveCodexPaths,
  resolveCodexProjectKey,
} from '../../src/utils/paths.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('project key paths', () => {
  it('normalizes symlink and realpath aliases to the same Claude/Codex project key', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-paths-'));
    tempDirs.push(root);

    const realRepo = path.join(root, 'real-repo');
    const aliasRepo = path.join(root, 'alias-repo');
    await fs.ensureDir(path.join(realRepo, '.git'));
    await fs.ensureDir(path.join(realRepo, 'subdir'));
    await fs.symlink(realRepo, aliasRepo);

    const [claudeReal, claudeAlias, codexReal, codexAlias] = await Promise.all([
      resolveClaudeProjectKey(realRepo),
      resolveClaudeProjectKey(aliasRepo),
      resolveCodexProjectKey(path.join(realRepo, 'subdir')),
      resolveCodexProjectKey(path.join(aliasRepo, 'subdir')),
    ]);

    expect(claudeAlias).toBe(claudeReal);
    expect(codexAlias).toBe(codexReal);
  });

  it('anchors Codex project paths at the repo root when invoked from a subdirectory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-paths-'));
    tempDirs.push(root);

    const repoRoot = path.join(root, 'repo');
    const nestedDir = path.join(repoRoot, 'packages', 'feature');
    await fs.ensureDir(path.join(repoRoot, '.git'));
    await fs.ensureDir(nestedDir);

    const paths = resolveCodexPaths(nestedDir, 'project');

    expect(paths.configDir).toBe(path.join(repoRoot, '.codex'));
    expect(paths.trackingDir).toBe(path.join(repoRoot, '.codex'));
    expect(paths.hooksPath).toBe(path.join(repoRoot, '.codex', 'hooks.json'));
  });
});
