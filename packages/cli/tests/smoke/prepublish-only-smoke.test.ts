import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

describe('public package publish guard', () => {
  it.each([
    'packages/agent-skill-eval',
    'packages/cli',
  ])('rejects the direct prepublishOnly entry for %s without publishing', async (packagePath) => {
    await expect(execFileAsync('npm', ['run', 'prepublishOnly', '--silent'], {
      cwd: path.join(repoRoot(), packagePath),
      env: process.env,
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('Direct package publication is disabled. Use pnpm release.'),
    });
  });
});
