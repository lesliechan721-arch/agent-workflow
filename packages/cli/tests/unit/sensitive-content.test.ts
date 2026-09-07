import { describe, expect, it } from 'vitest';

import {
  collectSensitiveTokenRepresentations,
  findSensitiveTokenPath,
  resolveSensitiveTokenRepresentations,
} from '../../src/utils/sensitive-content.js';
import { assertNoSensitiveConfigValues } from '../../src/utils/plugin-scripts.js';

describe('sensitive content scan', () => {
  it('creates unique raw and JSON-escaped representations for non-empty values', () => {
    const secret = 'quote" newline\n slash\\';

    expect(collectSensitiveTokenRepresentations([secret, secret, ''])).toEqual([
      JSON.stringify(secret).slice(1, -1),
      secret,
    ]);
  });

  it('blocks raw and JSON-escaped values at the eight Unicode code point boundary', () => {
    const raw = '🔐'.repeat(8);
    const escaped = 'ab\ncdefg';
    expect(findSensitiveTokenPath(
      { 'SKILL.md': `value=${raw}` },
      [raw],
    )).toBe('SKILL.md');
    expect(findSensitiveTokenPath(
      { 'SKILL.md': 'value=ab\\ncdefg' },
      [escaped],
    )).toBe('SKILL.md');
    expect(() => assertNoSensitiveConfigValues(
      { files: { 'SKILL.md': 'value=ab\\ncdefg' } },
      [escaped],
      'blocked',
    )).toThrow('blocked');
    expect(resolveSensitiveTokenRepresentations('ab\nc')).toEqual(['ab\nc', 'ab\\nc']);
  });

  it('allows seven code point and common short values in artifacts', () => {
    const values = ['🔐'.repeat(7), 'a', '1', 'prod'];
    expect(findSensitiveTokenPath(
      { 'prod.txt': `values=${values.join(' ')}` },
      values,
    )).toBeUndefined();
    expect(() => assertNoSensitiveConfigValues(
      { prod: values },
      values,
      'blocked',
    )).not.toThrow();
  });

  it('scans long sensitive values in file names and binary attachments', () => {
    const secret = 'long-attachment-secret';
    expect(findSensitiveTokenPath(
      { [`references/${secret}.txt`]: 'safe' },
      [secret],
    )).toBe('[REDACTED_PATH]');
    expect(findSensitiveTokenPath(
      { 'assets/data.bin': Buffer.from(`prefix ${secret} suffix`) },
      [secret],
    )).toBe('assets/data.bin');
  });
});
