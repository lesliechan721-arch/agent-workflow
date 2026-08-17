#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const IGNORED_NAMES = new Set(['.DS_Store', '.git', 'node_modules']);

function fail(message) {
  throw new Error(message);
}

function usage() {
  process.stdout.write([
    'Usage:',
    '  node prepare-aw-review-bundle.mjs <plugin-root> [options]',
    '',
    'Options:',
    '  --final <profile=path>  Add one materialized file or directory. Repeatable.',
    '  --source <name=path>    Add one companion source root used by the review batch. Repeatable.',
    '  --evidence <path>       Add one evidence file or directory. Repeatable.',
    '  --eval-audit <path>     Load one EvalAuditResult JSON document.',
    '  --eval-case <path>      Bind one Eval case or corpus file to the audit. Repeatable.',
    '  --eval-result <path>    Load one Eval result JSON document. Repeatable.',
    '  --client <name>         codex or claude. Default: codex.',
    '  -h, --help              Show this help.',
    '',
    'The command only reads artifacts and writes ReviewInputBundle JSON to stdout.',
    '',
  ].join('\n'));
}

function optionValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(flag + ' requires a value.');
  return value;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    usage();
    process.exit(0);
  }
  if (!args[0] || args[0].startsWith('--')) fail('Provide <plugin-root>.');

  const options = {
    pluginRoot: path.resolve(args[0]),
    client: 'codex',
    finals: [],
    sources: [],
    evidence: [],
    evalResults: [],
    evalAudit: null,
    evalCases: [],
  };
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--source') {
      const value = optionValue(args, index, flag);
      index += 1;
      const separator = value.indexOf('=');
      if (separator <= 0 || value.slice(separator + 1) === '') {
        fail('--source requires a non-empty name and path.');
      }
      options.sources.push({
        name: value.slice(0, separator),
        root: path.resolve(value.slice(separator + 1)),
      });
    } else if (flag === '--final') {
      const value = optionValue(args, index, flag);
      index += 1;
      const separator = value.indexOf('=');
      if (separator === 0 || (separator > 0 && value.slice(separator + 1) === '')) {
        fail('--final requires a non-empty profile and path.');
      }
      options.finals.push({
        profile: separator > 0 ? value.slice(0, separator) : 'default',
        artifactPath: path.resolve(separator > 0 ? value.slice(separator + 1) : value),
      });
    } else if (flag === '--evidence') {
      options.evidence.push(path.resolve(optionValue(args, index, flag)));
      index += 1;
    } else if (flag === '--eval-audit') {
      options.evalAudit = path.resolve(optionValue(args, index, flag));
      index += 1;
    } else if (flag === '--eval-result') {
      options.evalResults.push(path.resolve(optionValue(args, index, flag)));
      index += 1;
    } else if (flag === '--eval-case') {
      options.evalCases.push(path.resolve(optionValue(args, index, flag)));
      index += 1;
    } else if (flag === '--client') {
      options.client = optionValue(args, index, flag);
      index += 1;
    } else {
      fail('Unknown option: ' + flag);
    }
  }
  if (!['codex', 'claude'].includes(options.client)) {
    fail('--client must be codex or claude.');
  }
  if (options.evalAudit && options.evalCases.length === 0) {
    fail('--eval-audit requires at least one --eval-case for corpus digest binding.');
  }
  if (!options.evalAudit && options.evalCases.length > 0) {
    fail('--eval-case requires --eval-audit.');
  }
  return options;
}

function sha256(data) {
  return 'sha256:' + createHash('sha256').update(data).digest('hex');
}

function portablePath(filePath) {
  const relative = path.relative(process.cwd(), filePath);
  return (relative || '.').split(path.sep).join('/');
}

function isProjectProfile(relativePath) {
  return relativePath === '.agents-plugin/plugin.json'
    || relativePath === '.mcp.json'
    || relativePath.endsWith('.app.json')
    || relativePath.startsWith('config/')
    || relativePath.startsWith('renderers/');
}

function sourceArtifactRole(relativePath) {
  if (
    relativePath.startsWith('reports/')
    || /^skills\/[^/]+\/reports\//u.test(relativePath)
  ) {
    return 'evidence';
  }
  return isProjectProfile(relativePath) ? 'project-profile' : 'source';
}

async function collectFiles(root) {
  const rootStat = await stat(root);
  if (rootStat.isFile()) return [{ absolutePath: root, relativePath: path.basename(root) }];
  if (!rootStat.isDirectory()) fail('Artifact is not a file or directory: ' + root);

  const files = [];
  async function walk(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) await walk(absolutePath, relativePath);
      else if (entry.isFile()) {
        files.push({
          absolutePath,
          relativePath: relativePath.split(path.sep).join('/'),
        });
      }
    }
  }
  await walk(root);
  return files;
}

async function gitCurrentness(pluginRoot) {
  try {
    const { stdout: repository } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: pluginRoot,
      encoding: 'utf8',
    });
    const repositoryRoot = repository.trim();
    const { stdout: statusOutput } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', pluginRoot],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    const dirtyPaths = new Set();
    for (const entry of statusOutput.split('\0')) {
      if (entry.length < 4) continue;
      const candidate = entry.slice(3);
      dirtyPaths.add(path.resolve(repositoryRoot, candidate));
    }
    return {
      repositoryRoot,
      dirtyPaths,
    };
  } catch {
    return { repositoryRoot: null, dirtyPaths: null };
  }
}

