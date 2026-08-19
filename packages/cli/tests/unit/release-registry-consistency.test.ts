import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveRegistryUrl } from '../../../../scripts/release/common.mjs';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('CLI release registry URL', () => {
  it('uses the explicit environment registry before package publishConfig', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-registry-'));
    tempRoots.push(root);
    const packageJsonPath = path.join(root, 'package.json');
    await fs.writeFile(packageJsonPath, JSON.stringify({
      publishConfig: { registry: 'https://package.example.test' },
    }));

    await expect(resolveRegistryUrl(packageJsonPath, {
      AW_NPM_REGISTRY_URL: ' https://env.example.test/team ',
    })).resolves.toBe('https://env.example.test/team/');
  });

  it('normalizes package publishConfig and keeps the npmjs default', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-registry-'));
    tempRoots.push(root);
    const configured = path.join(root, 'configured.json');
    const fallback = path.join(root, 'fallback.json');
    await Promise.all([
      fs.writeFile(configured, JSON.stringify({
        publishConfig: { registry: ' https://package.example.test/team ' },
      })),
      fs.writeFile(fallback, '{}'),
    ]);

    await expect(resolveRegistryUrl(configured, {})).resolves.toBe('https://package.example.test/team/');
    await expect(resolveRegistryUrl(fallback, {})).resolves.toBe('https://registry.npmjs.org/');
  });
});
