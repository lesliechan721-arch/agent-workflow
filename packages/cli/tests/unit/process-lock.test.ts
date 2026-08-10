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
  it('retries when the observed owner releases before recovery lstat', async () => {
    const target = lockPath('release-before-lstat');
    const owner = await acquireProcessLock({ lockPath: target });
    let intercepted = false;
    const contender = await acquireProcessLock({
      lockPath: target,
      pollMs: 1,
      timeoutMs: 100,
      fileSystem: realFileSystem({
        async lstat(targetPath) {
          if (!intercepted && targetPath === target) {
            intercepted = true;
            await owner.release();
            const error = new Error('lock disappeared after EEXIST') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return fs.lstat(targetPath);
        },
      }),
    });

    expect(intercepted).toBe(true);
    expect(contender.owner.token).not.toBe(owner.owner.token);
    await contender.release();
  });

  it('still times out when EEXIST and recovery ENOENT repeat', async () => {
    const target = lockPath('repeated-missing-recovery');
    const fileSystem = realFileSystem({
      async mkdir() {
        const error = new Error('simulated existing lock') as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      },
      async lstat() {
        const error = new Error('simulated missing lock') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
    });

    await expect(acquireProcessLock({
      lockPath: target,
      fileSystem,
      timeoutMs: 20,
      pollMs: 1,
    })).rejects.toThrow('Timed out waiting for process lock');
  });

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

  it('retains an owner temp path and removes it during release retry', async () => {
    const target = lockPath('owner-temp-retry');
    let failTempCleanup = true;
    const fileSystem = realFileSystem({
      async unlink(targetPath) {
        if (failTempCleanup && targetPath.startsWith(`${target}.owner-`)) {
          failTempCleanup = false;
          const error = new Error('simulated owner temp cleanup EIO') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        await fs.unlink(targetPath);
      },
    });
    const lease = await acquireProcessLock({ lockPath: target, fileSystem });
    expect((await fs.readdir(path.dirname(target))).some(
      (entry) => entry.startsWith(`${path.basename(target)}.owner-`),
    )).toBe(true);

    await expect(lease.release()).resolves.toBeUndefined();
    expect((await fs.readdir(path.dirname(target))).some(
      (entry) => entry.startsWith(`${path.basename(target)}.owner-`),
    )).toBe(false);
  });

  it('keeps persistent owner temp cleanup failure visible and retryable', async () => {
    const target = lockPath('owner-temp-persistent');
    let blockTempCleanup = true;
    const fileSystem = realFileSystem({
      async unlink(targetPath) {
        if (blockTempCleanup && targetPath.startsWith(`${target}.owner-`)) {
          const error = new Error('persistent owner temp cleanup EIO') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        await fs.unlink(targetPath);
      },
    });
    const lease = await acquireProcessLock({ lockPath: target, fileSystem });

    await expect(lease.release()).rejects.toThrow('persistent owner temp cleanup EIO');
    await expect(fs.pathExists(path.join(target, 'owner.json'))).resolves.toBe(true);
    expect((await fs.readdir(path.dirname(target))).some(
      (entry) => entry.startsWith(`${path.basename(target)}.owner-`),
    )).toBe(true);

    blockTempCleanup = false;
    await expect(lease.release()).resolves.toBeUndefined();
    expect((await fs.readdir(path.dirname(target))).some(
      (entry) => entry.startsWith(`${path.basename(target)}.owner-`),
    )).toBe(false);
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

  it('accepts release completion by a contender after claim grace', async () => {
    const target = lockPath('contender-completes-release');
    const ownerPaused = deferred();
    const ownerClaimed = deferred();
    const owner = await acquireProcessLock({
      lockPath: target,
      testHooks: {
        async afterReleaseClaim() {
          ownerClaimed.resolve();
          await ownerPaused.promise;
        },
      },
    });
    const releasing = owner.release();
    await ownerClaimed.promise;
    const old = new Date(Date.now() - 2_000);
    await fs.utimes(target, old, old);
    const contender = await acquireProcessLock({
      lockPath: target,
      malformedOwnerGraceMs: 1,
      pollMs: 1,
      timeoutMs: 100,
    });

    ownerPaused.resolve();
    await expect(releasing).resolves.toBeUndefined();
    await contender.release();
  });

  it('accepts release completion during the contender owner publication window', async () => {
    const target = lockPath('contender-publication-window');
    const ownerPaused = deferred();
    const ownerClaimed = deferred();
    const contenderPaused = deferred();
    const contenderCreated = deferred();
    const owner = await acquireProcessLock({
      lockPath: target,
      testHooks: {
        async afterReleaseClaim() {
          ownerClaimed.resolve();
          await ownerPaused.promise;
        },
      },
    });
    const releasing = owner.release();
    await ownerClaimed.promise;
    const old = new Date(Date.now() - 2_000);
    await fs.utimes(target, old, old);
    const acquiring = acquireProcessLock({
      lockPath: target,
      malformedOwnerGraceMs: 1,
      pollMs: 1,
      timeoutMs: 100,
      testHooks: {
        async afterMkdir() {
          contenderCreated.resolve();
          await contenderPaused.promise;
        },
      },
    });
    await contenderCreated.promise;

    ownerPaused.resolve();
    await expect(releasing).resolves.toBeUndefined();
    contenderPaused.resolve();
    const contender = await acquiring;
    await contender.release();
  });

  it('cleans only strict stale-owner temp files during crash recovery', async () => {
    const target = lockPath('crashed-owner-temp');
    const parent = path.dirname(target);
    const base = path.basename(target);
    const staleOwner = {
      schemaVersion: 1 as const,
      token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      pid: 99_999_999,
      processStartIdentity: 'dead-owner-start',
      acquiredAt: new Date(Date.now() - 2_000).toISOString(),
    };
    const matchingTemp = path.join(
      parent,
      `${base}.owner-11111111-1111-4111-8111-111111111111.tmp`,
    );
    const differentTemp = path.join(
      parent,
      `${base}.owner-22222222-2222-4222-8222-222222222222.tmp`,
    );
    const symlinkTemp = path.join(
      parent,
      `${base}.owner-33333333-3333-4333-8333-333333333333.tmp`,
    );
    const nearMatchTemp = path.join(parent, `${base}.owner-not-a-uuid.tmp`);
    const sentinel = path.join(parent, 'owner-temp-sentinel');
    await fs.outputJson(path.join(target, 'owner.json'), staleOwner);
    await fs.writeJson(matchingTemp, staleOwner);
    await fs.writeJson(differentTemp, {
      ...staleOwner,
      token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      pid: process.pid,
      processStartIdentity: 'live-contender-start',
      acquiredAt: new Date().toISOString(),
    });
    await fs.writeJson(nearMatchTemp, staleOwner);
    await fs.writeFile(sentinel, 'keep\n');
    await fs.symlink(sentinel, symlinkTemp);
    const old = new Date(Date.now() - 2_000);
    await fs.utimes(target, old, old);

    const lease = await acquireProcessLock({
      lockPath: target,
      malformedOwnerGraceMs: 1,
      pollMs: 1,
      timeoutMs: 100,
    });
    await expect(fs.pathExists(matchingTemp)).resolves.toBe(false);
    await expect(fs.pathExists(differentTemp)).resolves.toBe(true);
    expect((await fs.lstat(symlinkTemp)).isSymbolicLink()).toBe(true);
    await expect(fs.pathExists(nearMatchTemp)).resolves.toBe(true);
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('keep\n');
    await lease.release();
  });

  it('restores a stale claim when matching temp cleanup fails and retries later', async () => {
    const target = lockPath('stale-owner-temp-retry');
    const staleOwner = {
      schemaVersion: 1 as const,
      token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      pid: 99_999_998,
      processStartIdentity: 'dead-owner-retry-start',
      acquiredAt: new Date(Date.now() - 2_000).toISOString(),
    };
    const matchingTemp = `${target}.owner-44444444-4444-4444-8444-444444444444.tmp`;
    await fs.outputJson(path.join(target, 'owner.json'), staleOwner);
    await fs.writeJson(matchingTemp, staleOwner);
    const old = new Date(Date.now() - 2_000);
    await fs.utimes(target, old, old);
    let failCleanup = true;
    const fileSystem = realFileSystem({
      async unlink(targetPath) {
        if (failCleanup && targetPath.startsWith(`${matchingTemp}.stale-quarantine-`)) {
          failCleanup = false;
          const error = new Error('stale owner temp cleanup EIO') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        await fs.unlink(targetPath);
      },
    });

    await expect(acquireProcessLock({
      lockPath: target,
      fileSystem,
      malformedOwnerGraceMs: 1,
      pollMs: 1,
      timeoutMs: 100,
    })).rejects.toThrow('stale owner temp cleanup EIO');
    await expect(fs.readJson(path.join(target, 'owner.json'))).resolves.toMatchObject({
      token: staleOwner.token,
    });
    await expect(fs.pathExists(matchingTemp)).resolves.toBe(true);

    await fs.utimes(target, old, old);
    const lease = await acquireProcessLock({
      lockPath: target,
      fileSystem,
      malformedOwnerGraceMs: 1,
      pollMs: 1,
      timeoutMs: 100,
    });
    await expect(fs.pathExists(matchingTemp)).resolves.toBe(false);
    await lease.release();
  });

  it('never deletes a foreign canonical temp installed after quarantine validation', async () => {
    const target = lockPath('stale-temp-foreign-after-validate');
    const staleOwner = {
      schemaVersion: 1 as const,
      token: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      pid: 99_999_997,
      processStartIdentity: 'dead-owner-foreign-start',
      acquiredAt: new Date(Date.now() - 2_000).toISOString(),
    };
    const canonicalPath = `${target}.owner-55555555-5555-4555-8555-555555555555.tmp`;
    let quarantinePath = '';
    await fs.outputJson(path.join(target, 'owner.json'), staleOwner);
    await fs.writeJson(canonicalPath, staleOwner);
    const old = new Date(Date.now() - 2_000);
    await fs.utimes(target, old, old);

    const lease = await acquireProcessLock({
      lockPath: target,
      malformedOwnerGraceMs: 1,
      pollMs: 1,
      timeoutMs: 100,
      testHooks: {
        async afterStaleTempValidate(canonical, quarantine) {
          expect(canonical).toBe(canonicalPath);
          quarantinePath = quarantine;
          await fs.writeFile(canonical, 'foreign canonical\n');
        },
      },
    });
    await expect(fs.readFile(canonicalPath, 'utf8')).resolves.toBe('foreign canonical\n');
    await expect(fs.pathExists(quarantinePath)).resolves.toBe(false);
    await lease.release();
  });

  it('restores quarantine without overwrite and retains it when canonical is foreign', async () => {
    const target = lockPath('stale-temp-quarantine-no-overwrite');
    const staleOwner = {
      schemaVersion: 1 as const,
      token: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      pid: 99_999_996,
      processStartIdentity: 'dead-owner-quarantine-start',
      acquiredAt: new Date(Date.now() - 2_000).toISOString(),
    };
    const canonicalPath = `${target}.owner-66666666-6666-4666-8666-666666666666.tmp`;
    let quarantinePath = '';
    await fs.outputJson(path.join(target, 'owner.json'), staleOwner);
    await fs.writeJson(canonicalPath, staleOwner);
    const old = new Date(Date.now() - 2_000);
    await fs.utimes(target, old, old);

    const error = await acquireProcessLock({
      lockPath: target,
      malformedOwnerGraceMs: 1,
      pollMs: 1,
      timeoutMs: 100,
      testHooks: {
        async afterStaleTempClaim(canonical, quarantine) {
          expect(canonical).toBe(canonicalPath);
          quarantinePath = quarantine;
          await fs.writeFile(canonical, 'foreign replacement\n');
          await fs.writeJson(quarantine, {
            ...staleOwner,
            token: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          });
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error)).toContain(quarantinePath);
    await expect(fs.readFile(canonicalPath, 'utf8')).resolves.toBe('foreign replacement\n');
    await expect(fs.pathExists(quarantinePath)).resolves.toBe(true);
    await expect(fs.readJson(path.join(target, 'owner.json'))).resolves.toMatchObject({
      token: staleOwner.token,
    });
  });

  it('rejects a missing release claim replaced by the same owner identity', async () => {
    const target = lockPath('missing-claim-same-owner');
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const claimCreated = deferred();
    let claimedPath = '';
    const owner = await acquireProcessLock({
      lockPath: target,
      testHooks: {
        async afterReleaseClaim(pathname) {
          claimedPath = pathname;
          claimCreated.resolve();
          await paused;
        },
      },
    });
    const releasing = owner.release();
    await claimCreated.promise;
    await fs.unlink(claimedPath);
    await fs.writeJson(path.join(target, 'owner.json'), owner.owner);
    resume();

    await expect(releasing).rejects.toThrow();
    await expect(fs.readJson(path.join(target, 'owner.json'))).resolves.toMatchObject({
      token: owner.owner.token,
    });
  });

  it('fails closed on malformed claim replacement and remains recoverable', async () => {
    const target = lockPath('missing-claim-malformed-owner');
    const anomalyPath = path.join(target, 'unexpected-entry');
    const owner = await acquireProcessLock({
      lockPath: target,
      testHooks: {
        async afterReleaseClaim(claimPath) {
          await fs.unlink(claimPath);
          await fs.writeJson(path.join(target, 'owner.json'), { malformed: true });
          await fs.writeFile(anomalyPath, 'unexpected\n');
        },
      },
    });

    await expect(owner.release()).rejects.toThrow(
      'release claim disappeared before verified cleanup',
    );
    await expect(fs.readFile(anomalyPath, 'utf8')).resolves.toBe('unexpected\n');
    await expect(owner.release()).rejects.toThrow(
      'release claim disappeared before verified cleanup',
    );

    await fs.remove(anomalyPath);
    const old = new Date(Date.now() - 2_000);
    await fs.utimes(target, old, old);
    const contender = await acquireProcessLock({
      lockPath: target,
      malformedOwnerGraceMs: 1,
      pollMs: 1,
      timeoutMs: 100,
    });
    await expect(owner.release()).resolves.toBeUndefined();
    await contender.release();
  });
});
