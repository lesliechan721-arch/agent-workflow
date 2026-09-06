import { describe, expect, it } from 'vitest';

import { sharedNativeStateLabel } from '../../src/tui/glossary.js';

describe('TUI glossary', () => {
  it('keeps unobserved, render drift, missing, and damaged states distinct', () => {
    const projection = (state: 'missing' | 'unobserved' | 'replaceable', reason?: 'renderDrift' | 'damaged') =>
      sharedNativeStateLabel({
        pluginId: 'demo@aw-official',
        state,
        ...(reason ? { reason } : {}),
      });

    expect(projection('unobserved')).toBe('未检查');
    expect(projection('replaceable', 'renderDrift')).toBe('待同步');
    expect(projection('missing')).toBe('缺失');
    expect(projection('replaceable', 'damaged')).toBe('损坏');
  });
});
