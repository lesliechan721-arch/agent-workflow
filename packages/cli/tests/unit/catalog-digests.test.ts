import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  calculateCodexNativeRenderPayloadDigest,
  calculateCodexSharedNativePayloadDigest,
} from '../../src/utils/catalog-digests.js';
import { CODEX_NATIVE_RENDER_RECEIPT_PATH } from '../../src/utils/codex-native-render-receipt.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('Codex shared native payload digest', () => {
  it('excludes AW metadata but binds Skill and other payload bytes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-payload-'));
    roots.push(root);
    await fs.outputJson(path.join(root, '.codex-plugin', 'plugin.json'), {
      name: 'demo', version: '1.0.0', skills: ['./skills/demo'], description: 'demo',
    });
    await fs.outputFile(path.join(root, 'skills', 'demo', 'SKILL.md'), 'first\n');
    await fs.outputFile(path.join(root, 'payload.txt'), 'payload\n');
    await fs.outputJson(path.join(root, '.agent-workflows-owner.json'), { value: 1 });
    await fs.outputJson(path.join(root, CODEX_NATIVE_RENDER_RECEIPT_PATH), { value: 1 });
    const baseline = await calculateCodexSharedNativePayloadDigest(root);
    const dynamicBaseline = await calculateCodexNativeRenderPayloadDigest(root);

    await fs.outputJson(path.join(root, '.agent-workflows-owner.json'), { value: 2 });
    await fs.outputJson(path.join(root, CODEX_NATIVE_RENDER_RECEIPT_PATH), { value: 2 });
    expect(await calculateCodexSharedNativePayloadDigest(root)).toBe(baseline);
    expect(await calculateCodexNativeRenderPayloadDigest(root)).toBe(dynamicBaseline);

    await fs.outputJson(path.join(root, '.codex-plugin', 'plugin.json'), {
      name: 'demo', version: '2.0.0', skills: ['./other'], description: 'demo',
    });
    expect(await calculateCodexSharedNativePayloadDigest(root)).toBe(baseline);
    expect(await calculateCodexNativeRenderPayloadDigest(root)).not.toBe(dynamicBaseline);

    await fs.outputJson(path.join(root, '.codex-plugin', 'plugin.json'), {
      name: 'demo', version: '3.0.0', skills: ['./skills/demo'], description: 'demo',
    });
    expect(await calculateCodexNativeRenderPayloadDigest(root)).toBe(dynamicBaseline);

    await fs.outputFile(path.join(root, 'skills', 'demo', 'SKILL.md'), 'second\n');
    expect(await calculateCodexSharedNativePayloadDigest(root)).not.toBe(baseline);
    expect(await calculateCodexNativeRenderPayloadDigest(root)).not.toBe(dynamicBaseline);
  });
});
