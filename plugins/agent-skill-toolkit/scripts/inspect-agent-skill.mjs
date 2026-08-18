#!/usr/bin/env node

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function usage() {
  return 'Usage: inspect-agent-skill.mjs <skill-dir> [--format json|text]';
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const positional = [];
  let format = 'json';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--format') format = argv[++index];
    else if (value.startsWith('-')) throw new Error('Unknown option: ' + value);
    else positional.push(value);
  }
  if (positional.length !== 1) throw new Error(usage());
  if (!['json', 'text'].includes(format)) throw new Error('--format must be json or text.');
  return { root: path.resolve(positional[0]), format };
}

const RESOURCE_PATTERN = /(?:references|scripts|assets|agents|evals)\/[A-Za-z0-9._()\-/]+/gu;
const SKIP_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);

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
  return [...new Set([...text.matchAll(RESOURCE_PATTERN)].map((match) => cleanResource(match[0])))]
    .sort();
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
  for (const resource of missingPointers) {
    issues.push({ code: 'missing-resource', severity: 'error', path: resource, message: 'Referenced resource does not exist.' });
  }

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

  const resourceRoots = ['references/', 'scripts/', 'assets/', 'agents/', 'evals/'];
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

  const result = {
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
    issues,
    note: 'Static diagnostics and size thresholds are evidence leads, not automatic findings.',
  };

  if (options.format === 'text') {
    process.stdout.write([
      `Skill: ${result.package.name ?? 'unknown'}`,
      `Files: ${result.totalFiles}`,
      `Issues: ${result.issues.length}`,
      `References requiring semantic audit: ${references.filter((reference) => reference.requiresSemanticAudit).length}`,
    ].join('\n') + '\n');
  } else {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
  if (issues.some((issue) => issue.severity === 'error')) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write('[ERROR] ' + error.message + '\n');
  process.exit(1);
});
