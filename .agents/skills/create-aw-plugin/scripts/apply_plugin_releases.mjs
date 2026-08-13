#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { parseStrictSemVer, resolveNextPluginVersion } from './lib/semver.mjs';
import {
  aggregatePluginReleaseIntents,
  readPluginReleaseIntents,
} from './lib/plugin-release-intents.mjs';

function printUsage() {
  console.log(`Usage:
  node .agents/skills/create-aw-plugin/scripts/apply_plugin_releases.mjs \\
    [<plugin-name> ... | --all] [--repo-root .]

With --all or no plugin names, an empty intent set is a successful no-op.
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = { all: false, plugins: [], repoRoot: '.' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--all') {
      options.all = true;
      continue;
    }
    if (arg === '--repo-root') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--repo-root requires a value.');
      options.repoRoot = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    options.plugins.push(arg);
  }
  if (options.all && options.plugins.length > 0) {
    throw new Error('--all cannot be combined with plugin names.');
  }
  return options;
}

async function replaceFile(filePath, content) {
  const tempPath = `${filePath}.aw-release-${process.pid}`;
  try {
    await fs.writeFile(tempPath, content, 'utf8');
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function rollbackApply(changedManifests, deletedIntents) {
  const rollbackErrors = [];
  for (const intent of [...deletedIntents].reverse()) {
    try {
      await fs.writeFile(intent.filePath, intent.content, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  for (const write of [...changedManifests].reverse()) {
    try {
      await replaceFile(write.manifestPath, write.originalContent);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  return rollbackErrors;
}

try {
  const args = parseArgs(process.argv);
  const repoRoot = path.resolve(args.repoRoot);
  const intents = await readPluginReleaseIntents(repoRoot);
  const plans = aggregatePluginReleaseIntents(intents);
  const selected = args.all || args.plugins.length === 0
    ? [...plans.keys()].sort()
    : [...new Set(args.plugins)].sort();
  if (selected.length === 0) {
    console.log('[OK] No plugin release intents to apply.');
    process.exit(0);
  }

  const writes = [];
  const consumedFiles = [];
  for (const plugin of selected) {
    const plan = plans.get(plugin);
    if (!plan) throw new Error(`No release intent found for plugin ${JSON.stringify(plugin)}.`);
    const manifestPath = path.join(repoRoot, 'plugins', plugin, '.agents-plugin', 'plugin.json');
    const originalContent = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(originalContent);
    parseStrictSemVer(manifest.version, `${plugin} plugin version`);
    const nextVersion = resolveNextPluginVersion(manifest.version, { bump: plan.bump });
    writes.push({
      manifestPath,
      originalContent,
      content: `${JSON.stringify({ ...manifest, version: nextVersion }, null, 2)}\n`,
      plugin,
      previousVersion: manifest.version,
      nextVersion,
    });
    consumedFiles.push(...plan.filePaths);
  }

  const intentFiles = await Promise.all(
    consumedFiles.map(async (filePath) => ({
      filePath,
      content: await fs.readFile(filePath, 'utf8'),
    })),
  );
  const changedManifests = [];
  const deletedIntents = [];
  try {
    for (const write of writes) {
      await replaceFile(write.manifestPath, write.content);
      changedManifests.push(write);
    }
    for (const intent of intentFiles) {
      await fs.rm(intent.filePath);
      deletedIntents.push(intent);
    }
  } catch (error) {
    const rollbackErrors = await rollbackApply(changedManifests, deletedIntents);
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Plugin release apply failed and rollback was incomplete: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }

  for (const write of writes) {
    console.log(`[OK] ${write.plugin}: ${write.previousVersion} -> ${write.nextVersion}`);
  }
  console.log(`[OK] Consumed ${consumedFiles.length} release intent(s).`);
} catch (error) {
  console.error(`[ERROR] ${error.message}`);
  process.exit(1);
}
