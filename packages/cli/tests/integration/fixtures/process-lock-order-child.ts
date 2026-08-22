import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import nodeFs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { createCliExecutionContext } from '../../../src/commands/runtime.js';
import {
  createTuiControllerDependencies,
  setTuiControllerRuntimeTestHooksForTests,
} from '../../../src/tui/controller-runtime.js';
import { catalogSourceCacheInternal } from '../../../src/utils/catalog-source-cache.js';
import { setPluginConfigWriteTestHooksForTests } from '../../../src/utils/plugin-config-write.js';
import { registerCurrentTestWritableStateRoot } from '../../setup/test-isolation.js';

const role = process.env.AW_LOCK_ORDER_ROLE;
const sharedRoot = process.env.AW_LOCK_ORDER_SHARED_ROOT;
const controlRoot = process.env.AW_LOCK_ORDER_CONTROL_ROOT;
const fixtureCwd = process.env.AW_LOCK_ORDER_CWD;
const failureMode = process.env.AW_LOCK_ORDER_FAILURE_MODE;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await fs.pathExists(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path.basename(filePath)}.`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function signal(name: string): Promise<void> {
  await fs.outputFile(path.join(controlRoot!, name), '');
}

async function waitForSignal(name: string): Promise<void> {
  await waitForFile(path.join(controlRoot!, name));
}

async function writeEvidenceJsonAtomic(
  finalPath: string,
  value: unknown,
  delayPublication = false,
): Promise<void> {
  const runToken = crypto.randomUUID();
  const temporaryPath = `${finalPath}.${process.pid}.${runToken}.tmp`;
  const serialized = `${JSON.stringify(value)}\n`;
  let handle: Awaited<ReturnType<typeof nodeFs.open>> | undefined;
  try {
    handle = await nodeFs.open(temporaryPath, 'wx');
    if (delayPublication) {
      const splitAt = Math.max(1, Math.floor(serialized.length / 2));
      await handle.write(serialized.slice(0, splitAt));
      await signal(`${role}-evidence-temp-partial`);
      await waitForSignal(`${role}-evidence-temp-release`);
      await handle.write(serialized.slice(splitAt));
    } else {
      await handle.writeFile(serialized, 'utf8');
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await nodeFs.rename(temporaryPath, finalPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await nodeFs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

describe.skipIf(role !== 'plugin' && role !== 'config')('production lock-order child', () => {
  it('runs the real TUI write bridge in a separate process', async () => {
    await writeEvidenceJsonAtomic(path.join(controlRoot!, `${role}-process.json`), {
      coordinatorPid: process.ppid,
      workerPid: process.pid,
    }, process.env.AW_LOCK_ORDER_DELAY_EVIDENCE === role);
    registerCurrentTestWritableStateRoot(sharedRoot!, 'cross-process production lock-order fixture');
    const runtimeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: requiredEnv('AW_LOCK_ORDER_HOME'),
      USERPROFILE: requiredEnv('AW_LOCK_ORDER_HOME'),
      AW_HOME: requiredEnv('AW_LOCK_ORDER_AW_HOME'),
      AW_CODEX_HOME: requiredEnv('AW_LOCK_ORDER_CODEX_HOME'),
      AW_CLAUDE_HOME: requiredEnv('AW_LOCK_ORDER_CLAUDE_HOME'),
      XDG_CONFIG_HOME: requiredEnv('AW_LOCK_ORDER_XDG_CONFIG_HOME'),
      XDG_CACHE_HOME: requiredEnv('AW_LOCK_ORDER_XDG_CACHE_HOME'),
      XDG_STATE_HOME: requiredEnv('AW_LOCK_ORDER_XDG_STATE_HOME'),
      TMPDIR: requiredEnv('AW_LOCK_ORDER_TMP'),
      TEMP: requiredEnv('AW_LOCK_ORDER_TMP'),
      TMP: requiredEnv('AW_LOCK_ORDER_TMP'),
    };
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: fixtureCwd!,
      env: runtimeEnv,
      nativeCliRunner: async (invocation) => ({
        exitCode: 0,
        stdout: invocation.command === 'claude' ? 'claude 99.0.0' : 'codex-cli 99.0.0',
        stderr: '',
      }),
      interactive: false,
    }));

    const actions = role === 'plugin'
      ? ['reinstall', 'upgrade'] as const
      : ['save', 'reset'] as const;
    for (let index = 0; index < actions.length; index += 1) {
      const round = index + 1;
      const action = actions[index]!;
      catalogSourceCacheInternal.setAfterRootLeaseAcquireHookForTests(undefined);
      setTuiControllerRuntimeTestHooksForTests(undefined);
      setPluginConfigWriteTestHooksForTests(undefined);
      const intent = role === 'plugin'
        ? {
            kind: 'pluginWrite' as const,
            action: action as 'reinstall' | 'upgrade',
            pluginId: 'team/demo',
            platform: 'codex' as const,
            scope: 'project' as const,
          }
        : action === 'save'
          ? {
              kind: 'configSave' as const,
              pluginId: 'team/demo',
              scope: 'project' as const,
              projectLayer: 'shared' as const,
              updates: { mode: 'strict' },
            }
          : {
              kind: 'configReset' as const,
              pluginId: 'team/demo',
              scope: 'project' as const,
              projectLayer: 'shared' as const,
            };
      const evidence = await dependencies.captureEvidence(intent);

      let rootLeaseAcquisitions = 0;
      catalogSourceCacheInternal.setAfterRootLeaseAcquireHookForTests(async () => {
        rootLeaseAcquisitions += 1;
        if (rootLeaseAcquisitions === 1) {
          await signal(`${role}-${round}-cache-preflight`);
          return;
        }
        await signal(`${role}-${round}-cache`);
        if (failureMode === 'child-failure' && role === 'plugin' && round === 1) {
          await waitForSignal('plugin-1-fail');
          throw new Error('forced process-lock child failure');
        }
        await waitForSignal(`${role}-${round}-cache-release`);
      });
      if (role === 'plugin') {
        setTuiControllerRuntimeTestHooksForTests({
          afterPluginOperationLocksAcquire: async () => {
            await signal(`plugin-${round}-target`);
            await waitForSignal(`plugin-${round}-target-release`);
          },
        });
      } else {
        let stoppedAtTarget = false;
        setPluginConfigWriteTestHooksForTests({
          beforeOperationLockAcquire: async () => {
            if (stoppedAtTarget) return;
            stoppedAtTarget = true;
            await signal(`config-${round}-target`);
            await waitForSignal(`config-${round}-target-release`);
          },
        });
      }

      await signal(`${role}-${round}-prepared`);
      await waitForSignal(`${role}-${round}-start`);
      await signal(`${role}-${round}-executing`);
      const result = await dependencies.executeIntent(intent, evidence);
      catalogSourceCacheInternal.setAfterRootLeaseAcquireHookForTests(undefined);
      setTuiControllerRuntimeTestHooksForTests(undefined);
      setPluginConfigWriteTestHooksForTests(undefined);
      if (role === 'plugin') {
        expect(result).toMatchObject({ overallState: 'succeeded' });
      } else {
        expect(result).toMatchObject({ configWrite: 'succeeded' });
      }
      expect(JSON.stringify(result)).not.toContain('operation.lock timeout');
      await writeEvidenceJsonAtomic(
        path.join(controlRoot!, `${role}-${round}-result.json`),
        { action },
      );
      await signal(`${role}-${round}-done`);
    }
  }, 60_000);
});
