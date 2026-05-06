import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { runPluginScriptTests } from '../../scripts/test-plugin-scripts.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeTempRepo(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-test-runner-'));
  tempDirs.push(tempDir);
  await fs.copy(fixturePath('repo-template'), tempDir);
  return tempDir;
}

async function readManifest(repoRoot: string): Promise<Record<string, unknown>> {
  return fs.readJson(path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json'));
}

function pluginRoot(repoRoot: string): string {
  return path.join(repoRoot, 'plugins', 'git-commit');
}

function pluginManifestPath(repoRoot: string): string {
  return path.join(pluginRoot(repoRoot), '.agents-plugin', 'plugin.json');
}

function pluginScriptPath(repoRoot: string, fileName: string): string {
  return path.join(pluginRoot(repoRoot), 'scripts', fileName);
}

async function writeManifest(repoRoot: string, manifest: Record<string, unknown>): Promise<void> {
  await fs.writeJson(pluginManifestPath(repoRoot), manifest, { spaces: 2 });
}

async function configureTestManifest(options: {
  repoRoot: string;
  products?: string[];
  testEntries: string[];
  buildPath?: string;
}): Promise<void> {
  const manifest = await readManifest(options.repoRoot);
  const marketplace = manifest.marketplace as Record<string, unknown>;
  const policy = marketplace.policy as Record<string, unknown>;
  policy.products = options.products;
  if (options.products && !options.products.includes('CODEX')) {
    delete manifest.apps;
    await fs.remove(path.join(pluginRoot(options.repoRoot), '.app.json'));
  }
  manifest.scripts = {
    tests: {
      node: options.testEntries,
    },
    ...(options.buildPath
      ? {
          node: {
            build: {
              runner: 'node',
              path: options.buildPath,
            },
          },
        }
      : {}),
  };
  await writeManifest(options.repoRoot, manifest);
}

async function writeNodeTestFile(repoRoot: string, fileName: string, source: string): Promise<void> {
  await fs.outputFile(pluginScriptPath(repoRoot, fileName), source, 'utf8');
}

async function writePlatformProbeTest(repoRoot: string, fileName: string): Promise<void> {
  await writeNodeTestFile(
    repoRoot,
    fileName,
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { readFile } from "node:fs/promises";',
      'test("platform probe", async () => {',
      '  const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      '  assert.equal(context.platform, process.env.AW_PLUGIN_PLATFORM);',
      '  console.log(`platform=${context.platform}`);',
      '});',
    ].join('\n'),
  );
}

async function writeProductRewriteBuild(repoRoot: string, fileName: string, products: string[]): Promise<void> {
  await writeNodeTestFile(
    repoRoot,
    fileName,
    [
      'import { readFile, writeFile } from "node:fs/promises";',
      '',
      'const manifestUrl = new URL("../.agents-plugin/plugin.json", import.meta.url);',
      'const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));',
      `manifest.marketplace.policy.products = ${JSON.stringify(products)};`,
      'await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\\n`, "utf8");',
    ].join('\n'),
  );
}

function captureOutput(): {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdout: () => string;
  readStderr: () => string;
} {
  let stdout = '';
  let stderr = '';
  return {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readStdout: () => stdout,
    readStderr: () => stderr,
  };
}

