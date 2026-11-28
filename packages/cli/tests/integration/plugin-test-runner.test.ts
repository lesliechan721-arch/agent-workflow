import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nativeToolFixture } from '../helpers/native-tools.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { runPluginScriptTests } from '../../scripts/test-plugin-scripts.js';
import * as pluginTestRunner from '../../scripts/test-plugin-scripts.js';
import { pluginTestContextGuardUrl } from '../../scripts/plugin-test-context-guard.mjs';

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
  platforms?: Array<'codex' | 'claude'>;
  testEntries: string[];
  buildPath?: string;
}): Promise<void> {
  const manifest = await readManifest(options.repoRoot);
  if (options.platforms) manifest.platforms = options.platforms;
  if (options.platforms && !options.platforms.includes('codex')) {
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

async function writePlatformRewriteBuild(repoRoot: string, fileName: string, platforms: Array<'codex' | 'claude'>): Promise<void> {
  await writeNodeTestFile(
    repoRoot,
    fileName,
    [
      'import { readFile, writeFile } from "node:fs/promises";',
      '',
      'const manifestUrl = new URL("../.agents-plugin/plugin.json", import.meta.url);',
      'const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));',
      `manifest.platforms = ${JSON.stringify(platforms)};`,
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
  it('runs a current generic-only plugin through the explicit canonical target', async () => {
    const repoRoot = await makeTempRepo();
    const manifest = await readManifest(repoRoot);
    manifest.platforms = ['generic'];
    manifest.scripts = { tests: { node: ['./scripts/generic.test.mjs'] } };
    await writeManifest(repoRoot, manifest);
    await writeNodeTestFile(repoRoot, 'generic.test.mjs', [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import fs from "node:fs";',
      'const context=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,"utf8"));',
      'test("generic context",()=>assert.equal(context.platform,"generic"));',
    ].join('\n'));
    const output = captureOutput();
    const code = await runPluginScriptTests(['git-commit', '--platform', 'generic'], { repoRoot, ...output });
    expect({ code, stderr: output.readStderr() }).toEqual({ code: 0, stderr: '' });
    expect(output.readStdout()).toContain('git-commit / generic');
  });

  // Test Value Gate: CI file shards must cover every installed test exactly
  // once, including non-ASCII names, and preserve a selected test's failure.
  it('runs disjoint Node file shards without omissions and propagates failures', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      platforms: ['codex'],
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

  // Test Value Gate: CI shard remapping must preserve every file, target, and
  // preferred backend, including new plugins/files and a failed native run.
  it('balances Windows CI shards without changing complete runner coverage', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      platforms: ['codex', 'claude'],
      testEntries: ['./scripts/part-*.test.mjs'],
    });
    const plugins = ['agent-skill-toolkit', 'aw-development-toolkit', 'dev-workflow', 'git-commit'];
    for (const plugin of plugins) {
      if (plugin !== 'git-commit') await clonePlugin(repoRoot, 'git-commit', plugin);
    }
    const nativePluginRoot = path.join(repoRoot, 'plugins', 'aw-development-toolkit');
    const nativeManifestPath = path.join(nativePluginRoot, '.agents-plugin', 'plugin.json');
    const nativeManifest = await fs.readJson(nativeManifestPath);
    const fixture = nativeToolFixture({ kind: 'plugin-test', consumer: 'node', policy: 'preferred' });
    nativeManifest.requires = { aw: { capabilities: ['aw.native-tools.v3'] } };
    nativeManifest.nativeTools = { definitions: fixture.closure.definitions, consumers: fixture.closure.consumers };
    await fs.writeJson(nativeManifestPath, nativeManifest);
    const contextFile = path.join(repoRoot, 'native-context.json');
    await fs.writeJson(contextFile, { schemaVersion: 1, tools: {
      job: { state: 'ready', protocol: 'aw.windows-job.v1', executable: process.execPath },
    } });
    const marker = path.join(repoRoot, 'matrix-events');
    for (const plugin of plugins) {
      await fs.outputJson(path.join(repoRoot, 'plugins', plugin, '.agents-plugin', 'test-platform-agnostic.json'),
        ['scripts/part-3.test.mjs']);
      for (let id = 0; id < 4; id += 1) {
        await fs.outputFile(path.join(repoRoot, 'plugins', plugin, 'scripts', `part-${id}.test.mjs`), [
          'import test from "node:test";',
          'import fs from "node:fs";',
          'import assert from "node:assert/strict";',
          'test("records complete CI matrix", () => {',
          ...(id === 3 ? [
            '  assert.ok(!Object.keys(process.env).includes("AW_PLUGIN_CONTEXT"));',
            '  assert.ok(!Object.keys(process.env).includes("AW_PLUGIN_PLATFORM"));',
            '  const platform = "agnostic";',
          ] : [
            '  const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
            '  const platform = context.platform;',
          ]),
          '  const backend = process.env.AW_NATIVE_TOOL_CONTEXT ? JSON.parse(process.env.AW_NATIVE_TOOL_CONTEXT).tools.job.state : "none";',
          `  fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify([${JSON.stringify(plugin)}, platform, ${id}, backend]) + "\\n");`,
          `  if (${JSON.stringify(plugin)} === "aw-development-toolkit" && ${id} === 0 && backend === "ready") throw new Error("selected native shard failure");`,
          '});',
        ].join('\n'));
      }
    }
    const expected: string[] = [];
    for (const plugin of plugins) {
      for (let id = 0; id < 4; id += 1) {
        for (const platform of id === 3 ? ['agnostic'] : ['codex', 'claude']) {
          for (const backend of plugin === 'aw-development-toolkit' ? ['ready', 'unavailable'] : ['none']) {
            expected.push(JSON.stringify([plugin, platform, id, backend]));
          }
        }
      }
    }
    const allSeen: string[] = [];
    const assigned = new Map<string, number>();
    let failedShards = 0;
    for (let index = 1; index <= 3; index += 1) {
      await fs.remove(marker);
      const output = captureOutput();
      const code = await runPluginScriptTests([
        '--all', '--test-shard', `${index}/3`,
        ...(index === 2 ? ['--test-shard-profile=windows-ci'] : ['--test-shard-profile', 'windows-ci']),
        '--test-concurrency', '1', '--native-mode', 'source-candidate', '--native-context', contextFile,
      ], { repoRoot, nativePlatform: 'win32', env: { ...process.env, AW_TEST_WORKERS: '1' }, ...output });
      if (code !== 0) {
        failedShards += 1;
        expect(output.readStdout()).toContain('selected native shard failure');
      }
      const seen = (await fs.readFile(marker, 'utf8')).trim().split('\n');
      for (const record of seen) {
        const [plugin, , id] = JSON.parse(record) as [string, string, number, string];
        const key = `${plugin}/${id}`;
        expect(assigned.get(key) ?? index).toBe(index);
        assigned.set(key, index);
      }
      allSeen.push(...seen);
    }
    expect(failedShards).toBe(1);
    expect(allSeen.sort()).toEqual(expected.sort());
  }, 30_000);

  // Test Value Gate: a false explicit declaration cannot silently skip a
  // target even when an environment read is optional or its error is caught.
  it('runs only explicitly independent tests without target context and rejects context reads', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      platforms: ['codex', 'claude'],
      testEntries: ['./scripts/independent.test.mjs', './scripts/target.test.mjs'],
    });
    await writePlatformProbeTest(repoRoot, 'target.test.mjs');
    // A test can read a runtime fixture whose static import belongs to another
    // declared entry. Classification must retain the original staging closure.
    await writeNodeTestFile(repoRoot, 'shared-fixture.mjs', 'export const marker = "shared support";');
    await fs.appendFile(pluginScriptPath(repoRoot, 'target.test.mjs'), [
      '',
      'test("shared test support survives target batch partition", async () => {',
      '  const fixture = new URL(["./shared", "fixture.mjs"].join("-"), import.meta.url);',
      '  assert.match(await readFile(fixture, "utf8"), /shared support/);',
      '});',
    ].join('\n'));
    await fs.outputJson(path.join(pluginRoot(repoRoot), '.agents-plugin', 'test-platform-agnostic.json'),
      ['scripts/independent.test.mjs']);
    await writeNodeTestFile(repoRoot, 'independent.test.mjs', [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { spawnSync } from "node:child_process";',
      'import fs from "node:fs";',
      'import path from "node:path";',
      'import { marker } from "./shared-fixture.mjs";',
      'test("independent probe", () => {',
      '  assert.equal(marker, "shared support");',
      '  assert.ok(!Object.keys(process.env).includes("AW_PLUGIN_CONTEXT"));',
      '  assert.ok(!Object.keys(process.env).includes("AW_PLUGIN_PLATFORM"));',
      '  assert.ok(!fs.existsSync(path.join(process.env.HOME, "..", "context.json")));',
      // A target-independent test may install and replace its native fixture
      // context. The platform-read guard must preserve ordinary env writes.
      '  process.env.AW_NATIVE_TOOL_CONTEXT = "fixture-before";',
      '  process.env.AW_NATIVE_TOOL_CONTEXT = "fixture-after";',
      '  assert.equal(process.env.AW_NATIVE_TOOL_CONTEXT, "fixture-after");',
      '  const child = spawnSync(process.execPath, ["-p", "JSON.stringify([process.env.AW_PLUGIN_CONTEXT, process.env.AW_NATIVE_TOOL_CONTEXT])"], {',
      '    env: { ...process.env, AW_PLUGIN_CONTEXT: "private" }, encoding: "utf8",',
      '  });',
      '  assert.equal(child.status, 0, child.stderr);',
      '  assert.deepEqual(JSON.parse(child.stdout), ["private", "fixture-after"]);',
      '  console.log("independent marker");',
      '});',
    ].join('\n'));
    const output = captureOutput();
    const code = await runPluginScriptTests(['git-commit'], {
      repoRoot, nativePlatform: 'darwin',
      env: { ...process.env, AW_PLUGIN_CONTEXT: 'parent-private', AW_PLUGIN_PLATFORM: 'claude' },
      ...output,
    });
    expect(code, output.readStdout() + output.readStderr()).toBe(0);
    expect(output.readStdout().match(/independent marker/g)).toHaveLength(1);
    expect(output.readStdout()).toContain('platform=codex');
    expect(output.readStdout()).toContain('platform=claude');

    // The independent entry is in shard 1; its dynamically reused support
    // must still be available to shard 2 without executing that entry again.
    const selected = captureOutput();
    const shardCode = await runPluginScriptTests(['git-commit', '--test-shard', '2/2'], {
      repoRoot, nativePlatform: 'darwin', ...selected,
    });
    expect(shardCode, selected.readStdout() + selected.readStderr()).toBe(0);
    expect(selected.readStdout()).not.toContain('independent marker');
    expect(selected.readStdout()).toContain('platform=codex');
    expect(selected.readStdout()).toContain('platform=claude');

    for (const [name, read] of [
      ['AW_PLUGIN_CONTEXT', 'process.env.AW_PLUGIN_CONTEXT'],
      ['AW_PLUGIN_PLATFORM', 'process.env["AW_PLUGIN_" + "PLATFORM"]'],
      ['AW_PLUGIN_PLATFORM', 'env.AW_PLUGIN_PLATFORM'],
    ]) {
      await writeNodeTestFile(repoRoot, 'independent.test.mjs', [
        'import test from "node:test";',
        'import { env } from "node:process";',
        `test("optional context read", () => { try { void (${read} ?? "fallback"); } catch {} });`,
      ].join('\n'));
      const conflict = captureOutput();
      expect(await runPluginScriptTests(['git-commit', '--test-file', 'scripts/independent.test.mjs'], {
        repoRoot, nativePlatform: 'linux', ...conflict,
      })).toBe(1);
      const report = conflict.readStdout() + conflict.readStderr();
      expect(report).toContain('independent.test.mjs');
      expect(report).toContain(name);
    }
  });

  it('rejects target context reads when the test entry is reached through a path alias', async () => {
    const repoRoot = await makeTempRepo();
    const canonicalRoot = await fs.realpath(repoRoot);
    const testFile = path.join(canonicalRoot, 'guarded.test.mjs');
    await fs.writeFile(testFile, [
      'import test from "node:test";',
      'test("optional read", () => { try { void process.env.AW_PLUGIN_CONTEXT; } catch {} });',
    ].join('\n'));
    let aliasedFile: string;
    if (process.platform === 'win32') {
      aliasedFile = testFile.replace(/^[A-Za-z]:/, (drive) => drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase());
    } else {
      aliasedFile = path.join(canonicalRoot, 'alias.test.mjs');
      await fs.symlink(testFile, aliasedFile);
    }
    expect(aliasedFile).not.toBe(testFile);
    const result = spawnSync(process.execPath, [
      '--import', pluginTestContextGuardUrl([testFile]), '--test', aliasedFile,
    ], { cwd: canonicalRoot, encoding: 'utf8', timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout + result.stderr).toContain('AW_PLUGIN_CONTEXT');

    // A tool probe may inherit the preload and pass a non-file argument.
    const probe = spawnSync(process.execPath, [
      '--import', pluginTestContextGuardUrl([testFile]), '-p', 'process.env.AW_PLUGIN_CONTEXT', 'non-file-argument',
    ], {
      cwd: canonicalRoot, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, AW_PLUGIN_CONTEXT: 'private' },
    });
    expect(probe.error).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout.trim()).toBe('private');

    const missing = spawnSync(process.execPath, [
      '--import', pluginTestContextGuardUrl([path.join(canonicalRoot, 'missing.test.mjs')]), '--test', testFile,
    ], { cwd: canonicalRoot, encoding: 'utf8', timeout: 10_000 });
    expect(missing.error).toBeUndefined();
    expect(missing.status, missing.stdout + missing.stderr).toBe(1);
    expect(missing.stdout + missing.stderr).toContain('missing.test.mjs');
  });

  it('rejects invalid CI shard profiles before preparing plugins', async () => {
    for (const args of [
      ['--all', '--test-shard', '1/3', '--test-shard-profile'],
      ['--all', '--test-shard', '1/3', '--test-shard-profile', 'other'],
      ['--all', '--test-shard-profile', 'windows-ci'],
      ['--all', '--test-shard', '1/2', '--test-shard-profile', 'windows-ci'],
      ['git-commit', '--test-shard', '1/3', '--test-shard-profile', 'windows-ci'],
    ]) {
      const output = captureOutput();
      expect(await runPluginScriptTests(args, {
        repoRoot: path.join(os.tmpdir(), 'missing-shard-profile-repo'), ...output,
      })).toBe(1);
      expect(output.readStdout()).toBe('');
      expect(output.readStderr()).toContain('--test-shard-profile');
    }
  });

  it('applies configured Node file concurrency and explicit overrides to real test processes', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      platforms: ['codex'],
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

  // Test Value Gate: one user store must survive project context, while both
  // Native profiles use the matching schema and same-platform provider defaults.
  it.each(['user', 'project'] as const)('runs the author helper with %s context and exact Native profiles', async (scope) => {
    const repoRoot = await makeTempRepo();
    const manifest = await readManifest(repoRoot);
    manifest.dependencies = ['config-provider'];
    manifest.requires = { aw: { capabilities: ['aw.plugin-config-cross-plugin-value-ref.v1'] } };
    manifest.config = {
      schemaVersion: 5,
      fields: {
        mode: {
          type: 'string',
          default: 'common-mode',
          valueRef: { plugin: 'config-provider', field: 'registry', key: 'key' },
        },
        shared: { type: 'string' },
      },
      platforms: {
        codex: { fields: { mode: { type: 'string', default: 'codex-mode',
          valueRef: { plugin: 'config-provider', field: 'registry', key: 'key' } } } },
        claude: { fields: { mode: { type: 'string', default: 'claude-mode',
          valueRef: { plugin: 'config-provider', field: 'registry', key: 'key' } } } },
      },
    };
    await fs.outputJson(path.join(repoRoot, 'plugins', 'config-provider', '.agents-plugin', 'plugin.json'), {
      schemaVersion: 4, name: 'config-provider', version: '0.1.0', description: 'Plugin test config provider.',
      platforms: ['codex', 'claude'],
      marketplace: { category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      config: {
        schemaVersion: 5,
        fields: { registry: { type: 'array', default: [{ key: 'common-mode' }], validation: { uniqueBy: 'key' }, items: {
          type: 'object', properties: { key: { type: 'string', required: true } }, additionalProperties: false,
        } } },
        platforms: Object.fromEntries(['codex', 'claude'].map((platform) => [platform, { fields: {
          registry: { type: 'array', default: [{ key: `${platform}-mode` }], validation: { uniqueBy: 'key' }, items: {
            type: 'object', properties: { key: { type: 'string', required: true } }, additionalProperties: false,
          } },
        } }])),
      },
    });
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
      'import { readFile } from "node:fs/promises";',
      'import path from "node:path";',
      'import test from "node:test";',
      'import { promisify } from "node:util";',
      'const execFileAsync = promisify(execFile);',
      'test("effective config", async () => {',
      '  const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      '  const expected = `${context.platform}-mode`;',
      `  assert.equal(context.scope, ${JSON.stringify(scope)});`,
      '  assert.equal(context.paths.configStores.user, context.paths.configStores.project);',
      '  const store = JSON.parse(await readFile(context.paths.configStores.user, "utf8"));',
      '  assert.equal(store.schemaVersion, 6);',
      '  assert.equal(store.binding.kind, "source");',
      '  assert.deepEqual(store.common, { shared: "common-input" });',
      '  assert.deepEqual(store.platforms, {});',
      '  assert.equal(Object.hasOwn(store, "values"), false);',
      '  assert.equal(context.config.values.mode, expected);',
      '  assert.equal(context.config.values.shared, "common-input");',
      '  const result = await execFileAsync(process.execPath, [',
      '    path.join(process.env.AW_PLUGIN_ROOT, "scripts", "aw-config.mjs"),',
      '    "get", "mode",',
      '  ], { env: process.env });',
      '  assert.equal(result.stdout.trim(), expected);',
      '});',
    ].join('\n'));
    const output = captureOutput();

    const exitCode = await runPluginScriptTests(['git-commit', '--platform', 'both', '--scope', scope], {
      repoRoot,
      testConfigValues: { shared: 'common-input' },
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
        '  assert.equal(process.env.AW_SUBAGENT_COMMUNICATION_DIAGNOSTICS, "1");',
        '  assert.equal(process.env.AW_TEST_UNRELATED_HOST_VALUE, undefined);',
        '  assert.equal(process.env.AW_SUBAGENT_LONG_RUN_MS, undefined);',
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
        AW_SUBAGENT_COMMUNICATION_DIAGNOSTICS: '1',
        AW_TEST_UNRELATED_HOST_VALUE: 'private-host-value',
        AW_SUBAGENT_LONG_RUN_MS: '1805000',
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
      platforms: ['codex'],
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
      platforms: ['claude'],
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
      platforms: ['codex', 'claude'],
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
    expect(output.readStderr()).toContain('--platform must be one of: codex, claude, antigravity, cursor, opencode, pi, copilot, grok, generic, both.');
    expect(output.readStderr()).not.toContain('auto');
  });

  it('fails fast for unsupported explicit platform selections before runtime bundling', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      platforms: ['codex'],
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
    expect(output.readStderr()).toContain('platforms=[codex]');
    expect(output.readStderr()).toContain('supported platforms=codex');
    expect(output.readStderr()).not.toContain('missing-platform-probe');
  });

  it('expands --platform both for codex-only plugins without requiring claude support', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      platforms: ['codex'],
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
      platforms: ['claude'],
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
    expect(codexOutput.readStderr()).toContain('platforms=[claude]');
    expect(codexOutput.readStderr()).toContain('supported platforms=claude');
  });

  it('uses the staging manifest platforms when source and staging platforms differ', async () => {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({
      repoRoot,
      platforms: ['claude'],
      testEntries: ['./scripts/platform-probe.test.mjs'],
      buildPath: './scripts/rewrite-platforms.mjs',
    });
    await writePlatformProbeTest(repoRoot, 'platform-probe.test.mjs');
    await writePlatformRewriteBuild(repoRoot, 'rewrite-platforms.mjs', ['codex']);
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
    await expect(readManifest(repoRoot)).resolves.toMatchObject({ platforms: ['claude'] });
  });

  it('fails before running any tests when --all --platform codex selects an unsupported plugin', async () => {
    const repoRoot = await makeTempRepo();
    await clonePlugin(repoRoot, 'git-commit', 'claude-only');
    await configureTestManifest({
      repoRoot,
      platforms: ['codex'],
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
    claudeOnlyManifest.platforms = ['claude'];
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

  it('redacts config marked sensitive by the selected Native profile from node output and failures', async () => {
    const repoRoot = await makeTempRepo();
    const manifest = await readManifest(repoRoot);
    manifest.config = {
      schemaVersion: 5,
      fields: {
        token: { type: 'string' },
        pin: { type: 'string' },
        enabled: { type: 'string' },
        accessKey: { type: 'string' },
      },
      platforms: {
        codex: { fields: {
          token: { type: 'string', sensitive: true },
          pin: { type: 'string', sensitive: true },
          enabled: { type: 'string', sensitive: true },
          accessKey: { type: 'string', sensitive: true },
        } },
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
      schemaVersion: 4,
      platforms: ['codex', 'claude'],
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

// Test Value Gate: real Node imports must resolve a trusted AW reader in the
// isolated test bundle even though the author command source omits it.
it('stages declared generated readers for tests of a command package', async () => {
  const repoRoot = await makeTempRepo();
  await configureTestManifest({ repoRoot, testEntries: ['./scripts/command.test.mjs'] });
  const manifest = await readManifest(repoRoot);
  manifest.requires = { aw: { capabilities: ['aw.managed-commands.v2', 'aw.native-tools.v3'] } };
  manifest.nativeTools = nativeToolFixture().closure;
  manifest.config = { fields: { message: { type: 'string', default: 'hello' } } };
  manifest.command = {
    sourceDir: './command', mode: 'static', platforms: ['claude'],
    runtimeConfig: { keys: ['message'] }, routes: { fallback: { runner: 'node', entry: 'entry.mjs' } },
  };
  await writeManifest(repoRoot, manifest);
  await fs.outputFile(path.join(pluginRoot(repoRoot), 'command', 'entry.mjs'), [
    'export { readCommandRuntimeConfig } from "./.aw/command-runtime-config.mjs";',
    'export { readNativeTool } from "./.aw/native-tool-reader.mjs";',
  ].join('\n'));
  await writeNodeTestFile(repoRoot, 'command.test.mjs', [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { readCommandRuntimeConfig, readNativeTool } from "../command/entry.mjs";',
    'test("command readers load", () => {',
    '  assert.equal(typeof readCommandRuntimeConfig, "function");',
    '  assert.equal(typeof readNativeTool, "function");',
    '});',
  ].join('\n'));

  const output = captureOutput();
  const run = () => runPluginScriptTests(['git-commit', '--platform', 'claude'], {
    repoRoot, stdout: output.stdout, stderr: output.stderr,
  });
  expect(await run(), output.readStderr()).toBe(0);
  expect(await fs.pathExists(path.join(pluginRoot(repoRoot), 'command', '.aw'))).toBe(false);
  await writeNodeTestFile(repoRoot, 'command.test.mjs',
    'import "../command/.aw/command-runtime-config.mjs";\n');
  expect(await run()).toBe(1);
  expect(output.readStderr()).toContain('Unable to resolve relative import "../command/.aw/command-runtime-config.mjs"');
});

// Test Value Gate: observe injected host tools, preferred backends, and refusal before consumer side effects.
describe('plugin test native preparation', () => {
  async function prepareNativeTest(policy: 'required' | 'preferred' = 'required', protocol = 'aw.windows-job.v1') {
    const repoRoot = await makeTempRepo();
    await configureTestManifest({ repoRoot, testEntries: ['./scripts/native.test.mjs'] });
    const manifest = await readManifest(repoRoot);
    const fixture = nativeToolFixture({ kind: 'plugin-test', consumer: 'node', policy, protocol });
    manifest.requires = { aw: { capabilities: ['aw.managed-commands.v2', 'aw.native-tools.v3'] } };
    manifest.command = { sourceDir: './command', mode: 'static', platforms: ['claude'],
      routes: { fallback: { runner: 'node', entry: 'entry.mjs' } } };
    // Only the plugin-test consumer's tool should be available to the Node tests.
    manifest.nativeTools = {
      definitions: [...fixture.closure.definitions, { key: 'command-job', protocol: 'aw.windows-job.v1' }],
      consumers: [...fixture.closure.consumers, {
        kind: 'plugin-command', tools: [{ key: 'command-job', platforms: ['win32'], policy: 'required' }],
      }],
    };
    await writeManifest(repoRoot, manifest);
    await fs.outputFile(path.join(repoRoot, 'plugins', 'git-commit', 'command', 'entry.mjs'), 'export {};\n');
    const startedFile = path.join(repoRoot, 'consumer-started');
    await writeNodeTestFile(repoRoot, 'native.test.mjs', [
      'import test from "node:test";', 'import assert from "node:assert/strict";', 'import fs from "node:fs";',
      'test("native contract", () => {',
      ` fs.writeFileSync(${JSON.stringify(startedFile)}, "started");`,
      ' const context=JSON.parse(process.env.AW_NATIVE_TOOL_CONTEXT);',
      ' assert.deepEqual(Object.keys(context.tools), ["job"]);',
      ' assert.equal(context.tools.job.protocol,"aw.windows-job.v1");',
      ' assert.equal(process.env.aw_native_other,undefined);',
      ' console.log("native-backend="+context.tools.job.state);',
      '});',
    ].join('\n'));
    return { repoRoot, startedFile };
  }
  const runNativeTests = runPluginScriptTests;
  const ready = { state: 'ready' as const, protocol: 'aw.windows-job.v1', executable: process.execPath };

  // Test Value Gate: use the public command and real Node consumer so option
  // parsing and author-command forwarding cannot drift from the test runner.
  it.each(['fixture', 'source-candidate'])('passes native context through public plugin test in %s mode', async (mode) => {
    const { repoRoot, startedFile } = await prepareNativeTest();
    const contextFile = path.join(repoRoot, 'native-context.json');
    await fs.writeJson(contextFile, { schemaVersion: 1, tools: { job: ready } });
    const runner = vi.spyOn(pluginTestRunner, 'runPluginScriptTests').mockImplementation((args, options) =>
      runNativeTests(args, { ...options, nativePlatform: 'win32' }));
    let result: Awaited<ReturnType<typeof runCliEntry>>;
    try {
      result = await runCliEntry(['dev', 'plugin', 'test', pluginRoot(repoRoot), '--workspace-root', repoRoot,
        '--native-mode', mode, '--native-context', contextFile, '--json'], { cwd: repoRoot });
    } finally { runner.mockRestore(); }
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({
      schemaVersion: 2,
      status: 'success',
      command: 'dev.plugin.test',
      data: { exitCode: 0 }
    });
    expect(result.stderr).toContain('native-backend=ready');
    expect(await fs.readFile(startedFile, 'utf8')).toBe('started');
  });

  it('refuses an unsupported protocol before a public source-candidate consumer starts', async () => {
    const protocol = 'example.unsupported.v1';
    const { repoRoot, startedFile } = await prepareNativeTest('required', protocol);
    const contextFile = path.join(repoRoot, 'native-context.json');
    await fs.writeJson(contextFile, { schemaVersion: 1, tools: { job: { ...ready, protocol } } });
    const runner = vi.spyOn(pluginTestRunner, 'runPluginScriptTests').mockImplementation((args, options) =>
      runNativeTests(args, { ...options, nativePlatform: 'win32' }));
    let result: Awaited<ReturnType<typeof runCliEntry>>;
    try {
      result = await runCliEntry(['dev', 'plugin', 'test', pluginRoot(repoRoot), '--workspace-root', repoRoot,
        '--native-mode', 'source-candidate', '--native-context', contextFile, '--json'], { cwd: repoRoot });
    } finally { runner.mockRestore(); }
    expect(result.exitCode).toBe(1);
    expect(result.parseJsonStdout()).toMatchObject({
      schemaVersion: 2,
      status: 'failed',
      command: 'dev.plugin.test',
      data: { exitCode: 1 }
    });
    expect(result.stderr).toContain(protocol);
    expect(await fs.pathExists(startedFile)).toBe(false);
  });

  it('runs both preferred backends from identical bundled cases in explicit fixture mode', async () => {
    const { repoRoot } = await prepareNativeTest('preferred');
    const contextFile = path.join(repoRoot, 'native-context.json');
    await fs.writeJson(contextFile, { schemaVersion: 1, tools: { job: ready } });
    const output = captureOutput();
    const prepare = vi.fn(async () => process.execPath);
    expect(await runPluginScriptTests(['git-commit', '--platform', 'codex', '--native-context', contextFile], {
      repoRoot, nativePlatform: 'win32', nativePrepare: prepare, env: { ...process.env, aw_native_other: 'untrusted', AW_NATIVE_TOOL_CONTEXT: 'untrusted' }, ...output,
    })).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(output.readStdout()).toContain('native-backend=ready');
    expect(output.readStdout()).toContain('native-backend=unavailable');
    expect(output.readStdout()).toContain('"mode":"fixture","backend":"portable"');
    await fs.writeJson(contextFile, { schemaVersion: 1, tools: { job: { ...ready, extra: true } } });
    expect(await runPluginScriptTests(['git-commit', '--platform', 'codex', '--native-context', contextFile], { repoRoot, nativePlatform: 'win32', ...captureOutput() })).toBe(1);
  });

  it('uses the installed Eval dependency and stops before starting a consumer when it is missing', async () => {
    const { repoRoot, startedFile } = await prepareNativeTest();
    const prepare = vi.fn(async () => process.execPath);
    const args = ['git-commit', '--platform', 'codex', '--native-mode', 'installed'];
    expect(await runPluginScriptTests(args, { repoRoot, nativePlatform: 'win32', nativePrepare: prepare, ...captureOutput() })).toBe(0);
    expect(await fs.readFile(startedFile, 'utf8')).toBe('started');
    await fs.remove(startedFile);
    const missing = async () => { throw Object.assign(new Error('Reinstall the current CLI/Eval with optional dependencies.'), { code: 'nativeToolDependencyMissing' }); };
    const output = captureOutput();
    expect(await runPluginScriptTests(args, { repoRoot, nativePlatform: 'win32', nativePrepare: missing, ...output })).toBe(1);
    expect(await fs.pathExists(startedFile)).toBe(false);
    expect(output.readStderr()).toContain('optional dependencies');
  });

  it('requires an explicit Windows fixture before starting a test consumer', async () => {
    const { repoRoot, startedFile } = await prepareNativeTest();
    expect(await runPluginScriptTests(['git-commit', '--platform', 'codex'], {
      repoRoot, nativePlatform: 'win32', ...captureOutput(),
    })).toBe(1);
    expect(await fs.pathExists(startedFile)).toBe(false);
  });

  it('keeps non-Windows tests independent of Windows packages', async () => {
    const { repoRoot } = await prepareNativeTest();
    await writeNodeTestFile(repoRoot, 'native.test.mjs', 'import test from "node:test"; import assert from "node:assert/strict"; test("no Windows tool",()=>{assert.equal(process.env.AW_NATIVE_TOOL_CONTEXT,undefined);});');
    const prepare = vi.fn(async () => process.execPath);
    expect(await runPluginScriptTests(['git-commit', '--platform', 'codex'], { repoRoot, nativePlatform: 'darwin', nativePrepare: prepare, ...captureOutput() })).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
  });
});
