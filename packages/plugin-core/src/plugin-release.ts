import {
  assertStrictSemVer,
  compareStrictSemVer,
  parseStrictSemVer,
} from './manifest-contract.js';
import type { CatalogChannel, CatalogManifestV4, PluginMeta } from './types.js';

export const PLUGIN_RELEASE_LEDGER_FILENAME = 'plugin-release-ledger.json';
export const PLUGIN_RELEASE_LEDGER_SCHEMA_VERSION = 2;

const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

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
  schemaVersion: 2;
  records: PluginReleaseLedgerRecord[];
}

function assertPlainObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(value: Record<string, unknown>, fieldName: string, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Invalid ${fieldName}: unknown field ${JSON.stringify(key)}.`);
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

function identityKey(record: Pick<PluginReleaseLedgerRecord, 'plugin' | 'version'>): string {
  return `${record.plugin}@${record.version}`;
}

function recordKey(record: Pick<PluginReleaseLedgerRecord, 'channel' | 'catalogVersion' | 'plugin' | 'version'>): string {
  return JSON.stringify([record.channel, record.catalogVersion, record.plugin, record.version]);
}

function sameDigests(left: PluginReleaseLedgerRecord, right: PluginReleaseLedgerRecord): boolean {
  return left.artifactDigest === right.artifactDigest
    && left.manifestDigest === right.manifestDigest
    && left.contentDigest === right.contentDigest;
}

function validateRecord(rawValue: unknown, index: number): PluginReleaseLedgerRecord {
  const raw = assertPlainObject(rawValue, `plugin release ledger.records[${index}]`);
  assertAllowedKeys(raw, `plugin release ledger.records[${index}]`, [
    'plugin', 'version', 'contentDigest', 'artifactDigest', 'manifestDigest', 'channel', 'catalogVersion',
  ]);
  if (raw.channel !== 'latest' && raw.channel !== 'beta') {
    throw new Error(`Invalid plugin release ledger.records[${index}].channel.`);
  }
  return {
    plugin: assertPluginName(raw.plugin, `plugin release ledger.records[${index}].plugin`),
    version: assertStrictSemVer(raw.version, `plugin release ledger.records[${index}].version`),
    contentDigest: raw.contentDigest === null ? null : assertDigest(raw.contentDigest, `plugin release ledger.records[${index}].contentDigest`),
    artifactDigest: assertDigest(raw.artifactDigest, `plugin release ledger.records[${index}].artifactDigest`),
    manifestDigest: assertDigest(raw.manifestDigest, `plugin release ledger.records[${index}].manifestDigest`),
    channel: raw.channel,
    catalogVersion: assertStrictSemVer(raw.catalogVersion, `plugin release ledger.records[${index}].catalogVersion`),
  };
}

export function validatePluginReleaseLedger(rawValue: unknown): PluginReleaseLedger {
  const raw = assertPlainObject(rawValue, 'plugin release ledger');
  assertAllowedKeys(raw, 'plugin release ledger', ['schemaVersion', 'records']);
  if (raw.schemaVersion !== 2 || !Array.isArray(raw.records)) {
    throw new Error('Invalid plugin release ledger: expected schemaVersion 2 and records array.');
  }
  const byRecord = new Map<string, PluginReleaseLedgerRecord>();
  const byIdentity = new Map<string, PluginReleaseLedgerRecord>();
  for (const record of raw.records.map(validateRecord)) {
    const duplicate = byRecord.get(recordKey(record));
    if (duplicate) {
      if (!sameDigests(duplicate, record)) throw new Error(`Plugin publication record for ${identityKey(record)} contains conflicting digests.`);
      continue;
    }
    const identity = byIdentity.get(identityKey(record));
    if (identity && !sameDigests(identity, record)) throw new Error(`Plugin release identity ${identityKey(record)} maps to different digests.`);
    byRecord.set(recordKey(record), record);
    byIdentity.set(identityKey(record), record);
  }
  return {
    schemaVersion: 2,
    records: [...byRecord.values()].sort((left, right) =>
      left.plugin.localeCompare(right.plugin)
      || compareStrictSemVer(left.version, right.version)
      || left.channel.localeCompare(right.channel)
      || compareStrictSemVer(left.catalogVersion, right.catalogVersion)),
  };
}

export function validatePluginReleaseLedgerAgainstManifest(rawLedger: unknown, manifest: CatalogManifestV4): PluginReleaseLedger {
  const ledger = validatePluginReleaseLedger(rawLedger);
  for (const entry of manifest.entries) {
    const records = ledger.records.filter((record) => record.plugin === entry.name
      && record.version === entry.version
      && record.channel === manifest.channel
      && record.catalogVersion === manifest.catalogVersion);
    if (records.length !== 1
      || records[0]!.artifactDigest !== entry.artifactDigest
      || records[0]!.manifestDigest !== entry.manifestDigest
      || records[0]!.contentDigest !== entry.contentDigest) {
      throw new Error(`Plugin release ledger does not match catalog entry ${entry.name}@${entry.version}.`);
    }
  }
  const current = ledger.records.filter((record) => record.channel === manifest.channel
    && record.catalogVersion === manifest.catalogVersion);
  if (current.length !== manifest.entries.length) {
    throw new Error('Plugin release ledger contains unexpected records for the current catalog.');
  }
  return ledger;
}

export function mergePluginReleaseLedgers(
  ...ledgers: Array<PluginReleaseLedger | null | undefined>
): PluginReleaseLedger {
  return validatePluginReleaseLedger({
    schemaVersion: PLUGIN_RELEASE_LEDGER_SCHEMA_VERSION,
    records: ledgers.flatMap((ledger) => ledger?.records ?? []),
  });
}

export function resolveBetaPluginVersionOverrides(options: {
  plugins: readonly PluginMeta[];
  contentDigests: ReadonlyMap<string, string>;
  ledger: PluginReleaseLedger;
}): Record<string, string> {
  const ledger = validatePluginReleaseLedger(options.ledger);
  const overrides: Record<string, string> = {};
  for (const plugin of options.plugins) {
    const name = plugin.manifest.name;
    const target = assertStablePluginVersion(plugin.manifest.version, `${name} source version`);
    const contentDigest = options.contentDigests.get(name);
    if (!contentDigest) throw new Error(`Missing release content digest for plugin ${JSON.stringify(name)}.`);
    const stable = ledger.records.find((record) => record.plugin === name && record.version === target);
    if (stable) {
      if (stable.contentDigest !== contentDigest) {
        throw new Error(`Plugin release identity ${name}@${target} maps to different content. Increase the source plugin version.`);
      }
      continue;
    }
    const prefix = `${target}-beta.`;
    const betas = ledger.records.filter((record) => record.plugin === name && record.version.startsWith(prefix)
      && /^\d+$/u.test(record.version.slice(prefix.length)));
    const highest = betas.reduce((value, record) => Math.max(value, Number(record.version.slice(prefix.length))), 0);
    const latest = betas.find((record) => Number(record.version.slice(prefix.length)) === highest);
    overrides[name] = latest?.contentDigest === contentDigest ? latest.version : `${prefix}${highest + 1}`;
  }
  return overrides;
}

export function appendCatalogToPluginReleaseLedger(options: {
  previous: PluginReleaseLedger;
  manifest: CatalogManifestV4;
  contentDigests: ReadonlyMap<string, string>;
}): PluginReleaseLedger {
  const previous = validatePluginReleaseLedger(options.previous);
  const records = [...previous.records];
  for (const entry of options.manifest.entries) {
    const contentDigest = options.contentDigests.get(entry.name);
    if (!contentDigest) throw new Error(`Missing release content digest for plugin ${JSON.stringify(entry.name)}.`);
    const candidate: PluginReleaseLedgerRecord = {
      plugin: entry.name,
      version: entry.version,
      contentDigest,
      artifactDigest: entry.artifactDigest,
      manifestDigest: entry.manifestDigest,
      channel: options.manifest.channel,
      catalogVersion: options.manifest.catalogVersion,
    };
    const exact = records.find((record) => recordKey(record) === recordKey(candidate));
    const identity = records.find((record) => identityKey(record) === identityKey(candidate));
    const highest = records.filter((record) => record.plugin === candidate.plugin)
      .reduce<PluginReleaseLedgerRecord | null>((current, record) => !current
        || compareStrictSemVer(record.version, current.version) > 0 ? record : current, null);
    if (exact) {
      if (!sameDigests(exact, candidate)) throw new Error(`Plugin publication record for ${identityKey(candidate)} contains conflicting digests.`);
      continue;
    }
    if (identity && !sameDigests(identity, candidate)) throw new Error(`Plugin release identity ${identityKey(candidate)} maps to different digests.`);
    if (highest && (identity
      ? compareStrictSemVer(candidate.version, highest.version) < 0
      : compareStrictSemVer(candidate.version, highest.version) <= 0)) {
      throw new Error(identity
        ? `Plugin ${candidate.plugin} version ${candidate.version} must not be lower than published ${highest.version}.`
        : `Plugin ${candidate.plugin} version ${candidate.version} must be higher than published ${highest.version}.`);
    }
    records.push(candidate);
  }
  return validatePluginReleaseLedger({ schemaVersion: 2, records });
}
