import path from 'node:path';

import fs from 'fs-extra';

import { CATALOG_STATE_FILE, CATALOG_STATE_SCHEMA_VERSION } from '../constants.js';
import type {
  CatalogGenerationActiveV1,
  CatalogGenerationLastSyncV1,
  CatalogGenerationStateFileV1,
  CatalogSourceGenerationStateV1,
} from '../types.js';
import { CatalogGenerationError } from './catalog-generation-error.js';
import { CATALOG_SOURCE_ID_PATTERN } from './catalog-sources.js';
import { atomicReplaceConfigFile } from './plugin-config.js';
import { resolveAwHome } from './state-paths.js';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|path:sha256:[0-9a-f]{64})$/u;

function stateError(message: string, cause?: unknown): CatalogGenerationError {
  return new CatalogGenerationError({
    code: 'catalogGenerationStateInvalid',
    message: `${message} Repair or remove catalog-state.json, then run aw catalog source sync. This state never authorizes plugin deletion.`,
    cause,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, name: string, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw stateError(`Invalid ${name}: unknown field "${unexpected}".`);
}

function parseDate(value: unknown, name: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw stateError(`Invalid ${name}: expected an ISO date.`);
  }
  return value;
}

function parseActive(value: unknown, name: string): CatalogGenerationActiveV1 {
  if (!isRecord(value)) throw stateError(`Invalid ${name}: expected an object.`);
  assertKeys(value, name, [
    'sourceConfigFingerprint', 'sourceIdentity', 'requestedRef', 'resolvedCommit',
    'logicalIdentity', 'manifestDigest', 'snapshotDigest', 'activatedAt',
  ]);
  if (
    typeof value.sourceConfigFingerprint !== 'string'
    || !DIGEST_PATTERN.test(value.sourceConfigFingerprint)
    || typeof value.sourceIdentity !== 'string'
    || !DIGEST_PATTERN.test(value.sourceIdentity)
    || typeof value.requestedRef !== 'string'
    || value.requestedRef.length === 0
    || typeof value.resolvedCommit !== 'string'
    || !COMMIT_PATTERN.test(value.resolvedCommit)
    || typeof value.logicalIdentity !== 'string'
    || value.logicalIdentity.trim() === ''
    || value.logicalIdentity !== value.logicalIdentity.trim()
    || typeof value.manifestDigest !== 'string'
    || !DIGEST_PATTERN.test(value.manifestDigest)
    || typeof value.snapshotDigest !== 'string'
    || !DIGEST_PATTERN.test(value.snapshotDigest)
  ) throw stateError(`Invalid ${name}.`);
  return {
    sourceConfigFingerprint: value.sourceConfigFingerprint,
    sourceIdentity: value.sourceIdentity,
    requestedRef: value.requestedRef,
    resolvedCommit: value.resolvedCommit,
    logicalIdentity: value.logicalIdentity,
    manifestDigest: value.manifestDigest,
    snapshotDigest: value.snapshotDigest,
    activatedAt: parseDate(value.activatedAt, `${name}.activatedAt`),
  };
}

function parseLastSync(value: unknown, name: string): CatalogGenerationLastSyncV1 {
  if (!isRecord(value)) throw stateError(`Invalid ${name}: expected an object.`);
  assertKeys(value, name, ['syncedAt', 'mode', 'state', 'resolvedCommit', 'errorCode']);
  if (
    (value.mode !== 'check' && value.mode !== 'sync')
    || (value.state !== 'succeeded' && value.state !== 'failed')
    || (value.resolvedCommit !== undefined
      && (typeof value.resolvedCommit !== 'string' || !COMMIT_PATTERN.test(value.resolvedCommit)))
    || (value.errorCode !== undefined
      && (typeof value.errorCode !== 'string' || value.errorCode.length === 0))
    || (value.state === 'succeeded' && value.errorCode !== undefined)
    || (value.state === 'failed' && value.errorCode === undefined)
  ) throw stateError(`Invalid ${name}.`);
  return {
    syncedAt: parseDate(value.syncedAt, `${name}.syncedAt`),
    mode: value.mode,
    state: value.state,
    ...(value.resolvedCommit === undefined ? {} : { resolvedCommit: value.resolvedCommit }),
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
  };
}

function parseSourceState(value: unknown, name: string): CatalogSourceGenerationStateV1 {
  if (!isRecord(value)) throw stateError(`Invalid ${name}: expected an object.`);
  assertKeys(value, name, ['active', 'lastSync']);
  const active = value.active === undefined ? undefined : parseActive(value.active, `${name}.active`);
  const lastSync = value.lastSync === undefined
    ? undefined
    : parseLastSync(value.lastSync, `${name}.lastSync`);
  return { ...(active ? { active } : {}), ...(lastSync ? { lastSync } : {}) };
}

export function validateCatalogGenerationState(value: unknown): CatalogGenerationStateFileV1 {
  if (!isRecord(value)) throw stateError('Invalid Catalog state: expected an object.');
  assertKeys(value, 'Catalog state', ['schemaVersion', 'sources']);
  if (value.schemaVersion !== CATALOG_STATE_SCHEMA_VERSION || !isRecord(value.sources)) {
    throw stateError('Invalid Catalog state schema.');
  }
  const sources: Record<string, CatalogSourceGenerationStateV1> = {};
  for (const sourceId of Object.keys(value.sources).sort()) {
    if (!CATALOG_SOURCE_ID_PATTERN.test(sourceId)) {
      throw stateError(`Invalid Catalog state source ID "${sourceId}".`);
    }
    sources[sourceId] = parseSourceState(value.sources[sourceId], `Catalog state.sources.${sourceId}`);
  }
  return { schemaVersion: 1, sources };
}

export function createEmptyCatalogGenerationState(): CatalogGenerationStateFileV1 {
  return { schemaVersion: 1, sources: {} };
}

export function resolveCatalogGenerationStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveAwHome(env), CATALOG_STATE_FILE);
}

