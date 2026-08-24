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
const IGNORED_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);
const PRODUCTION_DIGEST_DOMAIN = 'aw-production-records-v1';

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
          'ReviewInputBundle v5 accepts only one Eval execution bundle per target; provide --eval-result only once.',
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

function comparePosixPaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function updateLengthPrefixed(hash, value) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function productionDigest(records) {
  const hash = createHash('sha256');
  updateLengthPrefixed(hash, PRODUCTION_DIGEST_DOMAIN);
  for (const record of [...records].sort((left, right) =>
    comparePosixPaths(left.path, right.path))) {
    updateLengthPrefixed(hash, record.path);
    updateLengthPrefixed(hash, record.mode);
    updateLengthPrefixed(hash, createHash('sha256').update(record.content).digest());
  }
  return `sha256:${hash.digest('hex')}`;
}

function normalizedRegularFileMode(mode) {
  return process.platform !== 'win32' && (mode & 0o111) !== 0 ? '100755' : '100644';
}

function isIgnoredProductionPath(relativePath) {
  return relativePath.split(/[\\/]/u).includes('.DS_Store');
}

function artifactPath(repositoryRoot, filePath) {
  const relative = path.relative(repositoryRoot, filePath);
  if (
    !relative
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    fail(`Artifact must be inside the repository root: ${filePath}`);
  }
  return relative.split(path.sep).join('/');
}

async function collectFiles(root) {
  const rootLinkStat = await lstat(root);
  if (rootLinkStat.isSymbolicLink()) fail(`Artifact cannot be a symlink: ${root}`);
  const rootStat = await stat(root);
  if (rootStat.isFile())
    return [{
      absolutePath: root,
      relativePath: path.basename(root),
      mode: normalizedRegularFileMode(rootStat.mode),
    }];
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
      else if (entry.isFile()) {
        const fileStat = await stat(absolutePath);
        files.push({
          absolutePath,
          relativePath: relativePath.split(path.sep).join('/'),
          mode: normalizedRegularFileMode(fileStat.mode),
        });
      }
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
    const canonicalRepositoryRoot = await realpath(repositoryRoot);
    const sourceRoot = await realpath(root);
    const rootPathspec = path.relative(canonicalRepositoryRoot, sourceRoot) || '.';
    const { stdout: statusOutput } = await execFileAsync(
      'git',
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--no-renames',
        '--untracked-files=all',
        '--',
        rootPathspec,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    const dirtyPaths = new Map();
    for (const entry of statusOutput.split('\0')) {
      if (entry.length < 4 || entry[2] !== ' ') continue;
      const status = entry.slice(0, 2);
      dirtyPaths.set(path.resolve(canonicalRepositoryRoot, entry.slice(3)), status);
    }
    const { stdout: ignoredOutput } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', rootPathspec],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    const ignoredPaths = new Set(
      ignoredOutput
        .split('\0')
        .filter(Boolean)
        .map((entry) => path.resolve(canonicalRepositoryRoot, entry)),
    );
    const { stdout: stagedOutput } = await execFileAsync(
      'git',
      ['ls-files', '--stage', '-z', '--', rootPathspec],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    const trackedModes = new Map();
    for (const entry of stagedOutput.split('\0')) {
      if (!entry) continue;
      const separator = entry.indexOf('\t');
      if (separator < 0) continue;
      const [mode, , stage] = entry.slice(0, separator).split(' ');
      if (stage !== '0') continue;
      trackedModes.set(
        path.resolve(canonicalRepositoryRoot, entry.slice(separator + 1)),
        mode,
      );
    }
    return {
      repositoryRoot,
      sourceRoot,
      dirtyPaths,
      ignoredPaths,
      trackedModes,
    };
  } catch {
    return {
      repositoryRoot: null,
      sourceRoot: null,
      dirtyPaths: null,
      ignoredPaths: null,
      trackedModes: null,
    };
  }
}

function dirtyStatusReason(status, role) {
  if (status.includes('?')) return `untracked ${role} file`;
  if (status.includes('D')) return `deleted ${role} file`;
  if (status.includes('A')) return `added ${role} file`;
  return `modified ${role} file`;
}

async function sourceDigest(roots) {
  const records = [];
  for (const root of roots) {
    for (const file of await collectFiles(root.root)) {
      if (isPluginEvidenceArtifact(file.relativePath, root.skillRoots)) continue;
      records.push({
        path: `${root.name}/${file.relativePath}`,
        mode: file.mode,
        content: await readFile(file.absolutePath),
      });
    }
  }
  return productionDigest(records);
}

