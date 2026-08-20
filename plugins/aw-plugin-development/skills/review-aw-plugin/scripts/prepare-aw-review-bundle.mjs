#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  findSkillRoots,
  isPluginEvidenceArtifact,
} from './review-artifact-policy.mjs';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const IGNORED_NAMES = new Set(['.DS_Store', '.git', 'node_modules']);

function fail(message) {
  throw new Error(message);
}

function optionValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${flag} requires a value.`);
  return value;
}

function parseNamedPath(value, flag, defaultName = null) {
  const separator = value.indexOf('=');
  if (separator < 0) {
    if (defaultName === null || !value) fail(`${flag} requires name=path.`);
    return { name: defaultName, filePath: path.resolve(value) };
  }
  const name = value.slice(0, separator);
  const filePath = value.slice(separator + 1);
  if (!name || !filePath) fail(`${flag} requires non-empty name and path.`);
  return { name, filePath: path.resolve(filePath) };
}

function usage() {
  return [
    'Usage: prepare-aw-review-bundle.mjs <plugin-root> [options]',
    '',
    'Options:',
    '  --repo-root <path>       Target workspace root. Default: current directory.',
    '  --source <name=path>     Add a companion plugin source root. Repeatable.',
    '  --final <profile=path>   Add a materialized file or directory. Repeatable.',
    '  --evidence <path>        Add an evidence file or directory. Repeatable.',
    '  --eval-audit <path>      Add one passing EvalAuditResult.',
    '  --eval-case <path>       Bind an Eval case/corpus file to the audit. Repeatable.',
    '  --eval-result <path>     Add one EvalRunBundle; requires --eval-audit.',
    '  --client <name>          codex or claude. Default: codex.',
    '  -h, --help               Show this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (!args[0] || args[0].startsWith('--')) fail('Provide <plugin-root>.');
  const options = {
    pluginRoot: path.resolve(args[0]),
    repoRoot: process.cwd(),
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
      const parsed = parseNamedPath(optionValue(args, index, flag), flag);
      options.sources.push({ name: parsed.name, root: parsed.filePath });
      index += 1;
    } else if (flag === '--final') {
      const parsed = parseNamedPath(optionValue(args, index, flag), flag, 'default');
      options.finals.push({ profile: parsed.name, artifactPath: parsed.filePath });
      index += 1;
    } else if (flag === '--evidence') {
      options.evidence.push(path.resolve(optionValue(args, index, flag)));
      index += 1;
    } else if (flag === '--eval-audit') {
      options.evalAudit = path.resolve(optionValue(args, index, flag));
      index += 1;
    } else if (flag === '--eval-result') {
      if (options.evalResults.length > 0) {
        fail(
          'ReviewInputBundle v4 accepts only one Eval execution bundle per target; provide --eval-result only once.',
        );
      }
      options.evalResults.push(path.resolve(optionValue(args, index, flag)));
      index += 1;
    } else if (flag === '--eval-case') {
      options.evalCases.push(path.resolve(optionValue(args, index, flag)));
      index += 1;
    } else if (flag === '--client') {
      options.client = optionValue(args, index, flag);
      index += 1;
    } else if (flag === '--repo-root') {
      options.repoRoot = path.resolve(optionValue(args, index, flag));
      index += 1;
    } else {
      fail(`Unknown option: ${flag}`);
    }
  }
  if (!['codex', 'claude'].includes(options.client)) fail('--client must be codex or claude.');
  if (options.evalAudit && options.evalCases.length === 0)
    fail('--eval-audit requires at least one --eval-case.');
  if (!options.evalAudit && options.evalCases.length > 0)
    fail('--eval-case requires --eval-audit.');
  if (options.evalResults.length > 0 && !options.evalAudit)
    fail('--eval-result requires --eval-audit and its case corpus.');
  return options;
}

function sha256(data) {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function portablePath(filePath) {
  const relative = path.relative(process.cwd(), filePath);
  return (relative || '.').split(path.sep).join('/');
}

async function collectFiles(root) {
  const rootStat = await stat(root);
  if (rootStat.isFile()) return [{ absolutePath: root, relativePath: path.basename(root) }];
  if (!rootStat.isDirectory()) fail(`Artifact is not a file or directory: ${root}`);
  const files = [];
  async function walk(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) fail(`Artifact tree cannot contain symlinks: ${relativePath}`);
      if (entry.isDirectory()) await walk(absolutePath, relativePath);
      else if (entry.isFile())
        files.push({ absolutePath, relativePath: relativePath.split(path.sep).join('/') });
    }
  }
  await walk(root);
  return files;
}

async function jsonDocument(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`);
  }
}

