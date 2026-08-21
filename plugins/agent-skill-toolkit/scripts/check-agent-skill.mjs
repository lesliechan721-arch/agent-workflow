#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const IGNORED = new Set(['.git', 'node_modules', '.DS_Store']);
const AUTHOR_ONLY = new Set(['evals', 'reports']);
const PRODUCTION_DIGEST_DOMAIN = 'aw-production-records-v1';
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const RESOURCE_PATTERN = /(?<![A-Za-z0-9._/\-])(?:\.\/)?(?:references|scripts|assets|agents|evals|providers)\/[A-Za-z0-9._()\-/]+/gu;
const MARKDOWN_LINK_PATTERN = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^\s)\n])+))/gu;
const MARKDOWN_DEFINITION_PATTERN = /^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gmu;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

function usage() {
  return 'Usage: check-agent-skill.mjs <skill-root> [--root-kind source|materialized] [--profile name] [--output file] [--format json|text]';
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const positional = [];
  let rootKind = 'source';
  let profile = null;
  let output = null;
  let format = 'json';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--root-kind') rootKind = argv[++index];
    else if (value === '--profile') profile = argv[++index];
    else if (value === '--output') output = path.resolve(argv[++index] ?? '');
    else if (value === '--format') format = argv[++index];
    else if (value.startsWith('-')) throw new Error('Unknown option: ' + value);
    else positional.push(value);
  }
  if (positional.length !== 1) throw new Error(usage());
  if (!['source', 'materialized'].includes(rootKind)) throw new Error('--root-kind must be source or materialized.');
  if (!['json', 'text'].includes(format)) throw new Error('--format must be json or text.');
  if (profile !== null && !profile) throw new Error('--profile must be non-empty.');
  return { root: path.resolve(positional[0]), rootKind, profile, output, format };
}

function posix(value) {
  return value.split(path.sep).join('/');
}

function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { valid: false, name: null, description: null, error: 'SKILL.md must start with YAML frontmatter.' };
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return { valid: false, name: null, description: null, error: 'SKILL.md frontmatter is not closed.' };
  const raw = text.slice(4, end);
  const scalar = (key) => raw.match(new RegExp(`^${key}:\\s*(.*)$`, 'mu'))?.[1]?.trim().replace(/^['"]|['"]$/gu, '') ?? null;
  const block = (key) => {
    const header = raw.match(new RegExp(`^${key}:\\s*[>|]-?\\s*$`, 'mu'));
    if (!header) return scalar(key);
    const tail = raw.slice(header.index + header[0].length).replace(/^\n/u, '');
    const lines = [];
    for (const line of tail.split('\n')) {
      if (/^[A-Za-z0-9_-]+:\s*/u.test(line)) break;
      lines.push(line.replace(/^\s{2}/u, ''));
    }
    return lines.join(' ').trim();
  };
  return { valid: true, name: scalar('name'), description: block('description'), error: null };
}

async function collectFiles(root) {
  const files = [];
  const symlinks = [];
  async function walk(directory, relative = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const next = posix(path.join(relative, entry.name));
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) symlinks.push(next);
      else if (info.isDirectory()) await walk(absolute, next);
      else if (info.isFile()) files.push({ path: next, absolute, mode: info.mode });
    }
  }
  await walk(root);
  return { files, symlinks };
}

function productionFiles(files) {
  return files.filter((file) => !AUTHOR_ONLY.has(file.path.split('/')[0]));
}

function updateLengthPrefixed(hash, value) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

async function productionDigest(files) {
  const hash = createHash('sha256');
  updateLengthPrefixed(hash, PRODUCTION_DIGEST_DOMAIN);
  for (const file of [...productionFiles(files)].sort((a, b) => a.path.localeCompare(b.path))) {
    const content = await readFile(file.absolute);
    updateLengthPrefixed(hash, file.path);
    updateLengthPrefixed(hash, process.platform !== 'win32' && (file.mode & 0o111) !== 0 ? '100755' : '100644');
    updateLengthPrefixed(hash, createHash('sha256').update(content).digest());
  }
  return 'sha256:' + hash.digest('hex');
}

function stripCode(text) {
  return text
    .replace(/```[^\n]*\n[\s\S]*?```/gu, (value) => value.replace(/[^\n]/gu, ' '))
    .replace(/(?<!\\)`[^`\n]+`/gu, (value) => value.replace(/[^\n]/gu, ' '));
}

function cleanTarget(value) {
  return value.replace(/^\.\//u, '').replace(/[),.;:`'"\]}]+$/gu, '');
}

function coreTargets(text) {
  return [...new Set([...text.matchAll(RESOURCE_PATTERN)].map((match) => cleanTarget(match[0])))]
    .filter((value) => value && !value.endsWith('/'));
}

function markdownTargets(text) {
  const prose = stripCode(text);
  const values = [];
  for (const match of prose.matchAll(MARKDOWN_LINK_PATTERN)) values.push(match[1] ?? match[2]);
  for (const match of prose.matchAll(MARKDOWN_DEFINITION_PATTERN)) values.push(match[1] ?? match[2]);
  return values.filter(Boolean);
}

function resolveMarkdownTarget(origin, lexical) {
  let target = lexical.split('#', 1)[0].split('?', 1)[0];
  if (!target || target.startsWith('//') || URI_SCHEME_PATTERN.test(target)) return null;
  if (target.includes('\\') || path.posix.isAbsolute(target)) return { invalid: true, target: lexical };
  try { target = decodeURIComponent(target); } catch { return { invalid: true, target: lexical }; }
  const joined = /^(?:references|scripts|assets|agents|evals|providers)\//u.test(target)
    ? target
    : path.posix.join(path.posix.dirname(origin), target);
  const normalized = path.posix.normalize(joined).replace(/^\.\//u, '');
  if (!normalized || normalized === '..' || normalized.startsWith('../')) return { invalid: true, target: lexical };
  return { invalid: false, target: normalized };
}

function textResource(filePath) {
  return TEXT_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase());
}

