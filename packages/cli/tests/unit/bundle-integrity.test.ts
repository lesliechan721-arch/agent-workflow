import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import {
  calculatePluginBundleFingerprint,
  calculatePluginBundleFingerprintV2,
} from '../../src/utils/bundle-integrity.js';
import {
  calculatePluginBundleFingerprint as calculateThroughLegacyPluginScriptsApi,
} from '../../src/utils/plugin-scripts.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('plugin bundle fingerprint', () => {
  it('uses unambiguous structural framing for NUL-containing file contents', async () => {
    const root = getCurrentSourceTestIsolation().layout.fixtureCwd;
    const bundleA = path.join(root, 'bundle-a');
    const bundleB = path.join(root, 'bundle-b');
    await fs.outputFile(path.join(bundleA, 'a'), Buffer.from('b\0c\0'));
    await fs.outputFile(path.join(bundleB, 'a'), Buffer.from('b'));
    await fs.outputFile(path.join(bundleB, 'c'), Buffer.alloc(0));

    const oldConstructionA = Buffer.concat([
      Buffer.from('a\0'), Buffer.from('b\0c\0'), Buffer.from('\0'),
    ]);
    const oldConstructionB = Buffer.concat([
      Buffer.from('a\0'), Buffer.from('b'), Buffer.from('\0'),
      Buffer.from('c\0'), Buffer.alloc(0), Buffer.from('\0'),
    ]);
    expect(oldConstructionA.equals(oldConstructionB)).toBe(true);
    await expect(calculatePluginBundleFingerprintV2(bundleA)).resolves.not.toBe(
      await calculatePluginBundleFingerprintV2(bundleB),
    );
  });

  it('binds entry type and symlink target bytes and keeps the legacy export compatible', async () => {
    const root = getCurrentSourceTestIsolation().layout.fixtureCwd;
    const fileBundle = path.join(root, 'file-bundle');
    const directoryBundle = path.join(root, 'directory-bundle');
    const linkBundle = path.join(root, 'link-bundle');
    await fs.outputFile(path.join(fileBundle, 'entry'), Buffer.alloc(0));
    await fs.ensureDir(path.join(directoryBundle, 'entry'));
    await fs.ensureDir(linkBundle);
    await fs.symlink('target-a', path.join(linkBundle, 'entry'));

    const fileDigest = await calculatePluginBundleFingerprintV2(fileBundle);
    expect(fileDigest).not.toBe(await calculatePluginBundleFingerprintV2(directoryBundle));
    expect(fileDigest).not.toBe(await calculatePluginBundleFingerprintV2(linkBundle));
    expect(await calculateThroughLegacyPluginScriptsApi(fileBundle)).toBe(
      await calculatePluginBundleFingerprint(fileBundle),
    );
  });

  it('does not convert missing roots or readdir failures into an empty bundle', async () => {
    const missing = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'missing');
    await expect(calculatePluginBundleFingerprintV2(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the legacy fingerprint algorithm at its fixed golden value', async () => {
    const bundle = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'legacy-golden');
    await fs.outputFile(path.join(bundle, 'a'), 'hello');
    await expect(calculatePluginBundleFingerprint(bundle)).resolves.toBe(
      'sha256:b80f9504b9a9b84ac9bec1ad62892f7b49eaa4ef65c5b501d449a027a9a47e18',
    );
  });
});
