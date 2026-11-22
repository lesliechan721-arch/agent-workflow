import path from 'node:path';
import fs from 'fs-extra';
import {
  COMMAND_RUNTIME_CONFIG_READER,
  canonicalizeIdentityValue,
  type InstalledCommandProducer,
  type PlatformName,
  type PluginConfigValue,
  type ProducerIdentity,
} from '@lesliechan721/aw-plugin-core/manifest';

import { ManagedCommandError } from './managed-command-errors.js';
import { resolveCliPackageRoot } from './paths.js';

export { COMMAND_RUNTIME_CONFIG_READER } from '@lesliechan721/aw-plugin-core/manifest';
const SNAPSHOT_KIND = 'aw-command-runtime-config';

export interface CommandRuntimeConfigSnapshot {
  schemaVersion: 1;
  kind: typeof SNAPSHOT_KIND;
  producer: ProducerIdentity;
  pluginVersion: string;
  sourceContentDigest: string;
  platform: PlatformName;
  allowedKeys: string[];
  effectiveValues: Record<string, PluginConfigValue>;
}

export function commandRuntimeConfigSnapshotPath(platform: PlatformName): string {
  return `.aw/runtime-config/${platform}.json`;
}

export async function readCommandRuntimeConfigReaderSource(): Promise<Buffer> {
  const asset = path.join('authoring', 'assets', 'command-runtime-config.mjs');
  const root = resolveCliPackageRoot();
  const source = path.join(root, asset);
  return fs.readFile(await fs.pathExists(source) ? source : path.join(root, 'dist', asset));
}

function snapshotInvalid(): never {
  throw new ManagedCommandError('commandRuntimeConfigInvalid', 'The installed command runtime config is invalid. Run aw command package sync or aw plugin sync.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isConfigValue(value: unknown): boolean {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return true;
  if (Array.isArray(value)) return value.every(isConfigValue);
  return isRecord(value) && Object.entries(value).every(([key, entry]) =>
    !['__proto__', 'constructor', 'prototype'].includes(key) && isConfigValue(entry));
}

async function readRegularConfigFile(root: string, relative: string): Promise<Buffer> {
  let current = root;
  const segments = relative.split('/');
  try {
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !(index === segments.length - 1 ? stat.isFile() : stat.isDirectory())) snapshotInvalid();
    }
    return await fs.readFile(current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ManagedCommandError('commandRuntimeConfigMissing', 'The installed command runtime config is missing. Run aw command package sync or aw plugin sync.');
    }
    snapshotInvalid();
  }
}

export async function readManagedCommandRuntimeConfigSnapshot(
  resourceRoot: string, record: InstalledCommandProducer, platform: PlatformName,
): Promise<CommandRuntimeConfigSnapshot> {
  if (!record.runtimeConfigKeys || !record.runtimeConfigPlatforms.includes(platform)) snapshotInvalid();
  const bytes = await readRegularConfigFile(resourceRoot, commandRuntimeConfigSnapshotPath(platform));
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { snapshotInvalid(); }
  if (!isRecord(value)
    || Object.keys(value).length !== 8
    || value.schemaVersion !== 1
    || value.kind !== SNAPSHOT_KIND
    || value.pluginVersion !== record.pluginVersion
    || value.sourceContentDigest !== record.sourceContentDigest
    || value.platform !== platform
    || canonicalizeIdentityValue(value.producer) !== canonicalizeIdentityValue(record.producer)
    || !Array.isArray(value.allowedKeys)
    || canonicalizeIdentityValue(value.allowedKeys) !== canonicalizeIdentityValue(record.runtimeConfigKeys)
    || !isRecord(value.effectiveValues)
    || Object.entries(value.effectiveValues).some(([key, entry]) => !record.runtimeConfigKeys!.includes(key) || !isConfigValue(entry))) {
    snapshotInvalid();
  }
  return value as unknown as CommandRuntimeConfigSnapshot;
}

export async function validateManagedCommandRuntimeConfigFiles(
  resourceRoot: string, record: InstalledCommandProducer,
): Promise<void> {
  if (!record.runtimeConfigKeys) return;
  await readRegularConfigFile(resourceRoot, COMMAND_RUNTIME_CONFIG_READER);
  for (const platform of record.runtimeConfigPlatforms) {
    await readManagedCommandRuntimeConfigSnapshot(resourceRoot, record, platform);
  }
}
