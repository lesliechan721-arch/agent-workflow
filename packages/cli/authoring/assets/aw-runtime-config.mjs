import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BINDING = '.aw-runtime-config.json';
const READER = 'scripts/aw-runtime-config.mjs';
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class RuntimeConfigError extends Error {
  constructor(code, detail = 'Installed runtime config is unavailable.') {
    super(`${code}: ${detail} Fix the configuration, then run aw plugin sync <source/plugin> --context <user|project>, or repeat that command with --rebuild.`);
    this.name = 'RuntimeConfigError';
    this.code = code;
    this.recoveryActions = ['sync', 'reinstall'];
  }
}

function fail(code, detail) { throw new RuntimeConfigError(code, detail); }
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
  if (!isRecord(binding) || binding.schemaVersion !== 2 || binding.kind !== 'aw-runtime-config') {
    fail('runtimeConfigVersionUnsupported', 'Expected installed runtime config schemaVersion 2. Rebuild old runtime resources before installing them.');
  }
  if (['definition', 'sources', 'resourceVersion', 'revision', 'digest', 'resources', 'consistencyGroup', 'peerLocators', 'nativeReceiptPath']
    .some((key) => Object.hasOwn(binding, key))) {
    fail('runtimeConfigMigrationRequired', 'Remove v1 runtime metadata and regenerate the schemaVersion 2 binding.');
  }
  const identity = binding.installedIdentity;
  if (!isRecord(identity) || !isRecord(binding.effectiveValues)
    || Object.keys(binding).some((key) => !['schemaVersion', 'kind', 'installedIdentity', 'allowedKeys', 'effectiveValues', 'originPath'].includes(key))
    || !Array.isArray(binding.allowedKeys) || binding.allowedKeys.length === 0
    || binding.allowedKeys.some((key) => typeof key !== 'string' || !key)
    || new Set(binding.allowedKeys).size !== binding.allowedKeys.length
    || Object.values(binding.effectiveValues).some((value) => value === null)) fail('runtimeConfigBindingInvalid');
  for (const key of ['sourceId', 'sourceIdentity', 'pluginId', 'pluginName', 'pluginVersion', 'artifactId', 'skillKey']) {
    if (typeof identity[key] !== 'string' || !identity[key]) fail('runtimeConfigIdentityMismatch');
  }
  if (!['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'gemini', 'copilot', 'grok'].includes(identity.platform) || !['user', 'project'].includes(identity.scope)
    || !['user', 'project'].includes(identity.configScope)
    || identity.pluginId !== `${identity.sourceId}/${identity.pluginName}`
    || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(identity.skillKey)
    || (identity.logicalIdentity !== undefined && (typeof identity.logicalIdentity !== 'string' || !identity.logicalIdentity))) {
    fail('runtimeConfigIdentityMismatch');
  }
  // Core validates field definitions and dependency values when it creates this resource.
  // The reader enforces only this resource's format and permitted projection.
  if (Object.keys(binding.effectiveValues).some((key) => !binding.allowedKeys.includes(key))) fail('runtimeConfigKeyDenied');
  return binding;
}
async function readOrigin(root, binding) {
  if (binding.originPath === undefined) return false;
  if (binding.originPath !== '.aw-runtime-native-receipt.json') fail('runtimeConfigPathUnsafe');
  const originFile = await regularFile(root, binding.originPath);
  let origin;
  try { origin = JSON.parse(await fs.readFile(originFile, 'utf8')); }
  catch { fail('runtimeConfigBindingInvalid'); }
  if (!isRecord(origin) || origin.schemaVersion !== 1 || origin.kind !== 'aw-runtime-component-origin'
    || Object.keys(origin).some((key) => !['schemaVersion', 'kind', 'source', 'platform', 'scope', 'configScope', 'component', 'inputDigest'].includes(key))
    || !isRecord(origin.source) || !isRecord(origin.component)
    || !/^sha256:[0-9a-f]{64}$/u.test(origin.inputDigest ?? '')) fail('runtimeConfigVersionUnsupported');
  const identity = binding.installedIdentity;
  const sourceKeys = ['sourceId', 'sourceIdentity', 'logicalIdentity', 'pluginId', 'pluginName', 'pluginVersion'];
  if (Object.keys(origin.source).some((key) => !sourceKeys.includes(key))
    || sourceKeys.some((key) => origin.source[key] !== identity[key])
    || origin.platform !== identity.platform || origin.scope !== identity.scope || origin.configScope !== identity.configScope
    || Object.keys(origin.component).some((key) => !['id', 'kind', 'name'].includes(key))
    || origin.component.kind !== 'skill' || origin.component.id !== identity.artifactId
    || origin.component.name !== identity.skillKey) fail('runtimeConfigIdentityMismatch');
  return true;
}

