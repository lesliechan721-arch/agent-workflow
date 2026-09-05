import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDevWithCache,
  devBuildCacheContract,
} from '../../../../scripts/build/dev-build-cache.mjs';
import { computeTreeDigest } from '../../../../scripts/build/build-cache.mjs';

const tempDirs: string[] = [];

async function createRepo(): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-dev-build-cache-'));
  tempDirs.push(repoRoot);
  const files = {
    'package.json': '{}\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'release/version-targets.json': '{}\n',
    'tsconfig.base.json': '{}\n',
    'packages/agent-skill-eval/package.json': '{}\n',
    'packages/agent-skill-eval/tsconfig.json': '{}\n',
    'packages/agent-skill-eval/tsconfig.dev.json': '{}\n',
    'packages/agent-skill-eval/src/index.ts': 'export const evalValue = 1\n',
    'packages/agent-skill-eval/schemas/eval-result.schema.json': '{}\n',
    'packages/agent-skill-eval/scripts/embed-schemas.mjs': 'export {}\n',
    'packages/agent-skill-eval/scripts/copy-windows-job-helper.mjs': 'export {}\n',
    'packages/agent-skill-eval/scripts/windows-job-helper-artifacts.mjs': 'export {}\n',
    'packages/agent-skill-eval/native/windows/manifest.json': '{}\n',
    'packages/agent-skill-eval/native/windows/x64/aw-windows-job.exe': 'x64 source fixture\n',
    'packages/agent-skill-eval/native/windows/arm64/aw-windows-job.exe': 'arm64 source fixture\n',
    'packages/plugin-core/package.json': '{}\n',
    'packages/plugin-core/tsconfig.json': '{}\n',
    'packages/plugin-core/tsconfig.dev.json': '{}\n',
    'packages/plugin-core/src/index.ts': 'export const coreValue = 1\n',
    'packages/plugin-core/schemas/plugin-manifest-v3.json': '{}\n',
    'packages/plugin-core/scripts/generate-manifest-types.mjs': 'export {}\n',
    'packages/cli/package.json': '{}\n',
    'packages/cli/tsconfig.json': '{}\n',
    'packages/cli/tsconfig.dev.json': '{}\n',
    'packages/cli/index.ts': 'export {}\n',
    'packages/cli/src/index.ts': 'export const cliValue = 1\n',
    'packages/cli/scripts/bundle-plugins.ts': 'export {}\n',
    'packages/cli/authoring/assets/aw-config.mjs': 'export {}\n',
    'plugins/demo/.agents-plugin/plugin.json': '{"name":"demo"}\n',
    'plugins/demo/skills/demo/SKILL.md': '---\nname: demo\n---\n',
  };
  await Promise.all(Object.entries(files).map(async ([relativePath, contents]) => {
    const filePath = path.join(repoRoot, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
  }));
  return repoRoot;
}

