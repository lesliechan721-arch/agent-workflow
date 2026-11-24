import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const platforms = ['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'copilot', 'grok'];
const sha256 = /^sha256:[a-f0-9]{64}$/u;
const packageIdPattern = /^pkg_[0-9a-f]{64}$/u;
const revisionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const uniqueKeys = (keys) => Array.isArray(keys) && keys.length > 0
  && [...keys].every((key) => typeof key === 'string' && key.length > 0) && new Set(keys).size === keys.length;

function validConfigValue(value) {
  if (typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return true;
  if (Array.isArray(value)) return value.every(validConfigValue);
  return record(value) && Object.entries(value).every(([key, child]) =>
    !['__proto__', 'constructor', 'prototype'].includes(key) && validConfigValue(child));
}

function fail(code = 'commandRuntimeConfigInvalid') {
  const recovery = code === 'commandRuntimeConfigContextMissing'
    ? 'Launch through aw command run <source/plugin/platform> -- [args...].'
    : 'Refresh the command package with aw plugin sync or aw command package sync.';
  const error = new Error(`${code}. ${recovery}`);
  error.code = code;
  throw error;
}

async function regularFile(file) {
  const root = path.parse(file).root;
  const parts = file.slice(root.length).split(path.sep === '\\' ? /[\\/]/u : path.sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    if (!part || part === '.' || part === '..') fail();
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) fail();
  }
  return current;
}

async function readRecord(file) {
  const value = JSON.parse(await fs.readFile(await regularFile(file), 'utf8'));
  if (!record(value)) fail();
  return value;
}

function sameProducer(left, right) {
  return record(right) && Object.keys(right).length === 3 && left.sourceId === right.sourceId
    && left.pluginName === right.pluginName && left.sourceIdentity === right.sourceIdentity;
}

function readContext() {
  const raw = process.env.AW_COMMAND_RUNTIME_CONFIG;
  if (raw === undefined) fail('commandRuntimeConfigContextMissing');
  const context = JSON.parse(raw);
  if (!record(context) || Object.keys(context).length !== 4 || context.schemaVersion !== 1
    || !platforms.includes(context.platform) || typeof context.packageId !== 'string' || !packageIdPattern.test(context.packageId)
    || typeof context.revision !== 'string' || !revisionPattern.test(context.revision)) fail();
  return context;
}

/** Read selected applied values from the immutable revision containing this module. */
export async function readCommandRuntimeConfig(options = {}) {
  try {
    if (!record(options) || Reflect.ownKeys(options).some((key) => key !== 'from' && key !== 'keys')) fail();
    const { from, keys } = options;
    const { platform, packageId, revision } = readContext();
    const reader = await regularFile(fileURLToPath(import.meta.url));
    const readerDirectory = path.dirname(reader);
    const revisionRoot = path.dirname(readerDirectory);
    const revisions = path.dirname(revisionRoot);
    const packageRoot = path.dirname(revisions);
    if (path.basename(readerDirectory) !== '.aw' || path.basename(reader) !== 'command-runtime-config.mjs'
      || path.basename(revisions) !== 'revisions'
      || path.basename(revisionRoot) !== revision || path.basename(packageRoot) !== packageId) fail();
    const caller = typeof from === 'string' && path.isAbsolute(from) ? from : fileURLToPath(from);
    const relative = path.relative(revisionRoot, await regularFile(caller));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail();
    if (!uniqueKeys(keys)) fail('commandRuntimeConfigKeyDenied');
    const owner = await readRecord(path.join(packageRoot, 'owner.json'));
    const receipt = await readRecord(path.join(revisionRoot, '.aw-command-producer.json'));
    const producer = owner.producer;
    if (owner.schemaVersion !== 2 || owner.owner !== 'agent-workflows' || owner.kind !== 'plugin-command-package'
      || !record(producer) || Object.keys(producer).length !== 3
      || typeof producer.sourceId !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/u.test(producer.sourceId)
      || typeof producer.pluginName !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(producer.pluginName)
      || !sha256.test(producer.sourceIdentity ?? '') || receipt.schemaVersion !== 2
      || !sameProducer(producer, receipt.producer) || typeof receipt.pluginVersion !== 'string' || !receipt.pluginVersion
      || !sha256.test(receipt.sourceContentDigest ?? '') || !Array.isArray(receipt.runtimeConfigPlatforms)
      || receipt.runtimeConfigPlatforms.some((name) => !platforms.includes(name))
      || new Set(receipt.runtimeConfigPlatforms).size !== receipt.runtimeConfigPlatforms.length
      || !uniqueKeys(receipt.runtimeConfigKeys)) fail();
    // These keys follow the package identity's canonical lexicographic order.
    const identity = JSON.stringify({ pluginName: producer.pluginName, schemaVersion: 2,
      sourceId: producer.sourceId, sourceIdentity: producer.sourceIdentity });
    if (`pkg_${createHash('sha256').update(identity).digest('hex')}` !== packageId) fail();
    if (!receipt.runtimeConfigPlatforms.includes(platform)) fail('commandRuntimeConfigMissing');
    if (keys.some((key) => !receipt.runtimeConfigKeys.includes(key))) fail('commandRuntimeConfigKeyDenied');
    const snapshot = await readRecord(path.join(revisionRoot, '.aw', 'runtime-config', `${platform}.json`)).catch((error) => {
      if (error?.code === 'ENOENT') fail('commandRuntimeConfigMissing');
      throw error;
    });
    if (Object.keys(snapshot).length !== 8 || snapshot.schemaVersion !== 1 || snapshot.kind !== 'aw-command-runtime-config' || snapshot.platform !== platform
      || !sameProducer(producer, snapshot.producer) || snapshot.pluginVersion !== receipt.pluginVersion
      || snapshot.sourceContentDigest !== receipt.sourceContentDigest || !uniqueKeys(snapshot.allowedKeys)
      || snapshot.allowedKeys.length !== receipt.runtimeConfigKeys.length
      || snapshot.allowedKeys.some((key, index) => key !== receipt.runtimeConfigKeys[index])
      || !record(snapshot.effectiveValues) || Object.entries(snapshot.effectiveValues).some(([key, value]) =>
        !snapshot.allowedKeys.includes(key) || !validConfigValue(value))) fail();
    return {
      values: Object.fromEntries(keys.filter((key) => Object.hasOwn(snapshot.effectiveValues, key))
        .map((key) => [key, snapshot.effectiveValues[key]])),
      platform,
      installedIdentity: { ...producer, pluginId: `${producer.sourceId}/${producer.pluginName}`, platform,
        pluginVersion: receipt.pluginVersion, sourceContentDigest: receipt.sourceContentDigest },
      resourceRoot: revisionRoot,
    };
  } catch (error) {
    if (error?.code?.startsWith('commandRuntimeConfig')) throw error;
    fail();
  }
}
