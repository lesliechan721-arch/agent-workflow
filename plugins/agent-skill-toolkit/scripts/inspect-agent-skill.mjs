#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function usage() {
  return 'Usage: inspect-agent-skill.mjs <skill-dir> [--root-kind source|materialized] [--profile name] [--format json|text] [--output path]';
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const positional = [];
  let format = 'json';
  let rootKind = 'source';
  let profile = null;
  let outputPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--format') format = argv[++index];
    else if (value === '--root-kind') rootKind = argv[++index];
    else if (value === '--profile') profile = argv[++index];
    else if (value === '--output') outputPath = path.resolve(argv[++index] ?? '');
    else if (value.startsWith('-')) throw new Error('Unknown option: ' + value);
    else positional.push(value);
  }
  if (positional.length !== 1) throw new Error(usage());
  if (!['json', 'text'].includes(format)) throw new Error('--format must be json or text.');
  if (!['source', 'materialized'].includes(rootKind))
    throw new Error('--root-kind must be source or materialized.');
  if (profile !== null && profile.length === 0) throw new Error('--profile must be non-empty.');
  return { root: path.resolve(positional[0]), format, rootKind, profile, outputPath };
}

const RESOURCE_PATTERN = /(?<![A-Za-z0-9._/\-])(?:\.\/)?(?:references|scripts|assets|agents|evals|providers)\/[A-Za-z0-9._()\-/]+/gu;
const SKIP_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);
const PRODUCTION_DIGEST_DOMAIN = 'aw-production-records-v1';

function portable(value) {
  return value.split(path.sep).join('/');
}

