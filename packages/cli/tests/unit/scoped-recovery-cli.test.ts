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
      if (entry.isDirectory()) {
        entries[`${path.relative(root, full)}/`] = '';
        await walk(full);
      } else if (entry.isFile()) entries[path.relative(root, full)] = (await fs.readFile(full)).toString('base64');
      else entries[path.relative(root, full)] = await fs.readlink(full);
    }
  }
  if (await fs.pathExists(root)) await walk(root);
  return entries;
}

describe('explicit scoped recovery CLI', () => {
  it.each([
    ['intent', 'list'], ['targets', 'list'], ['targets', 'set', 'codex'],
    ['status'], ['sync', '--all'], ['install', 'team/demo'],
    ['reinstall', 'team/demo'], ['uninstall', 'team/demo'], ['cleanup', 'team/demo'],
  ])('rejects missing scope for %s without choosing a write location', async (...args) => {
    const options = await location('scope-required');
    const before = await fileTree(options.env.AW_HOME!);
    const result = await jsonCommand(args, options);
    expect(result.exitCode).toBe(2);
    expect(result.value).toMatchObject({ ok: false, scope: null,
      errors: [{ code: 'invalidArguments' }] });
    expect(await fileTree(options.env.AW_HOME!)).toEqual(before);
  });

  it.each([
    ['project', 'status'],
    ['install', 'team/demo', '--scope', 'user', '-p', 'codex'],
    ['sync', '--all', '--scope', 'user', '--platform', 'both'],
  ])('rejects retired commands and gives replacement guidance', async (...args) => {
    const result = await jsonCommand(args, await location('removed-entry'));
    expect(result.exitCode).toBe(2);
    expect(result.value.errors[0]).toMatchObject({ code: 'invalidArguments',
      message: expect.stringContaining('aw intent') });
  });

  it('saves user targets outside a repository without creating project files', async () => {
    const options = await location('plain-directory');
    const result = await jsonCommand(['targets', 'set', 'cursor', 'codex', 'cursor', '--scope', 'user'], options);
    expect(result.exitCode).toBe(0);
    expect(result.value).toMatchObject({ kind: 'aw-recovery', scope: 'user', preferencesChanged: true,
      declarationChanged: false, configChanged: false, outputsMayHaveChanged: false,
      selection: { agents: ['codex', 'cursor'] } });
    expect(await observePreferences({ ...options, scope: 'user' })).toMatchObject({ state: 'valid',
      value: { kind: 'aw-deployment-preferences', agents: ['codex', 'cursor'] } });
    expect(await fs.readdir(options.cwd)).toEqual([]);
  });

  it('removes only the explicit scope declaration even when called inside a project', async () => {
    const options = await location('separate-demands');
    await git(options.cwd, ['init', '--quiet']);
    await addRoot({ ...options, scope: 'user' }, 'team/demo', 'team-identity');
    await addRoot({ ...options, scope: 'project' }, 'team/demo', 'team-identity');
    const userPath = await resolveIntentPath({ ...options, scope: 'user' });
    const original = await fs.readFile(userPath);
    const result = await jsonCommand(['intent', 'remove', 'team/demo', '--scope', 'project'], options);
    expect(result.exitCode).toBe(0);
    expect(result.value).toMatchObject({ scope: 'project', declarationChanged: true,
      intent: { roots: [] }, outputsMayHaveChanged: false });
    expect(await fs.readFile(userPath)).toEqual(original);
  });

  it('preserves legacy preference bytes until an explicit reset of that scope', async () => {
    const options = await location('legacy-preferences');
    const preferencesPath = await resolvePreferencesPath({ ...options, scope: 'user' });
    const original = '{ "schemaVersion": 1, "kind": "aw-project-preferences", "agents": [] }\n';
    await fs.outputFile(preferencesPath, original);
    const rejected = await jsonCommand(['targets', 'set', 'codex', '--scope', 'user'], options);
    expect(rejected.exitCode).toBe(1);
    expect(await fs.readFile(preferencesPath, 'utf8')).toBe(original);
    const reset = await jsonCommand(['targets', 'reset', '--scope', 'user'], options);
    expect(reset.exitCode).toBe(0);
    expect(await observePreferences({ ...options, scope: 'user' })).toMatchObject({ state: 'valid',
      value: { agents: [], dependencyScopeOverrides: [] } });
  });

  it('reports the exact legacy user file and leaves it unchanged', async () => {
    const options = await location('legacy-user-intent');
    const filename = await resolveIntentPath({ ...options, scope: 'user' });
    const original = '{ "schemaVersion": 2, "kind": "aw-plugin-intents", "roots": [] }\n';
    await fs.outputFile(filename, original);
    const result = await jsonCommand(['intent', 'list', '--scope', 'user'], options);
    expect(result.exitCode).toBe(1);
    expect(result.value.intent).toMatchObject({ state: 'unsupported-version', roots: null });
    expect(JSON.stringify(result.value)).toContain(filename);
    expect(JSON.stringify(result.value)).toContain('备份');
    expect(await fs.readFile(filename, 'utf8')).toBe(original);
  });

  it('deduplicates repeated one-time targets without saving preferences', async () => {
    const options = await location('repeated-targets');
    const result = await jsonCommand(['sync', '--all', '--check', '--scope', 'user',
      '--target', 'cursor', '--target', 'codex', '--target', 'cursor'], options);
    expect(result.exitCode).toBe(0);
    expect(result.value.selection).toMatchObject({ agents: ['codex', 'cursor'], origin: 'argument' });
    expect(await observePreferences({ ...options, scope: 'user' })).toEqual({ state: 'absent' });
  });

  it('keeps empty status and check read-only, including persistent runtime and lock paths', async () => {
    const options = await location('readonly-empty');
    const before = await fileTree(options.env.AW_HOME!);
    const status = await jsonCommand(['status', '--scope', 'user'], options);
    expect(status.exitCode).toBe(0);
    expect(status.value).toMatchObject({ kind: 'aw-recovery-status', scope: 'user', allSatisfied: true });
    const check = await jsonCommand(['sync', '--all', '--check', '--scope', 'user'], options);
    expect(check.exitCode).toBe(0);
    expect(check.value).toMatchObject({ kind: 'aw-recovery', scope: 'user', ok: true,
      declarationChanged: false, preferencesChanged: false, configChanged: false, outputsMayHaveChanged: false });
    expect(await fileTree(options.env.AW_HOME!)).toEqual(before);
    expect(await fs.readdir(options.cwd)).toEqual([]);
  });

  it('reports a native inventory read error with no declared roots', async () => {
    const options = await location('unreadable-empty-inventory');
    await fs.outputFile(path.join(options.env.AW_HOME!, 'plugin-config'), 'not a directory');
    const status = await jsonCommand(['status', '--scope', 'user'], options);
    expect(status.exitCode).toBe(1);
    expect(status.value).toMatchObject({ kind: 'aw-recovery-status', ok: false,
      inventory: [], allSatisfied: true, errors: [expect.objectContaining({ code: 'stateInventoryFailed' })] });
    expect(JSON.stringify(status.value)).not.toContain('not a directory');
    const check = await jsonCommand(['sync', '--all', '--check', '--scope', 'user'], options);
    expect(check.exitCode).toBe(1);
    expect(check.value).toMatchObject({ kind: 'aw-recovery', ok: false,
      errors: [expect.objectContaining({ code: 'stateInventoryFailed' })] });
  });

  it('rejects invalid check combinations before any preparation', async () => {
    const options = await location('invalid-check');
    const before = await fileTree(options.env.AW_HOME!);
    for (const args of [
      ['sync', '--all', '--check', '--refresh', '--scope', 'user'],
      ['sync', 'team/demo', '--all', '--scope', 'user'],
      ['sync', '--scope', 'user'],
      ['targets', 'set', 'both', '--scope', 'user'],
    ]) {
      const result = await jsonCommand(args, options);
      expect(result.exitCode).toBe(2);
      expect(result.value.errors[0].code).toBe('invalidArguments');
    }
    expect(await fileTree(options.env.AW_HOME!)).toEqual(before);
  });
});
