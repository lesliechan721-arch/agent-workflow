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
    ['plugin', 'intent', 'list'], ['plugin', 'intent', 'remove', 'team/demo'],
    ['plugin', 'cleanup', 'team/demo', '--target', 'codex'],
    ['plugin', 'cleanup', 'team/demo', '--scope', 'user'],
    ['plugin', 'sync', '--scope', 'user'], ['plugin', 'status', '--scope', 'user'],
    ['plugin', 'targets', 'set', 'codex', '--scope', 'user'],
    ['plugin', 'install', 'team/demo', '--target', 'codex'],
    ['plugin', 'install', 'team/demo', '--scope', 'project', '--context', 'user'],
    ['plugin', 'remove', 'team/demo', '--scope', 'project', '--context', 'user'],
    ['plugin', 'targets', 'set'], ['plugin', 'targets', 'set', 'codex', '--none'],
    ['plugin', 'targets', 'set', 'claude-code'], ['plugin', 'targets', 'set', 'gemini'],
    ['plugin', 'targets', 'exclude', 'team/demo', '--target', 'agent-skills'],
    ['plugin', 'sync', '--check', '--rebuild'], ['plugin', 'sync', '--check', '--refresh'],
    ['install', 'team/demo'], ['reinstall', 'team/demo'], ['uninstall', 'team/demo'],
  ])('rejects invalid or retired arguments without writes: %s', async (...args) => {
    const options = await location('invalid-arguments');
    const before = await fileTree(options.env.AW_HOME!);
    const result = await jsonCommand(args, options);
    expect(result.exitCode).toBe(2);
    expect(result.value).toMatchObject({ ok: false, errors: [{ code: 'invalidArguments' }] });
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
    const set = await jsonCommand(['plugin', 'targets', 'set', 'cursor', 'codex', 'cursor'], options);
    expect(set.exitCode).toBe(0);
    expect(set.value).toMatchObject({ preferencesChanged: true, declarationChanged: false, outputsMayHaveChanged: false,
      policy: { schemaVersion: 2, targets: ['codex', 'cursor'], exclusions: [] } });
    expect((await jsonCommand(['plugin', 'targets', 'set', '--none'], options)).exitCode).toBe(0);
    expect(await observePreferences({ ...options, scope: 'user' })).toMatchObject({ state: 'valid', value: { targets: [], exclusions: [] } });
    expect(await Promise.all(paths.map((file) => fs.readFile(file)))).toEqual(before);
    expect(await fs.readFile(output, 'utf8')).toBe('existing output');
  });

  it('rejects install with no targets before saving a root', async () => {
    const options = await location('targets-required');
    const result = await jsonCommand(['plugin', 'install', 'team/demo'], options);
    expect(result.exitCode).toBe(1);
    expect(result.value.errors).toContainEqual(expect.objectContaining({ code: 'targetsNotConfigured' }));
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
    const invalid = await jsonCommand(['plugin', 'intent', 'remove', 'team/demo', 'invalid', '--scope', 'project'], options);
    expect(invalid.exitCode).toBe(2);
    expect(await fs.readFile(projectPath)).toEqual(project);
    const removed = await jsonCommand(['plugin', 'intent', 'remove', 'team/demo', '--scope', 'project'], options);
    expect(removed.exitCode).toBe(0);
    expect(removed.value).toMatchObject({ scope: 'project', declarationChanged: true, intent: { roots: [] } });
    expect(await fs.readFile(userPath)).toEqual(user);
  });

  it('preserves legacy preferences until the user repairs strong state', async () => {
    const options = await location('legacy-preferences');
    const filename = await resolvePreferencesPath({ ...options, scope: 'user' });
    const original = '{ "schemaVersion": 1, "kind": "aw-project-preferences", "agents": [] }\n';
    await fs.outputFile(filename, original);
    expect((await jsonCommand(['plugin', 'targets', 'set', 'codex'], options)).exitCode).toBe(1);
    expect(await fs.readFile(filename, 'utf8')).toBe(original);
  });

  it('defaults to the current project while explicit user context remains neutral and read-only', async () => {
    const options = await location('context-selection');
    await git(options.cwd, ['init', '--quiet']);
    const before = await fileTree(options.env.AW_HOME!);
    const project = await jsonCommand(['plugin', 'status'], options);
    expect(project.exitCode).toBe(0);
    expect(project.value.coverage).toMatchObject({ scopes: ['user', 'project'], projectRoot: options.cwd });
    const user = await jsonCommand(['plugin', 'status', '--context', 'user'], options);
    expect(user.exitCode).toBe(0);
    expect(user.value.coverage.scopes).toEqual(['user']);
    expect(user.value.coverage.projectRoot).toBeUndefined();
    const check = await jsonCommand(['plugin', 'sync', '--check', '--context', 'user'], options);
    expect(check.exitCode).toBe(0);
    expect(check.value).toMatchObject({ declarationChanged: false, preferencesChanged: false,
      configChanged: false, outputsMayHaveChanged: false });
    expect(await fileTree(options.env.AW_HOME!)).toEqual(before);
  });

  it('rejects explicit project context outside a project without writes', async () => {
    const options = await location('no-project');
    const before = await fileTree(options.env.AW_HOME!);
    const result = await jsonCommand(['plugin', 'status', '--context', 'project'], options);
    expect(result.exitCode).toBe(1);
    expect(result.value.errors).toContainEqual(expect.objectContaining({ code: 'projectRootUnavailable' }));
    expect(await fileTree(options.env.AW_HOME!)).toEqual(before);
  });
});
