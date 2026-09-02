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
  schemaVersion: 2;
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

export function catalogPublicationPlanDigest(
  descriptor: CatalogPublicationDescriptor,
  expectedCommit: string,
): string {
  return digest(canonicalJson({ descriptor, expectedCommit }));
}

export function catalogPublicationDirectoryPath(workspaceRoot: string, catalogVersion: string): string {
  return path.join(workspaceRoot, '.aw', 'publish', catalogVersion);
}

export function catalogPublicationJournalPath(workspaceRoot: string, catalogVersion: string): string {
  return path.join(catalogPublicationDirectoryPath(workspaceRoot, catalogVersion), 'journal.json');
}

export function catalogPublicationRepositoryName(): string {
  return 'repository';
}

export function catalogPublicationRepositoryPath(workspaceRoot: string, catalogVersion: string): string {
  return path.join(
    catalogPublicationDirectoryPath(workspaceRoot, catalogVersion),
    catalogPublicationRepositoryName(),
  );
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
  const commonValid = value.schemaVersion === 2
    && isDigest(value.planDigest)
    && isCommit(value.expectedCommit)
    && value.planDigest === catalogPublicationPlanDigest(value.descriptor, value.expectedCommit)
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
    && value.repository !== catalogPublicationRepositoryName()) {
    throw new Error(`Catalog ${catalogVersion} publication journal is damaged. Increase the Catalog version.`);
  }
  return value as unknown as CatalogPublicationJournal;
}

export async function readCatalogPublicationJournal(
  filePath: string,
  catalogVersion: string,
): Promise<CatalogPublicationJournal | null> {
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Catalog ${catalogVersion} publication journal is damaged. Increase the Catalog version.`);
  }
  try {
    return parseCatalogPublicationJournal(await fs.readJson(filePath), catalogVersion);
  } catch (error) {
    if (error instanceof Error && error.message.includes('publication journal is damaged')) throw error;
    throw new Error(`Catalog ${catalogVersion} publication journal is damaged. Increase the Catalog version.`, {
      cause: error,
    });
  }
}

export interface LocatedCatalogPublicationJournal {
  catalogVersion: string;
  journalPath: string;
  journal: CatalogPublicationJournal;
}

const CATALOG_VERSION_DIRECTORY = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u;

export async function findCatalogPublicationJournalByPlanDigest(
  workspaceRoot: string,
  planDigest: string,
): Promise<LocatedCatalogPublicationJournal> {
  const publishRoot = path.join(workspaceRoot, '.aw', 'publish');
  let entries;
  try {
    entries = await fs.readdir(publishRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'No schema v2 Catalog publication journal matches the authorized plan digest. '
        + 'The journal is missing or damaged, or the digest is unauthorized. Increase the Catalog version or run catalog publish plan.',
      );
    }
    throw error;
  }
  const matches: Array<{ catalogVersion: string; journalPath: string; value: unknown }> = [];
  for (const entry of entries) {
    if (!CATALOG_VERSION_DIRECTORY.test(entry.name)) continue;
    const directoryPath = path.join(publishRoot, entry.name);
    const directoryStats = await fs.lstat(directoryPath);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new Error(`Catalog ${entry.name} publication state directory is damaged. Increase the Catalog version.`);
    }
    const journalPath = path.join(directoryPath, 'journal.json');
    let journalStats;
    try {
      journalStats = await fs.lstat(journalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!journalStats.isFile() || journalStats.isSymbolicLink()) {
      throw new Error(`Catalog ${entry.name} publication journal is damaged. Increase the Catalog version.`);
    }
    let value: unknown;
    try {
      value = await fs.readJson(journalPath);
    } catch {
      continue;
    }
    if (isRecord(value) && value.schemaVersion === 2 && value.planDigest === planDigest) {
      matches.push({ catalogVersion: entry.name, journalPath, value });
    }
  }
  if (matches.length === 0) {
    throw new Error(
      'No schema v2 Catalog publication journal matches the authorized plan digest. '
      + 'The journal is missing or damaged, or the digest is unauthorized. Increase the Catalog version or run catalog publish plan.',
    );
  }
  if (matches.length !== 1) {
    throw new Error(
      'Multiple schema v2 Catalog publication journals match the authorized plan digest. Increase the Catalog version.',
    );
  }
  const match = matches[0]!;
  return {
    catalogVersion: match.catalogVersion,
    journalPath: match.journalPath,
    journal: parseCatalogPublicationJournal(match.value, match.catalogVersion),
  };
}

export async function writeCatalogPublicationJournalAtomic(
  filePath: string,
  journal: CatalogPublicationJournal,
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
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.remove(temporary);
    throw error;
  }
}
