import crypto from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import fs from 'fs-extra';

import {
  CATALOG_BETA_REF,
  CATALOG_LATEST_REF,
  CATALOG_SOURCES_FILE,
  CATALOG_SOURCES_SCHEMA_VERSION,
  OFFICIAL_CATALOG_SOURCE_URL,
} from '../constants.js';
import type {
  CatalogGitRefPolicy,
  CatalogSource,
  CatalogSourceId,
  CatalogSourcesConfig,
  CliVersion,
} from '../types.js';
import {
  canonicalizeCatalogGitUrl,
  canonicalizeCatalogPath,
} from './catalog-source-identity.js';
import { parseStrictSemVer } from './manifest.js';
import {
  atomicReplaceConfigFile,
  withConfigFileMutation,
} from './plugin-config.js';
import { CatalogGenerationError } from './catalog-generation-error.js';
import {
  withAwHomeMutationLock,
  type AwHomeMutationToken,
} from './aw-home-mutation-lock.js';
import {
  assertRealFileParentWithinRoot,
  assertSafeFileMutationPath,
} from './safe-fs.js';
import { resolveAwHome } from './state-paths.js';

export const CATALOG_SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export type {
  CatalogGitRefPolicy,
  CatalogSource,
  CatalogSourcesConfig,
} from '../types.js';

export type CatalogSourceUpdate =
  | {
      type?: 'git';
      url?: string;
      refPolicy?: CatalogGitRefPolicy;
      subdir?: string | null;
      autoCheck?: boolean;
    }
  | {
      type?: 'path';
      path?: string;
      autoCheck?: boolean;
    };

export interface CatalogSourcesConfigSnapshot {
  config: CatalogSourcesConfig;
  digest: string;
  materialized: boolean;
}

export interface CatalogSourcesConfigRecoveryResult {
  snapshot: CatalogSourcesConfigSnapshot;
  backupPath: string;
}

let catalogSourcesBackupBeforeOpenHookForTests:
  | ((backupPath: string) => Promise<void>)
  | undefined;

export function setCatalogSourcesBackupBeforeOpenHookForTests(
  hook: ((backupPath: string) => Promise<void>) | undefined,
): void {
  catalogSourcesBackupBeforeOpenHookForTests = hook;
}

export class CatalogSourcesConfigConflictError extends Error {
  readonly expectedDigest: string;
  readonly actualDigest: string;

  constructor(expectedDigest: string, actualDigest: string) {
    super('Catalog sources config changed after it was read.');
    this.name = 'CatalogSourcesConfigConflictError';
    this.expectedDigest = expectedDigest;
    this.actualDigest = actualDigest;
  }
}

function assertObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  fieldName: string,
  allowedKeys: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`Invalid ${fieldName}: unknown field "${key}".`);
    }
  }
}