async function declaredRuntimeTargets(skillRoot, skillName) {
  let current = path.dirname(skillRoot);
  for (let depth = 0; depth < 6; depth += 1) {
    const manifestPath = path.join(current, '.agents-plugin', 'plugin.json');
    const raw = await readFile(manifestPath, 'utf8').catch(() => null);
    if (raw !== null) {
      const manifest = JSON.parse(raw);
      return new Set((manifest.buildConfig?.skillRuntimeFiles ?? [])
        .filter((entry) => entry?.skill === skillName && typeof entry?.target === 'string')
        .map((entry) => entry.target.replace(/^\.\//u, '')));
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return new Set();
}

async function runtimeClosure(files, skillText, options = {}) {
  const byPath = new Map(productionFiles(files).map((file) => [file.path, file]));
  const queue = ['SKILL.md'];
  const visited = new Set();
  const errors = [];
  const warnings = [];
  while (queue.length > 0) {
    const origin = queue.shift();
    if (visited.has(origin)) continue;
    visited.add(origin);
    const file = byPath.get(origin);
    if (!file) continue;
    const text = origin === 'SKILL.md' ? skillText : await readFile(file.absolute, 'utf8');
    const dependencies = [];
    for (const lexical of markdownTargets(text)) {
      const resolved = resolveMarkdownTarget(origin, lexical);
      if (resolved) dependencies.push({ ...resolved, lexical });
    }
    for (const target of coreTargets(text)) dependencies.push({ invalid: false, target, lexical: target });
    const seen = new Set();
    for (const dependency of dependencies) {
      if (seen.has(dependency.target)) continue;
      seen.add(dependency.target);
      if (dependency.invalid) {
        errors.push({ code: 'invalid-local-path', origin, path: dependency.lexical, message: 'Runtime path must remain inside the Skill root.' });
        continue;
      }
      const target = dependency.target;
      if (!byPath.has(target)) {
        if (options.rootKind === 'source' && options.declaredTargets?.has(target)) {
          warnings.push({ code: 'declared-runtime-projection', origin, path: target, message: 'Resource is declared for build-time projection and must exist in the materialized Skill.' });
        } else {
          errors.push({ code: 'missing-runtime-resource', origin, path: target, message: 'Referenced runtime resource does not exist.' });
        }
      } else if (textResource(target) && !visited.has(target)) {
        queue.push(target);
      }
    }
  }
  for (const file of productionFiles(files)) {
    if (file.path === 'SKILL.md') continue;
    if (textResource(file.path) && !visited.has(file.path)) {
      warnings.push({ code: 'unreachable-text-resource', path: file.path, message: 'Agent-facing text is not reachable from SKILL.md.' });
    }
  }
  return { errors, warnings };
}

function renderText(result) {
  const lines = [
    `Skill: ${result.target.name}`,
    `Digest: ${result.target.digest}`,
    `Machine check: ${result.ok ? 'pass' : 'fail'}`,
  ];
  for (const error of result.errors) lines.push(`[error] ${error.code}: ${error.origin ?? 'package'} -> ${error.path ?? ''} ${error.message}`.trim());
  for (const warning of result.warnings) lines.push(`[warning] ${warning.code}: ${warning.path ?? ''} ${warning.message}`.trim());
  return lines.join('\n') + '\n';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const rootInfo = await stat(options.root).catch(() => null);
  if (!rootInfo?.isDirectory()) throw new Error('Skill root is not a directory: ' + options.root);
  const { files, symlinks } = await collectFiles(options.root);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const errors = symlinks.map((entry) => ({ code: 'symlink-runtime-path', path: entry, message: 'Skill runtime paths must not contain symbolic links.' }));
  const warnings = [];
  const skillFile = byPath.get('SKILL.md');
  if (!skillFile) throw new Error('Missing SKILL.md: ' + options.root);
  const skillText = await readFile(skillFile.absolute, 'utf8');
  const frontmatter = parseFrontmatter(skillText);
  const directoryName = path.basename(options.root);
  if (!frontmatter.valid) errors.push({ code: 'invalid-frontmatter', message: frontmatter.error });
  if (!frontmatter.name) errors.push({ code: 'missing-name', message: 'frontmatter.name is required.' });
  else if (frontmatter.name !== directoryName) errors.push({ code: 'name-directory-mismatch', message: `frontmatter.name ${frontmatter.name} does not match ${directoryName}.` });
  if (!frontmatter.description) errors.push({ code: 'missing-description', message: 'frontmatter.description is required.' });
  const declaredTargets = await declaredRuntimeTargets(options.root, frontmatter.name ?? directoryName);
  const closure = await runtimeClosure(files, skillText, { rootKind: options.rootKind, declaredTargets });
  errors.push(...closure.errors);
  warnings.push(...closure.warnings);
  const result = {
    schemaVersion: 1,
    producer: 'check-agent-skill',
    target: {
      name: frontmatter.name ?? directoryName,
      rootKind: options.rootKind,
      profile: options.profile,
      digest: await productionDigest(files),
    },
    ok: errors.length === 0,
    errors,
    warnings,
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (options.output) await writeFile(options.output, json, 'utf8');
  process.stdout.write(options.format === 'json' ? json : renderText(result));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write('[ERROR] ' + error.message + '\n');
  process.exit(2);
});
