import { describe, expect, it } from 'vitest';

import { catalogRefPolicyForPreset } from '../../src/tui/source-ref-presets.js';

describe('Catalog ref presentation presets', () => {
  it('maps Follow, Release, and Beta without extending the stored ref policy', () => {
    expect(catalogRefPolicyForPreset('followCli')).toEqual({ type: 'cliChannel' });
    expect(catalogRefPolicyForPreset('release')).toEqual({
      type: 'explicit', ref: 'refs/heads/catalog/latest',
    });
    expect(catalogRefPolicyForPreset('beta')).toEqual({
      type: 'explicit', ref: 'refs/heads/catalog/beta',
    });
    expect(catalogRefPolicyForPreset('custom')).toBeUndefined();
  });
});
