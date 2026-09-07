import { describe, expect, it } from 'vitest';

import {
  collectSensitiveTokenRepresentations,
  findSensitiveTokenPath,
} from '../../src/utils/sensitive-content.js';

describe('sensitive content scan', () => {
  it('creates unique raw and JSON-escaped representations for non-empty values', () => {
    const secret = 'quote" newline\n slash\\';

    expect(collectSensitiveTokenRepresentations([secret, secret, ''])).toEqual([
      JSON.stringify(secret).slice(1, -1),
      secret,
    ]);
  });

  it('finds a JSON-escaped sensitive value in rendered files', () => {
    expect(findSensitiveTokenPath(
      { 'SKILL.md': 'value=line1\\nline2' },
      ['line1\nline2'],
    )).toBe('SKILL.md');
  });
});
