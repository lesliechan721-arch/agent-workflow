#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_DIR = 'plugin-config';
const LOCAL_CONFIG_DIR = 'plugin-config.local';
const CONFIG_FILE = 'config.json';
const SUPPORTED_TYPES = new Set(['string', 'number', 'boolean', 'object']);
const REDACTED = '[redacted]';
const SOURCE_IDENTITY_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createPropertyMap() {
  return Object.create(null);
}

function ownProperty(value, property) {
  return isRecord(value) && Object.hasOwn(value, property) ? value[property] : undefined;
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
    fail(`Unable to parse ${label} as JSON.`);
  }
}

function safePluginSegment(pluginName) {
  if (typeof pluginName !== 'string' || pluginName.trim() === '') {
    fail('Invalid plugin config segment.');
  }
  if (
    pluginName !== pluginName.trim() ||
    pluginName === '.' ||
    pluginName === '..' ||
    pluginName.includes('/') ||
    pluginName.includes('\\') ||
    path.posix.isAbsolute(pluginName) ||
    path.win32.isAbsolute(pluginName) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(pluginName)
  ) {
    fail('Invalid plugin config segment.');
  }
  return pluginName;
}

function validateConfigSchema(rawSchema) {
  if (!isRecord(rawSchema)) {
    fail('Plugin manifest does not declare a valid AW config schema.');
  }

  const schema = createPropertyMap();
  for (const [key, rawField] of Object.entries(rawSchema)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      fail('Plugin manifest declares an invalid config key.');
    }
    if (!isRecord(rawField)) {
      fail(`Config schema field "${key}" must be an object.`);
    }

    const allowed = new Set([
      'type',
      'title',
      'description',
      'default',
      'required',
      'sensitive',
      'choices',
      'validation',
      'properties',
      'additionalProperties',
    ]);
    for (const fieldKey of Object.keys(rawField)) {
      if (!allowed.has(fieldKey)) {
        fail(`Config schema field "${key}" contains an unsupported property.`);
      }
    }

    if (typeof rawField.type !== 'string' || !SUPPORTED_TYPES.has(rawField.type)) {
      fail(`Config schema field "${key}" has an unsupported type.`);
    }
    if (rawField.required !== undefined && typeof rawField.required !== 'boolean') {
      fail(`Config schema field "${key}" has an invalid required flag.`);
    }
    if (rawField.sensitive !== undefined && typeof rawField.sensitive !== 'boolean') {
      fail(`Config schema field "${key}" has an invalid sensitive flag.`);
    }
    schema[key] = structuredClone(rawField);
  }
  return schema;
}

function validateManifest(rawManifest) {
  if (!isRecord(rawManifest)) {
    fail('Bundle manifest is not a JSON object.');
  }
  const pluginName = safePluginSegment(rawManifest.name);
  if (!isRecord(rawManifest.config) || !isRecord(rawManifest.config.fields)) {
    fail(`Plugin "${pluginName}" does not declare an AW config schema.`);
  }
  return {
    pluginName,
    schema: validateConfigSchema(rawManifest.config.fields),
  };
}

function locateBundleManifest() {
  let currentDir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifestPath = path.join(currentDir, '.agents-plugin', 'plugin.json');
    if (fs.existsSync(manifestPath)) {
      return {
        bundleRoot: currentDir,
        manifestPath,
      };
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      fail('Unable to locate bundle .agents-plugin/plugin.json.');
    }
    currentDir = parentDir;
  }
}

function resolveAwProjectRoot(cwd) {
  let currentDir = path.resolve(cwd);
  while (true) {
    if (
      fs.existsSync(path.join(currentDir, '.git')) ||
      fs.existsSync(path.join(currentDir, 'pnpm-workspace.yaml'))
    ) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return path.resolve(cwd);
    }
    currentDir = parentDir;
  }
}

function resolveAwHome() {
  return process.env.AW_HOME || path.join(os.homedir(), '.aw');
}

function resolveConfigStorePath(sourceId, pluginName, scope, cwd) {
  if (scope === 'user') {
    return path.join(resolveAwHome(), CONFIG_DIR, sourceId, pluginName, CONFIG_FILE);
  }
  const projectRoot = resolveAwProjectRoot(cwd);
  if (scope === 'projectLocal') {
    return path.join(projectRoot, '.agent-workflows', LOCAL_CONFIG_DIR, sourceId, pluginName, CONFIG_FILE);
  }
  return path.join(projectRoot, '.agent-workflows', CONFIG_DIR, sourceId, pluginName, CONFIG_FILE);
}

