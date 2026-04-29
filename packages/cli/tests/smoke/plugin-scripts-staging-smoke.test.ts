import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeTempRepo(): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-scripts-smoke-'));
  tempDirs.push(tempRoot);
  const tempRepo = path.join(tempRoot, 'repo');
  await fs.copy(fixturePath('repo-template'), tempRepo);
  return tempRepo;
}

function packageLockfile(): string {
  return [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: true',
    '  excludeLinksFromLockfile: false',
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      yaml:',
    '        specifier: 2.8.3',
    '        version: 2.8.3',
    '    devDependencies:',
    '      chalk:',
    '        specifier: 5.6.2',
    '        version: 5.6.2',
    '',
    'packages:',
    '',
    '  chalk@5.6.2:',
    '    resolution: {integrity: sha512-7NzBL0rN6fMUW+f7A6Io4h40qQlG+xGmtMxfbnH/K7TAtt8JQWVQK+6g0UXKMeVJoyV5EkkNsErQ8pVD3bLHbA==}',
    '    engines: {node: ^12.17.0 || ^14.13 || >=16.0.0}',
    '',
    '  yaml@2.8.3:',
    '    resolution: {integrity: sha512-AvbaCLOO2Otw/lW5bmh9d/WEdcDFdQp2Z2ZUH3pX9U2ihyUY0nvLv7J6TrWowklRGPYbB/IuIMfYgxaCPg5Bpg==}',
    "    engines: {node: '>= 14.6'}",
    '    hasBin: true',
    '',
    'snapshots:',
    '',
    '  chalk@5.6.2: {}',
    '',
    '  yaml@2.8.3: {}',
    '',
  ].join('\n');
}

async function writeNodeScriptFixture(repoRootPath: string): Promise<void> {
  const pluginRoot = path.join(repoRootPath, 'plugins', 'git-commit');
  const scriptsRoot = path.join(pluginRoot, 'scripts');
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);

  manifest.marketplace.policy.products = ['CLAUDE'];
  manifest.scripts = {
    lifecycle: {
      install: {
        default: {
          runner: 'node',
          path: './scripts/runtime.mjs',
        },
      },
    },
    node: {
      packageRoot: './scripts',
      build: {
        runner: 'node',
        path: './scripts/build.mjs',
      },
    },
    tests: {
      node: ['./scripts/source-only.test.mjs'],
    },
  };

  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.ensureDir(scriptsRoot);
  await fs.writeJson(
    path.join(scriptsRoot, 'package.json'),
    {
      name: 'git-commit-smoke-scripts',
      version: '0.1.0',
      type: 'module',
      dependencies: {
        yaml: '2.8.3',
      },
      devDependencies: {
        chalk: '5.6.2',
      },
    },
    { spaces: 2 },
  );
  await fs.writeFile(path.join(scriptsRoot, 'pnpm-lock.yaml'), packageLockfile(), 'utf8');
  await fs.writeFile(
    path.join(scriptsRoot, 'runtime-helper.mjs'),
    'export const runtimeSuffix = "runtime-helper";\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(scriptsRoot, 'runtime.mjs'),
    [
      'import YAML from "yaml";',
      'import { runtimeSuffix } from "./runtime-helper.mjs";',
      '',
      'export function parseSmokeConfig(source) {',
      '  const parsed = YAML.parse(source);',
      '  return `${parsed.name}:${runtimeSuffix}`;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(scriptsRoot, 'source-only.test.mjs'),
    'throw new Error("source test glob should have been replaced by the manifest build");\n',
    'utf8',
  );

  const generatedTestSource = [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { readFile } from "node:fs/promises";',
    'import chalk from "chalk";',
    'import { parseSmokeConfig } from "./runtime.mjs";',
    '',
    'test("staged smoke generated test", async () => {',
    '  const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
    '  assert.equal(context.plugin.name, "git-commit");',
    '  assert.equal(context.platform, "codex");',
    '  assert.equal(context.plugin.version, "0.1.0");',
    '  assert.equal(process.cwd(), context.cwd);',
    '  assert.notEqual(context.plugin.rootDir, context.sourceRoot);',
    '  assert.equal(parseSmokeConfig("name: smoke\\n"), "smoke:runtime-helper");',
    '  assert.equal(chalk.bold("dev-dependency").includes("dev-dependency"), true);',
    '});',
    '',
  ].join('\n');

  await fs.writeFile(
    path.join(scriptsRoot, 'build.mjs'),
    [
      'import chalk from "chalk";',
      'import { readFile, writeFile } from "node:fs/promises";',
      '',
      'const manifestUrl = new URL("../.agents-plugin/plugin.json", import.meta.url);',
      'const generatedTestUrl = new URL("./generated.test.mjs", import.meta.url);',
      'const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));',
      '',
      'if (!chalk.green("build-dependency").includes("build-dependency")) {',
      '  throw new Error("dev dependency was not available to the manifest build");',
      '}',
      '',
      `await writeFile(generatedTestUrl, ${JSON.stringify(generatedTestSource)}, "utf8");`,
      'manifest.description = "Built smoke description";',
      'manifest.marketplace.policy.products = ["CODEX"];',
      'manifest.scripts.tests.node = ["./scripts/generated.test.mjs"];',
      'await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\\n`, "utf8");',
      '',
    ].join('\n'),
    'utf8',
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin scripts staging smoke', () => {
  it('runs real scripts.node staging through the package plugin:test entry', async () => {
    const root = repoRoot();
    const tempRepo = await makeTempRepo();
    await writeNodeScriptFixture(tempRepo);

    const result = await execFileAsync(
      'pnpm',
      ['plugin:test', 'git-commit', '--platform', 'auto', '--test-name', 'staged smoke generated test'],
      {
        cwd: root,
        env: {
          ...process.env,
          AW_PLUGIN_TEST_REPO_ROOT: tempRepo,
          NO_COLOR: '1',
        },
        maxBuffer: 30 * 1024 * 1024,
        timeout: 120_000,
      },
    );

    expect(result.stdout).toContain('git-commit / codex: passed');
    expect(result.stdout).not.toContain('git-commit / claude');
    expect(result.stderr).toBe('');

    await expect(
      fs.pathExists(path.join(tempRepo, 'plugins', 'git-commit', 'scripts', 'generated.test.mjs')),
    ).resolves.toBe(false);
    await expect(
      fs.readJson(path.join(tempRepo, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      description: expect.not.stringContaining('Built smoke description'),
      marketplace: {
        policy: {
          products: ['CLAUDE'],
        },
      },
      scripts: {
        tests: {
          node: ['./scripts/source-only.test.mjs'],
        },
      },
    });
  }, 120_000);
});
