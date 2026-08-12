import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';

import type {
  CatalogChannel,
  CatalogManifest,
  PluginMeta,
} from '../types.js';
import {
  assertStrictSemVer,
  compareStrictSemVer,
  parseStrictSemVer,
} from './manifest.js';

export const PLUGIN_DEVELOPMENT_RECEIPT_FILENAME = 'development-receipt.json';
export const PLUGIN_RELEASE_LEDGER_FILENAME = 'plugin-release-ledger.json';
export const PLUGIN_RELEASE_INTENT_DIRECTORY = path.join('.changes', 'plugins');

const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BUMP_RANK = new Map<PluginReleaseBump, number>([
  ['patch', 0],
  ['minor', 1],
  ['major', 2],
]);
const execFileAsync = promisify(execFile);

export type PluginReleaseBump = 'major' | 'minor' | 'patch';

export interface PluginDevelopmentReceiptEntry {
  name: string;
  baseVersion: string;
  contentDigest: string;
  plannedBump: PluginReleaseBump | null;
  targetVersion: string | null;
  intentFiles: string[];
}

export interface PluginDevelopmentReceipt {
  schemaVersion: 1;
  phase: 'development';
  publishable: false;
  catalogVersion: string;
  gitCommit: string | null;
  dirty: boolean | null;
  entries: PluginDevelopmentReceiptEntry[];
}

export interface PluginReleaseLedgerRecord {
  plugin: string;
  version: string;
  contentDigest: string | null;
  artifactDigest: string;
  manifestDigest: string;
  channel: CatalogChannel;
  catalogVersion: string;
}

export interface PluginReleaseLedger {
  schemaVersion: 1;
  records: PluginReleaseLedgerRecord[];
}

interface RawReleaseIntent {
  schemaVersion: 1;
  plugin: string;
  bump: PluginReleaseBump;
  summary: string;
  fileName: string;
}

function assertPlainObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  fieldName: string,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Invalid ${fieldName}: unknown field ${JSON.stringify(key)}.`);
    }
  }
}

function assertPluginName(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !PLUGIN_NAME_PATTERN.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected lowercase hyphen-case.`);
  }
  return value;
}

