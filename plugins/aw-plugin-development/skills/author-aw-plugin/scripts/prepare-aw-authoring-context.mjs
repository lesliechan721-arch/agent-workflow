#!/usr/bin/env node

import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const COMPONENT_TYPES = new Set([
  'manifest', 'skill', 'extension', 'slash-command', 'mcp', 'app', 'dynamic-artifact',
  'config-helper', 'pre-apply', 'node-build', 'readme', 'eval-assets',
]);
const OPERATIONS = new Set(['create', 'change', 'remove']);
const PRODUCTS = new Set(['CODEX', 'CLAUDE']);
const SKILL_INVOCATIONS = new Set(['model', 'manual', 'claude-model-only']);

function fail(message) {
  throw new Error(message);
}

function usage() {
  process.stdout.write([
    'Usage:',
    '  node prepare-aw-authoring-context.mjs <plugin-root> --components <json-file> [options]',
    '',
    'Options:',
    '  --components <json-file>  Required JSON array of component requests.',
    '  --mode <mode>              Required: create or edit.',
    '  --plugin <name>            Required in create mode.',
    '  --change-mode <mode>       create or change. Inferred from the manifest by default.',
    '  --workspace-root <path>    Target AW workspace root. Default: current directory.',
    '  --allowed-file <path>      Add an authorized file or directory. Repeatable.',
    '  --product <name>           CODEX or CLAUDE. Repeatable.',
    '  --source-profile <id>      Default: aw-default.',
    '  --no-build                 Mark the build as not required.',
    '  --validator <command>      Add one workspace validator. Repeatable.',
    '  -h, --help                 Show this help.',
    '',
    'AWAuthoringContext v3 migration:',
    '  Replace --component-type and --skill-invocation with --components <json-file>.',
    '',
  ].join('\n'));
}

function optionValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(flag + ' requires a value.');
  return value;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    usage();
    process.exit(0);
  }
  if (!args[0] || args[0].startsWith('--')) fail('Provide <plugin-root>.');

  const options = {
    pluginRoot: args[0],
    componentsFile: null,
    plugin: null,
    mode: null,
    changeMode: null,
    allowedFiles: [],
    products: [],
    sourceProfile: 'aw-default',
    buildRequired: true,
    workspaceRoot: process.cwd(),
    validators: [],
  };
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--component-type' || flag === '--skill-invocation') {
      fail(
        flag +
          ' was removed. Use --components <json-file> with one or more component requests.',
      );
    }
    if (flag === '--no-build') {
      options.buildRequired = false;
      continue;
    }
    const value = optionValue(args, index, flag);
    index += 1;
    if (flag === '--components') options.componentsFile = path.resolve(value);
    else if (flag === '--mode') options.mode = value;
    else if (flag === '--plugin') options.plugin = value;
    else if (flag === '--change-mode') options.changeMode = value;
    else if (flag === '--workspace-root') options.workspaceRoot = path.resolve(value);
    else if (flag === '--allowed-file') options.allowedFiles.push(value);
    else if (flag === '--product') options.products.push(value.toUpperCase());
    else if (flag === '--source-profile') options.sourceProfile = value;
    else if (flag === '--validator') options.validators.push(value);
    else fail('Unknown option: ' + flag);
  }
  if (!options.componentsFile) {
    fail('--components <json-file> is required by AWAuthoringContext v3.');
  }
  if (!['create', 'edit'].includes(options.mode)) {
    fail('--mode must be create or edit.');
  }
  if (options.changeMode && !['create', 'change'].includes(options.changeMode)) {
    fail('--change-mode must be create or change.');
  }
  if (options.products.some((product) => !PRODUCTS.has(product))) {
    fail('--product must be CODEX or CLAUDE.');
  }
  options.pluginRoot = path.isAbsolute(options.pluginRoot)
    ? path.resolve(options.pluginRoot)
    : path.resolve(options.workspaceRoot, options.pluginRoot);
  return options;
}

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    fail('Cannot read ' + label + ': ' + file + ': ' + error.message);
  }
}

async function readManifest(pluginRoot) {
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  try {
    const stats = await lstat(manifestPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      fail('Plugin manifest must be a non-symlink regular file: ' + manifestPath);
    }
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail('Cannot read plugin manifest: ' + manifestPath + ': ' + error.message);
  }
}

async function assertCanonicalPluginRoot(workspaceRoot, pluginRoot, plugin, mode) {
  const workspaceStats = await lstat(workspaceRoot).catch(() => null);
  if (!workspaceStats?.isDirectory() || workspaceStats.isSymbolicLink()) {
    fail('Workspace root must be a non-symlink directory: ' + workspaceRoot);
  }
  let physicalWorkspaceRoot;
  try {
    physicalWorkspaceRoot = await realpath(workspaceRoot);
  } catch (error) {
    fail('Cannot resolve workspace root: ' + error.message);
  }
  const expectedPluginRoot = path.join(physicalWorkspaceRoot, 'plugins', plugin);
  const requestedPluginRoot = path.resolve(
    physicalWorkspaceRoot,
    path.relative(workspaceRoot, pluginRoot),
  );
  if (requestedPluginRoot !== expectedPluginRoot) {
    fail(
      'Plugin root must be the canonical workspace path: ' +
        path.join(workspaceRoot, 'plugins', plugin),
    );
  }
  const pluginsRoot = path.join(physicalWorkspaceRoot, 'plugins');
  const pluginsStats = await lstat(pluginsRoot).catch(() => null);
  if (!pluginsStats?.isDirectory() || pluginsStats.isSymbolicLink()) {
    fail('Workspace plugins root must be a non-symlink directory: ' + pluginsRoot);
  }
  const pluginStats = await lstat(pluginRoot).catch(() => null);
  if (mode === 'create') {
    if (pluginStats !== null) {
      fail('Create mode requires an absent plugin root: ' + pluginRoot);
    }
    return;
  }
  if (!pluginStats?.isDirectory() || pluginStats.isSymbolicLink()) {
    fail('Plugin root must be a non-symlink directory: ' + pluginRoot);
  }
  if (await realpath(pluginRoot) !== expectedPluginRoot) {
    fail('Plugin root must resolve to the canonical workspace path: ' + pluginRoot);
  }
}

