import crypto from 'node:crypto';

import {
  AGENT_VERSION_DISPLAY_NAMES,
  AGENT_VERSION_PROBE_COMMANDS,
  CODEX_PROJECT_PLUGIN_MIN_VERSION,
  DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS,
  MINIMUM_AGENT_VERSIONS,
} from '../constants.js';
import type {
  AgentVersionProbeResult,
  AgentVersionRequirement,
  CodexOperationRequirement,
  PlatformName,
  Scope,
} from '../types.js';
import { compareStrictSemVer, tryParseStrictSemVer } from './manifest.js';
import { getCodexHome } from './state-paths.js';
import {
  getDefaultNativeCliRunner,
  isNativeCliExecutableMissingError,
  runNativeCli,
  summarizeNativeCliFailure,
  type NativeCliRunner,
} from './native-cli.js';

export interface ProbeAgentVersionOptions {
  argsPrefix?: string[];
  cache?: boolean;
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  minimumVersion?: string;
  runner?: NativeCliRunner;
  timeoutMs?: number;
}

const VERSION_ARGUMENTS = ['--version'];

let probeCacheByRunner = new WeakMap<NativeCliRunner, Map<string, Promise<AgentVersionProbeResult>>>();

export function getMinimumAgentVersion(platform: PlatformName): string {
  return MINIMUM_AGENT_VERSIONS[platform];
}

export function getAgentVersionRequirement(platform: PlatformName): AgentVersionRequirement {
  return {
    platform,
    command: AGENT_VERSION_PROBE_COMMANDS[platform],
    displayName: AGENT_VERSION_DISPLAY_NAMES[platform],
    minVersion: getMinimumAgentVersion(platform),
  };
}

export function getCodexOperationRequirement(scope: Scope): CodexOperationRequirement {
  const requiresProjectPluginContract = scope === 'project';
  return {
    scope,
    minimumVersion: requiresProjectPluginContract
      ? CODEX_PROJECT_PLUGIN_MIN_VERSION
      : MINIMUM_AGENT_VERSIONS.codex,
    requiresProjectPluginContract,
  };
}

export function extractStrictSemVerTokenFromVersionOutput(output: string): string | null {
  for (const token of output.split(/\s+/u)) {
    if (token && tryParseStrictSemVer(token)) {
      return token;
    }
  }

  return null;
}

function combineProbeOutput(stdout: string, stderr: string): string {
  return [stdout, stderr]
    .filter((value) => value.length > 0)
    .join('\n');
}

function createEnvFingerprint(env: NodeJS.ProcessEnv): string {
  const entries = Object.keys(env)
    .sort()
    .map((key) => [key, env[key] ?? '']);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(entries))
    .digest('hex');
}

function buildProbeCacheKey(
  platform: PlatformName,
  requirement: AgentVersionRequirement,
  options: ProbeAgentVersionOptions,
): string {
  const env = options.env ?? process.env;
  return JSON.stringify({
    platform,
    command: options.command ?? requirement.command,
    args: [...(options.argsPrefix ?? []), ...VERSION_ARGUMENTS],
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs ?? DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS,
    minVersion: options.minimumVersion ?? requirement.minVersion,
    envFingerprint: createEnvFingerprint(env),
  });
}

function cloneProbeResult(result: AgentVersionProbeResult): AgentVersionProbeResult {
  return { ...result };
}

function createFailureProbeResult(
  requirement: AgentVersionRequirement,
  status: 'missing' | 'probeFailed' | 'unparseable' | 'tooOld',
  options: {
    detectedVersion?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    rawOutput?: string;
    details?: string;
  } = {},
): AgentVersionProbeResult {
  const reasonCode = {
    missing: 'agentVersionMissing',
    probeFailed: 'agentVersionProbeFailed',
    unparseable: 'agentVersionUnparseable',
    tooOld: 'agentVersionTooLow',
  } as const;

  return {
    platform: requirement.platform,
    command: requirement.command,
    status,
    requiredMinVersion: requirement.minVersion,
    detectedVersion: options.detectedVersion,
    reasonCode: reasonCode[status],
    stdout: options.stdout ?? '',
    stderr: options.stderr ?? '',
    rawOutput: options.rawOutput ?? '',
    exitCode: options.exitCode,
    details: options.details,
  };
}

