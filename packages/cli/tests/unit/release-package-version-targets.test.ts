import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { assertPublicPackageVersions } from '../../../../scripts/release/common.mjs';

const roots: string[] = [];
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

async function createFixture(overrides: {
  rootVersion?: string;
  targetVersion?: string;
  evalVersion?: string;
  cliVersion?: string;
} = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-package-versions-'));
  roots.push(root);
  const rootManifest: Record<string, unknown> = { name: 'agent-workflows', private: true };
  if (overrides.rootVersion !== undefined) rootManifest.version = overrides.rootVersion;
  const targetVersion = overrides.targetVersion ?? '1.0.0';
  await Promise.all([
    fs.mkdir(path.join(root, 'release'), { recursive: true }),
    fs.mkdir(path.join(root, 'packages', 'agent-skill-eval'), { recursive: true }),
    fs.mkdir(path.join(root, 'packages', 'cli'), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(root, 'package.json'), `${JSON.stringify(rootManifest)}\n`),
    fs.writeFile(path.join(root, 'release', 'version-targets.json'), `${JSON.stringify({
      schemaVersion: 1,
      cli: targetVersion,
      catalog: targetVersion,
    })}\n`),
    fs.writeFile(path.join(root, 'packages', 'agent-skill-eval', 'package.json'), `${JSON.stringify({
      name: '@lesliechan721/agent-skill-eval', version: overrides.evalVersion ?? targetVersion,
    })}\n`),
    fs.writeFile(path.join(root, 'packages', 'cli', 'package.json'), `${JSON.stringify({
      name: '@lesliechan721/aw', version: overrides.cliVersion ?? targetVersion,
    })}\n`),
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('public package version target gate', () => {
  it('accepts two lockstep public packages at the stable CLI target', async () => {
    await expect(assertPublicPackageVersions(await createFixture())).resolves.toEqual({
      targetVersion: '1.0.0',
      evalVersion: '1.0.0',
      cliVersion: '1.0.0',
    });
  });

  it('rejects a public package that diverges from the release target', async () => {
    await expect(assertPublicPackageVersions(await createFixture({ cliVersion: '1.0.1' })))
      .rejects.toThrow('release/version-targets.json cli "1.0.0" must match');
  });

  it('rejects a root package version mirror', async () => {
    await expect(assertPublicPackageVersions(await createFixture({ rootVersion: '1.0.0' })))
      .rejects.toThrow('package.json must not declare a version');
  });

  it('retires public beta version-write and direct-publish commands in favor of a release plan', async () => {
    const [makefile, packageRaw, readme] = await Promise.all([
      fs.readFile(path.join(workspaceRoot, 'Makefile'), 'utf8'),
      fs.readFile(path.join(workspaceRoot, 'package.json'), 'utf8'),
      fs.readFile(path.join(workspaceRoot, 'README.md'), 'utf8'),
    ]);
    const scripts = JSON.parse(packageRaw).scripts;
    for (const target of ['version-beta', 'publish-cli-beta', 'publish-catalog-beta', 'beta-release']) {
      expect(makefile).not.toMatch(new RegExp(`^${target}:`, 'mu'));
    }
    for (const script of [
      'version:set:beta',
      'release:publish:cli:beta',
      'release:publish:catalog:beta',
      'release:publish:beta',
    ]) {
      expect(scripts).not.toHaveProperty(script);
    }
    expect(readme).not.toMatch(/make (?:publish-catalog-beta|beta-release)\b/u);
    expect(readme).toContain('pnpm release:prepare -- beta');
    expect(readme).toContain('pnpm release:publish');
  });
});