function assertDigest(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !SHA256_DIGEST_PATTERN.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected a canonical sha256 digest.`);
  }
  return value;
}

function assertBump(value: unknown, fieldName: string): PluginReleaseBump {
  if (value !== 'major' && value !== 'minor' && value !== 'patch') {
    throw new Error(`Invalid ${fieldName}: expected major, minor, or patch.`);
  }
  return value;
}

function incrementStableVersion(version: string, bump: PluginReleaseBump): string {
  const parsed = parseStrictSemVer(version, 'plugin version');
  if (parsed.prerelease.length > 0 || parsed.build.length > 0) {
    throw new Error(
      `Plugin version ${JSON.stringify(version)} must be stable while release intents are pending.`,
    );
  }
  if (bump === 'major') return `${parsed.major + 1}.0.0`;
  if (bump === 'minor') return `${parsed.major}.${parsed.minor + 1}.0`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

async function readReleaseIntents(repoRoot: string): Promise<RawReleaseIntent[]> {
  const intentRoot = path.join(repoRoot, PLUGIN_RELEASE_INTENT_DIRECTORY);
  const entries = await fs.readdir(intentRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const intents: RawReleaseIntent[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === 'README.md' || entry.name === '.gitkeep') continue;
    if (!entry.isFile() || !/^[a-z0-9][a-z0-9._-]*\.json$/.test(entry.name)) {
      throw new Error(
        `Unsupported entry in ${PLUGIN_RELEASE_INTENT_DIRECTORY}: ${JSON.stringify(entry.name)}.`,
      );
    }
    const raw = assertPlainObject(
      await fs.readJson(path.join(intentRoot, entry.name)),
      `release intent ${entry.name}`,
    );
    assertAllowedKeys(raw, `release intent ${entry.name}`, [
      'schemaVersion',
      'plugin',
      'bump',
      'summary',
    ]);
    if (raw.schemaVersion !== 1) {
      throw new Error(`Invalid release intent ${entry.name}.schemaVersion: expected 1.`);
    }
    if (typeof raw.summary !== 'string' || raw.summary.trim() === '') {
      throw new Error(`Invalid release intent ${entry.name}.summary: expected a non-empty string.`);
    }
    intents.push({
      schemaVersion: 1,
      plugin: assertPluginName(raw.plugin, `release intent ${entry.name}.plugin`),
      bump: assertBump(raw.bump, `release intent ${entry.name}.bump`),
      summary: raw.summary.trim(),
      fileName: entry.name,
    });
  }
  return intents;
}

async function readGitDevelopmentState(
  repoRoot: string,
): Promise<{ gitCommit: string | null; dirty: boolean | null }> {
  try {
    const [commit, status] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
      }),
      execFileAsync('git', ['status', '--porcelain', '--untracked-files=normal'], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      }),
    ]);
    return {
      gitCommit: commit.stdout.trim(),
      dirty: status.stdout.trim() !== '',
    };
  } catch {
    return { gitCommit: null, dirty: null };
  }
}

export async function createPluginDevelopmentReceipt(options: {
  repoRoot: string;
  catalogVersion: string;
  plugins: readonly PluginMeta[];
  contentDigests: ReadonlyMap<string, string>;
}): Promise<PluginDevelopmentReceipt> {
  const catalogVersion = assertStrictSemVer(options.catalogVersion, 'development receipt catalogVersion');
  const [intents, gitState] = await Promise.all([
    readReleaseIntents(options.repoRoot),
    readGitDevelopmentState(options.repoRoot),
  ]);
  const pluginsByName = new Map(options.plugins.map((plugin) => [plugin.manifest.name, plugin]));
  const grouped = new Map<string, { bump: PluginReleaseBump; files: string[] }>();
  for (const intent of intents) {
    if (!pluginsByName.has(intent.plugin)) {
      throw new Error(
        `Release intent ${intent.fileName} refers to unknown plugin ${JSON.stringify(intent.plugin)}.`,
      );
    }
    const current = grouped.get(intent.plugin);
    if (!current) {
      grouped.set(intent.plugin, { bump: intent.bump, files: [intent.fileName] });
      continue;
    }
    if (BUMP_RANK.get(intent.bump)! > BUMP_RANK.get(current.bump)!) {
      current.bump = intent.bump;
    }
    current.files.push(intent.fileName);
  }

  const entries = options.plugins.map((plugin): PluginDevelopmentReceiptEntry => {
    const name = plugin.manifest.name;
    const plan = grouped.get(name);
    const contentDigest = options.contentDigests.get(name);
    if (!contentDigest) {
      throw new Error(`Missing development content digest for plugin ${JSON.stringify(name)}.`);
    }
    return {
      name,
      baseVersion: plugin.manifest.version,
      contentDigest: assertDigest(contentDigest, `${name} contentDigest`),
      plannedBump: plan?.bump ?? null,
      targetVersion: plan ? incrementStableVersion(plugin.manifest.version, plan.bump) : null,
      intentFiles: plan?.files ?? [],
    };
  });

  return {
    schemaVersion: 1,
    phase: 'development',
    publishable: false,
    catalogVersion,
    ...gitState,
    entries,
  };
}

export function validatePluginDevelopmentReceipt(rawValue: unknown): PluginDevelopmentReceipt {
  const raw = assertPlainObject(rawValue, 'plugin development receipt');
  assertAllowedKeys(raw, 'plugin development receipt', [
    'schemaVersion',
    'phase',
    'publishable',
    'catalogVersion',
    'gitCommit',
    'dirty',
    'entries',
  ]);
  if (raw.schemaVersion !== 1 || raw.phase !== 'development' || raw.publishable !== false) {
    throw new Error('Invalid plugin development receipt identity.');
  }
  if (!Array.isArray(raw.entries)) {
    throw new Error('Invalid plugin development receipt.entries: expected an array.');
  }
  if (raw.gitCommit !== null && (typeof raw.gitCommit !== 'string' || !/^[0-9a-f]{40,64}$/.test(raw.gitCommit))) {
    throw new Error('Invalid plugin development receipt.gitCommit.');
  }
  if (raw.dirty !== null && typeof raw.dirty !== 'boolean') {
    throw new Error('Invalid plugin development receipt.dirty.');
  }
  const names = new Set<string>();
  const entries = raw.entries.map((value, index): PluginDevelopmentReceiptEntry => {
    const entry = assertPlainObject(value, `plugin development receipt.entries[${index}]`);
    assertAllowedKeys(entry, `plugin development receipt.entries[${index}]`, [
      'name',
      'baseVersion',
      'contentDigest',
      'plannedBump',
      'targetVersion',
      'intentFiles',
    ]);
    const name = assertPluginName(entry.name, `plugin development receipt.entries[${index}].name`);
    if (names.has(name)) throw new Error(`Duplicate development receipt plugin ${JSON.stringify(name)}.`);
    names.add(name);
    const baseVersion = assertStrictSemVer(entry.baseVersion, `${name} baseVersion`);
    const plannedBump = entry.plannedBump === null
      ? null
      : assertBump(entry.plannedBump, `${name} plannedBump`);
    const targetVersion = entry.targetVersion === null
      ? null
      : assertStrictSemVer(entry.targetVersion, `${name} targetVersion`);
    if ((plannedBump === null) !== (targetVersion === null)) {
      throw new Error(`Invalid development receipt plan for plugin ${JSON.stringify(name)}.`);
    }
    if (plannedBump && targetVersion !== incrementStableVersion(baseVersion, plannedBump)) {
      throw new Error(`Invalid development receipt targetVersion for plugin ${JSON.stringify(name)}.`);
    }
    if (!Array.isArray(entry.intentFiles) || entry.intentFiles.some((file) => typeof file !== 'string')) {
      throw new Error(`Invalid development receipt intentFiles for plugin ${JSON.stringify(name)}.`);
    }
    return {
      name,
      baseVersion,
      contentDigest: assertDigest(entry.contentDigest, `${name} contentDigest`),
      plannedBump,
      targetVersion,
      intentFiles: [...entry.intentFiles] as string[],
    };
  });
  return {
    schemaVersion: 1,
    phase: 'development',
    publishable: false,
    catalogVersion: assertStrictSemVer(raw.catalogVersion, 'development receipt catalogVersion'),
    gitCommit: raw.gitCommit as string | null,
    dirty: raw.dirty as boolean | null,
    entries,
  };
}

function ledgerRecordKey(record: Pick<PluginReleaseLedgerRecord, 'plugin' | 'version'>): string {
  return `${record.plugin}@${record.version}`;
}

function validateLedgerRecord(rawValue: unknown, index: number): PluginReleaseLedgerRecord {
  const raw = assertPlainObject(rawValue, `plugin release ledger.records[${index}]`);
  assertAllowedKeys(raw, `plugin release ledger.records[${index}]`, [
    'plugin',
    'version',
    'contentDigest',
    'artifactDigest',
    'manifestDigest',
    'channel',
    'catalogVersion',
  ]);
  const channel = raw.channel;
  if (channel !== 'latest' && channel !== 'beta') {
    throw new Error(`Invalid plugin release ledger.records[${index}].channel.`);
  }
  return {
    plugin: assertPluginName(raw.plugin, `plugin release ledger.records[${index}].plugin`),
    version: assertStrictSemVer(raw.version, `plugin release ledger.records[${index}].version`),
    contentDigest: raw.contentDigest === null
      ? null
      : assertDigest(raw.contentDigest, `plugin release ledger.records[${index}].contentDigest`),
    artifactDigest: assertDigest(raw.artifactDigest, `plugin release ledger.records[${index}].artifactDigest`),
    manifestDigest: assertDigest(raw.manifestDigest, `plugin release ledger.records[${index}].manifestDigest`),
    channel,
    catalogVersion: assertStrictSemVer(
      raw.catalogVersion,
      `plugin release ledger.records[${index}].catalogVersion`,
    ),
  };
}

export function validatePluginReleaseLedger(rawValue: unknown): PluginReleaseLedger {
  const raw = assertPlainObject(rawValue, 'plugin release ledger');
  assertAllowedKeys(raw, 'plugin release ledger', ['schemaVersion', 'records']);
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.records)) {
    throw new Error('Invalid plugin release ledger: expected schemaVersion 1 and records array.');
  }
  const records = raw.records.map(validateLedgerRecord);
  const byKey = new Map<string, PluginReleaseLedgerRecord>();
  for (const record of records) {
    const key = ledgerRecordKey(record);
    const existing = byKey.get(key);
    if (
      existing
      && (
        existing.artifactDigest !== record.artifactDigest
        || existing.manifestDigest !== record.manifestDigest
        || (existing.contentDigest && record.contentDigest && existing.contentDigest !== record.contentDigest)
      )
    ) {
      throw new Error(`Plugin release identity ${key} maps to different digests.`);
    }
    if (!existing || (!existing.contentDigest && record.contentDigest)) {
      byKey.set(key, record);
    }
  }
  return {
    schemaVersion: 1,
    records: [...byKey.values()].sort((left, right) =>
      left.plugin.localeCompare(right.plugin) || compareStrictSemVer(left.version, right.version)),
  };
}

export function mergePluginReleaseLedgers(
  ...ledgers: Array<PluginReleaseLedger | null | undefined>
): PluginReleaseLedger {
  return validatePluginReleaseLedger({
    schemaVersion: 1,
    records: ledgers.flatMap((ledger) => ledger?.records ?? []),
  });
}

export function createLegacyPluginReleaseLedger(
  manifest: CatalogManifest,
): PluginReleaseLedger {
  return validatePluginReleaseLedger({
    schemaVersion: 1,
    records: manifest.entries.map((entry) => ({
      plugin: entry.name,
      version: entry.version,
      contentDigest: null,
      artifactDigest: entry.artifactDigest,
      manifestDigest: entry.manifestDigest,
      channel: manifest.channel,
      catalogVersion: manifest.catalogVersion,
    })),
  });
}

export function resolveBetaPluginVersionOverrides(
  receipt: PluginDevelopmentReceipt,
  ledger: PluginReleaseLedger,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const entry of receipt.entries) {
    if (!entry.targetVersion) continue;
    const prefix = `${entry.targetVersion}-beta.`;
    const priorBetas = ledger.records.filter((record) =>
      record.plugin === entry.name
      && record.version.startsWith(prefix)
      && /^\d+$/.test(record.version.slice(prefix.length))
    );
    const sameContent = priorBetas.find((record) => record.contentDigest === entry.contentDigest);
    if (sameContent) {
      overrides[entry.name] = sameContent.version;
      continue;
    }
    const highest = priorBetas.reduce((current, record) =>
      Math.max(current, Number(record.version.slice(prefix.length))), 0);
    overrides[entry.name] = `${prefix}${highest + 1}`;
  }
  return overrides;
}

export function appendCatalogToPluginReleaseLedger(options: {
  previous: PluginReleaseLedger;
  manifest: CatalogManifest;
  contentDigests: ReadonlyMap<string, string>;
}): PluginReleaseLedger {
  const previous = validatePluginReleaseLedger(options.previous);
  const records = [...previous.records];
  const existingByKey = new Map(records.map((record) => [ledgerRecordKey(record), record]));
  for (const entry of options.manifest.entries) {
    const contentDigest = options.contentDigests.get(entry.name);
    if (!contentDigest) {
      throw new Error(`Missing release content digest for plugin ${JSON.stringify(entry.name)}.`);
    }
    const candidate: PluginReleaseLedgerRecord = {
      plugin: entry.name,
      version: entry.version,
      contentDigest,
      artifactDigest: entry.artifactDigest,
      manifestDigest: entry.manifestDigest,
      channel: options.manifest.channel,
      catalogVersion: options.manifest.catalogVersion,
    };
    const key = ledgerRecordKey(candidate);
    const existing = existingByKey.get(key);
    if (existing) {
      if (
        existing.artifactDigest !== candidate.artifactDigest
        || existing.manifestDigest !== candidate.manifestDigest
        || (existing.contentDigest && existing.contentDigest !== candidate.contentDigest)
      ) {
        throw new Error(`Plugin release identity ${key} maps to different digests.`);
      }
      if (!existing.contentDigest) {
        const existingIndex = records.findIndex((record) => ledgerRecordKey(record) === key);
        records[existingIndex] = candidate;
        existingByKey.set(key, candidate);
      }
      continue;
    }
    const highest = records
      .filter((record) => record.plugin === candidate.plugin)
      .reduce<PluginReleaseLedgerRecord | null>((current, record) =>
        !current || compareStrictSemVer(record.version, current.version) > 0 ? record : current,
      null);
    if (highest && compareStrictSemVer(candidate.version, highest.version) <= 0) {
      throw new Error(
        `Plugin ${candidate.plugin} version ${candidate.version} must be higher than published ${highest.version}.`,
      );
    }
    records.push(candidate);
    existingByKey.set(key, candidate);
  }
  return validatePluginReleaseLedger({ schemaVersion: 1, records });
}