function normalizeSourceId(value: unknown, fieldName: string): CatalogSourceId {
  if (typeof value !== 'string' || !CATALOG_SOURCE_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected ${CATALOG_SOURCE_ID_PATTERN}.`);
  }
  return value;
}

function normalizeSubdir(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\\')) {
    throw new Error(`Invalid ${fieldName}: expected a relative POSIX path.`);
  }
  const normalized = path.posix.normalize(value);
  if (
    path.posix.isAbsolute(value)
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    throw new Error(`Invalid ${fieldName}: path must stay inside the catalog source.`);
  }
  return normalized.replace(/^\.\//, '').replace(/\/$/, '');
}

function normalizeAutoCheck(value: unknown, fieldName: string): false | undefined {
  if (value === undefined || value === true) return undefined;
  if (value !== false) {
    throw new Error(`Invalid ${fieldName}: expected a boolean.`);
  }
  return false;
}

export function isCatalogSourceAutoCheckEnabled(source: CatalogSource): boolean {
  return source.autoCheck !== false;
}

function normalizeRefPolicy(value: unknown, fieldName: string): CatalogGitRefPolicy {
  const input = assertObject(value, fieldName);
  if (input.type === 'cliChannel') {
    assertAllowedKeys(input, fieldName, ['type']);
    return { type: 'cliChannel' };
  }
  if (input.type !== 'explicit') {
    throw new Error(`Invalid ${fieldName}.type: expected "explicit" or "cliChannel".`);
  }
  assertAllowedKeys(input, fieldName, ['type', 'ref']);
  if (
    typeof input.ref !== 'string'
    || input.ref.trim() === ''
    || input.ref !== input.ref.trim()
    || /[\s\u0000-\u001f\u007f]/.test(input.ref)
  ) {
    throw new Error(`Invalid ${fieldName}.ref: expected a non-empty Git ref.`);
  }
  return { type: 'explicit', ref: input.ref };
}

function normalizeSource(value: unknown, fieldName: string): CatalogSource {
  const input = assertObject(value, fieldName);
  const id = normalizeSourceId(input.id, `${fieldName}.id`);
  const autoCheck = normalizeAutoCheck(input.autoCheck, `${fieldName}.autoCheck`);
  if (typeof input.primary !== 'boolean') {
    throw new Error(`Invalid ${fieldName}.primary: expected a boolean.`);
  }
  if (input.type === 'git') {
    assertAllowedKeys(input, fieldName, ['id', 'type', 'primary', 'autoCheck', 'url', 'refPolicy', 'subdir']);
    const subdir = normalizeSubdir(input.subdir, `${fieldName}.subdir`);
    if (typeof input.url !== 'string') {
      throw new Error(`Invalid ${fieldName}.url: expected a Git URL.`);
    }
    canonicalizeCatalogGitUrl(input.url);
    return {
      id,
      type: 'git',
      primary: input.primary,
      ...(autoCheck === false ? { autoCheck } : {}),
      url: input.url,
      refPolicy: normalizeRefPolicy(input.refPolicy, `${fieldName}.refPolicy`),
      ...(subdir ? { subdir } : {}),
    };
  }
  if (input.type === 'path') {
    assertAllowedKeys(input, fieldName, ['id', 'type', 'primary', 'autoCheck', 'path', 'managedBy']);
    if (
      typeof input.path !== 'string'
      || input.path.trim() === ''
      || !path.isAbsolute(input.path)
    ) {
      throw new Error(`Invalid ${fieldName}.path: expected a canonical absolute path.`);
    }
    let managedBy: { kind: 'catalog-workspace'; workspaceIdentity: string } | undefined;
    if (input.managedBy !== undefined) {
      const owner = assertObject(input.managedBy, `${fieldName}.managedBy`);
      assertAllowedKeys(owner, `${fieldName}.managedBy`, ['kind', 'workspaceIdentity']);
      if (owner.kind !== 'catalog-workspace') {
        throw new Error(`Invalid ${fieldName}.managedBy.kind: expected "catalog-workspace".`);
      }
      if (
        typeof owner.workspaceIdentity !== 'string'
        || owner.workspaceIdentity.trim() === ''
        || owner.workspaceIdentity !== owner.workspaceIdentity.trim()
      ) {
        throw new Error(`Invalid ${fieldName}.managedBy.workspaceIdentity: expected a non-empty string.`);
      }
      managedBy = { kind: 'catalog-workspace', workspaceIdentity: owner.workspaceIdentity };
    }
    return {
      id,
      type: 'path',
      primary: input.primary,
      ...(autoCheck === false ? { autoCheck } : {}),
      path: input.path,
      ...(managedBy ? { managedBy } : {}),
    };
  }
  throw new Error(`Invalid ${fieldName}.type: expected "git" or "path".`);
}

export function createDefaultCatalogSourcesConfig(): CatalogSourcesConfig {
  return {
    schemaVersion: CATALOG_SOURCES_SCHEMA_VERSION,
    sources: [{
      id: 'official',
      type: 'git',
      primary: true,
      url: OFFICIAL_CATALOG_SOURCE_URL,
      refPolicy: { type: 'cliChannel' },
    }],
  };
}

export function isDefaultOfficialCatalogSource(source: CatalogSource): boolean {
  const official = createDefaultCatalogSourcesConfig().sources[0]!;
  const normalized = normalizeSource(
    { ...source, primary: official.primary },
    'catalog source',
  );
  return isDeepStrictEqual(normalized, official);
}

export function validateCatalogSourcesConfig(rawConfig: unknown): CatalogSourcesConfig {
  const input = assertObject(rawConfig, 'catalog sources config');
  assertAllowedKeys(input, 'catalog sources config', ['schemaVersion', 'sources']);
  if (input.schemaVersion !== CATALOG_SOURCES_SCHEMA_VERSION) {
    throw new Error('Invalid catalog sources config.schemaVersion: expected 2.');
  }
  if (!Array.isArray(input.sources) || input.sources.length === 0) {
    throw new Error('Invalid catalog sources config.sources: expected at least one source.');
  }
  const sources = input.sources
    .map((source, index) => normalizeSource(source, `catalog sources config.sources[${index}]`))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (new Set(sources.map((source) => source.id)).size !== sources.length) {
    throw new Error('Invalid catalog sources config.sources: source IDs must be unique.');
  }
  if (sources.filter((source) => source.primary).length !== 1) {
    throw new Error('Invalid catalog sources config.sources: expected exactly one primary source.');
  }
  return { schemaVersion: 2, sources };
}

export function resolveCatalogSourceRef(
  policy: CatalogGitRefPolicy,
  cliVersion: CliVersion,
): string {
  const normalized = normalizeRefPolicy(policy, 'catalog source refPolicy');
  if (normalized.type === 'explicit') return normalized.ref;
  const version = parseStrictSemVer(cliVersion, 'cliVersion');
  return version.prerelease.length > 0 ? CATALOG_BETA_REF : CATALOG_LATEST_REF;
}

export async function addCatalogSource(
  config: CatalogSourcesConfig,
  source: CatalogSource,
  cwd: string,
): Promise<CatalogSourcesConfig> {
  const current = validateCatalogSourcesConfig(config);
  const candidate = normalizeSource(
    source.type === 'path'
      ? { ...source, path: await canonicalizeCatalogPath(source.path, cwd) }
      : source,
    'catalog source',
  );
  if (current.sources.some((entry) => entry.id === candidate.id)) {
    throw new Error(`Catalog source "${candidate.id}" already exists.`);
  }
  return validateCatalogSourcesConfig({
    schemaVersion: 2,
    sources: [
      ...current.sources.map((entry) => candidate.primary ? { ...entry, primary: false } : entry),
      candidate,
    ],
  });
}

export async function updateCatalogSource(
  config: CatalogSourcesConfig,
  sourceId: CatalogSourceId,
  update: CatalogSourceUpdate,
  cwd: string,
): Promise<CatalogSourcesConfig> {
  const current = validateCatalogSourcesConfig(config);
  const index = current.sources.findIndex((source) => source.id === sourceId);
  if (index < 0) throw new Error(`Catalog source "${sourceId}" does not exist.`);
  const existing = current.sources[index]!;
  const updateInput = assertObject(update, 'catalog source update');
  if (updateInput.type !== undefined && updateInput.type !== existing.type) {
    throw new Error('Catalog source type cannot be changed.');
  }
  assertAllowedKeys(
    updateInput,
    'catalog source update',
    existing.type === 'git'
      ? ['type', 'url', 'refPolicy', 'subdir', 'autoCheck']
      : ['type', 'path', 'autoCheck'],
  );
  const subdirUpdate = 'subdir' in update ? update.subdir : undefined;
  const subdir = existing.type === 'git'
    ? subdirUpdate === null ? undefined : subdirUpdate ?? existing.subdir
    : undefined;
  const updatedPath = existing.type === 'path'
    && 'path' in update
    && update.path !== undefined
    ? await canonicalizeCatalogPath(update.path, cwd)
    : undefined;
  const autoCheck = update.autoCheck === undefined
    ? existing.autoCheck
    : normalizeAutoCheck(update.autoCheck, 'catalog source update.autoCheck');
  const candidate = existing.type === 'git'
    ? {
        ...existing,
        ...(autoCheck === false ? { autoCheck } : {}),
        ...('url' in update && update.url !== undefined ? { url: update.url } : {}),
        ...('refPolicy' in update && update.refPolicy !== undefined
          ? { refPolicy: update.refPolicy }
          : {}),
        ...(subdir ? { subdir } : {}),
      }
    : {
        ...existing,
        ...(autoCheck === false ? { autoCheck } : {}),
        ...(updatedPath ? { path: updatedPath } : {}),
      };
  if (autoCheck === undefined) delete candidate.autoCheck;
  if (candidate.type === 'git' && !subdir) delete candidate.subdir;
  return validateCatalogSourcesConfig({
    schemaVersion: 2,
    sources: current.sources.map((source, sourceIndex) => sourceIndex === index ? candidate : source),
  });
}

export function setPrimaryCatalogSource(
  config: CatalogSourcesConfig,
  sourceId: CatalogSourceId,
): CatalogSourcesConfig {
  const current = validateCatalogSourcesConfig(config);
  if (!current.sources.some((source) => source.id === sourceId)) {
    throw new Error(`Catalog source "${sourceId}" does not exist.`);
  }
  return validateCatalogSourcesConfig({
    schemaVersion: 2,
    sources: current.sources.map((source) => ({
      ...source,
      primary: source.id === sourceId,
    })),
  });
}

export function removeCatalogSource(
  config: CatalogSourcesConfig,
  sourceId: CatalogSourceId,
  replacementPrimarySourceId?: CatalogSourceId,
): CatalogSourcesConfig {
  const current = validateCatalogSourcesConfig(config);
  const source = current.sources.find((entry) => entry.id === sourceId);
  if (!source) throw new Error(`Catalog source "${sourceId}" does not exist.`);
  if (current.sources.length === 1) throw new Error('The last catalog source cannot be removed.');
  if (!source.primary && replacementPrimarySourceId !== undefined) {
    throw new Error('A replacement primary source is only valid when removing the primary source.');
  }
  if (source.primary && replacementPrimarySourceId === undefined) {
    throw new Error('The primary catalog source cannot be removed.');
  }
  if (replacementPrimarySourceId === sourceId) {
    throw new Error('The replacement primary source must be another catalog source.');
  }
  if (replacementPrimarySourceId !== undefined
    && !current.sources.some((entry) => entry.id === replacementPrimarySourceId)) {
    throw new Error(`Catalog source "${replacementPrimarySourceId}" does not exist.`);
  }
  return validateCatalogSourcesConfig({
    schemaVersion: 2,
    sources: current.sources
      .filter((entry) => entry.id !== sourceId)
      .map((entry) => replacementPrimarySourceId === undefined ? entry : {
        ...entry,
        primary: entry.id === replacementPrimarySourceId,
      }),
  });
}

export function calculateCatalogSourcesConfigDigest(config: CatalogSourcesConfig): string {
  const normalized = validateCatalogSourcesConfig(config);
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}

export function resolveCatalogSourcesConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveAwHome(env), CATALOG_SOURCES_FILE);
}

async function readConfigAt(filePath: string): Promise<CatalogSourcesConfigSnapshot> {
  let rawConfig: unknown;
  try {
    rawConfig = await fs.readJson(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const config = createDefaultCatalogSourcesConfig();
      return {
        config,
        digest: calculateCatalogSourcesConfigDigest(config),
        materialized: false,
      };
    }
    throw new CatalogGenerationError({
      code: 'catalogSourcesConfigInvalid',
      message: 'Catalog sources config is unreadable or invalid. Repair or remove catalog-sources.json, then run aw catalog source sync.',
      cause: error,
    });
  }
  let config: CatalogSourcesConfig;
  try {
    config = validateCatalogSourcesConfig(rawConfig);
  } catch (error) {
    throw new CatalogGenerationError({
      code: 'catalogSourcesConfigInvalid',
      message: 'Catalog sources config is unreadable or invalid. Repair or remove catalog-sources.json, then run aw catalog source sync.',
      cause: error,
    });
  }
  return {
    config,
    digest: calculateCatalogSourcesConfigDigest(config),
    materialized: true,
  };
}

export async function readCatalogSourcesConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CatalogSourcesConfig> {
  return (await readConfigAt(resolveCatalogSourcesConfigPath(env))).config;
}

export async function readCatalogSourcesConfigSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CatalogSourcesConfigSnapshot> {
  return readConfigAt(resolveCatalogSourcesConfigPath(env));
}

export async function replaceCatalogSourcesConfig(options: {
  config: CatalogSourcesConfig;
  expectedDigest: string;
  env?: NodeJS.ProcessEnv;
  beforeReplace?: (current: CatalogSourcesConfigSnapshot) => Promise<void> | void;
}): Promise<CatalogSourcesConfigSnapshot> {
  const env = options.env ?? process.env;
  const awHome = resolveAwHome(env);
  const filePath = resolveCatalogSourcesConfigPath(env);
  const config = validateCatalogSourcesConfig(options.config);
  const digest = calculateCatalogSourcesConfigDigest(config);
  await withConfigFileMutation({
    filePath,
    allowedRoot: awHome,
    action: async () => {
      const current = await readConfigAt(filePath);
      if (current.digest !== options.expectedDigest) {
        throw new CatalogSourcesConfigConflictError(options.expectedDigest, current.digest);
      }
      await options.beforeReplace?.(current);
      await atomicReplaceConfigFile({
        filePath,
        allowedRoot: awHome,
        content: `${JSON.stringify(config, null, 2)}\n`,
      });
    },
  });
  return { config, digest, materialized: true };
}

function catalogSourcesRecoveryStale(): CatalogGenerationError {
  return new CatalogGenerationError({
    code: 'catalogSourcesConfigRecoveryStale',
    message: 'Catalog sources config recovery is stale because the config is missing or valid.',
  });
}

function catalogSourcesRecoveryFailed(cause: unknown): CatalogGenerationError {
  return new CatalogGenerationError({
    code: 'catalogSourcesConfigRecoveryFailed',
    message: 'Catalog sources config recovery failed. The invalid config was not replaced.',
    cause,
  });
}

function createBrokenCatalogSourcesBackupName(): string {
  const utc = new Date().toISOString().replace(/[-:.]/gu, '');
  return `${CATALOG_SOURCES_FILE}.broken-${utc}-${crypto.randomUUID()}`;
}

export async function recoverInvalidCatalogSourcesConfig(options: {
  env?: NodeJS.ProcessEnv;
  awHomeMutationToken?: AwHomeMutationToken;
} = {}): Promise<CatalogSourcesConfigRecoveryResult> {
  const env = options.env ?? process.env;
  return withAwHomeMutationLock({
    env,
    token: options.awHomeMutationToken,
    action: async () => {
      const awHome = resolveAwHome(env);
      const filePath = resolveCatalogSourcesConfigPath(env);
      try {
        return await withConfigFileMutation({
          filePath,
          allowedRoot: awHome,
          action: async () => {
            let target: Awaited<ReturnType<typeof nodeFs.lstat>>;
            try {
              target = await nodeFs.lstat(filePath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                throw catalogSourcesRecoveryStale();
              }
              throw error;
            }
            if (target.isSymbolicLink() || !target.isFile()) {
              throw new Error('Catalog sources config recovery target must be a regular file.');
            }
            const originalBytes = await nodeFs.readFile(filePath);
            try {
              validateCatalogSourcesConfig(JSON.parse(originalBytes.toString('utf8')));
              throw catalogSourcesRecoveryStale();
            } catch (error) {
              if (error instanceof CatalogGenerationError) throw error;
            }

            const backupName = createBrokenCatalogSourcesBackupName();
            const backupPath = path.join(awHome, backupName);
            await assertSafeFileMutationPath({
              filePath: backupPath,
              allowedRoot: awHome,
              label: 'Catalog sources config backup',
            });
            await assertRealFileParentWithinRoot({
              filePath: backupPath,
              allowedRoot: awHome,
              label: 'Catalog sources config backup',
            });
            await catalogSourcesBackupBeforeOpenHookForTests?.(backupPath);
            const backupHandle = await nodeFs.open(backupPath, 'wx', 0o600);
            try {
              await backupHandle.writeFile(originalBytes);
            } finally {
              await backupHandle.close();
            }

            const config = createDefaultCatalogSourcesConfig();
            await atomicReplaceConfigFile({
              filePath,
              allowedRoot: awHome,
              content: `${JSON.stringify(config, null, 2)}\n`,
            });
            return {
              snapshot: {
                config,
                digest: calculateCatalogSourcesConfigDigest(config),
                materialized: true,
              },
              backupPath: backupName,
            };
          },
        });
      } catch (error) {
        if (error instanceof CatalogGenerationError) throw error;
        throw catalogSourcesRecoveryFailed(error);
      }
    },
  });
}