function artifactRole(relativePath, skillRoots) {
  if (isPluginEvidenceArtifact(relativePath, skillRoots)) return 'evidence';
  if (
    relativePath === '.agents-plugin/plugin.json' ||
    relativePath === '.mcp.json' ||
    relativePath.endsWith('.app.json') ||
    relativePath.startsWith('config/') ||
    relativePath.startsWith('renderers/')
  )
    return 'project-profile';
  return 'source';
}

async function gitCurrentness(root) {
  try {
    const { stdout: repository } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      encoding: 'utf8',
    });
    const repositoryRoot = repository.trim();
    const { stdout: statusOutput } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', root],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    const dirtyPaths = new Set();
    for (const entry of statusOutput.split('\0')) {
      if (entry.length < 4 || entry[2] !== ' ') continue;
      dirtyPaths.add(path.resolve(repositoryRoot, entry.slice(3)));
    }
    return { repositoryRoot, dirtyPaths };
  } catch {
    return { repositoryRoot: null, dirtyPaths: null };
  }
}

async function sourceDigest(roots) {
  const hash = createHash('sha256');
  for (const root of [...roots].sort((left, right) => left.name.localeCompare(right.name))) {
    hash.update(root.name);
    hash.update('\0');
    for (const file of await collectFiles(root.root)) {
      if (isPluginEvidenceArtifact(file.relativePath, root.skillRoots)) continue;
      hash.update(file.relativePath);
      hash.update('\0');
      hash.update(await readFile(file.absolutePath));
      hash.update('\0');
    }
  }
  return `sha256:${hash.digest('hex')}`;
}

async function artifactEntries(root, role, owner, profile, currentness) {
  return Promise.all(
    (await collectFiles(root)).map(async (file) => ({
      role,
      path: portablePath(file.absolutePath),
      profile,
      digest: sha256(await readFile(file.absolutePath)),
      owner,
      currentness,
    })),
  );
}