export async function probeAgentVersion(
  platform: PlatformName,
  options: ProbeAgentVersionOptions = {},
): Promise<AgentVersionProbeResult> {
  const baseRequirement = getAgentVersionRequirement(platform);
  const requirement = options.minimumVersion === undefined
    ? baseRequirement
    : {
        ...baseRequirement,
        minVersion: options.minimumVersion,
      };
  if (!tryParseStrictSemVer(requirement.minVersion)) {
    throw new Error(`Invalid agent version requirement: ${requirement.minVersion}.`);
  }
  const runner = options.runner ?? getDefaultNativeCliRunner();
  if (options.cache === false) {
    return probeAgentVersionUncached(requirement, runner, options);
  }
  const cacheKey = buildProbeCacheKey(platform, requirement, options);
  let runnerCache = probeCacheByRunner.get(runner);
  if (!runnerCache) {
    runnerCache = new Map();
    probeCacheByRunner.set(runner, runnerCache);
  }

  const cached = runnerCache.get(cacheKey);
  if (cached) {
    return cloneProbeResult(await cached);
  }

  const probe = probeAgentVersionUncached(requirement, runner, options)
    .catch((error: unknown) => {
      runnerCache.delete(cacheKey);
      throw error;
    });
  runnerCache.set(cacheKey, probe);
  return cloneProbeResult(await probe);
}

export function probeCodexOperationVersion(
  requirement: CodexOperationRequirement,
  options: Omit<ProbeAgentVersionOptions, 'minimumVersion'> = {},
): Promise<AgentVersionProbeResult> {
  return probeAgentVersion('codex', {
    ...options,
    minimumVersion: requirement.minimumVersion,
  });
}

async function probeAgentVersionUncached(
  requirement: AgentVersionRequirement,
  runner: NativeCliRunner,
  options: ProbeAgentVersionOptions,
): Promise<AgentVersionProbeResult> {
  try {
    const env = options.env ?? process.env;
    const result = await runNativeCli(
      {
        command: options.command ?? requirement.command,
        args: [...(options.argsPrefix ?? []), ...VERSION_ARGUMENTS],
        cwd: options.cwd,
        env: requirement.platform === 'codex'
          ? { ...env, CODEX_HOME: getCodexHome(env) }
          : options.env,
        agentKind: requirement.platform,
        timeoutMs: options.timeoutMs ?? DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS,
      },
      runner,
    );

    const rawOutput = combineProbeOutput(result.stdout, result.stderr);
    if (result.exitCode !== 0) {
      return createFailureProbeResult(requirement, 'probeFailed', {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        rawOutput,
        details: rawOutput.trim() || `Command exited with code ${result.exitCode}.`,
      });
    }

    const detectedVersion = extractStrictSemVerTokenFromVersionOutput(rawOutput);
    if (!detectedVersion) {
      return createFailureProbeResult(requirement, 'unparseable', {
        stdout: result.stdout,
        stderr: result.stderr,
        rawOutput,
        details: `Unable to parse a strict SemVer token from ${requirement.command} --version output.`,
      });
    }

    if (compareStrictSemVer(detectedVersion, requirement.minVersion) < 0) {
      return createFailureProbeResult(requirement, 'tooOld', {
        detectedVersion,
        stdout: result.stdout,
        stderr: result.stderr,
        rawOutput,
        details: `${requirement.displayName} ${detectedVersion} is lower than required ${requirement.minVersion}.`,
      });
    }

    return {
      platform: requirement.platform,
      command: requirement.command,
      status: 'supported',
      requiredMinVersion: requirement.minVersion,
      detectedVersion,
      stdout: result.stdout,
      stderr: result.stderr,
      rawOutput,
      exitCode: result.exitCode,
    };
  } catch (error) {
    const nativeError = error as {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    };
    const stdout = typeof nativeError.stdout === 'string' ? nativeError.stdout : '';
    const stderr = typeof nativeError.stderr === 'string' ? nativeError.stderr : '';
    const rawOutput = combineProbeOutput(stdout, stderr);

    if (isNativeCliExecutableMissingError(error)) {
      return createFailureProbeResult(requirement, 'missing', {
        exitCode: typeof nativeError.exitCode === 'number' ? nativeError.exitCode : undefined,
        stdout,
        stderr,
        rawOutput,
        details: summarizeNativeCliFailure(error),
      });
    }

    return createFailureProbeResult(requirement, 'probeFailed', {
      exitCode: typeof nativeError.exitCode === 'number' ? nativeError.exitCode : undefined,
      stdout,
      stderr,
      rawOutput,
      details: summarizeNativeCliFailure(error),
    });
  }
}

export function clearAgentVersionProbeCacheForTests(): void {
  probeCacheByRunner = new WeakMap();
}
