import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StatusV4Payload } from '../../src/commands/status-v4.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import {
  createTuiControllerDependencies,
  statusTargetFingerprint,
} from '../../src/tui/controller-runtime.js';
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

  it('includes the private revision sidecar in the target review fingerprint', () => {
    const targets = [target('user', 'present')];
    const current = [{
      pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const,
      revision: { state: 'current' as const, availableVersion: '1.0.0', installedVersion: '1.0.0' },
    }];
    const upgradeAvailable = [{
      pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const,
      revision: { state: 'upgradeAvailable' as const, availableVersion: '2.0.0', installedVersion: '1.0.0' },
    }];

    expect(statusTargetFingerprint(targets, current))
      .not.toBe(statusTargetFingerprint(targets, upgradeAvailable));
  });

  it.each([
    ['current', 'present'],
    ['unknown', 'present'],
    ['upgradeAvailable', 'partial'],
  ] as const)('rejects upgrade when revision is %s and placement is %s', async (revisionState, placementState) => {
    runtimeMocks.statusCommandV4.mockResolvedValue({
      payload: { targets: [target('user', placementState)] },
      targetRevisions: [{
        pluginId: 'official/demo', platform: 'codex', scope: 'user',
        revision: revisionState === 'unknown'
          ? { state: 'unknown', availableVersion: '1.0.0' }
          : {
              state: revisionState,
              availableVersion: revisionState === 'current' ? '1.0.0' : '2.0.0',
              installedVersion: '1.0.0',
            },
      }],
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));

    await expect(dependencies.validateIntent!({
      kind: 'pluginWrite', action: 'upgrade', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'targetStateChanged' });
  });

  it('accepts upgrade only for a present placement with upgradeAvailable evidence', async () => {
    runtimeMocks.statusCommandV4.mockResolvedValue({
      payload: { targets: [target('user', 'present')] },
      targetRevisions: [{
        pluginId: 'official/demo', platform: 'codex', scope: 'user',
        revision: { state: 'upgradeAvailable', availableVersion: '2.0.0', installedVersion: '1.0.0' },
      }],
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));

    await expect(dependencies.validateIntent!({
      kind: 'pluginWrite', action: 'upgrade', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    }, new AbortController().signal)).resolves.toBeUndefined();
  });
});
