#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return [
    'Usage: discover-aw-review-targets.mjs <plugin-root> [options]',
    '  --final <profile=path>   Add one materialized Skill collection.',
    '  --output-root <path>     Persist machine-check JSON files for downstream review.',
    '  --format <json|text>',
  ].join('\n');
}

function namedPath(value) {
  const separator = value.indexOf('=');
  if (separator < 1 || separator === value.length - 1) {
    throw new Error('--final requires profile=path.');
  }
  return { profile: value.slice(0, separator), root: path.resolve(value.slice(separator + 1)) };
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  if (!argv[0] || argv[0].startsWith('-')) throw new Error(usage());
  const options = {
    pluginRoot: path.resolve(argv[0]),
    finals: [],
    outputRoot: null,
    format: 'json',
  };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--final') options.finals.push(namedPath(argv[++index] ?? ''));
    else if (value === '--output-root') options.outputRoot = path.resolve(argv[++index] ?? '');
    else if (value === '--format') options.format = argv[++index];
    else throw new Error('Unknown option: ' + value);
  }
  if (!['json', 'text'].includes(options.format)) throw new Error('--format must be json or text.');
  return options;
}

async function skillRoots(root) {
  const roots = [];
  async function visit(directory) {
    try {
      if ((await stat(path.join(directory, 'SKILL.md'))).isFile()) {
        roots.push(directory);
        return;
      }
    } catch {}
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (['.git', 'node_modules', '.DS_Store'].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error('Skill discovery cannot traverse symlink: ' + path.join(directory, entry.name));
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
    }
  }
  await visit(root);
  return roots;
}

async function resolveChecker() {
  const candidates = [
    path.join(scriptRoot, 'check-agent-skill.mjs'),
    path.resolve(scriptRoot, '../../../../agent-skill-toolkit/scripts/check-agent-skill.mjs'),
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  throw new Error('Cannot locate check-agent-skill.mjs in the materialized Skill or source plugin collection.');
}

async function inspect(checker, root, rootKind, profile, outputPath) {
  const args = [checker, root, '--root-kind', rootKind, '--format', 'json'];
  if (profile !== null) args.push('--profile', profile);
  if (outputPath) args.push('--output', outputPath);
  try {
    return JSON.parse((await execFileAsync(process.execPath, args, { encoding: 'utf8' })).stdout);
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout);
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const manifest = JSON.parse(await readFile(
    path.join(options.pluginRoot, '.agents-plugin', 'plugin.json'),
    'utf8',
  ));
  const skillsRoot = typeof manifest.skills === 'string'
    ? path.resolve(options.pluginRoot, manifest.skills)
    : path.join(options.pluginRoot, 'skills');
  const requiresBuild = manifest.scripts?.node?.build !== undefined;
  if (requiresBuild && options.finals.length === 0) {
    throw new Error('Plugins with scripts.node.build require at least one materialized --final collection.');
  }
  const collections = requiresBuild
    ? []
    : [{ kind: 'aw-plugin-skill', profile: null, root: skillsRoot }];
  const profiles = new Set();
  for (const entry of options.finals) {
    if (profiles.has(entry.profile)) throw new Error('Duplicate --final profile: ' + entry.profile);
    profiles.add(entry.profile);
    collections.push({ kind: 'materialized-skill', profile: entry.profile, root: entry.root });
  }
  if (options.outputRoot) await mkdir(options.outputRoot, { recursive: true });

  const checker = await resolveChecker();
  const targets = [];
  const slots = new Set();
  for (const collection of collections) {
    for (const root of await skillRoots(collection.root)) {
      const stem = [collection.kind, path.basename(root), collection.profile].filter(Boolean).join('--');
      const inspectionPath = options.outputRoot ? path.join(options.outputRoot, stem + '--inspection.json') : null;
      const inspection = await inspect(
        checker,
        root,
        collection.kind === 'materialized-skill' ? 'materialized' : 'source',
        collection.profile,
        inspectionPath,
      );
      const id = [collection.kind, inspection.target.name, collection.profile ?? 'source'].join(':');
      if (slots.has(id)) throw new Error('Duplicate review target: ' + id);
      slots.add(id);
      const errors = inspection.errors;
      const warnings = inspection.warnings;
      targets.push({
        id,
        kind: collection.kind,
        name: inspection.target.name,
        profile: collection.profile,
        root,
        digest: inspection.target.digest,
        machineCheck: {
          ok: errors.length === 0,
          errors,
          warningCount: warnings.length,
        },
        inspectionPath,
      });
    }
  }
  const groups = new Map();
  for (const target of targets) {
    const group = groups.get(target.digest) ?? { digest: target.digest, targetIds: [], reviewRoot: target.root };
    group.targetIds.push(target.id);
    groups.set(target.digest, group);
  }
  const uniqueReviews = [...groups.values()];
  const blockedTargetIds = targets
    .filter((target) => !target.machineCheck.ok)
    .map((target) => target.id);
  const result = {
    schemaVersion: 1,
    plugin: manifest.name,
    pluginReview: {
      id: `aw-plugin:${manifest.name}`,
      targetLevel: 'plugin',
      reviewRoot: options.pluginRoot,
      targetIds: targets.map((target) => target.id),
      uniqueDigests: uniqueReviews.map((group) => group.digest).sort(),
      materializedProfiles: [...profiles].sort(),
      machineCheck: {
        ok: blockedTargetIds.length === 0,
        blockedTargetIds,
      },
    },
    targets,
    uniqueReviews,
  };
  if (options.format === 'json') process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    process.stdout.write(`Plugin: ${result.plugin}\nTargets: ${targets.length}\nUnique digests: ${result.uniqueReviews.length}\nPlugin review: ${result.pluginReview.machineCheck.ok ? 'ready' : 'blocked'}\n`);
    for (const target of targets) {
      process.stdout.write(`- ${target.id}: ${target.machineCheck.ok ? 'ok' : 'blocked'} ${target.digest}\n`);
    }
  }
  if (blockedTargetIds.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write('[ERROR] ' + error.message + '\n');
  process.exit(1);
});
