import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireBuildLock,
  buildCacheContract,
  buildWithCache,
  computeBuildInputDigest,
  computeBuildOutputDigest,
  createBuildSnapshot,
  inspectBuildCache,
  resolvePnpmInvocation,
  withBuildSnapshot,
} from '../../../../scripts/build/build-cache.mjs';

const tempDirs: string[] = [];
const originalNpmExecPath = process.env.npm_execpath;
const originalNpmUserAgent = process.env.npm_config_user_agent;

async function createRepo(): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-build-cache-'));
  tempDirs.push(repoRoot);
  await fs.mkdir(path.join(repoRoot, 'plugins', 'demo'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'tools'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'packages', 'cli'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'packages', 'cli', 'node_modules'), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ packageManager: 'pnpm@10.33.0' }),
  );
  await fs.writeFile(path.join(repoRoot, 'plugins', 'demo', 'SKILL.md'), 'initial\n');
  await fs.writeFile(
    path.join(repoRoot, 'packages', 'cli', 'package.json'),
    JSON.stringify({ name: '@lesliechan721/aw', type: 'module', files: ['dist/'] }),
  );
  const fakePnpmPath = path.join(repoRoot, 'tools', 'pnpm.cjs');
  await fs.writeFile(fakePnpmPath, '/* deterministic pnpm fixture */\n');
  process.env.npm_execpath = fakePnpmPath;
  process.env.npm_config_user_agent = 'pnpm/10.33.0 npm/? node/test test test';
  return repoRoot;
}

async function writeRequiredOutputs(repoRoot: string, generation = 1): Promise<void> {
  await Promise.all(buildCacheContract.requiredOutputs.map(async (relativePath: string) => {
    const outputPath = path.join(repoRoot, relativePath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    let contents = `export const generation = ${generation};\n`;
    if (relativePath.endsWith('marketplace.json')) {
      contents = `{"plugins":[],"generation":${generation}}\n`;
    } else if (relativePath.endsWith('catalog-manifest.json')) {
      contents = `{"schemaVersion":1,"entries":[],"packages":{},"generation":${generation}}\n`;
    } else if (relativePath.endsWith('sidecar/package.json')) {
      contents = `{"name":"@lesliechan721/aw-plugins-manifest","files":[],"generation":${generation}}\n`;
    } else if (relativePath.endsWith('full/package.json')) {
      contents = `{"name":"@lesliechan721/aw-plugins","files":[],"generation":${generation}}\n`;
    }
    await fs.writeFile(outputPath, contents);
  }));
}

async function writeBuildOutputs(repoRoot: string, generation = 1): Promise<void> {
  await Promise.all(buildCacheContract.outputRoots.map((relativePath: string) =>
    fs.rm(path.join(repoRoot, relativePath), { recursive: true, force: true })
  ));
  await writeRequiredOutputs(repoRoot, generation);
  const nonrequiredModule = path.join(repoRoot, 'packages', 'cli', 'dist', 'src', 'nonrequired.js');
  await fs.mkdir(path.dirname(nonrequiredModule), { recursive: true });
  await fs.writeFile(nonrequiredModule, `export const generation = ${generation};\n`);
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  if (originalNpmExecPath === undefined) {
    delete process.env.npm_execpath;
  } else {
    process.env.npm_execpath = originalNpmExecPath;
  }
  if (originalNpmUserAgent === undefined) {
    delete process.env.npm_config_user_agent;
  } else {
    process.env.npm_config_user_agent = originalNpmUserAgent;
  }
  await Promise.all(tempDirs.splice(0).map((tempDir) =>
    fs.rm(tempDir, { recursive: true, force: true })
  ));
});

