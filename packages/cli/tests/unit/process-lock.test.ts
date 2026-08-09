import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import {
  acquireProcessLock,
  type ProcessLockFileSystem,
} from '../../src/utils/process-lock.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

function lockPath(name: string): string {
  return path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, `${name}.lock`);
}

function realFileSystem(overrides: Partial<ProcessLockFileSystem> = {}): ProcessLockFileSystem {
  return {
    mkdir: (targetPath) => fs.mkdir(targetPath),
    writeFile: (targetPath, contents, options) => fs.writeFile(targetPath, contents, options),
    readFile: (targetPath, encoding) => fs.readFile(targetPath, encoding),
    readdir: (targetPath) => fs.readdir(targetPath),
    stat: (targetPath) => fs.stat(targetPath),
    lstat: (targetPath) => fs.lstat(targetPath),
    rename: (sourcePath, targetPath) => fs.rename(sourcePath, targetPath),
    link: (existingPath, newPath) => fs.link(existingPath, newPath),
    copyFile: (sourcePath, targetPath, flags) => fs.copyFile(sourcePath, targetPath, flags),
    unlink: (targetPath) => fs.unlink(targetPath),
    rmdir: (targetPath) => fs.rmdir(targetPath),
    ...overrides,
  };
}

describe('process lock lease', () => {
  it('recovers a child process terminated after mkdir but before owner publication', async () => {
    const target = lockPath('child-mkdir');
    await execFileAsync(process.execPath, [
      '-e',
      'require("node:fs").mkdirSync(process.argv[1])',
      target,
    ]);
    const old = new Date(Date.now() - 2_000);
    await fs.utimes(target, old, old);

    const lease = await acquireProcessLock({
      lockPath: target,
      malformedOwnerGraceMs: 1,
      pollMs: 1,
    });
    expect(lease.owner.pid).toBe(process.pid);
    expect(lease.owner.processStartIdentity.length).toBeGreaterThan(0);
    expect(Date.parse(lease.owner.acquiredAt)).not.toBeNaN();
    await lease.release();
  });

  it('recovers malformed owners after grace and rejects non-positive owner PIDs', async () => {
    for (const [name, owner] of [
      ['malformed', '{broken'],
      ['negative-pid', JSON.stringify({
        schemaVersion: 1,
        token: '00000000-0000-0000-0000-000000000000',
        pid: -1,
        processStartIdentity: 'invalid',
        acquiredAt: new Date().toISOString(),
      })],
    ] as const) {
      const target = lockPath(name);
      await fs.outputFile(path.join(target, 'owner.json'), owner);
      const old = new Date(Date.now() - 2_000);
      await fs.utimes(target, old, old);
      const lease = await acquireProcessLock({
        lockPath: target,
        malformedOwnerGraceMs: 1,
        pollMs: 1,
      });
      await lease.release();
    }
  });

  it('detects PID reuse through process start identity', async () => {
    const target = lockPath('pid-reuse');
    await fs.outputJson(path.join(target, 'owner.json'), {
      schemaVersion: 1,
      token: '00000000-0000-0000-0000-000000000000',
      pid: process.pid,
      processStartIdentity: 'old-process-start',
      acquiredAt: new Date(Date.now() - 2_000).toISOString(),
    });
    const old = new Date(Date.now() - 2_000);
    await fs.utimes(target, old, old);
    const lease = await acquireProcessLock({
      lockPath: target,
      malformedOwnerGraceMs: 1,
      pollMs: 1,
      processStartIdentityReader: async () => 'new-process-start',
    });
    expect(lease.owner.processStartIdentity).toBe('new-process-start');
    await lease.release();
  });

  it('keeps a failed release claim retryable and verifies token ownership', async () => {
    const target = lockPath('release-retry');
    let failRemove = true;
    const fileSystem = realFileSystem({
      async unlink(targetPath) {
        if (failRemove
          && path.dirname(targetPath) === target
          && path.basename(targetPath).startsWith('release-')) {
          failRemove = false;
          throw new Error('simulated release cleanup failure');
        }
        await fs.unlink(targetPath);
      },
    });
    const lease = await acquireProcessLock({ lockPath: target, fileSystem });
    await expect(lease.release()).rejects.toThrow('simulated release cleanup failure');
    await expect(lease.release()).resolves.toBeUndefined();

    const ownershipTarget = lockPath('release-owner');
    const owned = await acquireProcessLock({ lockPath: ownershipTarget });
    await fs.writeJson(path.join(ownershipTarget, 'owner.json'), {
      ...owned.owner,
      token: '00000000-0000-0000-0000-000000000000',
    });
    await expect(owned.release()).rejects.toThrow('does not match its owner token');
  });

  it('does not recover an ownerless directory during the creator publication grace', async () => {
    const target = lockPath('publish-grace');
    const paused = deferred();
    const entered = deferred();
    const creator = acquireProcessLock({
      lockPath: target,
      malformedOwnerGraceMs: 1_000,
      testHooks: {
        async afterOwnerTempWritten() {
          entered.resolve();
          await paused.promise;
        },
      },
    });
    await entered.promise;
    await expect(acquireProcessLock({
      lockPath: target,
      timeoutMs: 30,
      pollMs: 2,
      malformedOwnerGraceMs: 1_000,
    })).rejects.toThrow('Timed out');
    paused.resolve();
    const lease = await creator;
    await lease.release();
  });

  it('never recursively removes a fixed lock path when owner publication loses wx', async () => {
    const target = lockPath('publish-wx');
    const laterOwner = { token: 'later-owner' };
    await expect(acquireProcessLock({
      lockPath: target,
      testHooks: {
        async afterMkdir() {
          await fs.writeJson(path.join(target, 'owner.json'), laterOwner);
        },
      },
    })).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(fs.readJson(path.join(target, 'owner.json'))).resolves.toEqual(laterOwner);
  });

  it('cleans only its partial owner temp when temp write fails', async () => {
    const target = lockPath('partial-owner-temp');
    let failWrite = true;
    const fileSystem = realFileSystem({
      async writeFile(targetPath, contents, options) {
        if (failWrite) {
          failWrite = false;
          await fs.writeFile(targetPath, contents.slice(0, 8), options);
          const error = new Error('simulated partial temp write') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        await fs.writeFile(targetPath, contents, options);
      },
    });
    await expect(acquireProcessLock({ lockPath: target, fileSystem }))
      .rejects.toThrow('simulated partial temp write');
    expect((await fs.readdir(path.dirname(target))).some((entry) => entry.includes('.owner-'))).toBe(false);
    const lease = await acquireProcessLock({ lockPath: target, fileSystem });
    await lease.release();
  });

  it('keeps release rename failure retryable before assigning a claim path', async () => {
    const target = lockPath('release-rename-retry');
    let failRename = true;
    const fileSystem = realFileSystem({
      async rename(sourcePath, targetPath) {
        if (failRename && path.basename(sourcePath) === 'owner.json') {
          failRename = false;
          const error = new Error('simulated release rename failure') as NodeJS.ErrnoException;
          error.code = 'EBUSY';
          throw error;
        }
        await fs.rename(sourcePath, targetPath);
      },
    });
    const lease = await acquireProcessLock({ lockPath: target, fileSystem });
    await expect(lease.release()).rejects.toThrow('simulated release rename failure');
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it('uses owner-file CAS when stale observation races a new owner', async () => {
    const target = lockPath('stale-aba');
    const ownerPath = path.join(target, 'owner.json');
    const oldOwner = {
      schemaVersion: 1,
      token: '00000000-0000-0000-0000-000000000000',
      pid: process.pid,
      processStartIdentity: 'old-start',
      acquiredAt: new Date(Date.now() - 2_000).toISOString(),
    };
    const newOwner = {
      ...oldOwner,
      token: '11111111-1111-1111-1111-111111111111',
      processStartIdentity: 'new-start',
    };
    await fs.outputJson(ownerPath, oldOwner);
    const old = new Date(Date.now() - 2_000);
    await fs.utimes(target, old, old);
    const paused = deferred();
    const entered = deferred();
    const acquiring = acquireProcessLock({
      lockPath: target,
      timeoutMs: 40,
      pollMs: 2,
      malformedOwnerGraceMs: 1,
      processStartIdentityReader: async () => 'new-start',
      testHooks: {
        async afterStaleObserve() {
          entered.resolve();
          await paused.promise;
        },
      },
    });
    await entered.promise;
    await fs.writeJson(ownerPath, newOwner);
    paused.resolve();
    await expect(acquiring).rejects.toThrow('Timed out');
    await expect(fs.readJson(ownerPath)).resolves.toMatchObject({ token: newOwner.token });
  });

  it('restores a stale owner after claim read failure', async () => {
    const target = lockPath('claim-read');
    const ownerPath = path.join(target, 'owner.json');
    await fs.outputJson(ownerPath, {
      schemaVersion: 1,
      token: '00000000-0000-0000-0000-000000000000',
      pid: process.pid,
      processStartIdentity: 'old-start',
      acquiredAt: new Date(Date.now() - 2_000).toISOString(),
    });
    const old = new Date(Date.now() - 2_000);
    await fs.utimes(target, old, old);
    const fileSystem = realFileSystem({
      async readFile(targetPath, encoding) {
        if (path.basename(targetPath).startsWith('stale-')) {
          throw new Error('simulated claim read failure');
        }
        return fs.readFile(targetPath, encoding);
      },
    });
    await expect(acquireProcessLock({
      lockPath: target,
      fileSystem,
      malformedOwnerGraceMs: 1,
      processStartIdentityReader: async () => 'new-start',
    })).rejects.toThrow('simulated claim read failure');
    await expect(fs.pathExists(ownerPath)).resolves.toBe(true);
  });

  it('never deletes an unverified mismatched claim when no-replace restore fails', async () => {
    const target = lockPath('claim-mismatch');
    const ownerPath = path.join(target, 'owner.json');
    await fs.outputJson(ownerPath, {
      schemaVersion: 1,
      token: '00000000-0000-0000-0000-000000000000',
      pid: process.pid,
      processStartIdentity: 'old-start',
      acquiredAt: new Date(Date.now() - 2_000).toISOString(),
    });
    const old = new Date(Date.now() - 2_000);
    await fs.utimes(target, old, old);
    const fileSystem = realFileSystem({
      async link() {
        const error = new Error('simulated restore failure') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      },
    });
    await expect(acquireProcessLock({
      lockPath: target,
      fileSystem,
      malformedOwnerGraceMs: 1,
      processStartIdentityReader: async () => 'new-start',
      testHooks: {
        async afterOwnerClaim(claimPath) {
          const claimed = await fs.readJson(claimPath);
          await fs.writeJson(claimPath, { ...claimed, token: '22222222-2222-2222-2222-222222222222' });
        },
      },
    })).rejects.toThrow('simulated restore failure');
    expect((await fs.readdir(target)).some((entry) => entry.startsWith('stale-'))).toBe(true);
    await expect(fs.pathExists(ownerPath)).resolves.toBe(false);
  });

  it('marks a mismatched release claim unsafe when no-replace restore fails', async () => {
    const target = lockPath('release-mismatch');
    const fileSystem = realFileSystem({
      async link(existingPath, newPath) {
        if (path.dirname(existingPath) === target
          && path.basename(existingPath).startsWith('release-')) {
          const error = new Error('simulated release restore failure') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        await fs.link(existingPath, newPath);
      },
    });
    const lease = await acquireProcessLock({
      lockPath: target,
      fileSystem,
      testHooks: {
        async afterReleaseClaim(claimPath) {
          const owner = JSON.parse(await fs.readFile(claimPath, 'utf8'));
          await fs.writeJson(claimPath, { ...owner, token: '33333333-3333-3333-3333-333333333333' });
        },
      },
    });
    await expect(lease.release()).rejects.toThrow('does not match its owner token');
    await expect(lease.release()).rejects.toThrow('unsafe and requires manual recovery');
    expect((await fs.readdir(target)).some((entry) => entry.startsWith('release-'))).toBe(true);
  });

  it('finishes a verified stale release claim instead of restoring it as an active owner', async () => {
    const target = lockPath('stale-release-claim');
    const token = '44444444-4444-4444-4444-444444444444';
    await fs.outputJson(path.join(target, `release-${token}.json`), {
      schemaVersion: 1,
      token,
      pid: process.pid,
      processStartIdentity: 'current-but-release-was-claimed',
      acquiredAt: new Date(Date.now() - 2_000).toISOString(),
    });
    const old = new Date(Date.now() - 2_000);
    await fs.utimes(target, old, old);
    const lease = await acquireProcessLock({
      lockPath: target,
      malformedOwnerGraceMs: 1,
      pollMs: 1,
    });
    expect(lease.owner.token).not.toBe(token);
    await lease.release();
  });
});
