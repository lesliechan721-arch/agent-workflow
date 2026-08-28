import path from 'node:path';

import fs from 'fs-extra';

import {
  CATALOG_GENERATIONS_FILE,
  CATALOG_GENERATIONS_SCHEMA_VERSION,
} from '../constants.js';
import type {
  CatalogGenerationCandidateV1,
  CatalogGenerationLastCheckV1,
  CatalogGenerationPointerV1,
  CatalogGenerationStateFileV1,
  CatalogSourceGenerationStateV1,
} from '../types.js';
import { CatalogGenerationError } from './catalog-generation-error.js';
import { createCatalogGenerationKey } from './catalog-generation-store.js';
import { CATALOG_SOURCE_ID_PATTERN } from './catalog-sources.js';
import { parseStrictSemVer } from './manifest.js';
import { atomicReplaceConfigFile, withConfigFileLock } from './plugin-config.js';
import { resolveAwHome } from './state-paths.js';

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RESOLVED_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|path:sha256:[0-9a-f]{64})$/u;

function stateError(message: string, cause?: unknown): CatalogGenerationError {
  return new CatalogGenerationError({
    code: 'catalogGenerationStateInvalid',
    message: `${message} Repair or remove catalog-generations.json, then refresh configured sources. This state never authorizes plugin deletion.`,
    cause,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  fieldName: string,
  allowed: readonly string[],
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw stateError(`Invalid ${fieldName}: unknown field "${unexpected}".`);
}

function parseDate(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw stateError(`Invalid ${fieldName}: expected an ISO date.`);
  }
  return value;
}

function parsePointer(
  value: unknown,
  fieldName: string,
  candidate: false,
): CatalogGenerationPointerV1;
function parsePointer(
  value: unknown,
  fieldName: string,
  candidate: true,
): CatalogGenerationCandidateV1;
function parsePointer(
  value: unknown,
  fieldName: string,
  candidate: boolean,
): CatalogGenerationPointerV1 | CatalogGenerationCandidateV1 {
  if (!isRecord(value)) throw stateError(`Invalid ${fieldName}: expected an object.`);
  const baseKeys = [
    'sourceConfigFingerprint', 'catalogVersion', 'channel', 'requestedRef', 'resolvedCommit', 'manifestDigest',
    'snapshotDigest', 'generationKey', 'activatedAt',
  ];
  assertAllowedKeys(
    value,
    fieldName,
    candidate ? [...baseKeys, 'candidateKind', 'downloadedAt'] : baseKeys,
  );
  if (
    typeof value.sourceConfigFingerprint !== 'string'
    || !SHA256_DIGEST_PATTERN.test(value.sourceConfigFingerprint)
    || typeof value.catalogVersion !== 'string'
    || (value.channel !== 'latest' && value.channel !== 'beta')
    || typeof value.requestedRef !== 'string'
    || value.requestedRef.length === 0
    || typeof value.resolvedCommit !== 'string'
    || !RESOLVED_COMMIT_PATTERN.test(value.resolvedCommit)
    || typeof value.manifestDigest !== 'string'
    || !SHA256_DIGEST_PATTERN.test(value.manifestDigest)
    || typeof value.snapshotDigest !== 'string'
    || !SHA256_DIGEST_PATTERN.test(value.snapshotDigest)
    || typeof value.generationKey !== 'string'
    || !/^[0-9a-f]{64}\/[0-9a-f]{64}$/u.test(value.generationKey)
  ) throw stateError(`Invalid ${fieldName}.`);
  try {
    parseStrictSemVer(value.catalogVersion, `${fieldName}.catalogVersion`);
  } catch (error) {
    throw stateError(`Invalid ${fieldName}.catalogVersion.`, error);
  }
  const pointer: CatalogGenerationPointerV1 = {
    sourceConfigFingerprint: value.sourceConfigFingerprint,
    catalogVersion: value.catalogVersion,
    channel: value.channel,
    requestedRef: value.requestedRef,
    resolvedCommit: value.resolvedCommit,
    manifestDigest: value.manifestDigest,
    snapshotDigest: value.snapshotDigest,
    generationKey: value.generationKey,
    ...(value.activatedAt === undefined
      ? {}
      : { activatedAt: parseDate(value.activatedAt, `${fieldName}.activatedAt`) }),
  };
  if (!candidate) return pointer;
  if (
    (value.candidateKind !== 'upgrade' && value.candidateKind !== 'refChange')
    || value.activatedAt !== undefined
  ) throw stateError(`Invalid ${fieldName} candidate fields.`);
  return {
    ...pointer,
    candidateKind: value.candidateKind,
    downloadedAt: parseDate(value.downloadedAt, `${fieldName}.downloadedAt`),
  };
}

function parseLastCheck(value: unknown, fieldName: string): CatalogGenerationLastCheckV1 {
  if (!isRecord(value)) throw stateError(`Invalid ${fieldName}: expected an object.`);
  assertAllowedKeys(value, fieldName, ['checkedAt', 'state', 'remoteCommit', 'errorCode']);
  const states = new Set([
    'upToDate', 'activeReady', 'candidateReady', 'failed',
    'immutableViolation', 'channelRollback',
  ]);
  if (
    typeof value.state !== 'string'
    || !states.has(value.state)
    || (value.remoteCommit !== undefined
      && (typeof value.remoteCommit !== 'string'
        || !RESOLVED_COMMIT_PATTERN.test(value.remoteCommit)))
    || (value.errorCode !== undefined
      && (typeof value.errorCode !== 'string' || value.errorCode.length === 0))
  ) throw stateError(`Invalid ${fieldName}.`);
  return {
    checkedAt: parseDate(value.checkedAt, `${fieldName}.checkedAt`),
    state: value.state as CatalogGenerationLastCheckV1['state'],
    ...(value.remoteCommit ? { remoteCommit: value.remoteCommit } : {}),
    ...(value.errorCode ? { errorCode: value.errorCode } : {}),
  };
}

function parseSourceState(value: unknown, fieldName: string): CatalogSourceGenerationStateV1 {
  if (!isRecord(value)) throw stateError(`Invalid ${fieldName}: expected an object.`);
  assertAllowedKeys(value, fieldName, [
    'logicalIdentity', 'refreshPolicy', 'active', 'candidate', 'lastCheck',
  ]);
  if (
    typeof value.logicalIdentity !== 'string'
    || value.logicalIdentity.trim() === ''
    || (value.refreshPolicy !== 'startup' && value.refreshPolicy !== 'manual')
  ) throw stateError(`Invalid ${fieldName} identity or refresh policy.`);
  const active = value.active === undefined
    ? undefined
    : parsePointer(value.active, `${fieldName}.active`, false);
  const candidate = value.candidate === undefined
    ? undefined
    : parsePointer(value.candidate, `${fieldName}.candidate`, true);
  for (const [pointerName, pointer] of [['active', active], ['candidate', candidate]] as const) {
    if (pointer && pointer.generationKey !== createCatalogGenerationKey(
      value.logicalIdentity,
      pointer.snapshotDigest,
    )) throw stateError(`Invalid ${fieldName}.${pointerName} generation identity.`);
  }
  return {
    logicalIdentity: value.logicalIdentity,
    refreshPolicy: value.refreshPolicy,
    ...(active ? { active } : {}),
    ...(candidate ? { candidate } : {}),
    ...(value.lastCheck === undefined
      ? {}
      : { lastCheck: parseLastCheck(value.lastCheck, `${fieldName}.lastCheck`) }),
  };
}

export function validateCatalogGenerationState(
  value: unknown,
): CatalogGenerationStateFileV1 {
  if (!isRecord(value)) throw stateError('Invalid Catalog generation state: expected an object.');
  assertAllowedKeys(value, 'Catalog generation state', ['schemaVersion', 'sources']);
  if (value.schemaVersion !== CATALOG_GENERATIONS_SCHEMA_VERSION || !isRecord(value.sources)) {
    throw stateError('Invalid Catalog generation state schema.');
  }
  const sources: Record<string, CatalogSourceGenerationStateV1> = {};
  for (const sourceId of Object.keys(value.sources).sort()) {
    if (!CATALOG_SOURCE_ID_PATTERN.test(sourceId)) {
      throw stateError(`Invalid Catalog generation source ID "${sourceId}".`);
    }
    sources[sourceId] = parseSourceState(
      value.sources[sourceId],
      `Catalog generation state.sources.${sourceId}`,
    );
  }
  return { schemaVersion: 1, sources };
}

export function createEmptyCatalogGenerationState(): CatalogGenerationStateFileV1 {
  return { schemaVersion: 1, sources: {} };
}

export function resolveCatalogGenerationStatePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveAwHome(env), CATALOG_GENERATIONS_FILE);
}

async function readStateAt(filePath: string): Promise<CatalogGenerationStateFileV1> {
  const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return createEmptyCatalogGenerationState();
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw stateError('Catalog generation state path is not a regular file.');
  }
  try {
    return validateCatalogGenerationState(await fs.readJson(filePath));
  } catch (error) {
    if (error instanceof CatalogGenerationError) throw error;
    throw stateError('Catalog generation state is unreadable.', error);
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
  action: (
    current: CatalogGenerationStateFileV1,
  ) => Promise<{ state: CatalogGenerationStateFileV1; result: T }>;
}): Promise<T> {
  const env = options.env ?? process.env;
  const awHome = resolveAwHome(env);
  const filePath = resolveCatalogGenerationStatePath(env);
  return withConfigFileLock({
    filePath,
    allowedRoot: awHome,
    action: async () => {
      const current = await readStateAt(filePath);
      const output = await options.action(current);
      const next = validateCatalogGenerationState(output.state);
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        await options.beforeReplace?.(next);
        await atomicReplaceConfigFile({
          filePath,
          allowedRoot: awHome,
          content: `${JSON.stringify(next, null, 2)}\n`,
        });
      }
      return output.result;
    },
  });
}
