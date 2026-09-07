import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import type { PluginMeta } from '../../src/types.js';
import {
  redactPluginScriptOutput,
  createDefaultPluginProcessRunner,
  runPreApplyScript,
  summarizePluginScriptOutput,
  type PluginProcessRunner,
  type PluginScriptInvocation,
} from '../../src/utils/plugin-scripts.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { assertProcessTreeInspectionAvailable } from '../../src/utils/process-tree.js';
import { waitForProcessExit } from '../support/process-tree.js';

const tempDirs: string[] = [];
const descendantPids = new Set<number>();
const OUTPUT_LIMIT = 64 * 1024;
const SYNTHETIC_DESCENDANT_MAX_LIFETIME_MS = 30_000;
const vitestPackagePath = realpathSync(fileURLToPath(
  new URL('../../node_modules/vitest/package.json', import.meta.url),
));
const viteNodePath = path.resolve(path.dirname(vitestPackagePath), '..', 'vite-node', 'vite-node.mjs');
const interruptHostPath = fileURLToPath(new URL('../fixtures/pre-apply-interrupt-host.ts', import.meta.url));
let hostProcessInspectionAvailable = false;
try {
  await assertProcessTreeInspectionAvailable();
  hostProcessInspectionAvailable = true;
} catch {
  // Default-runner process-tree tests require host process inspection permission.
}

