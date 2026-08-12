import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { PLUGIN_VERSION_BUMPS, resolveNextPluginVersion } from './semver.mjs';

const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INTENT_FILE_PATTERN = /^[a-z0-9][a-z0-9._-]*\.json$/;
const BUMP_RANK = new Map([
  ['patch', 0],
  ['minor', 1],
  ['major', 2],
]);

export const PLUGIN_RELEASE_INTENT_SCHEMA_VERSION = 1;
export const PLUGIN_RELEASE_INTENT_DIRECTORY = path.join('.changes', 'plugins');

function assertPlainObject(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldName} must be a JSON object.`);
  }
  return value;
}

function validateIntent(rawIntent, fileName) {
  const intent = assertPlainObject(rawIntent, `Release intent ${fileName}`);
  const allowedKeys = new Set(['schemaVersion', 'plugin', 'bump', 'summary']);
  for (const key of Object.keys(intent)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Release intent ${fileName} has unknown field ${JSON.stringify(key)}.`);
    }
  }
  if (intent.schemaVersion !== PLUGIN_RELEASE_INTENT_SCHEMA_VERSION) {
    throw new Error(
      `Release intent ${fileName}.schemaVersion must be ${PLUGIN_RELEASE_INTENT_SCHEMA_VERSION}.`,
    );
  }
  if (typeof intent.plugin !== 'string' || !PLUGIN_NAME_PATTERN.test(intent.plugin)) {
    throw new Error(`Release intent ${fileName}.plugin must use lowercase hyphen-case.`);
  }
  if (typeof intent.bump !== 'string' || !PLUGIN_VERSION_BUMPS.has(intent.bump)) {
    throw new Error(`Release intent ${fileName}.bump must be major, minor, or patch.`);
  }
  if (typeof intent.summary !== 'string' || intent.summary.trim() === '') {
    throw new Error(`Release intent ${fileName}.summary must be a non-empty string.`);
  }
  return {
    schemaVersion: PLUGIN_RELEASE_INTENT_SCHEMA_VERSION,
    plugin: intent.plugin,
    bump: intent.bump,
    summary: intent.summary.trim(),
    fileName,
  };
}

export async function readPluginReleaseIntents(repoRoot) {
  const intentRoot = path.join(repoRoot, PLUGIN_RELEASE_INTENT_DIRECTORY);
  let entries;
  try {
    entries = await fs.readdir(intentRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const intents = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === 'README.md' || entry.name === '.gitkeep') continue;
    if (!entry.isFile() || !INTENT_FILE_PATTERN.test(entry.name)) {
      throw new Error(
        `Unsupported entry in ${PLUGIN_RELEASE_INTENT_DIRECTORY}: ${JSON.stringify(entry.name)}.`,
      );
    }
    const filePath = path.join(intentRoot, entry.name);
    let rawIntent;
    try {
      rawIntent = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot read release intent ${entry.name}: ${error.message}`);
    }
    intents.push({
      ...validateIntent(rawIntent, entry.name),
      filePath,
    });
  }
  return intents;
}

export function aggregatePluginReleaseIntents(intents) {
  const plans = new Map();
  for (const intent of intents) {
    const current = plans.get(intent.plugin);
    if (!current) {
      plans.set(intent.plugin, {
        plugin: intent.plugin,
        bump: intent.bump,
        summaries: [intent.summary],
        files: [intent.fileName],
        filePaths: [intent.filePath],
      });
      continue;
    }
    if (BUMP_RANK.get(intent.bump) > BUMP_RANK.get(current.bump)) {
      current.bump = intent.bump;
    }
    current.summaries.push(intent.summary);
    current.files.push(intent.fileName);
    current.filePaths.push(intent.filePath);
  }
  return plans;
}

export function resolvePluginReleasePlan(currentVersion, aggregatedIntent) {
  if (!aggregatedIntent) return null;
  return {
    ...aggregatedIntent,
    baseVersion: currentVersion,
    targetVersion: resolveNextPluginVersion(currentVersion, {
      bump: aggregatedIntent.bump,
    }),
  };
}

export async function readPluginReleasePlans(repoRoot) {
  return aggregatePluginReleaseIntents(await readPluginReleaseIntents(repoRoot));
}

export async function writePluginReleaseIntent(repoRoot, options) {
  const plugin = String(options.plugin ?? '');
  const bump = String(options.bump ?? '');
  const summary = String(options.summary ?? '').trim();
  const id = String(options.id ?? '').trim();
  if (!PLUGIN_NAME_PATTERN.test(plugin)) {
    throw new Error('plugin must use lowercase hyphen-case.');
  }
  if (!PLUGIN_VERSION_BUMPS.has(bump)) {
    throw new Error('bump must be major, minor, or patch.');
  }
  if (!summary) {
    throw new Error('summary must be a non-empty string.');
  }
  if (!id || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    throw new Error('id must start with a lowercase letter or digit and use lowercase letters, digits, dot, underscore, or hyphen.');
  }

  const pluginManifestPath = path.join(
    repoRoot,
    'plugins',
    plugin,
    '.agents-plugin',
    'plugin.json',
  );
  await fs.access(pluginManifestPath).catch(() => {
    throw new Error(`Plugin manifest not found: ${pluginManifestPath}`);
  });

  const intentRoot = path.join(repoRoot, PLUGIN_RELEASE_INTENT_DIRECTORY);
  const filePath = path.join(intentRoot, `${id}.json`);
  await fs.mkdir(intentRoot, { recursive: true });
  const content = `${JSON.stringify({
    schemaVersion: PLUGIN_RELEASE_INTENT_SCHEMA_VERSION,
    plugin,
    bump,
    summary,
  }, null, 2)}\n`;
  await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
  return filePath;
}
