import crypto from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';

import fs from 'fs-extra';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { ScopeContext, ScopeContextOptions } from '../../src/intent/scope-context.js';

type Entry = { path: string; directory: boolean; ino: number; contents?: string };

function windowsFixture(marker = '.codex', environment: NodeJS.ProcessEnv = {}) {
  const paths = path.win32;
  const profile = 'D:\\Users\\test-user';
  const userTemp = paths.join(profile, 'AppData', 'Local', 'Temp');
  const systemRoot = 'W:\\Windows';
  const systemTemp = paths.join(systemRoot, 'temp');
  const env = { UserProfile: profile, TEMP: userTemp, TMP: userTemp, SystemRoot: systemRoot, ...environment };
  const entries = new Map<string, Entry>();
  const writes: string[] = [];
  const removals: string[] = [];
  let sequence = 0;
  let denied = false;
  const key = (value: string): string => paths.resolve(value).toLowerCase();
  const missing = (): never => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  function directory(value: string): void {
    const resolved = paths.resolve(value);
    if (entries.has(key(resolved))) return;
    const parent = paths.dirname(resolved);
    if (parent !== resolved) directory(parent);
    entries.set(key(resolved), { path: resolved, directory: true, ino: ++sequence });
  }
  function file(value: string, contents = 'foreign'): void {
    directory(paths.dirname(value));
    entries.set(key(value), { path: value, directory: false, ino: ++sequence, contents });
  }
  function stat(value: string) {
    const entry = entries.get(key(value)) ?? missing();
    return { dev: 1, ino: entry.ino, isDirectory: () => entry.directory,
      isSymbolicLink: () => false, isFile: () => !entry.directory };
  }
  const memoryFs = {
    realpathSync: (value: string) => (entries.get(key(value)) ?? missing()).path,
    realpath: async (value: string) => (entries.get(key(value)) ?? missing()).path,
    lstat: async (value: string) => stat(value),
    mkdir: async (value: string) => { directory(value); writes.push(value); },
    mkdtemp: async (prefix: string) => {
      const parent = entries.get(key(paths.dirname(prefix))) ?? missing();
      if (!parent.directory) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      if (denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      const created = `${prefix}${++sequence}`;
      directory(created);
      writes.push(created);
      return created;
    },
    remove: async (value: string) => {
      removals.push(value);
      for (const existing of entries.keys()) {
        if (existing === key(value) || existing.startsWith(`${key(value)}\\`)) entries.delete(existing);
      }
    },
  };
  directory(profile);
  directory(userTemp);
  directory(systemTemp);
  directory(paths.join(profile, marker));
  file(paths.join(userTemp, 'foreign.txt'));
  file(paths.join(systemTemp, 'foreign.txt'));
  return { profile, systemRoot, systemTemp, userTemp, env, entries, writes, removals, memoryFs,
    directory, file, key, denyCreation: () => { denied = true; } };
}

async function loadWindowsContext(fixture: ReturnType<typeof windowsFixture>) {
  // Scope context has no filesystem/platform seam. Global Vitest mocks would also change the isolation hooks.
  // A local loader binds only the required dependencies and executes the current helpers without rewriting them.
  const modules = new Map<string, object>();
  const filenames = new Map([
    ['../utils/state-paths.js', new URL('../../src/utils/state-paths.ts', import.meta.url)],
    ['scope-context', new URL('../../src/intent/scope-context.ts', import.meta.url)],
  ]);
  const dependencies: Record<string, unknown> = {
    'node:path': path.win32,
    'node:crypto': crypto,
    'node:os': { tmpdir: () => fixture.userTemp, userInfo: () => ({ homedir: fixture.profile }) },
    'fs-extra': fixture.memoryFs,
    './test-path-fence.js': { assertTestWritablePath: (value: string) => value },
    '../utils/test-path-fence.js': { assertTestWritablePath: (value: string) => value },
  };
  for (const [name, filename] of filenames) {
    const source = await fs.readFile(filename, 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    const exports = {};
    // Execute the unchanged public helpers with a foreign-platform environment and an isolated filesystem.
    vm.runInNewContext(compiled, { exports, process: { platform: 'win32', env: fixture.env },
      require: (dependency: string) => dependencies[dependency] ?? modules.get(dependency)
        ?? (() => { throw new Error(`Unexpected dependency ${dependency}`); })(),
    }, { filename: filename.pathname });
    modules.set(name, exports);
  }
  return modules.get('scope-context') as {
    createScopeContext(options: ScopeContextOptions): Promise<ScopeContext>;
  };
}

describe('Windows User neutral context', () => {
  // Test Value Gate: normal global Agent homes must not disable User recovery when a safe system temp is available.
  for (const marker of ['.codex', '.claude', '.cursor']) {
    it.each([true, false])(`uses the safe system temp with ${marker} and readOnly=%s`, async (readOnly) => {
      const fixture = windowsFixture(marker);
      const { createScopeContext } = await loadWindowsContext(fixture);
      const context = await createScopeContext({ scope: 'user', cwd: fixture.profile, env: fixture.env, readOnly });
      expect(path.win32.dirname(context.executionCwd)).toBe(fixture.systemTemp);
      expect(context.awHome).toBe(path.win32.join(fixture.profile, '.aw'));
      expect(context.generationRoot).toBe(path.win32.join(fixture.profile, '.aw', 'portable', 'user'));
      expect(fixture.entries.has(fixture.key(context.executionCwd))).toBe(true);
      await context.dispose();
      expect(fixture.entries.has(fixture.key(context.executionCwd))).toBe(false);
      expect(fixture.removals).toEqual([context.executionCwd]);
      expect(fixture.entries.get(fixture.key(path.win32.join(fixture.userTemp, 'foreign.txt')))?.contents).toBe('foreign');
      expect(fixture.entries.get(fixture.key(path.win32.join(fixture.systemTemp, 'foreign.txt')))?.contents).toBe('foreign');
      expect(fixture.writes).toEqual([context.executionCwd]);
    });
  }

  it.each([
    { SystemRoot: undefined, windir: 'W:\\Windows' },
    { SystemRoot: undefined, sYsTeMrOoT: 'W:\\Windows' },
    { systemroot: 'Z:\\ignored', SystemRoot: 'W:\\Windows' },
  ])('respects Windows system-root key selection: %j', async (environment) => {
    const fixture = windowsFixture('.codex', environment);
    if ('sYsTeMrOoT' in environment) delete fixture.env.SystemRoot;
    const { createScopeContext } = await loadWindowsContext(fixture);
    const context = await createScopeContext({ scope: 'user', cwd: fixture.profile, env: fixture.env, readOnly: true });
    expect(path.win32.dirname(context.executionCwd)).toBe(fixture.systemTemp);
    await context.dispose();
  });

  // Test Value Gate: unsafe or unwritable candidates must not create outputs or remove foreign files.
  it.each(['polluted', 'denied', 'not-directory', 'relative-root', 'missing-root', 'missing-directory'])(
    'blocks all failed candidates when the system temp is %s', async (failure) => {
      const fixture = windowsFixture();
      if (failure === 'polluted') fixture.file(path.win32.join(fixture.systemRoot, '.git'));
      if (failure === 'denied') fixture.denyCreation();
      if (failure === 'not-directory') fixture.file(fixture.systemTemp);
      if (failure === 'relative-root') fixture.env.SystemRoot = '\\Windows';
      if (failure === 'missing-root') delete fixture.env.SystemRoot;
      if (failure === 'missing-directory') {
        for (const key of fixture.entries.keys()) {
          if (key === fixture.key(fixture.systemTemp) || key.startsWith(`${fixture.key(fixture.systemTemp)}\\`)) {
            fixture.entries.delete(key);
          }
        }
      }
      const before = [...fixture.entries];
      const { createScopeContext } = await loadWindowsContext(fixture);
      for (const readOnly of [true, false]) {
        await expect(createScopeContext({ scope: 'user', cwd: fixture.profile, env: fixture.env, readOnly }))
          .rejects.toThrow('userNeutralCwdUnavailable');
      }
      expect([...fixture.entries]).toEqual(before);
      expect(fixture.writes).toEqual([]);
      expect(fixture.removals).toEqual([]);
    },
  );

  it('preserves a foreign replacement of its created temporary directory', async () => {
    const fixture = windowsFixture();
    const { createScopeContext } = await loadWindowsContext(fixture);
    const context = await createScopeContext({ scope: 'user', cwd: fixture.profile, env: fixture.env, readOnly: true });
    fixture.entries.delete(fixture.key(context.executionCwd));
    fixture.directory(context.executionCwd);
    const foreign = path.win32.join(context.executionCwd, 'foreign.txt');
    fixture.file(foreign, 'replacement');
    await context.dispose();
    expect(fixture.entries.get(fixture.key(foreign))?.contents).toBe('replacement');
    expect(fixture.removals).toEqual([]);
  });
});