async function addInvalidNeighborPlugin(repoRoot: string): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', 'bad-neighbor');
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.writeJson(
    path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    {
      name: 'bad-neighbor',
      version: '0.1.0',
      description: 'Bad neighbor',
      marketplace: {
        category: 'test',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
        },
      },
      scripts: {
        lifecycle: {
          install: './scripts/missing.mjs --inline',
        },
      },
    },
    { spaces: 2 },
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin script test runner', () => {
  it('loads staging helpers through the scripts layer instead of importing src directly', async () => {
    const source = await fs.readFile(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'scripts',
        'test-plugin-scripts.ts',
      ),
      'utf8',
    );

    expect(source).toContain('./plugin-staging.js');
    expect(source).not.toContain('../src/');
  });

  it('skips plugins with no matching node test entries', async () => {
    const repoRoot = await makeTempRepo();
    const manifest = await readManifest(repoRoot);
    manifest.scripts = {
      tests: {
        node: ['./scripts/*.test.mjs'],
      },
    };
    await writeManifest(repoRoot, manifest);
    const output = captureOutput();

    await expect(runPluginScriptTests(['git-commit'], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    })).resolves.toBe(0);
    expect(output.readStdout()).toContain('skipped (no tests matched)');
    expect(output.readStderr()).toBe('');
  });

  it('accepts the pnpm argument separator used by the package script', async () => {
    const repoRoot = await makeTempRepo();
    const manifest = await readManifest(repoRoot);
    manifest.scripts = {
      tests: {
        node: ['./scripts/*.test.mjs'],
      },
    };
    await writeManifest(repoRoot, manifest);
    const output = captureOutput();

    await expect(runPluginScriptTests(['--', 'git-commit'], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    })).resolves.toBe(0);
    expect(output.readStdout()).toContain('skipped (no tests matched)');
    expect(output.readStderr()).toBe('');
  });

  it('runs only the requested plugin in single-plugin mode', async () => {
    const repoRoot = await makeTempRepo();
    await addInvalidNeighborPlugin(repoRoot);
    const manifest = await readManifest(repoRoot);
    manifest.scripts = {
      tests: {
        node: ['./scripts/context.test.mjs'],
      },
    };
    await writeManifest(repoRoot, manifest);
    await fs.outputFile(
      path.join(repoRoot, 'plugins', 'git-commit', 'scripts', 'context.test.mjs'),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { readFile } from "node:fs/promises";',
        'test("context", async () => {',
        '  const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
        '  assert.equal(context.event, "test");',
        '  assert.equal(context.platform, "codex");',
        '  assert.equal(context.scope, "user");',
        '  assert.equal(process.cwd(), context.cwd);',
        '  assert.notEqual(context.plugin.rootDir, context.sourceRoot);',
        '});',
      ].join('\n'),
      'utf8',
    );
    const output = captureOutput();

    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'codex'], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
      env: { ...process.env, PATH: process.env.PATH ?? '' } as NodeJS.ProcessEnv,
    });
    expect(exitCode, `${output.readStdout()}\n${output.readStderr()}`).toBe(0);
    expect(output.readStdout()).toContain('git-commit / codex: passed');
    expect(output.readStderr()).not.toContain('bad-neighbor');
  });

  it('passes scope and test-name through both platform runs with isolated homes and bundles', async () => {
    const repoRoot = await makeTempRepo();
    const manifest = await readManifest(repoRoot);
    manifest.scripts = {
      tests: {
        node: ['./scripts/platform-isolation.test.mjs'],
      },
    };
    await writeManifest(repoRoot, manifest);
    await fs.outputFile(
      path.join(repoRoot, 'plugins', 'git-commit', 'scripts', 'platform-isolation.test.mjs'),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import os from "node:os";',
        'import path from "node:path";',
        'import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";',
        'async function exists(file) {',
        '  try {',
        '    await access(file);',
        '    return true;',
        '  } catch {',
        '    return false;',
        '  }',
        '}',
        'test("selected lifecycle view", async () => {',
        '  const contextPath = process.env.AW_PLUGIN_CONTEXT;',
        '  const context = JSON.parse(await readFile(contextPath, "utf8"));',
        '  const testTempDir = path.dirname(contextPath);',
        '  const marker = path.join(process.env.AW_PLUGIN_ROOT, "platform-marker.txt");',
        '  assert.equal(context.scope, "project");',
        '  assert.equal(process.env.AW_PLUGIN_SCOPE, "project");',
        '  assert.equal(context.platform, process.env.AW_PLUGIN_PLATFORM);',
        '  assert.equal(process.cwd(), context.cwd);',
        '  assert.equal(os.homedir(), path.join(testTempDir, "home"));',
        '  assert.equal(os.tmpdir(), path.join(testTempDir, "tmp"));',
        '  await writeFile(path.join(os.homedir(), "home-marker.txt"), "ok", "utf8");',
        '  const createdTemp = await mkdtemp(path.join(os.tmpdir(), "probe-"));',
        '  assert.equal(await exists(createdTemp), true);',
        '  if (process.env.AW_PLUGIN_PLATFORM === "codex") {',
        '    assert.equal(await exists(marker), false);',
        '    await writeFile(marker, "codex", "utf8");',
        '  } else {',
        '    assert.equal(process.env.AW_PLUGIN_PLATFORM, "claude");',
        '    assert.equal(await exists(marker), false);',
        '    await writeFile(marker, "claude", "utf8");',
        '  }',
        '});',
        'test("excluded failing test", () => {',
        '  assert.fail("test-name filtering did not apply");',
        '});',
      ].join('\n'),
      'utf8',
    );
    const output = captureOutput();

    const exitCode = await runPluginScriptTests([
      'git-commit',
      '--platform',
      'both',
      '--scope',
      'project',
      '--test-name',
      'selected lifecycle view',
    ], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? '',
        HOME: path.join(repoRoot, 'host-home'),
        TMPDIR: path.join(repoRoot, 'host-tmp'),
      } as NodeJS.ProcessEnv,
    });

    expect(exitCode, `${output.readStdout()}\n${output.readStderr()}`).toBe(0);
    expect(output.readStdout()).toContain('git-commit / codex: passed');
    expect(output.readStdout()).toContain('git-commit / claude: passed');
    expect(output.readStderr()).toBe('');
  });

  it('uses the staging manifest supported platforms for --platform auto on codex-only plugins', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      products: ['CODEX'],
      testEntries: ['./scripts/platform-probe.test.mjs'],
    });
    await writePlatformProbeTest(repoRoot, 'platform-probe.test.mjs');
    const output = captureOutput();

    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'auto'], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
      env: { ...process.env, PATH: process.env.PATH ?? '' } as NodeJS.ProcessEnv,
    });

    expect(exitCode, `${output.readStdout()}\n${output.readStderr()}`).toBe(0);
    expect(output.readStdout()).toContain('git-commit / codex: passed');
    expect(output.readStdout()).not.toContain('git-commit / claude');
    expect(output.readStderr()).toBe('');
  });

  it('uses the staging manifest supported platforms for --platform auto on claude-only plugins', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      products: ['CLAUDE'],
      testEntries: ['./scripts/platform-probe.test.mjs'],
    });
    await writePlatformProbeTest(repoRoot, 'platform-probe.test.mjs');
    const output = captureOutput();

    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'auto'], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
      env: { ...process.env, PATH: process.env.PATH ?? '' } as NodeJS.ProcessEnv,
    });

    expect(exitCode, `${output.readStdout()}\n${output.readStderr()}`).toBe(0);
    expect(output.readStdout()).toContain('git-commit / claude: passed');
    expect(output.readStdout()).not.toContain('git-commit / codex');
    expect(output.readStderr()).toBe('');
  });

  it('uses the full staging manifest supported platform set for --platform auto on dual-platform plugins', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      products: ['CODEX', 'CLAUDE'],
      testEntries: ['./scripts/platform-probe.test.mjs'],
    });
    await writePlatformProbeTest(repoRoot, 'platform-probe.test.mjs');
    const output = captureOutput();

    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'auto'], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
      env: { ...process.env, PATH: process.env.PATH ?? '' } as NodeJS.ProcessEnv,
    });

    expect(exitCode, `${output.readStdout()}\n${output.readStderr()}`).toBe(0);
    expect(output.readStdout()).toContain('git-commit / codex: passed');
    expect(output.readStdout()).toContain('git-commit / claude: passed');
    expect(output.readStderr()).toBe('');
  });

  it('fails fast for unsupported explicit platform selections before runtime bundling', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      products: ['CODEX'],
      testEntries: ['./scripts/missing-platform-probe.test.mjs'],
    });
    const output = captureOutput();

    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'claude'], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
      env: { ...process.env, PATH: process.env.PATH ?? '' } as NodeJS.ProcessEnv,
    });

    expect(exitCode).toBe(1);
    expect(output.readStdout()).toBe('');
    expect(output.readStderr()).toContain('Cannot run plugin tests for "git-commit" with --platform=claude');
    expect(output.readStderr()).toContain('marketplace.policy.products=[CODEX]');
    expect(output.readStderr()).toContain('supported platforms=codex');
    expect(output.readStderr()).not.toContain('missing-platform-probe');
  });

  it('rejects --platform both for codex-only plugins', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      products: ['CODEX'],
      testEntries: ['./scripts/platform-probe.test.mjs'],
    });
    await writePlatformProbeTest(repoRoot, 'platform-probe.test.mjs');
    const output = captureOutput();

    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'both'], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(1);
    expect(output.readStderr()).toContain('Cannot run plugin tests for "git-commit" with --platform=both');
    expect(output.readStderr()).toContain('marketplace.policy.products=[CODEX]');
    expect(output.readStderr()).toContain('supported platforms=codex');
  });

  it('rejects unsupported explicit codex and both selections for claude-only plugins', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      products: ['CLAUDE'],
      testEntries: ['./scripts/platform-probe.test.mjs'],
    });
    await writePlatformProbeTest(repoRoot, 'platform-probe.test.mjs');

    const codexOutput = captureOutput();
    const codexExitCode = await runPluginScriptTests(['git-commit', '--platform', 'codex'], {
      repoRoot,
      stdout: codexOutput.stdout,
      stderr: codexOutput.stderr,
    });
    expect(codexExitCode).toBe(1);
    expect(codexOutput.readStderr()).toContain('Cannot run plugin tests for "git-commit" with --platform=codex');
    expect(codexOutput.readStderr()).toContain('marketplace.policy.products=[CLAUDE]');
    expect(codexOutput.readStderr()).toContain('supported platforms=claude');

    const bothOutput = captureOutput();
    const bothExitCode = await runPluginScriptTests(['git-commit', '--platform', 'both'], {
      repoRoot,
      stdout: bothOutput.stdout,
      stderr: bothOutput.stderr,
    });
    expect(bothExitCode).toBe(1);
    expect(bothOutput.readStderr()).toContain('Cannot run plugin tests for "git-commit" with --platform=both');
    expect(bothOutput.readStderr()).toContain('marketplace.policy.products=[CLAUDE]');
    expect(bothOutput.readStderr()).toContain('supported platforms=claude');
  });

  it('uses the staging manifest products when source and staging products differ', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      products: ['CLAUDE'],
      testEntries: ['./scripts/platform-probe.test.mjs'],
      buildPath: './scripts/rewrite-products.mjs',
    });
    await writePlatformProbeTest(repoRoot, 'platform-probe.test.mjs');
    await writeProductRewriteBuild(repoRoot, 'rewrite-products.mjs', ['CODEX']);
    const output = captureOutput();

    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'auto'], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
      env: { ...process.env, PATH: process.env.PATH ?? '' } as NodeJS.ProcessEnv,
    });

    expect(exitCode, `${output.readStdout()}\n${output.readStderr()}`).toBe(0);
    expect(output.readStdout()).toContain('git-commit / codex: passed');
    expect(output.readStdout()).not.toContain('git-commit / claude');
    expect(output.readStderr()).toBe('');
    await expect(readManifest(repoRoot)).resolves.toMatchObject({
      marketplace: {
        policy: {
          products: ['CLAUDE'],
        },
      },
    });
  });

  it('rejects undeclared bare package imports in tests without scripts.node', async () => {
    const repoRoot = await makeTempRepo();
    const manifest = await readManifest(repoRoot);
    manifest.scripts = {
      tests: {
        node: ['./scripts/bare.test.mjs'],
      },
    };
    await writeManifest(repoRoot, manifest);
    await fs.outputFile(
      path.join(repoRoot, 'plugins', 'git-commit', 'scripts', 'bare.test.mjs'),
      'import YAML from "yaml";\n',
      'utf8',
    );
    const output = captureOutput();

    await expect(runPluginScriptTests(['git-commit'], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    })).resolves.toBe(1);
    expect(output.readStderr()).toContain('Runtime import "yaml"');
  });

  it('redacts sensitive config values from node test output and failures', async () => {
    const repoRoot = await makeTempRepo();
    const manifest = await readManifest(repoRoot);
    manifest.config = {
      schema: {
        token: {
          type: 'string',
          sensitive: true,
          default: 'super-secret-plugin-token',
        },
        pin: {
          type: 'number',
          sensitive: true,
          default: 8675309,
        },
        enabled: {
          type: 'boolean',
          sensitive: true,
          default: true,
        },
      },
    };
    manifest.scripts = {
      tests: {
        node: ['./scripts/redact.test.mjs'],
      },
    };
    await writeManifest(repoRoot, manifest);
    await fs.outputFile(
      path.join(repoRoot, 'plugins', 'git-commit', 'scripts', 'redact.test.mjs'),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { readFile } from "node:fs/promises";',
        'test("redacts config", async () => {',
        '  const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
        '  const token = context.config.values.token;',
        '  const pin = context.config.values.pin;',
        '  const enabled = context.config.values.enabled;',
        '  console.log(`token=${token} pin=${pin} enabled=${enabled}`);',
        '  console.error(`token=${token} pin=${pin} enabled=${enabled}`);',
        '  assert.equal(token, "different-token");',
        '});',
      ].join('\n'),
      'utf8',
    );
    const output = captureOutput();

    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'codex'], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
      env: { ...process.env, PATH: process.env.PATH ?? '' } as NodeJS.ProcessEnv,
    });

    expect(exitCode).toBe(1);
    const combinedOutput = `${output.readStdout()}\n${output.readStderr()}`;
    expect(combinedOutput).not.toContain('super-secret-plugin-token');
    expect(combinedOutput).not.toContain('8675309');
    expect(combinedOutput).not.toContain('enabled=true');
    expect(combinedOutput).toContain('token=[REDACTED] pin=[REDACTED] enabled=[REDACTED]');
  });
});
