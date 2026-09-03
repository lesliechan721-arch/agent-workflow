import os from 'node:os';
import path from 'node:path';

import { resolveAwHome } from './state-paths.js';

const DEFAULT_ERROR_CODE = 'catalogSourceResolutionFailed';

export type CatalogProviderCompatibilityErrorCode = 'awCapabilityUnsupported';

export class CatalogProviderCompatibilityError extends Error {
  readonly sourceId: string;
  readonly code: CatalogProviderCompatibilityErrorCode;
  readonly requiredCapabilities: string[];
  readonly missingCapabilities: string[];
  readonly availableCapabilities: string[];

  constructor(options: {
    sourceId: string;
    requiredCapabilities: readonly string[];
    missingCapabilities: readonly string[];
    availableCapabilities: readonly string[];
  }) {
    super(`Catalog source "${options.sourceId}" requires unsupported AW capabilities: ${options.missingCapabilities.join(', ')}.`);
    this.name = 'CatalogProviderCompatibilityError';
    this.sourceId = options.sourceId;
    this.code = 'awCapabilityUnsupported';
    this.requiredCapabilities = [...options.requiredCapabilities];
    this.missingCapabilities = [...options.missingCapabilities];
    this.availableCapabilities = [...options.availableCapabilities];
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceRoot(message: string, root: string, replacement: string): string {
  const normalized = path.resolve(root);
  const variants = new Set([
    normalized,
    normalized.replaceAll('\\', '/'),
    ...(normalized.startsWith('/var/') ? [`/private${normalized}`] : []),
    ...(normalized.startsWith('/private/var/') ? [normalized.slice('/private'.length)] : []),
  ]);
  let output = message;
  for (const variant of variants) {
    output = output.replace(new RegExp(escapeRegExp(variant), 'g'), replacement);
  }
  return output;
}

export function sanitizeCatalogSourceErrorMessage(
  message: string,
  env: NodeJS.ProcessEnv = process.env,
  sensitiveRoots: readonly string[] = [],
): string {
  const awHome = path.resolve(resolveAwHome(env));
  let output = message;
  for (const root of sensitiveRoots) {
    if (root.trim() !== '') output = replaceRoot(output, root, '[catalog-source]');
  }
  for (const [root, replacement] of [
    [path.join(path.dirname(awHome), '.aw-local-marketplace-staging'), '[catalog-staging]'],
    [awHome, '[aw-state]'],
  ] as const) {
    output = replaceRoot(output, root, replacement);
  }
  for (const tempRoot of new Set([
    env.TMPDIR,
    env.TEMP,
    env.TMP,
    os.tmpdir(),
    '/private/tmp',
    '/tmp',
  ].filter((value): value is string => Boolean(value)))) {
    output = replaceRoot(output, tempRoot, '[temporary]');
  }
  return output.replace(
    /\.(?:materialize|path)-[^/\\\s"']+\.tmp/gu,
    '[catalog-materialization]',
  );
}

export function catalogSourceErrorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : DEFAULT_ERROR_CODE;
}

export function sanitizeCatalogSourceError(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
  sensitiveRoots: readonly string[] = [],
): Error & { code: string } {
  const original = error instanceof Error ? error : new Error(String(error));
  const sanitized = new Error(sanitizeCatalogSourceErrorMessage(original.message, env, sensitiveRoots), {
    ...(original.cause === undefined
      ? {}
      : { cause: sanitizeCatalogSourceError(original.cause, env, sensitiveRoots) }),
  }) as Error & { code: string };
  sanitized.name = original.name;
  sanitized.code = catalogSourceErrorCode(original);
  const sourceId = (original as { sourceId?: unknown }).sourceId;
  if (typeof sourceId === 'string') {
    (sanitized as Error & { sourceId?: string }).sourceId = sourceId;
  }
  if ('inventory' in original) {
    (sanitized as Error & { inventory?: unknown }).inventory = original.inventory;
  }
  if ('impact' in original) {
    (sanitized as Error & { impact?: unknown }).impact = original.impact;
  }
  type CapabilityField = 'requiredCapabilities' | 'missingCapabilities' | 'availableCapabilities';
  const originalCapabilities = original as Error & Partial<Record<CapabilityField, unknown>>;
  const sanitizedCapabilities = sanitized as Error & { code: string }
    & Partial<Record<CapabilityField, string[]>>;
  for (const field of [
    'requiredCapabilities',
    'missingCapabilities',
    'availableCapabilities',
  ] as const) {
    const value = originalCapabilities[field];
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      sanitizedCapabilities[field] = [...value];
    }
  }
  return sanitized;
}
