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
          authentication: 'ON_INSTALL',
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

async function clonePlugin(repoRoot: string, sourceName: string, targetName: string): Promise<void> {
  const sourceRoot = path.join(repoRoot, 'plugins', sourceName);
  const targetRoot = path.join(repoRoot, 'plugins', targetName);
  await fs.copy(sourceRoot, targetRoot);
  const manifestPath = path.join(targetRoot, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  manifest.name = targetName;
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

async function writeMarkerTest(repoRoot: string, pluginName: string, fileName: string): Promise<void> {
  await fs.outputFile(
    path.join(repoRoot, 'plugins', pluginName, 'scripts', fileName),
    [
      'import test from "node:test";',
      'import { readFile, writeFile } from "node:fs/promises";',
      'import path from "node:path";',
      'test("marker", async () => {',
      '  const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      '  await writeFile(path.join(context.sourceRoot, "test-ran.marker"), "ran", "utf8");',
      '});',
    ].join('\n'),
    'utf8',
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin script test runner', () => {
  // Test Value Gate: CI file shards must cover every installed test exactly
  // once, including non-ASCII names, and preserve a selected test's failure.
  it('runs disjoint Node file shards without omissions and propagates failures', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      products: ['CODEX'],
      testEntries: ['./scripts/shard-*.test.mjs'],
    });
    const marker = path.join(pluginRoot(repoRoot), 'shard-events');
    for (let id = 0; id < 5; id += 1) {
      await writeNodeTestFile(repoRoot, `shard-${id}.test.mjs`, [
        'import test from "node:test";',
        'import fs from "node:fs";',
        'import path from "node:path";',
        `test("中文与标点 / case ${id}", () => {`,
        '  const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
        `  fs.appendFileSync(path.join(context.sourceRoot, "shard-events"), "${id}\\n");`,
        `  if (${id} === 0 && fs.existsSync(path.join(context.sourceRoot, "fail-selected"))) throw new Error("selected shard failure");`,
        '});',
      ].join('\n'));
    }
    for (const fail of [false, true]) {
      await fs.remove(marker);
      if (fail) await fs.writeFile(path.join(pluginRoot(repoRoot), 'fail-selected'), '');
      let failures = 0;
      let completed = 0;
      for (let index = 1; index <= 3; index += 1) {
        const output = captureOutput();
        const args = index === 1 ? ['--test-shard', '1/3'] : [`--test-shard=${index}/3`];
        const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'codex', ...args], {
          repoRoot,
          env: { ...process.env, AW_TEST_WORKERS: '1' },
          stdout: output.stdout,
          stderr: output.stderr,
        });
        if (exitCode !== 0) {
          failures += 1;
          expect(output.readStdout()).toContain('selected shard failure');
        } else {
          expect(output.readStdout()).toContain(`passed (test shard ${index}/3)`);
        }
        const events = (await fs.readFile(marker, 'utf8')).trim().split('\n');
        expect(events.length).toBeGreaterThan(completed);
        completed = events.length;
      }
      expect(failures).toBe(fail ? 1 : 0);
      expect((await fs.readFile(marker, 'utf8')).trim().split('\n').sort()).toEqual(['0', '1', '2', '3', '4']);
    }
    // --all includes plugins with fewer files than shards. An empty shard must
    // not fall back to executing their full suite or report full-file coverage.
    await fs.remove(marker);
    for (let id = 1; id < 5; id += 1) await fs.remove(pluginScriptPath(repoRoot, `shard-${id}.test.mjs`));
    const output = captureOutput();
    expect(await runPluginScriptTests(['git-commit', '--platform', 'codex', '--test-shard', '3/3'], {
      repoRoot,
      env: { ...process.env, AW_TEST_WORKERS: '1' },
      stdout: output.stdout,
      stderr: output.stderr,
    })).toBe(0);
    expect(await fs.pathExists(marker)).toBe(false);
    expect(output.readStdout()).toContain('passed (test shard 3/3)');
  });

  it('rejects malformed file shards before preparing a plugin', async () => {
    for (const value of [undefined, '', '0/3', '1/0', '4/3', '1.5/3', '1', '01/3', '1/9007199254740992']) {
      const output = captureOutput();
      const args = value === undefined ? ['--test-shard'] : ['--test-shard', value];
      const exitCode = await runPluginScriptTests(['git-commit', ...args], {
        repoRoot: path.join(os.tmpdir(), 'missing-shard-validation-repo'),
        env: { ...process.env, AW_TEST_WORKERS: '1' },
        stdout: output.stdout,
        stderr: output.stderr,
      });
      expect(exitCode).toBe(1);
      expect(output.readStdout()).toBe('');
      expect(output.readStderr()).toContain('--test-shard must be index/total');
    }
  });

  it('applies configured Node file concurrency and explicit overrides to real test processes', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      products: ['CODEX'],
      testEntries: ['./scripts/worker-*.test.mjs'],
    });
    const defaultWorkers = Math.max(1, os.availableParallelism() - 1);
    for (const selection of [
      { value: '', args: [], expected: Math.min(2, defaultWorkers), workers: defaultWorkers, source: 'default' },
      { value: '1', args: [], expected: 1, workers: 1, source: 'environment' },
      { value: '1', args: ['--test-concurrency=2'], expected: 2, workers: 2, source: 'explicit parameter' },
    ]) {
      const eventsPath = path.join(pluginRoot(repoRoot), 'worker-events');
      await fs.remove(eventsPath);
      for (let id = 0; id < 2; id += 1) {
        await writeNodeTestFile(repoRoot, `worker-${id}.test.mjs`, [
          'import test from "node:test";',
          'import fs from "node:fs";',
          'import path from "node:path";',
          'test("records actual Node file concurrency", async () => {',
          '  const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
          '  const events = path.join(context.sourceRoot, "worker-events");',
          `  fs.appendFileSync(events, 'start ${id}\\n');`,
          '  const deadline = Date.now() + 5000;',
          `  while (fs.readFileSync(events, 'utf8').split('\\n').filter((line) => line.startsWith('start')).length < ${selection.expected}) {`,
          '    if (Date.now() > deadline) throw new Error("Node test files did not run in parallel");',
          '    await new Promise((resolve) => setTimeout(resolve, 10));',
          '  }',
          '  await new Promise((resolve) => setTimeout(resolve, 50));',
          `  fs.appendFileSync(events, 'end ${id}\\n');`,
          '});',
        ].join('\n'));
      }
      const output = captureOutput();
      const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'codex', ...selection.args], {
        repoRoot,
        env: { ...process.env, AW_TEST_WORKERS: selection.value },
        stdout: output.stdout,
        stderr: output.stderr,
      });
      expect(exitCode, `${output.readStdout()}\n${output.readStderr()}`).toBe(0);
      const events = (await fs.readFile(eventsPath, 'utf8')).trim().split('\n');
      let active = 0;
      let peak = 0;
      for (const event of events) {
        active += event.startsWith('start') ? 1 : -1;
        peak = Math.max(active, peak);
      }
      expect(peak).toBe(selection.expected);
      expect(output.readStdout()).toContain(`"maxWorkers":${selection.workers},"source":"${selection.source}"`);
      expect(output.readStderr()).toBe('');
    }
  });

  it('rejects invalid worker input before preparing a plugin', async () => {
    for (const selection of [
      { value: '0', args: [], error: 'AW_TEST_WORKERS' },
      { value: 'bad', args: ['--test-concurrency=2'], error: 'AW_TEST_WORKERS' },
      { value: '2', args: ['--test-concurrency', '0'], error: 'Explicit test workers' },
    ]) {
      const output = captureOutput();
      const exitCode = await runPluginScriptTests(['git-commit', ...selection.args], {
        repoRoot: path.join(os.tmpdir(), 'missing-worker-validation-repo'),
        env: { ...process.env, AW_TEST_WORKERS: selection.value },
        stdout: output.stdout,
        stderr: output.stderr,
      });
      expect(exitCode).toBe(1);
      expect(output.readStdout()).toBe('');
      expect(output.readStderr()).toContain(selection.error);
      expect(output.readStderr()).toContain('positive safe decimal integer');
    }
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
        'const { helperValue } = await import("./context-helper.mjs");',
        'test("context", async () => {',
        '  const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
        '  assert.equal(context.event, "test");',
        '  assert.equal(context.platform, "codex");',
        '  assert.equal(context.scope, "user");',
        '  assert.equal(process.cwd(), context.cwd);',
        '  assert.notEqual(context.plugin.rootDir, context.sourceRoot);',
        '  assert.equal(helperValue, "copied");',
        '});',
      ].join('\n'),
      'utf8',
    );
    await fs.outputFile(
      path.join(repoRoot, 'plugins', 'git-commit', 'scripts', 'context-helper.mjs'),
      'export const helperValue = "copied";\n',
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

  it('runs the standard author helper against validated effective test config', async () => {
    const repoRoot = await makeTempRepo();
    const manifest = await readManifest(repoRoot);
    manifest.config = {
      fields: {
        mode: {
          type: 'string',
          default: 'default-mode',
        },
      },
    };
    manifest.scripts = {
      helpers: {
        config: './scripts/aw-config.mjs',
      },
      tests: {
        node: ['./scripts/config-effective.test.mjs'],
      },
    };
    await writeManifest(repoRoot, manifest);
    await fs.ensureDir(path.dirname(pluginScriptPath(repoRoot, 'aw-config.mjs')));
    await fs.copyFile(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        '..',
        'packages',
        'cli',
        'authoring',
        'assets',
        'aw-config.mjs',
      ),
      pluginScriptPath(repoRoot, 'aw-config.mjs'),
    );
    await writeNodeTestFile(repoRoot, 'config-effective.test.mjs', [
      'import assert from "node:assert/strict";',
      'import { execFile } from "node:child_process";',
      'import path from "node:path";',
      'import test from "node:test";',
      'import { promisify } from "node:util";',
      'const execFileAsync = promisify(execFile);',
      'test("effective config", async () => {',
      '  const result = await execFileAsync(process.execPath, [',
      '    path.join(process.env.AW_PLUGIN_ROOT, "scripts", "aw-config.mjs"),',
      '    "get", "mode",',
      '  ], { env: process.env });',
      '  assert.equal(result.stdout.trim(), "default-mode");',
      '});',
    ].join('\n'));
    const output = captureOutput();

    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'codex'], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
      env: { ...process.env, PATH: process.env.PATH ?? '' } as NodeJS.ProcessEnv,
    });

    expect(exitCode, `${output.readStdout()}\n${output.readStderr()}`).toBe(0);
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

  it('defaults to both and expands to the staging manifest supported platforms on codex-only plugins', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      products: ['CODEX'],
      testEntries: ['./scripts/platform-probe.test.mjs'],
    });
    await writePlatformProbeTest(repoRoot, 'platform-probe.test.mjs');
    const output = captureOutput();

    const exitCode = await runPluginScriptTests(['git-commit'], {
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

  it('expands --platform both to the staging manifest supported platforms on claude-only plugins', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      products: ['CLAUDE'],
      testEntries: ['./scripts/platform-probe.test.mjs'],
    });
    await writePlatformProbeTest(repoRoot, 'platform-probe.test.mjs');
    const output = captureOutput();

    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'both'], {
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

  it('expands --platform both to the full staging manifest supported platform set on dual-platform plugins', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      products: ['CODEX', 'CLAUDE'],
      testEntries: ['./scripts/platform-probe.test.mjs'],
    });
    await writePlatformProbeTest(repoRoot, 'platform-probe.test.mjs');
    const output = captureOutput();

    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'both'], {
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

  it('rejects --platform auto with the public platform list', async () => {
    const repoRoot = await makeTempRepo();
    const output = captureOutput();

    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'auto'], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(1);
    expect(output.readStdout()).toBe('');
    expect(output.readStderr()).toContain('--platform must be one of: codex, claude, both.');
    expect(output.readStderr()).not.toContain('auto');
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

  it('expands --platform both for codex-only plugins without requiring claude support', async () => {
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

    expect(exitCode, `${output.readStdout()}\n${output.readStderr()}`).toBe(0);
    expect(output.readStdout()).toContain('git-commit / codex: passed');
    expect(output.readStdout()).not.toContain('git-commit / claude');
    expect(output.readStderr()).toBe('');
  });

  it('rejects unsupported explicit codex selections for claude-only plugins', async () => {
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

    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'both'], {
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

  it('fails before running any tests when --all --platform codex selects an unsupported plugin', async () => {
    const repoRoot = await makeTempRepo();
    await clonePlugin(repoRoot, 'git-commit', 'claude-only');
    await configureTestManifest({
      repoRoot,
      products: ['CODEX'],
      testEntries: ['./scripts/git-commit-marker.test.mjs'],
    });
    await writeMarkerTest(repoRoot, 'git-commit', 'git-commit-marker.test.mjs');

    const claudeOnlyManifestPath = path.join(
      repoRoot,
      'plugins',
      'claude-only',
      '.agents-plugin',
      'plugin.json',
    );
    const claudeOnlyManifest = await fs.readJson(claudeOnlyManifestPath);
    claudeOnlyManifest.marketplace.policy.products = ['CLAUDE'];
    claudeOnlyManifest.scripts = {
      tests: {
        node: ['./scripts/claude-only-marker.test.mjs'],
      },
    };
    delete claudeOnlyManifest.apps;
    await fs.writeJson(claudeOnlyManifestPath, claudeOnlyManifest, { spaces: 2 });
    await fs.remove(path.join(repoRoot, 'plugins', 'claude-only', '.app.json'));
    await writeMarkerTest(repoRoot, 'claude-only', 'claude-only-marker.test.mjs');

    const output = captureOutput();
    const exitCode = await runPluginScriptTests(['--all', '--platform', 'codex'], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
      env: { ...process.env, PATH: process.env.PATH ?? '' } as NodeJS.ProcessEnv,
    });

    expect(exitCode).toBe(1);
    expect(output.readStdout()).toBe('');
    expect(output.readStderr()).toContain('Cannot run plugin tests for "claude-only" with --platform=codex');
    await expect(
      fs.pathExists(path.join(repoRoot, 'plugins', 'git-commit', 'test-ran.marker')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(repoRoot, 'plugins', 'claude-only', 'test-ran.marker')),
    ).resolves.toBe(false);
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
      'require.resolve("yaml");\n',
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

  it('runs tests with CommonJS directory main and extensionless JSON imports', async () => {
    const repoRoot = await makeTempRepo();
    const manifest = await readManifest(repoRoot);
    manifest.scripts = {
      tests: {
        node: ['./scripts/commonjs.test.cjs'],
      },
    };
    await writeManifest(repoRoot, manifest);
    await writeNodeTestFile(repoRoot, 'commonjs.test.cjs', [
      'const test = require("node:test");',
      'const assert = require("node:assert/strict");',
      'const helper = require("./feature");',
      'test("CommonJS test closure", () => {',
      '  assert.deepEqual(helper, { staged: true });',
      '});',
    ].join('\n'));
    await fs.outputJson(pluginScriptPath(repoRoot, 'feature/package.json'), {
      main: '../shared.cjs',
    });
    await writeNodeTestFile(
      repoRoot,
      'shared.cjs',
      'module.exports = require("./fixture");\n',
    );
    await fs.outputJson(pluginScriptPath(repoRoot, 'fixture.json'), {
      staged: true,
    });
    const output = captureOutput();

    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'codex'], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
      env: { ...process.env, PATH: process.env.PATH ?? '' } as NodeJS.ProcessEnv,
    });

    expect(exitCode, `${output.readStdout()}\n${output.readStderr()}`).toBe(0);
    expect(output.readStdout()).toContain('git-commit / codex: passed');
    expect(output.readStderr()).toBe('');
  });

  it('rejects a test import resolved only by a nested CommonJS package manifest', async () => {
    const repoRoot = await makeTempRepo();
    const manifest = await readManifest(repoRoot);
    manifest.scripts = {
      tests: {
        node: ['./scripts/nested-main.test.cjs'],
      },
    };
    await writeManifest(repoRoot, manifest);
    await writeNodeTestFile(
      repoRoot,
      'nested-main.test.cjs',
      'require("./nested-main-helper");\n',
    );
    await fs.outputJson(pluginScriptPath(repoRoot, 'nested-main-helper/package.json'), {
      main: 'nested',
    });
    await fs.outputJson(pluginScriptPath(repoRoot, 'nested-main-helper/nested/package.json'), {
      main: 'actual.cjs',
    });
    await writeNodeTestFile(
      repoRoot,
      'nested-main-helper/nested/actual.cjs',
      'module.exports = true;\n',
    );
    const output = captureOutput();

    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'codex'], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(exitCode).toBe(1);
    expect(output.readStdout()).toBe('');
    expect(output.readStderr()).toContain(
      'Unable to resolve relative import "./nested-main-helper" from "scripts/nested-main.test.cjs".',
    );
  });

  // Test Value Gate: a running test must be identifiable before it exits, while
  // config values split across stdout writes must remain private.
  it('reports live test progress while retaining cross-write output redaction', async () => {
    const repoRoot = await makeTempRepo();
    const manifest = await readManifest(repoRoot);
    manifest.config = { fields: {
      value: { type: 'string', sensitive: true },
      shortValue: { type: 'string', sensitive: true },
    } };
    manifest.scripts = { tests: { node: ['./scripts/progress.test.mjs'] } };
    await writeManifest(repoRoot, manifest);
    const releaseFile = path.join(repoRoot, 'release');
    const secret = 'private-progress-value';
    await writeNodeTestFile(repoRoot, 'progress.test.mjs', [
      'import test from "node:test";',
      'import { access } from "node:fs/promises";',
      'import { setTimeout } from "node:timers/promises";',
      `test(${JSON.stringify(`live ${secret}`)}, { timeout: 5000 }, async () => {`,
      `  process.stdout.write(${JSON.stringify(secret.slice(0, 9))});`,
      '  await setTimeout(25);',
      `  process.stdout.write(${JSON.stringify(secret.slice(9) + '\n')});`,
      `  while (true) { try { await access(${JSON.stringify(releaseFile)}); break; } catch {} await setTimeout(10); }`,
      '});',
    ].join('\n'));
    const output = captureOutput();
    let live = false;
    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'codex'], {
      repoRoot,
      testConfigValues: { value: secret, shortValue: '0' },
      stdout(text) {
        output.stdout(text);
        if (text.startsWith('AW_PLUGIN_TEST ') && text.includes('"event":"dequeue"') && text.includes('live ')) {
          live = true;
          fs.writeFileSync(releaseFile, 'continue');
        }
      },
      stderr: output.stderr,
    });
    expect(exitCode, output.readStderr()).toBe(0);
    expect(live).toBe(true);
    expect(output.readStdout()).toContain('live [REDACTED]');
    expect(output.readStdout()).not.toContain(secret);
    const progress = output.readStdout().split('\n').filter((line) => line.startsWith('AW_PLUGIN_TEST '))
      .map((line) => JSON.parse(line.slice('AW_PLUGIN_TEST '.length)));
    expect(progress.some((event) => event.file === 'scripts/progress.test.mjs' && event.event === 'pass')).toBe(true);
  });

  // Test Value Gate: isolating a heavy file must preserve full coverage across
  // the dedicated run and all remaining shards, with no silent missing target.
  it('covers selected files and the remaining shards without overlap', async () => {
    const repoRoot = await makeTempRepo();
    const files = ['a', 'b', 'c', 'd'];
    await configureTestManifest({ repoRoot, testEntries: files.map((name) => `./scripts/${name}.test.mjs`) });
    for (const name of files) await writeNodeTestFile(repoRoot, `${name}.test.mjs`,
      `import test from 'node:test'; test('file-${name}', () => {});`);
    const seen: string[] = [];
    for (const selection of [
      ['--test-file', './scripts/b.test.mjs'],
      ...['1/3', '2/3', '3/3'].map((shard) => ['--exclude-test-file', 'scripts/b.test.mjs', '--test-shard', shard]),
    ]) {
      const output = captureOutput();
      expect(await runPluginScriptTests(['git-commit', '--platform', 'codex', ...selection], {
        repoRoot, stdout: output.stdout, stderr: output.stderr,
      }), output.readStderr()).toBe(0);
      for (const line of output.readStdout().split('\n').filter((line) => line.startsWith('AW_PLUGIN_TEST '))) {
        const event = JSON.parse(line.slice('AW_PLUGIN_TEST '.length));
        if (event.event === 'pass' && /^file-[a-d]$/.test(event.name)) seen.push(event.name);
      }
    }
    expect(seen.sort()).toEqual(files.map((name) => `file-${name}`));
    const output = captureOutput();
    expect(await runPluginScriptTests(['git-commit', '--test-file', 'scripts/missing.test.mjs'], {
      repoRoot, stdout: output.stdout, stderr: output.stderr,
    })).toBe(1);
    expect(output.readStderr()).toContain('No declared test file matches');
  }, 30_000);

  it('redacts sensitive config values from node test output and failures', async () => {
    const repoRoot = await makeTempRepo();
    const manifest = await readManifest(repoRoot);
    manifest.config = {
      fields: {
        token: {
          type: 'string',
          sensitive: true,
        },
        pin: {
          type: 'string',
          sensitive: true,
        },
        enabled: {
          type: 'string',
          sensitive: true,
        },
        accessKey: {
          type: 'string',
          sensitive: true,
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
        '  const accessKey = context.config.values.accessKey;',
        '  console.log(`token=${token} pin=${pin} enabled=${enabled} access=${accessKey}`);',
        '  console.error(`token=${token} pin=${pin} enabled=${enabled} access=${accessKey}`);',
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
      testConfigValues: {
        token: 'super-secret-plugin-token',
        pin: '8675309-plugin-secret',
        enabled: 'enabled-plugin-secret',
        accessKey: 'nested-plugin-test-secret',
      },
    });

    expect(exitCode).toBe(1);
    const combinedOutput = `${output.readStdout()}\n${output.readStderr()}`;
    for (const secret of [
      'super-secret-plugin-token',
      '8675309-plugin-secret',
      'enabled-plugin-secret',
      'nested-plugin-test-secret',
    ]) {
      expect(combinedOutput).not.toContain(secret);
    }
    expect(combinedOutput).toContain(
      'token=[REDACTED] pin=[REDACTED] enabled=[REDACTED] access=[REDACTED]',
    );
  });

  it('uses the catalog runtime resolver when plugin:test bundles a projected Skill reference', async () => {
    const repoRoot = await makeTempRepo();
    const providerRoot = path.join(repoRoot, 'plugins', 'registry-provider');
    await fs.outputJson(path.join(providerRoot, '.agents-plugin', 'plugin.json'), {
      name: 'registry-provider',
      version: '0.1.0',
      description: 'registry provider',
      schemaVersion: 3,
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
      buildConfig: {
        runtimeExports: [{
          name: 'registry', source: './registry.json',
          requires: { aw: { capabilities: [] } },
        }],
      },
    }, { spaces: 2 });
    await fs.outputFile(path.join(providerRoot, 'registry.json'), '{"catalog":true}\n');

    const manifest = await readManifest(repoRoot);
    manifest.buildConfig = {
      skillRuntimeFiles: [{
        skill: 'commit',
        target: 'references/registry.json',
        import: { plugin: 'registry-provider', export: 'registry' },
      }],
    };
    manifest.scripts = { tests: { node: ['./scripts/projection.test.mjs'] } };
    await writeManifest(repoRoot, manifest);
    await writeNodeTestFile(repoRoot, 'projection.test.mjs', [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { readFile } from "node:fs/promises";',
      'import path from "node:path";',
      'test("catalog projection", async () => {',
      '  const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      '  const projected = JSON.parse(await readFile(path.join(context.plugin.rootDir, "codex", "skills", "commit", "references", "registry.json"), "utf8"));',
      '  assert.deepEqual(projected, { catalog: true });',
      '});',
    ].join('\n'));
    const output = captureOutput();

    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'codex'], {
      repoRoot,
      stdout: output.stdout,
      stderr: output.stderr,
      env: { ...process.env, PATH: process.env.PATH ?? '' },
    });

    expect(exitCode, `${output.readStdout()}\n${output.readStderr()}`).toBe(0);
    expect(output.readStdout()).toContain('git-commit / codex: passed');
  });
});
