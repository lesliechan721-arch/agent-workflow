import crypto from 'node:crypto';

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function normalizeStableTargetVersion(value, fieldName = 'targetVersion') {
  if (typeof value !== 'string' || !STABLE_VERSION_PATTERN.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected a strict stable SemVer version.`);
  }
  return value;
}

function compareCodeUnitStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function canonicalJsonValue(value, fieldName, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid ${fieldName}: JSON numbers must be finite.`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new Error(`Invalid ${fieldName}: expected a JSON value.`);
  }
  if (seen.has(value)) {
    throw new Error(`Invalid ${fieldName}: circular JSON value.`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new Error(`Invalid ${fieldName}[${index}]: sparse arrays are not supported.`);
        }
      }
      return `[${value.map((entry, index) => canonicalJsonValue(
        entry,
        `${fieldName}[${index}]`,
        seen,
      )).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Invalid ${fieldName}: expected a plain JSON object.`);
    }
    return `{${Object.keys(value).sort(compareCodeUnitStrings).map((key) => (
      `${JSON.stringify(key)}:${canonicalJsonValue(value[key], `${fieldName}.${key}`, seen)}`
    )).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value) {
  return canonicalJsonValue(value, 'value', new Set());
}

export function calculateCanonicalDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
