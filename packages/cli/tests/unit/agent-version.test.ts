import { afterEach, describe, expect, it } from 'vitest';

import {
  clearAgentVersionProbeCacheForTests,
  extractStrictSemVerTokenFromVersionOutput,
  getAgentVersionRequirement,
  getCodexOperationRequirement,
  probeCodexOperationVersion,
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

  it.each([
    { platform: 'codex' as const, command: 'codex', displayName: 'Codex' },
    { platform: 'claude' as const, command: 'claude', displayName: 'Claude Code' },
  ])('provides valid probe metadata for $platform', ({ platform, command, displayName }) => {
    const requirement = getAgentVersionRequirement(platform);

    expect(requirement).toMatchObject({ platform, command, displayName });
    expect(extractStrictSemVerTokenFromVersionOutput(requirement.minVersion))
      .toBe(requirement.minVersion);
  });

  it('keeps the base Codex gate separate from the project activation gate', async () => {
    const user = getCodexOperationRequirement('user');
    const project = getCodexOperationRequirement('project');

    expect(user).toEqual({
      scope: 'user',
      minimumVersion: '0.145.0',
      requiresProjectPluginContract: false,
    });
    expect(project).toEqual({
      scope: 'project',
      minimumVersion: '0.151.0',
      requiresProjectPluginContract: true,
    });
    await expect(probeCodexOperationVersion(user, {
      runner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.150.0', stderr: '' }),
    })).resolves.toMatchObject({ status: 'supported', requiredMinVersion: '0.145.0' });
    await expect(probeCodexOperationVersion(project, {
      runner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.150.0', stderr: '' }),
    })).resolves.toMatchObject({
      status: 'tooOld',
      requiredMinVersion: '0.151.0',
      detectedVersion: '0.150.0',
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

  it('passes the effective Codex home and agent kind only to Codex version probes', async () => {
    const codexEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: '/ignored/codex-home',
      HOME: '/preserved/home',
      USERPROFILE: 'C:\\preserved\\profile',
    };
    const claudeEnv: NodeJS.ProcessEnv = {
      HOME: '/claude/home',
      USERPROFILE: 'C:\\claude\\profile',
      PATH: process.env.PATH,
    };
    let codexInvocation: NativeCliInvocation | undefined;
    let claudeInvocation: NativeCliInvocation | undefined;

    await probeAgentVersion('codex', {
      env: codexEnv,
      runner: async (invocation) => {
        codexInvocation = invocation;
        return { exitCode: 0, stdout: 'codex-cli 0.145.0', stderr: '' };
      },
    });
    await probeAgentVersion('claude', {
      env: claudeEnv,
      runner: async (invocation) => {
        claudeInvocation = invocation;
        return { exitCode: 0, stdout: '2.1.88 (Claude Code)', stderr: '' };
      },
    });

    expect(codexInvocation).toMatchObject({
      agentKind: 'codex',
      env: {
        CODEX_HOME: process.env.AW_CODEX_HOME,
        HOME: '/preserved/home',
        USERPROFILE: 'C:\\preserved\\profile',
      },
    });
    expect(claudeInvocation?.env).toEqual(claudeEnv);
    expect(claudeInvocation?.env?.CODEX_HOME).toBeUndefined();
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
      env: { ...process.env, PATH: '/bin' },
      runner,
    });
    const second = await probeAgentVersion('codex', {
      cwd: '/repo',
      env: { ...process.env, PATH: '/bin' },
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
