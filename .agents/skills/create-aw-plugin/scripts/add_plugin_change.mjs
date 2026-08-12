#!/usr/bin/env node

import crypto from 'node:crypto';
import * as path from 'node:path';

import { PLUGIN_VERSION_BUMPS } from './lib/semver.mjs';
import { writePluginReleaseIntent } from './lib/plugin-release-intents.mjs';

function fail(message) {
  throw new Error(message);
}

function readOptionValue(args, index, flag) {
  const current = args[index];
  const eqIndex = current.indexOf('=');
  if (eqIndex >= 0) return { value: current.slice(eqIndex + 1), nextIndex: index };
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${flag} requires a value.`);
  return { value, nextIndex: index + 1 };
}

function printUsage() {
  console.log(`Usage:
  node .agents/skills/create-aw-plugin/scripts/add_plugin_change.mjs <plugin-name> \\
    --bump major|minor|patch --summary <text> [--id <id>] [--repo-root .]
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = { repoRoot: '.' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (!arg.startsWith('--')) {
      if (!options.plugin) {
        options.plugin = arg;
        continue;
      }
      fail(`Unexpected positional argument: ${arg}`);
    }
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const { value, nextIndex } = readOptionValue(args, index, flag);
    index = nextIndex;
    if (flag === '--bump') options.bump = value;
    else if (flag === '--summary') options.summary = value;
    else if (flag === '--id') options.id = value;
    else if (flag === '--repo-root') options.repoRoot = value;
    else fail(`Unknown option: ${flag}`);
  }
  if (!options.plugin) fail('plugin-name is required.');
  if (!PLUGIN_VERSION_BUMPS.has(options.bump)) fail('--bump must be major, minor, or patch.');
  if (!options.summary) fail('--summary is required.');
  return options;
}

try {
  const args = parseArgs(process.argv);
  const id = args.id ?? `${args.plugin}-${crypto.randomUUID().slice(0, 8)}`;
  const filePath = await writePluginReleaseIntent(path.resolve(args.repoRoot), {
    plugin: args.plugin,
    bump: args.bump,
    summary: args.summary,
    id,
  });
  console.log(`[OK] Added plugin release intent: ${filePath}`);
} catch (error) {
  console.error(`[ERROR] ${error.message}`);
  process.exit(1);
}
