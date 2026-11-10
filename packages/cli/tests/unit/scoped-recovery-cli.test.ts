import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/index.js';
import { addRoot, resolveIntentPath } from '../../src/intent/intent-store.js';
import { observePreferences, resolvePreferencesPath } from '../../src/intent/deployment-preferences.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function location(name: string) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = path.join(isolation.layout.fixtureCwd, name);
  await fs.ensureDir(cwd);
  return { cwd, env: isolation.env };
}
async function jsonCommand(args: string[], options: Awaited<ReturnType<typeof location>>) {
  const captured = createCapturedCliIo();
  const exitCode = await runCli([...args, '--json'], { ...options, interactive: false, io: captured.io });
  return { exitCode, value: JSON.parse(captured.readStdout()), stderr: captured.readStderr() };
}
async function fileTree(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  async function walk(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { entries[`${path.relative(root, full)}/`] = ''; await walk(full); }
      else if (entry.isFile()) entries[path.relative(root, full)] = (await fs.readFile(full)).toString('base64');
      else entries[path.relative(root, full)] = await fs.readlink(full);
    }
  }
  if (await fs.pathExists(root)) await walk(root);
  return entries;
}

// Test Value Gate: argv errors must fail before strong configuration or output writes.
describe('plugin work context CLI', () => {
  it.each([
    ['plugin', 'list', '--requested'], ['plugin', 'remove', 'team/demo', '--only', 'requirements'],
    ['plugin', 'remove', '--only', 'outputs', 'team/demo', '--target', 'codex'],
    ['plugin', 'remove', '--only', 'outputs', 'team/demo', '--scope', 'user'],
    ['plugin', 'sync', '--scope', 'user'], ['plugin', 'status', '--scope', 'user'],
    ['target', 'set', 'codex', '--scope', 'user'],
    ['plugin', 'install', 'team/demo', '--target', 'codex'],
    ['plugin', 'install', 'team/demo', '--scope', 'project', '--context', 'user'],
    ['plugin', 'remove', 'team/demo', '--scope', 'project', '--context', 'user'],
    ['target', 'set'], ['target', 'set', 'codex', '--none'],
    ['target', 'set', 'claude-code'], ['target', 'set', 'unknown-platform'],
    ['target', 'exclude', 'team/demo', '--target', 'agent-skills'],
    ['plugin', 'sync', '--check', '--rebuild'], ['plugin', 'sync', '--check', '--refresh'],
    ['install', 'team/demo'], ['reinstall', 'team/demo'], ['uninstall', 'team/demo'],
  ])('rejects invalid or retired arguments without writes: %s', async (...args) => {
    const options = await location('invalid-arguments');
    const before = await fileTree(options.env.AW_HOME!);
    const result = await jsonCommand(args, options);
    expect(result.exitCode).toBe(2);
    expect(result.value).toMatchObject({ schemaVersion: 1, status: 'failed', data: {}, diagnostics: [expect.objectContaining({ severity: 'error' })] });
    expect(await fileTree(options.env.AW_HOME!)).toEqual(before);
    expect(await fs.readdir(options.cwd)).toEqual([]);
  });

  it('saves one canonical policy and clears targets while preserving declarations and outputs', async () => {
    const options = await location('one-policy');
    await git(options.cwd, ['init', '--quiet']);
    await addRoot({ ...options, scope: 'user' }, 'team/demo', 'team-identity');
    await addRoot({ ...options, scope: 'project' }, 'team/demo', 'team-identity');
    const paths = await Promise.all(['user', 'project'].map((scope) => resolveIntentPath({ ...options, scope: scope as 'user' | 'project' })));
    const before = await Promise.all(paths.map((file) => fs.readFile(file)));
    const output = path.join(options.cwd, 'keep.txt');
    await fs.writeFile(output, 'existing output');
    const unavailable = { ...options, env: { ...options.env, PATH: '' } };
    const requested = ['target', 'set', 'cursor', 'codex', 'gemini', 'cursor'];
    const beforeSelection = await fileTree(options.env.AW_HOME!);
    const blocked = await jsonCommand(requested, unavailable);
    expect(blocked.exitCode).toBe(3);
    expect(blocked.value.diagnostics).toContainEqual(expect.objectContaining({ code: 'targetUnavailable' }));
    expect(await fileTree(options.env.AW_HOME!)).toEqual(beforeSelection);
    const set = await jsonCommand([...requested, '--force'], unavailable);
    expect(set.exitCode).toBe(0);
    expect(set.value).toMatchObject({ command: 'target.set', status: 'success', data: {
      preferencesChanged: true, outputsMayHaveChanged: false,
      policy: { schemaVersion: 2, targets: ['codex', 'cursor', 'gemini'], exclusions: [] },
    } });
    expect((await jsonCommand(['target', 'set', '--none'], options)).exitCode).toBe(0);
    expect(await observePreferences({ ...options, scope: 'user' })).toMatchObject({ state: 'valid', value: { targets: [], exclusions: [] } });
    expect(await Promise.all(paths.map((file) => fs.readFile(file)))).toEqual(before);
    expect(await fs.readFile(output, 'utf8')).toBe('existing output');
  });

  it('rejects install with no targets before saving a root', async () => {
    const options = await location('targets-required');
    const result = await jsonCommand(['plugin', 'install', 'team/demo', '--scope', 'user'], options);
    expect(result.exitCode).toBe(3);
    expect(result.value.diagnostics).toContainEqual(expect.objectContaining({ code: 'noTargetsEnabled' }));
    expect(await fs.pathExists(await resolveIntentPath({ ...options, scope: 'user' }))).toBe(false);
  });

  it('validates all removal IDs and changes only the selected declaration', async () => {
    const options = await location('separate-demands');
    await git(options.cwd, ['init', '--quiet']);
    await addRoot({ ...options, scope: 'user' }, 'team/demo', 'team-identity');
    await addRoot({ ...options, scope: 'project' }, 'team/demo', 'team-identity');
    const userPath = await resolveIntentPath({ ...options, scope: 'user' });
    const projectPath = await resolveIntentPath({ ...options, scope: 'project' });
    const user = await fs.readFile(userPath);
    const project = await fs.readFile(projectPath);
    const invalid = await jsonCommand(['plugin', 'remove', '--only', 'requirements', 'team/demo', 'invalid', '--scope', 'project'], options);
    expect(invalid.exitCode).toBe(2);
    expect(await fs.readFile(projectPath)).toEqual(project);
    const removed = await jsonCommand(['plugin', 'remove', '--only', 'requirements', 'team/demo', '--scope', 'project'], options);
    expect(removed.exitCode).toBe(0);
    expect(removed.value).toMatchObject({ command: 'plugin.remove', status: 'success', data: { request: { scope: 'project' }, changes: { requirements: 'changed' }, requirements: { roots: [] } } });
    expect(await fs.readFile(userPath)).toEqual(user);
  });

  it('preserves legacy preferences until the user repairs strong state', async () => {
    const options = await location('legacy-preferences');
    const filename = await resolvePreferencesPath({ ...options, scope: 'user' });
    const original = '{ "schemaVersion": 1, "kind": "aw-project-preferences", "agents": [] }\n';
    await fs.outputFile(filename, original);
    const result = await jsonCommand(['target', 'set', 'codex', '--force'], options);
    expect(result.exitCode).toBe(3);
    expect(result.value.diagnostics).toContainEqual(expect.objectContaining({ code: 'deploymentPreferencesInvalid' }));
    expect(await fs.readFile(filename, 'utf8')).toBe(original);
  });

  it('defaults to the current project while explicit user context remains neutral and read-only', async () => {
    const options = await location('context-selection');
    await git(options.cwd, ['init', '--quiet']);
    const before = await fileTree(options.env.AW_HOME!);
    const project = await jsonCommand(['plugin', 'status'], options);
    expect(project.exitCode).toBe(0);
    expect(project.value.data.coverage).toMatchObject({ scopes: ['user', 'project'], currentProject: true });
    const user = await jsonCommand(['plugin', 'status', '--context', 'user'], options);
    expect(user.exitCode).toBe(0);
    expect(user.value.data.coverage.scopes).toEqual(['user']);
    expect(user.value.data.coverage.projectRoot).toBeUndefined();
    expect(project.value.command).toBe('plugin.status');
    expect(user.value.command).toBe('plugin.status');
    expect(await fileTree(options.env.AW_HOME!)).toEqual(before);
  });

  it('rejects explicit project context outside a project without writes', async () => {
    const options = await location('no-project');
    const before = await fileTree(options.env.AW_HOME!);
    const result = await jsonCommand(['plugin', 'status', '--context', 'project'], options);
    expect(result.exitCode).toBe(3);
    expect(result.value.diagnostics).toContainEqual(expect.objectContaining({ code: 'projectRootUnavailable' }));
    expect(await fileTree(options.env.AW_HOME!)).toEqual(before);
  });
});