function validateStringArray(value, label, allowedValues = null) {
  if (!Array.isArray(value) || value.length === 0) fail(label + ' must be a non-empty array.');
  if (value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    fail(label + ' must contain non-empty strings.');
  }
  if (new Set(value).size !== value.length) fail(label + ' must contain unique values.');
  if (allowedValues && value.some((entry) => !allowedValues.has(entry))) {
    fail(label + ' contains an unsupported value.');
  }
}

function validateComponents(value, products) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('--components must contain a non-empty JSON array.');
  }
  const ids = new Set();
  for (const [index, component] of value.entries()) {
    const label = 'components[' + index + ']';
    if (!component || typeof component !== 'object' || Array.isArray(component)) {
      fail(label + ' must be an object.');
    }
    const allowedKeys = new Set([
      'id', 'type', 'operation', 'paths', 'profiles', 'skillInvocation',
    ]);
    const unknownKey = Object.keys(component).find((key) => !allowedKeys.has(key));
    if (unknownKey) fail(label + ' has unknown property: ' + unknownKey + '.');
    if (typeof component.id !== 'string' || component.id.length === 0) {
      fail(label + '.id must be a non-empty string.');
    }
    if (ids.has(component.id)) fail('Component id must be unique: ' + component.id + '.');
    ids.add(component.id);
    if (!COMPONENT_TYPES.has(component.type)) fail(label + '.type is unsupported.');
    if (!OPERATIONS.has(component.operation)) fail(label + '.operation is unsupported.');
    validateStringArray(component.paths, label + '.paths');
    validateStringArray(component.profiles, label + '.profiles', PRODUCTS);
    if (component.profiles.some((profile) => !products.includes(profile))) {
      fail(label + '.profiles must be supported by the plugin products.');
    }
    if (component.type === 'skill') {
      if (!SKILL_INVOCATIONS.has(component.skillInvocation)) {
        fail(label + '.skillInvocation must be model, manual, or claude-model-only.');
      }
      if (
        component.skillInvocation === 'claude-model-only' &&
        (component.profiles.length !== 1 || component.profiles[0] !== 'CLAUDE')
      ) {
        fail(label + ' with claude-model-only must use profiles ["CLAUDE"].');
      }
    } else if (component.skillInvocation !== undefined && component.skillInvocation !== null) {
      fail(label + '.skillInvocation must be null or omitted for non-skill components.');
    }
    if (
      component.type === 'app' &&
      (component.profiles.length !== 1 || component.profiles[0] !== 'CODEX')
    ) {
      fail(label + ' with app must use profiles ["CODEX"].');
    }
  }
  return value;
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.mode === 'create' && !options.plugin) {
    fail('--plugin is required in create mode.');
  }
  await assertCanonicalPluginRoot(
    options.workspaceRoot,
    options.pluginRoot,
    options.plugin ?? path.basename(options.pluginRoot),
    options.mode,
  );
  const manifest = options.mode === 'edit'
    ? await readManifest(options.pluginRoot)
    : null;
  if (options.mode === 'edit' && !manifest) {
    fail('Edit mode requires an existing plugin manifest.');
  }
  const changeMode = options.changeMode ?? (manifest ? 'change' : 'create');
  const plugin = options.plugin ?? manifest?.name;
  if (!plugin) fail('--plugin is required when the plugin manifest does not exist.');
  if (manifest?.name && options.plugin && options.plugin !== manifest.name) {
    fail('--plugin does not match the existing plugin manifest name.');
  }
  if (options.mode === 'edit') {
    await assertCanonicalPluginRoot(
      options.workspaceRoot,
      options.pluginRoot,
      plugin,
      options.mode,
    );
  }
  if (
    options.changeMode &&
    options.changeMode !== (options.mode === 'create' ? 'create' : 'change')
  ) {
    fail('--change-mode must match --mode.');
  }
  if (changeMode === 'change' && !manifest) {
    fail('change mode requires an existing plugin manifest.');
  }

  const products = options.products.length > 0
    ? [...new Set(options.products)]
    : manifest?.marketplace?.policy?.products ?? ['CODEX', 'CLAUDE'];
  validateStringArray(products, 'products', PRODUCTS);
  const components = validateComponents(
    await readJson(options.componentsFile, 'components JSON'),
    products,
  );

  process.stdout.write(JSON.stringify({
    schemaVersion: 3,
    repository: path.basename(options.workspaceRoot) || 'aw-workspace',
    plugin,
    pluginRoot: options.pluginRoot,
    changeMode,
    products,
    components,
    allowedFiles: options.allowedFiles,
    sourceProfile: options.sourceProfile,
    buildRequired: options.buildRequired,
    validators: options.validators,
  }, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write('[ERROR] ' + error.message + '\n');
  process.exit(1);
});
