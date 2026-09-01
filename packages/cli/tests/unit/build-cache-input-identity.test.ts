import {
  acquireBuildLock,
  afterEach,
  buildCacheContract,
  buildWithCache,
  computeBuildInputDigest,
  computeBuildOutputDigest,
  createBuildSnapshot,
  createDeferred,
  createRepo,
  describe,
  expect,
  fs,
  fsSync,
  inspectBuildCache,
  it,
  originalNpmExecPath,
  originalNpmUserAgent,
  os,
  path,
  pathToFileURL,
  resolvePnpmInvocation,
  tempDirs,
  vi,
  withBuildSnapshot,
  writeBuildOutputs,
  writeRequiredOutputs,
} from './build-cache.test-helper.js';
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
    const nestedEvalPath = path.join(
      repoRoot,
      'plugins',
      'demo',
      'skills',
      'demo',
      'base',
      'evals',
      'private.json',
    );
    const dependencyPath = path.join(repoRoot, 'plugins', 'demo', 'node_modules', 'dep', 'index.js');
    const nestedDistPath = path.join(repoRoot, 'plugins', 'demo', 'runtime', 'dist', 'index.js');
    await fs.mkdir(path.dirname(evalPath), { recursive: true });
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.mkdir(path.dirname(nestedEvalPath), { recursive: true });
    await fs.mkdir(path.dirname(dependencyPath), { recursive: true });
    await fs.mkdir(path.dirname(nestedDistPath), { recursive: true });
    await fs.writeFile(evalPath, 'eval-one\n');
    await fs.writeFile(reportPath, 'report-one\n');
    await fs.writeFile(nestedEvalPath, 'nested-eval-one\n');
    await fs.writeFile(dependencyPath, 'dependency-one\n');
    await fs.writeFile(nestedDistPath, 'nested-one\n');
    await fs.symlink('SKILL.md', linkPath);

    const initialDigest = await computeBuildInputDigest(repoRoot);
    await fs.utimes(skillPath, new Date(), new Date());
    expect(await computeBuildInputDigest(repoRoot)).toBe(initialDigest);

    await fs.writeFile(evalPath, 'eval-two\n');
    await fs.writeFile(reportPath, 'report-two\n');
    await fs.writeFile(nestedEvalPath, 'nested-eval-two\n');
    await fs.writeFile(dependencyPath, 'dependency-two\n');
    expect(await computeBuildInputDigest(repoRoot)).toBe(initialDigest);

    await fs.writeFile(nestedDistPath, 'nested-two\n');
    expect(await computeBuildInputDigest(repoRoot)).not.toBe(initialDigest);

    const nestedDigest = await computeBuildInputDigest(repoRoot);
    await fs.unlink(linkPath);
    await fs.symlink('other.md', linkPath);
    expect(await computeBuildInputDigest(repoRoot)).not.toBe(nestedDigest);
  });

  it('invalidates the build cache when a canonical Eval schema changes', async () => {
    const repoRoot = await createRepo();
    const schemaPath = path.join(
      repoRoot,
      'packages',
      'agent-skill-eval',
      'schemas',
      'eval-result.schema.json',
    );
    await fs.writeFile(schemaPath, '{"version":1}\n');
    const initialDigest = await computeBuildInputDigest(repoRoot);
    await fs.writeFile(schemaPath, '{"version":1,"title":"changed"}\n');
    await expect(computeBuildInputDigest(repoRoot)).resolves.not.toBe(initialDigest);
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
      args: [
        path.resolve('/tmp/pnpm.cjs'),
        '--filter',
        '@lesliechan721/agent-skill-eval',
        '--filter',
        '@lesliechan721/aw-plugin-core',
        '--filter',
        '@lesliechan721/aw',
        'build',
      ],
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
      schemaVersion: 9,
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
      "fs.mkdirSync('packages/agent-skill-eval/dist/schemas', { recursive: true });",
      "fs.writeFileSync('packages/agent-skill-eval/dist/index.js', 'export {};\\n');",
      "fs.writeFileSync('packages/agent-skill-eval/dist/bin.js', 'export {};\\n');",
      "fs.writeFileSync('packages/agent-skill-eval/dist/schemas/digests.json', '{}\\n');",
      "fs.mkdirSync('packages/plugin-core/dist', { recursive: true });",
      "fs.writeFileSync('packages/plugin-core/dist/index.js', 'export {};\\n');",
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

    await fs.writeFile(manifestPath, JSON.stringify({
      name: 'demo',
      buildConfig: { cacheable: false },
      scripts: { node: { build: ['node', 'build.mjs'] } },
    }));
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
      reason: 'reuse disabled: plugin demo declares scripts.node.build',
    });
    expect(buildCount).toBe(4);
    await expect(fs.stat(path.join(repoRoot, '.release', 'cache', 'build-stamp.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reuses only an explicitly cacheable plugin build and rebuilds for projection inputs', async () => {
    const repoRoot = await createRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'demo');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const buildScriptPath = path.join(pluginRoot, 'scripts', 'build.mjs');
    const providerPath = path.join(repoRoot, 'plugins', 'provider', 'standards', 'rules.json');
    const providerManifestPath = path.join(
      repoRoot,
      'plugins',
      'provider',
      '.agents-plugin',
      'plugin.json',
    );
    const cliSourceInputPath = path.join(
      repoRoot,
      'packages',
      'cli',
      'src',
      'utils',
      'registered-input.ts',
    );
    const sharedPackageInputPath = path.join(
      repoRoot,
      'packages',
      'agent-skill-eval',
      'src',
      'shared-contract.ts',
    );
    await Promise.all([
      fs.mkdir(path.dirname(manifestPath), { recursive: true }),
      fs.mkdir(path.dirname(buildScriptPath), { recursive: true }),
      fs.mkdir(path.dirname(providerPath), { recursive: true }),
      fs.mkdir(path.dirname(providerManifestPath), { recursive: true }),
      fs.mkdir(path.dirname(cliSourceInputPath), { recursive: true }),
      fs.mkdir(path.dirname(sharedPackageInputPath), { recursive: true }),
    ]);
    await fs.writeFile(manifestPath, JSON.stringify({
      name: 'demo',
      buildConfig: {
        cacheable: true,
        buildImports: [
          { plugin: 'provider', export: 'rules', env: 'AW_PLUGIN_IMPORT_RULES' },
        ],
      },
      scripts: { node: { build: { runner: 'node', path: './scripts/build.mjs' } } },
    }));
    await fs.writeFile(providerManifestPath, JSON.stringify({
      name: 'provider',
      buildConfig: {
        runtimeExports: [{
          name: 'rules', source: './standards/rules.json',
          requires: { aw: { capabilities: [] } },
        }],
      },
    }));
    await fs.writeFile(buildScriptPath, 'export const build = 1;\n');
    await fs.writeFile(providerPath, '{"rule":1}\n');
    await fs.writeFile(cliSourceInputPath, 'export const registeredInput = 1;\n');
    await fs.writeFile(sharedPackageInputPath, 'export const sharedContract = 1;\n');

    let buildCount = 0;
    const build = async () => {
      buildCount += 1;
      await writeBuildOutputs(repoRoot, buildCount);
    };
    await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
      reused: false,
    });
    await fs.utimes(buildScriptPath, new Date(), new Date());
    const originalNoise = process.env.AW_BUILD_CACHE_TEST_NOISE;
    process.env.AW_BUILD_CACHE_TEST_NOISE = 'ignored';
    try {
      await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
        reused: true,
        reason: 'stamp and output tree match',
      });
    } finally {
      if (originalNoise === undefined) {
        delete process.env.AW_BUILD_CACHE_TEST_NOISE;
      } else {
        process.env.AW_BUILD_CACHE_TEST_NOISE = originalNoise;
      }
    }

    for (const [changedPath, contents] of [
      [buildScriptPath, 'export const build = 2;\n'],
      [providerPath, '{"rule":2}\n'],
      [cliSourceInputPath, 'export const registeredInput = 2;\n'],
      [sharedPackageInputPath, 'export const sharedContract = 2;\n'],
    ] as const) {
      await fs.writeFile(changedPath, contents);
      await expect(buildWithCache(repoRoot, { build })).resolves.toMatchObject({
        reused: false,
        reason: 'inputDigest changed',
      });
    }
    expect(buildCount).toBe(5);
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