function readStore(filePath, identity) {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, exists: false, values: {} };
  }
  const envelope = readJsonFile(filePath, 'plugin config store');
  if (
    !isRecord(envelope) ||
    envelope.schemaVersion !== 2 ||
    envelope.sourceId !== identity.sourceId ||
    envelope.sourceIdentity !== identity.sourceIdentity ||
    envelope.pluginName !== identity.pluginName ||
    !isRecord(envelope.values)
  ) {
    fail('Plugin config store does not match its schema 2 source identity.');
  }
  return { path: filePath, exists: true, values: envelope.values };
}

function stableValue(value) {
  if (!isRecord(value)) return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  ));
}

function validateChoices(key, field, value) {
  if (
    field.choices?.allowCustom === false &&
    !field.choices.presets.some((preset) => stableValue(preset.value) === stableValue(value))
  ) {
    fail(`Config "${key}" must match a declared preset.`);
  }
}

function validateString(key, field, value) {
  if (typeof value !== 'string') fail(`Config "${key}" must be a string.`);
  const length = [...value].length;
  if (field.validation?.minLength !== undefined && length < field.validation.minLength) {
    fail(`Config "${key}" is shorter than the allowed minimum.`);
  }
  if (field.validation?.maxLength !== undefined && length > field.validation.maxLength) {
    fail(`Config "${key}" is longer than the allowed maximum.`);
  }
  if (field.validation?.pattern !== undefined && !new RegExp(field.validation.pattern, 'u').test(value)) {
    fail(`Config "${key}" does not match the required pattern.`);
  }
  return value;
}

function coerceScalar(key, field, value) {
  if (field.type === 'string') {
    const stringValue = validateString(key, field, value);
    validateChoices(key, field, stringValue);
    return stringValue;
  }
  if (field.type === 'number') {
    const numberValue = typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
    if (!Number.isFinite(numberValue)) fail(`Config "${key}" must be a number.`);
    if (field.validation?.integer === true && !Number.isInteger(numberValue)) {
      fail(`Config "${key}" must be an integer.`);
    }
    if (field.validation?.minimum !== undefined && numberValue < field.validation.minimum) {
      fail(`Config "${key}" is smaller than the allowed minimum.`);
    }
    if (field.validation?.maximum !== undefined && numberValue > field.validation.maximum) {
      fail(`Config "${key}" is greater than the allowed maximum.`);
    }
    if (
      field.validation?.multipleOf !== undefined &&
      Math.abs(numberValue / field.validation.multipleOf - Math.round(numberValue / field.validation.multipleOf)) > 1e-9
    ) {
      fail(`Config "${key}" is not an allowed multiple.`);
    }
    validateChoices(key, field, numberValue);
    return numberValue;
  }
  if (field.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
      if (['false', '0', 'no', 'n'].includes(normalized)) return false;
    }
    fail(`Config "${key}" must be a boolean.`);
  }
  fail(`Config "${key}" has an unsupported type.`);
}

function coerceValue(key, field, value) {
  if (field.type !== 'object') return coerceScalar(key, field, value);
  if (!isRecord(value)) fail(`Config "${key}" must be an object.`);
  const entries = Object.entries(value);
  if (entries.length > 32) fail(`Config "${key}" has too many properties.`);
  if (field.validation?.minProperties !== undefined && entries.length < field.validation.minProperties) {
    fail(`Config "${key}" has fewer than the allowed properties.`);
  }
  if (field.validation?.maxProperties !== undefined && entries.length > field.validation.maxProperties) {
    fail(`Config "${key}" has more than the allowed properties.`);
  }
  for (const [property, child] of Object.entries(field.properties ?? {})) {
    if (child.required === true && !Object.hasOwn(value, property)) {
      fail(`Config "${key}.${property}" is required.`);
    }
  }
  const result = createPropertyMap();
  for (const [property, childValue] of entries) {
    if (field.validation?.key !== undefined) {
      validateString(`${key}.${property}`, { type: 'string', validation: field.validation.key }, property);
    }
    const child = ownProperty(field.properties, property) ?? field.additionalProperties;
    if (!child) fail(`Config "${key}.${property}" is not allowed.`);
    result[property] = coerceScalar(`${key}.${property}`, child, childValue);
  }
  validateChoices(key, field, result);
  return result;
}

