#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* @aw-config-core */

const CONFIG_DIR = 'plugin-config';
const CONFIG_FILE = 'config.json';
const SOURCE_IDENTITY_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new Error(message);
}

function readJsonFile(filePath, label) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    fail(`Unable to read ${label}.`);
  }
  try {
    return JSON.parse(content);
  } catch {
    fail(`invalidJson: Unable to parse ${label} as JSON.`);
  }
}

function safeSegment(value) {
  if (typeof value !== 'string' || value.trim() === '') fail('Invalid plugin config segment.');
  if (
    value !== value.trim()
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) fail('Invalid plugin config segment.');
  return value;
}

function normalizeSchema(rawSchema) {
  try {
    return normalizePluginConfigDefinition({ fields: rawSchema }).fields;
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Invalid AW config schema.');
  }
}

function validateManifest(rawManifest) {
  if (!isRecord(rawManifest)) fail('Bundle manifest is not a JSON object.');
  const pluginName = safeSegment(rawManifest.name);
  if (!isRecord(rawManifest.config) || !isRecord(rawManifest.config.fields)) {
    fail(`Plugin "${pluginName}" does not declare an AW config schema.`);
  }
  return { pluginName, schema: normalizeSchema(rawManifest.config.fields) };
}

function locateBundleManifest() {
  let currentDir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifestPath = path.join(currentDir, '.agents-plugin', 'plugin.json');
    if (fs.existsSync(manifestPath)) return { bundleRoot: currentDir, manifestPath };
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) fail('Unable to locate bundle .agents-plugin/plugin.json.');
    currentDir = parentDir;
  }
}

function resolveProjectRoot(cwd) {
  let currentDir = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(currentDir, '.git')) || fs.existsSync(path.join(currentDir, 'pnpm-workspace.yaml'))) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return path.resolve(cwd);
    currentDir = parentDir;
  }
}

function resolveAwHome() {
  return process.env.AW_HOME || path.join(os.homedir(), '.aw');
}

function resolveStorePath(sourceId, pluginName, scope, cwd) {
  const root = scope === 'user'
    ? resolveAwHome()
    : path.join(resolveProjectRoot(cwd), '.agent-workflows');
  return path.join(root, CONFIG_DIR, sourceId, pluginName, CONFIG_FILE);
}

function supportedValue(value) {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return isRecord(value) && Object.values(value).every((child) =>
    typeof child === 'string'
    || typeof child === 'boolean'
    || (typeof child === 'number' && Number.isFinite(child)));
}

function validateValues(values, schema) {
  if (!isRecord(values)) fail('invalidValues: Store values must be an object.');
  for (const [key, value] of Object.entries(values)) {
    if (!supportedValue(value)) fail(`invalidValues: Config "${key}" has an unsupported value.`);
    const field = schema[key];
    if (!field) continue;
    const issues = validatePluginConfigValue(field, value, key);
    if (issues.length > 0) fail(`invalidValues: ${formatPluginConfigIssue(issues[0])}`);
  }
  return values;
}

function missingStore(filePath) {
  return { path: filePath, state: 'missing', exists: false, values: {} };
}

function readStore(filePath, identity, schema) {
  if (!fs.existsSync(filePath)) return missingStore(filePath);
  const envelope = readJsonFile(filePath, 'plugin config store');
  if (!isRecord(envelope) || envelope.schemaVersion !== 3) {
    fail('schemaVersionUnsupported: Only plugin config store schemaVersion 3 is supported.');
  }
  if (
    envelope.sourceId !== identity.sourceId
    || envelope.sourceIdentity !== identity.sourceIdentity
    || envelope.pluginName !== identity.pluginName
  ) fail('identityMismatch: Plugin config store identity does not match its path.');
  return {
    path: filePath,
    state: 'ready',
    exists: true,
    values: validateValues(envelope.values, schema),
  };
}

function createState(schema) {
  return {
    values: Object.create(null),
    redactedValues: Object.create(null),
    sources: Object.fromEntries(Object.keys(schema).map((key) => [key, 'missing'])),
    ignoredUnknownKeys: [],
    issues: [],
  };
}

function applyLayer(state, schema, entries, source) {
  validateValues(entries, schema);
  for (const [key, field] of Object.entries(schema)) {
    if (!Object.hasOwn(entries, key)) continue;
    const value = entries[key];
    state.values[key] = value;
    state.redactedValues[key] = redactPluginConfigValue(field, value);
    state.sources[key] = source;
  }
}

