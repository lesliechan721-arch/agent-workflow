import { describe, expect, it, vi } from 'vitest';

import { publishRelease } from '../../../../scripts/release/publish-release.mjs';

describe('combined release Phase 4A boundary', () => {
  it('creates the catalog handoff and stops before any remote CLI or catalog action', async () => {
    const runCommand = vi.fn(async () => undefined);
    const stageCatalogRelease = vi.fn(async () => ({
      outputRoot: '/tmp/catalog-stage',
    }));
    const readCliPackageJson = vi.fn(async () => ({ version: '1.0.0' }));

    await expect(publishRelease(
      [
        'latest',
        '--cli-version',
        '1.0.0',
        '--catalog-version',
        '2.0.0',
      ],
      { runCommand, stageCatalogRelease, readCliPackageJson },
    )).rejects.toThrow('the CLI was not published');

    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith('pnpm', ['run', 'release:verify']);
    expect(stageCatalogRelease).toHaveBeenCalledWith([
      '--catalog-version',
      '2.0.0',
    ]);
  });

  it('stops before verification and staging when the CLI version is wrong', async () => {
    const runCommand = vi.fn();
    const stageCatalogRelease = vi.fn();
    await expect(publishRelease(
      ['beta', '--cli-version', '1.0.1', '--catalog-version', '2.0.0-beta.1'],
      {
        runCommand,
        stageCatalogRelease,
        readCliPackageJson: async () => ({ version: '1.0.0' }),
      },
    )).rejects.toThrow('CLI version mismatch');
    expect(runCommand).not.toHaveBeenCalled();
    expect(stageCatalogRelease).not.toHaveBeenCalled();
  });
});