async function jsonDocument(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    fail(label + ' is not valid JSON: ' + filePath + ': ' + error.message);
  }
}

async function artifactEntries(root, role, owner, profile, currentness) {
  const files = await collectFiles(root);
  return Promise.all(files.map(async (file) => ({
    role,
    path: portablePath(file.absolutePath),
    profile,
    digest: sha256(await readFile(file.absolutePath)),
    owner,
    currentness,
    relativePath: file.relativePath,
  })));
}

async function authorSourceDigest(roots) {
  const hash = createHash('sha256');
  for (const entry of [...roots].sort((left, right) => left.name.localeCompare(right.name))) {
    hash.update(entry.name);
    hash.update('\0');
    const files = await collectFiles(entry.root);
    for (const file of files) {
      if (file.relativePath === 'reports' || file.relativePath.startsWith('reports/')) continue;
      hash.update(file.relativePath);
      hash.update('\0');
      hash.update(await readFile(file.absolutePath));
      hash.update('\0');
    }
  }
  return 'sha256:' + hash.digest('hex');
}

async function main() {
  const options = parseArgs(process.argv);
  const manifestPath = path.join(options.pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = await jsonDocument(manifestPath, 'Plugin manifest');
  if (!manifest.name) fail('Plugin manifest has no name: ' + manifestPath);

  const sourceRoots = [{ name: manifest.name, root: options.pluginRoot }];
  for (const source of options.sources) {
    if (sourceRoots.some((entry) => entry.name === source.name)) {
      fail('Duplicate source owner: ' + source.name);
    }
    const sourceManifest = await jsonDocument(
      path.join(source.root, '.agents-plugin', 'plugin.json'),
      'Companion plugin manifest',
    );
    if (sourceManifest.name !== source.name) {
      fail('--source name does not match its plugin manifest: ' + source.name);
    }
    sourceRoots.push(source);
  }
  const sourceArtifacts = [];
  let targetGit = null;
  for (const source of sourceRoots) {
    const git = await gitCurrentness(source.root);
    if (source.name === manifest.name) targetGit = git;
    const sourceFiles = await collectFiles(source.root);
    sourceArtifacts.push(...await Promise.all(sourceFiles.map(async (file) => {
      const role = sourceArtifactRole(file.relativePath);
      const canonicalPath = await realpath(file.absolutePath);
      return {
        role,
        path: portablePath(file.absolutePath),
        profile: role === 'project-profile' ? 'aw' : null,
        digest: sha256(await readFile(file.absolutePath)),
        owner: source.name,
        currentness: role === 'evidence'
          ? 'historical'
          : git.dirtyPaths === null
            ? 'unknown'
            : git.dirtyPaths.has(canonicalPath) ? 'dirty' : 'current',
        relativePath: file.relativePath,
      };
    })));
  }
  const sourceDigest = await authorSourceDigest(sourceRoots);

  const finalArtifacts = [];
  for (const final of options.finals) {
    finalArtifacts.push(...await artifactEntries(
      final.artifactPath,
      'final',
      manifest.name,
      final.profile,
      'unknown',
    ));
  }

  const evidencePaths = new Set([
    ...options.evidence,
    ...options.evalResults,
    ...(options.evalAudit ? [options.evalAudit] : []),
  ]);
  const evidenceArtifacts = [];
  for (const evidencePath of evidencePaths) {
    evidenceArtifacts.push(...await artifactEntries(
      evidencePath,
      'evidence',
      manifest.name,
      null,
      'unknown',
    ));
  }

  const artifacts = [...sourceArtifacts, ...finalArtifacts, ...evidenceArtifacts]
    .map(({ relativePath: _relativePath, ...artifact }) => artifact)
    .sort((left, right) => left.path.localeCompare(right.path) || left.role.localeCompare(right.role));

  const evalAudit = options.evalAudit
    ? await jsonDocument(options.evalAudit, 'Eval audit')
    : null;
  if (options.evalAudit) {
    const validator = path.join(scriptRoot, 'validate-eval-audit-result.mjs');
    try {
      await execFileAsync(process.execPath, [
        validator,
        options.evalAudit,
        ...options.evalCases.flatMap((casePath) => ['--case', casePath]),
        '--format',
        'json',
      ], { encoding: 'utf8' });
    } catch (error) {
      fail('Eval audit validation failed: ' + String(error.stdout || error.message || error));
    }
  }
  const evalResults = [];
  for (const resultPath of options.evalResults) {
    evalResults.push(await jsonDocument(resultPath, 'Eval result'));
  }

  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    target: {
      kind: 'aw-plugin',
      name: manifest.name,
      sourceDigest,
    },
    artifacts,
    environment: {
      repository: 'agent-workflows',
      repositoryRoot: targetGit.repositoryRoot,
      client: options.client,
      dependencyMode: 'manual',
      capabilities: [
        ...(options.finals.length > 0 ? ['materialized-final'] : []),
        ...(options.evalAudit ? ['eval-audit'] : []),
        ...(options.evalResults.length > 0 ? ['eval-results'] : []),
      ],
    },
    orchestration: {
      stageOwner: 'caller',
      providedStages: [
        'source-bundle',
        ...(options.finals.length > 0 ? ['materialized-profile-review'] : []),
        ...(options.evalAudit ? ['eval-audit'] : []),
      ],
    },
    evalAudit,
    evalResults,
  }, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write('[ERROR] ' + error.message + '\n');
  process.exit(1);
});
