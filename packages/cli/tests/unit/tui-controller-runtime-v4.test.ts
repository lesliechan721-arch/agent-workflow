import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StatusV4Payload } from '../../src/commands/status-v4.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const runtimeMocks = vi.hoisted(() => ({
  statusCommandV4: vi.fn(),
  cleanupWriteCommand: vi.fn(),
  installWriteCommand: vi.fn(),
  reinstallWriteCommand: vi.fn(),
  uninstallWriteCommand: vi.fn(),
  upgradeWriteCommand: vi.fn(),
}));

vi.mock('../../src/commands/status-v4.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/status-v4.js')>(),
  statusCommandV4: runtimeMocks.statusCommandV4,
}));

vi.mock('../../src/commands/write-commands.js', () => ({
  cleanupWriteCommand: runtimeMocks.cleanupWriteCommand,
  installWriteCommand: runtimeMocks.installWriteCommand,
  reinstallWriteCommand: runtimeMocks.reinstallWriteCommand,
  uninstallWriteCommand: runtimeMocks.uninstallWriteCommand,
  upgradeWriteCommand: runtimeMocks.upgradeWriteCommand,
}));

function target(
  scope: 'user' | 'project',
  state: 'present' | 'partial' | 'error',
): StatusV4Payload['targets'][number] {
  return {
    pluginName: 'demo',
    pluginId: 'official/demo',
    sourceId: 'official',
    sourceIdentity: 'identity:official',
    version: '1.0.0',
    platform: 'codex',
    scope,
    cwd: '/workspace',
    state,
    components: [],
    errors: state === 'error' ? [{ code: 'targetError', message: 'safe failure' }] : [],
  };
}

function bundleUnavailableStatus(): Awaited<ReturnType<typeof runtimeMocks.statusCommandV4>> {
  const orphan = target('user', 'error');
  orphan.errors = [{ code: 'bundleUnavailable', message: 'safe failure' }];
  return {
    payload: {
      schemaVersion: 4,
      catalog: {
        primarySourceId: 'official',
        configDigest: 'sha256:config',
        compositeDigest: 'sha256:composite',
        sources: [{
          id: 'official',
          identity: 'identity:official',
          type: 'path',
          primary: true,
          requestedRef: 'path',
          freshness: 'path',
        }],
      },
      filters: { plugins: ['official/demo'], platform: 'codex', cwd: '/workspace' },
      targets: [orphan],
      errors: [],
    },
    pluginSummaries: [],
  };
}

describe('TUI controller runtime scope conflict validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['present', 'error'],
    ['error', 'present'],
  ] as const)('fails closed for forged %s + %s scope origin before any write', async (userState, projectState) => {
    runtimeMocks.statusCommandV4.mockResolvedValue({
      payload: { targets: [target('user', userState), target('project', projectState)] },
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));
    const presentScope = userState === 'present' ? 'user' : 'project';

    await expect(dependencies.validateIntent!({
      kind: 'pluginWrite',
      action: 'uninstall',
      pluginId: 'official/demo',
      platform: 'codex',
      scope: presentScope,
      originIssue: {
        issueId: 'scope:official/demo:codex',
        issueKey: 'forged',
        category: 'scopeConflict',
        actionId: presentScope === 'user' ? 'keepProjectScope' : 'keepUserScope',
      },
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'operationReviewStale' });

    expect(runtimeMocks.cleanupWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.installWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.reinstallWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.uninstallWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.upgradeWriteCommand).not.toHaveBeenCalled();
  });

  it.each(['partial', 'present'] as const)('keeps present + %s scope conflict validation valid', async (projectState) => {
    runtimeMocks.statusCommandV4.mockResolvedValue({
      payload: { targets: [target('user', 'present'), target('project', projectState)] },
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));

    await expect(dependencies.validateIntent!({
      kind: 'pluginWrite',
      action: 'uninstall',
      pluginId: 'official/demo',
      platform: 'codex',
      scope: 'project',
      originIssue: {
        issueId: 'scope:official/demo:codex',
        issueKey: 'scope-evidence',
        category: 'scopeConflict',
        actionId: 'keepUserScope',
      },
    }, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('uses status ownership evidence to run ordinary cleanup when the current Catalog bundle is absent', async () => {
    runtimeMocks.statusCommandV4.mockResolvedValue(bundleUnavailableStatus());
    runtimeMocks.cleanupWriteCommand.mockResolvedValue({
      platforms: ['codex'],
      plugins: ['demo'],
      warnings: [],
      rebuildResults: [],
      targetResults: [{
        target: {
          pluginName: 'demo',
          pluginId: 'official/demo',
          sourceId: 'official',
          platform: 'codex',
          scope: 'user',
          cwd: '/workspace',
        },
        action: 'cleanup',
        state: 'completed',
      }],
      overallState: 'succeeded',
      nativePlugins: {},
      repoManagedArtifacts: [],
      receiptTargets: [],
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'cleanup' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'user' as const,
      originIssue: {
        issueId: 'target:official/demo:codex:user:error',
        issueKey: 'sourceUnavailable\0official/demo\0\0\0\0\0official\0identity:official\0codex\0user',
        category: 'sourceUnavailable' as const,
        actionId: 'cleanup' as const,
      },
    };

    await expect(dependencies.validateIntent!(intent, new AbortController().signal))
      .resolves.toBeUndefined();
    const evidence = await dependencies.captureEvidence(intent, new AbortController().signal);
    expect(evidence).toMatchObject({
      source: { sourceId: 'official', sourceIdentity: 'identity:official', requestedRef: 'path' },
      targetFingerprint: expect.stringMatching(/^sha256:/u),
    });

    await expect(dependencies.executeIntent(intent, evidence)).resolves.toMatchObject({
      overallState: 'succeeded',
    });
    expect(runtimeMocks.cleanupWriteCommand).toHaveBeenCalledWith(
      ['official/demo'],
      expect.objectContaining({ platform: 'codex', scope: 'user', force: false }),
      expect.objectContaining({ reviewPreflight: expect.any(Function) }),
    );
    expect(runtimeMocks.installWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.uninstallWriteCommand).not.toHaveBeenCalled();
  });
});
