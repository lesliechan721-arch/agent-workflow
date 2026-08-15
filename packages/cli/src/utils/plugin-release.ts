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

export const PLUGIN_RELEASE_LEDGER_FILENAME = 'plugin-release-ledger.json';

const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

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

export function assertStablePluginVersion(version: string, fieldName = 'plugin version'): string {
  const parsed = parseStrictSemVer(version, fieldName);
  if (parsed.prerelease.length > 0 || parsed.build.length > 0) {
    throw new Error(`Invalid ${fieldName}: expected a stable SemVer without prerelease or build metadata.`);
  }
  return version;
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
    if (!existing) {
      byKey.set(key, record);
      continue;
    }
    const preferred = existing.channel === 'latest'
      ? existing
      : record.channel === 'latest'
        ? record
        : existing;
    byKey.set(key, {
      ...preferred,
      contentDigest: existing.contentDigest ?? record.contentDigest,
    });
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
  options: {
    plugins: readonly PluginMeta[];
    contentDigests: ReadonlyMap<string, string>;
    ledger: PluginReleaseLedger;
  },
): Record<string, string> {
  const ledger = validatePluginReleaseLedger(options.ledger);
  const overrides: Record<string, string> = {};
  for (const plugin of options.plugins) {
    const name = plugin.manifest.name;
    const targetVersion = assertStablePluginVersion(plugin.manifest.version, `${name} source version`);
    const contentDigest = options.contentDigests.get(name);
    if (!contentDigest) {
      throw new Error(`Missing release content digest for plugin ${JSON.stringify(name)}.`);
    }
    assertDigest(contentDigest, `${name} contentDigest`);
    const publishedStableIdentity = ledger.records.find((record) =>
      record.plugin === name
      && record.version === targetVersion
    );
    if (publishedStableIdentity) {
      if (
        publishedStableIdentity.contentDigest
        && publishedStableIdentity.contentDigest !== contentDigest
      ) {
        throw new Error(
          `Plugin release identity ${name}@${targetVersion} maps to different content. Increase the source plugin version.`,
        );
      }
      continue;
    }

    const prefix = `${targetVersion}-beta.`;
    const priorBetas = ledger.records.filter((record) =>
      record.plugin === name
      && record.version.startsWith(prefix)
      && /^\d+$/.test(record.version.slice(prefix.length))
    );
    const sameContent = priorBetas.find((record) => record.contentDigest === contentDigest);
    if (sameContent) {
      overrides[name] = sameContent.version;
      continue;
    }
    const highest = priorBetas.reduce((current, record) =>
      Math.max(current, Number(record.version.slice(prefix.length))), 0);
    overrides[name] = `${prefix}${highest + 1}`;
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
    const highest = records
      .filter((record) => record.plugin === candidate.plugin)
      .reduce<PluginReleaseLedgerRecord | null>((current, record) =>
        !current || compareStrictSemVer(record.version, current.version) > 0 ? record : current,
      null);
    if (existing) {
      if (highest && compareStrictSemVer(candidate.version, highest.version) < 0) {
        throw new Error(
          `Plugin ${candidate.plugin} version ${candidate.version} must not be lower than published ${highest.version}.`,
        );
      }
      if (
        existing.artifactDigest !== candidate.artifactDigest
        || existing.manifestDigest !== candidate.manifestDigest
        || (existing.contentDigest && existing.contentDigest !== candidate.contentDigest)
      ) {
        throw new Error(`Plugin release identity ${key} maps to different digests.`);
      }
      if (candidate.channel === 'latest' && existing.channel === 'beta') {
        const existingIndex = records.findIndex((record) => ledgerRecordKey(record) === key);
        records[existingIndex] = candidate;
        existingByKey.set(key, candidate);
      } else if (!existing.contentDigest) {
        const existingIndex = records.findIndex((record) => ledgerRecordKey(record) === key);
        const enriched = { ...existing, contentDigest: candidate.contentDigest };
        records[existingIndex] = enriched;
        existingByKey.set(key, enriched);
      }
      continue;
    }
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
