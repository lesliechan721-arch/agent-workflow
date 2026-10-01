import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const PURE_TEST_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'AW_HOME',
  'AW_CODEX_HOME',
  'AW_CLAUDE_HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'npm_config_userconfig',
  'NPM_CONFIG_USERCONFIG',
] as const;

type PureTestEnvKey = typeof PURE_TEST_ENV_KEYS[number];

interface SavedEnvValue {
  present: boolean;
  value: string | undefined;
}

export interface PureTestIsolationContext {
  sentinelHome: string;
  npmUserConfigPath: string;
  teardown: () => Promise<void>;
}

async function findMissingSentinelHome(): Promise<string> {
  while (true) {
    const candidate = path.join(os.tmpdir(), `aw-pure-test-home-${process.pid}-${randomUUID()}`);
    try {
      await fs.lstat(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return candidate;
      }
      throw error;
    }
  }
}

function restoreControlledEnv(savedEnv: Map<PureTestEnvKey, SavedEnvValue>): void {
  for (const key of PURE_TEST_ENV_KEYS) {
    const saved = savedEnv.get(key);
    if (!saved?.present) {
      delete process.env[key];
    } else if (saved.value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved.value;
    }
  }
}

export async function createPureTestIsolationContext(): Promise<PureTestIsolationContext> {
  const sentinelHome = await findMissingSentinelHome();
  const npmUserConfigPath = path.join(sentinelHome, '.npmrc');
  const savedEnv = new Map<PureTestEnvKey, SavedEnvValue>();
  const nextEnv: Record<PureTestEnvKey, string> = {
    HOME: sentinelHome,
    USERPROFILE: sentinelHome,
    AW_HOME: path.join(sentinelHome, '.aw'),
    AW_CODEX_HOME: path.join(sentinelHome, '.codex'),
    AW_CLAUDE_HOME: path.join(sentinelHome, '.claude'),
    CODEX_HOME: path.join(sentinelHome, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(sentinelHome, '.claude'),
    XDG_CONFIG_HOME: path.join(sentinelHome, '.config'),
    XDG_CACHE_HOME: path.join(sentinelHome, '.cache'),
    XDG_STATE_HOME: path.join(sentinelHome, '.local', 'state'),
    TMPDIR: path.join(sentinelHome, 'tmp'),
    TEMP: path.join(sentinelHome, 'tmp'),
    TMP: path.join(sentinelHome, 'tmp'),
    npm_config_userconfig: npmUserConfigPath,
    NPM_CONFIG_USERCONFIG: npmUserConfigPath,
  };

  for (const key of PURE_TEST_ENV_KEYS) {
    savedEnv.set(key, {
      present: Object.hasOwn(process.env, key),
      value: process.env[key],
    });
    process.env[key] = nextEnv[key];
  }

  return {
    sentinelHome,
    npmUserConfigPath,
    teardown: async () => {
      restoreControlledEnv(savedEnv);

      try {
        await fs.lstat(sentinelHome)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }
        throw error;
      }

      let cleanupError: unknown;
      try {
        await fs.rm(sentinelHome, { recursive: true, force: true });
      } catch (error) {
        cleanupError = error;
      }

      const failure = new Error(`Pure test created its sentinel HOME: ${sentinelHome}`);
      if (cleanupError !== undefined) {
        failure.cause = cleanupError;
      }
      throw failure;
    },
  };
}

export function installNoNetworkFetchGuard(): typeof globalThis.fetch | undefined {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    throw new Error(`Network access is disabled in tests. Use a path source or local bare Git remote for ${String(input)}.`);
  };
  return previousFetch;
}

export function restoreFetch(previousFetch: typeof globalThis.fetch | undefined): void {
  if (previousFetch === undefined) {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
    return;
  }
  globalThis.fetch = previousFetch;
}
