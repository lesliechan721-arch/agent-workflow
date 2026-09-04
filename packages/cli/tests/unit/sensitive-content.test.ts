import { describe, expect, it } from 'vitest';

import { findSensitiveTokenPath } from '../../src/utils/sensitive-content.js';

describe('sensitive content scan', () => {
  it('finds a JSON-escaped sensitive value in rendered files', () => {
    expect(findSensitiveTokenPath(
      { 'SKILL.md': 'value=line1\\nline2' },
      ['line1\nline2'],
    )).toBe('SKILL.md');
  });
});
