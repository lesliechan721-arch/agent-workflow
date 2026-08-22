import crypto from 'node:crypto';

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CANDIDATE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SOURCE_HEAD_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
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

export function normalizeCandidateVersion(value, fieldName = 'candidateVersion') {
  if (typeof value !== 'string' || !CANDIDATE_VERSION_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${fieldName}: expected x.y.z or x.y.z-beta.N with a positive canonical N.`,
    );
  }
  return value;
}

function parseCandidateVersion(value, fieldName = 'candidateVersion') {
  const candidateVersion = normalizeCandidateVersion(value, fieldName);
  const match = CANDIDATE_VERSION_PATTERN.exec(candidateVersion);
  return {
    candidateVersion,
    targetVersion: `${match[1]}.${match[2]}.${match[3]}`,
    betaNumber: match[4] ?? null,
  };
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return compareCodeUnitStrings(left, right);
}

function compareCodeUnitStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareCandidateVersions(left, right) {
  const leftParsed = parseCandidateVersion(left);
  const rightParsed = parseCandidateVersion(right);
  const leftCore = leftParsed.targetVersion.split('.');
  const rightCore = rightParsed.targetVersion.split('.');
  for (let index = 0; index < leftCore.length; index += 1) {
    const relation = compareNumericIdentifiers(leftCore[index], rightCore[index]);
    if (relation !== 0) return relation;
  }
  if (leftParsed.betaNumber === rightParsed.betaNumber) return 0;
  if (leftParsed.betaNumber === null) return 1;
  if (rightParsed.betaNumber === null) return -1;
  return compareNumericIdentifiers(leftParsed.betaNumber, rightParsed.betaNumber);
}

export function normalizePublishedHistory(value) {
  if (!Array.isArray(value)) {
    throw new Error('Invalid publishedHistory: expected an array.');
  }
  const byVersion = new Map();
  value.forEach((rawEntry, index) => {
    const fieldName = `publishedHistory[${index}]`;
    const entry = assertObject(rawEntry, fieldName);
    assertAllowedKeys(entry, fieldName, ['candidateVersion', 'contentDigest']);
    const candidateVersion = normalizeCandidateVersion(
      entry.candidateVersion,
      `${fieldName}.candidateVersion`,
    );
    const contentDigest = entry.contentDigest === null
      ? null
      : normalizeDigest(entry.contentDigest, `${fieldName}.contentDigest`);
    const existing = byVersion.get(candidateVersion);
    if (existing !== undefined && existing !== contentDigest) {
      throw new Error(
        `Invalid publishedHistory: conflicting content digests for ${candidateVersion}.`,
      );
    }
    byVersion.set(candidateVersion, contentDigest);
  });
  return [...byVersion.entries()]
    .map(([candidateVersion, contentDigest]) => ({ candidateVersion, contentDigest }))
    .sort((left, right) => compareCandidateVersions(
      left.candidateVersion,
      right.candidateVersion,
    ));
}

function candidateResult(status, reason, targetVersion, candidateVersion = null) {
  return { status, reason, targetVersion, candidateVersion };
}

export function resolveReleaseCandidate({
  intent,
  targetVersion: rawTargetVersion,
  contentDigest: rawContentDigest,
  publishedHistory,
}) {
  if (intent !== 'beta' && intent !== 'stable') {
    throw new Error('Invalid intent: expected "beta" or "stable".');
  }
  const targetVersion = normalizeStableTargetVersion(rawTargetVersion);
  const contentDigest = normalizeDigest(rawContentDigest, 'contentDigest');
  const targetHistory = normalizePublishedHistory(publishedHistory)
    .map((entry) => ({ ...entry, ...parseCandidateVersion(entry.candidateVersion) }))
    .filter((entry) => entry.targetVersion === targetVersion);
  const stable = targetHistory.find((entry) => entry.betaNumber === null);
  if (stable) {
    return stable.contentDigest === contentDigest
      ? candidateResult('skip', 'stable-already-published', targetVersion, targetVersion)
      : candidateResult('deferred', 'target-bump-required', targetVersion);
  }

  const betas = targetHistory.filter((entry) => entry.betaNumber !== null);
  const latestBeta = betas.at(-1);
  if (intent === 'beta') {
    if (!latestBeta) {
      return candidateResult('publish', 'first-beta', targetVersion, `${targetVersion}-beta.1`);
    }
    if (latestBeta.contentDigest === contentDigest) {
      return candidateResult(
        'skip',
        'beta-already-published',
        targetVersion,
        latestBeta.candidateVersion,
      );
    }
    return candidateResult(
      'publish',
      latestBeta.contentDigest === null ? 'beta-digest-unknown' : 'beta-content-changed',
      targetVersion,
      `${targetVersion}-beta.${BigInt(latestBeta.betaNumber) + 1n}`,
    );
  }

  if (!latestBeta) {
    return candidateResult('publish', 'no-beta-train', targetVersion, targetVersion);
  }
  if (latestBeta.contentDigest === contentDigest) {
    return candidateResult('publish', 'beta-promoted', targetVersion, targetVersion);
  }
  return candidateResult(
    'deferred',
    'beta-required',
    targetVersion,
  );
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

export function normalizeReleaseMetadata(rawMetadata) {
  const metadata = assertObject(rawMetadata, 'release metadata');
  assertAllowedKeys(metadata, 'release metadata', [
    'schemaVersion',
    'targetVersion',
    'candidateVersion',
    'planId',
    'sourceHead',
    'packageContentDigest',
    'trainContentDigest',
  ]);
  if (metadata.schemaVersion !== 1) {
    throw new Error('Invalid release metadata.schemaVersion: expected 1.');
  }
  const targetVersion = normalizeStableTargetVersion(metadata.targetVersion);
  const candidate = parseCandidateVersion(metadata.candidateVersion);
  if (candidate.targetVersion !== targetVersion) {
    throw new Error('Invalid release metadata.candidateVersion: target core does not match targetVersion.');
  }
  if (typeof metadata.sourceHead !== 'string' || !SOURCE_HEAD_PATTERN.test(metadata.sourceHead)) {
    throw new Error('Invalid release metadata.sourceHead: expected a lowercase Git object ID.');
  }
  return {
    schemaVersion: 1,
    targetVersion,
    candidateVersion: candidate.candidateVersion,
    planId: normalizeDigest(metadata.planId, 'release metadata.planId'),
    sourceHead: metadata.sourceHead,
    packageContentDigest: normalizeDigest(
      metadata.packageContentDigest,
      'release metadata.packageContentDigest',
    ),
    trainContentDigest: normalizeDigest(
      metadata.trainContentDigest,
      'release metadata.trainContentDigest',
    ),
  };
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
