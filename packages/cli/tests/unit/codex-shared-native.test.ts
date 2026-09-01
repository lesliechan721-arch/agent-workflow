import { describe, expect, it } from 'vitest';

import type { CodexSharedNativeEvidence } from '../../src/utils/codex-shared-native.js';
import { inspectCodexSharedNative } from '../../src/utils/codex-shared-native.js';

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
    pluginListEntries: [{
      pluginId: 'demo@aw-team',
      version: '2.0.0',
      enabled: true,
    }],
    manifest: {
      state: 'present',
      identity: 'demo',
      version: '2.0.0',
      payloadDigest: digest,
      payloadPath: '/codex/plugins/cache/aw-team/demo/2.0.0',
      pathSafe: true,
    },
    managedByCurrentIntent: true,
    ...overrides,
  };
}

describe('codex-shared-native', () => {
  it('classifies the six live native states without adding a scope identity', () => {
    const cases = [
      [
        evidence({
          marketplaceRegistration: undefined,
          pluginListEntries: [],
          manifest: { state: 'absent' },
          managedByCurrentIntent: false,
        }),
        { state: 'absent', nativeAction: 'install' },
      ],
      [
        evidence({ managedByCurrentIntent: false }),
        { state: 'claimable', version: '2.0.0', nativeAction: 'none' },
      ],
      [
        evidence(),
        { state: 'present', version: '2.0.0', nativeAction: 'none' },
      ],
      [
        evidence({
          pluginListEntries: [{ pluginId: 'demo@aw-team', version: '1.0.0', enabled: true }],
          manifest: {
            state: 'present',
            identity: 'demo',
            version: '1.0.0',
            payloadDigest: `sha256:${'b'.repeat(64)}`,
            payloadPath: '/codex/plugins/cache/aw-team/demo/1.0.0',
            pathSafe: true,
          },
        }),
        {
          state: 'outdated',
          version: '1.0.0',
          desiredVersion: '2.0.0',
          nativeAction: 'replace',
        },
      ],
      [
        evidence({
          manifest: {
            state: 'present',
            identity: 'demo',
            version: '2.0.0',
            payloadDigest: `sha256:${'b'.repeat(64)}`,
            payloadPath: '/codex/plugins/cache/aw-team/demo/2.0.0',
            pathSafe: true,
          },
        }),
        { state: 'corrupt', diagnostic: 'payloadDigestMismatch', nativeAction: 'blocked' },
      ],
      [
        evidence({
          marketplaceRegistration: {
            name: 'aw-team',
            source: '/foreign/marketplace',
            sourceType: 'local',
            sourcePointsToManifest: false,
          },
        }),
        {
          state: 'foreign',
          diagnostic: 'marketplaceRegistrationForeign',
          nativeAction: 'blocked',
        },
      ],
    ] as const;

    for (const [input, expected] of cases) {
      const result = inspectCodexSharedNative(input);
      expect(result).toEqual(expected);
      expect(result).not.toHaveProperty('scope');
    }
  });

  it('classifies an exact canonical existing plugin as a zero-write claim', () => {
    expect(inspectCodexSharedNative(evidence({ managedByCurrentIntent: false }))).toEqual({
      state: 'claimable',
      version: '2.0.0',
      nativeAction: 'none',
    });
  });

  it('fails closed for unsafe registered payload paths without colliding namespaced peers', () => {
    expect(inspectCodexSharedNative(evidence({
      manifest: {
        state: 'present',
        identity: 'demo',
        version: '2.0.0',
        payloadDigest: digest,
        payloadPath: '/foreign/demo',
        pathSafe: false,
      },
    }))).toMatchObject({ state: 'foreign', diagnostic: 'payloadPathUnsafe' });

    expect(inspectCodexSharedNative(evidence({
      pluginListEntries: [{ pluginId: 'demo@foreign', version: '2.0.0', enabled: true }],
    }))).toMatchObject({ state: 'absent', diagnostic: 'staleCacheObserved' });
  });

  it('requires exact plugin-list, manifest identity, version, and digest evidence', () => {
    expect(inspectCodexSharedNative(evidence({ pluginListEntries: null })))
      .toMatchObject({ state: 'corrupt', diagnostic: 'pluginListUnavailable' });
    expect(inspectCodexSharedNative(evidence({ manifest: { state: 'absent' } })))
      .toMatchObject({ state: 'corrupt', diagnostic: 'manifestMissing' });
    expect(inspectCodexSharedNative(evidence({
      manifest: {
        state: 'present',
        identity: 'foreign-demo',
        version: '2.0.0',
        payloadDigest: digest,
        payloadPath: '/codex/plugins/cache/aw-team/demo/2.0.0',
        pathSafe: true,
      },
    }))).toMatchObject({ state: 'foreign', diagnostic: 'manifestIdentityMismatch' });
  });

  it('treats cache as secondary evidence behind the official plugin list', () => {
    expect(inspectCodexSharedNative(evidence({
      marketplaceRegistration: undefined,
      pluginListEntries: [],
      manifest: { state: 'absent' },
      managedByCurrentIntent: false,
    }))).toEqual({ state: 'absent', nativeAction: 'install' });
    expect(inspectCodexSharedNative(evidence({
      pluginListEntries: [],
      managedByCurrentIntent: false,
    }))).toEqual({
      state: 'absent',
      nativeAction: 'install',
      diagnostic: 'staleCacheObserved',
    });
    expect(inspectCodexSharedNative(evidence({
      pluginListEntries: [{
        pluginId: 'demo@aw-team', version: '1.0.0', enabled: true,
      }],
    }))).toEqual({
      state: 'outdated',
      version: '1.0.0',
      desiredVersion: '2.0.0',
      nativeAction: 'replace',
    });
  });
});
