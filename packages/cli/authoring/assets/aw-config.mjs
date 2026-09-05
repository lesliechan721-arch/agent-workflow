#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new Error(message);
}

function readContext() {
  const contextPath = process.env.AW_PLUGIN_CONTEXT;
  if (!contextPath) fail('AW_PLUGIN_CONTEXT is required.');

  let context;
  try {
    context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  } catch {
    fail('Unable to read AW_PLUGIN_CONTEXT as JSON.');
  }
  if (
    !isRecord(context)
    || !isRecord(context.plugin)
    || typeof context.plugin.name !== 'string'
    || context.plugin.name.trim() === ''
    || !isRecord(context.config)
    || !isRecord(context.config.schema)
    || !isRecord(context.config.values)
  ) {
    fail('AW_PLUGIN_CONTEXT does not contain config data.');
  }
  return context;
}

function redactValues(schema, values) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    isRecord(schema[key]) && schema[key].sensitive === true ? '[redacted]' : value,
  ]));
}

function resolveConfig(scope) {
  if (scope !== 'effective') {
    fail('AW_PLUGIN_CONTEXT only supports effective config reads; use aw config for user or project scope.');
  }
  const context = readContext();
  const schema = context.config.schema;
  const values = Object.fromEntries(
    Object.entries(context.config.values).filter(([key]) => Object.hasOwn(schema, key)),
  );
  const sources = isRecord(context.config.sources)
    ? Object.fromEntries(
        Object.entries(context.config.sources).filter(([key]) => Object.hasOwn(schema, key)),
      )
    : {};
  const identity = {
    ...(typeof context.plugin.sourceId === 'string' ? { sourceId: context.plugin.sourceId } : {}),
    ...(typeof context.plugin.sourceIdentity === 'string'
      ? { sourceIdentity: context.plugin.sourceIdentity }
      : {}),
    ...(typeof context.plugin.logicalIdentity === 'string'
      ? { logicalIdentity: context.plugin.logicalIdentity }
      : {}),
    ...(typeof context.plugin.pluginId === 'string' ? { pluginId: context.plugin.pluginId } : {}),
  };
  return {
    pluginName: context.plugin.name,
    ...identity,
    scope,
    values,
    redactedValues: redactValues(schema, values),
    sources,
    schema,
    diagnostics: {
      issues: Array.isArray(context.config.issues) ? context.config.issues : [],
      ignoredUnknownKeys: Array.isArray(context.config.ignoredUnknownKeys)
        ? context.config.ignoredUnknownKeys
        : [],
    },
    paths: { configStores: {} },
  };
}

function printUsage() {
  process.stdout.write(`Usage:
  node aw-config.mjs get <key> [--scope effective]
  node aw-config.mjs json [--scope effective]

Options:
  --scope <scope>  Read effective config from AW_PLUGIN_CONTEXT. Default: effective.
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
  const result = resolveConfig(args.scope);
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