describe('build cache input and environment identity', () => {
  it('keeps input and output entry boundaries unambiguous', async () => {
    const repoRoot = await createRepo();
    const inputRoot = path.join(repoRoot, 'collision-input');
    await fs.mkdir(inputRoot);
    const inputA = path.join(inputRoot, 'a');
    const inputB = path.join(inputRoot, 'b');
    await fs.writeFile(inputA, 'A');
    await fs.writeFile(inputB, 'B');
    const inputMode = (await fs.stat(inputB)).mode & 0o777;
    const inputBefore = await computeBuildInputDigest(repoRoot, ['collision-input']);
    await fs.appendFile(inputA, `\0file\0collision-input/b\0${inputMode}\0B`);
    await fs.rm(inputB);
    expect(await computeBuildInputDigest(repoRoot, ['collision-input'])).not.toBe(inputBefore);

    const outputRoot = path.join(repoRoot, 'packages', 'cli', 'dist');
    await fs.mkdir(outputRoot, { recursive: true });
    const outputA = path.join(outputRoot, 'a');
    const outputB = path.join(outputRoot, 'b');
    await fs.writeFile(outputA, 'A');
    await fs.writeFile(outputB, 'B');
    const outputMode = (await fs.stat(outputB)).mode & 0o777;
    const outputBefore = await computeBuildOutputDigest(repoRoot);
    await fs.appendFile(outputA, `\0file\0packages/cli/dist/b\0${outputMode}\0B`);
    await fs.rm(outputB);
    expect(await computeBuildOutputDigest(repoRoot)).not.toBe(outputBefore);
  });

  it('keeps stable content hashes, excludes evals and node_modules, and includes nested dist', async () => {
    const repoRoot = await createRepo();
    const skillPath = path.join(repoRoot, 'plugins', 'demo', 'SKILL.md');
    const linkPath = path.join(repoRoot, 'plugins', 'demo', 'current');
    const evalPath = path.join(
      repoRoot,
      'plugins',
      'demo',
      'skills',
      'demo',
      'evals',
      'case.json',
    );
    const reportPath = path.join(
      repoRoot,
      'plugins',
      'demo',
      'skills',
      'demo',
      'reports',
      'run-1',
      'summary.json',
    );
    const dependencyPath = path.join(repoRoot, 'plugins', 'demo', 'node_modules', 'dep', 'index.js');
    const nestedDistPath = path.join(repoRoot, 'plugins', 'demo', 'runtime', 'dist', 'index.js');
    await fs.mkdir(path.dirname(evalPath), { recursive: true });
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.mkdir(path.dirname(dependencyPath), { recursive: true });
    await fs.mkdir(path.dirname(nestedDistPath), { recursive: true });
    await fs.writeFile(evalPath, 'eval-one\n');
    await fs.writeFile(reportPath, 'report-one\n');
    await fs.writeFile(dependencyPath, 'dependency-one\n');
    await fs.writeFile(nestedDistPath, 'nested-one\n');
    await fs.symlink('SKILL.md', linkPath);

    const initialDigest = await computeBuildInputDigest(repoRoot);
    await fs.utimes(skillPath, new Date(), new Date());
    expect(await computeBuildInputDigest(repoRoot)).toBe(initialDigest);

    await fs.writeFile(evalPath, 'eval-two\n');
    await fs.writeFile(reportPath, 'report-two\n');
    await fs.writeFile(dependencyPath, 'dependency-two\n');
    expect(await computeBuildInputDigest(repoRoot)).toBe(initialDigest);

    await fs.writeFile(nestedDistPath, 'nested-two\n');
    expect(await computeBuildInputDigest(repoRoot)).not.toBe(initialDigest);

    const nestedDigest = await computeBuildInputDigest(repoRoot);
    await fs.unlink(linkPath);
    await fs.symlink('other.md', linkPath);
    expect(await computeBuildInputDigest(repoRoot)).not.toBe(nestedDigest);
  });

  it('binds registered input symlinks to referent bytes during a build', async () => {
    const repoRoot = await createRepo();
    const referentPath = path.join(repoRoot, 'external-runtime.md');
    const linkPath = path.join(repoRoot, 'plugins', 'demo', 'runtime.md');
    await fs.writeFile(referentPath, 'referent-one\n');
    await fs.symlink(referentPath, linkPath);

    const firstDigest = await computeBuildInputDigest(repoRoot);
    await fs.writeFile(referentPath, 'referent-two\n');
    await expect(computeBuildInputDigest(repoRoot)).resolves.not.toBe(firstDigest);

    await expect(buildWithCache(repoRoot, {
      build: async () => {
        await writeBuildOutputs(repoRoot);
        await fs.writeFile(referentPath, 'referent-three\n');
      },
    })).rejects.toThrow('Build identity inputDigest changed');
  });

  it('uses the Node executable with npm_execpath and fails fast without it', () => {
    expect(resolvePnpmInvocation({ npm_execpath: '/tmp/pnpm.cjs' })).toEqual({
      command: process.execPath,
      args: [path.resolve('/tmp/pnpm.cjs'), '--filter', '@lesliechan721/aw', 'build'],
    });
    expect(() => resolvePnpmInvocation({})).toThrow('npm_execpath is missing');
  });

  it('records pnpm path/content, runtime platform, and architecture in the stamp', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    const stamp = JSON.parse(await fs.readFile(
      path.join(repoRoot, '.release', 'cache', 'build-stamp.json'),
      'utf8',
    ));

    expect(stamp).toMatchObject({
      schemaVersion: 5,
      nodeVersion: process.version,
      nodeExecPath: path.resolve(process.execPath),
      nodeExecRealPath: await fs.realpath(process.execPath),
      nodeExecDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      platform: process.platform,
      arch: process.arch,
      packageManager: 'pnpm@10.33.0',
      npmExecPath: process.env.npm_execpath,
      npmExecRealPath: await fs.realpath(String(process.env.npm_execpath)),
      npmUserAgent: process.env.npm_config_user_agent,
      npmExecDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      outputDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      cliPackageDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      generationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('refuses a stamp when the fixed npm_execpath launcher changes during the build', async () => {
    const repoRoot = await createRepo();
    const npmExecPath = String(process.env.npm_execpath);
    const stampPath = path.join(repoRoot, '.release', 'cache', 'build-stamp.json');

    await expect(buildWithCache(repoRoot, {
      build: async () => {
        await writeBuildOutputs(repoRoot);
        await fs.writeFile(npmExecPath, '/* replaced pnpm launcher */\n');
      },
    })).rejects.toThrow('Build identity npmExecDigest changed');
    await expect(fs.stat(stampPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a stamp when a pnpm alias changes realpath during the build', async () => {
    const repoRoot = await createRepo();
    const targetA = path.join(repoRoot, 'tools', 'pnpm-a.cjs');
    const targetB = path.join(repoRoot, 'tools', 'pnpm-b.cjs');
    const aliasPath = path.join(repoRoot, 'tools', 'pnpm-alias.cjs');
    await fs.writeFile(targetA, '/* pnpm a */\n');
    await fs.writeFile(targetB, '/* pnpm b */\n');
    await fs.symlink(targetA, aliasPath);
    process.env.npm_execpath = aliasPath;

    await expect(buildWithCache(repoRoot, {
      build: async () => {
        await writeBuildOutputs(repoRoot);
        await fs.unlink(aliasPath);
        await fs.symlink(targetB, aliasPath);
      },
    })).rejects.toThrow('Build identity npmExecRealPath changed');
    await expect(fs.stat(path.join(repoRoot, '.release', 'cache', 'build-stamp.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a generation when CLI package release fields change during build', async () => {
    const repoRoot = await createRepo();
    const packageJsonPath = path.join(repoRoot, 'packages', 'cli', 'package.json');
    await expect(buildWithCache(repoRoot, {
      build: async () => {
        await writeBuildOutputs(repoRoot);
        await fs.writeFile(packageJsonPath, JSON.stringify({
          name: '@lesliechan721/aw',
          type: 'module',
          version: '9.9.9',
          files: ['dist/', 'unexpected/'],
          publishConfig: { registry: 'https://example.invalid' },
        }));
      },
    })).rejects.toThrow('CLI package metadata changed while the build was running');
    await expect(fs.stat(path.join(repoRoot, '.release', 'cache', 'build-stamp.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans dist before the production launcher runs but leaves custom builders in control', async () => {
    const repoRoot = await createRepo();
    const orphanPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'orphan.js');
    await writeRequiredOutputs(repoRoot);
    await fs.mkdir(path.dirname(orphanPath), { recursive: true });
    await fs.writeFile(orphanPath, 'orphan\n');
    const fakePnpmPath = String(process.env.npm_execpath);
    await fs.writeFile(fakePnpmPath, [
      "const fs = require('node:fs');",
      "if (fs.existsSync('packages/cli/dist/orphan.js')) process.exit(9);",
      "fs.mkdirSync('packages/cli/dist/scripts', { recursive: true });",
      "fs.writeFileSync('packages/cli/dist/index.js', 'export {};\\n');",
      "fs.writeFileSync('packages/cli/dist/scripts/bundle-plugins.js', 'export {};\\n');",
      "fs.writeFileSync('launcher-ran', 'yes');",
    ].join('\n'));

    await buildWithCache(repoRoot);
    await expect(fs.stat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(repoRoot, 'launcher-ran'), 'utf8')).resolves.toBe('yes');

    await fs.mkdir(path.dirname(orphanPath), { recursive: true });
    await fs.writeFile(orphanPath, 'custom-owned\n');
    await buildWithCache(repoRoot, {
      build: async () => {
        await expect(fs.readFile(orphanPath, 'utf8')).resolves.toBe('custom-owned\n');
        await writeBuildOutputs(repoRoot);
      },
    });
  });

  it('disables reuse when a plugin declares scripts.node.build', async () => {
    const repoRoot = await createRepo();
    const manifestPath = path.join(repoRoot, 'plugins', 'demo', '.agents-plugin', 'plugin.json');
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify({
      name: 'demo',
      scripts: { node: { build: ['node', 'build.mjs'] } },
    }));
    let buildCount = 0;
    const build = async () => {
      buildCount += 1;
      await writeBuildOutputs(repoRoot, buildCount);
    };

    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'reuse disabled: plugin demo declares scripts.node.build',
    });
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'reuse disabled: plugin demo declares scripts.node.build',
    });
    expect(buildCount).toBe(2);
    const snapshot = await createBuildSnapshot(repoRoot, { build });
    expect(snapshot.generationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(buildCount).toBe(3);
    await expect(computeBuildOutputDigest(snapshot.root)).resolves.toBe(snapshot.outputDigest);
    await snapshot.cleanup();
    await expect(fs.stat(path.join(repoRoot, '.release', 'cache', 'build-stamp.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('disables reuse for a symlinked plugin directory when its referent changes', async () => {
    const repoRoot = await createRepo();
    const linkedSource = path.join(repoRoot, 'linked-plugin-source');
    await fs.mkdir(linkedSource, { recursive: true });
    await fs.writeFile(path.join(linkedSource, 'SKILL.md'), 'linked-one\n');
    await fs.symlink(linkedSource, path.join(repoRoot, 'plugins', 'linked'));
    let buildCount = 0;
    const build = async () => {
      buildCount += 1;
      await writeBuildOutputs(repoRoot, buildCount);
    };

    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'reuse disabled: registered input contains symlink plugins/linked',
    });
    await fs.writeFile(path.join(linkedSource, 'SKILL.md'), 'linked-two\n');
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'reuse disabled: registered input contains symlink plugins/linked',
    });
    expect(buildCount).toBe(2);
  });

  it('disables reuse for an internal plugin source symlink when its referent changes', async () => {
    const repoRoot = await createRepo();
    const referentPath = path.join(repoRoot, 'external-source.md');
    await fs.writeFile(referentPath, 'referent-one\n');
    await fs.symlink(referentPath, path.join(repoRoot, 'plugins', 'demo', 'runtime.md'));
    let buildCount = 0;
    const build = async () => {
      buildCount += 1;
      await writeBuildOutputs(repoRoot, buildCount);
    };

    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'reuse disabled: registered input contains symlink plugins/demo/runtime.md',
    });
    await fs.writeFile(referentPath, 'referent-two\n');
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'reuse disabled: registered input contains symlink plugins/demo/runtime.md',
    });
    expect(buildCount).toBe(2);
  });

  it('disables reuse for any registered input root symlink and allows missing or ordinary roots', async () => {
    const repoRoot = await createRepo();
    const packageRoot = path.join(repoRoot, 'packages', 'cli');
    const externalSource = path.join(repoRoot, 'external-cli-source');
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.mkdir(externalSource);
    await fs.writeFile(path.join(externalSource, 'index.ts'), 'one\n');
    await fs.symlink(externalSource, path.join(packageRoot, 'src'));
    let buildCount = 0;
    const build = async () => {
      buildCount += 1;
      await writeBuildOutputs(repoRoot, buildCount);
    };

    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reason: 'reuse disabled: registered input contains symlink packages/cli/src',
    });
    await fs.rm(path.join(packageRoot, 'src'));
    await fs.writeFile(path.join(packageRoot, 'src'), 'ordinary registered root\n');
    await buildWithCache(repoRoot, { build });
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({ reused: true });
    expect(buildCount).toBe(2);
  });
});

