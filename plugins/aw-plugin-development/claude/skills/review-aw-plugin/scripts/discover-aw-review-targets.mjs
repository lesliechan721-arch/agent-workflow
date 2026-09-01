#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { reviewSkillLeafPlan, supportedProfiles } from './review-skill-leaf-plan.mjs';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return [
    'Usage: discover-aw-review-targets.mjs <plugin-root> [options]',
    '  --workspace-root <path>  Explicit non-Git AW workspace root.',
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
    workspaceRoot: null,
    finals: [],
    outputRoot: null,
    format: 'json',
  };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--workspace-root') options.workspaceRoot = path.resolve(argv[++index] ?? '');
    else if (value === '--final') options.finals.push(namedPath(argv[++index] ?? ''));
    else if (value === '--output-root') options.outputRoot = path.resolve(argv[++index] ?? '');
    else if (value === '--format') options.format = argv[++index];
    else throw new Error('Unknown option: ' + value);
  }
  if (!['json', 'text'].includes(options.format)) throw new Error('--format must be json or text.');
  if (options.workspaceRoot === null) throw new Error('--workspace-root is required.');
  return options;
}

async function skillRoots(root) {
  const rootStats = await lstat(root).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Skill collection root must be a regular directory: ' + root);
  }
  const roots = [];
  async function visit(directory) {
    const skillFile = path.join(directory, 'SKILL.md');
    const skillStats = await lstat(skillFile).catch(() => null);
    if (skillStats && (!skillStats.isFile() || skillStats.isSymbolicLink())) {
      throw new Error('SKILL.md must be a non-symlink regular file: ' + skillFile);
    }
    if (skillStats) {
      roots.push(directory);
      return;
    }
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (['.git', 'node_modules', '.DS_Store'].includes(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      const stats = await lstat(entryPath);
      if (stats.isSymbolicLink()) throw new Error('Skill discovery cannot traverse symlink: ' + entryPath);
      if (stats.isDirectory()) await visit(entryPath);
      else if (!stats.isFile()) throw new Error('Skill collection contains a non-regular node: ' + entryPath);
    }
  }
  await visit(root);
  return roots;
}

async function resolveChecker() {
  const candidate = path.join(scriptRoot, 'check-agent-skill.mjs');
  const stats = await lstat(candidate).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new Error('Bundled check-agent-skill.mjs must be a regular file.');
  }
  return candidate;
}

