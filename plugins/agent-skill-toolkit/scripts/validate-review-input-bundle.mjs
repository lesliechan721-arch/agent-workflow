#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateEvalRunBundle } from './validate-eval-run-bundle.mjs';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const IGNORED_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);
const PRODUCTION_DIGEST_DOMAIN = 'aw-production-records-v1';

function usage() {
  return 'Usage: validate-review-input-bundle.mjs <bundle.json> [--handoff-root path] [--format text|json]';
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let handoffRoot = null;
  let format = 'text';
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--handoff-root') handoffRoot = path.resolve(argv[++index] ?? '');
    else if (value === '--format') format = argv[++index];
    else if (value.startsWith('-')) throw new Error(`Unknown option: ${value}`);
    else positional.push(path.resolve(value));
  }
  if (positional.length !== 1) throw new Error(usage());
  if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json.');
  return { bundlePath: positional[0], handoffRoot, format };
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

async function digest(filePath) {
  return `sha256:${createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex')}`;
}

function normalizedRegularFileMode(mode) {
  return process.platform !== 'win32' && (mode & 0o111) !== 0 ? '100755' : '100644';
}

async function gitCurrentness(root) {
  try {
    const { stdout: repository } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      encoding: 'utf8',
    });
    const repositoryRoot = await realpath(repository.trim());
    const sourceRoot = await realpath(root);
    const rootPathspec = path.relative(repositoryRoot, sourceRoot) || '.';
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
      dirtyPaths.set(path.resolve(repositoryRoot, entry.slice(3)), entry.slice(0, 2));
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
        .map((entry) => path.resolve(repositoryRoot, entry)),
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
      trackedModes.set(path.resolve(repositoryRoot, entry.slice(separator + 1)), mode);
    }
    return { sourceRoot, dirtyPaths, ignoredPaths, trackedModes };
  } catch {
    return { sourceRoot: null, dirtyPaths: null, ignoredPaths: null, trackedModes: null };
  }
}

function dirtyStatusReason(status, role) {
  if (status.includes('?')) return `untracked ${role} file`;
  if (status.includes('D')) return `deleted ${role} file`;
  if (status.includes('A')) return `added ${role} file`;
  return `modified ${role} file`;
}

function isIgnoredProductionPath(relativePath) {
  return relativePath.split(/[\\/]/u).includes('.DS_Store');
}

function isCanonicalArtifactPath(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && !value.includes('\\')
    && !path.posix.isAbsolute(value)
    && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
    && path.posix.normalize(value) === value
  );
}

async function readStrictArtifact(repositoryRoot, relativePath) {
  const segments = relativePath.split('/');
  let candidate = repositoryRoot;
  for (let index = 0; index < segments.length; index += 1) {
    candidate = path.join(candidate, segments[index]);
    const entry = await lstat(candidate);
    if (entry.isSymbolicLink()) throw new Error('symlink');
    if (index < segments.length - 1 && !entry.isDirectory()) throw new Error('not a directory');
    if (index === segments.length - 1 && !entry.isFile()) throw new Error('not a regular file');
  }
  const info = await stat(candidate);
  return {
    absolutePath: candidate,
    content: await readFile(candidate),
    mode: normalizedRegularFileMode(info.mode),
  };
}

function productionRoles(kind) {
  if (kind === 'aw-plugin') return new Set(['source', 'project-profile']);
  if (kind === 'materialized-skill') return new Set(['final']);
  return new Set(['source']);
}

function relativeBelow(root, candidate) {
  const relative = path.posix.relative(root, candidate);
  return relative && relative !== '..' && !relative.startsWith('../') ? relative : null;
}

function skillAuthorOnlyPath(relativePath) {
  return ['evals', 'reports'].includes(relativePath.split('/')[0]);
}

