import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.remove(root))); });

function capture() {
  let stdout = '';
  let stderr = '';
  return { io: { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } },
    stdout: () => stdout, stderr: () => stderr };
}

describe('public plugin and Skill scaffolds', () => {
  // Test Value Gate: real CLI children must produce current, valid author source
  // while removed options and duplicate static names leave source unchanged.
  it('creates, validates and extends Manifest v4 without changing default profiles', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-scaffold-'));
    roots.push(root);
    const execute = async (args: string[]) => {
      const output = capture();
      const exitCode = await runCli(args, { cwd: root, io: output.io });
      return { exitCode, stdout: output.stdout(), stderr: output.stderr() };
    };
    expect((await execute(['dev', 'catalog', 'create', '--workspace-root', root])).exitCode).toBe(0);
    const marketplacePath = path.join(root, 'plugins', 'marketplace-source.json');
    const marketplaceBefore = await fs.readFile(marketplacePath, 'utf8');
    const help = await execute(['dev', 'plugin', 'create', '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).not.toContain('--with-apps');
    for (const option of ['--with-apps', '--with-apps=true']) {
      const rejected = await execute(['dev', 'plugin', 'create', 'removed-apps', '--description',
        'Removed Apps entry.', '--no-skills', option, '--workspace-root', root]);
      expect(rejected.exitCode).toBe(2);
      expect(rejected.stderr).toMatch(/unknown option.*--with-apps/iu);
      expect(await fs.pathExists(path.join(root, 'plugins', 'removed-apps'))).toBe(false);
    }
    const created = await execute(['dev', 'plugin', 'create', 'source-scaffold', '--description',
      'A source scaffold with current author contracts.', '--skill-description',
      'Inspect repository input and report actionable results.', '--with-mcp', '--with-config-api',
      '--with-pre-apply', '--workspace-root', root]);
    expect(created.exitCode, `${created.stdout}\n${created.stderr}`).toBe(0);
    const pluginRoot = path.join(root, 'plugins', 'source-scaffold');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    expect(manifest).toMatchObject({ schemaVersion: 4, platforms: ['codex', 'claude'],
      version: '0.1.0', skills: './skills', mcpServers: './.mcp.json', config: { schemaVersion: 5 } });
    expect(manifest).not.toHaveProperty('apps');
    expect(await fs.pathExists(path.join(pluginRoot, '.app.json'))).toBe(false);
    const originalSkill = path.join(pluginRoot, 'skills', 'source-scaffold');
    expect(await fs.readJson(path.join(originalSkill, 'evals', 'manifest.json'))).toMatchObject({
      defaults: { profile: 'project-default' }, profiles: {
        'project-default': { platform: 'codex', scope: 'project' },
        'user-default': { platform: 'codex', scope: 'user' },
      },
    });
    const completeSkill = async (skill: string) => {
      const skillPath = path.join(skill, 'SKILL.md');
      const content = await fs.readFile(skillPath, 'utf8');
      await fs.writeFile(skillPath, content.replace(/\[TODO:[^\]]+\]/gu, 'Inspect the input and report the result.'));
    };
    await completeSkill(originalSkill);
    const validate = async () => {
      const result = await execute(['dev', 'plugin', 'validate', pluginRoot, '--workspace-root', root, '--json']);
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'success', data: { profile: 'aw-source' } });
    };
    await validate();
    const readmeBefore = await fs.readFile(path.join(pluginRoot, 'README.md'), 'utf8');
    const addArgs = ['dev', 'skill', 'create', '--plugin', 'source-scaffold', '--skill-name', 'second-skill',
      '--skill-description', 'Inspect another repository task and report clear results.', '--skill-invocation',
      'manual', '--workspace-root', root];
    const added = await execute(addArgs);
    expect(added.exitCode, `${added.stdout}\n${added.stderr}`).toBe(0);
    const addedSkill = path.join(pluginRoot, 'skills', 'second-skill');
    expect(await fs.readFile(path.join(addedSkill, 'SKILL.md'), 'utf8')).toContain('disable-model-invocation: true');
    expect(await fs.readFile(path.join(addedSkill, 'agents', 'openai.yaml'), 'utf8'))
      .toContain('allow_implicit_invocation: false');
    expect(await fs.pathExists(path.join(addedSkill, 'README.md'))).toBe(true);
    expect(await fs.pathExists(path.join(addedSkill, 'evals', 'manifest.json'))).toBe(true);
    await completeSkill(addedSkill);
    await validate();
    const beforeDuplicate = await fs.readFile(manifestPath, 'utf8');
    const duplicate = await execute(addArgs);
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stderr).toContain('Skill already exists');
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(beforeDuplicate);
    expect(await fs.readFile(path.join(pluginRoot, 'README.md'), 'utf8')).toBe(readmeBefore);
    expect(await fs.readFile(marketplacePath, 'utf8')).toBe(marketplaceBefore);
    await execFileAsync(process.execPath,
      ['--test', path.join(pluginRoot, 'scripts', 'generated-script.test.mjs')], { cwd: root, env: process.env });
  }, 30_000);
});
