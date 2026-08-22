import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { parsePublishPlanArgs } from '../../../../scripts/release/publish-plan.mjs';
import { parsePrepareArgs } from '../../../../scripts/release/release-prepare.mjs';
import { parseStatusArgs } from '../../../../scripts/release/release-status.mjs';
import { parseTargetArgs } from '../../../../scripts/release/release-target.mjs';

const execute = promisify(execFile);

describe('normal release command arguments', () => {
  it.each([
    ['release:status', parseStatusArgs, ['--cli-version', '1.0.0']],
    ['release:target', parseTargetArgs, ['--catalog-version', '1.0.0']],
    ['release:prepare', parsePrepareArgs, ['stable', '--cli-version', '1.0.0']],
    ['release:publish', parsePublishPlanArgs, ['--catalog-version', '1.0.0']],
  ])('%s rejects legacy version identity input', (_name, parse, args) => {
    expect(() => parse(args)).toThrow();
  });

  it('keeps the supported command surface strict', () => {
    expect(parseStatusArgs(['--json'])).toEqual({ json: true });
    expect(parseTargetArgs(['--cli', 'patch'])).toMatchObject({ cli: 'patch' });
    expect(parsePrepareArgs(['beta'])).toEqual({ channel: 'beta' });
    expect(parsePublishPlanArgs([])).toEqual({});
  });

  it.each([
    'publish-cli.mjs',
    'publish-catalog.mjs',
    'bootstrap-catalog.mjs',
    'promote-catalog.mjs',
    'publish-release.mjs',
  ])('rejects direct execution of %s before creating output', async (script) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-retired-release-entry-'));
    try {
      const scriptPath = fileURLToPath(new URL(`../../../../scripts/release/${script}`, import.meta.url));
      const result = await execute(process.execPath, [scriptPath], { cwd })
        .then(() => null, (error: { code?: number; stderr?: string }) => error);
      expect(result?.code).not.toBe(0);
      expect(result?.stderr).toContain('pnpm release:publish');
      expect(result?.stderr).toContain('pnpm release:recover');
      await expect(fs.readdir(cwd)).resolves.toEqual([]);
    } finally {
      await fs.remove(cwd);
    }
  });
});
