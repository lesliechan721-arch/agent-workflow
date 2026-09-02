import { describe, expect, it } from 'vitest';

import {
  CODEX_NATIVE_RENDER_RECEIPT_PATH,
  createCodexNativeRenderProjection,
  createCodexNativeRenderReceipt,
  parseCodexNativeRenderReceipt,
  serializeCodexNativeRenderReceipt,
} from '../../src/utils/codex-native-render-receipt.js';

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function input() {
  return {
    logicalPluginId: 'official/demo',
    sourceIdentity: digest('a'),
    pluginVersion: '1.2.3',
    rendererDigest: digest('b'),
    targets: [
      { id: 'z-target', skillKey: 'z-skill', configDigest: digest('c'), artifactDigest: digest('d') },
      { id: 'a.target', skillKey: 'a_skill', configDigest: digest('e'), artifactDigest: digest('f') },
    ],
  };
}

describe('Codex native render receipt', () => {
  it('round-trips the exact schema and normalizes target order', () => {
    const receipt = createCodexNativeRenderReceipt({ ...input(), payloadDigest: digest('0') });
    expect(CODEX_NATIVE_RENDER_RECEIPT_PATH).toBe('.agents-plugin/aw-codex-native-render.json');
    expect(receipt.targets.map((target) => target.id)).toEqual(['a.target', 'z-target']);
    expect(parseCodexNativeRenderReceipt(serializeCodexNativeRenderReceipt(receipt))).toEqual(receipt);

    const reordered = createCodexNativeRenderProjection({
      ...input(),
      targets: [...input().targets].reverse(),
    });
    expect(reordered).toEqual(createCodexNativeRenderProjection(input()));
    const changedRenderer = createCodexNativeRenderProjection({
      ...input(), rendererDigest: digest('9'),
    });
    expect(changedRenderer.renderInputDigest).not.toBe(receipt.renderInputDigest);
  });

  it('rejects unknown, missing, malformed, unbound, and duplicate target fields', () => {
    const receipt = createCodexNativeRenderReceipt({ ...input(), payloadDigest: digest('0') });
    expect(() => parseCodexNativeRenderReceipt({ ...receipt, extra: true })).toThrow(/exactly/u);
    const { kind: _kind, ...missing } = receipt;
    expect(() => parseCodexNativeRenderReceipt(missing)).toThrow(/exactly/u);
    expect(() => parseCodexNativeRenderReceipt({ ...receipt, pluginVersion: '1.2' }))
      .toThrow(/strict SemVer/u);
    expect(() => parseCodexNativeRenderReceipt({ ...receipt, payloadDigest: 'SHA256:nope' }))
      .toThrow(/SHA-256/u);
    expect(() => parseCodexNativeRenderReceipt({ ...receipt, configDigest: digest('9') }))
      .toThrow(/configDigest binding/u);
    expect(() => parseCodexNativeRenderReceipt({ ...receipt, rendererDigest: digest('9') }))
      .toThrow(/renderInputDigest binding/u);
    expect(() => createCodexNativeRenderReceipt({
      ...input(),
      targets: [input().targets[0]!, { ...input().targets[1]!, id: 'z-target' }],
      payloadDigest: digest('0'),
    })).toThrow(/duplicate target id/u);
    expect(() => createCodexNativeRenderReceipt({
      ...input(),
      targets: [input().targets[0]!, { ...input().targets[1]!, skillKey: 'z-skill' }],
      payloadDigest: digest('0'),
    })).toThrow(/duplicate target skillKey/u);
    expect(() => createCodexNativeRenderReceipt({
      ...input(), targets: [], payloadDigest: digest('0'),
    })).toThrow(/non-empty array/u);
  });
});
