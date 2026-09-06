import { describe, expect, it, vi } from 'vitest';

import {
  assertPublishedCliArtifactsMatch,
  ensureCliTag,
} from '../../../../scripts/release/cli-git-tag.mjs';

const version = '0.1.0-beta.1';
const sourceHead = 'a'.repeat(40);

describe('CLI Git tag publisher', () => {
  it('accepts an expected remote tag after an uncertain push result', async () => {
    const readRemoteTag = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ object: 'b'.repeat(40), commit: sourceHead });
    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'push') throw new Error('connection closed');
      return { stdout: '', stderr: '' };
    });

    await expect(ensureCliTag(version, sourceHead, {
      readRemoteTag,
      readLocalTag: async () => null,
      runGit,
    })).resolves.toMatchObject({ status: 'published', version, sourceHead });
  });

  it('requires tag repair when an uncertain push did not publish the tag', async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'push') throw new Error('connection closed');
      return { stdout: '', stderr: '' };
    });

    await expect(ensureCliTag(version, sourceHead, {
      readRemoteTag: async () => null,
      readLocalTag: async () => null,
      runGit,
    })).rejects.toThrow('pnpm release -- --repair-cli-tag');
  });

  it('matches all published packages against the prepared artifacts before repair', async () => {
    const assertPublishedPackageMatches = vi.fn(async () => undefined);
    const descriptor = {
      axes: { cli: true, catalog: false },
      candidates: { cli: version, catalog: null },
      npm: {
        packages: [
          { name: '@lesliechan721/aw-windows-job-win32-x64', path: 'artifacts/windows-x64.tgz' },
          { name: '@lesliechan721/aw-windows-job-win32-arm64', path: 'artifacts/windows-arm64.tgz' },
          { name: '@lesliechan721/agent-skill-eval', path: 'artifacts/eval.tgz' },
          { name: '@lesliechan721/aw-plugin-core', path: 'artifacts/core.tgz' },
          { name: '@lesliechan721/aw', path: 'artifacts/cli.tgz' },
        ],
      },
    };

    await assertPublishedCliArtifactsMatch('/prepared', descriptor, {
      assertPublishedPackageMatches,
    });

    expect(assertPublishedPackageMatches).toHaveBeenCalledTimes(5);
    expect(assertPublishedPackageMatches).toHaveBeenNthCalledWith(
      1,
      '@lesliechan721/aw-windows-job-win32-x64',
      version,
      expect.stringContaining('packages/aw-windows-job-win32-x64/package.json'),
      '/prepared/artifacts/windows-x64.tgz',
      expect.any(Object),
    );
    expect(assertPublishedPackageMatches).toHaveBeenNthCalledWith(
      2,
      '@lesliechan721/aw-windows-job-win32-arm64',
      version,
      expect.stringContaining('packages/aw-windows-job-win32-arm64/package.json'),
      '/prepared/artifacts/windows-arm64.tgz',
      expect.any(Object),
    );
    expect(assertPublishedPackageMatches).toHaveBeenNthCalledWith(
      3,
      '@lesliechan721/agent-skill-eval',
      version,
      expect.stringContaining('packages/agent-skill-eval/package.json'),
      '/prepared/artifacts/eval.tgz',
      expect.any(Object),
    );
    expect(assertPublishedPackageMatches).toHaveBeenNthCalledWith(
      4,
      '@lesliechan721/aw-plugin-core',
      version,
      expect.stringContaining('packages/plugin-core/package.json'),
      '/prepared/artifacts/core.tgz',
      expect.any(Object),
    );
    expect(assertPublishedPackageMatches).toHaveBeenNthCalledWith(
      5,
      '@lesliechan721/aw',
      version,
      expect.stringContaining('packages/cli/package.json'),
      '/prepared/artifacts/cli.tgz',
      expect.any(Object),
    );
  });
});
