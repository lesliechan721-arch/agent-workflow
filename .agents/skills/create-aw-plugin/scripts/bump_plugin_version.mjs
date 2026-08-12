#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';

import { PLUGIN_VERSION_BUMPS, parseStrictSemVer, resolveNextPluginVersion } from './lib/semver.mjs';

const HYPHEN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
  node .agents/skills/create-aw-plugin/scripts/bump_plugin_version.mjs <plugin-name> \\
    (--bump major|minor|patch | --version <semver>) [--repo-root .]
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
      if (!options.pluginName) {
        options.pluginName = arg;
        continue;
      }
      fail(`Unexpected positional argument: ${arg}`);
    }
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const { value, nextIndex } = readOptionValue(args, index, flag);
    index = nextIndex;
    if (flag === '--bump') {
      if (!PLUGIN_VERSION_BUMPS.has(value)) {
        fail('--bump must be one of "major", "minor", or "patch".');
      }
      options.bump = value;
    } else if (flag === '--version') {
      options.version = value;
    } else if (flag === '--repo-root') {
      options.repoRoot = value;
    } else {
      fail(`Unknown option: ${flag}`);
    }
  }
  if (!options.pluginName) fail('plugin-name is required.');
  if (options.bump === undefined && options.version === undefined) {
    fail('One of --bump or --version is required.');
  }
  return options;
}

function main() {
  const args = parseArgs(process.argv);
  if (!HYPHEN_NAME_PATTERN.test(args.pluginName)) {
    fail(`plugin-name must use lowercase hyphen-case, got ${JSON.stringify(args.pluginName)}.`);
  }
  const repoRoot = path.resolve(args.repoRoot);
  const manifestPath = path.join(
    repoRoot,
    'plugins',
    args.pluginName,
    '.agents-plugin',
    'plugin.json',
  );
  if (!fs.existsSync(manifestPath)) fail(`Plugin manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== args.pluginName) {
    fail(`Plugin manifest name ${JSON.stringify(manifest.name)} does not match ${JSON.stringify(args.pluginName)}.`);
  }
  parseStrictSemVer(manifest.version, 'plugin version');
  const nextVersion = resolveNextPluginVersion(manifest.version, {
    bump: args.bump,
    version: args.version,
  });
  const nextManifest = { ...manifest, version: nextVersion };
  const tempPath = `${manifestPath}.aw-version-${process.pid}`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, manifestPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  console.log(`[OK] ${args.pluginName}: ${manifest.version} -> ${nextVersion}`);
}

try {
  main();
} catch (error) {
  console.error(`[ERROR] ${error.message}`);
  process.exit(1);
}