async function createPlugin(options: { sensitiveDefault?: string } = {}): Promise<PluginMeta> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-pre-apply-'));
  tempDirs.push(rootDir);
  await fs.outputFile(path.join(rootDir, 'scripts', 'preApply.mjs'), 'process.stdin.resume();\n');
  return {
    sourceId: 'local',
    pluginId: 'local/demo',
    rootDir,
    manifestPath: path.join(rootDir, '.agents-plugin', 'plugin.json'),
    manifest: {
      schemaVersion: 3,
      name: 'demo',
      version: '1.0.0',
      description: 'preApply fixture',
      marketplace: {
        category: 'test',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
      scripts: { preApply: { path: './scripts/preApply.mjs', timeoutMs: 2_000 } },
      ...(options.sensitiveDefault ? {
        config: { fields: { token: { type: 'string', sensitive: true, default: options.sensitiveDefault } } },
      } : {}),
    },
  };
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fs.pathExists(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}.`);
}

function waitForChildExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function expectStandardSignalExit(
  outcome: { code: number | null; signal: NodeJS.Signals | null },
  signal: 'SIGINT' | 'SIGTERM',
): void {
  const conventionalExitCode = 128 + os.constants.signals[signal];
  expect(
    outcome.signal === signal && outcome.code === null
      || outcome.signal === null && outcome.code === conventionalExitCode,
  ).toBe(true);
}

afterEach(async () => {
  for (const pid of descendantPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The preApply runner cleanup can already have terminated the descendant.
    }
  }
  descendantPids.clear();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('preApply script', () => {
  it.skipIf(process.platform === 'win32' || !hostProcessInspectionAvailable).each([
    'SIGINT',
    'SIGTERM',
  ] as const)(
    'cleans the production preApply process tree before the host exits on %s',
    async (signal) => {
      const plugin = await createPlugin();
      const awHome = path.join(plugin.rootDir, 'aw-home');
      const rootPidPath = path.join(plugin.rootDir, 'root.pid');
      const descendantPidPath = path.join(plugin.rootDir, 'descendant.pid');
      const continuedPath = path.join(plugin.rootDir, 'continued');
      const descendantSource = [
        `setTimeout(() => process.exit(0), ${SYNTHETIC_DESCENDANT_MAX_LIFETIME_MS});`,
        'setInterval(() => {}, 1000);',
      ].join('\n');
      await fs.outputFile(path.join(plugin.rootDir, 'scripts', 'preApply.mjs'), [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(rootPidPath)}, String(process.pid));`,
        `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { detached: true, stdio: 'ignore' });`,
        `writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
        'descendant.unref();',
        `setTimeout(() => process.exit(0), ${SYNTHETIC_DESCENDANT_MAX_LIFETIME_MS});`,
        'setInterval(() => {}, 1000);',
      ].join('\n'));
      const host = spawn(process.execPath, [
        viteNodePath,
        interruptHostPath,
        plugin.rootDir,
        awHome,
        continuedPath,
      ], {
        cwd: path.resolve(fileURLToPath(new URL('../..', import.meta.url))),
        env: {
          PATH: process.env.PATH,
          HOME: path.join(plugin.rootDir, 'host-home'),
          AW_HOME: awHome,
          AW_CODEX_HOME: path.join(awHome, 'codex-home'),
          AW_CLAUDE_HOME: path.join(awHome, 'claude-home'),
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const exited = waitForChildExit(host);

      await Promise.all([waitForFile(rootPidPath), waitForFile(descendantPidPath)]);
      const rootPid = Number(await fs.readFile(rootPidPath, 'utf8'));
      const descendantPid = Number(await fs.readFile(descendantPidPath, 'utf8'));
      descendantPids.add(rootPid);
      descendantPids.add(descendantPid);
      host.kill(signal);

      expectStandardSignalExit(await exited, signal);
      await Promise.all([waitForProcessExit(rootPid), waitForProcessExit(descendantPid)]);
      descendantPids.delete(rootPid);
      descendantPids.delete(descendantPid);
      expect(await fs.pathExists(continuedPath)).toBe(false);
      expect(await fs.readdir(path.join(awHome, 'tmp'))).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'exits with a clear failure when interrupted process cleanup fails',
    async () => {
      const plugin = await createPlugin();
      const awHome = path.join(plugin.rootDir, 'aw-home');
      const continuedPath = path.join(plugin.rootDir, 'continued');
      const readyPath = path.join(plugin.rootDir, 'runner-ready');
      const host = spawn(process.execPath, [
        viteNodePath,
        interruptHostPath,
        plugin.rootDir,
        awHome,
        continuedPath,
        readyPath,
      ], {
        cwd: path.resolve(fileURLToPath(new URL('../..', import.meta.url))),
        env: {
          PATH: process.env.PATH,
          HOME: path.join(plugin.rootDir, 'host-home'),
          AW_HOME: awHome,
          AW_CODEX_HOME: path.join(awHome, 'codex-home'),
          AW_CLAUDE_HOME: path.join(awHome, 'claude-home'),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      host.stderr?.setEncoding('utf8');
      host.stderr?.on('data', (chunk: string) => { stderr += chunk; });
      const exited = waitForChildExit(host);

      await waitForFile(readyPath);
      host.kill('SIGTERM');

      await expect(exited).resolves.toEqual({ code: 1, signal: null });
      expect(stderr).toContain('preApply process cleanup failed after SIGTERM.');
      expect(await fs.pathExists(continuedPath)).toBe(false);
      expect(await fs.readdir(path.join(awHome, 'tmp'))).toEqual([]);
    },
  );

  it('removes its interrupt listeners after normal completion', async () => {
    const plugin = await createPlugin();
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');

    await runPreApplyScript({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: plugin.rootDir,
      context: createCommandExecutionContext({ env: { AW_HOME: path.join(plugin.rootDir, 'aw-home') } }),
      runner: { async run() {
        return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
      } },
    });

    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  });

  it('routes a Windows script through the Job helper and waits for helper close after abort', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 321,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin,
      stdout,
      stderr,
      kill: vi.fn(() => true),
    });
    const spawn = vi.fn(() => child);
    const observeProcessTree = vi.fn();
    const terminateProcessTree = vi.fn();
    const runner = createDefaultPluginProcessRunner({
      platform: 'win32',
      spawn: spawn as unknown as typeof import('node:child_process').spawn,
      createWindowsJobInvocation: () => ({
        command: 'C:\\aw\\aw-windows-job.exe',
        args: ['--config', 'encoded'],
        config: { schemaVersion: 1, executable: 'node.exe', args: ['script.js'], parentPid: 42 },
      }),
      observeProcessTree,
      terminateProcessTree,
    });
    const controller = new AbortController();
    const running = runner.run({
      command: 'node.exe',
      args: ['script.js'],
      cwd: '/',
      env: {},
    }, { timeoutMs: 2_000, signal: controller.signal });
    let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });

    controller.abort(new Error('script aborted'));
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(settled).toBe(false);
    child.signalCode = 'SIGKILL';
    child.emit('close', null, 'SIGKILL');

    await expect(running).rejects.toThrow('script aborted');
    expect(spawn).toHaveBeenCalledWith(
      'C:\\aw\\aw-windows-job.exe',
      ['--config', 'encoded'],
      expect.objectContaining({ detached: false }),
    );
    expect(observeProcessTree).not.toHaveBeenCalled();
    expect(terminateProcessTree).not.toHaveBeenCalled();
  });

  it.each([
    ['normal POSIX exit', 'linux', 'exit', false, true, true, false],
    ['normal POSIX cleanup rejection', 'linux', 'exit', true, true, true, false],
    ['POSIX abort cleanup rejection', 'linux', 'abort', true, false, true, false],
    ['normal Windows close', 'win32', 'close', false, true, false, true],
    ['Windows abort cleanup rejection', 'win32', 'abort', true, false, false, false],
  ] as const)('settles only after process-tree cleanup on %s', async (
    _name,
    platform,
    completion,
    rejectCleanup,
    requireConfirmedCleanup,
    detached,
    allowUnobservedWindowsProcessOnNormalCompletion,
  ) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 321,
      exitCode: 0 as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin,
      stdout,
      stderr,
      kill: vi.fn(() => true),
    });
    const observation = {
      pid: 321,
      onFailure: () => () => undefined,
      dispose: vi.fn(),
    };
    const terminateProcessTree = vi.fn(async () => {
      if (rejectCleanup) throw new Error('cleanup rejected');
    });
    const spawn = vi.fn(() => child);
    const runner = createDefaultPluginProcessRunner({
      platform,
      spawn: spawn as unknown as typeof import('node:child_process').spawn,
      observeProcessTree: () => observation,
      terminateProcessTree,
    });
    const controller = new AbortController();
    const running = runner.run({
      command: 'node',
      args: [],
      cwd: '/',
      env: {},
    }, { timeoutMs: 2_000, signal: controller.signal });
    if (completion === 'abort') controller.abort(new Error('script aborted'));
    else child.emit(completion, 0, null);

    if (rejectCleanup) {
      await expect(running).rejects.toThrow('cleanup rejected');
    } else {
      await expect(running).resolves.toMatchObject({ exitCode: 0, timedOut: false });
    }
    expect(terminateProcessTree).toHaveBeenCalledWith(
      321,
      expect.any(Function),
      {},
      {
        observation,
        requireConfirmedCleanup,
        ...(allowUnobservedWindowsProcessOnNormalCompletion
          ? { allowUnobservedWindowsProcessOnNormalCompletion: true }
          : {}),
      },
    );
    expect(spawn).toHaveBeenCalledWith(
      'node',
      [],
      expect.objectContaining({ detached }),
    );
  });

  it.skipIf(!hostProcessInspectionAvailable)(
    'handles a large input when the process exits immediately or reads it fully',
    async () => {
      const plugin = await createPlugin();
      const input = 'x'.repeat(2 * 1024 * 1024);
      const scripts = [
        { name: 'immediate-success.mjs', source: 'process.exit(0);\n', exitCode: 0 },
        { name: 'immediate-failure.mjs', source: 'process.exit(7);\n', exitCode: 7 },
        {
          name: 'read-input.mjs',
          source: [
            'let input = "";',
            'for await (const chunk of process.stdin) input += chunk;',
            `process.exit(input.length === ${input.length} ? 0 : 9);`,
          ].join('\n'),
          exitCode: 0,
        },
      ];
      const runner = createDefaultPluginProcessRunner();

      for (const script of scripts) {
        const entryPath = path.join(plugin.rootDir, 'scripts', script.name);
        await fs.outputFile(entryPath, script.source);
        const result = await runner.run({
          command: process.execPath,
          args: [entryPath],
          cwd: plugin.rootDir,
          env: { PATH: process.env.PATH },
          stdin: input,
        }, { timeoutMs: 5_000 });

        expect(result).toMatchObject({
          exitCode: script.exitCode,
          signal: null,
          timedOut: false,
        });
      }
    },
  );

  it('reports a non-EPIPE input error after process exit and cleanup', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = Object.assign(new EventEmitter(), {
      end: vi.fn((_input: string, callback: (error?: Error) => void) => {
        queueMicrotask(() => {
          const error = Object.assign(new Error('private input failure'), { code: 'EIO' });
          stdin.emit('error', error);
          callback(error);
        });
      }),
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 321,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin,
      stdout,
      stderr,
      kill: vi.fn(() => true),
    });
    const observation = {
      pid: 321,
      onFailure: () => () => undefined,
      dispose: vi.fn(),
    };
    const terminateProcessTree = vi.fn(async () => undefined);
    const runner = createDefaultPluginProcessRunner({
      platform: 'linux',
      spawn: vi.fn(() => child) as unknown as typeof import('node:child_process').spawn,
      observeProcessTree: () => observation,
      terminateProcessTree,
    });
    const running = runner.run({
      command: 'node', args: [], cwd: '/', env: {}, stdin: 'context',
    }, { timeoutMs: 2_000 });

    await Promise.resolve();
    child.exitCode = 0;
    child.emit('exit', 0, null);
    const inputFailure = await running.catch((error: unknown) => error as Error);

    expect(inputFailure).toMatchObject({
      name: 'PluginProcessInputError',
      message: 'Plugin process input could not be sent.',
    });
    expect(inputFailure.message).not.toContain('private input failure');
    expect(terminateProcessTree).toHaveBeenCalledOnce();

    const plugin = await createPlugin();
    const preApplyFailure = await runPreApplyScript({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: plugin.rootDir,
      context: createCommandExecutionContext({ env: { AW_HOME: path.join(plugin.rootDir, 'aw-home') } }),
      runner: { async run() { throw inputFailure; } },
    }).catch((error: unknown) => error as Error & { operationDiagnostic?: unknown });

    expect(preApplyFailure.message).toBe('preApply input could not be sent.');
    expect(preApplyFailure.operationDiagnostic).toEqual({
      code: 'preApplyInputFailed',
      stage: 'preApply',
      safeMessage: 'The preApply context could not be sent to the process.',
    });
  });

  it('redacts every exact substring of a short sensitive scalar', () => {
    expect(summarizePluginScriptOutput(
      'prefixabcSuffix ordinary short text',
      ['abc', ''],
    )).toBe(
      'prefix[REDACTED]Suffix ordinary short text',
    );
  });

  it('redacts raw and JSON-escaped forms of short sensitive scalars', () => {
    const secrets = ['ab\nc', 'a"b', 'a\\b'];
    const output = secrets.flatMap((secret) => [
      `raw=${secret}`,
      `escaped=${JSON.stringify(secret).slice(1, -1)}`,
    ]).join(' ');
    const summary = summarizePluginScriptOutput(output, secrets);

    expect(summary.match(/\[REDACTED\]/gu)?.length).toBe(6);
    for (const secret of secrets) {
      expect(summary).not.toContain(secret);
      expect(summary).not.toContain(JSON.stringify(secret).slice(1, -1));
    }
  });

  it('redacts raw and JSON-escaped forms of quotes, newlines, and backslashes', () => {
    const secret = 'quote" newline\n slash\\';
    const escaped = JSON.stringify(secret).slice(1, -1);

    expect(redactPluginScriptOutput(
      `raw=${secret} escaped=${escaped}`,
      [secret],
    )).toBe('raw=[REDACTED] escaped=[REDACTED]');
  });

  it('keeps generic credential redaction in plugin script summaries', () => {
    expect(summarizePluginScriptOutput(
      'authorization=Bearer bearer-secret token=token-secret',
      [],
    )).toBe('authorization=Bearer [REDACTED] token=[REDACTED]');
  });

  it('uses overlap only to redact a token that starts inside the raw output window', () => {
    const secret = `§${'s'.repeat(99)}`;
    const summary = summarizePluginScriptOutput(
      `${'x'.repeat(OUTPUT_LIMIT - 20)}${secret}RAW-OVERLAP-SECRET`,
      [secret],
    );

    expect(summary).toContain('[REDACTED]');
    expect(summary).not.toContain('RAW-OVERLAP-SECRET');
    for (let prefixLength = 1; prefixLength <= secret.length; prefixLength += 1) {
      expect(summary).not.toContain(secret.slice(0, prefixLength));
    }
  });

  it('preserves raw-window text after a fully contained sensitive token', () => {
    expect(summarizePluginScriptOutput(
      'before window-secret-value after-window-text',
      ['window-secret-value'],
    )).toBe('before [REDACTED] after-window-text');
  });

  it('redacts overlapping sensitive tokens independently of input order', () => {
    const value = 'before abc-secret after';
    const shortFirst = summarizePluginScriptOutput(value, ['abc', 'abc-secret']);
    const longFirst = summarizePluginScriptOutput(value, ['abc-secret', 'abc']);

    expect(shortFirst).toBe('before [REDACTED] after');
    expect(longFirst).toBe(shortFirst);
  });

  it('merges self-overlapping and partially overlapping sensitive token ranges', () => {
    expect(redactPluginScriptOutput('abababababab tail', ['abababab'])).toBe(
      '[REDACTED] tail',
    );
    expect(redactPluginScriptOutput('abcdefghijkl tail', ['abcdefgh', 'efghijkl'])).toBe(
      '[REDACTED] tail',
    );
  });

  it('does not expose output beyond the raw window after overlapping replacements', () => {
    const firstSecret = `§${'a'.repeat(39)}`;
    const secondSecret = `${'a'.repeat(20)}${'b'.repeat(30)}`;
    const summary = summarizePluginScriptOutput(
      `${'x'.repeat(OUTPUT_LIMIT - 30)}${firstSecret}${'b'.repeat(30)}RAW-OVERLAP-TAIL`,
      [firstSecret, secondSecret],
    );

    expect(summary).toContain('[REDACTED]');
    expect(summary).not.toContain('RAW-OVERLAP-TAIL');
    for (const secret of [firstSecret, secondSecret]) {
      for (let prefixLength = 1; prefixLength <= secret.length; prefixLength += 1) {
        expect(summary).not.toContain(secret.slice(0, prefixLength));
      }
    }
  });

  it('still truncates long non-sensitive output', () => {
    const summary = summarizePluginScriptOutput(`${'x'.repeat(OUTPUT_LIMIT)}tail`, []);

    expect(summary).toHaveLength(OUTPUT_LIMIT);
    expect(summary).not.toContain('tail');
  });

  it.skipIf(!hostProcessInspectionAvailable).each(['exit', 'timeout'] as const)(
    'redacts a JSON-escaped sensitive token split across the output limit on %s', async (mode) => {
    const secret = '§pre-apply "cross-boundary"\nsensitive\\token';
    const escaped = JSON.stringify(secret).slice(1, -1);
    const plugin = await createPlugin({ sensitiveDefault: secret });
    await fs.outputFile(path.join(plugin.rootDir, 'scripts', 'preApply.mjs'), [
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { input += chunk; });',
      'process.stdin.on("end", () => {',
      '  const token = JSON.stringify(JSON.parse(input).config.values.token).slice(1, -1);',
      '  const splitAt = 12;',
      `  const first = "x".repeat(${OUTPUT_LIMIT} - splitAt) + token.slice(0, splitAt);`,
      '  process.stderr.write(first, () => {',
      '    setTimeout(() => {',
      `      process.stderr.write(token.slice(splitAt), () => { ${mode === 'exit' ? 'process.exitCode = 7;' : 'setInterval(() => {}, 1000);'} });`,
      '    }, 20);',
      '  });',
      '});',
    ].join('\n'));

    const error = await runPreApplyScript({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: plugin.rootDir,
      context: createCommandExecutionContext({ env: { AW_HOME: path.join(plugin.rootDir, 'aw-home') } }),
      ...(mode === 'timeout' ? { scriptTimeoutMs: 1_000 } : {}),
    }).catch((failure: unknown) => failure as Error);

    expect(error.message).toContain('[REDACTED]');
    for (let prefixLength = 1; prefixLength <= escaped.length; prefixLength += 1) {
      expect(error.message).not.toContain(escaped.slice(0, prefixLength));
    }
    },
  );

  it.skipIf(!hostProcessInspectionAvailable)(
    'does not pull a partial token at the capture limit into a summary after repeated redaction', async () => {
    const secret = 'SENSITIVE_"capture"\nedge\\token';
    const escaped = JSON.stringify(secret).slice(1, -1);
    const plugin = await createPlugin({ sensitiveDefault: secret });
    await fs.outputFile(path.join(plugin.rootDir, 'scripts', 'preApply.mjs'), [
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { input += chunk; });',
      'process.stdin.on("end", () => {',
      '  const token = JSON.stringify(JSON.parse(input).config.values.token).slice(1, -1);',
      '  const repeated = token.repeat(100);',
      `  const finalStart = ${OUTPUT_LIMIT} + token.length - 5;`,
      '  const output = repeated + "x".repeat(finalStart - repeated.length) + token;',
      '  process.stderr.write(output, () => { process.exitCode = 7; });',
      '});',
    ].join('\n'));

    const error = await runPreApplyScript({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: plugin.rootDir,
      context: createCommandExecutionContext({
        env: { AW_HOME: path.join(plugin.rootDir, 'aw-home') },
      }),
    }).catch((failure: unknown) => failure as Error);

    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain(escaped);
    expect(error.message).not.toContain('SENSI');
    },
  );

  it.skipIf(!hostProcessInspectionAvailable)(
    'keeps default-runner non-sensitive output summaries at 64 KiB', async () => {
    const plugin = await createPlugin();
    await fs.outputFile(path.join(plugin.rootDir, 'scripts', 'preApply.mjs'), [
      'process.stdin.resume();',
      `process.stderr.write("x".repeat(${OUTPUT_LIMIT}), () => {`,
      '  setTimeout(() => {',
      '    process.stderr.write("tail", () => { process.exitCode = 7; });',
      '  }, 20);',
      '});',
    ].join('\n'));

    const error = await runPreApplyScript({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: plugin.rootDir,
      context: createCommandExecutionContext({ env: { AW_HOME: path.join(plugin.rootDir, 'aw-home') } }),
    }).catch((failure: unknown) => failure as Error);
    const prefix = 'preApply failed with exit code 7. stderr: ';

    expect(error.message.startsWith(prefix)).toBe(true);
    expect(error.message.slice(prefix.length)).toHaveLength(OUTPUT_LIMIT);
    expect(error.message).not.toContain('tail');
    },
  );

  it('uses only user config for a user target', async () => {
    const plugin = await createPlugin({ sensitiveDefault: 'default-value' });
    const sourceIdentity = `sha256:${'4'.repeat(64)}`;
    plugin.sourceIdentity = sourceIdentity;
    plugin.catalogLogicalIdentity = 'catalog.example/local';
    const cwd = path.join(plugin.rootDir, 'project');
    const env = { AW_HOME: path.join(plugin.rootDir, 'aw-home') };
    await writePluginConfigStore({
      sourceId: plugin.sourceId,
      sourceIdentity,
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
      values: { token: 'user-value' },
    });
    await writePluginConfigStore({
      sourceId: plugin.sourceId,
      sourceIdentity,
      logicalIdentity: plugin.catalogLogicalIdentity,
      pluginName: plugin.manifest.name,
      scope: 'project',
      cwd,
      env,
      values: { token: 'project-value' },
    });
    let invocation: PluginScriptInvocation | undefined;
    await runPreApplyScript({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd,
      context: createCommandExecutionContext({ env }),
      runner: { async run(value) {
        invocation = value;
        return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
      } },
    });

    expect(JSON.parse(invocation?.stdin ?? '{}').config.values).toEqual({ token: 'user-value' });
  });

  it('runs fixed Node in the plugin root and sends the minimal v1 context on stdin', async () => {
    const plugin = await createPlugin();
    let invocation: PluginScriptInvocation | undefined;
    const runner: PluginProcessRunner = {
      async run(value) {
        invocation = value;
        return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
      },
    };
    const cwd = path.join(plugin.rootDir, 'project');
    let timeoutMs: number | undefined;
    await runPreApplyScript({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd,
      context: createCommandExecutionContext({ env: { AW_HOME: path.join(plugin.rootDir, 'aw-home'), PATH: process.env.PATH } }),
      runner: { async run(value, options) {
        timeoutMs = options.timeoutMs;
        return runner.run(value, options);
      } },
    });

    expect(invocation?.command).toBe(process.execPath);
    expect(invocation?.cwd).toBe(plugin.rootDir);
    expect(invocation?.env.HOME).not.toBe(process.env.HOME);
    expect(JSON.parse(invocation?.stdin ?? '{}')).toEqual({
      schemaVersion: 1,
      plugin: { pluginId: 'local/demo', name: 'demo', version: '1.0.0', rootDir: plugin.rootDir },
      target: { platform: 'codex', scope: 'project', projectRoot: cwd },
      config: { values: {} },
    });
    expect(timeoutMs).toBe(2_000);
  });

  it('reports timeout and redacts sensitive stderr', async () => {
    const secret = 'secret "value"\npath\\tail';
    const escaped = JSON.stringify(secret).slice(1, -1);
    const plugin = await createPlugin({ sensitiveDefault: secret });
    const runner: PluginProcessRunner = {
      async run() {
        return { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: escaped, timedOut: true };
      },
    };
    await expect(runPreApplyScript({
      plugin,
      platform: 'claude',
      scope: 'user',
      cwd: plugin.rootDir,
      context: createCommandExecutionContext({ env: { AW_HOME: path.join(plugin.rootDir, 'aw-home') } }),
      runner,
    })).rejects.toThrow('preApply timed out. stderr: [REDACTED]');
  });

  it('redacts stdout and stderr in a non-zero failure', async () => {
    const secret = 'secret "value"\npath\\tail';
    const escaped = JSON.stringify(secret).slice(1, -1);
    const plugin = await createPlugin({ sensitiveDefault: secret });
    await expect(runPreApplyScript({
      plugin,
      platform: 'claude',
      scope: 'user',
      cwd: plugin.rootDir,
      context: createCommandExecutionContext({ env: { AW_HOME: path.join(plugin.rootDir, 'aw-home') } }),
      runner: { async run() {
        return {
          exitCode: 7,
          signal: null,
          stdout: `stdout ${escaped}`,
          stderr: `stderr ${escaped}`,
          timedOut: false,
        };
      } },
    })).rejects.toThrow(
      'preApply failed with exit code 7. stdout: stdout [REDACTED]; stderr: stderr [REDACTED]',
    );
  });

  it('keeps a typed safe diagnostic for a non-zero preApply exit', async () => {
    const plugin = await createPlugin({ sensitiveDefault: 'secret-value' });
    const error = await runPreApplyScript({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: plugin.rootDir,
      context: createCommandExecutionContext({ env: { AW_HOME: path.join(plugin.rootDir, 'aw-home') } }),
      runner: { async run() {
        return { exitCode: 9, signal: null, stdout: '', stderr: 'secret-value', timedOut: false };
      } },
    }).catch((failure: unknown) => failure as Error & { operationDiagnostic?: unknown });

    expect(error.operationDiagnostic).toEqual({
      code: 'preApplyExited',
      stage: 'preApply',
      safeMessage: 'The preApply process exited unsuccessfully.',
      exitCode: 9,
    });
    expect(JSON.stringify(error.operationDiagnostic)).not.toContain('secret-value');
  });

  it('removes private roots and a short embedded secret from public failures', async () => {
    const plugin = await createPlugin({ sensitiveDefault: 'abc' });
    const cwd = path.join(plugin.rootDir, 'prefixabcSuffix-project');
    const awHome = path.join(plugin.rootDir, 'prefixabcSuffix-aw-home');
    const error = await runPreApplyScript({
      plugin,
      platform: 'claude',
      scope: 'project',
      cwd,
      context: createCommandExecutionContext({ env: { AW_HOME: awHome } }),
      runner: { async run(invocation) {
        return {
          exitCode: 7,
          signal: null,
          stdout: '',
          stderr: [
            'prefixabcSuffix ordinary',
            invocation.cwd,
            cwd,
            invocation.env.AW_HOME,
            invocation.env.AW_CODEX_HOME,
            invocation.env.AW_CLAUDE_HOME,
            invocation.env.HOME,
            invocation.env.TMPDIR,
          ].join(' | '),
          timedOut: false,
        };
      } },
    }).catch((failure: unknown) => failure as Error);
    const serialized = JSON.stringify(error.message);

    expect(serialized).toContain('prefix[REDACTED]Suffix ordinary');
    expect(serialized).toContain('[plugin-root]');
    expect(serialized).toContain('[project-root]');
    expect(serialized).toContain('[aw-home]');
    expect(serialized).toContain('[codex-home]');
    expect(serialized).toContain('[claude-home]');
    expect(serialized).toContain('[temporary-home]');
    for (const privateValue of ['abc', plugin.rootDir, cwd, awHome]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it.skipIf(!hostProcessInspectionAvailable)(
    'captures and redacts a longer JSON-escaped token across the output limit', async () => {
      const secret = '§\0x';
      const encoded = JSON.stringify(secret).slice(1, -1);
      const plugin = await createPlugin({ sensitiveDefault: secret });
      await fs.outputFile(path.join(plugin.rootDir, 'scripts', 'preApply.mjs'), [
        'let input = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => { input += chunk; });',
        'process.stdin.on("end", () => {',
        '  const token = JSON.parse(input).config.values.token;',
        '  const encoded = JSON.stringify(token).slice(1, -1);',
        '  const splitAt = 2;',
        `  const first = "x".repeat(${OUTPUT_LIMIT} - splitAt) + encoded.slice(0, splitAt);`,
        '  process.stderr.write(first, () => {',
        '    setTimeout(() => {',
        '      process.stderr.write(encoded.slice(splitAt), () => { process.exitCode = 7; });',
        '    }, 20);',
        '  });',
        '});',
      ].join('\n'));

      const error = await runPreApplyScript({
        plugin,
        platform: 'codex',
        scope: 'user',
        cwd: plugin.rootDir,
        context: createCommandExecutionContext({ env: { AW_HOME: path.join(plugin.rootDir, 'aw-home') } }),
      }).catch((failure: unknown) => failure as Error);

      expect(error.message).toContain('[REDACTED]');
      expect(error.message).not.toContain(encoded);
      for (let prefixLength = 1; prefixLength <= encoded.length; prefixLength += 1) {
        expect(error.message).not.toContain(encoded.slice(0, prefixLength));
      }
    },
  );

  it('redacts a sensitive value that contains a private root as one overlapping range', async () => {
    const plugin = await createPlugin();
    const secret = `credential-part${plugin.rootDir}`;
    plugin.manifest.config = {
      fields: { token: { type: 'string', sensitive: true, default: secret } },
    };
    const error = await runPreApplyScript({
      plugin,
      platform: 'claude',
      scope: 'user',
      cwd: plugin.rootDir,
      context: createCommandExecutionContext({
        env: { AW_HOME: path.join(plugin.rootDir, 'aw-home') },
      }),
      runner: { async run() {
        return {
          exitCode: 7,
          signal: null,
          stdout: '',
          stderr: `prefix${secret}Suffix ordinary`,
          timedOut: false,
        };
      } },
    }).catch((failure: unknown) => failure as Error);

    expect(error.message).toContain('prefix[REDACTED]Suffix ordinary');
    expect(error.message).not.toContain('credential-part');
    expect(error.message).not.toContain(plugin.rootDir);
  });

  it('reports a stable spawn failure without exposing runner diagnostics', async () => {
    const plugin = await createPlugin({ sensitiveDefault: 'secret-value' });
    const error = await runPreApplyScript({
      plugin,
      platform: 'claude',
      scope: 'user',
      cwd: plugin.rootDir,
      context: createCommandExecutionContext({ env: { AW_HOME: path.join(plugin.rootDir, 'aw-home') } }),
      runner: { async run() { throw new Error(`spawn ${plugin.rootDir} secret-value`); } },
    }).catch((failure: unknown) => failure as Error);

    expect(error.message).toBe('preApply could not start.');
  });

  it('redacts every scalar leaf of a top-level sensitive object from stderr', async () => {
    const plugin = await createPlugin();
    const sourceIdentity = `sha256:${'8'.repeat(64)}`;
    plugin.sourceIdentity = sourceIdentity;
    plugin.manifest.config = {
      fields: {
        credentials: {
          type: 'object',
          sensitive: true,
          properties: {
            token: { type: 'string' },
            account: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    };
    const env = { AW_HOME: path.join(plugin.rootDir, 'aw-home') };
    await writePluginConfigStore({
      sourceId: plugin.sourceId,
      sourceIdentity,
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd: plugin.rootDir,
      env,
      values: { credentials: { token: 'object-secret', account: 'private-account' } },
    });
    const runner: PluginProcessRunner = {
      async run() {
        return {
          exitCode: 7,
          signal: null,
          stdout: '',
          stderr: 'object-secret private-account',
          timedOut: false,
        };
      },
    };

    const error = await runPreApplyScript({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: plugin.rootDir,
      context: createCommandExecutionContext({ env }),
      runner,
    }).catch((failure: unknown) => failure as Error);
    expect(error.message).not.toContain('object-secret');
    expect(error.message).not.toContain('private-account');
    expect(error.message).toContain('[REDACTED] [REDACTED]');
  });

  it('reports a non-zero exit without persisting failure state', async () => {
    const plugin = await createPlugin();
    const awHome = path.join(plugin.rootDir, 'aw-home');
    const runner: PluginProcessRunner = {
      async run() {
        return { exitCode: 7, signal: null, stdout: '', stderr: 'failed', timedOut: false };
      },
    };
    await expect(runPreApplyScript({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: plugin.rootDir,
      context: createCommandExecutionContext({ env: { AW_HOME: awHome } }),
      runner,
    })).rejects.toThrow('preApply failed with exit code 7');
    expect(await fs.pathExists(path.join(awHome, 'lifecycle'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32' || !hostProcessInspectionAvailable)(
    'terminates a detached descendant when the preApply parent exits non-zero',
    async () => {
      const plugin = await createPlugin();
      const descendantPidPath = path.join(plugin.rootDir, 'descendant.pid');
      const descendantSource = [
        `setTimeout(() => process.exit(0), ${SYNTHETIC_DESCENDANT_MAX_LIFETIME_MS});`,
        'setInterval(() => {}, 1000);',
      ].join('\n');
      await fs.outputFile(path.join(plugin.rootDir, 'scripts', 'preApply.mjs'), [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { detached: true, stdio: 'ignore' });`,
        `writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
        'descendant.unref();',
        'setTimeout(() => process.exit(7), 100);',
      ].join('\n'));

      await expect(runPreApplyScript({
        plugin,
        platform: 'codex',
        scope: 'user',
        cwd: plugin.rootDir,
        context: createCommandExecutionContext({
          env: { AW_HOME: path.join(plugin.rootDir, 'aw-home'), PATH: process.env.PATH },
        }),
      })).rejects.toThrow('preApply failed with exit code 7');

      const descendantPid = Number(await fs.readFile(descendantPidPath, 'utf8'));
      descendantPids.add(descendantPid);
      await waitForProcessExit(descendantPid);
      descendantPids.delete(descendantPid);
    },
  );
});
