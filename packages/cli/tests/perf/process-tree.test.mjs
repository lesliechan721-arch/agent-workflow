import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ProcessTreeTimeoutError,
  parsePosixProcessTree,
  parseWindowsProcessTree,
  runProcessTree,
} from '../../../../scripts/perf/process-tree.mjs';

const roots = [];
const observedPids = [];
const itOnPosix = process.platform === 'win32' ? it.skip : it;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessesToExit(pids, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (pids.some(isProcessAlive) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readJsonEventually(filePath, timeoutMs = 500) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function processTreeSnapshot(rootPid, pids, options = {}) {
  const rows = [
    `${pids.child} 1 child-start`,
    ...(!options.omitGrandchild
      ? [`${pids.grandchild} ${pids.child} ${options.grandchildStart ?? 'grandchild-start'}`]
      : []),
  ];
  return parsePosixProcessTree(rootPid, rows.join('\n'));
}

afterEach(async () => {
  for (const pid of observedPids.splice(0)) {
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The process exited between the check and the signal.
      }
    }
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('performance gate process tree cleanup', () => {
  itOnPosix('removes a detached grandchild after a bounded timeout', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-perf-process-tree-'));
    roots.push(root);
    const pidFile = path.join(root, 'pids.json');
    const grandchildSource = [
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const childSource = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { detached: true, stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));`,
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n');

    const startedAt = performance.now();
    let grandchildKilled = false;
    let failure;
    try {
      await runProcessTree({
        label: 'process tree fixture',
        command: process.execPath,
        args: ['-e', childSource],
        env: process.env,
        timeoutMs: 300,
        descendantMonitorIntervalMs: 25,
        terminationGraceMs: 100,
        cleanupSettleMs: 150,
      }, {
        snapshotPosixProcessTree: async (rootPid) => processTreeSnapshot(
          rootPid,
          await readJsonEventually(pidFile),
          { omitGrandchild: grandchildKilled },
        ),
        verifyPosixProcessTree: async (rootPid) => processTreeSnapshot(
          rootPid,
          await readJsonEventually(pidFile),
          { omitGrandchild: grandchildKilled },
        ),
        killPosixProcess: (pid, signal) => {
          if (signal === 'SIGKILL') {
            grandchildKilled = true;
          }
          process.kill(pid, signal);
        },
      });
    } catch (error) {
      failure = error;
    }
    const elapsedMs = performance.now() - startedAt;
    const pids = await readJsonEventually(pidFile);
    observedPids.push(pids.child, pids.grandchild);
    await waitForProcessesToExit(observedPids, 1_000);

    expect(failure).toBeInstanceOf(ProcessTreeTimeoutError);
    expect(elapsedMs).toBeGreaterThanOrEqual(300);
    expect(elapsedMs).toBeLessThan(1_500);
    expect(isProcessAlive(pids.child)).toBe(false);
    expect(isProcessAlive(pids.grandchild)).toBe(false);
  });

  itOnPosix('aborts an active tree through an external signal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-perf-external-abort-'));
    roots.push(root);
    const pidFile = path.join(root, 'pids.json');
    const grandchildSource = [
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const childSource = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { detached: true, stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));`,
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const controller = new AbortController();
    const reason = new Error('synthetic external abort');
    let grandchildKilled = false;
    const run = runProcessTree({
      label: 'external abort fixture',
      command: process.execPath,
      args: ['-e', childSource],
      env: process.env,
      signal: controller.signal,
      timeoutMs: null,
      descendantMonitorIntervalMs: 25,
      terminationGraceMs: 50,
      cleanupSettleMs: 100,
    }, {
      snapshotPosixProcessTree: async (rootPid) => processTreeSnapshot(
        rootPid,
        await readJsonEventually(pidFile),
        { omitGrandchild: grandchildKilled },
      ),
      verifyPosixProcessTree: async (rootPid) => processTreeSnapshot(
        rootPid,
        await readJsonEventually(pidFile),
        { omitGrandchild: grandchildKilled },
      ),
      killPosixProcess: (pid, signal) => {
        if (signal === 'SIGKILL') {
          grandchildKilled = true;
        }
        process.kill(pid, signal);
      },
    });
    const pids = await readJsonEventually(pidFile);
    observedPids.push(pids.child, pids.grandchild);
    controller.abort(reason);

    await expect(run).rejects.toBe(reason);
    await waitForProcessesToExit([pids.child, pids.grandchild], 500);
    expect(isProcessAlive(pids.child)).toBe(false);
    expect(isProcessAlive(pids.grandchild)).toBe(false);
  });

  itOnPosix('cleans an observed detached inherited-output grandchild before reporting exit zero', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-perf-normal-exit-tree-'));
    roots.push(root);
    const pidFile = path.join(root, 'pids.json');
    const grandchildSource = [
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const childSource = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));`,
      'setTimeout(() => process.exit(0), 500);',
    ].join('\n');
    let grandchildKilled = false;

    await expect(runProcessTree({
      label: 'normal exit tree fixture',
      command: process.execPath,
      args: ['-e', childSource],
      env: process.env,
      timeoutMs: 2_000,
      descendantMonitorIntervalMs: 25,
      terminationGraceMs: 100,
      cleanupSettleMs: 150,
    }, {
      snapshotPosixProcessTree: async (rootPid) => processTreeSnapshot(
        rootPid,
        await readJsonEventually(pidFile),
        { omitGrandchild: grandchildKilled },
      ),
      killPosixProcess: (pid, signal) => {
        if (signal === 'SIGKILL') {
          grandchildKilled = true;
        }
        process.kill(pid, signal);
      },
    })).resolves.toBeDefined();

    const pids = await readJsonEventually(pidFile);
    observedPids.push(pids.child, pids.grandchild);
    await waitForProcessesToExit([pids.grandchild], 1_000);
    expect(grandchildKilled).toBe(true);
    expect(isProcessAlive(pids.grandchild)).toBe(false);
  });

  itOnPosix('does not KILL a reused descendant PID with a different start identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-perf-reused-pid-'));
    roots.push(root);
    const pidFile = path.join(root, 'pid');
    const childSource = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const fakeDescendantPid = 900_001;
    const descendantSignals = [];
    let termObserved = false;
    const snapshotPosixProcessTree = async (rootPid) => parsePosixProcessTree(rootPid, [
      `${rootPid} 1 child-start`,
      `${fakeDescendantPid} ${rootPid} ${termObserved ? 'reused-start' : 'original-start'}`,
    ].join('\n'));

    await expect(runProcessTree({
      label: 'reused PID fixture',
      command: process.execPath,
      args: ['-e', childSource],
      env: process.env,
      timeoutMs: 300,
      descendantMonitorIntervalMs: 25,
      terminationGraceMs: 50,
      cleanupSettleMs: 100,
    }, {
      snapshotPosixProcessTree,
      verifyPosixProcessTree: snapshotPosixProcessTree,
      killPosixProcess: (pid, signal) => {
        if (pid === fakeDescendantPid) {
          descendantSignals.push(signal);
          termObserved = true;
        }
      },
    })).rejects.toBeInstanceOf(ProcessTreeTimeoutError);

    const childPid = Number(await fs.readFile(pidFile, 'utf8'));
    observedPids.push(childPid);
    await waitForProcessesToExit([childPid], 500);
    expect(descendantSignals).toEqual(['SIGTERM']);
    expect(isProcessAlive(childPid)).toBe(false);
  });

  itOnPosix('rejects new descendants from a reused POSIX root', async () => {
    const childSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const newChildPid = 900_002;
    const descendantSignals = [];
    let snapshotCalls = 0;
    let newChildKilled = false;
    const snapshotPosixProcessTree = async (rootPid) => {
      snapshotCalls += 1;
      const rootStart = snapshotCalls === 1 ? 'original-root' : 'reused-root';
      return parsePosixProcessTree(rootPid, [
        `${rootPid} 1 ${rootStart}`,
        ...(snapshotCalls === 1 || newChildKilled
          ? []
          : [`${newChildPid} ${rootPid} new-child-start`]),
      ].join('\n'));
    };

    await expect(runProcessTree({
      label: 'POSIX reused root fixture',
      command: process.execPath,
      args: ['-e', childSource],
      env: process.env,
      timeoutMs: 300,
      descendantMonitorIntervalMs: 1_000,
      terminationGraceMs: 50,
      cleanupSettleMs: 100,
    }, {
      snapshotPosixProcessTree,
      verifyPosixProcessTree: snapshotPosixProcessTree,
      killPosixProcess: (pid, signal) => {
        if (pid === newChildPid) {
          descendantSignals.push(signal);
          if (signal === 'SIGKILL') {
            newChildKilled = true;
          }
        }
      },
    })).rejects.toBeInstanceOf(ProcessTreeTimeoutError);

    expect(snapshotCalls).toBeGreaterThanOrEqual(3);
    expect(descendantSignals).toEqual([]);
  });

  itOnPosix('does not force KILL a process group after the root identity changes', async () => {
    const controller = new AbortController();
    const forceController = new AbortController();
    const abortReason = new Error('interrupt fixture');
    const groupSignals = [];
    let snapshotCalls = 0;
    const snapshotPosixProcessTree = async (rootPid) => {
      snapshotCalls += 1;
      return parsePosixProcessTree(
        rootPid,
        `${rootPid} 1 ${snapshotCalls === 1 ? 'original-root' : 'reused-root'}`,
      );
    };
    const running = runProcessTree({
      label: 'reused POSIX group fixture',
      command: process.execPath,
      args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      env: process.env,
      signal: controller.signal,
      forceSignal: forceController.signal,
      timeoutMs: null,
      descendantMonitorIntervalMs: 1_000,
      terminationGraceMs: 10_000,
      cleanupSettleMs: 100,
    }, {
      snapshotPosixProcessTree,
      verifyPosixProcessTree: snapshotPosixProcessTree,
      killPosixProcessGroup: (_pid, signal) => groupSignals.push(signal),
    });
    while (snapshotCalls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    controller.abort(abortReason);
    forceController.abort(new Error('repeat interrupt fixture'));
    await expect(running).rejects.toBe(abortReason);

    expect(groupSignals).toEqual([]);
  });

  itOnPosix('discovers root and detached grandchild on the third snapshot', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-perf-third-snapshot-root-'));
    roots.push(root);
    const pidFile = path.join(root, 'pids.json');
    const grandchildSource = [
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const childSource = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { detached: true, stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));`,
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    let snapshotCalls = 0;
    let grandchildKilled = false;
    const snapshotPosixProcessTree = async (rootPid) => {
      snapshotCalls += 1;
      if (snapshotCalls < 3) {
        throw new Error(`synthetic snapshot failure ${snapshotCalls}`);
      }
      return processTreeSnapshot(rootPid, await readJsonEventually(pidFile));
    };

    await expect(runProcessTree({
      label: 'third snapshot root fixture',
      command: process.execPath,
      args: ['-e', childSource],
      env: process.env,
      timeoutMs: 300,
      descendantSnapshotTimeoutMs: 50,
      descendantMonitorIntervalMs: 1_000,
      terminationGraceMs: 50,
      cleanupSettleMs: 100,
    }, {
      snapshotPosixProcessTree,
      verifyPosixProcessTree: async (rootPid) => processTreeSnapshot(
        rootPid,
        await readJsonEventually(pidFile),
        { omitGrandchild: grandchildKilled },
      ),
      killPosixProcess: (pid, signal) => {
        if (signal === 'SIGKILL') {
          grandchildKilled = true;
        }
        process.kill(pid, signal);
      },
    })).rejects.toBeInstanceOf(ProcessTreeTimeoutError);

    const pids = await readJsonEventually(pidFile);
    observedPids.push(pids.child, pids.grandchild);
    await waitForProcessesToExit([pids.child, pids.grandchild], 500);
    expect(snapshotCalls).toBe(3);
    expect(isProcessAlive(pids.child)).toBe(false);
    expect(isProcessAlive(pids.grandchild)).toBe(false);
  });

  itOnPosix('falls back to the owned process group when snapshots lack root identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-perf-missing-root-identity-'));
    roots.push(root);
    const pidFile = path.join(root, 'pid');
    const childSource = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    let snapshotCalls = 0;
    const groupSignals = [];
    const snapshotPosixProcessTree = async (rootPid) => {
      snapshotCalls += 1;
      if (snapshotCalls < 3) {
        throw new Error(`synthetic snapshot failure ${snapshotCalls}`);
      }
      return parsePosixProcessTree(rootPid, '999999 1 unrelated-start');
    };

    await expect(runProcessTree({
      label: 'missing root identity fixture',
      command: process.execPath,
      args: ['-e', childSource],
      env: process.env,
      timeoutMs: 300,
      descendantSnapshotTimeoutMs: 50,
      descendantMonitorIntervalMs: 1_000,
      terminationGraceMs: 50,
      cleanupSettleMs: 100,
    }, {
      snapshotPosixProcessTree,
      killPosixProcessGroup: (pid, signal) => {
        groupSignals.push(signal);
        process.kill(-pid, signal);
      },
    })).rejects.toThrow(
      'cleanup could not verify process-tree ownership',
    );

    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    observedPids.push(pid);
    await waitForProcessesToExit([pid], 500);
    expect(snapshotCalls).toBe(3);
    expect(groupSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(isProcessAlive(pid)).toBe(false);
  });

  itOnPosix('parses recursive identities in leaf-to-root order', () => {
    const snapshot = parsePosixProcessTree(10, [
      '10 1 root-start',
      '20 10 child-start',
      '30 20 leaf-start',
      '40 10 sibling-start',
      '50 999 unrelated-start',
    ].join('\n'));
    expect(snapshot.rootIdentity).toMatchObject({ pid: 10, startIdentity: 'root-start' });
    expect(snapshot.descendants.map((identity) => identity.pid)).toEqual([30, 40, 20]);
  });

  itOnPosix('bounds ps pending and throw fallback without leaving the direct child', async () => {
    const providers = [
      async () => await new Promise(() => {}),
      () => {
        throw new Error('synthetic ps failure');
      },
    ];

    for (const [index, snapshotPosixProcessTree] of providers.entries()) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `aw-perf-ps-fallback-${index}-`));
      roots.push(root);
      const pidFile = path.join(root, 'pid');
      const childSource = [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        "process.on('SIGTERM', () => {});",
        'setInterval(() => {}, 1000);',
      ].join('\n');
      const startedAt = performance.now();
      let failure;
      try {
        await runProcessTree({
          label: `ps fallback fixture ${index}`,
          command: process.execPath,
          args: ['-e', childSource],
          env: process.env,
          timeoutMs: 300,
          descendantSnapshotTimeoutMs: 50,
          descendantMonitorIntervalMs: 25,
          terminationGraceMs: 50,
          cleanupSettleMs: 100,
        }, { snapshotPosixProcessTree });
      } catch (error) {
        failure = error;
      }
      const elapsedMs = performance.now() - startedAt;
      const pid = Number(await fs.readFile(pidFile, 'utf8'));
      observedPids.push(pid);
      await waitForProcessesToExit([pid], 500);

      expect(failure).toMatchObject({
        message: expect.stringContaining('cleanup could not verify process-tree ownership'),
      });
      expect(elapsedMs).toBeLessThan(1_000);
      expect(isProcessAlive(pid)).toBe(false);
    }
  });

  it('uses bounded injected Windows taskkill /T and /F contracts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-perf-windows-taskkill-'));
    roots.push(root);
    const pidFile = path.join(root, 'pid');
    const childSource = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const invocations = [];
    let rootKilled = false;

    await expect(runProcessTree({
      label: 'Windows taskkill fixture',
      command: process.execPath,
      args: ['-e', childSource],
      env: process.env,
      timeoutMs: 300,
      terminationGraceMs: 50,
      cleanupSettleMs: 100,
      taskkillTimeoutMs: 50,
    }, {
      platform: 'win32',
      snapshotWindowsProcessTree: async (rootPid) => parseWindowsProcessTree(rootPid,
        rootKilled ? [] : {
          ProcessId: rootPid,
          ParentProcessId: 1,
          CreationDate: 'root-created',
        }),
      taskkillProcessTree: async (invocation) => {
        invocations.push(invocation);
        if (invocation.force) {
          rootKilled = true;
          process.kill(invocation.pid, 'SIGKILL');
        }
        return true;
      },
    })).rejects.toBeInstanceOf(ProcessTreeTimeoutError);

    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    observedPids.push(pid);
    await waitForProcessesToExit([pid], 500);
    expect(invocations.map((invocation) => invocation.args)).toEqual([
      ['/PID', String(pid), '/T'],
      ['/PID', String(pid), '/T', '/F'],
    ]);
    expect(isProcessAlive(pid)).toBe(false);
  });

  it('fails Windows external abort when the original identity remains after taskkill success', async () => {
    const controller = new AbortController();
    const reason = new Error('synthetic Windows abort');
    const childSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const taskkillInvocations = [];
    const run = runProcessTree({
      label: 'Windows abort verification fixture',
      command: process.execPath,
      args: ['-e', childSource],
      env: process.env,
      signal: controller.signal,
      timeoutMs: null,
      terminationGraceMs: 25,
      cleanupSettleMs: 25,
      taskkillTimeoutMs: 50,
    }, {
      platform: 'win32',
      snapshotWindowsProcessTree: async (rootPid) => parseWindowsProcessTree(rootPid, {
        ProcessId: rootPid,
        ParentProcessId: 1,
        CreationDate: 'original-root',
      }),
      taskkillProcessTree: async (invocation) => {
        taskkillInvocations.push(invocation);
        return true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort(reason);

    await expect(run).rejects.toThrow(
      'cleanup could not confirm Windows process-tree termination',
    );
    observedPids.push(taskkillInvocations[0].pid);
    expect(taskkillInvocations.map((invocation) => invocation.force)).toEqual([false, true]);
  });

  it.each([
    ['disappears', null],
    ['changes identity', 'reused-root'],
  ])('accepts Windows external abort when the original identity %s', async (_label, finalIdentity) => {
    const controller = new AbortController();
    const reason = new Error('synthetic Windows abort');
    let cleanupCompleted = false;
    const run = runProcessTree({
      label: 'Windows abort completed fixture',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000);'],
      env: process.env,
      signal: controller.signal,
      timeoutMs: null,
      terminationGraceMs: 25,
      cleanupSettleMs: 25,
      taskkillTimeoutMs: 50,
    }, {
      platform: 'win32',
      snapshotWindowsProcessTree: async (rootPid) => parseWindowsProcessTree(rootPid,
        cleanupCompleted && finalIdentity === null ? [] : {
          ProcessId: rootPid,
          ParentProcessId: 1,
          CreationDate: cleanupCompleted ? finalIdentity : 'original-root',
        }),
      taskkillProcessTree: async (invocation) => {
        if (invocation.force) {
          cleanupCompleted = true;
          process.kill(invocation.pid, 'SIGKILL');
        }
        return true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort(reason);

    await expect(run).rejects.toBe(reason);
  });

  it('does not adopt a first Windows snapshot that arrives after child exit', async () => {
    const childSource = 'process.exit(0);';
    const newChildPid = 900_100;
    const taskkillInvocations = [];
    let snapshotCalls = 0;

    await expect(runProcessTree({
      label: 'Windows reused root fixture',
      command: process.execPath,
      args: ['-e', childSource],
      env: process.env,
      timeoutMs: 20,
      descendantSnapshotTimeoutMs: 500,
      descendantMonitorIntervalMs: 1_000,
      terminationGraceMs: 50,
      cleanupSettleMs: 100,
      taskkillTimeoutMs: 50,
    }, {
      platform: 'win32',
      snapshotWindowsProcessTree: async (rootPid) => {
        snapshotCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return parseWindowsProcessTree(rootPid, [
          { ProcessId: rootPid, ParentProcessId: 1, CreationDate: 'reused-created' },
          {
            ProcessId: newChildPid,
            ParentProcessId: rootPid,
            CreationDate: 'new-child-created',
          },
        ]);
      },
      taskkillProcessTree: async (invocation) => {
        taskkillInvocations.push(invocation);
        return true;
      },
    })).rejects.toBeInstanceOf(ProcessTreeTimeoutError);

    expect(snapshotCalls).toBeGreaterThanOrEqual(3);
    expect(taskkillInvocations).toEqual([]);
  });

  it('rejects new children from a reused Windows root while cleaning an old observed child', async () => {
    const oldChildPid = 900_101;
    const newChildPid = 900_102;
    const taskkillInvocations = [];
    let snapshotCalls = 0;
    let oldChildKilled = false;
    const childSource = 'setTimeout(() => process.exit(0), 125);';

    await expect(runProcessTree({
      label: 'Windows reused root children fixture',
      command: process.execPath,
      args: ['-e', childSource],
      env: process.env,
      timeoutMs: 100,
      descendantMonitorIntervalMs: 1_000,
      terminationGraceMs: 50,
      cleanupSettleMs: 100,
      taskkillTimeoutMs: 50,
    }, {
      platform: 'win32',
      snapshotWindowsProcessTree: async (rootPid) => {
        snapshotCalls += 1;
        const rootCreationDate = snapshotCalls === 1 ? 'original-root' : 'reused-root';
        return parseWindowsProcessTree(rootPid, [
          { ProcessId: rootPid, ParentProcessId: 1, CreationDate: rootCreationDate },
          ...(!oldChildKilled ? [{
            ProcessId: oldChildPid,
            ParentProcessId: rootPid,
            CreationDate: 'old-child-created',
          }] : []),
          ...(snapshotCalls === 1 ? [] : [{
            ProcessId: newChildPid,
            ParentProcessId: rootPid,
            CreationDate: 'new-child-created',
          }]),
        ]);
      },
      taskkillProcessTree: async (invocation) => {
        taskkillInvocations.push(invocation);
        if (invocation.pid === oldChildPid && invocation.force) {
          oldChildKilled = true;
        }
        return true;
      },
    })).rejects.toBeInstanceOf(ProcessTreeTimeoutError);

    expect(taskkillInvocations.map((invocation) => ({
      pid: invocation.pid,
      force: invocation.force,
    }))).toEqual([
      { pid: oldChildPid, force: false },
      { pid: oldChildPid, force: true },
    ]);
    expect(taskkillInvocations.some((invocation) => invocation.pid === newChildPid)).toBe(false);
  });

  it('cleans an observed Windows detached child after root exit zero', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-perf-windows-normal-exit-'));
    roots.push(root);
    const pidFile = path.join(root, 'pids.json');
    const grandchildSource = 'setInterval(() => {}, 1000);';
    const childSource = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { detached: true, stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));`,
      'setTimeout(() => process.exit(0), 500);',
    ].join('\n');
    const taskkillInvocations = [];
    let grandchildKilled = false;

    await expect(runProcessTree({
      label: 'Windows normal exit fixture',
      command: process.execPath,
      args: ['-e', childSource],
      env: process.env,
      timeoutMs: 2_000,
      descendantMonitorIntervalMs: 25,
      terminationGraceMs: 50,
      cleanupSettleMs: 100,
      taskkillTimeoutMs: 50,
    }, {
      platform: 'win32',
      snapshotWindowsProcessTree: async (rootPid) => {
        const pids = await readJsonEventually(pidFile);
        return parseWindowsProcessTree(rootPid, [
          { ProcessId: pids.child, ParentProcessId: 1, CreationDate: 'child-created' },
          ...(!grandchildKilled ? [{
            ProcessId: pids.grandchild,
            ParentProcessId: pids.child,
            CreationDate: 'grandchild-created',
          }] : []),
        ]);
      },
      taskkillProcessTree: async (invocation) => {
        taskkillInvocations.push(invocation);
        if (invocation.force) {
          grandchildKilled = true;
          process.kill(invocation.pid, 'SIGKILL');
        }
        return true;
      },
    })).resolves.toBeDefined();

    const pids = await readJsonEventually(pidFile);
    observedPids.push(pids.child, pids.grandchild);
    await waitForProcessesToExit([pids.grandchild], 500);
    expect(taskkillInvocations.map((invocation) => invocation.args)).toEqual([
      ['/PID', String(pids.grandchild), '/T'],
      ['/PID', String(pids.grandchild), '/T', '/F'],
    ]);
    expect(isProcessAlive(pids.grandchild)).toBe(false);
  });

  it('bounds injected Windows taskkill pending and error fallback', async () => {
    const providers = [
      async () => await new Promise(() => {}),
      () => {
        throw new Error('synthetic taskkill failure');
      },
    ];
    for (const [index, taskkillProcessTree] of providers.entries()) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `aw-perf-taskkill-fallback-${index}-`));
      roots.push(root);
      const pidFile = path.join(root, 'pid');
      const childSource = [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        "process.on('SIGTERM', () => {});",
        'setInterval(() => {}, 1000);',
      ].join('\n');
      const startedAt = performance.now();
      await expect(runProcessTree({
        label: `Windows fallback fixture ${index}`,
        command: process.execPath,
        args: ['-e', childSource],
        env: process.env,
        timeoutMs: 300,
        terminationGraceMs: 50,
        cleanupSettleMs: 100,
        taskkillTimeoutMs: 50,
      }, {
        platform: 'win32',
        snapshotWindowsProcessTree: async (rootPid) => parseWindowsProcessTree(rootPid,
          isProcessAlive(rootPid) ? {
            ProcessId: rootPid,
            ParentProcessId: 1,
            CreationDate: 'root-created',
          } : []),
        taskkillProcessTree,
      })).rejects.toBeInstanceOf(ProcessTreeTimeoutError);
      const elapsedMs = performance.now() - startedAt;
      const pid = Number(await fs.readFile(pidFile, 'utf8'));
      observedPids.push(pid);
      await waitForProcessesToExit([pid], 500);

      expect(elapsedMs).toBeLessThan(1_000);
      expect(isProcessAlive(pid)).toBe(false);
    }
  });
});