function applyLayer(state, schema, entries, source) {
  for (const [key, field] of Object.entries(schema)) {
    if (!Object.hasOwn(entries, key)) continue;
    const value = coerceValue(key, field, entries[key]);
    state.values[key] = value;
    state.redactedValues[key] = field.sensitive
      ? REDACTED
      : field.type === 'object'
        ? Object.fromEntries(Object.entries(value).map(([property, childValue]) => [
            property,
            ownProperty(field.properties, property)?.sensitive === true ||
              (ownProperty(field.properties, property) === undefined && field.additionalProperties?.sensitive === true)
              ? REDACTED
              : childValue,
          ]))
        : value;
    state.sources[key] = source;
  }
}

function buildState(schema) {
  const sources = createPropertyMap();
  for (const key of Object.keys(schema)) {
    sources[key] = 'missing';
  }
  return {
    values: createPropertyMap(),
    redactedValues: createPropertyMap(),
    sources,
    ignoredUnknownKeys: [],
    issues: [],
  };
}

function collectUnknownKeys(state, schema, store, scope) {
  const schemaKeys = new Set(Object.keys(schema));
  for (const key of Object.keys(store.values)) {
    if (!schemaKeys.has(key)) {
      state.ignoredUnknownKeys.push({ scope, key });
    }
  }
}

