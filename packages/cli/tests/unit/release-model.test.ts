import { describe, expect, it } from 'vitest';

import {
  calculateCanonicalDigest,
  canonicalJson,
} from '../../../../scripts/release/release-model.mjs';

describe('release digests and metadata', () => {
  it('canonicalizes JSON object keys and rejects values with no JSON identity', () => {
    expect(canonicalJson({ z: 1, a: { d: true, c: null } }))
      .toBe('{"a":{"c":null,"d":true},"z":1}');
    expect(calculateCanonicalDigest({ z: 1, a: 2 }))
      .toBe(calculateCanonicalDigest({ a: 2, z: 1 }));
    expect(() => canonicalJson({ value: undefined })).toThrow('expected a JSON value');
    expect(() => canonicalJson({ value: Number.NaN })).toThrow('must be finite');
  });
});
