#!/usr/bin/env node

import {
  checkPluginVersions,
  formatPluginVersionCheck,
} from './lib/plugin-version-check.mjs';

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

function printUsage(command) {
  console.log(`Usage:
  aw plugin ${command} \\
    (<plugin-name> | --all) [--base <git-ref>] [--json] [--workspace-root .]

Options:
  --all               Check every current workspace plugin.
  --base <git-ref>    Compare against an explicit Git base.
  --json              Emit one schema v3 JSON document.
  --workspace-root <path>  Workspace root. Default: current directory.
  -h, --help          Show this help message.
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    all: false,
    json: false,
    repoRoot: '.',
    pluginNames: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-h' || arg === '--help') {
      printUsage('status');
      process.exit(0);
    }
    if (arg === '--') continue;
    if (arg === '--all') {
      options.all = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      options.pluginNames.push(arg);
      continue;
    }
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const { value, nextIndex } = readOptionValue(args, index, flag);
    index = nextIndex;
    if (flag === '--base') options.base = value;
    else if (flag === '--workspace-root') options.repoRoot = value;
    else fail(`Unknown option: ${flag}`);
  }
  if (options.all && options.pluginNames.length > 0) {
    fail('--all cannot be combined with explicit plugin names.');
  }
  if (!options.all && options.pluginNames.length === 0) {
    fail('Provide a plugin name or use --all.');
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv);
  const result = await checkPluginVersions(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatPluginVersionCheck(result));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exit(1);
});