async function validatePluginSource(pluginRoot, workspaceRoot) {
  const args = ['plugin', 'validate', pluginRoot, '--workspace-root', workspaceRoot, '--json'];
  try {
    return JSON.parse((await execFileAsync('aw', args, { encoding: 'utf8' })).stdout);
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout);
    return {
      ok: false,
      errors: [`Cannot run aw plugin validate: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function inspect(checker, root, rootKind, profile, outputPath) {
  const args = [checker, root, '--root-kind', rootKind, '--format', 'json'];
  if (profile !== null) args.push('--profile', profile);
  if (outputPath) args.push('--output', outputPath);
  const env = { ...process.env };
  delete env.AW_SKILL_VALIDATOR_BIN;
  try {
    return JSON.parse((await execFileAsync(process.execPath, args, { encoding: 'utf8', env })).stdout);
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
  const pluginStats = await lstat(options.pluginRoot).catch(() => null);
  const manifestDirectory = path.join(options.pluginRoot, '.agents-plugin');
  const manifestPath = path.join(manifestDirectory, 'plugin.json');
  const manifestDirectoryStats = await lstat(manifestDirectory).catch(() => null);
  const manifestStats = await lstat(manifestPath).catch(() => null);
  if (!pluginStats?.isDirectory() || pluginStats.isSymbolicLink()) throw new Error('Plugin root must be a regular directory.');
  if (!manifestDirectoryStats?.isDirectory() || manifestDirectoryStats.isSymbolicLink()) throw new Error('.agents-plugin must be a regular directory.');
  if (!manifestStats?.isFile() || manifestStats.isSymbolicLink()) throw new Error('Plugin manifest must be a regular file.');
  const pluginValidation = await validatePluginSource(options.pluginRoot, options.workspaceRoot);
  if (pluginValidation.ok !== true) {
    const errors = pluginValidation.errors ?? [];
    const plugin = path.basename(options.pluginRoot);
    const result = {
      schemaVersion: 1,
      plugin,
      pluginReview: {
        id: `aw-plugin:${plugin}`,
        targetLevel: 'plugin',
        reviewRoot: options.pluginRoot,
        targetIds: [],
        uniqueDigests: [],
        materializedProfiles: [],
        machineCheck: { ok: false, blockedTargetIds: [], errors },
      },
      targets: [],
      uniqueReviews: [],
    };
    if (options.format === 'json') process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else process.stdout.write(`Plugin: ${plugin}\nTargets: 0\nUnique digests: 0\nPlugin review: blocked\n`);
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const skillsRoot = typeof manifest.skills === 'string'
    ? path.resolve(options.pluginRoot, manifest.skills)
    : null;
  if (skillsRoot !== null && !isPathInside(options.pluginRoot, skillsRoot)) {
    throw new Error('Plugin skills collection must stay inside the plugin root.');
  }
  const requiresBuild = manifest.scripts?.node?.build !== undefined;
  if (requiresBuild && options.finals.length === 0) {
    throw new Error('Plugins with scripts.node.build require at least one materialized --final collection.');
  }
  const sourceRoots = skillsRoot === null ? [] : await skillRoots(skillsRoot);
  const sourceRootByName = new Map(sourceRoots.map((root) => [path.basename(root), root]));
  const leafPlan = reviewSkillLeafPlan(
    manifest,
    sourceRootByName.keys(),
    supportedProfiles(manifest),
  );
  const collections = requiresBuild
    ? []
    : leafPlan.staticLeaves.map((leaf) => ({
        kind: 'aw-plugin-skill', profile: null, root: sourceRootByName.get(leaf.name),
      }));
  const profiles = new Set();
  for (const entry of options.finals) {
    if (profiles.has(entry.profile)) throw new Error('Duplicate --final profile: ' + entry.profile);
    profiles.add(entry.profile);
    for (const root of await skillRoots(entry.root)) {
      collections.push({ kind: 'materialized-skill', profile: entry.profile, root });
    }
  }
  if (options.outputRoot) await mkdir(options.outputRoot, { recursive: true });

  const checker = await resolveChecker();
  const targets = [];
  const slots = new Set();
  for (const collection of collections) {
    for (const root of [collection.root]) {
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
      const plannedLeaf = collection.kind === 'materialized-skill'
        ? leafPlan.finalLeaves.find((leaf) =>
            leaf.name === inspection.target.name && leaf.profile === collection.profile)
        : leafPlan.staticLeaves.find((leaf) => leaf.name === inspection.target.name);
      if (!plannedLeaf) errors.push('Skill leaf is not consumed by the shared review plan.');
      targets.push({
        id,
        kind: collection.kind,
        name: inspection.target.name,
        profile: collection.profile,
        root,
        digest: inspection.target.digest,
        ...(plannedLeaf?.kind === 'dynamic' ? { dynamicTargetId: plannedLeaf.id } : {}),
        machineCheck: {
          ok: errors.length === 0,
          errors,
          warningCount: warnings.length,
        },
        inspectionPath,
      });
    }
  }
  for (const leaf of leafPlan.dynamicLeaves) {
    const id = `materialized-skill:${leaf.name}:${leaf.profile}`;
    if (slots.has(id)) continue;
    slots.add(id);
    targets.push({
      id,
      kind: 'materialized-skill',
      name: leaf.name,
      profile: leaf.profile,
      root: null,
      digest: null,
      dynamicTargetId: leaf.id,
      machineCheck: {
        ok: false,
        errors: [`Dynamic Skill ${leaf.id} requires a materialized ${leaf.profile} final leaf.`],
        warningCount: 0,
      },
      inspectionPath: null,
    });
  }
  const groups = new Map();
  for (const target of targets.filter((entry) => entry.digest !== null)) {
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
