import { describe, expect, it } from 'vitest';

import {
  CodexReconcilePlanError,
  createCodexReconcilePlan,
  type CodexReconcilerCatalogTarget,
  type CodexReconcilerInput,
  type CodexReconcilerLiveEvidence,
} from '../../src/utils/codex-reconciler.js';
import type { CodexSharedNativeState } from '../../src/utils/codex-shared-native.js';
import type { CodexSurfaceAnalysis } from '../../src/utils/codex-surface-analysis.js';
import {
  createEmptyPluginIntentState,
} from '../../src/utils/plugin-intent-state.js';

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
  sharedNative: CodexSharedNativeState,
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
  evidence = live({ state: 'absent', nativeAction: 'install' }),
): CodexReconcilerInput {
  return {
    operation,
    scope: catalogTarget.resolvedScope,
    cwd: '/repo',
    intentBefore: createEmptyPluginIntentState(),
    intentAfter: createEmptyPluginIntentState(),
    catalogClosure: [catalogTarget],
    liveEvidence: [evidence],
  };
}

describe('Codex desired-state reconciliation planner', () => {
  it.each([
    ['absent', { state: 'absent', nativeAction: 'install' }, 'install'],
    ['exact unowned', { state: 'claimable', version: '1.0.0', nativeAction: 'none' }, 'claim'],
    ['exact owned', { state: 'present', version: '1.0.0', nativeAction: 'none' }, 'reuse'],
    ['outdated', {
      state: 'outdated', version: '0.9.0', desiredVersion: '1.0.0', nativeAction: 'replace',
    }, 'replace'],
  ] as const)('plans install action for %s shared native evidence', (_label, state, action) => {
    expect(createCodexReconcilePlan(input('install', target(), live(state)))
      .sharedNativeActions[0]?.action).toBe(action);
  });

  it('plans repair only for safely repairable owned residue', () => {
    const corrupt = { state: 'corrupt', diagnostic: 'manifestMissing', nativeAction: 'blocked' } as const;
    expect(createCodexReconcilePlan(input('sync', target(), live(corrupt, {
      repairableSharedNative: true,
    }))).sharedNativeActions[0]?.action).toBe('repair');
    expect(() => createCodexReconcilePlan(input('sync', target(), live(corrupt))))
      .toThrowError(CodexReconcilePlanError);
  });

  it('restores user=false after project native installation and checks exact plus neutral cwd', () => {
    const plan = createCodexReconcilePlan(input('install', target({ desiredScopes: ['project'] }), live(
      { state: 'absent', nativeAction: 'install' },
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
      { state: 'present', version: '1.0.0', nativeAction: 'none' },
      { activations: { user: true, project: true } },
    )));
    expect(plan.activationActions.user[0]?.action).toBe('none');
    expect(plan.activationActions.project[0]?.action).toBe('none');
  });

  it('fails closed when two Catalog owners claim the same native artifact ID', () => {
    const first = target({ pluginId: 'first/demo' });
    const second = target({ pluginId: 'second/demo' });
    expect(() => createCodexReconcilePlan({
      ...input('sync'),
      catalogClosure: [first, second],
      liveEvidence: [live({ state: 'present', version: '1.0.0', nativeAction: 'none' })],
    })).toThrowError(/codexSurfaceOwnerCollision/u);
  });

  it.each(['mixed', 'extension'] as const)(
    'fails closed for %s AW-owned user/project overlap',
    (kind) => {
      expect(() => createCodexReconcilePlan(input('sync', target({
        desiredScopes: ['user', 'project'],
        surface: surface(kind),
      }), live({ state: 'present', version: '1.0.0', nativeAction: 'none' }))))
        .toThrowError(/codexExtensionScopeConflict/u);
    },
  );

  it('keeps healthy AW-owned extension components and removes stale scoped output', () => {
    const plan = createCodexReconcilePlan(input('sync', target({
      surface: surface('mixed'),
      desiredScopes: ['project'],
    }), live(
      { state: 'present', version: '1.0.0', nativeAction: 'none' },
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
      { state: 'present', version: '1.0.0', nativeAction: 'none' },
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
    const outdated = createCodexReconcilePlan(input('upgrade', target(), live({
      state: 'outdated', version: '0.9.0', desiredVersion: '1.0.0', nativeAction: 'replace',
    })));
    const forced = createCodexReconcilePlan(input('reinstall', target(), live({
      state: 'present', version: '1.0.0', nativeAction: 'none',
    })));
    expect(outdated.review).toMatchObject({ requiresConfirmation: true });
    expect(forced.review).toMatchObject({ requiresConfirmation: true });
  });

  it('uses assumed support only for activation-only project work', () => {
    const plan = createCodexReconcilePlan({
      ...input('sync', target({
        surface: surface('extension'),
        desiredScopes: ['project'],
      }), live({ state: 'absent', nativeAction: 'install' })),
      activationSupport: 'assumed',
    });
    expect(plan.sharedNativeActions).toEqual([]);
    expect(plan.postcheck.support).toBe('assumed');
    expect(plan.warnings).toContain('codexProjectActivationAssumed');
  });

  it('produces a stable plan for reordered live extension evidence', () => {
    const catalog = target({ surface: surface('mixed') });
    const first = input('sync', catalog, live(
      { state: 'present', version: '1.0.0', nativeAction: 'none' },
      { extensions: [
        { componentKey: 'extensions.instructions:guide', scope: 'user', state: 'absent' },
        { componentKey: 'extensions.instructions:guide', scope: 'project', state: 'present' },
      ] },
    ));
    const second = structuredClone(first);
    second.liveEvidence[0]!.extensions!.reverse();
    expect(createCodexReconcilePlan(first)).toEqual(createCodexReconcilePlan(second));
  });
});
