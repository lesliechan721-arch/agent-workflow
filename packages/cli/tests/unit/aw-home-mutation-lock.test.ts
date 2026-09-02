import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  withAwHomeMutationLock,
  type AwHomeMutationToken,
} from '../../src/utils/aw-home-mutation-lock.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('AW_HOME mutation lock', () => {
  it('serializes actions for the same canonical AW_HOME', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const env = { ...isolation.env, AW_HOME: path.join(isolation.env.AW_HOME!, 'shared') };
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondEntered = deferred();
    const order: string[] = [];
    const first = withAwHomeMutationLock({
      env,
      action: async () => {
        order.push('first:enter');
        firstEntered.resolve();
        await releaseFirst.promise;
        order.push('first:leave');
      },
    });
    await firstEntered.promise;
    const second = withAwHomeMutationLock({
      env,
      action: async () => {
        order.push('second:enter');
        secondEntered.resolve();
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(order).toEqual(['first:enter']);
    releaseFirst.resolve();
    await Promise.all([first, second, secondEntered.promise]);
    expect(order).toEqual(['first:enter', 'first:leave', 'second:enter']);
  });

  it('allows distinct AW_HOME roots to progress independently', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstEnv = { ...isolation.env, AW_HOME: path.join(isolation.env.AW_HOME!, 'first') };
    const secondEnv = { ...isolation.env, AW_HOME: path.join(isolation.env.AW_HOME!, 'second') };
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondEntered = deferred();
    const first = withAwHomeMutationLock({
      env: firstEnv,
      action: async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
      },
    });
    await firstEntered.promise;

    await withAwHomeMutationLock({
      env: secondEnv,
      action: async () => { secondEntered.resolve(); },
    });
    await secondEntered.promise;
    releaseFirst.resolve();
    await first;
  });

  it('cancels a caller that is waiting for the mutation lock', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const env = { ...isolation.env, AW_HOME: path.join(isolation.env.AW_HOME!, 'cancel') };
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const first = withAwHomeMutationLock({
      env,
      action: async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
      },
    });
    await firstEntered.promise;
    const controller = new AbortController();
    const waiting = withAwHomeMutationLock({
      env,
      signal: controller.signal,
      action: async () => undefined,
    });

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    releaseFirst.resolve();
    await first;
  });

  it('allows explicit nested reuse and rejects invalid, wrong-root, and expired tokens', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstEnv = { ...isolation.env, AW_HOME: path.join(isolation.env.AW_HOME!, 'first') };
    const secondEnv = { ...isolation.env, AW_HOME: path.join(isolation.env.AW_HOME!, 'second') };
    let captured!: AwHomeMutationToken;

    await withAwHomeMutationLock({
      env: firstEnv,
      action: async (token) => {
        captured = token;
        await expect(withAwHomeMutationLock({
          env: firstEnv,
          token,
          action: async (nestedToken) => nestedToken,
        })).resolves.toBe(token);
        await expect(withAwHomeMutationLock({
          env: secondEnv,
          token,
          action: async () => undefined,
        })).rejects.toThrow('different coordination root');
      },
    });

    await expect(withAwHomeMutationLock({
      env: firstEnv,
      token: captured,
      action: async () => undefined,
    })).rejects.toThrow('Invalid AW_HOME mutation token');
    await expect(withAwHomeMutationLock({
      env: firstEnv,
      token: {} as AwHomeMutationToken,
      action: async () => undefined,
    })).rejects.toThrow('Invalid AW_HOME mutation token');
  });
});
