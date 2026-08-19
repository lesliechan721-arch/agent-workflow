import { describe, expect, it, vi } from 'vitest';

import { publishCatalog } from '../../../../scripts/release/publish-catalog.mjs';

describe('publish-catalog Phase 4A boundary', () => {
  it('verifies and stages locally, then stops before remote publication', async () => {
    const runCommand = vi.fn(async () => undefined);
    const stageCatalogRelease = vi.fn(async () => ({
      outputRoot: '/tmp/catalog-stage',
    }));

    await expect(publishCatalog(
      ['beta', '--catalog-version', '9.0.0-beta.6'],
      { runCommand, stageCatalogRelease },
    )).rejects.toThrow('Remote Git catalog publishing is not available until Phase 4B');

    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith('pnpm', ['run', 'release:verify:catalog']);
    expect(stageCatalogRelease).toHaveBeenCalledWith([
      '--catalog-version',
      '9.0.0-beta.6',
    ]);
  });

  it('rejects a channel and version mismatch before staging', async () => {
    const stageCatalogRelease = vi.fn();
    await expect(publishCatalog(
      ['latest', '--catalog-version', '9.0.0-beta.6'],
      { stageCatalogRelease },
    )).rejects.toThrow('Expected a stable version');
    expect(stageCatalogRelease).not.toHaveBeenCalled();
  });
});