async function collectRegularFiles(root) {
  const files = [];
  async function walk(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink: ${relativePath}`);
      if (entry.isDirectory()) await walk(absolutePath, relativePath);
      else if (entry.isFile()) {
        const info = await stat(absolutePath);
        files.push({
          absolutePath,
          relativePath: relativePath.split(path.sep).join('/'),
          content: await readFile(absolutePath),
          mode: normalizedRegularFileMode(info.mode),
        });
      }
    }
  }
  await walk(root);
  return files;
}

function findSkillRoots(files, skillsDeclaration = './skills') {
  if (
    typeof skillsDeclaration !== 'string'
    || !skillsDeclaration.startsWith('./')
    || !isCanonicalArtifactPath(skillsDeclaration.slice(2))
  ) {
    throw new Error('invalid skills declaration');
  }
  const skillsRoot = skillsDeclaration.slice(2);
  const candidates = files
    .filter((file) => {
      const relative = relativeBelow(skillsRoot, file.relativePath);
      return relative && path.posix.basename(relative) === 'SKILL.md';
    })
    .map((file) => path.posix.dirname(file.relativePath))
    .sort((left, right) => left.localeCompare(right));
  const roots = [];
  for (const candidate of candidates) {
    if (!roots.some((root) => candidate.startsWith(`${root}/`))) roots.push(candidate);
  }
  return roots;
}

function isPluginEvidenceArtifact(relativePath, skillRoots) {
  if (relativePath === 'reports' || relativePath.startsWith('reports/')) return true;
  return skillRoots.some((skillRoot) => {
    const relative = relativeBelow(skillRoot, relativePath);
    return relative ? skillAuthorOnlyPath(relative) : false;
  });
}

function pluginArtifactRole(relativePath, skillRoots) {
  if (isPluginEvidenceArtifact(relativePath, skillRoots)) return 'evidence';
  if (
    relativePath === '.agents-plugin/plugin.json'
    || relativePath === '.mcp.json'
    || relativePath.endsWith('.app.json')
    || relativePath.startsWith('config/')
    || relativePath.startsWith('renderers/')
  ) return 'project-profile';
  return 'source';
}

function repositoryArtifactPath(repositoryRoot, absolutePath) {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join('/');
}

function compareProductionArtifacts(declared, expected, errors) {
  const declaredByPath = new Map(declared.map((artifact) => [artifact.path, artifact]));
  for (const [expectedPath, expectedFile] of expected) {
    const artifact = declaredByPath.get(expectedPath);
    if (!artifact) {
      errors.push(`production file ${expectedPath} is omitted from artifacts`);
      continue;
    }
    if (artifact.role !== expectedFile.role) {
      errors.push(`production artifact ${expectedPath} must use role ${expectedFile.role}`);
    }
  }
  for (const artifact of declared) {
    if (!expected.has(artifact.path)) {
      errors.push(`production artifact ${artifact.path} is outside the complete subject files`);
    }
  }
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

function canonicalProductionDigest(files, owner = null) {
  const hash = createHash('sha256');
  updateLengthPrefixed(hash, PRODUCTION_DIGEST_DOMAIN);
  const records = files.map((file) => ({
    path: owner === null ? file.relativePath : `${owner}/${file.relativePath}`,
    mode: file.mode,
    content: file.content,
  }));
  for (const record of records.sort((left, right) =>
    comparePosixPaths(left.path, right.path))) {
    updateLengthPrefixed(hash, record.path);
    updateLengthPrefixed(hash, record.mode);
    updateLengthPrefixed(hash, createHash('sha256').update(record.content).digest());
  }
  return `sha256:${hash.digest('hex')}`;
}

async function validateCurrentness(bundle, roots, expected, errors) {
  const artifactsByPath = new Map(bundle.artifacts.map((artifact) => [artifact.path, artifact]));
  const dirtyReasons = [];
  let currentnessUnknown = false;

  for (const artifact of bundle.artifacts) {
    if (artifact.currentness === 'dirty' && artifact.currentnessReason === undefined) {
      errors.push(`${artifact.path} dirty currentness requires currentnessReason`);
    }
    if (artifact.currentness !== 'dirty' && artifact.currentnessReason !== undefined) {
      errors.push(`${artifact.path} currentnessReason requires dirty currentness`);
    }
  }

  for (const root of roots) {
    const git = await gitCurrentness(root.absolutePath);
    if (git.dirtyPaths === null) currentnessUnknown = true;
    if (git.dirtyPaths !== null) {
      for (const [dirtyPath, status] of git.dirtyPaths) {
        const relativePath = path.relative(git.sourceRoot, dirtyPath).split(path.sep).join('/');
        if (
          relativePath === '..'
          || relativePath.startsWith('../')
          || isIgnoredProductionPath(relativePath)
          || root.isEvidence(relativePath)
        ) continue;
        dirtyReasons.push(
          `${dirtyStatusReason(status, 'production source')}: ${path.resolve(root.reasonPath, relativePath)}`,
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
          || root.isEvidence(relativePath)
        ) continue;
        dirtyReasons.push(
          `ignored production source file: ${path.resolve(root.reasonPath, relativePath)}`,
        );
      }
    }

    for (const [artifactPath, expectedFile] of expected) {
      if (expectedFile.root !== root) continue;
      const artifact = artifactsByPath.get(artifactPath);
      if (!artifact) continue;
      const canonicalPath = await realpath(expectedFile.absolutePath);
      const dirtyStatus = git.dirtyPaths?.get(canonicalPath);
      const ignored = git.ignoredPaths?.has(canonicalPath);
      const trackedMode = git.trackedModes?.get(canonicalPath);
      const modeMismatchReason =
        trackedMode !== undefined
        && ['100644', '100755'].includes(trackedMode)
        && trackedMode !== expectedFile.mode
          ? `working mode ${expectedFile.mode} differs from Git index mode ${trackedMode}`
          : null;
      if (modeMismatchReason) {
        dirtyReasons.push(
          `${modeMismatchReason}: ${path.resolve(root.reasonPath, expectedFile.relativePath)}`,
        );
      }
      const expectedCurrentness =
        git.dirtyPaths === null
          ? 'unknown'
          : dirtyStatus || ignored || modeMismatchReason
            ? 'dirty'
            : 'current';
      const expectedReason = expectedCurrentness === 'dirty'
        ? modeMismatchReason
          ?? (ignored
            ? `ignored ${expectedFile.role} file`
            : dirtyStatusReason(dirtyStatus, expectedFile.role))
        : null;
      if (artifact.currentness !== expectedCurrentness) {
        errors.push(`${artifactPath} currentness must be ${expectedCurrentness}`);
      }
      if (expectedReason === null && artifact.currentnessReason !== undefined) {
        errors.push(`${artifactPath} currentnessReason requires dirty currentness`);
      } else if (expectedReason !== null && artifact.currentnessReason !== expectedReason) {
        errors.push(`${artifactPath} currentnessReason does not match Git state`);
      }
    }
  }

  const normalizedDirtyReasons = [...new Set(dirtyReasons)].sort();
  const expectedTargetCurrentness =
    normalizedDirtyReasons.length > 0 ? 'dirty' : currentnessUnknown ? 'unknown' : 'current';
  if (bundle.target.currentness !== expectedTargetCurrentness) {
    errors.push(`target.currentness must be ${expectedTargetCurrentness}`);
  }
  const declaredDirtyReasons = bundle.target.dirtyReasons ?? [];
  if (!isDeepStrictEqual(declaredDirtyReasons, normalizedDirtyReasons)) {
    errors.push('target.dirtyReasons does not match aggregate production Git state');
  } else if (normalizedDirtyReasons.length === 0 && bundle.target.dirtyReasons !== undefined) {
    errors.push('target.dirtyReasons requires dirty currentness');
  }
}

async function validateArtifacts(bundle, errors) {
  let repositoryRoot;
  try {
    if (!path.isAbsolute(bundle.environment.repositoryRoot)) throw new Error('relative root');
    const rootEntry = await lstat(bundle.environment.repositoryRoot);
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) throw new Error('invalid root');
    repositoryRoot = await realpath(bundle.environment.repositoryRoot);
  } catch {
    errors.push('environment.repositoryRoot must resolve to a regular non-symlink directory');
    return;
  }

  const seen = new Map();
  const validated = [];
  for (let index = 0; index < bundle.artifacts.length; index += 1) {
    const artifact = bundle.artifacts[index];
    const label = `artifacts[${index}]`;
    if (!isCanonicalArtifactPath(artifact.path)) {
      errors.push(`${label}.path must be a canonical relative POSIX path`);
      continue;
    }
    const prior = seen.get(artifact.path);
    if (prior) {
      errors.push(
        isDeepStrictEqual(prior, artifact)
          ? `${label}.path duplicates another artifact declaration`
          : `${label}.path conflicts with another artifact declaration`,
      );
      continue;
    }
    seen.set(artifact.path, artifact);

    let file;
    try {
      file = await readStrictArtifact(repositoryRoot, artifact.path);
    } catch {
      errors.push(`${label}.path does not resolve to a regular non-symlink file`);
      continue;
    }
    const actualDigest = `sha256:${createHash('sha256').update(file.content).digest('hex')}`;
    if (actualDigest !== artifact.digest) errors.push(`${label}.digest does not match file content`);
    if (file.mode !== artifact.mode) errors.push(`${label}.mode does not match the regular file mode`);
    validated.push({ ...artifact, ...file });
  }

  const roles = productionRoles(bundle.target.kind);
  const production = validated.filter((artifact) => roles.has(artifact.role));
  if (production.length === 0) {
    errors.push(`${bundle.target.kind} target requires at least one production artifact`);
    return;
  }

  let calculatedDigest = null;
  const expected = new Map();
  const roots = [];
  if (bundle.target.kind === 'aw-plugin') {
    const byOwner = new Map();
    for (const artifact of production) {
      const ownerFiles = byOwner.get(artifact.owner) ?? [];
      ownerFiles.push(artifact);
      byOwner.set(artifact.owner, ownerFiles);
    }
    if (!byOwner.has(bundle.target.name)) {
      errors.push('aw-plugin production artifacts must include the target owner');
      return;
    }
    const completeFiles = [];
    for (const owner of [...byOwner.keys()].sort((left, right) => left.localeCompare(right))) {
      const ownerFiles = byOwner.get(owner);
      const manifests = ownerFiles.filter((artifact) =>
        artifact.path.endsWith('/.agents-plugin/plugin.json')
        || artifact.path === '.agents-plugin/plugin.json');
      if (manifests.length !== 1) {
        errors.push(`aw-plugin production owner ${owner} requires one .agents-plugin/plugin.json`);
        continue;
      }
      const ownerRoot = path.posix.dirname(path.posix.dirname(manifests[0].path));
      let manifest;
      try {
        manifest = JSON.parse(manifests[0].content.toString('utf8'));
      } catch {
        errors.push(`aw-plugin production owner ${owner} manifest must be valid JSON`);
        continue;
      }
      if (manifest.name !== owner) {
        errors.push(`aw-plugin production owner ${owner} does not match its manifest name`);
      }
      const ownerRootPath = path.join(repositoryRoot, ...ownerRoot.split('/'));
      let allFiles;
      let skillRoots;
      try {
        allFiles = await collectRegularFiles(ownerRootPath);
        skillRoots = findSkillRoots(allFiles, manifest.skills);
      } catch {
        errors.push(`aw-plugin production owner ${owner} root must be a regular symlink-free tree`);
        continue;
      }
      const relativeFiles = allFiles.filter(
        (file) => !isPluginEvidenceArtifact(file.relativePath, skillRoots),
      );
      const root = {
        absolutePath: ownerRootPath,
        reasonPath: path.join(bundle.environment.repositoryRoot, ...ownerRoot.split('/')),
        isEvidence: (relativePath) => isPluginEvidenceArtifact(relativePath, skillRoots),
      };
      roots.push(root);
      for (const file of relativeFiles) {
        const artifactPath = repositoryArtifactPath(repositoryRoot, file.absolutePath);
        expected.set(artifactPath, {
          ...file,
          role: pluginArtifactRole(file.relativePath, skillRoots),
          root,
        });
      }
      completeFiles.push(...relativeFiles.map((file) => ({ ...file, owner })));
    }
    calculatedDigest = canonicalProductionDigest(
      completeFiles.map((file) => ({
        ...file,
        relativePath: `${file.owner}/${file.relativePath}`,
      })),
    );
  } else {
    const skillFiles = production.filter((artifact) => path.posix.basename(artifact.path) === 'SKILL.md');
    if (skillFiles.length !== 1) {
      errors.push(`${bundle.target.kind} production artifacts require exactly one SKILL.md`);
      return;
    }
    const skillRoot = path.posix.dirname(skillFiles[0].path);
    const skillRootPath = path.join(repositoryRoot, ...skillRoot.split('/'));
    let allFiles;
    try {
      allFiles = await collectRegularFiles(skillRootPath);
    } catch {
      errors.push(`${bundle.target.kind} Skill root must be a regular symlink-free tree`);
      return;
    }
    const role = bundle.target.kind === 'materialized-skill' ? 'final' : 'source';
    const relativeFiles = allFiles.filter((file) => !skillAuthorOnlyPath(file.relativePath));
    const root = {
      absolutePath: skillRootPath,
      reasonPath: path.join(bundle.environment.repositoryRoot, ...skillRoot.split('/')),
      isEvidence: skillAuthorOnlyPath,
    };
    roots.push(root);
    for (const file of relativeFiles) {
      expected.set(repositoryArtifactPath(repositoryRoot, file.absolutePath), {
        ...file,
        role,
        root,
      });
    }
    calculatedDigest = canonicalProductionDigest(relativeFiles);
  }
  compareProductionArtifacts(production, expected, errors);
  if (calculatedDigest !== bundle.target.sourceDigest) {
    errors.push('target.sourceDigest does not match the complete production file set');
  }
  await validateCurrentness(bundle, roots, expected, errors);
}

async function firstReadable(candidates) {
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // Try the next canonical or distributed copy.
    }
  }
  throw new Error('Cannot locate required schema.');
}

async function schemaErrors(schemaPath, valuePath) {
  const validator = path.join(scriptRoot, 'validate-json-contract.mjs');
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [validator, schemaPath, valuePath, '--format', 'json'],
      { encoding: 'utf8' },
    );
    return JSON.parse(stdout).errors;
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim())
      return JSON.parse(error.stdout).errors;
    throw error;
  }
}

const schemaByName = {
  SkillInspectionResult: 'skill-inspection-result.schema.json',
  EvalAuditResult: 'eval-audit-result.schema.json',
  ReferenceAuditResult: 'reference-audit-result.schema.json',
  ReviewResult: 'review-result.schema.json',
  EvalRunBundle: 'eval-run-bundle.schema.json',
};

const stageCatalog = {
  'package-inspection': {
    producer: 'inspect-agent-skill',
    schema: 'SkillInspectionResult',
    profile: 'target',
  },
  'eval-audit': {
    producer: 'audit-agent-skill-evals',
    schema: 'EvalAuditResult',
    profile: 'null',
    mode: 'preflight',
  },
  'reference-audit': {
    producer: 'review-agent-content',
    schema: 'ReferenceAuditResult',
    profile: 'null',
  },
  'source-skill-review': {
    producer: 'review-agent-skill',
    schema: 'ReviewResult',
    profile: 'null',
    targetKind: 'source',
  },
  'materialized-profile-review': {
    producer: 'review-agent-skill',
    schema: 'ReviewResult',
    profile: 'required',
    targetKind: 'materialized-skill',
  },
  'eval-execution': {
    producer: null,
    schema: 'EvalRunBundle',
    profile: 'null',
  },
  'eval-result-triage': {
    producer: 'audit-agent-skill-evals',
    schema: 'EvalAuditResult',
    profile: 'null',
    mode: 'result-triage',
  },
};

function resultSubject(result) {
  return result.targetSkillDigest ?? result.target?.digest ?? result.targetDigest ?? null;
}

function stageSlotKey(id, profile, subjectDigest) {
  return JSON.stringify([id, profile ?? null, subjectDigest]);
}

async function validateObject(schemaName, value, label, temporaryRoot, evidenceRoot = null) {
  const valuePath = path.join(temporaryRoot, `${label.replace(/[^A-Za-z0-9._-]/gu, '-')}.json`);
  await writeFile(valuePath, JSON.stringify(value), 'utf8');
  if (schemaName === 'eval-run-bundle.schema.json')
    return (
      await validateEvalRunBundle(valuePath, { evidenceRoot: evidenceRoot ?? temporaryRoot })
    ).errors.map((entry) => `${label}: ${entry}`);
  const schemaPath = await firstReadable([
    path.join(scriptRoot, '..', 'schemas', schemaName),
    path.join(scriptRoot, '..', 'assets', schemaName),
  ]);
  return (await schemaErrors(schemaPath, valuePath)).map((entry) => `${label}: ${entry}`);
}

async function canonicalPackageInspection(bundle, temporaryRoot) {
  if (bundle.target.kind === 'aw-plugin') return null;
  const production = productionRoles(bundle.target.kind);
  const skillFiles = bundle.artifacts.filter((artifact) =>
    production.has(artifact.role) && path.posix.basename(artifact.path) === 'SKILL.md');
  if (skillFiles.length !== 1) return null;
  const repositoryRoot = await realpath(bundle.environment.repositoryRoot);
  const skillRoot = path.join(
    repositoryRoot,
    ...path.posix.dirname(skillFiles[0].path).split('/'),
  );
  const outputPath = path.join(temporaryRoot, 'canonical-package-inspection.json');
  const args = [
    path.join(scriptRoot, 'inspect-agent-skill.mjs'),
    skillRoot,
    '--root-kind',
    bundle.target.kind === 'materialized-skill' ? 'materialized' : 'source',
    '--format',
    'json',
    '--output',
    outputPath,
  ];
  if (bundle.target.profile !== null && bundle.target.profile !== undefined) {
    args.push('--profile', bundle.target.profile);
  }
  try {
    await execFileAsync(process.execPath, args, { encoding: 'utf8' });
  } catch {
    // Inspector errors are expected to use a non-zero exit after writing the result.
  }
  return JSON.parse(await readFile(outputPath, 'utf8'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const bundleSchema = await firstReadable([
    path.join(scriptRoot, '..', 'schemas', 'review-input-bundle.schema.json'),
    path.join(scriptRoot, '..', 'assets', 'review-input-bundle.schema.json'),
  ]);
  const errors = await schemaErrors(bundleSchema, options.bundlePath);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'review-bundle-validator-'));

  try {
    if (errors.length === 0) {
      const bundle = JSON.parse(await readFile(options.bundlePath, 'utf8'));
      const handoffRoot = await realpath(options.handoffRoot ?? path.dirname(options.bundlePath));
      const inlineEvidenceRoot = await realpath(path.dirname(options.bundlePath));
      const seen = new Map();
      const stageResults = new Map();

      await validateArtifacts(bundle, errors);

      for (const stage of bundle.orchestration.providedStages) {
        const stageContract = stageCatalog[stage.id];
        if (stageContract.producer !== null && stage.producer !== stageContract.producer) {
          errors.push(`${stage.id} producer must be ${stageContract.producer}`);
        }
        if (stage.schema !== stageContract.schema) {
          errors.push(`${stage.id} schema must be ${stageContract.schema}`);
        }
        if (stageContract.profile === 'null' && stage.profile !== null) {
          errors.push(`${stage.id} profile must be null`);
        }
        if (
          stageContract.profile === 'required'
          && (typeof stage.profile !== 'string' || stage.profile.length === 0)
        ) {
          errors.push(`${stage.id} profile must be a non-empty string`);
        }
        if (
          stageContract.profile === 'target'
          && stage.profile !== (bundle.target.profile ?? null)
        ) {
          errors.push(`${stage.id} profile must match the bundle target`);
        }
        const key = stageSlotKey(stage.id, stage.profile, stage.subjectDigest);
        const previous = seen.get(key);
        if (previous) {
          if (
            previous.resultDigest !== stage.resultDigest ||
            previous.resultPath !== stage.resultPath
          )
            errors.push(`conflicting results for provided stage slot ${key}`);
          else errors.push(`duplicate provided stage slot ${key}`);
          continue;
        }
        seen.set(key, stage);

        const candidate = path.resolve(path.dirname(options.bundlePath), stage.resultPath);
        let actual;
        try {
          if ((await lstat(candidate)).isSymbolicLink()) throw new Error('symlink');
          actual = await realpath(candidate);
          if (!(await stat(actual)).isFile()) throw new Error('not a file');
        } catch {
          errors.push(`${stage.id} resultPath does not resolve to a regular file`);
          continue;
        }
        if (!isPathInside(handoffRoot, actual)) {
          errors.push(`${stage.id} resultPath leaves the handoff root`);
          continue;
        }
        if ((await digest(actual)) !== stage.resultDigest) {
          errors.push(`${stage.id} resultDigest does not match file content`);
        }

        const schemaName = schemaByName[stageContract.schema];
        if (schemaName === 'eval-run-bundle.schema.json')
          errors.push(
            ...(await validateEvalRunBundle(actual, { evidenceRoot: path.dirname(actual) })).errors.map(
              (entry) => `${stage.id}: ${entry}`,
            ),
          );
        else {
          const schemaPath = await firstReadable([
            path.join(scriptRoot, '..', 'schemas', schemaName),
            path.join(scriptRoot, '..', 'assets', schemaName),
          ]);
          errors.push(
            ...(await schemaErrors(schemaPath, actual)).map((entry) => `${stage.id}: ${entry}`),
          );
        }

        let result;
        try {
          result = JSON.parse(await readFile(actual, 'utf8'));
        } catch {
          continue;
        }
        stageResults.set(key, { stage, result, actual });

        if (
          !['eval-execution', 'package-inspection'].includes(stage.id)
          && stage.independentContext !== true
        ) {
          errors.push(
            `${stage.id} provided review/audit stage must come from an independent context`,
          );
        }
        if (stage.id === 'eval-execution') {
          if (result.runner?.id !== stage.producer)
            errors.push('eval-execution producer does not match result runner id');
        } else if (result.producer !== stage.producer) {
          errors.push(`${stage.id} producer does not match result`);
        }
        if (result.independentContext !== stage.independentContext) {
          errors.push(`${stage.id} independentContext does not match result`);
        }
        const subject = resultSubject(result);
        if (!subject) errors.push(`${stage.id} result does not expose a subject digest`);
        else if (subject !== stage.subjectDigest)
          errors.push(`${stage.id} subjectDigest does not match result target`);

        if (
          bundle.target.kind !== 'aw-plugin' &&
          stage.subjectDigest !== bundle.target.sourceDigest
        ) {
          errors.push(`${stage.id} subjectDigest does not match bundle target`);
        }
        const resultProfile = result.target?.profile ?? null;
        if (resultProfile !== stage.profile) {
          errors.push(`${stage.id} profile does not match result target`);
        }
        if (stageContract.mode && result.mode !== stageContract.mode) {
          errors.push(`${stage.id} result mode must be ${stageContract.mode}`);
        }
        if (stage.id === 'package-inspection') {
          const expectedRootKind = bundle.target.kind === 'materialized-skill'
            ? 'materialized'
            : 'source';
          if (result.target?.rootKind !== expectedRootKind) {
            errors.push(`package-inspection rootKind must be ${expectedRootKind}`);
          }
          if (result.target?.name !== bundle.target.name) {
            errors.push('package-inspection target name does not match bundle target');
          }
          let canonical = null;
          try {
            canonical = await canonicalPackageInspection(bundle, temporaryRoot);
          } catch {
            errors.push('package-inspection canonical Inspector rerun failed');
          }
          if (canonical === null) {
            errors.push('package-inspection requires one canonical Skill root');
          } else if (!isDeepStrictEqual(
            {
              target: result.target,
              runtimeClosure: result.runtimeClosure,
              issues: result.issues,
            },
            {
              target: canonical.target,
              runtimeClosure: canonical.runtimeClosure,
              issues: canonical.issues,
            },
          )) {
            errors.push('package-inspection machine evidence does not match the canonical Inspector rerun');
          }
        }
        if (
          stageContract.targetKind === 'materialized-skill'
          && result.target?.kind !== 'materialized-skill'
        ) {
          errors.push(`${stage.id} result target must be materialized-skill`);
        }
        if (
          stageContract.targetKind === 'source'
          && result.target?.kind === 'materialized-skill'
        ) {
          errors.push(`${stage.id} result target must be a source Skill`);
        }
        if (stage.id === 'source-skill-review') {
          if (bundle.target.kind === 'aw-plugin') {
            if (result.target?.kind !== 'aw-plugin-skill') {
              errors.push('source-skill-review plugin target must be aw-plugin-skill');
            }
          } else if (
            result.target?.kind !== bundle.target.kind
            || result.target?.name !== bundle.target.name
            || (result.target?.profile ?? null) !== (bundle.target.profile ?? null)
            || result.target?.digest !== bundle.target.sourceDigest
          ) {
            errors.push('source-skill-review result target must exactly match bundle target');
          }
        }
        if (
          bundle.target.kind !== 'aw-plugin'
          && stage.id === 'materialized-profile-review'
          && stage.profile !== bundle.target.profile
        ) {
          errors.push(`${stage.id} profile does not match bundle target`);
        }
      }

      const executionStages = [...stageResults.values()].filter(
        (entry) => entry.stage.id === 'eval-execution',
      );
      const auditStages = [...stageResults.values()].filter(
        (entry) => entry.stage.id === 'eval-audit',
      );
      const usedTriageExecutionDigests = new Set();
      for (const triage of [...stageResults.values()].filter(
        (entry) => entry.stage.id === 'eval-result-triage',
      )) {
        const matches = executionStages.filter((execution) =>
          isDeepStrictEqual(triage.stage.evalExecution, {
            targetSkillDigest: execution.result.targetSkillDigest,
            caseCorpusDigest: execution.result.caseCorpusDigest,
            planDigest: execution.result.planDigest,
            resultDigest: execution.stage.resultDigest,
          }));
        if (matches.length !== 1) {
          errors.push('eval-result-triage requires one exactly matching eval-execution stage');
          continue;
        }
        const execution = matches[0];
        if (usedTriageExecutionDigests.has(execution.stage.resultDigest)) {
          errors.push('eval-result-triage reuses an eval-execution stage');
        }
        usedTriageExecutionDigests.add(execution.stage.resultDigest);
        if (
          triage.result.targetSkillDigest !== execution.result.targetSkillDigest
          || triage.result.caseCorpusDigest !== execution.result.caseCorpusDigest
        ) {
          errors.push('eval-result-triage result does not match eval-execution target and corpus');
        }
        const matchingAudits = auditStages.filter((audit) =>
          audit.result.targetSkillDigest === execution.result.targetSkillDigest
          && audit.result.caseCorpusDigest === execution.result.caseCorpusDigest);
        if (matchingAudits.length !== 1) {
          errors.push('eval-result-triage eval-execution requires one matching eval-audit stage');
        }
      }

      if (bundle.evalAudit !== null) {
        const semanticAuditStages = bundle.orchestration.providedStages.filter(
          (stage) => stage.id === 'eval-audit',
        );
        if (semanticAuditStages.length !== 1) {
          errors.push('evalAudit requires exactly one semantic eval-audit stage');
        }
        const auditStage = semanticAuditStages.length === 1
          ? stageResults.get(
            stageSlotKey(
              'eval-audit',
              semanticAuditStages[0].profile,
              semanticAuditStages[0].subjectDigest,
            ),
          )
          : null;
        errors.push(
          ...(await validateObject(
            'eval-audit-result.schema.json',
            bundle.evalAudit,
            'evalAudit',
            temporaryRoot,
            auditStage ? path.dirname(auditStage.actual) : inlineEvidenceRoot,
          )),
        );
        if (semanticAuditStages.length === 1) {
          const stage = semanticAuditStages[0];
          if (stage.producer !== bundle.evalAudit.producer) {
            errors.push('eval-audit stage producer does not match evalAudit');
          }
          if (stage.independentContext !== bundle.evalAudit.independentContext) {
            errors.push('eval-audit stage independentContext does not match evalAudit');
          }
          if (stage.subjectDigest !== bundle.evalAudit.targetSkillDigest) {
            errors.push('eval-audit stage subjectDigest does not match evalAudit');
          }
          if (stage.schema !== 'EvalAuditResult') {
            errors.push('eval-audit stage schema must be EvalAuditResult');
          }
          if (stage.profile !== null) errors.push('eval-audit stage profile must be null');
          if (auditStage && !isDeepStrictEqual(bundle.evalAudit, auditStage.result)) {
            errors.push('evalAudit does not equal the eval-audit stage result');
          }
        }
        if (
          bundle.target.kind !== 'aw-plugin' &&
          bundle.evalAudit.targetSkillDigest !== bundle.target.sourceDigest
        ) {
          errors.push('evalAudit targetSkillDigest does not match bundle target');
        }
      }

      const boundExecutionStages = new Set();
      for (let index = 0; index < bundle.evalResults.length; index += 1) {
        const result = bundle.evalResults[index];
        const executionStage = stageResults.get(
          stageSlotKey('eval-execution', null, result.targetSkillDigest),
        );
        errors.push(
          ...(await validateObject(
            'eval-run-bundle.schema.json',
            result,
            `evalResults-${index}`,
            temporaryRoot,
            executionStage ? path.dirname(executionStage.actual) : inlineEvidenceRoot,
          )),
        );
        if (
          bundle.target.kind !== 'aw-plugin' &&
          result.targetSkillDigest !== bundle.target.sourceDigest
        ) {
          errors.push(`evalResults[${index}] targetSkillDigest does not match bundle target`);
        }
        if (bundle.evalAudit && result.caseCorpusDigest !== bundle.evalAudit.caseCorpusDigest) {
          errors.push(`evalResults[${index}] caseCorpusDigest does not match evalAudit`);
        }
        if (bundle.evalAudit && result.targetSkillDigest !== bundle.evalAudit.targetSkillDigest) {
          errors.push(`evalResults[${index}] targetSkillDigest does not match evalAudit`);
        }
        if (!executionStage) {
          errors.push(`evalResults[${index}] requires one matching eval-execution stage`);
        } else if (boundExecutionStages.has(executionStage.stage.resultDigest)) {
          errors.push(`evalResults[${index}] reuses an eval-execution stage`);
        } else if (!isDeepStrictEqual(result, executionStage.result)) {
          errors.push(`evalResults[${index}] does not equal eval-execution stage result`);
        }
        if (executionStage) boundExecutionStages.add(executionStage.stage.resultDigest);
      }
    }

    const output = { valid: errors.length === 0, errors };
    process.stdout.write(
      options.format === 'json'
        ? `${JSON.stringify(output, null, 2)}\n`
        : output.valid
          ? 'ReviewInputBundle is valid.\n'
          : `${errors.join('\n')}\n`,
    );
    if (!output.valid) process.exitCode = 1;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`[ERROR] ${error.message}\n`);
  process.exit(1);
});