async function runValidator(script, args, label) {
  try {
    await execFileAsync(process.execPath, [script, ...args], { encoding: 'utf8' });
  } catch (error) {
    fail(`${label} validation failed: ${String(error.stdout || error.message || error)}`);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  const manifestPath = path.join(options.pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = await jsonDocument(manifestPath, 'Plugin manifest');
  if (!manifest.name) fail('Plugin manifest has no name.');

  const roots = [
    {
      name: manifest.name,
      root: options.pluginRoot,
      skillRoots: await findSkillRoots(options.pluginRoot, manifest.skills),
    },
  ];
  for (const source of options.sources) {
    if (roots.some((entry) => entry.name === source.name))
      fail(`Duplicate source owner: ${source.name}`);
    const sourceManifest = await jsonDocument(
      path.join(source.root, '.agents-plugin', 'plugin.json'),
      'Companion manifest',
    );
    if (sourceManifest.name !== source.name) fail(`--source name mismatch: ${source.name}`);
    roots.push({
      ...source,
      skillRoots: await findSkillRoots(source.root, sourceManifest.skills),
    });
  }

  const artifacts = [];
  let targetGit = { repositoryRoot: null, dirtyPaths: null };
  for (const root of roots) {
    const git = await gitCurrentness(root.root);
    if (root.name === manifest.name) targetGit = git;
    for (const file of await collectFiles(root.root)) {
      const role = artifactRole(file.relativePath, root.skillRoots);
      const canonicalPath = await realpath(file.absolutePath);
      artifacts.push({
        role,
        path: portablePath(file.absolutePath),
        profile: role === 'project-profile' ? 'aw' : null,
        digest: sha256(await readFile(file.absolutePath)),
        owner: root.name,
        currentness:
          role === 'evidence'
            ? 'historical'
            : git.dirtyPaths === null
              ? 'unknown'
              : git.dirtyPaths.has(canonicalPath)
                ? 'dirty'
                : 'current',
      });
    }
  }

  for (const final of options.finals) {
    artifacts.push(
      ...(await artifactEntries(
        final.artifactPath,
        'final',
        manifest.name,
        final.profile,
        'unknown',
      )),
    );
  }

  const evidencePaths = new Set([
    ...options.evidence,
    ...options.evalResults,
    ...(options.evalAudit ? [options.evalAudit] : []),
  ]);
  for (const evidencePath of evidencePaths) {
    artifacts.push(
      ...(await artifactEntries(evidencePath, 'evidence', manifest.name, null, 'unknown')),
    );
  }

  const pluginDigest = await sourceDigest(roots);
  const evalAudit = options.evalAudit ? await jsonDocument(options.evalAudit, 'Eval audit') : null;
  const stages = [];
  let evalAuditDigest = null;
  if (options.evalAudit) {
    const validator = path.join(scriptRoot, 'validate-eval-audit-result.mjs');
    await runValidator(
      validator,
      [
        options.evalAudit,
        ...options.evalCases.flatMap((casePath) => ['--case', casePath]),
        '--format',
        'json',
      ],
      'Eval audit',
    );
    evalAuditDigest = sha256(await readFile(options.evalAudit));
    stages.push({
      id: 'eval-audit',
      producer: evalAudit.producer,
      independentContext: evalAudit.independentContext,
      subjectDigest: evalAudit.targetSkillDigest,
      resultPath: path.resolve(options.evalAudit),
      resultDigest: evalAuditDigest,
      schema: 'EvalAuditResult',
      profile: null,
    });
  }

  const evalResults = [];
  for (const resultPath of options.evalResults) {
    const result = await jsonDocument(resultPath, 'Eval result');
    const validator = path.join(scriptRoot, 'validate-json-contract.mjs');
    const schema = path.join(scriptRoot, '..', 'assets', 'eval-run-bundle.schema.json');
    await runValidator(validator, [schema, resultPath, '--format', 'json'], 'Eval result');
    if (result.targetSkillDigest !== evalAudit.targetSkillDigest)
      fail('Eval result targetSkillDigest does not match Eval audit.');
    if (result.caseCorpusDigest !== evalAudit.caseCorpusDigest)
      fail('Eval result caseCorpusDigest does not match Eval audit.');
    if (result.preflightAuditDigest !== evalAuditDigest)
      fail('Eval result preflightAuditDigest does not match the supplied Eval audit file.');
    evalResults.push(result);
    stages.push({
      id: 'eval-execution',
      producer: result.producer,
      independentContext: result.independentContext,
      subjectDigest: result.targetSkillDigest,
      resultPath: path.resolve(resultPath),
      resultDigest: sha256(await readFile(resultPath)),
      schema: 'EvalRunBundle',
      profile: null,
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 4,
        target: {
          kind: 'aw-plugin',
          name: manifest.name,
          profile: null,
          sourceDigest: pluginDigest,
        },
        artifacts: artifacts.sort(
          (left, right) =>
            left.path.localeCompare(right.path) || left.role.localeCompare(right.role),
        ),
        environment: {
          repository: path.basename(options.repoRoot) || 'aw-workspace',
          repositoryRoot: options.repoRoot,
          gitRepositoryRoot: targetGit.repositoryRoot,
          client: options.client,
          dependencyMode: 'manual',
          capabilities: [
            ...(options.finals.length > 0 ? ['materialized-final'] : []),
            ...(options.evalAudit ? ['eval-audit'] : []),
            ...(options.evalResults.length > 0 ? ['eval-results'] : []),
          ],
        },
        orchestration: { stageOwner: 'caller', providedStages: stages },
        evalAudit,
        evalResults,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`[ERROR] ${error.message}\n`);
  process.exit(1);
});
