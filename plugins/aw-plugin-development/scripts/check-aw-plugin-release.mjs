#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const PROFILES = new Set(['codex-user', 'codex-project', 'claude-user', 'claude-project']);
const IGNORED = new Set(['.git', 'node_modules', '.DS_Store']);

function usage() {
  return 'Usage: check-aw-plugin-release.mjs <plugin-root> --review <review.json>... --final <profile=path>... [--profile name] [--output file] [--format json|text]';
}

function parseNamedPath(value, flag) {
  const index = value.indexOf('=');
  if (index < 1 || index === value.length - 1) throw new Error(`${flag} requires profile=path.`);
  const profile = value.slice(0, index);
  if (!PROFILES.has(profile)) throw new Error('Unknown profile: ' + profile);
  return { profile, root: path.resolve(value.slice(index + 1)) };
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const positional = [];
  const reviews = [];
  const finals = [];
  const profiles = [];
  let output = null;
  let format = 'json';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--review') reviews.push(path.resolve(argv[++index] ?? ''));
    else if (value === '--final') finals.push(parseNamedPath(argv[++index] ?? '', value));
    else if (value === '--profile') {
      const profile = argv[++index];
      if (!PROFILES.has(profile)) throw new Error('Unknown profile: ' + profile);
      profiles.push(profile);
    } else if (value === '--output') output = path.resolve(argv[++index] ?? '');
    else if (value === '--format') format = argv[++index];
    else if (value.startsWith('-')) throw new Error('Unknown option: ' + value);
    else positional.push(path.resolve(value));
  }
  if (positional.length !== 1 || reviews.length === 0) throw new Error(usage());
  if (!['json', 'text'].includes(format)) throw new Error('--format must be json or text.');
  return { pluginRoot: positional[0], reviews, finals, profiles: [...new Set(profiles)], output, format };
}

async function skillRoots(root) {
  const roots = [];
  async function visit(directory) {
    const skillFile = path.join(directory, 'SKILL.md');
    if ((await stat(skillFile).catch(() => null))?.isFile()) {
      roots.push(directory);
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error('Skill discovery cannot follow symlink: ' + entry.name);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
    }
  }
  await visit(root);
  return roots;
}

function supportedProfiles(manifest) {
  const products = Array.isArray(manifest.marketplace?.policy?.products) && manifest.marketplace.policy.products.length > 0
    ? manifest.marketplace.policy.products.map((value) => String(value).toUpperCase())
    : ['CODEX', 'CLAUDE'];
  return [...new Set(products.flatMap((product) => {
    if (product === 'CODEX') return ['codex-user', 'codex-project'];
    if (product === 'CLAUDE') return ['claude-user', 'claude-project'];
    return [];
  }))];
}

async function runJson(file, args, allowFailure = false) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [file, ...args], { encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (error) {
    if (!allowFailure || typeof error?.stdout !== 'string' || !error.stdout.trim()) throw error;
    return JSON.parse(error.stdout);
  }
}

async function requiresEval(skillRoot) {
  const manifestPath = path.join(skillRoot, 'evals', 'manifest.json');
  const content = await readFile(manifestPath, 'utf8').catch(() => null);
  if (content === null) return false;
  const manifest = JSON.parse(content);
  if (manifest.requiredForRelease === true) return true;
  return Array.isArray(manifest.suites) && manifest.suites.some((suite) => suite?.requiredForRelease === true);
}

