import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

describe('build smoke', () => {
  it('runs pnpm build and produces plugins-dist through the compiled bundle script', async () => {
    const root = repoRoot();
    const outputRoot = path.join(root, 'packages', 'cli', 'plugins-dist');
    await fs.remove(outputRoot);

    await execFileAsync('pnpm', ['build'], {
      cwd: root,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });

    await expect(
      fs.pathExists(path.join(outputRoot, '.claude-plugin', 'marketplace.json')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'git-commit', '.codex-plugin', 'plugin.json')),
    ).resolves.toBe(true);

    const { validateBundleLayout } = (await import(
      '../../src/utils/bundle-layout.js'
    )) as { validateBundleLayout: (rootDir: string) => Promise<void> };
    await expect(validateBundleLayout(outputRoot)).resolves.toBeUndefined();
  });
});
