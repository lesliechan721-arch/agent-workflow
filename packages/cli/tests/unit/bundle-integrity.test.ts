import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { calculatePluginBundleFingerprint } from '../../src/utils/bundle-integrity.js';
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
    await expect(calculatePluginBundleFingerprint(bundleA)).resolves.not.toBe(
      await calculatePluginBundleFingerprint(bundleB),
    );
  });

  it('binds entry type and symlink target bytes', async () => {
    const root = getCurrentSourceTestIsolation().layout.fixtureCwd;
    const fileBundle = path.join(root, 'file-bundle');
    const directoryBundle = path.join(root, 'directory-bundle');
    const linkBundle = path.join(root, 'link-bundle');
    await fs.outputFile(path.join(fileBundle, 'entry'), Buffer.alloc(0));
    await fs.ensureDir(path.join(directoryBundle, 'entry'));
    await fs.ensureDir(linkBundle);
    await fs.symlink('target-a', path.join(linkBundle, 'entry'));

    const fileDigest = await calculatePluginBundleFingerprint(fileBundle);
    expect(fileDigest).not.toBe(await calculatePluginBundleFingerprint(directoryBundle));
    expect(fileDigest).not.toBe(await calculatePluginBundleFingerprint(linkBundle));
  });

  it('does not convert missing roots or readdir failures into an empty bundle', async () => {
    const missing = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'missing');
    await expect(calculatePluginBundleFingerprint(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
