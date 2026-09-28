import { describe, expect, it } from 'vitest';

import {
  CodexReconcilePlanError,
  createCodexReconcilePlan,
  type CodexReconcilerCatalogTarget,
  type CodexReconcilerInput,
  type CodexReconcilerLiveEvidence,
} from '../../src/utils/codex-reconciler.js';
import type { CodexSharedNativeInspection } from '../../src/utils/codex-shared-native.js';
import type { CodexSurfaceAnalysis } from '../../src/utils/codex-surface-analysis.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function surface(kind: 'native' | 'mixed' | 'extension'): CodexSurfaceAnalysis {
  const native = kind !== 'extension';
  const extension = kind !== 'native';
  return {
    ok: true,
    nativeKinds: native ? ['skill'] : [],
    extensionKinds: extension ? ['instruction'] : [],
    unsupportedKinds: [],
    classification: kind === 'extension' ? 'aw-extension' : kind,
    deliveryOwner: kind === 'native' ? 'codex-native' : kind === 'mixed' ? 'split' : 'aw',
    scopeOverlap: extension ? 'aw-owned-conflict' : 'native-compatible',
    components: [
      ...(native ? [{
        key: 'manifest.skills',
        kind: 'skill' as const,
        owner: 'codex-native' as const,
        scopes: ['project', 'user'] as const,
        dynamic: false,
      }] : []),
      ...(extension ? [{
        key: 'extensions.instructions:guide',
        kind: 'instruction' as const,
        owner: 'aw' as const,
        scopes: ['project', 'user'] as const,
        dynamic: false,
        name: 'guide',
      }] : []),
    ],
    collisions: [],
    missingNativeIdentityKinds: [],
  };
}

function target(
  overrides: Partial<CodexReconcilerCatalogTarget> = {},
): CodexReconcilerCatalogTarget {
  return {
    pluginId: 'official/demo',
    pluginName: 'demo',
    codexPluginId: 'demo@aw',
    version: '1.0.0',
    payloadDigest: DIGEST,
    relation: 'requested',
    resolvedScope: 'project',
    surface: surface('native'),
    ...overrides,
  };
}

function live(
  sharedNative: CodexSharedNativeInspection,
  overrides: Partial<CodexReconcilerLiveEvidence> = {},
): CodexReconcilerLiveEvidence {
  return {
    codexPluginId: 'demo@aw',
    sharedNative,
    activations: {},
    ...overrides,
  };
}

function input(
  operation: CodexReconcilerInput['operation'],
  catalogTarget = target(),
  evidence = live({ state: 'missing' }),
): CodexReconcilerInput {
  return {
    operation,
    scope: catalogTarget.resolvedScope,
    cwd: '/repo',
    catalogClosure: [catalogTarget],
    liveEvidence: [evidence],
  };
}

