import crypto from 'node:crypto';

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CLI_TRAIN_PACKAGES = [
  '@lesliechan721/agent-skill-eval',
  '@lesliechan721/aw',
];

function assertObject(value, fieldName) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }
  return value;
}

function assertAllowedKeys(value, fieldName, allowedKeys) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`Invalid ${fieldName}: unknown field "${key}".`);
    }
  }
}

function normalizeDigest(value, fieldName) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected a canonical sha256 digest.`);
  }
  return value;
}

function normalizeNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    throw new Error(`Invalid ${fieldName}: expected a non-empty trimmed string.`);
  }
  return value;
}

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

export function calculateCliTrainContentDigest(rawPackages) {
  if (!Array.isArray(rawPackages)) {
    throw new Error('Invalid CLI train packages: expected an array.');
  }
  const packages = rawPackages.map((rawPackage, index) => {
    const fieldName = `packages[${index}]`;
    const packageEntry = assertObject(rawPackage, fieldName);
    assertAllowedKeys(packageEntry, fieldName, ['name', 'contentDigest']);
    return {
      name: normalizeNonEmptyString(packageEntry.name, `${fieldName}.name`),
      contentDigest: normalizeDigest(packageEntry.contentDigest, `${fieldName}.contentDigest`),
    };
  }).sort((left, right) => compareCodeUnitStrings(left.name, right.name));
  if (
    packages.length !== CLI_TRAIN_PACKAGES.length
    || packages.some((entry, index) => entry.name !== CLI_TRAIN_PACKAGES[index])
  ) {
    throw new Error(`Invalid CLI train packages: expected ${CLI_TRAIN_PACKAGES.join(' and ')}.`);
  }
  return calculateCanonicalDigest({ schemaVersion: 1, packages });
}

export function calculateCatalogContentDigest(rawCatalog) {
  const catalog = assertObject(rawCatalog, 'catalog digest input');
  for (const fieldName of ['schemaIdentity', 'marketplaceMetadata', 'compatibility']) {
    if (!Object.hasOwn(catalog, fieldName)) {
      throw new Error(`Invalid catalog digest input.${fieldName}: field is required.`);
    }
  }
  if (!Array.isArray(catalog.plugins)) {
    throw new Error('Invalid catalog digest input.plugins: expected an array.');
  }
  const names = new Set();
  const plugins = catalog.plugins.map((rawPlugin, index) => {
    const fieldName = `catalog digest input.plugins[${index}]`;
    const plugin = assertObject(rawPlugin, fieldName);
    const name = normalizeNonEmptyString(plugin.name, `${fieldName}.name`);
    if (names.has(name)) {
      throw new Error(`Invalid catalog digest input.plugins: duplicate plugin "${name}".`);
    }
    names.add(name);
    return {
      name,
      targetVersion: normalizeStableTargetVersion(
        plugin.targetVersion,
        `${fieldName}.targetVersion`,
      ),
      contentDigest: normalizeDigest(plugin.contentDigest, `${fieldName}.contentDigest`),
    };
  }).sort((left, right) => compareCodeUnitStrings(left.name, right.name));
  return calculateCanonicalDigest({
    schemaIdentity: catalog.schemaIdentity,
    marketplaceMetadata: catalog.marketplaceMetadata,
    compatibility: catalog.compatibility,
    plugins,
  });
}
