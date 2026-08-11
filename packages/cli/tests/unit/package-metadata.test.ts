import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { parseArgs as parsePackCliArgs } from '../../../../scripts/release/pack-cli.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

async function readPackageJson(relativePath: string): Promise<Record<string, unknown>> {
  return fs.readJson(path.join(repoRoot, relativePath));
}

describe('package metadata', () => {
  it('pins the workspace package manager version', async () => {
    const rootPackageJson = await readPackageJson('package.json');

    expect(rootPackageJson).toMatchObject({
      packageManager: 'pnpm@10.33.0',
    });
  });

  it('declares Node.js >=20 for the published CLI package and the workspace root', async () => {
    const [rootPackageJson, cliPackageJson] = await Promise.all([
      readPackageJson('package.json'),
      readPackageJson('packages/cli/package.json'),
    ]);

    expect(rootPackageJson).toMatchObject({
      engines: {
        node: '>=20',
      },
    });
    expect(cliPackageJson).toMatchObject({
      engines: {
        node: '>=20',
      },
    });
  });

  it('keeps the formal test gates on the bounded default Vitest pool', async () => {
    const [rootPackageJson, cliPackageJson, vitestConfig] = await Promise.all([
      readPackageJson('package.json'),
      readPackageJson('packages/cli/package.json'),
      fs.readFile(path.join(repoRoot, 'packages', 'cli', 'vitest.config.ts'), 'utf8'),
    ]);
    const rootScripts = rootPackageJson.scripts as Record<string, string>;
    const cliScripts = cliPackageJson.scripts as Record<string, string>;

    expect(rootScripts.test).toBe('pnpm --filter @lesliechan721/aw test');
    expect(rootScripts['test:unit']).toBe('pnpm --filter @lesliechan721/aw test:unit');
    expect(rootScripts['release:verify:cli']).toMatch(
      /^pnpm test && pnpm test:perf:gate &&/,
    );
    expect(cliScripts.test).toBe('vitest run');
    expect(cliScripts['test:unit']).toBe('vitest run tests/unit');
    expect(vitestConfig).toContain('maxWorkers: 3');
    expect(vitestConfig).not.toContain('minWorkers');
    expect(vitestConfig).toContain('testTimeout: 15_000');
    expect(vitestConfig).toContain('hookTimeout: 15_000');
  });

  it('routes reusable build and release entry points through build:ensure', async () => {
    const [rootPackageJson, cliPackageJson, packCatalogSource, packReleaseSource] = await Promise.all([
      readPackageJson('package.json'),
      readPackageJson('packages/cli/package.json'),
      fs.readFile(path.join(repoRoot, 'scripts', 'release', 'pack-catalog.mjs'), 'utf8'),
      fs.readFile(path.join(repoRoot, 'scripts', 'release', 'pack-release.mjs'), 'utf8'),
    ]);
    const rootScripts = rootPackageJson.scripts as Record<string, string>;
    const cliScripts = cliPackageJson.scripts as Record<string, string>;

    expect(rootScripts.build).toBe('node scripts/build/run-build.mjs');
    expect(rootScripts['build:ensure']).toBe('node scripts/build/ensure-build.mjs');
    expect(rootScripts['pack:cli']).toBe('node scripts/release/pack-cli.mjs');
    expect(rootScripts['release:pack:cli']).toBe(rootScripts['pack:cli']);
    expect(rootScripts['release:local']).toBe(
      'pnpm run release:verify:cli && pnpm run release:install:local',
    );
    expect(rootScripts['release:verify:catalog']).toMatch(/^pnpm build:ensure &&/);
    expect(cliScripts.prepack).toBe('pnpm --dir ../.. build:ensure');
    expect(packCatalogSource).toContain('withReleaseBuildSnapshot(');
    expect(packCatalogSource).toContain('sourceRoot: snapshot.catalogOutputRoot');
    expect(packCatalogSource).not.toContain("runCommand('pnpm', ['build");
    expect(packReleaseSource.indexOf('await packCli(')).toBeLessThan(
      packReleaseSource.indexOf('await packCatalogRelease('),
    );
  });

  it('keeps the public CLI pack destination argument contract', () => {
    expect(parsePackCliArgs([])).toEqual({ destination: undefined });
    expect(parsePackCliArgs(['--pack-destination', '/tmp/aw-pack'])).toEqual({
      destination: '/tmp/aw-pack',
    });
    expect(parsePackCliArgs(['--', '--pack-destination', 'relative-pack'])).toEqual({
      destination: 'relative-pack',
    });
    expect(() => parsePackCliArgs(['--pack-destination'])).toThrow('Missing value');
    expect(() => parsePackCliArgs(['--unexpected'])).toThrow('Unknown argument');
  });
});
