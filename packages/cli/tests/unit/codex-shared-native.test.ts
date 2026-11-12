import { describe, expect, it } from 'vitest';

import type { CodexSharedNativeEvidence } from '../../src/utils/codex-shared-native.js';
import { inspectCodexSharedNative, isCanonicalCodexMarketplaceRegistration } from '../../src/utils/codex-shared-native.js';
import {
  combineCodexNativePluginObservations,
  type CodexNativePluginObservation,
} from '../../src/utils/codex-native-observation.js';

const digest = `sha256:${'a'.repeat(64)}`;

// Ownership must accept Codex's Windows canonical spelling without granting
// an alias to another directory or interpreting verbatim device path syntax.
describe('Codex local marketplace source identity', () => {
  it.each([
    ['C:\\aw\\marketplaces\\team', '\\\\?\\C:\\aw\\marketplaces\\team', true],
    ['c:\\aw\\marketplaces\\team', '\\\\?\\C:\\aw\\marketplaces\\team', true],
    ['C:/aw/marketplaces/team', '\\\\?\\C:\\aw\\marketplaces\\team', true],
    ['\\\\server\\share\\aw\\team', '\\\\?\\UNC\\server\\share\\aw\\team', true],
    ['C:\\aw\\team\\', '\\\\?\\C:\\aw\\team', true],
    ['C:\\aw\\team', '\\\\?\\C:\\aw\\Team', false],
    ['\\\\server\\share\\aw', '\\\\?\\UNC\\Server\\share\\aw', false],
    ['C:\\aw\\team', '\\\\?\\D:\\aw\\team', false],
    ['C:\\aw\\team', '\\\\?\\C:\\foreign\\team', false],
  ])('compares supported Windows directory spellings %s and %s', (expected, source, matches) => {
    expect(isCanonicalCodexMarketplaceRegistration({ name: 'team', source, sourceType: 'local',
      sourcePointsToManifest: false }, expected, 'win32')).toBe(matches);
    expect(isCanonicalCodexMarketplaceRegistration({ name: 'team', source: expected, sourceType: 'local',
      sourcePointsToManifest: false }, source, 'win32')).toBe(matches);
  });

  it.each([
    'relative', 'C:relative', '\\aw\\team', '\\\\server', '\\\\server\\',
    '\\\\?\\C:\\aw\\..\\team', '\\\\?\\C:\\aw\\.\\team', '\\\\?\\C:/aw/team',
    'C:\\aw\\\\team', 'C:\\aw\\team.', 'C:\\aw\\team ', 'C:\\aw\\team:stream',
    'C:\\aw\\NUL', 'C:\\aw\\com1.txt', 'C:\\aw\\LPT².txt', '\\\\.\\C:\\aw\\team',
    '\\??\\C:\\aw\\team', '\\\\?\\GLOBALROOT\\Device\\team', '\\\\?\\Volume{abc}\\team',
    'C:\\aw\\team\u0000suffix',
  ])('rejects an ambiguous Windows path before identical-string comparison: %s', (source) => {
    expect(isCanonicalCodexMarketplaceRegistration({ name: 'team', source, sourceType: 'local',
      sourcePointsToManifest: false }, source, 'win32')).toBe(false);
  });

  it('keeps source type, manifest, absolute-path and POSIX case boundaries', () => {
    const registration = { name: 'team', source: '/aw/team', sourceType: 'local' as const, sourcePointsToManifest: false };
    expect(isCanonicalCodexMarketplaceRegistration(registration, '/aw/team', 'linux')).toBe(true);
    expect(isCanonicalCodexMarketplaceRegistration(registration, '/aw/Team', 'linux')).toBe(false);
    expect(isCanonicalCodexMarketplaceRegistration({ ...registration, source: 'relative' }, 'relative', 'linux')).toBe(false);
    expect(isCanonicalCodexMarketplaceRegistration({ ...registration, sourceType: 'git' }, '/aw/team', 'linux')).toBe(false);
    expect(isCanonicalCodexMarketplaceRegistration({ ...registration, sourcePointsToManifest: true }, '/aw/team', 'linux')).toBe(false);
    expect(isCanonicalCodexMarketplaceRegistration(undefined, '/aw/team', 'linux')).toBe(false);
    expect(isCanonicalCodexMarketplaceRegistration({ ...registration, source: undefined }, '/aw/team', 'linux')).toBe(false);
    expect(isCanonicalCodexMarketplaceRegistration({ ...registration, source: '\\\\?\\C:\\aw\\team' }, '\\\\?\\C:\\aw\\team', 'linux')).toBe(false);
  });
});

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
