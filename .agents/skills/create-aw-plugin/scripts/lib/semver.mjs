const STRICT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export const PLUGIN_VERSION_BUMPS = new Set(['major', 'minor', 'patch']);

export function parseStrictSemVer(value, fieldName = 'version') {
  const stringValue = String(value);
  const match = stringValue.match(STRICT_SEMVER_PATTERN);
  if (!match) {
    throw new Error(
      `${fieldName} must be a strict SemVer 2.0.0 string, got ${JSON.stringify(stringValue)}.`,
    );
  }

  return {
    raw: stringValue,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
    build: match[5] ? match[5].split('.') : [],
  };
}

function comparePrereleaseIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function compareStrictSemVer(left, right) {
  const leftVersion = parseStrictSemVer(left, 'version');
  const rightVersion = parseStrictSemVer(right, 'version');

  for (const key of ['major', 'minor', 'patch']) {
    if (leftVersion[key] !== rightVersion[key]) {
      return leftVersion[key] - rightVersion[key];
    }
  }

  const leftPrerelease = leftVersion.prerelease;
  const rightPrerelease = rightVersion.prerelease;
  if (leftPrerelease.length === 0 && rightPrerelease.length === 0) return 0;
  if (leftPrerelease.length === 0) return 1;
  if (rightPrerelease.length === 0) return -1;

  const maxLength = Math.max(leftPrerelease.length, rightPrerelease.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftIdentifier = leftPrerelease[index];
    const rightIdentifier = rightPrerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const result = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (result !== 0) return result;
  }

  return 0;
}

function incrementStableVersion(version, bump) {
  if (!PLUGIN_VERSION_BUMPS.has(bump)) {
    throw new Error('--bump must be one of "major", "minor", or "patch".');
  }
  if (version.prerelease.length > 0 || version.build.length > 0) {
    throw new Error(
      `Plugin version ${JSON.stringify(version.raw)} contains prerelease or build metadata; use --version with an exact higher SemVer.`,
    );
  }

  if (bump === 'major') return `${version.major + 1}.0.0`;
  if (bump === 'minor') return `${version.major}.${version.minor + 1}.0`;
  return `${version.major}.${version.minor}.${version.patch + 1}`;
}

export function resolveNextPluginVersion(currentValue, options = {}) {
  const current = parseStrictSemVer(currentValue, 'plugin version');
  const hasExactVersion = options.version !== undefined;
  const hasBump = options.bump !== undefined;
  if (hasExactVersion && hasBump) {
    throw new Error('--version and --bump are mutually exclusive.');
  }

  const next = hasExactVersion
    ? parseStrictSemVer(options.version, '--version').raw
    : incrementStableVersion(current, options.bump ?? options.defaultBump);

  if (compareStrictSemVer(next, current.raw) <= 0) {
    throw new Error(
      `New plugin version ${JSON.stringify(next)} must have higher SemVer precedence than ${JSON.stringify(current.raw)}.`,
    );
  }
  return next;
}
