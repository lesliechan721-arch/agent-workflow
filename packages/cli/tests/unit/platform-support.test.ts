import { describe, expect, it } from 'vitest';

import { resolveSupportedPlatforms, supportsPlatform } from '../../src/utils/platform-support.js';

describe('platform support', () => {
  it('derives support from marketplace products', () => {
    const manifest = {
      name: 'codex-only',
      version: '1.0.0',
      description: 'codex only',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL' as const,
          products: ['CODEX'],
        },
      },
    };
    expect([...resolveSupportedPlatforms(manifest)]).toEqual(['codex']);
    expect(supportsPlatform(manifest, 'codex')).toBe(true);
    expect(supportsPlatform(manifest, 'claude')).toBe(false);
  });
});
