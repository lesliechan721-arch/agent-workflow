import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import type { PluginMeta } from '../../src/types.js';
import {
  redactPluginScriptOutput,
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
let hostProcessInspectionAvailable = false;
try {
  await assertProcessTreeInspectionAvailable();
  hostProcessInspectionAvailable = true;
} catch {
  // This integration-style unit test requires permission to inspect the host process table.
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
  it('redacts short sensitive scalar tokens only at token boundaries', () => {
    expect(summarizePluginScriptOutput(
      'a 1 true long-secret-value cat 10 1.5 -1 untrue command:start',
      ['a', '1', 'true', 'long-secret-value'],
    )).toBe(
      '[REDACTED] [REDACTED] [REDACTED] [REDACTED] cat 10 1.5 -1 untrue command:start',
    );
    expect(summarizePluginScriptOutput(
      `${'x'.repeat(OUTPUT_LIMIT - 2)} az`,
      ['a'],
    )).toMatch(/ a$/u);
    expect(summarizePluginScriptOutput(
      `${'x'.repeat(OUTPUT_LIMIT - 2)} a `,
      ['a'],
    )).toMatch(/ \[REDACTED\]$/u);
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

  it('does not expose overlap text when overlapping tokens cross the raw output window', () => {
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

  it('redacts a sensitive token split across the output limit by the default runner', async () => {
    const secret = '§pre-apply-cross-boundary-sensitive-token';
    const plugin = await createPlugin({ sensitiveDefault: secret });
    await fs.outputFile(path.join(plugin.rootDir, 'scripts', 'preApply.mjs'), [
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { input += chunk; });',
      'process.stdin.on("end", () => {',
      '  const token = JSON.parse(input).config.values.token;',
      '  const splitAt = 12;',
      `  const first = "x".repeat(${OUTPUT_LIMIT} - splitAt) + token.slice(0, splitAt);`,
      '  process.stderr.write(first, () => {',
      '    setTimeout(() => {',
      '      process.stderr.write(token.slice(splitAt), () => { process.exitCode = 7; });',
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
    for (let prefixLength = 1; prefixLength <= secret.length; prefixLength += 1) {
      expect(error.message).not.toContain(secret.slice(0, prefixLength));
    }
  });

  it('keeps default-runner non-sensitive output summaries at 64 KiB', async () => {
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
  });

  it('uses only user config for a user target', async () => {
    const plugin = await createPlugin({ sensitiveDefault: 'default-value' });
    const sourceIdentity = `sha256:${'4'.repeat(64)}`;
    plugin.sourceIdentity = sourceIdentity;
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
    const plugin = await createPlugin({ sensitiveDefault: 'secret-value' });
    const runner: PluginProcessRunner = {
      async run() {
        return { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: 'secret-value', timedOut: true };
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
    const plugin = await createPlugin({ sensitiveDefault: 'secret-value' });
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
          stdout: 'stdout secret-value',
          stderr: 'stderr secret-value',
          timedOut: false,
        };
      } },
    })).rejects.toThrow(
      'preApply failed with exit code 7. stdout: stdout [REDACTED]; stderr: stderr [REDACTED]',
    );
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
