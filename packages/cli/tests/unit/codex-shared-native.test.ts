import { describe, expect, it } from 'vitest';

import type { CodexSharedNativeEvidence } from '../../src/utils/codex-shared-native.js';
import { inspectCodexSharedNative } from '../../src/utils/codex-shared-native.js';
import {
  combineCodexNativePluginObservations,
  type CodexNativePluginObservation,
} from '../../src/utils/codex-native-observation.js';

const digest = `sha256:${'a'.repeat(64)}`;

function evidence(
  overrides: Partial<CodexSharedNativeEvidence> = {},
): CodexSharedNativeEvidence {
  return {
    pluginName: 'demo',
    pluginId: 'demo@aw-team',
    marketplaceName: 'aw-team',
    canonicalMarketplaceRoot: '/aw/marketplaces/aw-team',
    desiredVersion: '2.0.0',
    expectedPayloadDigest: digest,
    marketplaceRegistration: {
      name: 'aw-team',
      source: '/aw/marketplaces/aw-team',
      sourceType: 'local',
      sourcePointsToManifest: false,
    },
    marketplacePathSafe: true,
    observation: {
      state: 'observed',
      value: 'installed',
      entry: { pluginId: 'demo@aw-team', version: '2.0.0', enabled: true },
    },
    ...overrides,
  };
}

describe('codex-shared-native', () => {
  it.each([
    [
      [{ state: 'unobserved' }, { state: 'observed', value: 'absent' }],
      { state: 'unobserved' },
    ],
    [
      [{ state: 'observed', value: 'absent' }, { state: 'unobserved' }],
      { state: 'unobserved' },
    ],
    [
      [
        { state: 'unobserved' },
        {
          state: 'observed', value: 'installed',
          entry: { pluginId: 'demo@aw-team', enabled: true },
        },
      ],
      {
        state: 'observed', value: 'installed',
        entry: { pluginId: 'demo@aw-team', enabled: true },
      },
    ],
    [
      [
        {
          state: 'observed', value: 'installed',
          entry: { pluginId: 'demo@aw-team', enabled: true },
        },
        { state: 'observed', value: 'absent' },
      ],
      {
        state: 'observed', value: 'installed',
        entry: { pluginId: 'demo@aw-team', enabled: true },
      },
    ],
  ] satisfies Array<[CodexNativePluginObservation[], CodexNativePluginObservation]>) (
    'merges exact and neutral native observations without treating unknown evidence as absence',
    (observations, expected) => {
      expect(combineCodexNativePluginObservations(observations)).toEqual(expected);
    },
  );

  it('uses the official snapshot as the only installed and version evidence', () => {
    expect(inspectCodexSharedNative(evidence())).toEqual({ state: 'usable', version: '2.0.0' });
    expect(inspectCodexSharedNative(evidence({
      observation: {
        state: 'observed', value: 'installed',
        entry: { pluginId: 'demo@aw-team', enabled: true },
      },
    }))).toEqual({ state: 'usable' });
    expect(inspectCodexSharedNative(evidence({
      observation: {
        state: 'observed', value: 'installed',
        entry: { pluginId: 'demo@aw-team', version: '1.0.0', enabled: true },
      },
    }))).toEqual({
      state: 'replaceable',
      reason: 'outdated',
      version: '1.0.0',
      desiredVersion: '2.0.0',
    });
  });

  it('reports official absence as missing', () => {
    expect(inspectCodexSharedNative(evidence({
      observation: { state: 'observed', value: 'absent' },
    }))).toEqual({ state: 'missing' });
  });

  it('uses AW-owned source projection evidence for sync drift', () => {
    expect(inspectCodexSharedNative(evidence({ sourceProjection: 'drifted' }))).toEqual({
      state: 'replaceable',
      reason: 'renderDrift',
      version: '2.0.0',
      desiredVersion: '2.0.0',
      diagnostic: 'projectionRenderDrift',
    });
  });

  it.each([
    ['damaged', 'projectionReceiptMissing', {
      state: 'replaceable', reason: 'damaged', version: '2.0.0', desiredVersion: '2.0.0',
      diagnostic: 'projectionReceiptMissing',
    }],
    ['foreign', 'projectionReceiptIdentityMismatch', {
      state: 'blocked', reason: 'foreign', diagnostic: 'projectionReceiptIdentityMismatch',
    }],
    ['unreadable', 'projectionReceiptUnreadable', {
      state: 'blocked', reason: 'unreadable', diagnostic: 'projectionReceiptUnreadable',
    }],
  ] as const)('classifies a %s projection evidence issue without claiming render drift', (
    reason,
    diagnostic,
    expected,
  ) => {
    expect(inspectCodexSharedNative(evidence({
      sourceProjectionIssue: { reason, diagnostic },
    }))).toEqual(expected);
  });

  it('keeps an old installed version ahead of damaged projection evidence', () => {
    expect(inspectCodexSharedNative(evidence({
      observation: {
        state: 'observed', value: 'installed',
        entry: { pluginId: 'demo@aw-team', version: '1.0.0', enabled: true },
      },
      sourceProjectionIssue: {
        reason: 'damaged', diagnostic: 'projectionReceiptMissing',
      },
    }))).toEqual({
      state: 'replaceable',
      reason: 'outdated',
      version: '1.0.0',
      desiredVersion: '2.0.0',
    });
  });

  it('does not let an old installed version hide foreign projection evidence', () => {
    expect(inspectCodexSharedNative(evidence({
      observation: {
        state: 'observed', value: 'installed',
        entry: { pluginId: 'demo@aw-team', version: '1.0.0', enabled: true },
      },
      sourceProjectionIssue: {
        reason: 'foreign', diagnostic: 'projectionReceiptIdentityMismatch',
      },
    }))).toEqual({
      state: 'blocked',
      reason: 'foreign',
      diagnostic: 'projectionReceiptIdentityMismatch',
    });
  });

  it('fails closed for foreign public marketplace config and unavailable official evidence', () => {
    expect(inspectCodexSharedNative(evidence({
      marketplaceRegistration: {
        name: 'aw-team',
        source: '/foreign/marketplace',
        sourceType: 'local',
        sourcePointsToManifest: false,
      },
    }))).toEqual({
      state: 'blocked',
      reason: 'foreign',
      diagnostic: 'marketplaceRegistrationForeign',
    });
    expect(inspectCodexSharedNative(evidence({
      observation: { state: 'failed', reason: 'unavailable' },
    }))).toEqual({
      state: 'blocked',
      reason: 'unreadable',
      diagnostic: 'pluginListUnavailable',
    });
  });

  it('keeps unobserved distinct from official absence', () => {
    expect(inspectCodexSharedNative(evidence({
      observation: { state: 'unobserved' },
    }))).toEqual({ state: 'unobserved' });
  });

  it.each([
    { state: 'observed', value: 'absent' } as const,
    { state: 'unobserved' } as const,
  ])('blocks an unsafe AW marketplace root before projecting $state evidence', (observation) => {
    expect(inspectCodexSharedNative(evidence({
      marketplacePathSafe: false,
      observation,
    }))).toEqual({
      state: 'blocked',
      reason: 'foreign',
      diagnostic: 'marketplacePathUnsafe',
    });
  });
});