describe('Codex desired-state reconciliation planner', () => {
  it('preserves user activation during selected project execution', () => {
    const plan = createCodexReconcilePlan(input('sync', target({
      resolvedScope: 'project', desiredScopes: ['project'], executionScopes: ['project'],
    }), live({ state: 'usable', version: '1.0.0' }, {
      activations: { user: true, project: true },
    })));
    expect(plan.activationActions.user[0]).toMatchObject({ action: 'none', desired: true });
    expect(plan.activationActions.project[0]).toMatchObject({ action: 'none', desired: true });
    expect(plan.postcheck.plugins[0]?.expectedUserEnabled).toBe(true);
  });

  it('preserves unselected project activation during user execution', () => {
    const plan = createCodexReconcilePlan(input('uninstall', target({
      resolvedScope: 'user', desiredScopes: ['project'], executionScopes: ['user'],
    }), live({ state: 'usable', version: '1.0.0' }, {
      activations: { user: true, project: true },
    })));
    expect(plan.activationActions.user[0]?.action).toBe('disable');
    expect(plan.activationActions.project[0]?.action).toBe('none');
    expect(plan.sharedNativeActions[0]?.action).toBe('none');
  });

  it('does not remove extensions outside selected execution scopes', () => {
    const plan = createCodexReconcilePlan(input('uninstall', target({
      surface: surface('extension'), resolvedScope: 'project', desiredScopes: [],
      executionScopes: ['project'],
    }), live({ state: 'unobserved' }, {
      extensions: [{ componentKey: 'extensions.instructions:guide', scope: 'user', state: 'present' }],
    })));
    expect(plan.extensionRemovals).toEqual([]);
  });

  it.each([
    ['absent', { state: 'missing' }, 'install'],
    ['outdated', {
      state: 'replaceable', reason: 'outdated', version: '0.9.0', desiredVersion: '1.0.0',
    }, 'replace'],
  ] as const)('plans the expected action for %s shared native evidence', (_label, state, action) => {
    expect(createCodexReconcilePlan(input('install', target(), live(state)))
      .sharedNativeActions[0]?.action).toBe(action);
  });

  it('reuses exact usable shared native without ownership warnings', () => {
    const plan = createCodexReconcilePlan(input(
      'install',
      target(),
      live({ state: 'usable', version: '1.0.0' }),
    ));
    expect(plan.sharedNativeActions[0]?.action).toBe('reuse');
    expect(plan.warnings).toEqual([]);
  });

  it('requires a native ensure action when shared state is unobserved', () => {
    expect(createCodexReconcilePlan(input(
      'install',
      target(),
      live({ state: 'unobserved' }),
    )).sharedNativeActions[0]?.action).toBe('install');
  });

  it('repairs damaged replaceable state and fails closed for unreadable state', () => {
    const damaged = {
      state: 'replaceable', reason: 'damaged', diagnostic: 'manifestMissing',
    } as const;
    expect(createCodexReconcilePlan(input('sync', target(), live(damaged)))
      .sharedNativeActions[0]?.action).toBe('repair');
    expect(() => createCodexReconcilePlan(input('sync', target(), live({
      state: 'blocked', reason: 'unreadable', diagnostic: 'manifestUnreadable',
    }))))
      .toThrowError(CodexReconcilePlanError);
  });

  it('replaces render drift instead of treating it as damaged cache state', () => {
    const plan = createCodexReconcilePlan(input('sync', target(), live({
      state: 'replaceable',
      reason: 'renderDrift',
      version: '1.0.0',
      desiredVersion: '1.0.0',
      diagnostic: 'projectionRenderDrift',
    })));
    expect(plan.sharedNativeActions[0]?.action).toBe('replace');
    expect(plan.review.requiresConfirmation).toBe(true);
  });

  it('restores user=false after project native installation and checks exact plus neutral cwd', () => {
    const plan = createCodexReconcilePlan(input('install', target({ desiredScopes: ['project'] }), live(
      { state: 'missing' },
      { activations: { user: true, project: false } },
    )));
    expect(plan.requirement).toMatchObject({
      minimumVersion: '0.151.0',
      requiresProjectPluginContract: true,
    });
    expect(plan.activationActions.user[0]).toMatchObject({ action: 'disable', desired: false });
    expect(plan.activationActions.project[0]).toMatchObject({ action: 'enable', desired: true });
    expect(plan.postcheck.plugins[0]).toMatchObject({
      expectedUserEnabled: false,
      expectedProjectEnabled: true,
      neutralCwdRequired: true,
    });
  });

  it('allows pure native user and project activation overlap', () => {
    const plan = createCodexReconcilePlan(input('sync', target({
      desiredScopes: ['user', 'project'],
    }), live(
      { state: 'usable', version: '1.0.0' },
      { activations: { user: true, project: true } },
    )));
    expect(plan.activationActions.user[0]?.action).toBe('none');
    expect(plan.activationActions.project[0]?.action).toBe('none');
  });

  it('fails closed when two Catalog owners map to the same native artifact ID', () => {
    const first = target({ pluginId: 'first/demo' });
    const second = target({ pluginId: 'second/demo' });
    expect(() => createCodexReconcilePlan({
      ...input('sync'),
      catalogClosure: [first, second],
      liveEvidence: [live({ state: 'usable', version: '1.0.0' })],
    })).toThrowError(/codexSurfaceOwnerCollision/u);
  });

  it.each(['mixed', 'extension'] as const)(
    'fails closed for %s AW-owned user/project overlap',
    (kind) => {
      expect(() => createCodexReconcilePlan(input('sync', target({
        desiredScopes: ['user', 'project'],
        surface: surface(kind),
      }), live({ state: 'usable', version: '1.0.0' }))))
        .toThrowError(/codexExtensionScopeConflict/u);
    },
  );

  it('keeps healthy AW-owned extension components and removes stale scoped output', () => {
    const plan = createCodexReconcilePlan(input('sync', target({
      surface: surface('mixed'),
      desiredScopes: ['project'],
    }), live(
      { state: 'usable', version: '1.0.0' },
      { extensions: [
        { componentKey: 'extensions.instructions:guide', scope: 'user', state: 'present' },
        { componentKey: 'extensions.instructions:guide', scope: 'project', state: 'present' },
      ] },
    )));
    expect(plan.extensionWrites).toEqual([]);
    expect(plan.extensionRemovals).toEqual([expect.objectContaining({
      componentKey: 'extensions.instructions:guide', scope: 'user', action: 'remove',
    })]);
  });

  it('never removes healthy shared native during uninstall or cleanup', () => {
    const evidence = live(
      { state: 'usable', version: '1.0.0' },
      { activations: { project: true } },
    );
    expect(createCodexReconcilePlan(input('uninstall', target({ desiredScopes: [] }), evidence))
      .sharedNativeActions[0]?.action).toBe('none');
    expect(createCodexReconcilePlan(input('uninstall', target({ desiredScopes: [] }), evidence))
      .managedInventory.desired).toEqual([]);
    expect(createCodexReconcilePlan(input('cleanup', target(), evidence))
      .sharedNativeActions[0]?.action).toBe('reuse');
  });

  it('requires direct authorization for shared replace and forced reinstall', () => {
    const outdated = createCodexReconcilePlan(input('sync', target(), live({
      state: 'replaceable', reason: 'outdated', version: '0.9.0', desiredVersion: '1.0.0',
    })));
    const forced = createCodexReconcilePlan(input('reinstall', target(), live({
      state: 'usable', version: '1.0.0',
    })));
    expect(outdated.review).toMatchObject({ requiresConfirmation: true });
    expect(forced.review).toMatchObject({ requiresConfirmation: true });
  });

  it('uses assumed support only for activation-only project work', () => {
    const plan = createCodexReconcilePlan({
      ...input('sync', target({
        surface: surface('extension'),
        desiredScopes: ['project'],
      }), live({ state: 'missing' })),
      activationSupport: 'assumed',
    });
    expect(plan.sharedNativeActions).toEqual([]);
    expect(plan.postcheck.support).toBe('assumed');
    expect(plan.warnings).toContain('codexProjectActivationAssumed');
  });

  it('produces a stable plan for reordered live extension evidence', () => {
    const catalog = target({ surface: surface('mixed') });
    const first = input('sync', catalog, live(
      { state: 'usable', version: '1.0.0' },
      { extensions: [
        { componentKey: 'extensions.instructions:guide', scope: 'user', state: 'absent' },
        { componentKey: 'extensions.instructions:guide', scope: 'project', state: 'present' },
      ] },
    ));
    const second = structuredClone(first);
    second.liveEvidence[0]!.extensions!.reverse();
    expect(createCodexReconcilePlan(first)).toEqual(createCodexReconcilePlan(second));
  });

  it('attributes a foreign extension to its component without poisoning healthy siblings', () => {
    const catalog = target({ surface: {
      ...surface('mixed'),
      extensionKinds: ['instruction', 'agent'],
      components: [
        ...surface('mixed').components,
        {
          key: 'extensions.agents:worker',
          kind: 'agent',
          owner: 'aw',
          scopes: ['project', 'user'],
          dynamic: false,
          name: 'worker',
        },
      ],
    } });
    expect(() => createCodexReconcilePlan(input('sync', catalog, live(
      { state: 'usable', version: '1.0.0' },
      { extensions: [
        { componentKey: 'extensions.instructions:guide', scope: 'project', state: 'present' },
        { componentKey: 'extensions.agents:worker', scope: 'project', state: 'foreign' },
      ] },
    )))).toThrowError(/extension extensions\.agents:worker is foreign/u);
  });
});
