import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertPathWithinReadableRoots,
  assertPathWithinWritableRoots,
  createPathFenceRegistry,
  listRegisteredRoots,
  normalizeAbsolutePath,
  registerReadonlyFixtureRoot,
  registerWritableStateRoot,
  TestPathFenceError,
} from '../helpers/path-fence.js';
import { expectPathFenceViolation } from '../helpers/test-isolation.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('path fence registry', () => {
  it('allows writes inside writable roots and rejects sibling paths with a similar prefix', async () => {
    const baseRoot = await makeTempDir('aw-path-fence-');
    const writableRoot = path.join(baseRoot, 'root');
    const siblingRoot = path.join(baseRoot, 'root-evil');
    await Promise.all([
      fs.ensureDir(writableRoot),
      fs.ensureDir(siblingRoot),
    ]);

    const registry = createPathFenceRegistry();
    registerWritableStateRoot(registry, writableRoot, 'fixture repo');

    expect(
      assertPathWithinWritableRoots(registry, {
        path: path.join(writableRoot, '.agent-workflows', 'plugin-config.json'),
        source: 'project config',
      }),
    ).toBe(normalizeAbsolutePath(path.join(writableRoot, '.agent-workflows', 'plugin-config.json')));

    expectPathFenceViolation(
      () => assertPathWithinWritableRoots(registry, {
        path: path.join(siblingRoot, '.agent-workflows', 'plugin-config.json'),
        source: 'project config',
      }),
      {
        access: 'write',
        path: path.join(siblingRoot, '.agent-workflows', 'plugin-config.json'),
        source: 'project config',
        reason: 'outsideRegisteredRoots',
        recommendedFixIncludes: 'registerWritableStateRoot()',
      },
    );
  });

  it('treats read-only fixture roots as readable but not writable until explicitly re-registered', async () => {
    const fixtureRoot = await makeTempDir('aw-path-fence-readonly-');
    const registry = createPathFenceRegistry();

    registerReadonlyFixtureRoot(registry, fixtureRoot, 'dist fixture');

    expect(
      assertPathWithinReadableRoots(registry, {
        path: path.join(fixtureRoot, 'plugins', 'marketplace.json'),
        source: 'embedded catalog',
      }),
    ).toBe(normalizeAbsolutePath(path.join(fixtureRoot, 'plugins', 'marketplace.json')));

    expectPathFenceViolation(
      () => assertPathWithinWritableRoots(registry, {
        path: path.join(fixtureRoot, 'plugins', 'marketplace.json'),
        source: 'catalog staging',
      }),
      {
        access: 'write',
        path: path.join(fixtureRoot, 'plugins', 'marketplace.json'),
        source: 'catalog staging',
        reason: 'writeToReadOnlyRoot',
        conflictingRootPath: fixtureRoot,
        recommendedFixIncludes: 'registerWritableStateRoot()',
      },
    );

    registerWritableStateRoot(registry, fixtureRoot, 'catalog staging');
    expect(() => assertPathWithinWritableRoots(registry, {
      path: path.join(fixtureRoot, 'plugins', 'marketplace.json'),
      source: 'catalog staging',
    })).not.toThrow();
  });

  it('normalizes symlink aliases to the same registered root', async () => {
    const baseRoot = await makeTempDir('aw-path-fence-symlink-');
    const realRoot = path.join(baseRoot, 'real-root');
    const aliasRoot = path.join(baseRoot, 'alias-root');
    await fs.ensureDir(path.join(realRoot, 'nested'));
    await fs.symlink(realRoot, aliasRoot);

    const registry = createPathFenceRegistry();
    registerWritableStateRoot(registry, aliasRoot, 'symlink fixture');

    expect(
      assertPathWithinWritableRoots(registry, {
        path: path.join(realRoot, 'nested', '..', 'artifact.json'),
        source: 'artifact output',
      }),
    ).toBe(normalizeAbsolutePath(path.join(realRoot, 'artifact.json')));
  });

  it('reports unsafe path, source, registered roots, and the recommended fix', async () => {
    const writableRoot = await makeTempDir('aw-path-fence-message-write-');
    const readonlyRoot = await makeTempDir('aw-path-fence-message-read-');
    const outsideRoot = await makeTempDir('aw-path-fence-message-outside-');

    const registry = createPathFenceRegistry();
    registerWritableStateRoot(registry, writableRoot, 'safe writable root');
    registerReadonlyFixtureRoot(registry, readonlyRoot, 'safe readonly root');

    let caught: unknown;
    try {
      assertPathWithinWritableRoots(registry, {
        path: path.join(outsideRoot, 'logs', 'aw.log'),
        source: 'AW_HOME',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TestPathFenceError);
    const fenceError = caught as TestPathFenceError;
    expect(fenceError.message).toContain(`Unsafe test write path: ${normalizeAbsolutePath(path.join(outsideRoot, 'logs', 'aw.log'))}`);
    expect(fenceError.message).toContain('source: AW_HOME');
    expect(fenceError.message).toContain('registered writable state roots:');
    expect(fenceError.message).toContain(normalizeAbsolutePath(writableRoot));
    expect(fenceError.message).toContain('registered read-only fixture roots:');
    expect(fenceError.message).toContain(normalizeAbsolutePath(readonlyRoot));
    expect(fenceError.message).toContain('recommended fix:');

    expect(listRegisteredRoots(registry)).toEqual({
      readonlyFixtureRoots: [
        {
          path: normalizeAbsolutePath(readonlyRoot),
          sources: ['safe readonly root'],
        },
      ],
      writableStateRoots: [
        {
          path: normalizeAbsolutePath(writableRoot),
          sources: ['safe writable root'],
        },
      ],
    });
  });
});
