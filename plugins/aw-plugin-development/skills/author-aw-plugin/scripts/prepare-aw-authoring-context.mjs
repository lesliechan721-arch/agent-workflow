#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
const COMPONENT_TYPES = new Set([
  'skill',
  'extension',
  'slash-command',
  'mcp',
  'app',
  'dynamic-artifact',
  'unknown',
]);
const VERSION_BUMPS = new Set(['major', 'minor', 'patch']);
const SKILL_INVOCATIONS = new Set(['model', 'manual', 'claude-model-only']);

function fail(message) {
  throw new Error(message);
}

function usage() {
  process.stdout.write([
    'Usage:',
    '  node prepare-aw-authoring-context.mjs <plugin-root> [options]',
    '',
    'Options:',
    '  --plugin <name>            Required only when the manifest does not exist.',
    '  --change-mode <mode>       create or change. Inferred from the manifest by default.',
    '  --component-type <type>    Skill, extension, slash-command, MCP, app, dynamic-artifact, or unknown.',
    '  --skill-invocation <mode>  model, manual, or claude-model-only. Skill default: model.',
    '  --repo-root <path>         Target AW workspace root. Default: current directory.',
    '  --allowed-file <path>      Add an authorized file or directory. Repeatable.',
    '  --product <name>           CODEX or CLAUDE. Repeatable.',
    '  --source-profile <id>      Default: aw-default.',
    '  --manifest-version-bump <major|minor|patch>',
    '  --no-build                 Mark the build as not required.',
    '  --validator <command>      Add one workspace validator. Repeatable.',
    '  -h, --help                 Show this help.',
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
    plugin: null,
    changeMode: null,
    componentType: 'unknown',
    allowedFiles: [],
    products: [],
    sourceProfile: 'aw-default',
    manifestVersionBump: null,
    buildRequired: true,
    repoRoot: process.cwd(),
    skillInvocation: null,
    validators: [],
  };
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--no-build') {
      options.buildRequired = false;
      continue;
    }
    const value = optionValue(args, index, flag);
    index += 1;
    if (flag === '--plugin') options.plugin = value;
    else if (flag === '--change-mode') options.changeMode = value;
    else if (flag === '--component-type') options.componentType = value;
    else if (flag === '--skill-invocation') options.skillInvocation = value;
    else if (flag === '--repo-root') options.repoRoot = path.resolve(value);
    else if (flag === '--allowed-file') options.allowedFiles.push(value);
    else if (flag === '--product') options.products.push(value.toUpperCase());
    else if (flag === '--source-profile') options.sourceProfile = value;
    else if (flag === '--manifest-version-bump') options.manifestVersionBump = value;
    else if (flag === '--validator') options.validators.push(value);
    else fail('Unknown option: ' + flag);
  }
  if (options.changeMode && !['create', 'change'].includes(options.changeMode)) {
    fail('--change-mode must be create or change.');
  }
  if (!COMPONENT_TYPES.has(options.componentType)) {
    fail('Unsupported --component-type: ' + options.componentType);
  }
  if (options.manifestVersionBump && !VERSION_BUMPS.has(options.manifestVersionBump)) {
    fail('--manifest-version-bump must be major, minor, or patch.');
  }
  if (options.products.some((product) => !['CODEX', 'CLAUDE'].includes(product))) {
    fail('--product must be CODEX or CLAUDE.');
  }
  if (options.skillInvocation && !SKILL_INVOCATIONS.has(options.skillInvocation)) {
    fail('--skill-invocation must be model, manual, or claude-model-only.');
  }
  if (options.componentType !== 'skill' && options.skillInvocation) {
    fail('--skill-invocation requires --component-type skill.');
  }
  if (options.componentType === 'skill' && !options.skillInvocation) {
    options.skillInvocation = 'model';
  }
  options.pluginRoot = path.isAbsolute(options.pluginRoot)
    ? path.resolve(options.pluginRoot)
    : path.resolve(options.repoRoot, options.pluginRoot);
  return options;
}

async function readManifest(pluginRoot) {
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail('Cannot read plugin manifest: ' + manifestPath + ': ' + error.message);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  const manifest = await readManifest(options.pluginRoot);
  const changeMode = options.changeMode ?? (manifest ? 'change' : 'create');
  const plugin = options.plugin ?? manifest?.name;
  if (!plugin) fail('--plugin is required when the plugin manifest does not exist.');
  if (manifest?.name && options.plugin && options.plugin !== manifest.name) {
    fail('--plugin does not match the existing plugin manifest name.');
  }
  if (changeMode === 'change' && !manifest) {
    fail('change mode requires an existing plugin manifest.');
  }

  let products = options.products.length > 0
    ? [...new Set(options.products)]
    : manifest?.marketplace?.policy?.products ?? ['CODEX', 'CLAUDE'];
  if (options.skillInvocation === 'claude-model-only') {
    if (options.products.some((product) => product !== 'CLAUDE')) {
      fail('claude-model-only invocation cannot target CODEX.');
    }
    products = ['CLAUDE'];
  }
  const validators = options.validators;

  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    repository: path.basename(options.repoRoot) || 'aw-workspace',
    plugin,
    pluginRoot: options.pluginRoot,
    changeMode,
    products,
    componentType: options.componentType,
    skillInvocation: options.skillInvocation,
    allowedFiles: options.allowedFiles,
    sourceProfile: options.sourceProfile,
    manifestVersionBump: options.manifestVersionBump,
    buildRequired: options.buildRequired,
    validators,
  }, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write('[ERROR] ' + error.message + '\n');
  process.exit(1);
});
