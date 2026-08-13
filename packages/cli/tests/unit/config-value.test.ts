import { describe, expect, it } from 'vitest';

import {
  formatConfigCommandValue,
  INVALID_CONFIG_JSON_VALUE_MESSAGE,
  parseConfigValue,
} from '../../src/utils/config-value.js';

describe('config value JSON helpers', () => {
  it.each([
    ['object', '{"enabled":true}', { enabled: true }],
    ['number', '42', 42],
    ['boolean', 'false', false],
  ])('parses a JSON %s value', (_name, raw, expected) => {
    expect(parseConfigValue(raw, true)).toEqual(expected);
  });

  it('keeps ordinary config values unchanged', () => {
    expect(parseConfigValue('42', false)).toBe('42');
  });

  it('uses a JSON literal for a copyable command token', () => {
    const token = formatConfigCommandValue('"medium"', true);
    expect(token).toBe('"medium"');
    expect(JSON.parse(token)).toBe('medium');
  });

  it('keeps an invalid original token invalid in the command summary', () => {
    expect(formatConfigCommandValue('not-json', true)).toBe('not-json');
  });

  it('reports one stable error for invalid JSON', () => {
    expect(() => parseConfigValue('medium', true)).toThrow(INVALID_CONFIG_JSON_VALUE_MESSAGE);
  });
});
