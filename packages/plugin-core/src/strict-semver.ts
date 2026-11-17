const STRICT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface StrictSemVer {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
}

export const STRICT_SEMVER_VALIDATION_CODE = 'invalidStrictSemVer';

export interface StrictSemVerValidationIssue {
  code: typeof STRICT_SEMVER_VALIDATION_CODE;
  fieldPath: string;
  value: unknown;
  message: string;
}

export class StrictSemVerValidationError extends Error {
  readonly code = STRICT_SEMVER_VALIDATION_CODE;
  readonly fieldPath: string;
  readonly value: unknown;

  constructor(issue: StrictSemVerValidationIssue) {
    super(issue.message);
    this.name = 'StrictSemVerValidationError';
    this.fieldPath = issue.fieldPath;
    this.value = issue.value;
  }
}

function formatStrictSemVerValidationValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (value === undefined) {
    return 'undefined';
  }

  const serialized = JSON.stringify(value);
  return serialized ?? String(value);
}

export function createStrictSemVerValidationIssue(
  value: unknown,
  fieldPath: string,
): StrictSemVerValidationIssue {
  return {
    code: STRICT_SEMVER_VALIDATION_CODE,
    fieldPath,
    value,
    message: `Invalid ${fieldPath}: expected a strict SemVer 2.0.0 string. Received ${formatStrictSemVerValidationValue(value)}.`,
  };
}

export function getStrictSemVerValidationIssue(
  value: unknown,
  fieldPath: string,
): StrictSemVerValidationIssue | null {
  return tryParseStrictSemVer(value)
    ? null
    : createStrictSemVerValidationIssue(value, fieldPath);
}

export function isStrictSemVerValidationError(error: unknown): error is StrictSemVerValidationError {
  return error instanceof StrictSemVerValidationError
    || (
      error instanceof Error
      && 'code' in error
      && error.code === STRICT_SEMVER_VALIDATION_CODE
    );
}

export function compareStrictSemVerFields(options: {
  left: {
    value: unknown;
    fieldPath: string;
  };
  right: {
    value: unknown;
    fieldPath: string;
  };
}):
  | { kind: 'ordered'; relation: number; left: StrictSemVer; right: StrictSemVer }
  | { kind: 'invalid'; issues: StrictSemVerValidationIssue[] } {
  const leftIssue = getStrictSemVerValidationIssue(options.left.value, options.left.fieldPath);
  const rightIssue = getStrictSemVerValidationIssue(options.right.value, options.right.fieldPath);
  if (leftIssue || rightIssue) {
    return {
      kind: 'invalid',
      issues: [leftIssue, rightIssue].filter((issue): issue is StrictSemVerValidationIssue => issue !== null),
    };
  }

  const left = tryParseStrictSemVer(options.left.value);
  const right = tryParseStrictSemVer(options.right.value);
  if (!left || !right) {
    throw new Error('Strict SemVer comparison reached an unreachable invalid state.');
  }

  return {
    kind: 'ordered',
    relation: compareStrictSemVer(left, right),
    left,
    right,
  };
}

export function assertStrictSemVer(value: unknown, fieldPath: string): string {
  return parseStrictSemVer(value, fieldPath).raw;
}

export function tryParseStrictSemVer(value: unknown): StrictSemVer | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = STRICT_SEMVER_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  return {
    raw: value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
    build: match[5] ? match[5].split('.') : [],
  };
}

export function parseStrictSemVer(value: unknown, fieldPath: string): StrictSemVer {
  const issue = getStrictSemVerValidationIssue(value, fieldPath);
  if (issue) {
    throw new StrictSemVerValidationError(issue);
  }

  return tryParseStrictSemVer(value)!;
}

function isNumericSemVerIdentifier(value: string): boolean {
  return /^\d+$/.test(value);
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftNumeric = isNumericSemVerIdentifier(left);
  const rightNumeric = isNumericSemVerIdentifier(right);
  if (leftNumeric && rightNumeric) {
    if (left.length !== right.length) {
      return left.length - right.length;
    }
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareStrictSemVer(
  left: string | StrictSemVer,
  right: string | StrictSemVer,
): number {
  const resolvedLeft = typeof left === 'string'
    ? parseStrictSemVer(left, 'left version')
    : left;
  const resolvedRight = typeof right === 'string'
    ? parseStrictSemVer(right, 'right version')
    : right;

  if (resolvedLeft.major !== resolvedRight.major) {
    return resolvedLeft.major - resolvedRight.major;
  }
  if (resolvedLeft.minor !== resolvedRight.minor) {
    return resolvedLeft.minor - resolvedRight.minor;
  }
  if (resolvedLeft.patch !== resolvedRight.patch) {
    return resolvedLeft.patch - resolvedRight.patch;
  }

  if (resolvedLeft.prerelease.length === 0 && resolvedRight.prerelease.length === 0) {
    return 0;
  }
  if (resolvedLeft.prerelease.length === 0) {
    return 1;
  }
  if (resolvedRight.prerelease.length === 0) {
    return -1;
  }

  const maxLength = Math.max(resolvedLeft.prerelease.length, resolvedRight.prerelease.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftIdentifier = resolvedLeft.prerelease[index];
    const rightIdentifier = resolvedRight.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const result = comparePrereleaseIdentifiers(leftIdentifier, rightIdentifier);
    if (result !== 0) {
      return result;
    }
  }

  return 0;
}
