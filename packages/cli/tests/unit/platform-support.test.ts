import { describe, expect, it } from 'vitest';

import { resolveSupportedPlatforms, supportsPlatform } from '../../src/utils/platform-support.js';

describe('platform support', () => {
  it('derives support from canonical manifest platforms', () => {
    const manifest = {
      name: 'codex-only',
      version: '1.0.0',
      description: 'codex only',
      platforms: ['codex' as const],
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL' as const,
        },
      },
    };
    expect([...resolveSupportedPlatforms(manifest)]).toEqual(['codex']);
    expect(supportsPlatform(manifest, 'codex')).toBe(true);
    expect(supportsPlatform(manifest, 'claude')).toBe(false);
  });
});
