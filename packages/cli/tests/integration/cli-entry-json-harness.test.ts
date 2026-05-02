import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCliEntry } from '../helpers/cli-entry.js';

const tempDirs: string[] = [];

interface MockStatusOptions {
  json?: boolean;
  verbose?: boolean;
}

interface MockStatusContext {
  diagnostics: {
    verbose: boolean;
    debug: boolean;
  };
  reporter: {
    notice: (notice: {
      level: 'info';
      message: string;
      identity: string;
      target: 'stderr';
    }) => void | Promise<void>;
  };
}

afterEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('cli entry JSON stdout harness', () => {
  it('parses CLI stdout JSON across json, verbose, and debug flag combinations', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-entry-json-'));
    tempDirs.push(tempDir);

    const statusCommand = vi.fn(async (
      _plugins: string[],
      options: MockStatusOptions,
      context: MockStatusContext,
    ) => {
      await context.reporter.notice({
        level: 'info',
        message: `diagnostic:${options.json ? 'json' : 'human'}:${context.diagnostics.debug ? 'debug' : 'nodebug'}`,
        identity: `diagnostic:${statusCommand.mock.calls.length}`,
        target: 'stderr',
      });

      return {
        reports: [],
        output: JSON.stringify({
          ok: true,
          json: options.json === true,
          optionsVerbose: options.verbose === true,
          diagnosticsVerbose: context.diagnostics.verbose,
          diagnosticsDebug: context.diagnostics.debug,
        }),
      };
    });
    vi.doMock('../../src/commands/status.js', () => ({
      statusCommand,
    }));

    const cases: Array<{
      label: string;
      flags: string[];
      expected: {
        json: boolean;
        optionsVerbose: boolean;
        diagnosticsVerbose: boolean;
        diagnosticsDebug: boolean;
      };
    }> = [
      {
        label: 'json',
        flags: ['--json'],
        expected: {
          json: true,
          optionsVerbose: false,
          diagnosticsVerbose: false,
          diagnosticsDebug: false,
        },
      },
      {
        label: 'verbose',
        flags: ['--verbose'],
        expected: {
          json: false,
          optionsVerbose: true,
          diagnosticsVerbose: true,
          diagnosticsDebug: false,
        },
      },
      {
        label: 'debug',
        flags: ['--debug'],
        expected: {
          json: false,
          optionsVerbose: false,
          diagnosticsVerbose: true,
          diagnosticsDebug: true,
        },
      },
      {
        label: 'json-verbose',
        flags: ['--json', '--verbose'],
        expected: {
          json: true,
          optionsVerbose: true,
          diagnosticsVerbose: true,
          diagnosticsDebug: false,
        },
      },
      {
        label: 'json-debug',
        flags: ['--json', '--debug'],
        expected: {
          json: true,
          optionsVerbose: false,
          diagnosticsVerbose: true,
          diagnosticsDebug: true,
        },
      },
      {
        label: 'json-verbose-debug',
        flags: ['--json', '--verbose', '--debug'],
        expected: {
          json: true,
          optionsVerbose: true,
          diagnosticsVerbose: true,
          diagnosticsDebug: true,
        },
      },
    ];

    for (const entry of cases) {
      const flags = [...entry.flags];
      if (flags.includes('--debug')) {
        flags.push('--log-file', path.join(tempDir, `${entry.label}.log`));
      }

      const result = await runCliEntry(
        ['status', 'git-commit', ...flags],
        {
          cwd: tempDir,
          env: { AW_HOME: path.join(tempDir, 'aw-home') } as NodeJS.ProcessEnv,
        },
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).not.toContain('diagnostic:');
      expect(result.stdout).not.toContain('调试：');
      expect(result.stderr).toContain('diagnostic:');
      const payload = result.parseJsonStdout();
      expect(payload).toMatchObject({
        ok: true,
        ...entry.expected,
      });
    }
  });
});
