import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

export interface CatalogPublicationDescriptor {
  schemaVersion: 1;
  workspaceIdentity: string;
  sourceHead: string;
  remote: {
    name: string | null;
    identityDigest: string;
  };
  branch: string;
  parent: string | null;
  tag: string;
  snapshotDigest: string;
}

export interface CatalogPublicationDisplayMetadata {
  catalogVersion: string;
  channel: 'latest' | 'beta';
  pluginCount: number;
}

interface CatalogPublicationJournalBase {
  schemaVersion: 1;
  planDigest: string;
  descriptor: CatalogPublicationDescriptor;
  expectedCommit: string;
  repository: string | null;
  display: CatalogPublicationDisplayMetadata;
  preparedAt: string;
}

export interface CatalogPublicationPreparedJournal extends CatalogPublicationJournalBase {
  state: 'prepared';
}

export interface CatalogPublicationUncertainJournal extends CatalogPublicationJournalBase {
  state: 'uncertain';
  uncertainAt: string;
}

export interface CatalogPublicationPublishedJournal extends CatalogPublicationJournalBase {
  state: 'published';
  repository: null;
  publishedAt: string;
}

export type CatalogPublicationJournal =
  | CatalogPublicationPreparedJournal
  | CatalogPublicationUncertainJournal
  | CatalogPublicationPublishedJournal;

function digest(value: string | Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function catalogPublicationPlanDigest(descriptor: CatalogPublicationDescriptor): string {
  return digest(canonicalJson(descriptor));
}

export function catalogPublicationJournalPath(workspaceRoot: string, catalogVersion: string): string {
  return path.join(workspaceRoot, '.aw', 'publish', `${catalogVersion}.json`);
}

export function catalogPublicationRepositoryName(catalogVersion: string): string {
  return `${catalogVersion}.repo`;
}

export function catalogPublicationRepositoryPath(workspaceRoot: string, catalogVersion: string): string {
  return path.join(workspaceRoot, '.aw', 'publish', catalogPublicationRepositoryName(catalogVersion));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/u.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function isCatalogPublicationDescriptor(value: unknown): value is CatalogPublicationDescriptor {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'workspaceIdentity', 'sourceHead', 'remote', 'branch', 'parent', 'tag',
    'snapshotDigest',
  ])) return false;
  if (!isRecord(value.remote) || !hasExactKeys(value.remote, ['name', 'identityDigest'])) return false;
  return value.schemaVersion === 1
    && typeof value.workspaceIdentity === 'string'
    && value.workspaceIdentity !== ''
    && isCommit(value.sourceHead)
    && (value.remote.name === null || (typeof value.remote.name === 'string' && value.remote.name !== ''))
    && isDigest(value.remote.identityDigest)
    && typeof value.branch === 'string'
    && value.branch !== ''
    && (value.parent === null || isCommit(value.parent))
    && typeof value.tag === 'string'
    && /^catalog-v\d+\.\d+\.\d+(?:-beta\.\d+)?$/u.test(value.tag)
    && isDigest(value.snapshotDigest);
}

function isDisplayMetadata(value: unknown): value is CatalogPublicationDisplayMetadata {
  return isRecord(value)
    && hasExactKeys(value, ['catalogVersion', 'channel', 'pluginCount'])
    && typeof value.catalogVersion === 'string'
    && (value.channel === 'latest' || value.channel === 'beta')
    && Number.isSafeInteger(value.pluginCount)
    && (value.pluginCount as number) >= 0;
}

export function parseCatalogPublicationJournal(
  value: unknown,
  catalogVersion: string,
): CatalogPublicationJournal {
  if (!isRecord(value) || !isCatalogPublicationDescriptor(value.descriptor)) {
    throw new Error(`Catalog ${catalogVersion} publication journal is damaged. Increase the Catalog version.`);
  }
  const commonValid = value.schemaVersion === 1
    && isDigest(value.planDigest)
    && value.planDigest === catalogPublicationPlanDigest(value.descriptor)
    && isCommit(value.expectedCommit)
    && (value.repository === null || typeof value.repository === 'string')
    && isDisplayMetadata(value.display)
    && value.display.catalogVersion === catalogVersion
    && value.descriptor.tag === `catalog-v${catalogVersion}`
    && isTimestamp(value.preparedAt);
  const commonKeys = [
    'schemaVersion', 'state', 'planDigest', 'descriptor', 'expectedCommit', 'repository', 'display',
    'preparedAt',
  ];
  let shapeValid = false;
  if (value.state === 'prepared') {
    shapeValid = hasExactKeys(value, commonKeys);
  } else if (value.state === 'uncertain') {
    shapeValid = hasExactKeys(value, [...commonKeys, 'uncertainAt']) && isTimestamp(value.uncertainAt);
  } else if (value.state === 'published') {
    shapeValid = hasExactKeys(value, [...commonKeys, 'publishedAt'])
      && value.repository === null
      && isTimestamp(value.publishedAt);
  }
  if (!commonValid || !shapeValid) {
    throw new Error(`Catalog ${catalogVersion} publication journal is damaged. Increase the Catalog version.`);
  }
  if (value.state !== 'published'
    && value.repository !== catalogPublicationRepositoryName(catalogVersion)) {
    throw new Error(`Catalog ${catalogVersion} publication journal is damaged. Increase the Catalog version.`);
  }
  return value as unknown as CatalogPublicationJournal;
}

export async function readCatalogPublicationJournal(
  filePath: string,
  catalogVersion: string,
): Promise<CatalogPublicationJournal | null> {
  if (!(await fs.pathExists(filePath))) return null;
  try {
    return parseCatalogPublicationJournal(await fs.readJson(filePath), catalogVersion);
  } catch (error) {
    if (error instanceof Error && error.message.includes('publication journal is damaged')) throw error;
    throw new Error(`Catalog ${catalogVersion} publication journal is damaged. Increase the Catalog version.`, {
      cause: error,
    });
  }
}

export async function writeCatalogPublicationJournalAtomic(
  filePath: string,
  journal: CatalogPublicationJournal,
  exclusive = false,
): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`,
  );
  await fs.writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    if (exclusive) {
      await fs.link(temporary, filePath);
      await fs.remove(temporary);
    } else {
      await fs.rename(temporary, filePath);
    }
  } catch (error) {
    await fs.remove(temporary);
    throw error;
  }
}
