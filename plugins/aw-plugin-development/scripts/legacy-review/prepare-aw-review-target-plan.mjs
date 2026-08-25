#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isSkillAuthorArtifact } from './review-artifact-policy.mjs';
import { reviewSkillLeafPlan, supportedProfiles } from '../review-skill-leaf-plan.mjs';

const PRODUCTION_DIGEST_DOMAIN = 'aw-production-records-v1';
const PROFILES = new Set(['codex-user', 'codex-project', 'claude-user', 'claude-project']);
const IGNORED_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);

function fail(message) {
  throw new Error(message);
}

function value(args, index, flag) {
  const candidate = args[index + 1];
  if (!candidate || candidate.startsWith('--')) fail(flag + ' requires a value.');
  return candidate;
}

function namedPath(candidate) {
  const separator = candidate.indexOf('=');
  if (separator < 1 || separator === candidate.length - 1) {
    fail('--final requires profile=path.');
  }
  const profile = candidate.slice(0, separator);
  if (!PROFILES.has(profile)) fail('Unknown review profile: ' + profile);
  return { profile, root: path.resolve(candidate.slice(separator + 1)) };
}

function parseArgs(args) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write([
      'Usage: prepare-aw-review-target-plan.mjs <plugin-root> --bundle <bundle.json> --output <plan.json> [options]',
      '  --mode quick|full|delta|release-quality',
      '  --profile codex-user|codex-project|claude-user|claude-project',
      '  --final profile=path',
    ].join('\n') + '\n');
    process.exit(0);
  }
  if (!args[0] || args[0].startsWith('--')) fail('Provide <plugin-root>.');
  const options = {
    pluginRoot: path.resolve(args[0]),
    bundlePath: null,
    outputPath: null,
    mode: 'release-quality',
    profiles: [],
    finals: [],
  };
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--bundle') {
      options.bundlePath = path.resolve(value(args, index, flag));
      index += 1;
    } else if (flag === '--output') {
      options.outputPath = path.resolve(value(args, index, flag));
      index += 1;
    } else if (flag === '--mode') {
      options.mode = value(args, index, flag);
      index += 1;
    } else if (flag === '--profile') {
      const profile = value(args, index, flag);
      if (!PROFILES.has(profile)) fail('Unknown review profile: ' + profile);
      options.profiles.push(profile);
      index += 1;
    } else if (flag === '--final') {
      options.finals.push(namedPath(value(args, index, flag)));
      index += 1;
    } else fail('Unknown option: ' + flag);
  }
  if (!options.bundlePath || !options.outputPath) fail('--bundle and --output are required.');
  if (!['quick', 'full', 'delta', 'release-quality'].includes(options.mode)) {
    fail('--mode must be quick, full, delta, or release-quality.');
  }
  return options;
}

function updateLengthPrefixed(hash, value) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function normalizedMode(mode) {
  return process.platform !== 'win32' && (mode & 0o111) !== 0 ? '100755' : '100644';
}

async function files(root) {
  const output = [];
  async function walk(directory, relative = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const next = path.join(relative, entry.name).split(path.sep).join('/');
      if (entry.isSymbolicLink()) fail('Review target cannot contain symlink: ' + next);
      if (entry.isDirectory()) await walk(absolute, next);
      else if (entry.isFile()) output.push({ absolute, relative: next });
    }
  }
  if ((await lstat(root)).isSymbolicLink()) fail('Review target root cannot be a symlink.');
  await walk(root);
  return output;
}

export async function digestSkill(root) {
  const hash = createHash('sha256');
  updateLengthPrefixed(hash, PRODUCTION_DIGEST_DOMAIN);
  const records = [];
  for (const file of await files(root)) {
    if (isSkillAuthorArtifact(file.relative, ['.'])) continue;
    records.push({
      path: file.relative,
      mode: normalizedMode((await stat(file.absolute)).mode),
      content: await readFile(file.absolute),
    });
  }
  records.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (const record of records) {
    updateLengthPrefixed(hash, record.path);
    updateLengthPrefixed(hash, record.mode);
    updateLengthPrefixed(hash, createHash('sha256').update(record.content).digest());
  }
  return 'sha256:' + hash.digest('hex');
}

export async function skillRoots(root) {
  const roots = [];
  async function visit(directory) {
    try {
      if ((await stat(path.join(directory, 'SKILL.md'))).isFile()) {
        roots.push(directory);
        return;
      }
    } catch {}
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      if (entry.isSymbolicLink()) fail('Skill discovery cannot contain symlink: ' + entry.name);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
    }
  }
  await visit(root);
  return roots.sort();
}

