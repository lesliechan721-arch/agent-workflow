import { afterEach, describe, expect, it } from 'vitest';

import {
  clearAgentVersionProbeCacheForTests,
  extractStrictSemVerTokenFromVersionOutput,
  getAgentVersionRequirement,
  getMinimumAgentVersion,
  probeAgentVersion,
} from '../../src/utils/agent-version.js';
import { NativeCliError, type NativeCliInvocation } from '../../src/utils/native-cli.js';

function createInvocation(command: string): NativeCliInvocation {
  return {
    command,
    args: ['--version'],
  };
}

function createNativeCliError(options: {
  command: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  cause?: unknown;
}): NativeCliError {
  return new NativeCliError({
    invocation: createInvocation(options.command),
    exitCode: options.exitCode ?? 1,
    stdout: options.stdout ?? '',
    stderr: options.stderr ?? '',
    cause: options.cause,
  });
}

describe('agent-version', () => {
  afterEach(() => {
    clearAgentVersionProbeCacheForTests();
  });

  it('reads built-in minimum versions by platform', () => {
    expect(getMinimumAgentVersion('codex')).toBe('0.145.0');
    expect(getMinimumAgentVersion('claude')).toBe('2.1.88');
    expect(getAgentVersionRequirement('claude')).toMatchObject({
      platform: 'claude',
      command: 'claude',
      displayName: 'Claude Code',
      minVersion: '2.1.88',
    });
  });

  it('extracts the first strict SemVer token from supported version outputs', () => {
    expect(extractStrictSemVerTokenFromVersionOutput('codex-cli 0.145.0')).toBe('0.145.0');
    expect(extractStrictSemVerTokenFromVersionOutput('2.1.119 (Claude Code)')).toBe('2.1.119');
    expect(extractStrictSemVerTokenFromVersionOutput('noise\n0.144.1-alpha.1 more')).toBe('0.144.1-alpha.1');
  });

  it.each([
    'latest',
    'v0.145.0',
    'agent-0.145.0',
    '0.144',
    '0.145.0beta',
    '0.145.0.1',
    '"0.145.0"',
  ])('rejects invalid SemVer token output %s', (output) => {
    expect(extractStrictSemVerTokenFromVersionOutput(output)).toBeNull();
  });

  it('treats stdout/stderr mixed output as one probe stream', async () => {
    const result = await probeAgentVersion('codex', {
      runner: async () => ({
        exitCode: 0,
        stdout: 'codex-cli',
        stderr: '0.145.0',
      }),
    });

    expect(result).toMatchObject({
      platform: 'codex',
      command: 'codex',
      status: 'supported',
      detectedVersion: '0.145.0',
      requiredMinVersion: '0.145.0',
    });
    expect(result.rawOutput).toContain('codex-cli');
    expect(result.rawOutput).toContain('0.145.0');
  });

  it('caches matching probes within the current process', async () => {
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return {
        exitCode: 0,
        stdout: 'codex-cli 0.145.0',
        stderr: '',
      };
    };
    const first = await probeAgentVersion('codex', {
      cwd: '/repo',
      env: { PATH: '/bin' },
      runner,
    });
    const second = await probeAgentVersion('codex', {
      cwd: '/repo',
      env: { PATH: '/bin' },
      runner,
    });

    expect(calls).toBe(1);
    expect(first).toMatchObject({ status: 'supported', detectedVersion: '0.145.0' });
    expect(second).toMatchObject({ status: 'supported', detectedVersion: '0.145.0' });
    expect(second).not.toBe(first);
  });

  it.each(['0.144.0', '0.144.999'])('rejects Codex %s below the 0.145.0 minimum', async (version) => {
    await expect(
      probeAgentVersion('codex', {
        runner: async () => ({
          exitCode: 0,
          stdout: `codex-cli ${version}`,
          stderr: '',
        }),
      }),
    ).resolves.toMatchObject({
      status: 'tooOld',
      reasonCode: 'agentVersionTooLow',
      detectedVersion: version,
      requiredMinVersion: '0.145.0',
    });
  });

  it('compares prerelease precedence with strict SemVer rules', async () => {
    await expect(
      probeAgentVersion('codex', {
        runner: async () => ({
          exitCode: 0,
          stdout: 'codex-cli 0.145.0-beta.1',
          stderr: '',
        }),
      }),
    ).resolves.toMatchObject({
      status: 'tooOld',
      reasonCode: 'agentVersionTooLow',
      detectedVersion: '0.145.0-beta.1',
    });

    await expect(
      probeAgentVersion('codex', {
        runner: async () => ({
          exitCode: 0,
          stdout: 'codex-cli 0.145.1-alpha.1',
          stderr: '',
        }),
      }),
    ).resolves.toMatchObject({
      status: 'supported',
      detectedVersion: '0.145.1-alpha.1',
    });

    await expect(
      probeAgentVersion('claude', {
        runner: async () => ({
          exitCode: 0,
          stdout: '2.1.88-alpha.1 (Claude Code)',
          stderr: '',
        }),
      }),
    ).resolves.toMatchObject({
      status: 'tooOld',
      reasonCode: 'agentVersionTooLow',
      detectedVersion: '2.1.88-alpha.1',
    });
  });

  it('returns stable reason codes for missing, probe failures, unparseable output, and too-low versions', async () => {
    const missing = await probeAgentVersion('codex', {
      runner: async () => {
        throw createNativeCliError({
          command: 'codex',
          cause: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }),
        });
      },
    });
    expect(missing).toMatchObject({
      platform: 'codex',
      status: 'missing',
      reasonCode: 'agentVersionMissing',
    });

    const timeout = await probeAgentVersion('claude', {
      runner: async () => {
        throw createNativeCliError({
          command: 'claude',
          exitCode: 124,
          stderr: 'timed out',
        });
      },
    });
    expect(timeout).toMatchObject({
      platform: 'claude',
      status: 'probeFailed',
      reasonCode: 'agentVersionProbeFailed',
      exitCode: 124,
    });

    const unparseable = await probeAgentVersion('claude', {
      runner: async () => ({
        exitCode: 0,
        stdout: 'latest',
        stderr: '',
      }),
    });
    expect(unparseable).toMatchObject({
      platform: 'claude',
      status: 'unparseable',
      reasonCode: 'agentVersionUnparseable',
    });

    const tooLow = await probeAgentVersion('codex', {
      runner: async () => ({
        exitCode: 0,
        stdout: 'codex-cli 0.130.0',
        stderr: '',
      }),
    });
    expect(tooLow).toMatchObject({
      platform: 'codex',
      status: 'tooOld',
      reasonCode: 'agentVersionTooLow',
      detectedVersion: '0.130.0',
    });
  });
});