describe('build cache output binding', () => {
  it('rejects required and non-required output symlinks for builds and snapshots', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    const indexPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
    const referentPath = path.join(repoRoot, 'external-index.js');
    await fs.writeFile(referentPath, 'export const external = 1;\n');
    await fs.rm(indexPath);
    await fs.symlink(referentPath, indexPath);
    let buildCount = 0;
    const symlinkBuild = async () => {
      buildCount += 1;
      await writeRequiredOutputs(repoRoot, buildCount);
    };

    await expect(buildWithCache(repoRoot, { build: symlinkBuild }))
      .rejects.toThrow('Build output contains unsupported symlink packages/cli/dist/index.js');
    await fs.writeFile(referentPath, 'export const external = 2;\n');
    await expect(createBuildSnapshot(repoRoot, { build: symlinkBuild }))
      .rejects.toThrow('Build output contains unsupported symlink packages/cli/dist/index.js');
    expect(buildCount).toBe(2);

    await writeBuildOutputs(repoRoot, 3);
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot, 3) });
    const nonrequiredPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'src', 'nonrequired.js');
    await fs.rm(nonrequiredPath);
    await fs.symlink(referentPath, nonrequiredPath);
    await expect(buildWithCache(repoRoot, { build: () => writeRequiredOutputs(repoRoot, 4) }))
      .rejects.toThrow('Build output contains unsupported symlink packages/cli/dist/src/nonrequired.js');
    await expect(fs.stat(path.join(repoRoot, '.release', 'cache', 'build-stamp.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rebuilds after JS/JSON mutation and any output tree deletion or addition', async () => {
    const repoRoot = await createRepo();
    let buildCount = 0;
    const build = async () => {
      buildCount += 1;
      await writeBuildOutputs(repoRoot, buildCount);
    };

    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({ reused: false });
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: true,
      reason: 'stamp and output tree match',
    });

    await fs.writeFile(path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js'), 'export const tampered = true;\n');
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'outputDigest changed',
    });

    const marketplacePath = path.join(
      repoRoot,
      'packages',
      'cli',
      'plugins-dist',
      '.claude-plugin',
      'marketplace.json',
    );
    const marketplace = JSON.parse(await fs.readFile(marketplacePath, 'utf8'));
    await fs.writeFile(marketplacePath, JSON.stringify({ ...marketplace, tampered: true }));
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'outputDigest changed',
    });

    await fs.rm(path.join(repoRoot, 'packages', 'cli', 'dist', 'src', 'nonrequired.js'));
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'outputDigest changed',
    });

    await fs.writeFile(path.join(repoRoot, 'packages', 'cli', 'dist', 'src', 'added.js'), 'export {};\n');
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'outputDigest changed',
    });
    expect(buildCount).toBe(5);
  });

  it('rebuilds for input changes, missing required output, and a bad stamp', async () => {
    const repoRoot = await createRepo();
    let buildCount = 0;
    const build = async () => {
      buildCount += 1;
      await writeBuildOutputs(repoRoot, buildCount);
    };
    await buildWithCache(repoRoot, { build });

    await fs.writeFile(path.join(repoRoot, 'plugins', 'demo', 'SKILL.md'), 'changed\n');
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'inputDigest changed',
    });

    await fs.rm(path.join(repoRoot, buildCacheContract.requiredOutputs[0]));
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: expect.stringContaining('missing output'),
    });

    await fs.writeFile(path.join(repoRoot, '.release', 'cache', 'build-stamp.json'), '{bad');
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'invalid stamp',
    });
    expect(buildCount).toBe(4);
  });

  it('refuses warm reuse when inputs change during cache inspection', async () => {
    const repoRoot = await createRepo();
    let generation = 0;
    const build = async () => {
      generation += 1;
      await writeBuildOutputs(repoRoot, generation);
    };
    await buildWithCache(repoRoot, { build });

    const inputInspection = await inspectBuildCache(repoRoot, {
      __testBeforeFinalInputCheck: async () => {
        await fs.writeFile(path.join(repoRoot, 'plugins', 'demo', 'SKILL.md'), 'changed\n');
      },
    });
    expect(inputInspection).toMatchObject({
      reusable: false,
      reason: 'inputDigest changed',
    });

    await buildWithCache(repoRoot, { build });
    const cliPackageInspection = await inspectBuildCache(repoRoot, {
      __testBeforeFinalInputCheck: async () => {
        await fs.writeFile(
          path.join(repoRoot, 'packages', 'cli', 'package.json'),
          JSON.stringify({ name: '@lesliechan721/aw', type: 'module', version: '9.9.9' }),
        );
      },
    });
    expect(cliPackageInspection).toMatchObject({
      reusable: false,
      reason: 'cliPackageDigest changed',
    });
  });

  it('refuses warm reuse when outputs change during final cache inspection', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });

    const inspection = await inspectBuildCache(repoRoot, {
      __testBeforeFinalOutputCheck: async () => {
        await fs.writeFile(
          path.join(repoRoot, 'packages', 'cli', 'dist', 'src', 'nonrequired.js'),
          'export const changedDuringInspection = true;\n',
        );
      },
    });
    expect(inspection).toMatchObject({
      reusable: false,
      reason: 'outputDigest changed',
    });
  });

  it('forces a new build and refreshes a warm stamp', async () => {
    const repoRoot = await createRepo();
    let buildCount = 0;
    const build = async () => {
      buildCount += 1;
      await writeBuildOutputs(repoRoot, buildCount);
    };
    await buildWithCache(repoRoot, { build });
    const stampPath = path.join(repoRoot, '.release', 'cache', 'build-stamp.json');
    const before = JSON.parse(await fs.readFile(stampPath, 'utf8'));
    const warm = await buildWithCache(repoRoot, { build });
    expect(warm).toMatchObject({ reused: true, generationId: before.generationId });

    await expect(buildWithCache(repoRoot, { build, force: true })).resolves.toMatchObject({
      reused: false,
      reason: 'forced build',
    });
    const after = JSON.parse(await fs.readFile(stampPath, 'utf8'));
    expect(buildCount).toBe(2);
    expect(after.outputDigest).not.toBe(before.outputDigest);
    expect(after.generationId).not.toBe(before.generationId);
    await expect(fs.readFile(path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js'), 'utf8'))
      .resolves.toContain('generation = 2');
  });

  it('does not write a stamp after a failed build and releases the lock', async () => {
    const repoRoot = await createRepo();
    const stampPath = path.join(repoRoot, '.release', 'cache', 'build-stamp.json');
    const lockPath = path.join(repoRoot, '.release', 'cache', 'build.lock');

    await expect(buildWithCache(repoRoot, {
      build: async () => {
        throw new Error('build failed');
      },
    })).rejects.toThrow('build failed');
    await expect(fs.stat(stampPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('build cache lock ownership', () => {
  it('removes its own canonical lock when diagnostic owner writing fails', async () => {
    const repoRoot = await createRepo();
    const lockPath = path.join(repoRoot, '.release', 'cache', 'build.lock');
    await expect(acquireBuildLock(repoRoot, {
      __testWriteBuildOwner: async () => {
        throw new Error('diagnostic write failed');
      },
    })).rejects.toThrow('diagnostic write failed');
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns a rejected Promise and removes only its intent when sync owner write fails', async () => {
    const repoRoot = await createRepo();
    let buildCalled = false;
    const result = buildWithCache(repoRoot, {
      build: async () => {
        buildCalled = true;
      },
      force: true,
      writeForceOwnerSync: () => {
        throw new Error('force owner write failed');
      },
    });

    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toThrow('force owner write failed');
    expect(buildCalled).toBe(false);
    const intentRoot = path.join(repoRoot, '.release', 'cache', 'build.force');
    expect(await fs.readdir(intentRoot)).toEqual([]);
  });

  it('never steals crash, invalid-owner, or PID-reuse locks', async () => {
    const repoRoot = await createRepo();
    const lockPath = path.join(repoRoot, '.release', 'cache', 'build.lock');
    const cases = [
      { name: 'crashed stale owner', owner: JSON.stringify({ pid: 999_999, token: 'dead' }) },
      { name: 'invalid owner', owner: '{invalid' },
      { name: 'PID reuse', owner: JSON.stringify({ pid: process.pid, token: 'reused' }) },
    ];

    for (const testCase of cases) {
      await fs.rm(lockPath, { recursive: true, force: true });
      await fs.mkdir(lockPath, { recursive: true });
      await fs.writeFile(path.join(lockPath, 'owner.json'), testCase.owner);
      const oldTime = new Date(Date.now() - 60_000);
      await fs.utimes(lockPath, oldTime, oldTime);

      const error = await acquireBuildLock(repoRoot, {
        lockTimeoutMs: 25,
        pollIntervalMs: 5,
      }).then(() => null, (caught) => caught as Error);
      expect(error?.message, testCase.name).toContain(lockPath);
      expect(error?.message, testCase.name).toContain('not recovered automatically');
      expect(error?.message, testCase.name).toContain('remove the lock offline');
      await expect(fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'))
        .resolves.toBe(testCase.owner);
    }
  });

  it('keeps an ownerless force intent active and never recovers it automatically', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    const intentPath = path.join(
      repoRoot,
      '.release',
      'cache',
      'build.force',
      '00000000-0000-4000-8000-000000000001',
    );
    await fs.mkdir(intentPath, { recursive: true });

    await expect(buildWithCache(repoRoot, {
      build: () => writeBuildOutputs(repoRoot, 2),
      lockTimeoutMs: 30,
      pollIntervalMs: 5,
    })).rejects.toThrow('Intents are not recovered automatically');
    await expect(fs.stat(intentPath)).resolves.toBeDefined();
  });

  it('serializes 32 concurrent ensure calls with one build owner', async () => {
    const repoRoot = await createRepo();
    let buildCount = 0;
    let activeBuilds = 0;
    let maxActiveBuilds = 0;
    const build = async () => {
      buildCount += 1;
      activeBuilds += 1;
      maxActiveBuilds = Math.max(maxActiveBuilds, activeBuilds);
      await new Promise((resolve) => setTimeout(resolve, 40));
      await writeBuildOutputs(repoRoot, buildCount);
      activeBuilds -= 1;
    };

    const results = await Promise.all(Array.from({ length: 32 }, () =>
      buildWithCache(repoRoot, { build, lockTimeoutMs: 15_000, pollIntervalMs: 2 })
    ));
    expect(buildCount).toBe(1);
    expect(maxActiveBuilds).toBe(1);
    expect(results.filter((result) => result.reused)).toHaveLength(31);
  }, 20_000);

  it('makes an ensure caller wait for a concurrent forced build and then reuse it', async () => {
    const repoRoot = await createRepo();
    let startBuild: (() => void) | undefined;
    const buildStarted = new Promise<void>((resolve) => {
      startBuild = resolve;
    });
    let buildCount = 0;
    const build = async () => {
      buildCount += 1;
      startBuild?.();
      await new Promise((resolve) => setTimeout(resolve, 60));
      await writeBuildOutputs(repoRoot, buildCount);
    };

    let intentVisibleBeforeOwnerWrite = false;
    const forced = buildWithCache(repoRoot, {
      build,
      force: true,
      pollIntervalMs: 5,
      onForceIntentVisible: ({ intentPath }: { intentPath: string }) => {
        intentVisibleBeforeOwnerWrite = fsSync.existsSync(intentPath) &&
          !fsSync.existsSync(path.join(intentPath, 'owner.json'));
      },
      writeForceOwnerSync: (ownerPath: string, contents: string) => {
        fsSync.writeFileSync(ownerPath, contents, { flag: 'wx' });
      },
    });
    expect(intentVisibleBeforeOwnerWrite).toBe(true);
    await buildStarted;
    const ensured = buildWithCache(repoRoot, { build, pollIntervalMs: 5 });
    const [forcedResult, ensuredResult] = await Promise.all([forced, ensured]);

    expect(buildCount).toBe(1);
    expect(forcedResult).toMatchObject({ reused: false, reason: 'forced build' });
    expect(ensuredResult).toMatchObject({ reused: true });
  });

  it('does not let a warm ensure pass a force intent queued behind another lock owner', async () => {
    const repoRoot = await createRepo();
    let generation = 0;
    const build = async () => {
      generation += 1;
      await writeBuildOutputs(repoRoot, generation);
    };
    await buildWithCache(repoRoot, { build });
    const blocker = await acquireBuildLock(repoRoot);

    const forced = buildWithCache(repoRoot, {
      build,
      force: true,
      lockTimeoutMs: 1_000,
      pollIntervalMs: 5,
    });
    const intentRoot = path.join(repoRoot, '.release', 'cache', 'build.force');
    let intentOwnerPath = '';
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const intentNames = await fs.readdir(intentRoot).catch(() => []);
      const intentName = intentNames.find((entryName) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entryName)
      );
      if (intentName) {
        intentOwnerPath = path.join(intentRoot, intentName, 'owner.json');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await expect(fs.stat(intentOwnerPath)).resolves.toBeDefined();

    let ensureSettled = false;
    const ensured = buildWithCache(repoRoot, {
      build,
      lockTimeoutMs: 1_000,
      pollIntervalMs: 5,
    }).finally(() => {
      ensureSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ensureSettled).toBe(false);

    await blocker.release();
    const [forcedResult, ensuredResult] = await Promise.all([forced, ensured]);
    expect(generation).toBe(2);
    expect(forcedResult).toMatchObject({ reused: false, reason: 'forced build' });
    expect(ensuredResult).toMatchObject({ reused: true });
    await expect(fs.readFile(path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js'), 'utf8'))
      .resolves.toContain('generation = 2');
  });

  it('lets a warm ensure linearize before a force registered after its intent check', async () => {
    const repoRoot = await createRepo();
    let generation = 0;
    const build = async () => {
      generation += 1;
      await writeBuildOutputs(repoRoot, generation);
    };
    const initial = await buildWithCache(repoRoot, { build });
    const checked = createDeferred<void>();
    const continueWarm = createDeferred<void>();
    const warm = buildWithCache(repoRoot, {
      build,
      pollIntervalMs: 5,
      __testAfterForceIntentCheck: async ({ forceActive }: { forceActive: boolean }) => {
        if (!forceActive) {
          checked.resolve();
          await continueWarm.promise;
        }
      },
    });
    await checked.promise;

    const forceBuildStarted = createDeferred<void>();
    const finishForceBuild = createDeferred<void>();
    const forced = buildWithCache(repoRoot, {
      build: async () => {
        forceBuildStarted.resolve();
        await finishForceBuild.promise;
        await build();
      },
      force: true,
      lockTimeoutMs: 1_000,
      pollIntervalMs: 5,
    });
    continueWarm.resolve();
    const warmResult = await warm;
    expect(warmResult).toMatchObject({
      reused: true,
      generationId: initial.generationId,
    });
    await forceBuildStarted.promise;
    finishForceBuild.resolve();
    await expect(forced).resolves.toMatchObject({ reused: false, reason: 'forced build' });
  });

  it('keeps multiple ensures behind every synchronously registered force intent', async () => {
    const repoRoot = await createRepo();
    let generation = 0;
    const build = async () => {
      generation += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      await writeBuildOutputs(repoRoot, generation);
    };
    await buildWithCache(repoRoot, { build });
    const blocker = await acquireBuildLock(repoRoot);
    const forces = Array.from({ length: 3 }, () => buildWithCache(repoRoot, {
      build,
      force: true,
      lockTimeoutMs: 10_000,
      pollIntervalMs: 2,
    }));
    const ensures = Array.from({ length: 5 }, () => buildWithCache(repoRoot, {
      build,
      lockTimeoutMs: 10_000,
      pollIntervalMs: 2,
    }));
    await blocker.release();

    const [forceResults, ensureResults] = await Promise.all([
      Promise.all(forces),
      Promise.all(ensures),
    ]);
    expect(generation).toBe(4);
    expect(forceResults.every((result) => !result.reused)).toBe(true);
    expect(ensureResults.every((result) => result.reused)).toBe(true);
    expect(new Set(ensureResults.map((result) => result.generationId)).size).toBe(1);
  });
});

describe('build snapshots', () => {
  it('copies and verifies one stable generation with consumer paths', async () => {
    const repoRoot = await createRepo();
    const built = await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    const snapshot = await createBuildSnapshot(repoRoot, {
      build: () => writeBuildOutputs(repoRoot, 2),
    });

    expect(snapshot).toMatchObject({
      root: expect.stringContaining('.release/build-snapshots/build-'),
      generationId: built.generationId,
      outputDigest: built.outputDigest,
      inputDigest: built.inputDigest,
      cliPackageDigest: built.cliPackageDigest,
      cliPackageRoot: path.join(snapshot.root, 'packages', 'cli'),
      cliDistRoot: path.join(snapshot.root, 'packages', 'cli', 'dist'),
      catalogOutputRoot: path.join(snapshot.root, 'packages', 'cli', 'plugins-dist'),
    });
    await expect(fs.readFile(path.join(snapshot.cliPackageRoot, 'package.json'), 'utf8'))
      .resolves.toContain('@lesliechan721/aw');
    const [sourcePackageStats, snapshotPackageStats] = await Promise.all([
      fs.stat(path.join(repoRoot, 'packages', 'cli', 'package.json')),
      fs.lstat(path.join(snapshot.cliPackageRoot, 'package.json')),
    ]);
    expect(snapshotPackageStats.isFile()).toBe(true);
    expect(snapshotPackageStats.isSymbolicLink()).toBe(false);
    expect(snapshotPackageStats.mode & 0o777).toBe(sourcePackageStats.mode & 0o777);
    await expect(computeBuildOutputDigest(snapshot.root)).resolves.toBe(built.outputDigest);
    await expect(snapshot.cleanup()).resolves.toBeUndefined();
    await expect(fs.stat(snapshot.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('materializes a symlinked canonical package as generation-bound regular bytes', async () => {
    const repoRoot = await createRepo();
    const canonicalPackagePath = path.join(repoRoot, 'packages', 'cli', 'package.json');
    const externalPackagePath = path.join(repoRoot, 'external-cli-package.json');
    const originalContents = JSON.stringify({
      name: '@lesliechan721/aw',
      type: 'module',
      version: '1.2.3',
      files: ['dist/'],
      publishConfig: { registry: 'https://registry.example.test' },
    });
    await fs.writeFile(externalPackagePath, originalContents, { mode: 0o640 });
    await fs.rm(canonicalPackagePath);
    await fs.symlink(externalPackagePath, canonicalPackagePath);
    const build = () => writeBuildOutputs(repoRoot);

    const snapshot = await createBuildSnapshot(repoRoot, { build });
    const snapshotPackagePath = path.join(snapshot.cliPackageRoot, 'package.json');
    const snapshotStats = await fs.lstat(snapshotPackagePath);
    expect(snapshotStats.isFile()).toBe(true);
    expect(snapshotStats.isSymbolicLink()).toBe(false);
    expect(snapshotStats.mode & 0o777).toBe(0o640);
    await expect(fs.readFile(snapshotPackagePath, 'utf8')).resolves.toBe(originalContents);
    await expect(fs.stat(path.join(repoRoot, '.release', 'cache', 'build-stamp.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    await fs.writeFile(externalPackagePath, JSON.stringify({
      name: '@lesliechan721/aw',
      version: '9.9.9',
      files: ['changed/'],
    }));
    await expect(fs.readFile(snapshotPackagePath, 'utf8')).resolves.toBe(originalContents);
    await snapshot.cleanup();
  });

  it('rejects package and non-package input changes during snapshot copy and cleans', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    const snapshotsRoot = path.join(repoRoot, '.release', 'build-snapshots');
    const packageJsonPath = path.join(repoRoot, 'packages', 'cli', 'package.json');

    await expect(createBuildSnapshot(repoRoot, {
      __testCopyPath: async (source: string, target: string, options?: { recursive?: boolean }) => {
        await fs.cp(source, target, options);
        if (source.endsWith(path.join('packages', 'cli', 'dist'))) {
          await fs.writeFile(packageJsonPath, JSON.stringify({
            name: '@lesliechan721/aw',
            type: 'module',
            version: '2.0.0',
            files: ['dist/', 'changed/'],
            publishConfig: { registry: 'https://changed.invalid' },
          }));
        }
      },
    })).rejects.toThrow('CLI package metadata changed while snapshot generation');
    await expect(fs.readdir(snapshotsRoot).catch(() => [])).resolves.toEqual([]);

    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot, 2) });
    await expect(createBuildSnapshot(repoRoot, {
      __testCopyPath: async (source: string, target: string, options?: { recursive?: boolean }) => {
        await fs.cp(source, target, options);
        if (source.endsWith(path.join('packages', 'cli', 'dist'))) {
          await fs.writeFile(path.join(repoRoot, 'plugins', 'demo', 'SKILL.md'), 'changed\n');
        }
      },
    })).rejects.toThrow('Build inputs changed while snapshot generation');
    await expect(fs.readdir(snapshotsRoot).catch(() => [])).resolves.toEqual([]);
  });

  it('rejects a symlink referent change during snapshot copy and cleans', async () => {
    const repoRoot = await createRepo();
    const referentPath = path.join(repoRoot, 'external-runtime.md');
    await fs.writeFile(referentPath, 'referent-one\n');
    await fs.symlink(
      referentPath,
      path.join(repoRoot, 'plugins', 'demo', 'runtime.md'),
    );
    const snapshotsRoot = path.join(repoRoot, '.release', 'build-snapshots');

    await expect(createBuildSnapshot(repoRoot, {
      build: () => writeBuildOutputs(repoRoot),
      __testCopyPath: async (source: string, target: string, options?: { recursive?: boolean }) => {
        await fs.cp(source, target, options);
        if (source.endsWith(path.join('packages', 'cli', 'dist'))) {
          await fs.writeFile(referentPath, 'referent-two\n');
        }
      },
    })).rejects.toThrow('Build inputs changed while snapshot generation');
    await expect(fs.readdir(snapshotsRoot).catch(() => [])).resolves.toEqual([]);
  });

  it('rejects snapshot symlinks outside its dependency link and cleans', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    const snapshotsRoot = path.join(repoRoot, '.release', 'build-snapshots');

    await expect(createBuildSnapshot(repoRoot, {
      __testCopyPath: async (source: string, target: string, options?: { recursive?: boolean }) => {
        await fs.cp(source, target, options);
        if (source.endsWith(path.join('packages', 'cli', 'plugins-dist'))) {
          await fs.symlink('package.json', path.join(path.dirname(target), 'extra-link'));
        }
      },
    })).rejects.toThrow(
      'Build snapshot contains unsupported symlink packages/cli/extra-link',
    );
    await expect(fs.readdir(snapshotsRoot).catch(() => [])).resolves.toEqual([]);
  });

  it('resolves real ESM dependencies through the POSIX snapshot node_modules link', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const repoRoot = await createRepo();
    const dependencyRoot = path.join(
      repoRoot,
      'packages',
      'cli',
      'node_modules',
      'snapshot-dependency',
    );
    await fs.mkdir(dependencyRoot, { recursive: true });
    await fs.writeFile(path.join(dependencyRoot, 'package.json'), JSON.stringify({
      name: 'snapshot-dependency',
      type: 'module',
      exports: './index.js',
    }));
    await fs.writeFile(path.join(dependencyRoot, 'index.js'), "export const value = 'linked';\n");
    const build = async () => {
      await writeBuildOutputs(repoRoot);
      await fs.writeFile(
        path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js'),
        "export { value } from 'snapshot-dependency';\n",
      );
    };
    await buildWithCache(repoRoot, { build });

    const snapshot = await createBuildSnapshot(repoRoot, { build });
    const snapshotNodeModules = path.join(snapshot.cliPackageRoot, 'node_modules');
    await expect(fs.realpath(snapshotNodeModules)).resolves.toBe(
      await fs.realpath(path.join(repoRoot, 'packages', 'cli', 'node_modules')),
    );
    const imported = await import(
      `${pathToFileURL(path.join(snapshot.cliDistRoot, 'index.js')).href}?test=${Math.random()}`
    ) as { value: string };
    expect(imported.value).toBe('linked');
    await snapshot.cleanup();
    await expect(fs.readFile(path.join(dependencyRoot, 'index.js'), 'utf8'))
      .resolves.toContain('linked');
  });

  it('requests a Windows junction for the snapshot dependency link', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    let linkCall: { source: string; target: string; type: string } | null = null;
    const snapshot = await createBuildSnapshot(repoRoot, {
      __testSnapshotPlatform: 'win32',
      __testCreateDependencyLink: async (source: string, target: string, type: string) => {
        linkCall = { source, target, type };
        await fs.symlink(source, target, 'dir');
      },
    });

    expect(linkCall).toEqual({
      source: path.join(repoRoot, 'packages', 'cli', 'node_modules'),
      target: path.join(snapshot.cliPackageRoot, 'node_modules'),
      type: 'junction',
    });
    await snapshot.cleanup();
  });

  it('fails clearly and cleans its snapshot when canonical dependencies are missing', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    await fs.rm(path.join(repoRoot, 'packages', 'cli', 'node_modules'), {
      recursive: true,
      force: true,
    });

    await expect(createBuildSnapshot(repoRoot)).rejects.toThrow(
      `missing CLI dependencies at ${path.join(repoRoot, 'packages', 'cli', 'node_modules')}`,
    );
    const snapshotsRoot = path.join(repoRoot, '.release', 'build-snapshots');
    await expect(fs.readdir(snapshotsRoot).catch(() => [])).resolves.toEqual([]);
  });

  it('does not copy snapshots during an ordinary warm ensure', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    let copyCount = 0;
    await expect(buildWithCache(repoRoot, {
      build: () => writeBuildOutputs(repoRoot, 2),
      __testCopyPath: async () => {
        copyCount += 1;
      },
    })).resolves.toMatchObject({ reused: true });
    expect(copyCount).toBe(0);
  });

  it('holds the build lock through snapshot copy and preserves the old generation', async () => {
    const repoRoot = await createRepo();
    let generation = 1;
    const initial = await buildWithCache(repoRoot, {
      build: () => writeBuildOutputs(repoRoot, generation),
    });
    const copyPaused = createDeferred<void>();
    const continueCopy = createDeferred<void>();
    const snapshotPromise = createBuildSnapshot(repoRoot, {
      build: () => writeBuildOutputs(repoRoot, generation),
      __testCopyPath: async (source: string, target: string, options?: { recursive?: boolean }) => {
        await fs.cp(source, target, options);
        if (source.endsWith(path.join('packages', 'cli', 'dist'))) {
          copyPaused.resolve();
          await continueCopy.promise;
        }
      },
    });
    await copyPaused.promise;

    let forceSettled = false;
    const forced = buildWithCache(repoRoot, {
      build: async () => {
        generation = 2;
        await writeBuildOutputs(repoRoot, generation);
      },
      force: true,
      lockTimeoutMs: 1_000,
      pollIntervalMs: 5,
    }).finally(() => {
      forceSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(forceSettled).toBe(false);
    continueCopy.resolve();

    const snapshot = await snapshotPromise;
    await forced;
    expect(snapshot.generationId).toBe(initial.generationId);
    await expect(computeBuildOutputDigest(snapshot.root)).resolves.toBe(initial.outputDigest);
    await expect(fs.readFile(path.join(snapshot.cliDistRoot, 'index.js'), 'utf8'))
      .resolves.toContain('generation = 1');
    await expect(fs.readFile(path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js'), 'utf8'))
      .resolves.toContain('generation = 2');
    await snapshot.cleanup();
  });

  it('cleans only its own snapshot after copy failure or digest mismatch', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    const snapshotsRoot = path.join(repoRoot, '.release', 'build-snapshots');
    const siblingRoot = path.join(snapshotsRoot, 'consumer-owned');
    await fs.mkdir(siblingRoot, { recursive: true });

    await expect(createBuildSnapshot(repoRoot, {
      __testCopyPath: async (source: string, target: string, options?: { recursive?: boolean }) => {
        if (source.endsWith('plugins-dist')) {
          throw new Error('copy failed');
        }
        await fs.cp(source, target, options);
      },
    })).rejects.toThrow('copy failed');
    expect((await fs.readdir(snapshotsRoot)).sort()).toEqual(['consumer-owned']);

    await expect(createBuildSnapshot(repoRoot, {
      __testCopyPath: async (source: string, target: string, options?: { recursive?: boolean }) => {
        await fs.cp(source, target, options);
        if (source.endsWith(path.join('packages', 'cli', 'dist'))) {
          await fs.writeFile(path.join(target, 'index.js'), 'corrupt\n');
        }
      },
    })).rejects.toThrow('Build snapshot digest mismatch');
    expect((await fs.readdir(snapshotsRoot)).sort()).toEqual(['consumer-owned']);
  });

  it('preserves a primary consumer error when snapshot cleanup also fails', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });
    let snapshotRoot = '';

    const error = await withBuildSnapshot(
      repoRoot,
      async (snapshot: { root: string }) => {
        snapshotRoot = snapshot.root;
        throw new Error('consumer failed');
      },
      {
        __testRemoveSnapshot: async () => {
          throw new Error('cleanup failed');
        },
      },
    ).then(() => null, (caught) => caught as AggregateError);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error?.message).toContain('consumer failed');
    expect(error?.message).toContain('cleanup failed');
    expect((error as AggregateError & { cause?: unknown }).cause).toMatchObject({
      message: 'consumer failed',
    });
    await expect(fs.stat(snapshotRoot)).resolves.toBeDefined();
    await fs.rm(snapshotRoot, { recursive: true, force: true });
  });

  it('preserves a copy error when failed snapshot cleanup also reports an error', async () => {
    const repoRoot = await createRepo();
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot) });

    const error = await createBuildSnapshot(repoRoot, {
      __testCopyPath: async () => {
        throw new Error('snapshot copy failed');
      },
      __testRemoveSnapshot: async () => {
        throw new Error('snapshot cleanup failed');
      },
    }).then(() => null, (caught) => caught as AggregateError);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error?.message).toContain('snapshot copy failed');
    expect(error?.message).toContain('snapshot cleanup failed');
    expect((error as AggregateError & { cause?: unknown }).cause).toMatchObject({
      message: 'snapshot copy failed',
    });
    await fs.rm(path.join(repoRoot, '.release', 'build-snapshots'), {
      recursive: true,
      force: true,
    });
  });

  it('does not hold the build lock while a consumer cleanup is pending', async () => {
    const repoRoot = await createRepo();
    let generation = 1;
    await buildWithCache(repoRoot, { build: () => writeBuildOutputs(repoRoot, generation) });
    const cleanupStarted = createDeferred<void>();
    const continueCleanup = createDeferred<void>();
    const snapshot = await createBuildSnapshot(repoRoot, {
      __testRemoveSnapshot: async (target: string) => {
        cleanupStarted.resolve();
        await continueCleanup.promise;
        await fs.rm(target, { recursive: true, force: true });
      },
    });

    const cleanup = snapshot.cleanup();
    await cleanupStarted.promise;
    const forced = buildWithCache(repoRoot, {
      build: async () => {
        generation = 2;
        await writeBuildOutputs(repoRoot, generation);
      },
      force: true,
      lockTimeoutMs: 500,
      pollIntervalMs: 5,
    });
    await expect(forced).resolves.toMatchObject({ reused: false });
    continueCleanup.resolve();
    await expect(cleanup).resolves.toBeUndefined();
  });
});
