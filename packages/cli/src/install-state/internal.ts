import crypto from 'node:crypto';
import path from 'node:path';

export interface ValidationFailure {
  code: string;
  error: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | ({ ok: false } & ValidationFailure);

export function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

export function fail(code: string, error: string): ValidationResult<never> {
  return { ok: false, code, error };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function sha256Hex(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/');
}

export function createInstallStateSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'plugin';
}

export function ensureOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  context: string,
): ValidationResult<Record<string, unknown>> {
  const allowed = new Set(allowedKeys);
  const unsupportedKey = Object.keys(value).find((key) => !allowed.has(key));
  if (!unsupportedKey) {
    return ok(value);
  }

  return fail(
    'unexpectedField',
    `Invalid ${context}: unexpected field "${unsupportedKey}".`,
  );
}

export function isPathInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function normalizeRepoRelativePath(
  value: string,
  options: { allowDot?: boolean } = {},
): ValidationResult<string> {
  if (!isNonEmptyString(value)) {
    return fail('invalidRelativePath', 'Expected a non-empty repo-relative path.');
  }

  if (value.includes('\\')) {
    return fail('invalidRelativePath', `Invalid repo-relative path "${value}": use "/" separators.`);
  }

  if (path.posix.isAbsolute(value)) {
    return fail('invalidRelativePath', `Invalid repo-relative path "${value}": absolute paths are not allowed.`);
  }

  if (value.includes('/../') || value.startsWith('../') || value.endsWith('/..') || value === '..') {
    return fail('invalidRelativePath', `Invalid repo-relative path "${value}": ".." is not allowed.`);
  }

  if (value.includes('/./') || value.startsWith('./') || value.endsWith('/.') || value.includes('//')) {
    return fail('invalidRelativePath', `Invalid repo-relative path "${value}": path must already be normalized.`);
  }

  if (value === '.') {
    if (options.allowDot) {
      return ok(value);
    }
    return fail('invalidRelativePath', 'Invalid repo-relative path ".": only project root locators may use ".".');
  }

  return ok(value);
}