async function artifactEntries(root, role, owner, profile, currentness, repositoryRoot) {
  return Promise.all(
    (await collectFiles(root)).map(async (file) => ({
      role,
      path: artifactPath(repositoryRoot, file.absolutePath),
      profile,
      digest: sha256(await readFile(file.absolutePath)),
      mode: file.mode,
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
  let targetGit = { repositoryRoot: null, dirtyPaths: null, ignoredPaths: null };
  const productionDirtyReasons = [];
  let sourceCurrentnessUnknown = false;
  for (const root of roots) {
    const git = await gitCurrentness(root.root);
    if (root.name === manifest.name) targetGit = git;
    if (git.dirtyPaths === null) sourceCurrentnessUnknown = true;
    if (git.dirtyPaths !== null) {
      for (const [dirtyPath, status] of git.dirtyPaths) {
        const relativePath = path.relative(git.sourceRoot, dirtyPath).split(path.sep).join('/');
        if (
          relativePath === '..'
          || relativePath.startsWith('../')
          || isIgnoredProductionPath(relativePath)
          || isPluginEvidenceArtifact(relativePath, root.skillRoots)
        ) continue;
        productionDirtyReasons.push(
          `${dirtyStatusReason(status, 'production source')}: ${path.resolve(root.root, relativePath)}`,
        );
      }
    }
    if (git.ignoredPaths !== null) {
      for (const ignoredPath of git.ignoredPaths) {
        const relativePath = path.relative(git.sourceRoot, ignoredPath).split(path.sep).join('/');
        if (
          relativePath === '..'
          || relativePath.startsWith('../')
          || isIgnoredProductionPath(relativePath)
          || isPluginEvidenceArtifact(relativePath, root.skillRoots)
        ) continue;
        productionDirtyReasons.push(
          `ignored production source file: ${path.resolve(root.root, relativePath)}`,
        );
      }
    }
    for (const file of await collectFiles(root.root)) {
      const role = artifactRole(file.relativePath, root.skillRoots);
      const canonicalPath = await realpath(file.absolutePath);
      const dirtyStatus = git.dirtyPaths?.get(canonicalPath);
      const ignored = git.ignoredPaths?.has(canonicalPath);
      const trackedMode = git.trackedModes?.get(canonicalPath);
      if (trackedMode === '120000') {
        fail(`Artifact tree cannot contain Git symlinks: ${file.relativePath}`);
      }
      const modeMismatchReason =
        role !== 'evidence' &&
        trackedMode !== undefined &&
        ['100644', '100755'].includes(trackedMode) &&
        trackedMode !== file.mode
          ? `working mode ${file.mode} differs from Git index mode ${trackedMode}`
          : null;
      const currentness =
        role === 'evidence'
          ? 'historical'
          : git.dirtyPaths === null
            ? 'unknown'
            : dirtyStatus || ignored || modeMismatchReason
              ? 'dirty'
              : 'current';
      if (modeMismatchReason) {
        productionDirtyReasons.push(
          `${modeMismatchReason}: ${path.resolve(root.root, file.relativePath)}`,
        );
      }
      artifacts.push({
        role,
        path: artifactPath(options.repoRoot, file.absolutePath),
        profile: role === 'project-profile' ? 'aw' : null,
        digest: sha256(await readFile(file.absolutePath)),
        mode: file.mode,
        owner: root.name,
        currentness,
        ...(currentness === 'dirty'
          ? {
              currentnessReason: modeMismatchReason ??
                (ignored ? `ignored ${role} file` : dirtyStatusReason(dirtyStatus, role)),
            }
          : {}),
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
        options.repoRoot,
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
      ...(await artifactEntries(
        evidencePath,
        'evidence',
        manifest.name,
        null,
        'unknown',
        options.repoRoot,
      )),
    );
  }

  const pluginDigest = await sourceDigest(roots);
  const evalAudit = options.evalAudit ? await jsonDocument(options.evalAudit, 'Eval audit') : null;
  const stages = [];
  let evalAuditDigest = null;
  if (options.evalAudit) {
    const validator = path.resolve(scriptRoot, '../../../../plugins/agent-skill-toolkit/scripts/validate-eval-audit-result.mjs');
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
    const validator = path.resolve(scriptRoot, '../../../../plugins/agent-skill-toolkit/scripts/validate-json-contract.mjs');
    const schema = path.resolve(scriptRoot, '../../../../plugins/agent-skill-toolkit/schemas/eval-run-bundle.schema.json');
    await runValidator(validator, [schema, resultPath, '--format', 'json'], 'Eval result');
    if (result.targetSkillDigest !== evalAudit.targetSkillDigest)
      fail('Eval result targetSkillDigest does not match Eval audit.');
    if (result.caseCorpusDigest !== evalAudit.caseCorpusDigest)
      fail('Eval result caseCorpusDigest does not match Eval audit.');
    evalResults.push(result);
    stages.push({
      id: 'eval-execution',
      producer: result.runner.id,
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
        schemaVersion: 5,
        target: {
          kind: 'aw-plugin',
          name: manifest.name,
          profile: null,
          sourceDigest: pluginDigest,
          currentness:
            productionDirtyReasons.length > 0
              ? 'dirty'
              : sourceCurrentnessUnknown
                ? 'unknown'
                : 'current',
          ...(productionDirtyReasons.length > 0
            ? { dirtyReasons: [...new Set(productionDirtyReasons)].sort() }
            : {}),
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
