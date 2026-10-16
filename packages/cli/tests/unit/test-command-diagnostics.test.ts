import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { sanitizeTestDiagnostic, TestCommandDiagnostics } from '../helpers/test-command-diagnostics.js';
import { waitForProcessExit } from '../support/process-tree.js';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

async function writeFixtureConfig(root: string, fixture: string, sourceIsolation = false): Promise<string> {
  const config = path.join(root, 'vitest.config.mjs');
  await fs.writeFile(config, [
    `import base from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'vitest.config.ts')).href)};`,
    `export default { ...base, root: ${JSON.stringify(root)}, test: { environment: 'node', include: [${JSON.stringify(fixture)}], hookTimeout: 10000, maxWorkers: 1, minWorkers: 1,`,
    `setupFiles: ${JSON.stringify(sourceIsolation ? [path.join(packageRoot, 'tests/setup/test-isolation.ts')] : [])} } };`,
  ].join('\n'));
  return config;
}

describe('test command diagnostics', () => {
  it('archives numeric npm timing and cache evidence without paths, URLs, or credentials', async ({ task, signal }) => {
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, 'aw-diagnostic-redaction-'));
    process.env.AW_TEST_DIAGNOSTICS_DIR = path.join(root, 'diagnostics');
    process.env.NPM_TOKEN = 'private-test-token';
    const diagnostics = new TestCommandDiagnostics('npm', task.name, signal);
    const logs = path.join(root, 'raw-logs');
    await fs.outputFile(path.join(logs, 'test-debug-0.log'), [
      'http fetch GET 200 https://user:private-test-token@private.example/pkg (cache hit)',
      'http fetch GET 200 https://private.example/pkg (cache miss)',
      'http fetch GET 200 https://private.example/pkg (cache revalidated)',
    ].join('\n'));
    await fs.outputJson(path.join(logs, 'test-timing.json'), {
      metadata: { command: [root, 'private-test-token'] },
      timers: { npm: 123, [`build:${root}`]: 42, 'token=private-test-token': 5 },
      unfinishedTimers: { install: [1, 2] },
    });
    await diagnostics.npmLogs(logs, path.join(process.env.HOME!, '.npm'));
    await diagnostics.finish();
    const files = await fs.readdir(path.join(root, 'diagnostics', 'npm'));
    expect(files.every((name) => name.endsWith('.json'))).toBe(true);
    const summaryPath = path.join(root, 'diagnostics', 'npm', `${diagnostics.id}-npm.json`);
    const summary = await fs.readJson(summaryPath);
    expect(summary).toMatchObject({
      cache: path.join('[home]', '.npm'), cacheLocation: 'isolated-home',
      cacheHits: 1, cacheMisses: 1, cacheRevalidated: 1,
      timing: [{ timers: { npm: 123 }, unfinishedTimers: { install: [1, 2] } }],
    });
    const archived = await fs.readFile(summaryPath, 'utf8');
    for (const secret of [root, 'private-test-token', 'private.example', 'metadata']) {
      expect(archived).not.toContain(secret);
    }
    expect(sanitizeTestDiagnostic('C:\\Users\\private\\cache https://private.example token=private-test-token'))
      .toBe('[path] [url] token=[secret]');
  });

  it('waits for real Vitest timeout cleanup before deleting fixtures and starting the next case', async ({ task, signal }) => {
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, 'aw-diagnostic-timeout-'));
    const fixture = path.join(root, 'timeout.test.mjs');
    const helperUrl = pathToFileURL(path.join(packageRoot, 'tests/helpers/test-command-diagnostics.ts')).href;
    const originalFailure = 'original intentional timeout';
    await fs.writeFile(fixture, [
      "import fs from 'node:fs/promises';",
      "import path from 'node:path';",
      "import { afterEach, expect, it } from 'vitest';",
      `import { TestCommandDiagnostics } from ${JSON.stringify(helperUrl)};`,
      'let scope; let currentRoot; let firstRoot;',
      'afterEach(async () => {',
      '  await scope.finish();',
      '  await fs.rm(currentRoot, { recursive: true, force: true });',
      '});',
      `it(${JSON.stringify(originalFailure)}, async ({ task, signal }) => {`,
      "  currentRoot = firstRoot = await fs.mkdtemp(path.join(process.env.TMPDIR, 'owned-'));",
      "  scope = new TestCommandDiagnostics('publisher', task.name, signal);",
      '  await scope.run(async () => {',
      '    const childSource = [',
      '      "const fs = require(\'node:fs\');",',
      '      "const { spawn } = require(\'node:child_process\');",',
      '      "const grandchild = spawn(process.execPath, [\'-e\', \'setTimeout(() => process.exit(124), 20000); setInterval(() => {}, 1000)\'], { cwd: process.cwd(), stdio: \'ignore\' });",',
      `      ${JSON.stringify(`fs.writeFileSync(${JSON.stringify(path.join(root, 'pids.json'))}, JSON.stringify({ root: process.pid, grandchild: grandchild.pid }));`)},`,
      `      ${JSON.stringify(`console.error(${JSON.stringify(originalFailure)});`)},`,
      '      "process.on(\'SIGTERM\', () => {});",',
      '      "setTimeout(() => process.exit(124), 20000);",',
      '      "setInterval(() => {}, 1000);",',
      '    ].join("\\n");',
      '    await scope.command(process.execPath, ["-e", childSource], { cwd: currentRoot });',
      '  });',
      '}, 1000);',
      'it("uses a fresh fixture after timeout", async ({ task, signal }) => {',
      "  scope = new TestCommandDiagnostics('publisher', task.name, signal);",
      "  currentRoot = await fs.mkdtemp(path.join(process.env.TMPDIR, 'owned-'));",
      '  expect(currentRoot).not.toBe(firstRoot);',
      '  await expect(fs.stat(firstRoot)).rejects.toMatchObject({ code: "ENOENT" });',
      '  await fs.writeFile(path.join(currentRoot, "fresh"), "next case");',
      `  await fs.writeFile(${JSON.stringify(path.join(root, 'next-case.json'))}, JSON.stringify({ firstRoot, currentRoot }));`,
      '});',
    ].join('\n'));
    const config = await writeFixtureConfig(root, 'timeout.test.mjs');
    const scope = new TestCommandDiagnostics('publisher', task.name, signal);
    const started = Date.now();
    let failure: unknown;
    try {
      await scope.command(process.execPath, [
        path.resolve(packageRoot, '../../scripts/test/run-vitest.mjs'),
        'run', '--config', config, '--maxWorkers=1', '--no-file-parallelism',
      ], {
        cwd: packageRoot,
        env: { ...process.env, AW_TEST_DIAGNOSTICS_DIR: path.join(root, 'diagnostics') },
      });
    } catch (error) {
      failure = error;
    } finally {
      await scope.finish();
    }
    expect(String(failure)).toContain('Test timed out in 1000ms');
    expect(String(failure)).toContain(originalFailure);
    expect(Date.now() - started).toBeLessThan(12_000);
    const pids = await fs.readJson(path.join(root, 'pids.json')) as { root: number; grandchild: number };
    await Promise.all(Object.values(pids).map((pid) => waitForProcessExit(pid)));
    const next = await fs.readJson(path.join(root, 'next-case.json')) as { firstRoot: string; currentRoot: string };
    expect(next.firstRoot).not.toBe(next.currentRoot);
    await expect(fs.pathExists(next.firstRoot)).resolves.toBe(false);
    await expect(fs.pathExists(next.currentRoot)).resolves.toBe(false);
    const reports = await fs.readdir(path.join(root, 'diagnostics', 'publisher'));
    const events = (await Promise.all(reports.map((name) => fs.readJson(path.join(root, 'diagnostics', 'publisher', name)))))
      .flatMap((report) => report.events);
    expect(events).toContainEqual(expect.objectContaining({ state: 'cancelled', error: expect.stringContaining('1000ms') }));
    expect(events).toContainEqual(expect.objectContaining({ metrics: expect.objectContaining({ leakedProcessCount: 0, cleanupFailureCount: 0 }) }));
  });

  it('retains only the failed pack isolation and blocks later cases from consuming it', async ({ task, signal }) => {
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, 'aw-pack-retention-'));
    const report = path.join(root, 'report.json');
    await fs.writeFile(path.join(root, 'retention.test.mjs'), [
      "import fs from 'node:fs/promises';",
      "import { afterAll, vi } from 'vitest';",
      'const state = vi.hoisted(() => ({',
      '  scopes: [], runCalls: 0, home: process.env.HOME, tmp: process.env.TMPDIR, cwd: process.cwd(),',
      '}));',
      // Inject only the reported cleanup failure. The actual pack hooks and source isolation still run.
      `vi.mock(${JSON.stringify(path.join(packageRoot, 'tests/helpers/test-command-diagnostics.ts'))}, async () => {`,
      '  const { mkdirSync } = await import("node:fs");',
      '  return {',
      '  TestCommandDiagnostics: class {',
      '    constructor() {',
      '      this.index = state.scopes.length;',
      '      mkdirSync(process.env.HOME, { recursive: true });',
      '      state.scopes.push({ home: process.env.HOME, tmp: process.env.TMPDIR });',
      '    }',
      '    async run() { state.runCalls++; throw new Error("original fixture failure"); }',
      '    async finish() { if (this.index === 0) throw new Error("injected cleanup unconfirmed"); }',
      '  },',
      '  };',
      '});',
      `import ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'tests/smoke/pack-smoke.test.ts')).href)};`,
      'afterAll(async () => {',
      '  const exists = async (value) => fs.stat(value).then(() => true, () => false);',
      `  await fs.writeFile(${JSON.stringify(report)}, JSON.stringify({`,
      '    runCalls: state.runCalls, scopes: state.scopes,',
      '    homeRestored: process.env.HOME === state.home, tmpRestored: process.env.TMPDIR === state.tmp,',
      '    cwdRestored: process.cwd() === state.cwd,',
      '    retained: await exists(state.scopes[0].home) && await exists(state.scopes[0].tmp),',
      '    laterRemoved: (await Promise.all(state.scopes.slice(1).map(async ({ home, tmp }) => !await exists(home) && !await exists(tmp)))).every(Boolean),',
      '  }));',
      '});',
    ].join('\n'));
    const config = await writeFixtureConfig(root, 'retention.test.mjs', true);
    const scope = new TestCommandDiagnostics('publisher', task.name, signal);
    let failure: unknown;
    try {
      await scope.command(process.execPath, [
        path.resolve(packageRoot, '../../scripts/test/run-vitest.mjs'),
        'run', '--config', config, '--maxWorkers=1', '--no-file-parallelism',
      ], { cwd: packageRoot });
    } catch (error) {
      failure = error;
    } finally {
      await scope.finish();
    }
    expect(String(failure)).toContain('original fixture failure');
    expect(String(failure)).toContain('injected cleanup unconfirmed');
    expect(String(failure)).toContain('Retained this case');
    expect(await fs.readJson(report)).toMatchObject({
      runCalls: 1,
      scopes: Array.from({ length: 5 }, () => expect.objectContaining({ home: expect.any(String), tmp: expect.any(String) })),
      homeRestored: true, tmpRestored: true, cwdRestored: true, retained: true, laterRemoved: true,
    });
  });

  it('cancels a detached nested native runner that replaces its own process marker', async ({ task }) => {
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, 'aw-nested-native-'));
    const pidFile = path.join(root, 'pids.json');
    const nativeUrl = pathToFileURL(path.join(packageRoot, 'src/utils/native-cli.ts')).href;
    const nestedSource = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(124), 20000); setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ native: process.pid, grandchild: grandchild.pid }));`,
      "process.on('SIGTERM', () => {});",
      'setTimeout(() => process.exit(124), 20000);',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    await fs.writeFile(path.join(root, 'nested.test.mjs'), [
      "import { it } from 'vitest';",
      `import { createExecFileNativeCliRunner } from ${JSON.stringify(nativeUrl)};`,
      'it("waits in a native runner without passing the test signal", async () => {',
      '  const watchdog = setTimeout(() => process.exit(124), 20000);',
      '  try {',
      `    await createExecFileNativeCliRunner()({ command: process.execPath, args: ['-e', ${JSON.stringify(nestedSource)}], cwd: ${JSON.stringify(root)}, env: process.env });`,
      '  } finally { clearTimeout(watchdog); }',
      '}, 10000);',
    ].join('\n'));
    const config = await writeFixtureConfig(root, 'nested.test.mjs');
    const controller = new AbortController();
    const scope = new TestCommandDiagnostics('publisher', task.name, controller.signal);
    const running = scope.run(() => scope.command(process.execPath, [
      path.resolve(packageRoot, '../../scripts/test/run-vitest.mjs'),
      'run', '--config', config, '--maxWorkers=1', '--no-file-parallelism',
    ], { cwd: packageRoot }));
    const outcome = running.then(() => undefined, (error: unknown) => error);
    let pids: Record<string, number> | undefined;
    try {
      const deadline = Date.now() + 5_000;
      while (!pids && Date.now() < deadline) {
        try {
          pids = await fs.readJson(pidFile) as Record<string, number>;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(pids).toBeDefined();
      const started = Date.now();
      controller.abort(new Error('intentional outer cancellation'));
      expect(String(await outcome)).toContain('intentional outer cancellation');
      await scope.finish();
      await Promise.all(Object.values(pids!).map((pid) => waitForProcessExit(pid)));
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      controller.abort(new Error('fixture cleanup'));
      await Promise.allSettled([running, scope.finish()]);
      // Safety only: each fixture also has a 20 second self-exit deadline.
      for (const pid of Object.values(pids ?? {})) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
  });
});