async function readStateAt(filePath: string): Promise<CatalogGenerationStateFileV1> {
  const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return createEmptyCatalogGenerationState();
  if (!stat.isFile() || stat.isSymbolicLink()) throw stateError('Catalog state path is unsafe.');
  try {
    return validateCatalogGenerationState(await fs.readJson(filePath));
  } catch (error) {
    if (error instanceof CatalogGenerationError) throw error;
    throw stateError('Catalog state is unreadable.', error);
  }
}

export async function readCatalogGenerationState(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CatalogGenerationStateFileV1> {
  return readStateAt(resolveCatalogGenerationStatePath(env));
}

export async function withCatalogGenerationStateTransaction<T>(options: {
  env?: NodeJS.ProcessEnv;
  beforeReplace?: (next: CatalogGenerationStateFileV1) => Promise<void> | void;
  action: (current: CatalogGenerationStateFileV1) => Promise<{
    state: CatalogGenerationStateFileV1;
    result: T;
  }>;
}): Promise<T> {
  const env = options.env ?? process.env;
  const filePath = resolveCatalogGenerationStatePath(env);
  const current = await readStateAt(filePath);
  const output = await options.action(current);
  const next = validateCatalogGenerationState(output.state);
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    await options.beforeReplace?.(next);
    await atomicReplaceConfigFile({
      filePath,
      allowedRoot: resolveAwHome(env),
      content: `${JSON.stringify(next, null, 2)}\n`,
    });
  }
  return output.result;
}

export async function removeCatalogSourceGenerationState(options: {
  sourceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  return withCatalogGenerationStateTransaction({
    env: options.env,
    action: async (current) => {
      if (!current.sources[options.sourceId]) return { state: current, result: false };
      const sources = { ...current.sources };
      delete sources[options.sourceId];
      return { state: { schemaVersion: 1, sources }, result: true };
    },
  });
}