function renderText(result) {
  const lines = [
    `Plugin: ${result.plugin}`,
    `Release check: ${result.ready ? 'ready' : 'blocked'}`,
    `Profiles: ${result.profiles.join(', ') || 'none'}`,
  ];
  for (const reason of result.reasons) lines.push('- ' + reason);
  return lines.join('\n') + '\n';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const manifest = JSON.parse(await readFile(path.join(options.pluginRoot, '.agents-plugin', 'plugin.json'), 'utf8'));
  const profiles = options.profiles.length > 0 ? options.profiles : supportedProfiles(manifest);
  const finalRoots = new Map();
  for (const entry of options.finals) {
    if (finalRoots.has(entry.profile)) throw new Error('Duplicate final profile: ' + entry.profile);
    finalRoots.set(entry.profile, entry.root);
  }
  const reviews = [];
  for (const reviewPath of options.reviews) reviews.push({ path: reviewPath, value: JSON.parse(await readFile(reviewPath, 'utf8')) });
  const reviewByDigest = new Map();
  for (const review of reviews) {
    const digest = review.value?.target?.digest;
    if (reviewByDigest.has(digest)) throw new Error('Duplicate review for digest: ' + digest);
    reviewByDigest.set(digest, review);
  }

  const checker = process.env.AW_SKILL_CHECK_BIN
    ? path.resolve(process.env.AW_SKILL_CHECK_BIN)
    : path.join(scriptRoot, 'check-agent-skill.mjs');
  const validator = process.env.AW_REVIEW_LITE_VALIDATOR
    ? path.resolve(process.env.AW_REVIEW_LITE_VALIDATOR)
    : path.join(scriptRoot, 'validate-review-result-lite.mjs');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aw-release-check-'));
  const reasons = [];
  const targets = [];
  try {
    const skillsRoot = typeof manifest.skills === 'string'
      ? path.resolve(options.pluginRoot, manifest.skills)
      : path.join(options.pluginRoot, 'skills');
    const sourceRoots = await skillRoots(skillsRoot);
    const sourceByName = new Map();
    for (const root of sourceRoots) {
      const check = await runJson(checker, [root, '--root-kind', 'source', '--format', 'json'], true);
      sourceByName.set(check.target.name, { root, check });
    }

    const finalByProfile = new Map();
    for (const profile of profiles) {
      const root = finalRoots.get(profile);
      const byName = new Map();
      if (root) {
        for (const skillRoot of await skillRoots(root)) {
          const check = await runJson(checker, [skillRoot, '--root-kind', 'materialized', '--profile', profile, '--format', 'json'], true);
          byName.set(check.target.name, { root: skillRoot, check });
        }
      }
      finalByProfile.set(profile, byName);
    }

    async function evaluateTarget(kind, name, profile, root, check, evalRequired) {
      const checkPath = path.join(temporary, `${kind}-${name}-${profile ?? 'source'}-check.json`);
      await writeFile(checkPath, JSON.stringify(check, null, 2) + '\n');
      const review = reviewByDigest.get(check.target.digest);
      let reviewDesign = null;
      let evalEvidence = null;
      let validReview = false;
      if (!check.ok) reasons.push(`${kind}:${name}:${profile ?? 'source'} failed machine check`);
      if (!review) {
        reasons.push(`${kind}:${name}:${profile ?? 'source'} has no review for digest ${check.target.digest}`);
      } else {
        const validation = await runJson(validator, [review.path, '--check', checkPath, '--format', 'json'], true);
        validReview = validation.valid === true;
        reviewDesign = review.value.design ?? null;
        evalEvidence = review.value.evalEvidence ?? null;
        if (!validReview) reasons.push(`${kind}:${name}:${profile ?? 'source'} review is invalid: ${validation.errors.join('; ')}`);
        else if (validation.effectiveDecision !== 'pass') reasons.push(`${kind}:${name}:${profile ?? 'source'} review decision is ${validation.effectiveDecision}`);
        if (evalRequired && !['executed', 'comparative'].includes(evalEvidence)) {
          reasons.push(`${kind}:${name}:${profile ?? 'source'} requires executed Eval evidence`);
        }
      }
      targets.push({ kind, name, profile, digest: check.target.digest, machineCheck: check.ok ? 'pass' : 'fail', reviewDesign, evalEvidence, validReview });
    }

    for (const [name, source] of sourceByName) {
      const evalRequired = await requiresEval(source.root);
      await evaluateTarget('source', name, null, source.root, source.check, evalRequired);
      for (const profile of profiles) {
        const final = finalByProfile.get(profile).get(name);
        if (!final) {
          reasons.push(`materialized:${name}:${profile} is missing`);
          targets.push({ kind: 'materialized', name, profile, digest: null, machineCheck: 'missing', reviewDesign: null, evalEvidence: null, validReview: false });
        } else {
          await evaluateTarget('materialized', name, profile, final.root, final.check, evalRequired);
        }
      }
    }
    for (const [profile, byName] of finalByProfile) {
      for (const name of byName.keys()) if (!sourceByName.has(name)) reasons.push(`materialized:${name}:${profile} has no source Skill`);
    }

    const result = {
      schemaVersion: 1,
      producer: 'check-aw-plugin-release',
      plugin: manifest.name,
      ready: reasons.length === 0,
      profiles,
      targets,
      reasons,
    };
    const json = JSON.stringify(result, null, 2) + '\n';
    if (options.output) await writeFile(options.output, json, 'utf8');
    process.stdout.write(options.format === 'json' ? json : renderText(result));
    if (!result.ready) process.exitCode = 1;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write('[ERROR] ' + error.message + '\n');
  process.exit(2);
});
