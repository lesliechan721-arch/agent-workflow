import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolvePublishedCliVersion,
  resolveRegistryUrl,
} from '../../../../scripts/release/common.mjs';

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

  it.each([
    { mode: 'beta' as const, version: '2.0.0-beta.3' },
    { mode: 'latest' as const, version: '2.0.0+published-build' },
  ])('resolves the current published $mode version from the configured registry', async ({
    mode,
    version,
  }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-registry-'));
    tempRoots.push(root);
    const packageJsonPath = path.join(root, 'package.json');
    await fs.writeFile(packageJsonPath, JSON.stringify({
      publishConfig: { registry: 'https://registry.example.test/team' },
    }));
    const captureCommand = vi.fn(async () => ({ stdout: `${JSON.stringify(version)}\n`, stderr: '' }));

    await expect(resolvePublishedCliVersion(mode, {
      packageJsonPath,
      env: {},
      captureCommand,
    })).resolves.toBe(version);
    expect(captureCommand).toHaveBeenCalledWith('pnpm', [
      'view',
      '@lesliechan721/aw',
      `dist-tags.${mode}`,
      '--json',
      '--registry',
      'https://registry.example.test/team/',
    ], expect.any(Object));
  });

  it.each([
    { name: 'a missing dist-tag', stdout: 'null', message: 'did not return' },
    { name: 'invalid JSON', stdout: 'not-json', message: 'invalid JSON' },
    { name: 'a non-strict version', stdout: '"01.0.0"', message: 'Invalid version' },
    { name: 'a stable beta version', stdout: '"1.0.0"', message: 'Expected a prerelease version' },
  ])('fails closed for $name', async ({ stdout, message }) => {
    const captureCommand = vi.fn(async () => ({ stdout, stderr: '' }));
    await expect(resolvePublishedCliVersion('beta', {
      env: {},
      captureCommand,
    })).rejects.toThrow(message);
  });

  it('propagates registry lookup errors', async () => {
    const captureCommand = vi.fn(async () => {
      throw new Error('registry unavailable');
    });
    await expect(resolvePublishedCliVersion('latest', {
      env: {},
      captureCommand,
    })).rejects.toThrow('registry unavailable');
  });
});