function estimatedTokens(text) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { valid: false, error: 'SKILL.md must start with YAML frontmatter.' };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { valid: false, error: 'SKILL.md frontmatter is not closed.' };
  const raw = text.slice(4, end);
  const scalar = (name) => {
    const match = raw.match(new RegExp(`^${name}:\\s*(.*)$`, 'mu'));
    return match ? match[1].trim().replace(/^['"]|['"]$/gu, '') : null;
  };
  const block = (name) => {
    const line = raw.match(new RegExp(`^${name}:\\s*[>|]-?\\s*$`, 'mu'));
    if (!line) return scalar(name);
    const start = line.index + line[0].length;
    const tail = raw.slice(start).replace(/^\n/u, '');
    const lines = [];
    for (const candidate of tail.split('\n')) {
      if (/^[A-Za-z0-9_-]+:\s*/u.test(candidate)) break;
      lines.push(candidate.replace(/^\s{2}/u, ''));
    }
    return lines.join(' ').trim();
  };
  return {
    valid: true,
    raw,
    name: scalar('name'),
    description: block('description'),
    compatibility: block('compatibility'),
    body: text.slice(end + 5),
  };
}

function cleanResource(value) {
  return value.replace(/[),.;:`'"\]}]+$/gu, '');
}

function resourcePaths(text) {
  return [...new Set([...text.matchAll(RESOURCE_PATTERN)]
    .map((match) => cleanResource(match[0]).replace(/^\.\//u, '')))]
    .filter((target) => !target.endsWith('/') && !target.endsWith('-'))
    .sort();
}

const SHELL_FENCE_LANGUAGES = new Set(['', 'sh', 'bash', 'zsh', 'shell', 'powershell', 'pwsh', 'ps1', 'cmd']);

function hasExecutionSignal(snippet) {
  const tokens = snippet.trim().replace(/^\$\s+/u, '').split(/\s+/u).filter(Boolean);
  return tokens.length > 1 || /^(?:node|python3?|sh|bash|deno|bun|powershell|pwsh|cmd)\b/u.test(tokens[0] ?? '');
}

function dependencyPaths(text, includePathOnlyCode) {
  const snippets = [];
  let prose = text.replace(/```([^\n]*)\n([\s\S]*?)```/gu, (block, info, body) => {
    const language = info.trim().split(/\s+/u, 1)[0]?.toLowerCase() ?? '';
    if (SHELL_FENCE_LANGUAGES.has(language)) snippets.push(body);
    return block.replace(/[^\n]/gu, ' ');
  });
  prose = prose.replace(/(?<!\\)`([^`\n]+)`/gu, (block, body) => {
    snippets.push(body);
    return block.replace(/[^\n]/gu, ' ');
  });
  return [...new Set([
    ...resourcePaths(prose),
    ...snippets
      .filter((snippet) => includePathOnlyCode || hasExecutionSignal(snippet))
      .flatMap(resourcePaths),
  ])].sort();
}

function markdownDependencyPaths(text) {
  let prose = text.replace(/```([^\n]*)\n([\s\S]*?)```/gu, (block) =>
    block.replace(/[^\n]/gu, ' '));
  prose = prose.replace(/(?<!\\)`([^`\n]+)`/gu, (block) =>
    block.replace(/[^\n]/gu, ' '));
  const targets = [];
  for (const match of prose.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^\s)\n])+))/gu)) {
    targets.push(match[1] ?? match[2]);
  }
  for (const match of prose.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gmu)) {
    targets.push(match[1] ?? match[2]);
  }
  return [...new Set(targets.filter(Boolean))].sort();
}

const CORE_RESOURCE_ROOT_PATTERN = /^(?:\.\/)?(?:references|scripts|assets|agents|evals|providers)(?:\/|$)/u;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const WINDOWS_PATH_PATTERN = /^(?:[A-Za-z]:|\\|\/)/u;

function resolveMarkdownDependency(origin, lexicalTarget) {
  let target = lexicalTarget.split('#', 1)[0].split('?', 1)[0];
  if (target === '' || target.startsWith('//')) return null;
  if (WINDOWS_PATH_PATTERN.test(target)) return { invalid: true, target: lexicalTarget };
  if (URI_SCHEME_PATTERN.test(target)) return null;
  try {
    target = decodeURIComponent(target.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/gu, '$1'));
  } catch {
    return { invalid: true, target: lexicalTarget };
  }
  if (target.includes('\\')) {
    return { invalid: true, target: lexicalTarget };
  }
  const resolved = CORE_RESOURCE_ROOT_PATTERN.test(target)
    ? target.replace(/^\.\//u, '')
    : path.posix.join(path.posix.dirname(origin), target);
  const normalized = path.posix.normalize(resolved).replace(/^\.\//u, '');
  if (
    normalized === ''
    || normalized === '..'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
  ) {
    return { invalid: true, target: lexicalTarget };
  }
  return { invalid: false, target: normalized };
}

async function collectFiles(root) {
  const files = [];
  async function walk(directory, relative = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const nextRelative = portable(path.join(relative, entry.name));
      if (entry.isDirectory()) await walk(absolute, nextRelative);
      else if (entry.isFile()) {
        const info = await stat(absolute);
        files.push({ path: nextRelative, absolute, bytes: info.size });
      }
    }
  }
  await walk(root);
  return files;
}

function normalizedRegularFileMode(mode) {
  return process.platform !== 'win32' && (mode & 0o111) !== 0 ? '100755' : '100644';
}

function updateLengthPrefixed(hash, value) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function isAuthorOnlyPath(relativePath) {
  return ['evals', 'reports'].includes(relativePath.split('/')[0]);
}

async function productionDigest(files) {
  const hash = createHash('sha256');
  updateLengthPrefixed(hash, PRODUCTION_DIGEST_DOMAIN);
  for (const file of files
    .filter((entry) => !isAuthorOnlyPath(entry.path))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    const info = await stat(file.absolute);
    updateLengthPrefixed(hash, file.path);
    updateLengthPrefixed(hash, normalizedRegularFileMode(info.mode));
    updateLengthPrefixed(hash, createHash('sha256').update(await readFile(file.absolute)).digest());
  }
  return 'sha256:' + hash.digest('hex');
}

async function collectSymlinkPaths(root) {
  const links = [];
  async function walk(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (SKIP_NAMES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const nextRelative = portable(path.join(relative, entry.name));
      if ((await lstat(absolute)).isSymbolicLink()) links.push(nextRelative);
      else if (entry.isDirectory()) await walk(absolute, nextRelative);
    }
  }
  await walk(root);
  return links.sort();
}

function isAgentFacingTextResource(relativePath) {
  return ['.md', '.markdown', '.txt'].includes(path.posix.extname(relativePath).toLowerCase());
}

async function runtimeClosure(files, skillText) {
  const byPath = new Map(files
    .filter((file) => !isAuthorOnlyPath(file.path))
    .map((file) => [file.path, file]));
  const nodes = [];
  const edges = [];
  const issues = [];
  const pending = ['SKILL.md'];
  const visited = new Set();
  while (pending.length > 0) {
    const origin = pending.shift();
    if (visited.has(origin)) continue;
    visited.add(origin);
    const file = byPath.get(origin);
    if (!file) continue;
    nodes.push(origin);
    const text = origin === 'SKILL.md' ? skillText : await readFile(file.absolute, 'utf8');
    const dependencies = [
      ...markdownDependencyPaths(text).flatMap((lexicalTarget) => {
        const resolved = resolveMarkdownDependency(origin, lexicalTarget);
        return resolved === null ? [] : [{
          target: resolved.target,
          lexicalTarget,
          syntax: 'markdown-link',
          invalid: resolved.invalid,
        }];
      }),
      ...dependencyPaths(text, origin === 'SKILL.md').map((target) => ({
        target,
        lexicalTarget: target,
        syntax: 'core-path-token',
        invalid: false,
      })),
    ];
    const seenDependencies = new Set();
    for (const dependency of dependencies) {
      const key = dependency.target;
      if (seenDependencies.has(key)) continue;
      seenDependencies.add(key);
      const { target } = dependency;
      if (dependency.invalid) {
        edges.push({
          origin,
          target,
          kind: 'runtime-resource',
          syntax: dependency.syntax,
          status: 'missing',
        });
        issues.push({
          code: 'invalid-local-path',
          severity: 'error',
          origin,
          path: dependency.lexicalTarget,
          message: 'Runtime resource path is not a normalized Skill-local path.',
        });
        continue;
      }
      const present = byPath.has(target);
      edges.push({
        origin,
        target,
        kind: isAgentFacingTextResource(target) ? 'agent-facing-text' : 'runtime-resource',
        syntax: dependency.syntax,
        status: present ? 'present' : 'missing',
      });
      if (!present) {
        issues.push({
          code: 'missing-runtime-resource',
          severity: 'error',
          origin,
          path: target,
          message: 'Referenced runtime resource does not exist.',
        });
      } else if (isAgentFacingTextResource(target) && !visited.has(target)) {
        pending.push(target);
      }
    }
  }
  return {
    root: 'SKILL.md',
    complete: true,
    nodes: nodes.sort(),
    edges: edges.sort((left, right) =>
      left.origin.localeCompare(right.origin) || left.target.localeCompare(right.target)),
    issues,
  };
}

function nearestHeading(lines, lineIndex) {
  for (let index = lineIndex; index >= 0; index -= 1) {
    const match = lines[index].match(/^#{1,6}\s+(.+)$/u);
    if (match) return match[1].trim();
  }
  return 'root';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const files = await collectFiles(options.root);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const issues = [];
  for (const linkPath of await collectSymlinkPaths(options.root)) {
    issues.push({
      code: 'symlink-in-runtime-path',
      severity: 'error',
      path: linkPath,
      message: 'Skill runtime paths must not contain symbolic links.',
    });
  }
  const skillFile = byPath.get('SKILL.md');
  if (!skillFile) throw new Error('Missing SKILL.md: ' + options.root);
  const skillText = await readFile(skillFile.absolute, 'utf8');
  const frontmatter = parseFrontmatter(skillText);
  const directoryName = path.basename(options.root);
  if (!frontmatter.valid) issues.push({ code: 'invalid-frontmatter', severity: 'error', message: frontmatter.error });
  else {
    if (!frontmatter.name) issues.push({ code: 'missing-name', severity: 'error', message: 'frontmatter.name is required.' });
    if (frontmatter.name && frontmatter.name !== directoryName) {
      issues.push({ code: 'name-directory-mismatch', severity: 'error', message: `name ${frontmatter.name} does not match directory ${directoryName}.` });
    }
    if (frontmatter.name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(frontmatter.name)) {
      issues.push({ code: 'nonportable-name', severity: 'warning', message: 'name is not lowercase kebab-case.' });
    }
    if (!frontmatter.description) issues.push({ code: 'missing-description', severity: 'error', message: 'frontmatter.description is required.' });
    if (frontmatter.description && frontmatter.description.length > 1024) {
      issues.push({ code: 'description-too-long', severity: 'warning', message: 'description exceeds 1024 characters.' });
    }
  }

  const pointers = resourcePaths(skillText);
  const missingPointers = pointers.filter((resource) => !byPath.has(resource));
  const closure = await runtimeClosure(files, skillText);
  issues.push(...closure.issues);

  const incoming = new Map();
  const deepReferences = [];
  for (const file of files.filter((entry) => entry.path === 'SKILL.md' || entry.path.startsWith('references/'))) {
    const text = file.path === 'SKILL.md' ? skillText : await readFile(file.absolute, 'utf8');
    for (const resource of resourcePaths(text)) {
      const list = incoming.get(resource) ?? [];
      list.push(file.path);
      incoming.set(resource, list);
      if (file.path.startsWith('references/') && resource.startsWith('references/')) {
        deepReferences.push({ from: file.path, to: resource });
      }
    }
  }

  const references = [];
  for (const file of files.filter((entry) => entry.path.startsWith('references/'))) {
    const text = await readFile(file.absolute, 'utf8');
    references.push({
      path: file.path,
      bytes: file.bytes,
      lines: text.split('\n').length,
      estimatedTokens: estimatedTokens(text),
      headings: [...text.matchAll(/^#{1,6}\s+/gmu)].length,
      incomingPointers: incoming.get(file.path) ?? [],
      requiresSemanticAudit: text.split('\n').length > 300 || estimatedTokens(text) > 4000,
    });
  }

  const resourceRoots = ['references/', 'scripts/', 'assets/', 'agents/', 'evals/', 'providers/'];
  const unreachableResources = files
    .filter((file) => resourceRoots.some((root) => file.path.startsWith(root)))
    .filter((file) => !incoming.has(file.path))
    .filter((file) => !file.path.endsWith('/README.md'))
    .map((file) => file.path);

  const jsonFiles = [];
  for (const file of files.filter((entry) => entry.path.endsWith('.json'))) {
    try {
      JSON.parse(await readFile(file.absolute, 'utf8'));
      jsonFiles.push({ path: file.path, valid: true });
    } catch (error) {
      jsonFiles.push({ path: file.path, valid: false, error: error.message });
      issues.push({ code: 'invalid-json', severity: 'error', path: file.path, message: error.message });
    }
  }

  const scripts = [];
  for (const file of files.filter((entry) => entry.path.startsWith('scripts/'))) {
    const text = await readFile(file.absolute, 'utf8').catch(() => '');
    scripts.push({
      path: file.path,
      bytes: file.bytes,
      hasHelpSignal: /--help|-h\b|Usage:/u.test(text),
      interactiveInputSignal: /readline|inquirer|prompts\s*\(/u.test(text),
      absolutePathSignal: /\/(?:Users|home|tmp)\//u.test(text),
    });
  }

  const lines = skillText.split('\n');
  const activePathCandidates = [];
  for (let index = 0; index < lines.length; index += 1) {
    const refs = resourcePaths(lines[index]).filter((value) => value.startsWith('references/'));
    if (refs.length === 0) continue;
    activePathCandidates.push({
      branch: nearestHeading(lines, index),
      line: index + 1,
      references: refs,
      text: lines[index].trim(),
    });
  }

  const openaiPath = byPath.get('agents/openai.yaml');
  const openai = openaiPath
    ? {
        present: true,
        allowImplicitInvocationDeclared: /allow_implicit_invocation\s*:/u.test(await readFile(openaiPath.absolute, 'utf8')),
      }
    : { present: false, allowImplicitInvocationDeclared: false };

  const identifiedIssues = issues.map((entry) => ({
    id: [
      'inspection',
      entry.code,
      entry.origin ?? 'SKILL.md',
      entry.path ?? '-',
    ].join(':'),
    ...entry,
  }));
  const result = {
    schemaVersion: 1,
    producer: 'inspect-agent-skill',
    independentContext: false,
    target: {
      name: frontmatter.valid ? frontmatter.name ?? directoryName : directoryName,
      rootKind: options.rootKind,
      profile: options.profile,
      digest: await productionDigest(files),
    },
    root: options.root,
    package: {
      name: frontmatter.valid ? frontmatter.name : null,
      directoryName,
      descriptionLength: frontmatter.valid && frontmatter.description ? frontmatter.description.length : null,
      compatibility: frontmatter.valid ? frontmatter.compatibility : null,
    },
    skill: {
      bytes: skillFile.bytes,
      lines: skillText.split('\n').length,
      estimatedTokens: estimatedTokens(skillText),
    },
    totalFiles: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    pointers,
    missingPointers,
    deepReferences,
    unreachableResources,
    activePathCandidates,
    references,
    scripts,
    jsonFiles,
    openai,
    runtimeClosure: {
      root: closure.root,
      complete: closure.complete,
      nodes: closure.nodes,
      edges: closure.edges,
    },
    issues: identifiedIssues,
    note: 'Error diagnostics are mandatory machine evidence; warnings and size thresholds are evidence leads.',
  };

  if (options.format === 'text') {
    const output = [
      `Skill: ${result.package.name ?? 'unknown'}`,
      `Files: ${result.totalFiles}`,
      `Issues: ${result.issues.length}`,
      `References requiring semantic audit: ${references.filter((reference) => reference.requiresSemanticAudit).length}`,
    ].join('\n') + '\n';
    if (options.outputPath) await writeFile(options.outputPath, output, 'utf8');
    else process.stdout.write(output);
  } else {
    const output = JSON.stringify(result, null, 2) + '\n';
    if (options.outputPath) await writeFile(options.outputPath, output, 'utf8');
    else process.stdout.write(output);
  }
  if (identifiedIssues.some((issue) => issue.severity === 'error')) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write('[ERROR] ' + error.message + '\n');
  process.exit(1);
});
