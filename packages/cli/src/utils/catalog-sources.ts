import crypto from 'node:crypto';
import path from 'node:path';

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
  withConfigFileLock,
} from './plugin-config.js';
import { withActiveMarketplaceRuntimeLease } from './active-marketplace-runtime-lock.js';
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
    }
  | {
      type?: 'path';
      path?: string;
    };

export interface CatalogSourcesConfigSnapshot {
  config: CatalogSourcesConfig;
  digest: string;
  materialized: boolean;
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
  if (typeof input.primary !== 'boolean') {
    throw new Error(`Invalid ${fieldName}.primary: expected a boolean.`);
  }
  if (input.type === 'git') {
    assertAllowedKeys(input, fieldName, ['id', 'type', 'primary', 'url', 'refPolicy', 'subdir']);
    const subdir = normalizeSubdir(input.subdir, `${fieldName}.subdir`);
    if (typeof input.url !== 'string') {
      throw new Error(`Invalid ${fieldName}.url: expected a Git URL.`);
    }
    canonicalizeCatalogGitUrl(input.url);
    return {
      id,
      type: 'git',
      primary: input.primary,
      url: input.url,
      refPolicy: normalizeRefPolicy(input.refPolicy, `${fieldName}.refPolicy`),
      ...(subdir ? { subdir } : {}),
    };
  }
  if (input.type === 'path') {
    assertAllowedKeys(input, fieldName, ['id', 'type', 'primary', 'path']);
    if (
      typeof input.path !== 'string'
      || input.path.trim() === ''
      || !path.isAbsolute(input.path)
    ) {
      throw new Error(`Invalid ${fieldName}.path: expected a canonical absolute path.`);
    }
    return {
      id,
      type: 'path',
      primary: input.primary,
      path: input.path,
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

export function validateCatalogSourcesConfig(rawConfig: unknown): CatalogSourcesConfig {
  const input = assertObject(rawConfig, 'catalog sources config');
  assertAllowedKeys(input, 'catalog sources config', ['schemaVersion', 'sources']);
  if (input.schemaVersion !== CATALOG_SOURCES_SCHEMA_VERSION) {
    throw new Error('Invalid catalog sources config.schemaVersion: expected 1.');
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
  return { schemaVersion: 1, sources };
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
    schemaVersion: 1,
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
      ? ['type', 'url', 'refPolicy', 'subdir']
      : ['type', 'path'],
  );
  const subdirUpdate = 'subdir' in update ? update.subdir : undefined;
  const subdir = existing.type === 'git'
    ? subdirUpdate === null ? undefined : subdirUpdate ?? existing.subdir
    : undefined;
  const updatedPath = existing.type === 'path'
    ? await canonicalizeCatalogPath(
        'path' in update && update.path !== undefined ? update.path : existing.path,
        cwd,
      )
    : undefined;
  const candidate = existing.type === 'git'
    ? {
        ...existing,
        ...('url' in update && update.url !== undefined ? { url: update.url } : {}),
        ...('refPolicy' in update && update.refPolicy !== undefined
          ? { refPolicy: update.refPolicy }
          : {}),
        ...(subdir ? { subdir } : {}),
      }
    : {
        ...existing,
        ...(updatedPath ? { path: updatedPath } : {}),
      };
  if (candidate.type === 'git' && !subdir) delete candidate.subdir;
  return validateCatalogSourcesConfig({
    schemaVersion: 1,
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
    schemaVersion: 1,
    sources: current.sources.map((source) => ({
      ...source,
      primary: source.id === sourceId,
    })),
  });
}

export function removeCatalogSource(
  config: CatalogSourcesConfig,
  sourceId: CatalogSourceId,
): CatalogSourcesConfig {
  const current = validateCatalogSourcesConfig(config);
  const source = current.sources.find((entry) => entry.id === sourceId);
  if (!source) throw new Error(`Catalog source "${sourceId}" does not exist.`);
  if (current.sources.length === 1) throw new Error('The last catalog source cannot be removed.');
  if (source.primary) throw new Error('The primary catalog source cannot be removed.');
  return validateCatalogSourcesConfig({
    schemaVersion: 1,
    sources: current.sources.filter((entry) => entry.id !== sourceId),
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
  if (!(await fs.pathExists(filePath))) {
    const config = createDefaultCatalogSourcesConfig();
    return {
      config,
      digest: calculateCatalogSourcesConfigDigest(config),
      materialized: false,
    };
  }
  const config = validateCatalogSourcesConfig(await fs.readJson(filePath));
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
  await withActiveMarketplaceRuntimeLease(env, () => withConfigFileLock({
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
  }));
  return { config, digest, materialized: true };
}
