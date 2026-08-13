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

function printUsage() {
  console.log(`Usage:
  node .agents/skills/create-aw-plugin/scripts/check_plugin_versions.mjs \\
    (<plugin-name> | --all) [--mode author|release] [--base <git-ref>] [--json] [--repo-root .]

Options:
  --all               Check every plugin changed relative to the Git base.
  --mode <mode>       For changed existing plugins, author requires a release intent and release requires
                      a version bump. New plugins keep their initial version without an intent. Default: author.
  --base <git-ref>    Git comparison base. Default: HEAD.
  --json              Emit one schema v1 JSON document.
  --repo-root <path>  Repository root. Default: current directory.
  -h, --help          Show this help message.
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    all: false,
    base: 'HEAD',
    mode: 'author',
    json: false,
    repoRoot: '.',
    pluginNames: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-h' || arg === '--help') {
      printUsage();
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
    else if (flag === '--mode') {
      if (value !== 'author' && value !== 'release') {
        fail('--mode must be "author" or "release".');
      }
      options.mode = value;
    } else if (flag === '--repo-root') options.repoRoot = value;
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
