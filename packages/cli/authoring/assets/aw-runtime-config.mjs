import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BINDING = '.aw-runtime-config.json';
const READER = 'scripts/aw-runtime-config.mjs';
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class RuntimeConfigError extends Error {
  constructor(code) {
    super(`${code}: Installed runtime config is unavailable. Run aw sync or aw reinstall.`);
    this.name = 'RuntimeConfigError';
    this.code = code;
    this.recoveryActions = ['sync', 'reinstall'];
  }
}

function fail(code) { throw new RuntimeConfigError(code); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}
function digest(value) {
  return `sha256:${createHash('sha256').update('aw-runtime-config-v1\0')
    .update(JSON.stringify(canonical(value))).digest('hex')}`;
}
function bytesDigest(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function relativeFile(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\')
    && !value.includes('\0') && !path.posix.isAbsolute(value)
    && !path.win32.isAbsolute(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
async function regularFile(root, relative) {
  if (!relativeFile(relative)) fail('runtimeConfigPathUnsafe');
  let current = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = await fs.lstat(current).catch(() => fail('runtimeConfigResourceMissing'));
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      fail('runtimeConfigPathUnsafe');
    }
  }
  return current;
}
async function assertPathSafe(file) {
  const absolute = path.resolve(file);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(() => fail('runtimeConfigResourceMissing'));
    if (stat.isSymbolicLink()) fail('runtimeConfigPathUnsafe');
  }
  return absolute;
}
function validateBinding(binding) {
  if (!isRecord(binding) || binding.schemaVersion !== 1 || binding.kind !== 'aw-runtime-config') {
    fail('runtimeConfigVersionUnsupported');
  }
  const identity = binding.installedIdentity;
  if (!isRecord(identity) || !isRecord(binding.definition) || !isRecord(binding.definition.fields)
    || !isRecord(binding.effectiveValues) || !isRecord(binding.sources) || !isRecord(binding.resources)
    || !Array.isArray(binding.peerLocators)
    || !Array.isArray(binding.allowedKeys) || binding.allowedKeys.length === 0
    || binding.allowedKeys.some((key) => typeof key !== 'string')
    || new Set(binding.allowedKeys).size !== binding.allowedKeys.length
    || typeof binding.resourceVersion !== 'string' || !binding.resourceVersion
    || !DIGEST.test(binding.revision) || !DIGEST.test(binding.digest)) fail('runtimeConfigBindingInvalid');
  for (const key of ['sourceId', 'sourceIdentity', 'pluginId', 'pluginName', 'pluginVersion', 'artifactId', 'skillKey']) {
    if (typeof identity[key] !== 'string' || !identity[key]) fail('runtimeConfigIdentityMismatch');
  }
  if (!['codex', 'claude'].includes(identity.platform) || !['user', 'project'].includes(identity.scope)
    || !['user', 'project'].includes(identity.configScope)
    || identity.pluginId !== `${identity.sourceId}/${identity.pluginName}`) fail('runtimeConfigIdentityMismatch');
  const { digest: actualDigest, ...payload } = binding;
  if (digest(payload) !== actualDigest) fail('runtimeConfigBindingInvalid');
  const { artifactId: _artifactId, skillKey: _skillKey, scope: _scope, ...revisionIdentity } = identity;
  if (digest({ installedIdentity: revisionIdentity, allowedKeys: binding.allowedKeys,
    definition: binding.definition, effectiveValues: binding.effectiveValues,
    sources: binding.sources, resourceVersion: binding.resourceVersion,
    consistencyGroup: binding.consistencyGroup }) !== binding.revision) {
    fail('runtimeConfigRevisionMismatch');
  }
  for (const [key, field] of Object.entries(binding.definition.fields)) {
    if (!isRecord(field) || field.sensitive === true) fail('runtimeConfigKeyDenied');
    if (Object.hasOwn(binding.effectiveValues, key) && binding.effectiveValues[key] === null) fail('runtimeConfigBindingInvalid');
  }
  if (binding.allowedKeys.some((key) => !Object.hasOwn(binding.definition.fields, key))
    || Object.keys(binding.effectiveValues).some((key) => !Object.hasOwn(binding.definition.fields, key))) fail('runtimeConfigKeyDenied');
  const group = binding.consistencyGroup ?? [];
  if (!Array.isArray(group) || group.length !== binding.peerLocators.length
    || binding.peerLocators.some((peer, index) => !isRecord(peer)
      || !isRecord(group[index]) || peer.artifactId !== group[index].artifactId || peer.skillKey !== group[index].skillKey
      || typeof peer.skillKey !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(peer.skillKey)
      || (peer.skillKey === identity.skillKey ? peer.relativeRoot !== '.'
        : peer.relativeRoot !== `../${peer.skillKey}` && peer.relativeRoot !== `.aw-runtime-peers/${peer.skillKey}` && peer.relativeRoot !== '../..'))) {
    fail('runtimeConfigBindingInvalid');
  }
  return binding;
}
async function checkOwner(root, identity) {
  const ownerPath = path.join(root, '.agent-workflows-owner.json');
  const stat = await fs.lstat(ownerPath).catch(() => null);
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink()) fail('runtimeConfigIdentityMismatch');
  let owner;
  try { owner = JSON.parse(await fs.readFile(ownerPath, 'utf8')); } catch { fail('runtimeConfigIdentityMismatch'); }
  if (!isRecord(owner) || owner.schemaVersion !== 3 || owner.owner !== 'agent-workflows'
    || owner.sourceId !== identity.sourceId || owner.pluginId !== identity.pluginId
    || owner.plugin !== identity.pluginName || owner.artifactKey !== identity.skillKey
    || owner.platform !== identity.platform || owner.scope !== identity.scope) fail('runtimeConfigIdentityMismatch');
}

