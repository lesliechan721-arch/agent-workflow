import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { readPlatformPackageContentDigest } from '../../src/utils/platform-empty-state.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('native package content digest', () => {
  // Test Value Gate: owner metadata is outside content identity; installed runtime and native payload bytes remain bound.
  it('excludes only package ownership metadata while binding runtime config, manifests and Skills', async () => {
    const root = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'native-payload');
    const manifestPath = path.join(root, '.codex-plugin/plugin.json');
    const skillPath = path.join(root, 'skills/demo/SKILL.md');
    const runtimePath = path.join(root, 'skills/demo/.aw-runtime-config.json');
    const ownerPath = path.join(root, '.agent-workflows-owner.json');
    const manifest = { name: 'demo', version: '1.0.0', skills: './skills' };
    await fs.outputJson(manifestPath, manifest);
    await fs.outputFile(skillPath, 'First Skill.\n');
    await fs.outputJson(runtimePath, { applied: 'first' });
    await fs.outputJson(ownerPath, { value: 1 });
    const baseline = await readPlatformPackageContentDigest(root);
    expect(baseline).toMatch(/^sha256:[a-f0-9]{64}$/u);
    await fs.writeJson(ownerPath, { value: 2 });
    expect(await readPlatformPackageContentDigest(root)).toBe(baseline);
    await fs.writeJson(runtimePath, { applied: 'second' });
    expect(await readPlatformPackageContentDigest(root)).not.toBe(baseline);
    await fs.writeJson(runtimePath, { applied: 'first' });
    expect(await readPlatformPackageContentDigest(root)).toBe(baseline);
    await fs.writeJson(manifestPath, { ...manifest, version: '2.0.0' });
    expect(await readPlatformPackageContentDigest(root)).not.toBe(baseline);
    await fs.writeJson(manifestPath, manifest);
    expect(await readPlatformPackageContentDigest(root)).toBe(baseline);
    await fs.writeFile(skillPath, 'Second Skill.\n');
    expect(await readPlatformPackageContentDigest(root)).not.toBe(baseline);
  });
});