function addMissingRequiredIssues(state, schema) {
  for (const [key, field] of Object.entries(schema)) {
    if (field.required && state.values[key] === undefined) {
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
  const state = buildState(schema);
  if (scope === 'effective') {
    for (const [key, field] of Object.entries(schema)) {
      if (field.default !== undefined) {
        applyLayer(state, { [key]: field }, { [key]: field.default }, 'default');
      }
    }
    for (const [storeKey, source] of [
      ['user', 'user'],
      ['project', 'projectShared'],
      ['projectLocal', 'projectLocal'],
    ]) {
      collectUnknownKeys(state, schema, stores[storeKey], source);
      applyLayer(state, schema, stores[storeKey].values, source);
    }
    addMissingRequiredIssues(state, schema);
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
    diagnostics: {
      issues: state.issues,
      ignoredUnknownKeys: state.ignoredUnknownKeys,
    },
    paths: {
      configStores: {
        user: stores.user.path,
        project: stores.project.path,
        projectLocal: stores.projectLocal.path,
      },
    },
  };
}

function normalizeContextConfig(context) {
  if (!isRecord(context) || !isRecord(context.config)) {
    fail('AW_PLUGIN_CONTEXT does not contain config data.');
  }
  const schema = validateConfigSchema(context.config.schema);
  const pluginName = safePluginSegment(
    context.plugin?.name || context.pluginName || context.config.pluginName || 'plugin',
  );
  const sourceId = context.plugin?.sourceId;
  const sourceIdentity = context.plugin?.sourceIdentity;
  if ((sourceId === undefined) !== (sourceIdentity === undefined)) {
    fail('AW_PLUGIN_CONTEXT contains an incomplete source identity.');
  }
  const identity = sourceId === undefined
    ? null
    : {
        pluginName,
        sourceId: safePluginSegment(sourceId),
        sourceIdentity,
      };
  if (identity && !SOURCE_IDENTITY_PATTERN.test(identity.sourceIdentity)) {
    fail('AW_PLUGIN_CONTEXT contains an invalid source identity.');
  }
  return { pluginName, schema, identity };
}

function resolveFromContext(scope) {
  const contextPath = process.env.AW_PLUGIN_CONTEXT;
  if (!contextPath) return null;

  const context = readJsonFile(contextPath, 'AW_PLUGIN_CONTEXT');
  const { pluginName, schema, identity } = normalizeContextConfig(context);

  if (scope === 'effective') {
    const state = buildState(schema);
    const values = isRecord(context.config.values) ? context.config.values : {};
    const sources = isRecord(context.config.sources) ? context.config.sources : {};
    applyLayer(state, schema, values, 'context');
    for (const key of Object.keys(schema)) {
      const source = ownProperty(sources, key);
      if (typeof source === 'string') {
        state.sources[key] = source;
      }
    }
    for (const key of Object.keys(values)) {
      if (!Object.hasOwn(schema, key)) {
        state.ignoredUnknownKeys.push({ scope: 'context', key });
      }
    }
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
        ignoredUnknownKeys: [
          ...(Array.isArray(context.config.ignoredUnknownKeys) ? context.config.ignoredUnknownKeys : []),
          ...state.ignoredUnknownKeys,
        ],
      },
      paths: {
        configStores: isRecord(context.paths?.configStores) ? context.paths.configStores : {},
      },
    };
  }

  const storePath = context.paths?.configStores?.[scope];
  if (typeof storePath !== 'string' || storePath.trim() === '') {
    fail(`AW_PLUGIN_CONTEXT does not provide a ${scope} config store path.`);
  }
  if (!identity) {
    fail('AW_PLUGIN_CONTEXT must provide a source identity for scoped config reads.');
  }
  const store = readStore(storePath, identity);
  return resolveFromStores({
    identity,
    schema,
    scope,
    stores: {
      user: scope === 'user' ? store : { path: '', exists: false, values: {} },
      project: scope === 'project' ? store : { path: '', exists: false, values: {} },
      projectLocal: scope === 'projectLocal' ? store : { path: '', exists: false, values: {} },
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
  const sourceId = safePluginSegment(marketplace.sourceId);
  const sourceIdentity = marketplace.sourceIdentity;
  if (
    marketplace.schemaVersion !== 2 ||
    sourceId !== path.basename(marketplaceRoot) ||
    typeof sourceIdentity !== 'string' ||
    !SOURCE_IDENTITY_PATTERN.test(sourceIdentity) ||
    !['aw', `aw-${sourceId}`].includes(marketplace.marketplaceName)
  ) {
    fail('Marketplace config does not contain a canonical schema 2 source identity.');
  }
  const identity = { sourceId, sourceIdentity, pluginName };
  const cwd = process.cwd();
  const projectRoot = resolveAwProjectRoot(cwd);
  for (const legacyPath of [
    path.join(resolveAwHome(), CONFIG_DIR, pluginName, CONFIG_FILE),
    path.join(projectRoot, '.agent-workflows', CONFIG_DIR, pluginName, CONFIG_FILE),
    path.join(projectRoot, '.agent-workflows', LOCAL_CONFIG_DIR, pluginName, CONFIG_FILE),
  ]) {
    if (fs.existsSync(legacyPath)) {
      fail('Legacy non-namespaced plugin config is not supported.');
    }
  }
  const stores = {
    user: readStore(resolveConfigStorePath(sourceId, pluginName, 'user', cwd), identity),
    project: readStore(resolveConfigStorePath(sourceId, pluginName, 'project', cwd), identity),
    projectLocal: readStore(resolveConfigStorePath(sourceId, pluginName, 'projectLocal', cwd), identity),
  };
  return resolveFromStores({ identity, schema, scope, stores });
}

function printUsage() {
  process.stdout.write(`Usage:
  node aw-config.mjs get <key> [--scope effective|user|project|project-local]
  node aw-config.mjs json [--scope effective|user|project|project-local]

Options:
  --scope <scope>  Read effective, user, project, or project-local config. Default: effective.
  -h, --help       Show this help message.
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args.shift();
  if (command === '-h' || command === '--help') {
    printUsage();
    process.exit(0);
  }
  let scope = 'effective';
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--scope') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) fail('--scope requires a value.');
      scope = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--scope=')) {
      scope = arg.slice('--scope='.length);
      continue;
    }
    positional.push(arg);
  }

  if (scope === 'project-local') scope = 'projectLocal';
  if (!['effective', 'user', 'project', 'projectLocal'].includes(scope)) {
    fail('--scope must be effective, user, project, or project-local.');
  }
  if (command !== 'get' && command !== 'json') {
    fail('Usage: node aw-config.mjs get <key> [--scope effective|user|project|project-local] | json [--scope effective|user|project|project-local]');
  }
  if (command === 'get' && positional.length !== 1) {
    fail('Usage: node aw-config.mjs get <key> [--scope effective|user|project|project-local]');
  }
  if (command === 'json' && positional.length !== 0) {
    fail('Usage: node aw-config.mjs json [--scope effective|user|project|project-local]');
  }
  return { command, key: positional[0], scope };
}

function renderGet(result, key) {
  if (!Object.hasOwn(result.schema, key)) {
    fail(`Unknown config key "${key}".`);
  }
  if (!Object.hasOwn(result.values, key)) {
    fail(`Config key "${key}" is not set.`);
  }
  const value = result.values[key];
  return typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value)}\n`;
}

function main() {
  const args = parseArgs(process.argv);
  const result = resolveFromContext(args.scope) || resolveFallback(args.scope);
  const output = args.command === 'get'
    ? renderGet(result, args.key)
    : `${JSON.stringify(result, null, 2)}\n`;
  process.stdout.write(output);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[aw-config] ${message}\n`);
  process.exit(1);
}
