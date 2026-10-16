import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createWindowsJobInvocation,
  ProcessTreeTimeoutError,
  parsePosixProcessTree,
  parseWindowsProcessTree,
  resolveWindowsJobHelperPath,
  runProcessTree,
  snapshotWindowsProcessTree,
} from '../../../../scripts/perf/process-tree.mjs';

const roots = [];
const observedPids = [];
const itOnPosix = process.platform === 'win32' ? it.skip : it;
const syntheticWatchdogSource = 'setTimeout(() => process.exit(124), 30_000);';

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
      syntheticWatchdogSource,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const childSource = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { detached: true, stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));`,
      "process.on('SIGTERM', () => {});",
      syntheticWatchdogSource,
      'setInterval(() => {}, 1000);',
    ].join('\n');

    const startedAt = performance.now();
    const metrics = {};
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
        metrics,
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
    expect(metrics).toMatchObject({
      managedSpawnCount: 1,
      peakLiveDescendants: 1,
      cleanupFailureCount: 0,
      leakedProcessCount: 0,
    });
    expect(metrics.processTableScanCount).toBeLessThanOrEqual(3);
  });

  itOnPosix('aborts an active tree through an external signal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-perf-external-abort-'));
    roots.push(root);
    const pidFile = path.join(root, 'pids.json');
    const grandchildSource = [
      "process.on('SIGTERM', () => {});",
      syntheticWatchdogSource,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const childSource = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { detached: true, stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));`,
      "process.on('SIGTERM', () => {});",
      syntheticWatchdogSource,
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
      syntheticWatchdogSource,
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
      syntheticWatchdogSource,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const fakeDescendantPid = 900_001;
    const descendantSignals = [];
    let termObserved = false;
    const auditPosixProcessTree = async (rootPid) => {
      const rootIdentity = { pid: rootPid, parentPid: 1, startIdentity: 'child-start' };
      const descendant = {
        pid: fakeDescendantPid,
        parentPid: rootPid,
        startIdentity: termObserved ? 'reused-start' : 'original-start',
      };
      return {
        rootIdentity,
        descendants: [],
        identitiesByPid: new Map([
          [rootPid, rootIdentity],
          [fakeDescendantPid, descendant],
        ]),
        owned: termObserved ? [] : [descendant],
      };
    };

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
      auditPosixProcessTree,
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
    const childSource = `${syntheticWatchdogSource} process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
    const newChildPid = 900_002;
    const descendantSignals = [];
    let snapshotCalls = 0;
    let newChildKilled = false;
    const auditPosixProcessTree = async (rootPid) => {
      snapshotCalls += 1;
      const rootStart = snapshotCalls === 1 ? 'original-root' : 'reused-root';
      const rootIdentity = { pid: rootPid, parentPid: 1, startIdentity: rootStart };
      const newChild = { pid: newChildPid, parentPid: rootPid, startIdentity: 'new-child-start' };
      return {
        rootIdentity,
        descendants: [],
        identitiesByPid: new Map([
          [rootPid, rootIdentity],
          ...(snapshotCalls === 1 || newChildKilled ? [] : [[newChildPid, newChild]]),
        ]),
        owned: snapshotCalls === 1 ? [rootIdentity] : [],
      };
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
      auditPosixProcessTree,
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

  itOnPosix('does not force KILL a process group after the audited root identity changes', async () => {
    const controller = new AbortController();
    const forceController = new AbortController();
    const abortReason = new Error('interrupt fixture');
    const groupSignals = [];
    let snapshotCalls = 0;
    const auditPosixProcessTree = async (rootPid) => {
      snapshotCalls += 1;
      const rootIdentity = {
        pid: rootPid,
        parentPid: 1,
        processGroupId: rootPid,
        startIdentity: snapshotCalls === 1 ? 'original-root' : 'reused-root',
      };
      return {
        rootIdentity,
        descendants: [],
        identitiesByPid: new Map([[rootPid, rootIdentity]]),
        owned: snapshotCalls === 1 ? [rootIdentity] : [],
      };
    };
    const running = runProcessTree({
      label: 'reused POSIX group fixture',
      command: process.execPath,
      args: ['-e', `${syntheticWatchdogSource} process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`],
      env: process.env,
      signal: controller.signal,
      forceSignal: forceController.signal,
      timeoutMs: null,
      descendantMonitorIntervalMs: 1_000,
      terminationGraceMs: 10_000,
      cleanupSettleMs: 100,
    }, {
      auditPosixProcessTree,
      killPosixProcessGroup: (_pid, signal) => groupSignals.push(signal),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    controller.abort(abortReason);
    forceController.abort(new Error('repeat interrupt fixture'));
    await expect(running).rejects.toBe(abortReason);

    expect(groupSignals).toEqual(['SIGTERM']);
  });

  itOnPosix('reports a final audit failure after killing the direct root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-perf-third-snapshot-root-'));
    roots.push(root);
    const pidFile = path.join(root, 'pids.json');
    const grandchildSource = [
      "process.on('SIGTERM', () => {});",
      syntheticWatchdogSource,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const childSource = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { detached: true, stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));`,
      "process.on('SIGTERM', () => {});",
      syntheticWatchdogSource,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    let snapshotCalls = 0;
    const snapshotPosixProcessTree = async (rootPid) => {
      snapshotCalls += 1;
      throw new Error(`synthetic snapshot failure ${snapshotCalls}`);
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
    })).rejects.toThrow('cleanup could not verify process-tree ownership');

    const pids = await readJsonEventually(pidFile);
    observedPids.push(pids.child, pids.grandchild);
    await waitForProcessesToExit([pids.child], 500);
    expect(snapshotCalls).toBe(1);
    expect(isProcessAlive(pids.child)).toBe(false);
    expect(isProcessAlive(pids.grandchild)).toBe(true);
  });

  itOnPosix('falls back to the owned process group when snapshots lack root identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-perf-missing-root-identity-'));
    roots.push(root);
    const pidFile = path.join(root, 'pid');
    const childSource = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "process.on('SIGTERM', () => {});",
      syntheticWatchdogSource,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    let snapshotCalls = 0;
    const groupSignals = [];
    const metrics = {};
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
      metrics,
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
    expect(snapshotCalls).toBe(1);
    expect(groupSignals).toEqual(['SIGTERM']);
    expect(isProcessAlive(pid)).toBe(false);
    expect(metrics).toMatchObject({
      managedSpawnCount: 1,
      cleanupFailureCount: 1,
      leakedProcessCount: null,
    });
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

  it('validates every Windows PPID edge by creation order', () => {
    const snapshot = parseWindowsProcessTree(10, [
      { ProcessId: 10, ParentProcessId: 1, CreationDateTicks: '638000000000002000' },
      { ProcessId: 20, ParentProcessId: 10, CreationDateTicks: '638000000000003000' },
      { ProcessId: 30, ParentProcessId: 20, CreationDateTicks: '638000000000002500' },
      { ProcessId: 40, ParentProcessId: 30, CreationDateTicks: '638000000000004000' },
    ]);

    expect(snapshot.descendants.map((identity) => identity.pid)).toEqual([20]);
    expect(snapshot.unconfirmedDescendants.map((identity) => identity.pid)).toEqual([40, 30]);
  });

  itOnPosix('projects PowerShell CreationDate to exact UTC ticks before parsing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-windows-snapshot-contract-'));
    roots.push(root);
    const executable = path.join(root, 'powershell.exe');
    const argsFile = path.join(root, 'args.json');
    await fs.writeFile(executable, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.POWERSHELL_ARGS_FILE, JSON.stringify(process.argv.slice(2)));",
      'process.stdout.write(JSON.stringify([',
      "  { ProcessId: 10, ParentProcessId: 1, CreationDateTicks: '638000000000001001' },",
      "  { ProcessId: 20, ParentProcessId: 10, CreationDateTicks: '638000000000001002' },",
      ']));',
    ].join('\n'));
    await fs.chmod(executable, 0o755);
    const originalPath = process.env.PATH;
    const originalArgsFile = process.env.POWERSHELL_ARGS_FILE;
    process.env.PATH = `${root}${path.delimiter}${originalPath}`;
    process.env.POWERSHELL_ARGS_FILE = argsFile;
    let snapshot;
    try {
      snapshot = await snapshotWindowsProcessTree(10, new AbortController().signal);
    } finally {
      process.env.PATH = originalPath;
      if (originalArgsFile === undefined) delete process.env.POWERSHELL_ARGS_FILE;
      else process.env.POWERSHELL_ARGS_FILE = originalArgsFile;
    }
    const args = JSON.parse(await fs.readFile(argsFile, 'utf8'));
    const command = args[args.indexOf('-Command') + 1];

    expect(command).toContain("($_.CreationDate.ToUniversalTime().Ticks).ToString()");
    expect(snapshot.rootIdentity.startIdentity).toBe('638000000000001001');
    expect(snapshot.descendants.map((identity) => identity.pid)).toEqual([20]);
  });

  itOnPosix('resolves source and platform-package Windows Job helpers and launches the fixed protocol', async () => {
    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-windows-job-path-'));
    roots.push(packageRoot);
    const sourceHelper = path.join(
      packageRoot,
      'native/windows/x64/aw-windows-job.exe',
    );
    const platformHelper = path.join(
      packageRoot,
      'platform-package/aw-windows-job.exe',
    );
    const configFile = path.join(packageRoot, 'config.json');
    await fs.mkdir(path.dirname(sourceHelper), { recursive: true });
    await fs.writeFile(sourceHelper, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const encoded = process.argv[process.argv.indexOf('--config') + 1];",
      "fs.writeFileSync(process.env.WINDOWS_JOB_CONFIG_FILE, Buffer.from(encoded, 'base64url'));",
      "process.stdout.write('helper stdout');",
    ].join('\n'));
    await fs.chmod(sourceHelper, 0o755);

    expect(resolveWindowsJobHelperPath({ packageRoot, arch: 'x64' })).toBe(sourceHelper);
    const invocation = createWindowsJobInvocation('target.exe', ['two words'], {
      helperPath: sourceHelper,
      parentPid: 42,
    });
    expect(invocation.args).toEqual([
      '--config',
      expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
    ]);
    expect(JSON.parse(Buffer.from(invocation.args[1], 'base64url').toString('utf8'))).toEqual({
      schemaVersion: 1,
      executable: 'target.exe',
      args: ['two words'],
      parentPid: 42,
    });
    const metrics = {};
    const result = await runProcessTree({
      label: 'Windows Job protocol fixture',
      command: 'target.exe',
      args: ['two words', 'quote"value'],
      env: { ...process.env, WINDOWS_JOB_CONFIG_FILE: configFile },
      timeoutMs: 1_000,
      metrics,
    }, {
      platform: 'win32',
      arch: 'x64',
      windowsJobPackageRoot: packageRoot,
    });
    const config = JSON.parse(await fs.readFile(configFile, 'utf8'));

    expect(result).toMatchObject({ exitCode: 0, stdout: 'helper stdout' });
    expect(config).toEqual({
      schemaVersion: 1,
      executable: 'target.exe',
      args: ['two words', 'quote"value'],
      parentPid: process.pid,
    });
    expect(metrics).toMatchObject({
      managedSpawnCount: 1,
      processTableScanCount: 0,
      peakLiveDescendants: null,
      cleanupFailureCount: 0,
      leakedProcessCount: 0,
    });

    await fs.mkdir(path.dirname(platformHelper), { recursive: true });
    await fs.writeFile(platformHelper, 'platform helper');
    expect(resolveWindowsJobHelperPath({
      packageRoot,
      arch: 'x64',
      resolvePackage: (specifier) => {
        expect(specifier).toBe(
          '@lesliechan721/aw-windows-job-win32-x64/aw-windows-job.exe',
        );
        return platformHelper;
      },
    })).toBe(platformHelper);
  });

  it('fails closed for unsupported, missing, and shell-script Windows Job targets', async () => {
    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-windows-job-missing-'));
    roots.push(packageRoot);

    expect(() => resolveWindowsJobHelperPath({ packageRoot, arch: 'ia32' }))
      .toThrow('unsupported on architecture ia32');
    expect(() => resolveWindowsJobHelperPath({ packageRoot, arch: 'x64' }))
      .toThrow('helper is missing for architecture x64');
    expect(() => createWindowsJobInvocation('target.cmd', [], {
      helperPath: 'aw-windows-job.exe',
    })).toThrow('.cmd and .bat targets are unsupported');
    await expect(runProcessTree({
      label: 'missing Windows Job helper fixture',
      command: 'target.exe',
      args: [],
      env: process.env,
      timeoutMs: 1_000,
    }, {
      platform: 'win32',
      arch: 'x64',
      windowsJobPackageRoot: packageRoot,
    })).rejects.toThrow('helper is missing for architecture x64');
    await expect(runProcessTree({
      label: 'Windows Job startup failure fixture',
      command: 'target.exe',
      args: [],
      env: process.env,
      timeoutMs: 1_000,
    }, {
      platform: 'win32',
      createWindowsJobInvocation: () => ({
        command: path.join(packageRoot, 'does-not-exist.exe'),
        args: ['--config', 'invalid'],
      }),
    })).rejects.toThrow('Windows Job helper failed');
  });

  it.each(['timeout', 'abort'])('closes the Windows Job helper on %s', async (reason) => {
    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), `aw-windows-job-${reason}-`));
    roots.push(packageRoot);
    const helperPath = path.join(packageRoot, 'native/windows/x64/aw-windows-job.exe');
    const pidFile = path.join(packageRoot, 'helper.pid');
    await fs.mkdir(path.dirname(helperPath), { recursive: true });
    await fs.writeFile(helperPath, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.WINDOWS_JOB_PID_FILE, String(process.pid));",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    await fs.chmod(helperPath, 0o755);
    const controller = new AbortController();
    const abortReason = new Error('synthetic Windows Job abort');
    const run = runProcessTree({
      label: `Windows Job ${reason} fixture`,
      command: 'target.exe',
      args: [],
      env: { ...process.env, WINDOWS_JOB_PID_FILE: pidFile },
      signal: controller.signal,
      timeoutMs: reason === 'timeout' ? 100 : null,
    }, {
      platform: 'win32',
      arch: 'x64',
      windowsJobPackageRoot: packageRoot,
    });
    const helperPid = await readJsonEventually(pidFile);
    observedPids.push(helperPid);
    if (reason === 'abort') controller.abort(abortReason);

    if (reason === 'timeout') await expect(run).rejects.toBeInstanceOf(ProcessTreeTimeoutError);
    else await expect(run).rejects.toBe(abortReason);
    await waitForProcessesToExit([helperPid], 500);
    expect(isProcessAlive(helperPid)).toBe(false);
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
        syntheticWatchdogSource,
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
      syntheticWatchdogSource,
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
          CreationDateTicks: '100',
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
    const childSource = `${syntheticWatchdogSource} process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
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
        CreationDateTicks: '100',
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
    ['changes identity', '200'],
  ])('accepts Windows external abort when the original identity %s', async (_label, finalIdentity) => {
    const controller = new AbortController();
    const reason = new Error('synthetic Windows abort');
    let cleanupCompleted = false;
    const run = runProcessTree({
      label: 'Windows abort completed fixture',
      command: process.execPath,
      args: ['-e', `${syntheticWatchdogSource} setInterval(() => {}, 1000);`],
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
          CreationDateTicks: cleanupCompleted ? finalIdentity : '100',
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
    const metrics = {};

    await expect(runProcessTree({
      label: 'Windows reused root fixture',
      command: process.execPath,
      args: ['-e', childSource],
      env: process.env,
      timeoutMs: null,
      descendantSnapshotTimeoutMs: 10_000,
      metrics,
      descendantMonitorIntervalMs: 1_000,
      terminationGraceMs: 50,
      cleanupSettleMs: 100,
      taskkillTimeoutMs: 50,
    }, {
      platform: 'win32',
      snapshotWindowsProcessTree: async (rootPid) => {
        snapshotCalls += 1;
        await waitForProcessesToExit([rootPid], 5_000);
        expect(isProcessAlive(rootPid)).toBe(false);
        return parseWindowsProcessTree(rootPid, [
          { ProcessId: rootPid, ParentProcessId: 1, CreationDateTicks: '200' },
          {
            ProcessId: newChildPid,
            ParentProcessId: rootPid,
            CreationDateTicks: '300',
          },
        ]);
      },
      taskkillProcessTree: async (invocation) => {
        taskkillInvocations.push(invocation);
        return true;
      },
    })).rejects.toThrow('exited, but Windows process-tree cleanup is unconfirmed.');

    expect(snapshotCalls).toBeGreaterThanOrEqual(1);
    expect(metrics.peakLiveDescendants).toBe(0);
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
        const rootCreationDate = snapshotCalls === 1 ? '100' : '300';
        return parseWindowsProcessTree(rootPid, [
          { ProcessId: rootPid, ParentProcessId: 1, CreationDateTicks: rootCreationDate },
          ...(!oldChildKilled ? [{
            ProcessId: oldChildPid,
            ParentProcessId: rootPid,
            CreationDateTicks: '200',
          }] : []),
          ...(snapshotCalls === 1 ? [] : [{
            ProcessId: newChildPid,
            ParentProcessId: rootPid,
            CreationDateTicks: '400',
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
    })).rejects.toThrow('cleanup could not confirm Windows process-tree termination');

    expect(taskkillInvocations.map((invocation) => ({
      pid: invocation.pid,
      force: invocation.force,
    }))).toEqual([
      { pid: oldChildPid, force: false },
      { pid: oldChildPid, force: true },
    ]);
    expect(taskkillInvocations.some((invocation) => invocation.pid === newChildPid)).toBe(false);
  });

  it('fails a normal Windows exit when every process snapshot fails', async () => {
    const taskkillInvocations = [];
    const metrics = {};

    await expect(runProcessTree({
      label: 'Windows normal exit snapshot failure fixture',
      command: process.execPath,
      args: ['-e', 'process.exit(0);'],
      env: process.env,
      timeoutMs: 1_000,
      descendantSnapshotTimeoutMs: 25,
      descendantMonitorIntervalMs: 1_000,
      terminationGraceMs: 25,
      cleanupSettleMs: 25,
      taskkillTimeoutMs: 25,
      metrics,
    }, {
      platform: 'win32',
      snapshotWindowsProcessTree: async () => {
        throw new Error('synthetic Windows snapshot failure');
      },
      taskkillProcessTree: async (invocation) => {
        taskkillInvocations.push(invocation);
        return true;
      },
    })).rejects.toThrow('Windows descendant cleanup could not be verified');

    expect(taskkillInvocations).toEqual([]);
    expect(metrics).toMatchObject({
      cleanupFailureCount: 1,
      leakedProcessCount: null,
    });
  });

  it('fails a normal Windows exit when the root identity still appears alive', async () => {
    const taskkillInvocations = [];

    await expect(runProcessTree({
      label: 'Windows live root after exit fixture',
      command: process.execPath,
      args: ['-e', 'process.exit(0);'],
      env: process.env,
      timeoutMs: 1_000,
      descendantMonitorIntervalMs: 1_000,
      terminationGraceMs: 25,
      cleanupSettleMs: 25,
      taskkillTimeoutMs: 25,
    }, {
      platform: 'win32',
      snapshotWindowsProcessTree: async (rootPid) => parseWindowsProcessTree(rootPid, {
        ProcessId: rootPid,
        ParentProcessId: 1,
        CreationDateTicks: '100',
      }),
      taskkillProcessTree: async (invocation) => {
        taskkillInvocations.push(invocation);
        return true;
      },
    })).rejects.toThrow('Windows process-tree cleanup is unconfirmed');

    expect(taskkillInvocations).toEqual([]);
  });

  it('fails a normal Windows exit without killing an unverified late child candidate', async () => {
    const candidatePid = 900_103;
    const taskkillInvocations = [];
    let snapshotCalls = 0;

    await expect(runProcessTree({
      label: 'Windows late child candidate fixture',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 100);'],
      env: process.env,
      timeoutMs: 1_000,
      descendantMonitorIntervalMs: 1_000,
      terminationGraceMs: 25,
      cleanupSettleMs: 25,
      taskkillTimeoutMs: 25,
    }, {
      platform: 'win32',
      snapshotWindowsProcessTree: async (rootPid) => {
        snapshotCalls += 1;
        return parseWindowsProcessTree(rootPid, snapshotCalls === 1
          ? { ProcessId: rootPid, ParentProcessId: 1, CreationDateTicks: '100' }
          : {
              ProcessId: candidatePid,
              ParentProcessId: rootPid,
              CreationDateTicks: '200',
            });
      },
      taskkillProcessTree: async (invocation) => {
        taskkillInvocations.push(invocation);
        return true;
      },
    })).rejects.toThrow('Windows process-tree cleanup is unconfirmed');

    expect(snapshotCalls).toBeGreaterThanOrEqual(2);
    expect(taskkillInvocations).toEqual([]);
  });

  it('does not kill a same-millisecond Windows PPID candidate that started before its parent', async () => {
    const candidatePid = 777;
    const taskkillInvocations = [];
    let rootKilled = false;
    const childSource = `${syntheticWatchdogSource} process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;

    await expect(runProcessTree({
      label: 'Windows reused PPID edge fixture',
      command: process.execPath,
      args: ['-e', childSource],
      env: process.env,
      timeoutMs: 300,
      descendantMonitorIntervalMs: 25,
      terminationGraceMs: 25,
      cleanupSettleMs: 25,
      taskkillTimeoutMs: 25,
    }, {
      platform: 'win32',
      snapshotWindowsProcessTree: async (rootPid) => parseWindowsProcessTree(rootPid, [
        ...(!rootKilled ? [{
          ProcessId: rootPid,
          ParentProcessId: 1,
          CreationDateTicks: '638000000000002000',
        }] : []),
        {
          ProcessId: candidatePid,
          ParentProcessId: rootPid,
          CreationDateTicks: '638000000000001000',
        },
      ]),
      taskkillProcessTree: async (invocation) => {
        taskkillInvocations.push(invocation);
        if (invocation.pid !== candidatePid && invocation.force) {
          rootKilled = true;
          process.kill(invocation.pid, 'SIGKILL');
        }
        return true;
      },
    })).rejects.toThrow('cleanup could not confirm Windows process-tree termination');

    expect(taskkillInvocations.some((invocation) => invocation.pid === candidatePid)).toBe(false);
  });

  it('cleans an observed Windows detached child after root exit zero', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-perf-windows-normal-exit-'));
    roots.push(root);
    const pidFile = path.join(root, 'pids.json');
    const grandchildSource = `${syntheticWatchdogSource} setInterval(() => {}, 1000);`;
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
          ...(isProcessAlive(pids.child) ? [{
            ProcessId: pids.child,
            ParentProcessId: 1,
            CreationDateTicks: '100',
          }] : []),
          ...(!grandchildKilled ? [{
            ProcessId: pids.grandchild,
            ParentProcessId: pids.child,
            CreationDateTicks: '200',
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
        syntheticWatchdogSource,
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
            CreationDateTicks: '100',
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
