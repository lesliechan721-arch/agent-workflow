import path from 'node:path';

import fs from 'fs-extra';

import type { CommandDiagnostics } from '../commands/runtime.js';
import type { CommandEvent, DebugLogger } from './model.js';
import { redactValue } from './redact.js';

const MAX_LOG_FILES = 20;
const MAX_LOG_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function createNoopDebugLogger(): DebugLogger {
  return {
    log: () => {},
  };
}

async function appendJsonLine(logFile: string, payload: unknown): Promise<void> {
  await fs.ensureDir(path.dirname(logFile));
  await fs.appendFile(logFile, `${JSON.stringify(redactValue(payload))}\n`, 'utf8');
}

async function cleanupOldLogs(logFile: string, diagnostics: CommandDiagnostics): Promise<void> {
  if (diagnostics.commandName === 'status' || diagnostics.logFileSource !== 'default') {
    return;
  }

  const dir = path.dirname(logFile);
  try {
    const entries = await fs.readdir(dir);
    const now = Date.now();
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.startsWith('aw-') && entry.endsWith('.log'))
        .map(async (entry) => {
          const filePath = path.join(dir, entry);
          const stat = await fs.stat(filePath);
          return {
            filePath,
            mtimeMs: stat.mtimeMs,
          };
        }),
    );

    const sorted = candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    await Promise.all(
      sorted
        .filter((entry, index) => index >= MAX_LOG_FILES || now - entry.mtimeMs > MAX_LOG_AGE_MS)
        .map((entry) => fs.remove(entry.filePath)),
    );
  } catch (error) {
    await appendJsonLine(logFile, {
      time: new Date().toISOString(),
      runId: diagnostics.runId,
      commandName: diagnostics.commandName,
      event: {
        type: 'debug-log:cleanup-error',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export function createFileDebugLogger(diagnostics: CommandDiagnostics): DebugLogger {
  if (!diagnostics.debug || !diagnostics.logFile) {
    return createNoopDebugLogger();
  }

  const logFile = diagnostics.logFile;
  let initialized = false;

  async function ensureInitialized(): Promise<void> {
    if (initialized) {
      return;
    }

    initialized = true;
    await appendJsonLine(logFile, {
      time: new Date().toISOString(),
      runId: diagnostics.runId,
      commandName: diagnostics.commandName,
      event: {
        type: 'run:metadata',
        data: {
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          logFile,
          commandName: diagnostics.commandName,
          runId: diagnostics.runId,
          cliVersion: process.env.npm_package_version,
          ...diagnostics.metadata,
        },
      },
    });
    await cleanupOldLogs(logFile, diagnostics);
  }

  return {
    logFile,
    log: async (event: CommandEvent) => {
      if (initialized && !(await fs.pathExists(logFile))) {
        initialized = false;
      }
      await ensureInitialized();
      await appendJsonLine(logFile, {
        time: new Date().toISOString(),
        runId: diagnostics.runId,
        commandName: diagnostics.commandName,
        event,
      });
    },
  };
}
