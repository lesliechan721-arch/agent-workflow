import {
  AGENT_VERSION_DISPLAY_NAMES,
  AGENT_VERSION_PROBE_COMMANDS,
  DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS,
  MINIMUM_AGENT_VERSIONS,
} from '../constants.js';
import type {
  AgentVersionProbeResult,
  AgentVersionRequirement,
  PlatformName,
} from '../types.js';
import { compareStrictSemVer, tryParseStrictSemVer } from './manifest.js';
import {
  isNativeCliExecutableMissingError,
  runNativeCli,
  summarizeNativeCliFailure,
  type NativeCliRunner,
} from './native-cli.js';

export interface ProbeAgentVersionOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runner?: NativeCliRunner;
  timeoutMs?: number;
}

const VERSION_ARGUMENTS = ['--version'];

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
  const requirement = getAgentVersionRequirement(platform);

  try {
    const result = await runNativeCli(
      {
        command: requirement.command,
        args: VERSION_ARGUMENTS,
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs ?? DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS,
      },
      options.runner,
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
