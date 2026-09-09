import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_REVIEW_TTL_MS,
  resolveReviewTtl,
} from '../skills/decision-prototype/scripts/review-config.mjs';

test('Review TTL uses the fixed default and accepts a session override', async () => {
  assert.equal(await resolveReviewTtl({}), 30 * 60 * 1000);
  assert.equal(await resolveReviewTtl({ ttlMs: MAX_REVIEW_TTL_MS }), MAX_REVIEW_TTL_MS);

  for (const invalid of [0, -1, MAX_REVIEW_TTL_MS + 1, 1.5, Number.NaN]) {
    await assert.rejects(resolveReviewTtl({ ttlMs: invalid }), /--ttl/);
  }
});