async function checkNativePackage(root, identity) {
  // Every current Native projection places Skills directly under its package's skills/ directory.
  // Other ancestors, including a Review workspace's owner, are not this Skill's origin.
  if (path.basename(path.dirname(root)) !== 'skills') return false;
  const packageRoot = path.dirname(path.dirname(root));
  const ownerPath = path.join(packageRoot, '.agent-workflows-owner.json');
  const stat = await fs.lstat(ownerPath).catch(() => null);
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) fail('runtimeConfigIdentityMismatch');
  let owner;
  try { owner = JSON.parse(await fs.readFile(ownerPath, 'utf8')); }
  catch { fail('runtimeConfigIdentityMismatch'); }
  if (!isRecord(owner) || !Object.hasOwn(owner, 'nativeProjection')) return false;
  const projection = owner.nativeProjection;
  if (!isRecord(projection) || !Array.isArray(projection.components) || !isRecord(projection.physicalIdentity)
    || !/^sha256:[0-9a-f]{64}$/u.test(projection.inputDigest ?? '')
    || !/^sha256:[0-9a-f]{64}$/u.test(projection.contentDigest ?? '')) {
    fail('runtimeConfigIdentityMismatch');
  }
  const relativeOutput = `${path.relative(packageRoot, root).split(path.sep).join('/')}/SKILL.md`;
  const component = projection.components.find((entry) => isRecord(entry)
    && Array.isArray(entry.relativeOutputs) && entry.relativeOutputs.includes(relativeOutput));
  if (!component) return false;
  const physical = projection.physicalIdentity;
  if (owner.schemaVersion !== 3 || owner.owner !== 'agent-workflows'
    || owner.sourceId !== identity.sourceId || owner.sourceIdentity !== identity.sourceIdentity
    || owner.pluginId !== identity.pluginId || owner.plugin !== identity.pluginName
    || owner.platform !== identity.platform || owner.scope !== identity.scope || owner.scope !== identity.configScope
    || physical.sourceIdentity !== identity.sourceIdentity || physical.pluginId !== identity.pluginId
    || physical.platform !== identity.platform
    || component.id !== identity.artifactId || component.nativeName !== path.basename(root)
    || component.nativeName !== identity.skillKey) fail('runtimeConfigIdentityMismatch');
  return true;
}

/** Read this Skill's installed effective values from its actual calling resource. */
export async function readRuntimeConfig(options = {}) {
  try {
    if (Object.hasOwn(options, 'expectedRevision')) {
      fail('runtimeConfigMigrationRequired', 'expectedRevision is no longer supported. Call readRuntimeConfig with from and keys only.');
    }
    const { from, keys } = options;
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string' || !key) || new Set(keys).size !== keys.length) {
      fail('runtimeConfigKeyDenied');
    }
    let caller;
    try { caller = from instanceof URL || (typeof from === 'string' && from.startsWith('file:'))
      ? fileURLToPath(from) : from; } catch { fail('runtimeConfigPathUnsafe'); }
    if (typeof caller !== 'string' || !path.isAbsolute(caller)) fail('runtimeConfigPathUnsafe');
    caller = await assertPathSafe(caller);
    const callerStat = await fs.lstat(caller);
    if (!callerStat.isFile()) fail('runtimeConfigPathUnsafe');
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
    await regularFile(root, path.relative(root, caller).split(path.sep).join('/'));
    await regularFile(root, READER);
    await regularFile(root, 'SKILL.md');
    if (keys.some((key) => !binding.allowedKeys.includes(key))) fail('runtimeConfigKeyDenied');
    const origin = await readOrigin(root, binding);
    const installed = await checkNativePackage(root, binding.installedIdentity);
    if (!origin && !installed) fail('runtimeConfigIdentityMismatch');
    return {
      installedIdentity: structuredClone(binding.installedIdentity),
      effectiveValues: Object.fromEntries(keys.filter((key) => Object.hasOwn(binding.effectiveValues, key))
        .map((key) => [key, structuredClone(binding.effectiveValues[key])])),
      resourceRoot: root,
    };
  } catch (error) {
    if (error instanceof RuntimeConfigError) throw error;
    fail('runtimeConfigReadFailed');
  }
}
