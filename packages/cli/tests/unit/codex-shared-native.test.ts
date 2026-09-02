import { describe, expect, it } from 'vitest';

import type { CodexSharedNativeEvidence } from '../../src/utils/codex-shared-native.js';
import { inspectCodexSharedNative } from '../../src/utils/codex-shared-native.js';
import {
  createCodexNativeRenderProjection,
  createCodexNativeRenderReceipt,
  type CodexNativeRenderTargetReceipt,
} from '../../src/utils/codex-native-render-receipt.js';

const digest = `sha256:${'a'.repeat(64)}`;
const otherDigest = (character: string): string => `sha256:${character.repeat(64)}`;

const projectionTargets: CodexNativeRenderTargetReceipt[] = [{
  id: 'demo-target',
  skillKey: 'demo-skill',
  configDigest: otherDigest('b'),
  artifactDigest: otherDigest('c'),
}];

function projectionInput() {
  return {
    logicalPluginId: 'official/demo',
    sourceIdentity: otherDigest('d'),
    pluginVersion: '2.0.0',
    rendererDigest: otherDigest('e'),
    targets: projectionTargets,
  };
}

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
    ...overrides,
  };
}

describe('codex-shared-native', () => {
  it('uses only the four shared-native states and keeps detail beside the state', () => {
    const cases = [
      [
        evidence({
          marketplaceRegistration: undefined,
          pluginListEntries: [],
          manifest: { state: 'absent' },
        }),
        { state: 'missing' },
      ],
      [
        evidence(),
        { state: 'usable', version: '2.0.0' },
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
          state: 'replaceable',
          reason: 'outdated',
          version: '1.0.0',
          desiredVersion: '2.0.0',
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
        { state: 'replaceable', reason: 'damaged', diagnostic: 'payloadDigestMismatch' },
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
          state: 'blocked',
          reason: 'foreign',
          diagnostic: 'marketplaceRegistrationForeign',
        },
      ],
    ] as const;

    for (const [input, expected] of cases) {
      const result = inspectCodexSharedNative(input);
      expect(result).toEqual(expected);
      expect(result).not.toHaveProperty('scope');
    }
  });

  it('classifies an exact canonical existing plugin as reusable shared native', () => {
    expect(inspectCodexSharedNative(evidence())).toEqual({
      state: 'usable',
      version: '2.0.0',
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
    }))).toMatchObject({ state: 'blocked', reason: 'foreign', diagnostic: 'payloadPathUnsafe' });

    expect(inspectCodexSharedNative(evidence({
      pluginListEntries: [{ pluginId: 'demo@foreign', version: '2.0.0', enabled: true }],
    }))).toMatchObject({ state: 'missing', staleCacheObserved: true });
  });

  it('requires exact plugin-list, manifest identity, version, and digest evidence', () => {
    expect(inspectCodexSharedNative(evidence({ pluginListEntries: null })))
      .toMatchObject({ state: 'blocked', reason: 'unreadable', diagnostic: 'pluginListUnavailable' });
    expect(inspectCodexSharedNative(evidence({ manifest: { state: 'absent' } })))
      .toMatchObject({ state: 'replaceable', reason: 'damaged', diagnostic: 'manifestMissing' });
    expect(inspectCodexSharedNative(evidence({
      manifest: {
        state: 'present',
        identity: 'foreign-demo',
        version: '2.0.0',
        payloadDigest: digest,
        payloadPath: '/codex/plugins/cache/aw-team/demo/2.0.0',
        pathSafe: true,
      },
    }))).toMatchObject({ state: 'blocked', reason: 'foreign', diagnostic: 'manifestIdentityMismatch' });
  });

  it('treats cache as secondary evidence behind the official plugin list', () => {
    expect(inspectCodexSharedNative(evidence({
      marketplaceRegistration: undefined,
      pluginListEntries: [],
      manifest: { state: 'absent' },
    }))).toEqual({ state: 'missing' });
    expect(inspectCodexSharedNative(evidence({
      pluginListEntries: [],
    }))).toEqual({
      state: 'missing',
      staleCacheObserved: true,
    });
    expect(inspectCodexSharedNative(evidence({
      pluginListEntries: [{
        pluginId: 'demo@aw-team', version: '1.0.0', enabled: true,
      }],
    }))).toEqual({
      state: 'replaceable',
      reason: 'outdated',
      version: '1.0.0',
      desiredVersion: '2.0.0',
    });
  });

  it('uses a matching projection receipt without changing static native behavior', () => {
    const expectedProjection = createCodexNativeRenderProjection(projectionInput());
    const receipt = createCodexNativeRenderReceipt({ ...projectionInput(), payloadDigest: digest });
    expect(inspectCodexSharedNative(evidence({
      expectedProjection,
      projectionReceipt: { state: 'present', receipt },
    }))).toEqual({ state: 'usable', version: '2.0.0' });
    expect(inspectCodexSharedNative(evidence())).toEqual({ state: 'usable', version: '2.0.0' });
  });

  it.each([
    ['source', { ...projectionInput(), sourceIdentity: otherDigest('f') }],
    ['renderer', { ...projectionInput(), rendererDigest: otherDigest('f') }],
    ['config', {
      ...projectionInput(),
      targets: [{ ...projectionTargets[0]!, configDigest: otherDigest('f') }],
    }],
    ['target', {
      ...projectionInput(),
      targets: [{ ...projectionTargets[0]!, id: 'changed-target' }],
    }],
  ] as const)('classifies %s projection changes as render drift', (_label, changedInput) => {
    const receipt = createCodexNativeRenderReceipt({ ...projectionInput(), payloadDigest: digest });
    expect(inspectCodexSharedNative(evidence({
      expectedProjection: createCodexNativeRenderProjection(changedInput),
      projectionReceipt: { state: 'present', receipt },
    }))).toMatchObject({
      state: 'replaceable', reason: 'renderDrift', diagnostic: 'projectionRenderDrift',
    });
  });

  it('classifies direct render-input drift as replaceable render drift', () => {
    const receipt = createCodexNativeRenderReceipt({ ...projectionInput(), payloadDigest: digest });
    const expectedProjection = {
      ...createCodexNativeRenderProjection(projectionInput()),
      renderInputDigest: otherDigest('f'),
    };
    expect(inspectCodexSharedNative(evidence({
      expectedProjection,
      projectionReceipt: { state: 'present', receipt },
    }))).toMatchObject({ state: 'replaceable', reason: 'renderDrift' });
  });

  it('fails closed for missing, unreadable, tampered, and foreign projection evidence', () => {
    const expectedProjection = createCodexNativeRenderProjection(projectionInput());
    const receipt = createCodexNativeRenderReceipt({ ...projectionInput(), payloadDigest: digest });
    expect(inspectCodexSharedNative(evidence({
      expectedProjection,
      projectionReceipt: { state: 'absent' },
    }))).toMatchObject({
      state: 'replaceable', reason: 'damaged', diagnostic: 'projectionReceiptMissing',
    });
    expect(inspectCodexSharedNative(evidence({
      expectedProjection,
      projectionReceipt: { state: 'unreadable' },
    }))).toMatchObject({
      state: 'blocked', reason: 'unreadable', diagnostic: 'projectionReceiptUnreadable',
    });
    expect(inspectCodexSharedNative(evidence({
      expectedProjection,
      expectedPayloadDigest: undefined,
      projectionReceipt: { state: 'present', receipt },
    }))).toMatchObject({
      state: 'replaceable',
      reason: 'damaged',
      diagnostic: 'projectionExpectedPayloadDigestMissing',
    });
    expect(inspectCodexSharedNative(evidence({
      expectedProjection,
      manifest: {
        state: 'present',
        identity: 'demo',
        version: '2.0.0',
        payloadDigest: otherDigest('f'),
        payloadPath: '/codex/plugins/cache/aw-team/demo/2.0.0',
        pathSafe: true,
      },
      projectionReceipt: { state: 'present', receipt },
    }))).toMatchObject({
      state: 'replaceable', reason: 'damaged', diagnostic: 'projectionPayloadDigestMismatch',
    });
    const rewrittenReceipt = createCodexNativeRenderReceipt({
      ...projectionInput(), payloadDigest: otherDigest('f'),
    });
    expect(inspectCodexSharedNative(evidence({
      expectedProjection,
      manifest: {
        state: 'present',
        identity: 'demo',
        version: '2.0.0',
        payloadDigest: otherDigest('f'),
        payloadPath: '/codex/plugins/cache/aw-team/demo/2.0.0',
        pathSafe: true,
      },
      projectionReceipt: { state: 'present', receipt: rewrittenReceipt },
    }))).toMatchObject({
      state: 'replaceable', reason: 'damaged', diagnostic: 'projectionPayloadDigestMismatch',
    });
    const foreignReceipt = createCodexNativeRenderReceipt({
      ...projectionInput(), logicalPluginId: 'official/foreign', payloadDigest: digest,
    });
    expect(inspectCodexSharedNative(evidence({
      expectedProjection,
      projectionReceipt: { state: 'present', receipt: foreignReceipt },
    }))).toMatchObject({
      state: 'blocked', reason: 'foreign', diagnostic: 'projectionReceiptIdentityMismatch',
    });
  });
});
