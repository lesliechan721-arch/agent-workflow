export const DEFAULT_REVIEW_TTL_MS = 1_800_000;
export const MAX_REVIEW_TTL_MS = 14_400_000;

function validateTtlMs(ttlMs, source) {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_REVIEW_TTL_MS) {
    throw new Error(`${source} must be an integer from 1 to ${MAX_REVIEW_TTL_MS} milliseconds.`);
  }
  return ttlMs;
}

export async function resolveReviewTtl({ ttlMs }) {
  if (ttlMs !== undefined) return validateTtlMs(ttlMs, '--ttl');
  return DEFAULT_REVIEW_TTL_MS;
}
