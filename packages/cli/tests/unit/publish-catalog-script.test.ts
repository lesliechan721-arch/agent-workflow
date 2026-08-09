import { afterEach, describe, expect, it, vi } from 'vitest';

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('publish-catalog script', () => {
  it('logs stable package metadata without cleaned staging paths', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.doMock('../../../../scripts/release/common.mjs', () => ({
      createCatalogRegistryAdapter: vi.fn(async () => ({ kind: 'registry' })),
      publishCatalogRelease: vi.fn(async () => ({
        channel: 'beta',
        catalogVersion: '9.0.0-beta.6',
        manifest: { catalogVersion: '9.0.0-beta.6', channel: 'beta' },
        packages: {
          sidecar: {
            name: '@yiliang/aw-plugins-manifest',
            version: '9.0.0-beta.6',
          },
          full: {
            name: '@yiliang/aw-plugins',
            version: '9.0.0-beta.6',
          },
        },
      })),
      runCommand: vi.fn(async () => undefined),
    }));
    process.argv = [
      process.execPath,
      'scripts/release/publish-catalog.mjs',
      'beta',
      '--catalog-version',
      '9.0.0-beta.6',
    ];

    await import(
      new URL(`../../../../scripts/release/publish-catalog.mjs?test=${Math.random()}`, import.meta.url).href
    );

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      'Published catalog 9.0.0-beta.6 to beta (@yiliang/aw-plugins-manifest, @yiliang/aw-plugins).',
    );
    expect(log.mock.calls.flat().join('\n')).not.toContain('.release');
    expect(process.exitCode).not.toBe(1);
  });
});
