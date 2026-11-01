import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveWindowsNpmCommand } from '../../src/utils/windows-npm-shim.js';
import { writeSkillsCliFixture } from '../helpers/skills-cli-fixture.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function createSkillsFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-windows-skills-'));
  roots.push(root);
  const binRoot = path.join(root, 'npm prefix & literal');
  const fixture = await writeSkillsCliFixture(
    binRoot,
    'console.log(JSON.stringify(process.argv.slice(2)));\n',
    process.env,
  );
  return {
    ...fixture,
    binRoot,
    resolve: () => resolveWindowsNpmCommand({
      command: 'skills', packageName: 'skills', binName: 'skills', cwd: root,
      env: { Path: `"${binRoot}"`, PathExt: '.CMD' },
    }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('Windows npm launcher', () => {
  it('runs the Skills mjs entry with literal argv from a quoted PATH containing spaces', async () => {
    const fixture = await createSkillsFixture();
    const invocation = await fixture.resolve();
    expect(invocation).toEqual({
      command: process.execPath, argsPrefix: [await fs.realpath(fixture.launcher)],
    });
    const args = ['add', 'C:\\materialized root\\a&b', '--skill', 'a"b', '%PATH%', 'x|y'];
    const result = await execFileAsync(invocation.command, [...invocation.argsPrefix, ...args], {
      env: fixture.env,
    });
    expect(JSON.parse(result.stdout)).toEqual(args);
    expect(result.stderr).toBe('');
  });

  it.each(['modified shim', 'foreign package', 'escaping entry'])(
    'rejects a %s before invoking the package',
    async (mode) => {
      const fixture = await createSkillsFixture();
      if (mode === 'modified shim') await fs.appendFile(fixture.shim, '@calc.exe\r\n');
      else await fs.writeJson(path.join(fixture.binRoot, 'node_modules', 'skills', 'package.json'), {
        name: mode === 'foreign package' ? 'foreign-skills' : 'skills',
        bin: { skills: mode === 'escaping entry' ? '../outside.mjs' : './bin/cli.mjs' },
      });
      await expect(fixture.resolve()).rejects.toThrow('Windows skills launcher is unsupported');
    },
  );
});
