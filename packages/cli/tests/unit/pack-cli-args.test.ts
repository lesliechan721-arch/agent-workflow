import { describe, expect, it } from 'vitest';

import { parseArgs as parsePackCliArgs } from '../../../../scripts/release/pack-cli.mjs';

describe('pack CLI arguments', () => {
  it('parses the public CLI pack destination argument', () => {
    expect(parsePackCliArgs([])).toEqual({ destination: undefined });
    expect(parsePackCliArgs(['--pack-destination', '/tmp/aw-pack'])).toEqual({
      destination: '/tmp/aw-pack',
    });
    expect(parsePackCliArgs(['--', '--pack-destination', 'relative-pack'])).toEqual({
      destination: 'relative-pack',
    });
    expect(parsePackCliArgs(['--native-candidate', '/tmp/native-candidate'])).toEqual({ destination: undefined, nativeCandidateRoot: '/tmp/native-candidate' });
    expect(() => parsePackCliArgs(['--native-candidate'])).toThrow('Missing value');
    expect(() => parsePackCliArgs(['--pack-destination'])).toThrow('Missing value');
    expect(() => parsePackCliArgs(['--unexpected'])).toThrow('Unknown argument');
  });
});