function collectUnknownKeys(state, schema, store, scope) {
  for (const key of Object.keys(store.values)) {
    if (!Object.hasOwn(schema, key)) state.ignoredUnknownKeys.push({ scope, key });
  }
}

function addRequiredIssues(state, schema) {
  for (const [key, field] of Object.entries(schema)) {
    if (field.required === true && !Object.hasOwn(state.values, key)) {
      state.issues.push({
        type: 'missing-required',
        key,
        source: state.sources[key],
        message: `Config "${key}" is required.`,
      });
    }
  }
}

function resolveFromStores({ identity, schema, scope, stores }) {
  const state = createState(schema);
  if (scope === 'effective') {
    for (const [key, field] of Object.entries(schema)) {
      if (field.default !== undefined) applyLayer(state, { [key]: field }, { [key]: field.default }, 'default');
    }
    for (const [storeKey, source] of [['user', 'user'], ['project', 'project']]) {
      collectUnknownKeys(state, schema, stores[storeKey], source);
      applyLayer(state, schema, stores[storeKey].values, source);
    }
    addRequiredIssues(state, schema);
  } else {
    collectUnknownKeys(state, schema, stores[scope], scope);
    applyLayer(state, schema, stores[scope].values, scope);
  }
  return {
    pluginName: identity.pluginName,
    sourceId: identity.sourceId,
    sourceIdentity: identity.sourceIdentity,
    pluginId: `${identity.sourceId}/${identity.pluginName}`,
    scope,
    values: state.values,
    redactedValues: state.redactedValues,
    sources: state.sources,
    schema,
    diagnostics: { issues: state.issues, ignoredUnknownKeys: state.ignoredUnknownKeys },
    paths: { configStores: { user: stores.user.path, project: stores.project.path } },
  };
}

function contextIdentity(context, pluginName) {
  const sourceId = context.plugin?.sourceId;
  const sourceIdentity = context.plugin?.sourceIdentity;
  if ((sourceId === undefined) !== (sourceIdentity === undefined)) {
    fail('AW_PLUGIN_CONTEXT contains an incomplete source identity.');
  }
  if (sourceId === undefined) return null;
  if (typeof sourceIdentity !== 'string' || !SOURCE_IDENTITY_PATTERN.test(sourceIdentity)) {
    fail('AW_PLUGIN_CONTEXT contains an invalid source identity.');
  }
  return { pluginName, sourceId: safeSegment(sourceId), sourceIdentity };
}

function resolveFromContext(scope) {
  const contextPath = process.env.AW_PLUGIN_CONTEXT;
  if (!contextPath) return null;
  const context = readJsonFile(contextPath, 'AW_PLUGIN_CONTEXT');
  if (!isRecord(context) || !isRecord(context.config)) fail('AW_PLUGIN_CONTEXT does not contain config data.');
  const schema = normalizeSchema(context.config.schema);
  const pluginName = safeSegment(context.plugin?.name || context.pluginName || context.config.pluginName || 'plugin');
  const identity = contextIdentity(context, pluginName);
  if (scope === 'effective') {
    const state = createState(schema);
    const values = validateValues(context.config.values, schema);
    applyLayer(state, schema, values, 'missing');
    for (const [key, source] of Object.entries(isRecord(context.config.sources) ? context.config.sources : {})) {
      if (
        Object.hasOwn(schema, key)
        && ['default', 'user', 'project', 'missing'].includes(source)
      ) state.sources[key] = source;
    }
    const contextStorePaths = isRecord(context.paths?.configStores)
      ? context.paths.configStores
      : {};
    return {
      pluginName,
      ...(identity ? {
        sourceId: identity.sourceId,
        sourceIdentity: identity.sourceIdentity,
        pluginId: `${identity.sourceId}/${pluginName}`,
      } : {}),
      scope,
      values: state.values,
      redactedValues: state.redactedValues,
      sources: state.sources,
      schema,
      diagnostics: {
        issues: Array.isArray(context.config.issues) ? context.config.issues : [],
        ignoredUnknownKeys: Array.isArray(context.config.ignoredUnknownKeys)
          ? context.config.ignoredUnknownKeys : [],
      },
      paths: {
        configStores: {
          ...(typeof contextStorePaths.user === 'string' ? { user: contextStorePaths.user } : {}),
          ...(typeof contextStorePaths.project === 'string' ? { project: contextStorePaths.project } : {}),
        },
      },
    };
  }
  if (!identity) fail('AW_PLUGIN_CONTEXT must provide a source identity for scoped config reads.');
  const storePath = context.paths?.configStores?.[scope];
  if (typeof storePath !== 'string' || storePath.trim() === '') {
    fail(`AW_PLUGIN_CONTEXT does not provide a ${scope} config store path.`);
  }
  const store = readStore(storePath, identity, schema);
  return resolveFromStores({
    identity,
    schema,
    scope,
    stores: {
      user: scope === 'user' ? store : missingStore(''),
      project: scope === 'project' ? store : missingStore(''),
    },
  });
}