async function checkResources(root, binding) {
  await checkOwner(root, binding.installedIdentity);
  if (binding.nativeReceiptPath !== undefined) {
    if (typeof binding.nativeReceiptPath !== 'string'
      || (binding.nativeReceiptPath !== '.aw-runtime-native-receipt.json'
        && !/^(?:\.\.\/)+\.agents-plugin\/aw-codex-native-render\.json$/u.test(binding.nativeReceiptPath))) {
      fail('runtimeConfigPathUnsafe');
    }
    const receiptFile = await assertPathSafe(path.resolve(root, binding.nativeReceiptPath));
    let receipt;
    try { receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8')); }
    catch { fail('runtimeConfigBindingInvalid'); }
    const identity = binding.installedIdentity;
    if (!isRecord(receipt) || receipt.schemaVersion !== 1 || receipt.kind !== 'aw-codex-native-render') {
      fail('runtimeConfigVersionUnsupported');
    }
    if (receipt.logicalPluginId !== identity.pluginId || receipt.sourceIdentity !== identity.sourceIdentity
      || receipt.pluginVersion !== identity.pluginVersion || receipt.strategy !== 'shared-user'
      || !Array.isArray(receipt.targets) || !receipt.targets.some((target) => isRecord(target)
        && target.id === identity.artifactId && target.skillKey === identity.skillKey)) {
      fail('runtimeConfigIdentityMismatch');
    }
  }
  for (const [relative, expected] of Object.entries(binding.resources)) {
    if (!DIGEST.test(expected)) fail('runtimeConfigBindingInvalid');
    const file = await regularFile(root, relative);
    if (bytesDigest(await fs.readFile(file)) !== expected) fail('runtimeConfigResourceMismatch');
  }
}

/** Read only AW's installed effective snapshot. `from` must be an installed resource file. */
export async function readRuntimeConfig({ from, keys, expectedRevision } = {}) {
  try {
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string') || new Set(keys).size !== keys.length) {
      fail('runtimeConfigKeyDenied');
    }
    let caller;
    try { caller = from instanceof URL || (typeof from === 'string' && from.startsWith('file:'))
      ? fileURLToPath(from) : from; } catch { fail('runtimeConfigPathUnsafe'); }
    if (typeof caller !== 'string' || !path.isAbsolute(caller)) fail('runtimeConfigPathUnsafe');
    caller = await assertPathSafe(caller);
    let root = path.dirname(caller);
    let binding;
    while (true) {
      const stat = await fs.lstat(path.join(root, BINDING)).catch(() => null);
      if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink()) fail('runtimeConfigPathUnsafe');
        let value;
        try { value = JSON.parse(await fs.readFile(path.join(root, BINDING), 'utf8')); }
        catch { fail('runtimeConfigBindingInvalid'); }
        binding = validateBinding(value);
        break;
      }
      const parent = path.dirname(root);
      if (parent === root) fail('runtimeConfigBindingMissing');
      root = parent;
    }
    if (path.basename(root) !== binding.installedIdentity.skillKey) fail('runtimeConfigIdentityMismatch');
    const callerRelative = path.relative(root, caller).split(path.sep).join('/');
    if (!Object.hasOwn(binding.resources, callerRelative) || !Object.hasOwn(binding.resources, READER)) {
      fail('runtimeConfigIdentityMismatch');
    }
    if (keys.some((key) => !binding.allowedKeys.includes(key))) fail('runtimeConfigKeyDenied');
    if (expectedRevision !== undefined && expectedRevision !== binding.revision) fail('runtimeConfigRevisionMismatch');
    await checkResources(root, binding);
    for (const locator of binding.peerLocators) {
      if (locator.relativeRoot === '.') continue;
      const peerRoot = await assertPathSafe(path.resolve(root, locator.relativeRoot));
      const embedded = locator.relativeRoot.startsWith('.aw-runtime-peers/');
      if (locator.relativeRoot === '../..') {
        if (path.basename(path.dirname(root)) !== '.aw-runtime-peers' || path.basename(peerRoot) !== locator.skillKey) fail('runtimeConfigPathUnsafe');
      } else if (path.dirname(peerRoot) !== (embedded ? path.join(root, '.aw-runtime-peers') : path.dirname(root))) fail('runtimeConfigPathUnsafe');
      const peerFile = await regularFile(peerRoot, BINDING);
      let peer;
      try { peer = validateBinding(JSON.parse(await fs.readFile(peerFile, 'utf8'))); }
      catch (error) { if (error instanceof RuntimeConfigError) throw error; fail('runtimeConfigBindingInvalid'); }
      const expectedIdentity = { ...binding.installedIdentity, artifactId: locator.artifactId, skillKey: locator.skillKey };
      if (JSON.stringify(canonical(peer.installedIdentity)) !== JSON.stringify(canonical(expectedIdentity))) {
        fail('runtimeConfigIdentityMismatch');
      }
      if (peer.revision !== binding.revision) fail('runtimeConfigRevisionMismatch');
      await checkResources(peerRoot, peer);
    }
    return {
      installedIdentity: structuredClone(binding.installedIdentity),
      effectiveValues: Object.fromEntries(keys.filter((key) => Object.hasOwn(binding.effectiveValues, key))
        .map((key) => [key, structuredClone(binding.effectiveValues[key])])),
      revision: binding.revision,
      resourceRoot: root,
      resourceVersion: binding.resourceVersion,
    };
  } catch (error) {
    if (error instanceof RuntimeConfigError) throw error;
    fail('runtimeConfigReadFailed');
  }
}