function createBuilders(repoRoot: string, builds: string[], generations: Map<string, number>) {
  const write = async (relativePath: string, contents: string): Promise<void> => {
    const filePath = path.join(repoRoot, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
  };
  return Object.fromEntries(devBuildCacheContract.targets.map((target) => [
    target.id,
    async ({ cleaned }: { cleaned: boolean }) => {
      builds.push(`${target.id}:${cleaned ? 'clean' : 'incremental'}`);
      const generation = (generations.get(target.id) ?? 0) + 1;
      generations.set(target.id, generation);
      if (target.id === 'agent-skill-eval') {
        await write('packages/agent-skill-eval/dist/index.js', `export const generation = ${generation}\n`);
        await write('packages/agent-skill-eval/dist/bin.js', 'export {}\n');
        await write('packages/agent-skill-eval/dist/schemas/digests.json', '{}\n');
        await write('packages/agent-skill-eval/dist/native/windows/manifest.json', '{}\n');
        await write('packages/agent-skill-eval/dist/native/windows/x64/aw-windows-job.exe', 'x64 fixture\n');
        await write('packages/agent-skill-eval/dist/native/windows/arm64/aw-windows-job.exe', 'arm64 fixture\n');
      } else if (target.id === 'plugin-core') {
        await write('packages/plugin-core/dist/index.js', `export const generation = ${generation}\n`);
      } else if (target.id === 'cli-typescript') {
        await write('packages/cli/dist/index.js', `export const generation = ${generation}\n`);
        await write('packages/cli/dist/scripts/bundle-plugins.js', 'export {}\n');
      } else {
        await write('packages/cli/plugins-dist/.claude-plugin/marketplace.json', '{"plugins":[]}\n');
        await write('packages/cli/plugins-dist/.agents/plugins/marketplace.json', '{"plugins":[]}\n');
        await write(
          'packages/cli/plugins-dist/catalog-manifest.json',
          `{"schemaVersion":7,"release":{"state":"development"},"entries":[],"generation":${generation}}\n`,
        );
      }
      if (target.tsBuildInfoPath) {
        await write(target.tsBuildInfoPath, JSON.stringify({ generation }));
      }
    },
  ]));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('development build cache', () => {
  it('builds four independent targets once and reuses every warm target', async () => {
    const repoRoot = await createRepo();
    const builds: string[] = [];
    const builders = createBuilders(repoRoot, builds, new Map());

    await expect(buildDevWithCache(repoRoot, { builders })).resolves.toMatchObject({
      targets: devBuildCacheContract.targets.map((target) => ({
        target: target.id,
        reused: false,
        cleaned: true,
      })),
    });
    await expect(buildDevWithCache(repoRoot, { builders })).resolves.toMatchObject({
      targets: devBuildCacheContract.targets.map((target) => ({
        target: target.id,
        reused: true,
      })),
    });
    expect(builds).toEqual(devBuildCacheContract.targets.map((target) => `${target.id}:clean`));
  });

  it('excludes tests, Vitest config, docs, evals, reports, and changes from all dev keys', async () => {
    const repoRoot = await createRepo();
    const builds: string[] = [];
    const builders = createBuilders(repoRoot, builds, new Map());
    await buildDevWithCache(repoRoot, { builders });
    builds.length = 0;

    const excluded = [
      'packages/agent-skill-eval/tests/unit/noise.test.ts',
      'packages/plugin-core/vitest.config.ts',
      'packages/cli/docs/noise.md',
      'plugins/demo/evals/case.json',
      'plugins/demo/reports/run.json',
      '.changes/noise.md',
    ];
    for (const relativePath of excluded) {
      const filePath = path.join(repoRoot, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, relativePath);
    }

    expect((await buildDevWithCache(repoRoot, { builders })).targets.every((target) => target.reused))
      .toBe(true);
    expect(builds).toEqual([]);
  });

  it.each([
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ])('invalidates all target keys when %s changes', async (relativePath) => {
    const repoRoot = await createRepo();
    const builds: string[] = [];
    const builders = createBuilders(repoRoot, builds, new Map());
    await buildDevWithCache(repoRoot, { builders });
    builds.length = 0;

    await fs.appendFile(path.join(repoRoot, relativePath), '# dependency identity changed\n');
    const result = await buildDevWithCache(repoRoot, { builders });

    expect(result.targets).toEqual(devBuildCacheContract.targets.map((target) =>
      expect.objectContaining({ target: target.id, reused: false, cleaned: false })
    ));
    expect(builds).toEqual(devBuildCacheContract.targets.map((target) =>
      `${target.id}:incremental`
    ));
  });

  it('invalidates CLI and bundle when upstream public output identity changes', async () => {
    const repoRoot = await createRepo();
    const builds: string[] = [];
    const generations = new Map<string, number>();
    const builders = createBuilders(repoRoot, builds, generations);
    await buildDevWithCache(repoRoot, { builders });
    builds.length = 0;

    await fs.writeFile(
      path.join(repoRoot, 'packages', 'agent-skill-eval', 'src', 'index.ts'),
      'export const evalValue = 2\n',
    );
    const result = await buildDevWithCache(repoRoot, { builders });

    expect(result.targets.map(({ target, reused }) => ({ target, reused }))).toEqual([
      { target: 'agent-skill-eval', reused: false },
      { target: 'plugin-core', reused: true },
      { target: 'cli-typescript', reused: false },
      { target: 'plugin-bundle', reused: false },
    ]);
    expect(builds).toEqual([
      'agent-skill-eval:incremental',
      'cli-typescript:incremental',
      'plugin-bundle:incremental',
    ]);
  });

  it('uses an independent plugin bundle key and output identity', async () => {
    const repoRoot = await createRepo();
    const builds: string[] = [];
    const builders = createBuilders(repoRoot, builds, new Map());
    await buildDevWithCache(repoRoot, { builders });
    builds.length = 0;

    await fs.writeFile(
      path.join(repoRoot, 'plugins', 'demo', 'skills', 'demo', 'SKILL.md'),
      '---\nname: changed\n---\n',
    );
    let result = await buildDevWithCache(repoRoot, { builders });
    expect(result.targets.filter((target) => !target.reused)).toEqual([
      expect.objectContaining({ target: 'plugin-bundle', cleaned: false }),
    ]);

    builds.length = 0;
    await fs.writeFile(
      path.join(repoRoot, 'packages', 'cli', 'plugins-dist', 'catalog-manifest.json'),
      '{bad',
    );
    result = await buildDevWithCache(repoRoot, { builders });
    expect(result.targets.filter((target) => !target.reused)).toEqual([
      expect.objectContaining({ target: 'plugin-bundle', cleaned: true }),
    ]);
    expect(builds).toEqual(['plugin-bundle:clean']);
  });

  it.each([
    ['input deletion', async (repoRoot: string) => {
      await fs.rm(path.join(repoRoot, 'packages', 'plugin-core', 'src', 'index.ts'));
    }],
    ['missing output', async (repoRoot: string) => {
      await fs.rm(path.join(repoRoot, 'packages', 'plugin-core', 'dist', 'index.js'));
    }],
    ['changed output', async (repoRoot: string) => {
      await fs.writeFile(
        path.join(repoRoot, 'packages', 'plugin-core', 'dist', 'index.js'),
        'not the built output\n',
      );
    }],
    ['invalid metadata', async (repoRoot: string) => {
      await fs.writeFile(
        path.join(repoRoot, '.release', 'cache', 'dev-build', 'plugin-core.json'),
        '{bad',
      );
    }],
    ['invalid tsbuildinfo', async (repoRoot: string) => {
      await fs.writeFile(
        path.join(repoRoot, '.release', 'cache', 'dev-build', 'plugin-core.tsbuildinfo'),
        '{bad',
      );
    }],
  ])('cleans only the affected target after %s', async (_name, damage) => {
    const repoRoot = await createRepo();
    const builds: string[] = [];
    const builders = createBuilders(repoRoot, builds, new Map());
    await buildDevWithCache(repoRoot, { builders });
    builds.length = 0;
    await damage(repoRoot);

    const result = await buildDevWithCache(repoRoot, { builders });
    expect(result.targets.find((target) => target.target === 'agent-skill-eval')?.reused).toBe(true);
    expect(result.targets.find((target) => target.target === 'plugin-core')).toMatchObject({
      reused: false,
      cleaned: true,
    });
    expect(builds).toContain('plugin-core:clean');
    expect(builds).not.toContain('agent-skill-eval:clean');
  });

  it('cleans only the affected target when output digest inspection cannot read the tree', async () => {
    const repoRoot = await createRepo();
    const builds: string[] = [];
    const builders = createBuilders(repoRoot, builds, new Map());
    await buildDevWithCache(repoRoot, { builders });
    builds.length = 0;
    let failPluginCoreInspection = true;

    const result = await buildDevWithCache(repoRoot, {
      builders,
      computeOutputDigest: async (root: string, roots: string[]) => {
        if (failPluginCoreInspection && roots.includes('packages/plugin-core/dist')) {
          failPluginCoreInspection = false;
          throw new Error('injected output read failure');
        }
        return computeTreeDigest(root, roots);
      },
    });

    expect(result.targets.filter((target) => target.cleaned).map((target) => target.target))
      .toEqual(['plugin-core']);
    expect(builds).toContain('plugin-core:clean');
    expect(builds.filter((build) => build.endsWith(':clean'))).toEqual(['plugin-core:clean']);
  });

  it('cleans and rebuilds Eval when a copied Windows helper is missing', async () => {
    const repoRoot = await createRepo();
    const builds: string[] = [];
    const builders = createBuilders(repoRoot, builds, new Map());
    await buildDevWithCache(repoRoot, { builders });
    builds.length = 0;

    await fs.rm(path.join(
      repoRoot,
      'packages',
      'agent-skill-eval',
      'dist',
      'native',
      'windows',
      'x64',
      'aw-windows-job.exe',
    ));
    const result = await buildDevWithCache(repoRoot, { builders });

    expect(result.targets.find((target) => target.target === 'agent-skill-eval')).toMatchObject({
      reused: false,
      cleaned: true,
    });
    await expect(fs.readFile(path.join(
      repoRoot,
      'packages',
      'agent-skill-eval',
      'dist',
      'native',
      'windows',
      'x64',
      'aw-windows-job.exe',
    ), 'utf8')).resolves.toBe('x64 fixture\n');
  });

  it('fails closed when output digest validation still cannot read the rebuilt tree', async () => {
    const repoRoot = await createRepo();
    const builds: string[] = [];
    const builders = createBuilders(repoRoot, builds, new Map());
    await buildDevWithCache(repoRoot, { builders });
    builds.length = 0;

    await expect(buildDevWithCache(repoRoot, {
      builders,
      computeOutputDigest: async (root: string, roots: string[]) => {
        if (roots.includes('packages/plugin-core/dist')) {
          throw new Error('persistent output read failure');
        }
        return computeTreeDigest(root, roots);
      },
    })).rejects.toThrow('persistent output read failure');
    expect(builds).toEqual(['plugin-core:clean']);
    await expect(fs.stat(path.join(
      repoRoot,
      '.release',
      'cache',
      'dev-build',
      'plugin-core.json',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