function resolveFallback(scope) {
  const { bundleRoot, manifestPath } = locateBundleManifest();
  const { pluginName, schema } = validateManifest(readJsonFile(manifestPath, 'bundle manifest'));
  const pluginsRoot = path.dirname(bundleRoot);
  const marketplaceRoot = path.dirname(pluginsRoot);
  if (path.basename(pluginsRoot) !== 'plugins' || path.basename(bundleRoot) !== pluginName) {
    fail('Bundle manifest is not inside a namespaced local marketplace.');
  }
  const marketplace = readJsonFile(path.join(marketplaceRoot, 'config.json'), 'marketplace config');
  const sourceId = safeSegment(marketplace.sourceId);
  const sourceIdentity = marketplace.sourceIdentity;
  if (
    marketplace.schemaVersion !== 2
    || sourceId !== path.basename(marketplaceRoot)
    || typeof sourceIdentity !== 'string'
    || !SOURCE_IDENTITY_PATTERN.test(sourceIdentity)
    || !['aw', `aw-${sourceId}`].includes(marketplace.marketplaceName)
  ) fail('Marketplace config does not contain a canonical schema 2 source identity.');
  const identity = { sourceId, sourceIdentity, pluginName };
  const cwd = process.cwd();
  const projectRoot = resolveProjectRoot(cwd);
  for (const legacyPath of [
    path.join(resolveAwHome(), CONFIG_DIR, pluginName, CONFIG_FILE),
    path.join(projectRoot, '.agent-workflows', CONFIG_DIR, pluginName, CONFIG_FILE),
  ]) {
    if (fs.existsSync(legacyPath)) fail('Legacy non-namespaced plugin config is not supported.');
  }
  const stores = {
    user: readStore(resolveStorePath(sourceId, pluginName, 'user', cwd), identity, schema),
    project: readStore(resolveStorePath(sourceId, pluginName, 'project', cwd), identity, schema),
  };
  return resolveFromStores({ identity, schema, scope, stores });
}

function printUsage() {
  process.stdout.write(`Usage:
  node aw-config.mjs get <key> [--scope effective|user|project]
  node aw-config.mjs json [--scope effective|user|project]

Options:
  --scope <scope>  Read effective, user, or project config. Default: effective.
  -h, --help       Show this help message.
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args.shift();
  if (command === '-h' || command === '--help') return { help: true };
  let scope = 'effective';
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--scope') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) fail('--scope requires a value.');
      scope = value;
      index += 1;
    } else if (arg.startsWith('--scope=')) {
      scope = arg.slice('--scope='.length);
    } else {
      positional.push(arg);
    }
  }
  if (!['effective', 'user', 'project'].includes(scope)) fail('--scope must be effective, user, or project.');
  if (command !== 'get' && command !== 'json') fail('Usage: node aw-config.mjs get <key> | json');
  if (command === 'get' && positional.length !== 1) fail('Usage: node aw-config.mjs get <key>');
  if (command === 'json' && positional.length !== 0) fail('Usage: node aw-config.mjs json');
  return { command, key: positional[0], scope };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    return;
  }
  const result = resolveFromContext(args.scope) || resolveFallback(args.scope);
  if (args.command === 'get') {
    if (!Object.hasOwn(result.schema, args.key)) fail(`Unknown config key "${args.key}".`);
    if (!Object.hasOwn(result.values, args.key)) fail(`Config key "${args.key}" is not set.`);
    const value = result.redactedValues[args.key];
    process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ ...result, values: result.redactedValues }, null, 2)}\n`);
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  }
}

if (isDirectExecution()) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[aw-config] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
