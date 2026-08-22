import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { installWriteCommand } from '../../src/commands/write-commands.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import {
  getCurrentSourceTestIsolation,
  type ActiveSourceTestIsolation,
} from '../setup/test-isolation.js';
import { waitForProcessExit } from '../support/process-tree.js';
import { runSmokeNodeProcess } from '../support/smoke-node-runner.js';

const require = createRequire(import.meta.url);
const vitestCliPath = require.resolve('vitest/vitest.mjs');
const cliPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const childConfigPath = path.join(cliPackageRoot, 'vitest.process-lock-child.config.ts');
const roles = ['plugin', 'config'] as const;

type LockOrderRole = typeof roles[number];

interface LockOrderHarness {
  isolation: ActiveSourceTestIsolation;
  controlRoot: string;
  childEnv: NodeJS.ProcessEnv;
}

interface ProcessEvidence {
  coordinatorPid: number;
  workerPid: number;
}

async function waitForFile(filePath: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await fs.pathExists(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path.basename(filePath)}.`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function prepareLockOrderHarness(): Promise<LockOrderHarness> {
  const isolation = getCurrentSourceTestIsolation();
  const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cross-process-lock-source');
  await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'render.mjs'), [
    'const files = { "SKILL.md": "---\\nname: lock-order\\ndescription: Lock order.\\n---\\n", "README.md": "Lock order.\\n", "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n" };',
    'console.log(JSON.stringify({ version: 2, artifacts: [{',
    '  id: "codex-lock-order", kind: "skill", platform: "codex",',
    '  target: "codex.skill", state: "present", refreshKeys: [],',
    '  skillKey: "lock-order", content: { files }',
    '}] }));',
  ].join('\n'));
  await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
    manifest.marketplace.policy.products = ['CODEX'];
    manifest.scripts = {
      artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
    };
    manifest.artifacts = {
      targets: [{
        id: 'codex-lock-order',
        platform: 'codex',
        scopes: ['project'],
        target: 'codex.skill',
        states: ['present'],
        refreshKeys: [],
        skillKey: 'lock-order',
      }],
    };
    manifest.config = { schema: { mode: { type: 'string', title: 'Mode' } } };
  });
  const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 1,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
    },
    expectedDigest: snapshot.digest,
    env: isolation.env,
  });
  const nativeCliRunner = async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' });
  await expect(installWriteCommand(['team/demo'], {
    cwd: isolation.layout.fixtureCwd,
    platform: 'codex',
    scope: 'project',
  }, { env: isolation.env, nativeCliRunner })).resolves.toMatchObject({ overallState: 'succeeded' });

  const controlRoot = path.join(isolation.layout.fixtureCwd, 'cross-process-lock-control');
  await fs.ensureDir(controlRoot);
  return {
    isolation,
    controlRoot,
    childEnv: {
      ...process.env,
      AW_LOCK_ORDER_SHARED_ROOT: isolation.layout.rootDir,
      AW_LOCK_ORDER_CONTROL_ROOT: controlRoot,
      AW_LOCK_ORDER_CWD: isolation.layout.fixtureCwd,
      AW_LOCK_ORDER_HOME: isolation.env.HOME,
      AW_LOCK_ORDER_AW_HOME: isolation.env.AW_HOME,
      AW_LOCK_ORDER_CODEX_HOME: isolation.env.AW_CODEX_HOME,
      AW_LOCK_ORDER_CLAUDE_HOME: isolation.env.AW_CLAUDE_HOME,
      AW_LOCK_ORDER_XDG_CONFIG_HOME: isolation.env.XDG_CONFIG_HOME,
      AW_LOCK_ORDER_XDG_CACHE_HOME: isolation.env.XDG_CACHE_HOME,
      AW_LOCK_ORDER_XDG_STATE_HOME: isolation.env.XDG_STATE_HOME,
      AW_LOCK_ORDER_TMP: isolation.env.TMPDIR,
    },
  };
}

function startCoordinator(
  harness: LockOrderHarness,
  role: LockOrderRole,
  signal: AbortSignal,
  failureMode?: 'child-failure',
  delayEvidence = false,
): Promise<unknown | undefined> {
  return runSmokeNodeProcess({
    scriptPath: vitestCliPath,
    args: [
      'run',
      '--config',
      childConfigPath,
      '--maxWorkers=1',
      '--reporter=dot',
    ],
    cwd: cliPackageRoot,
    env: {
      ...harness.childEnv,
      AW_LOCK_ORDER_ROLE: role,
      AW_LOCK_ORDER_FAILURE_MODE: failureMode,
      AW_LOCK_ORDER_DELAY_EVIDENCE: delayEvidence ? role : undefined,
    },
    timeoutMs: 90_000,
    signal,
    cleanupOnFailure: [],
  }).then(() => undefined, (error: unknown) => error);
}

async function readProcessEvidence(
  controlRoot: string,
  role: LockOrderRole,
): Promise<ProcessEvidence> {
  const evidencePath = path.join(controlRoot, `${role}-process.json`);
  await waitForFile(evidencePath);
  return fs.readJson(evidencePath) as Promise<ProcessEvidence>;
}

async function assertProcessTreesExited(evidence: ProcessEvidence[]): Promise<void> {
  for (const entry of evidence) {
    expect(entry.coordinatorPid).not.toBe(entry.workerPid);
  }
  await Promise.all(evidence.flatMap((entry) => [
    waitForProcessExit(entry.coordinatorPid, 5_000),
    waitForProcessExit(entry.workerPid, 5_000),
  ]));
}

async function removeAbnormalRunState(harness: LockOrderHarness): Promise<void> {
  process.chdir(cliPackageRoot);
  await harness.isolation.cleanup();
  await expect(fs.pathExists(harness.isolation.layout.rootDir)).resolves.toBe(false);
}

async function settleAbnormalRun(
  harness: LockOrderHarness,
  abortController: AbortController,
  completions: Array<Promise<unknown | undefined>>,
  evidence: ProcessEvidence[],
  reason: string,
): Promise<Array<unknown | undefined>> {
  abortController.abort(new Error(reason));
  const outcomes = await Promise.all(completions);
  try {
    await assertProcessTreesExited(evidence);
  } finally {
    await removeAbnormalRunState(harness);
  }
  return outcomes;
}

describe('cross-process production write lock order', () => {
  it('keeps the child entry out of main integration suite discovery', () => {
    const listed = spawnSync(process.execPath, [
      vitestCliPath,
      'list',
      'tests/integration',
      '--filesOnly',
      '--json',
    ], {
      cwd: cliPackageRoot,
      encoding: 'utf8',
    });
    expect(listed.status, listed.stderr).toBe(0);
    const files = (JSON.parse(listed.stdout) as Array<{ file: string }>).map((entry) => entry.file);
    expect(files).not.toContain(path.join(
      cliPackageRoot,
      'tests/integration/fixtures/process-lock-order-child.ts',
    ));
    expect(files).toContain(fileURLToPath(import.meta.url));
  });

  it('publishes complete process evidence atomically', async () => {
    const harness = await prepareLockOrderHarness();
    const abortController = new AbortController();
    const completion = startCoordinator(
      harness,
      'plugin',
      abortController.signal,
      undefined,
      true,
    );
    let evidence: ProcessEvidence | undefined;
    let outcomes: Array<unknown | undefined> = [];
    try {
      await waitForFile(path.join(harness.controlRoot, 'plugin-evidence-temp-partial'));
      const finalPath = path.join(harness.controlRoot, 'plugin-process.json');
      await expect(fs.pathExists(finalPath)).resolves.toBe(false);
      const temporaryNames = (await fs.readdir(harness.controlRoot))
        .filter((entry) => entry.startsWith('plugin-process.json.') && entry.endsWith('.tmp'));
      expect(temporaryNames).toHaveLength(1);
      await expect(fs.readJson(path.join(harness.controlRoot, temporaryNames[0]!)))
        .rejects.toThrow();

      await fs.outputFile(path.join(harness.controlRoot, 'plugin-evidence-temp-release'), '');
      evidence = await readProcessEvidence(harness.controlRoot, 'plugin');
      await expect(fs.readdir(harness.controlRoot)).resolves.not.toEqual(
        expect.arrayContaining(temporaryNames),
      );
    } finally {
      outcomes = await settleAbnormalRun(
        harness,
        abortController,
        [completion],
        evidence ? [evidence] : [],
        'atomic evidence test cleanup',
      );
    }
    expect(outcomes).toEqual([expect.objectContaining({ reason: 'aborted' })]);
  }, 90_000);

  it('serializes TUI reinstall/upgrade with config save/reset without ABBA', async () => {
    const harness = await prepareLockOrderHarness();
    const abortController = new AbortController();
    const completions = roles.map((role) => startCoordinator(
      harness,
      role,
      abortController.signal,
    ));

    try {
      for (const round of [1, 2]) {
        await Promise.all(roles.map((role) => waitForFile(path.join(
          harness.controlRoot,
          `${role}-${round}-prepared`,
        ))));
        await fs.outputFile(path.join(harness.controlRoot, `plugin-${round}-start`), '');
        await waitForFile(path.join(harness.controlRoot, `plugin-${round}-cache`));
        await fs.outputFile(path.join(harness.controlRoot, `plugin-${round}-cache-release`), '');
        await waitForFile(path.join(harness.controlRoot, `plugin-${round}-target`));

        await fs.outputFile(path.join(harness.controlRoot, `config-${round}-start`), '');
        await waitForFile(path.join(harness.controlRoot, `config-${round}-executing`));
        await fs.outputFile(path.join(harness.controlRoot, `plugin-${round}-target-release`), '');
        await waitForFile(path.join(harness.controlRoot, `plugin-${round}-done`));

        await waitForFile(path.join(harness.controlRoot, `config-${round}-cache`));
        await fs.outputFile(path.join(harness.controlRoot, `config-${round}-cache-release`), '');
        await waitForFile(path.join(harness.controlRoot, `config-${round}-target`));
        await fs.outputFile(path.join(harness.controlRoot, `config-${round}-target-release`), '');
        await waitForFile(path.join(harness.controlRoot, `config-${round}-done`));
      }
      await expect(Promise.all(completions)).resolves.toEqual([undefined, undefined]);
    } finally {
      abortController.abort(new Error('lock-order parent cleanup'));
      await Promise.all(completions);
    }

    await expect(fs.readJson(path.join(harness.controlRoot, 'plugin-1-result.json'))).resolves.toEqual({ action: 'reinstall' });
    await expect(fs.readJson(path.join(harness.controlRoot, 'plugin-2-result.json'))).resolves.toEqual({ action: 'upgrade' });
    await expect(fs.readJson(path.join(harness.controlRoot, 'config-1-result.json'))).resolves.toEqual({ action: 'save' });
    await expect(fs.readJson(path.join(harness.controlRoot, 'config-2-result.json'))).resolves.toEqual({ action: 'reset' });
  }, 90_000);

  it('terminates both coordinator trees and removes lock/temp state after a parent barrier timeout', async () => {
    const harness = await prepareLockOrderHarness();
    const abortController = new AbortController();
    const completions = roles.map((role) => startCoordinator(
      harness,
      role,
      abortController.signal,
    ));
    let evidence: ProcessEvidence[] = [];
    let barrierError: unknown;
    let outcomes: Array<unknown | undefined> = [];
    try {
      evidence = await Promise.all(roles.map((role) => readProcessEvidence(
        harness.controlRoot,
        role,
      )));
      await Promise.all(roles.map((role) => waitForFile(path.join(
        harness.controlRoot,
        `${role}-1-prepared`,
      ))));
      await fs.outputFile(path.join(harness.controlRoot, 'plugin-1-start'), '');
      await waitForFile(path.join(harness.controlRoot, 'plugin-1-cache'));
      await waitForFile(path.join(harness.controlRoot, 'forced-missing-barrier'), 100);
    } catch (error) {
      barrierError = error;
    } finally {
      outcomes = await settleAbnormalRun(
        harness,
        abortController,
        completions,
        evidence,
        'forced parent barrier timeout',
      );
    }

    expect(barrierError).toBeInstanceOf(Error);
    expect((barrierError as Error).message).toContain('forced-missing-barrier');
    expect(outcomes).toEqual([
      expect.objectContaining({ reason: 'aborted' }),
      expect.objectContaining({ reason: 'aborted' }),
    ]);
  }, 90_000);

  it('terminates the sibling coordinator tree and removes lock/temp state after a worker failure', async () => {
    const harness = await prepareLockOrderHarness();
    const abortController = new AbortController();
    const completions = [
      startCoordinator(harness, 'plugin', abortController.signal, 'child-failure'),
      startCoordinator(harness, 'config', abortController.signal),
    ];
    let evidence: ProcessEvidence[] = [];
    let pluginOutcome: unknown;
    let outcomes: Array<unknown | undefined> = [];
    try {
      evidence = await Promise.all(roles.map((role) => readProcessEvidence(
        harness.controlRoot,
        role,
      )));
      await Promise.all(roles.map((role) => waitForFile(path.join(
        harness.controlRoot,
        `${role}-1-prepared`,
      ))));
      await fs.outputFile(path.join(harness.controlRoot, 'plugin-1-start'), '');
      await waitForFile(path.join(harness.controlRoot, 'plugin-1-cache'));
      await fs.outputFile(path.join(harness.controlRoot, 'plugin-1-fail'), '');
      pluginOutcome = await completions[0];
    } finally {
      outcomes = await settleAbnormalRun(
        harness,
        abortController,
        completions,
        evidence,
        'sibling child failed',
      );
    }

    expect(pluginOutcome).toBeInstanceOf(Error);
    expect((pluginOutcome as Error).message).toContain('forced process-lock child failure');
    expect(outcomes[1]).toEqual(expect.objectContaining({ reason: 'aborted' }));
  }, 90_000);
});