export async function skillName(root) {
  const text = await readFile(path.join(root, 'SKILL.md'), 'utf8');
  const match = text.match(/^---\s*\n[\s\S]*?^name:\s*([^\n]+)$/mu);
  return match?.[1]?.trim().replace(/^['"]|['"]$/gu, '') || path.basename(root);
}

export async function describeReviewPlanSource(pluginRoot) {
  const manifest = JSON.parse(await readFile(
    path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    'utf8',
  ));
  const skillsPath = typeof manifest.skills === 'string'
    ? path.resolve(pluginRoot, manifest.skills)
    : null;
  const sources = [];
  if (skillsPath !== null) {
    for (const root of await skillRoots(skillsPath)) {
      sources.push({ name: await skillName(root), digest: await digestSkill(root) });
    }
  }
  const leafPlan = reviewSkillLeafPlan(manifest, sources.map((entry) => entry.name));
  return {
    manifest,
    sources: leafPlan.staticLeaves.map((leaf) =>
      sources.find((source) => source.name === leaf.name)),
    leafPlan,
    supportedProfiles: supportedProfiles(manifest),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [source, bundle] = await Promise.all([
    describeReviewPlanSource(options.pluginRoot),
    readFile(options.bundlePath, 'utf8').then(JSON.parse),
  ]);
  const { manifest, sources } = source;
  if (bundle.target?.kind !== 'aw-plugin' || bundle.target?.name !== manifest.name) {
    fail('Review bundle does not match the plugin manifest.');
  }
  const allSupported = source.supportedProfiles;
  const requested = [...new Set(options.profiles)];
  const profiles = requested.length > 0
    ? requested
    : options.mode === 'release-quality'
      ? allSupported
      : [...new Set(options.finals.map((entry) => entry.profile))];
  for (const profile of profiles) {
    if (!allSupported.includes(profile)) fail('Profile is not supported by the plugin: ' + profile);
  }
  const leafPlan = reviewSkillLeafPlan(manifest, sources.map((entry) => entry.name), profiles);
  const finalRoots = new Map();
  for (const entry of options.finals) {
    if (finalRoots.has(entry.profile)) fail('Duplicate --final profile: ' + entry.profile);
    finalRoots.set(entry.profile, entry.root);
  }
  for (const profile of finalRoots.keys()) {
    if (!profiles.includes(profile)) fail('--final is outside the selected release scope: ' + profile);
  }

  const finalByProfile = new Map();
  for (const profile of profiles) {
    const roots = finalRoots.get(profile);
    const byName = new Map();
    if (roots) {
      for (const root of await skillRoots(roots)) {
        const name = await skillName(root);
        if (byName.has(name)) fail('Duplicate materialized Skill ' + name + ' for ' + profile);
        byName.set(name, await digestSkill(root));
      }
    }
    for (const name of byName.keys()) {
      if (
        !sources.some((source) => source.name === name)
        && !leafPlan.dynamicLeaves.some((leaf) => leaf.profile === profile && leaf.name === name)
      ) {
        fail('Materialized profile contains an unexpected Skill: ' + profile + ':' + name);
      }
    }
    finalByProfile.set(profile, byName);
  }

  const expectedTargets = sources.map((source) => ({
    id: `aw-plugin-skill:${source.name}`,
    targetName: source.name,
    kind: 'aw-plugin-skill',
    profile: null,
    digest: source.digest,
    status: 'present',
  }));
  for (const profile of profiles) {
    const byName = finalByProfile.get(profile);
    for (const source of sources.filter((entry) =>
      leafPlan.staticLeaves.find((leaf) => leaf.name === entry.name)?.profiles.includes(profile))) {
      const digest = byName.get(source.name) ?? null;
      expectedTargets.push({
        id: `materialized-skill:${source.name}:${profile}`,
        targetName: source.name,
        kind: 'materialized-skill',
        profile,
        digest,
        status: digest === null ? 'missing' : 'present',
      });
    }
  }
  for (const leaf of leafPlan.dynamicLeaves) {
    const digest = finalByProfile.get(leaf.profile).get(leaf.name) ?? null;
    expectedTargets.push({
      id: `materialized-skill:${leaf.id}:${leaf.name}:${leaf.profile}`,
      targetName: leaf.name,
      kind: 'materialized-skill',
      profile: leaf.profile,
      digest,
      status: digest === null ? 'missing' : 'present',
    });
  }
  const plan = {
    schemaVersion: 1,
    producer: 'prepare-aw-review-target-plan',
    plugin: manifest.name,
    pluginSourceDigest: bundle.target.sourceDigest,
    mode: options.mode,
    releaseScope: {
      kind: requested.length > 0 || (profiles.length > 0 && options.mode !== 'release-quality')
        ? 'explicit'
        : options.mode === 'release-quality'
          ? 'all-supported'
          : 'source-only',
      profiles,
    },
    expectedTargets,
  };
  await writeFile(options.outputPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write('[ERROR] ' + error.message + '\n');
    process.exit(1);
  });
}
