#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isSkillAuthorArtifact } from './review-artifact-policy.mjs';
const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const PRODUCTION_DIGEST_DOMAIN = 'aw-production-records-v1';
const IGNORED_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);
function fail(m) {
  throw new Error(m);
}
function sha(d) {
  return 'sha256:' + createHash('sha256').update(d).digest('hex');
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
  return 'sha256:' + hash.digest('hex');
}
function val(a, i, f) {
  const v = a[i + 1];
  if (!v || v.startsWith('--')) fail(f + ' requires a value.');
  return v;
}
function named(v) {
  const i = v.indexOf('=');
  if (i < 1 || i === v.length - 1) fail('--final requires profile=path.');
  return { profile: v.slice(0, i), root: path.resolve(v.slice(i + 1)) };
}
function parse(a) {
  if (a.includes('--help') || a.includes('-h')) {
    process.stdout.write(
      'Usage: prepare-aw-review-targets.mjs <plugin-root> [--repo-root path] [--final profile=path] [--bundle plugin-bundle.json] [--output-root path]\n',
    );
    process.exit(0);
  }
  if (!a[0] || a[0].startsWith('--')) fail('Provide <plugin-root>.');
  const o = {
    pluginRoot: path.resolve(a[0]),
    repoRoot: process.cwd(),
    finals: [],
    bundlePath: null,
    outputRoot: null,
  };
  for (let i = 1; i < a.length; i += 1) {
    if (a[i] === '--repo-root') {
      o.repoRoot = path.resolve(val(a, i, a[i]));
      i += 1;
    } else if (a[i] === '--final') {
      o.finals.push(named(val(a, i, a[i])));
      i += 1;
    } else if (a[i] === '--bundle') {
      o.bundlePath = path.resolve(val(a, i, a[i]));
      i += 1;
    } else if (a[i] === '--output-root') {
      o.outputRoot = path.resolve(val(a, i, a[i]));
      i += 1;
    } else fail('Unknown option: ' + a[i]);
  }
  return o;
}
async function walk(root) {
  const out = [];
  async function visit(d, p = '') {
    const entries = await readdir(d, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const e of entries) {
      if (IGNORED_NAMES.has(e.name)) continue;
      const abs = path.join(d, e.name),
        rel = path.join(p, e.name);
      if (e.isSymbolicLink()) fail('Skill target cannot contain symlinks: ' + rel);
      if (e.isDirectory()) await visit(abs, rel);
      else if (e.isFile()) out.push({ abs, rel: rel.split(path.sep).join('/') });
    }
  }
  await visit(root);
  return out;
}
function normalizedRegularFileMode(mode) {
  return process.platform !== 'win32' && (mode & 0o111) !== 0 ? '100755' : '100644';
}
async function digest(root) {
  if ((await lstat(root)).isSymbolicLink()) fail('Skill target cannot be a symlink');
  const canonicalRoot = await realpath(root);
  const records = [];
  for (const f of await walk(canonicalRoot)) {
    if (isSkillAuthorArtifact(f.rel, ['.'])) continue;
    records.push({
      path: f.rel,
      mode: normalizedRegularFileMode((await stat(f.abs)).mode),
      content: await readFile(f.abs),
    });
  }
  return productionDigest(records);
}
function skillName(text, dir) {
  const m = text.match(/^---\s*\n[\s\S]*?^name:\s*([^\n]+)$/mu);
  return m?.[1]?.trim().replace(/^['"]|['"]$/gu, '') || path.basename(dir);
}
async function skillRoots(root) {
  const roots = [];
  async function hasSkillFile(directory) {
    try {
      return (await stat(path.join(directory, 'SKILL.md'))).isFile();
    } catch {
      return false;
    }
  }
  async function visit(d) {
    if (await hasSkillFile(d)) {
      roots.push(d);
      return;
    }
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (IGNORED_NAMES.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) fail('Skill discovery cannot contain symlinks: ' + p);
      if (e.isDirectory()) {
        await visit(p);
      }
    }
  }
  await visit(root);
  return roots.sort();
}
function normalizedArtifactPath(filePath, repositoryRoot) {
  return path.normalize(path.isAbsolute(filePath) ? filePath : path.resolve(repositoryRoot, filePath));
}
function reviewArtifactPath(repositoryRoot, filePath) {
  const relative = path.relative(repositoryRoot, filePath);
  if (
    !relative
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) fail('Artifact must be inside the repository root: ' + filePath);
  return relative.split(path.sep).join('/');
}
function inheritedCurrentness(file, digest, mode, pluginBundle, repositoryRoot) {
  const pluginRepositoryRoot = pluginBundle?.environment?.repositoryRoot ?? repositoryRoot;
  const match = pluginBundle?.artifacts?.find(
    (artifact) =>
      normalizedArtifactPath(artifact.path, pluginRepositoryRoot) ===
        normalizedArtifactPath(file, repositoryRoot) &&
      artifact.digest === digest &&
      artifact.mode === mode,
  );
  return match
    ? {
        currentness: match.currentness,
        ...(match.currentnessReason
          ? { currentnessReason: match.currentnessReason }
          : {}),
      }
    : { currentness: 'unknown' };
}
async function artifactRows(root, role, profile, owner, pluginBundle, repositoryRoot) {
  return Promise.all(
    (await walk(root)).map(async (f) => {
      const fileDigest = sha(await readFile(f.abs)),
        mode = normalizedRegularFileMode((await stat(f.abs)).mode);
      return {
        role: role === 'source' && isSkillAuthorArtifact(f.rel, ['.']) ? 'evidence' : role,
        path: reviewArtifactPath(repositoryRoot, f.abs),
        profile,
        digest: fileDigest,
        mode,
        owner,
        ...inheritedCurrentness(f.abs, fileDigest, mode, pluginBundle, repositoryRoot),
      };
    }),
  );
}
async function target(kind, root, profile, owner, repo, pluginBundle) {
  const text = await readFile(path.join(root, 'SKILL.md'), 'utf8'),
    name = skillName(text, root),
    sourceDigest = await digest(root);
  const evalAudit =
      pluginBundle?.evalAudit?.targetSkillDigest === sourceDigest ? pluginBundle.evalAudit : null,
    evalResults = (pluginBundle?.evalResults ?? []).filter(
      (r) => r.targetSkillDigest === sourceDigest,
    ),
    providedStages = (pluginBundle?.orchestration?.providedStages ?? []).filter(
      (stage) => stage.subjectDigest === sourceDigest,
    ),
    artifacts = await artifactRows(
      root,
      kind === 'aw-plugin-skill' ? 'source' : 'final',
      profile,
      owner,
      pluginBundle,
      repo,
    ),
    deletionPrefix = 'deleted production source file: ',
    sourceDeletionReasons = (pluginBundle?.target?.dirtyReasons ?? []).filter((reason) =>
      reason.startsWith(deletionPrefix),
    ),
    relevantDeletionReasons = kind === 'materialized-skill'
      ? sourceDeletionReasons.map((reason) => `materialized target may contain ${reason}`)
      : sourceDeletionReasons.filter((reason) => {
          const deletedPath = reason.slice(deletionPrefix.length);
          const relative = path.relative(root, deletedPath);
          return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        }),
    dirtyReasons = [
      ...relevantDeletionReasons,
      ...artifacts
        .filter((artifact) => artifact.currentness === 'dirty')
        .map((artifact) => `${artifact.currentnessReason ?? 'dirty source file'}: ${artifact.path}`),
    ],
    targetCurrentness = dirtyReasons.length > 0
      ? 'dirty'
      : artifacts.some((artifact) => artifact.currentness === 'unknown')
        ? 'unknown'
        : 'current';
  const executionResultDigests = new Set(
    providedStages
      .filter((stage) => stage.id === 'eval-execution')
      .map((stage) => stage.resultDigest),
  );
  const boundProvidedStages = providedStages.filter(
    (stage) =>
      stage.id !== 'eval-result-triage'
      || executionResultDigests.has(stage.evalExecution?.resultDigest),
  );
  return {
    schemaVersion: 5,
    target: {
      kind,
      name,
      profile,
      sourceDigest,
      currentness: targetCurrentness,
      ...(dirtyReasons.length > 0 ? { dirtyReasons: [...new Set(dirtyReasons)].sort() } : {}),
    },
    artifacts,
    environment: pluginBundle?.environment ?? {
      repository: path.basename(repo) || 'aw-workspace',
      repositoryRoot: repo,
      client: null,
      dependencyMode: 'manual',
      capabilities: [],
    },
    orchestration: { stageOwner: 'caller', providedStages: boundProvidedStages },
    evalAudit,
    evalResults,
  };
}
async function attachPackageInspection(bundle, root, outputRoot, fileStem) {
  const inspector = path.join(scriptRoot, 'inspect-agent-skill.mjs');
  const args = [
    inspector,
    root,
    '--root-kind',
    bundle.target.kind === 'materialized-skill' ? 'materialized' : 'source',
    '--format',
    'json',
  ];
  if (bundle.target.profile !== null) args.push('--profile', bundle.target.profile);
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, { encoding: 'utf8' }));
  } catch (error) {
    if (typeof error?.stdout !== 'string' || !error.stdout.trim()) throw error;
    stdout = error.stdout;
  }
  const inspection = JSON.parse(stdout);
  if (inspection.target.digest !== bundle.target.sourceDigest) {
    fail('Package inspection digest does not match review target ' + bundle.target.name);
  }
  const resultName = fileStem + '--package-inspection.json';
  const resultContent = JSON.stringify(inspection, null, 2) + '\n';
  await writeFile(path.join(outputRoot, resultName), resultContent, 'utf8');
  bundle.orchestration.providedStages.push({
    id: 'package-inspection',
    producer: 'inspect-agent-skill',
    independentContext: false,
    subjectDigest: bundle.target.sourceDigest,
    resultPath: resultName,
    resultDigest: sha(resultContent),
    schema: 'SkillInspectionResult',
    profile: bundle.target.profile,
  });
}
async function main() {
  const o = parse(process.argv.slice(2)),
    pluginBundle = o.bundlePath ? JSON.parse(await readFile(o.bundlePath, 'utf8')) : null,
    repositoryRoot = pluginBundle?.environment?.repositoryRoot ?? o.repoRoot,
    manifest = JSON.parse(
      await readFile(path.join(o.pluginRoot, '.agents-plugin', 'plugin.json'), 'utf8'),
    );
  const skillsPath =
    typeof manifest.skills === 'string'
      ? path.resolve(o.pluginRoot, manifest.skills)
      : path.join(o.pluginRoot, 'skills');
  const rows = [];
  for (const r of await skillRoots(skillsPath))
    rows.push({
      root: r,
      bundle: await target(
        'aw-plugin-skill',
        r,
        null,
        manifest.name,
        repositoryRoot,
        pluginBundle,
      ),
    });
  for (const f of o.finals)
    for (const r of await skillRoots(f.root))
      rows.push(
        {
          root: r,
          bundle: await target(
            'materialized-skill',
            r,
            f.profile,
            manifest.name,
            repositoryRoot,
            pluginBundle,
          ),
        },
      );
  const seen = new Set(),
    targets = [];
  if (o.outputRoot) await mkdir(o.outputRoot, { recursive: true });
  for (const row of rows) {
    const bundle = row.bundle;
    const key = [bundle.target.kind, bundle.target.name, bundle.target.profile ?? ''].join(':');
    if (seen.has(key)) fail('Duplicate review target ' + key);
    seen.add(key);
    let bundlePath = null;
    if (o.outputRoot) {
      const fileStem = [bundle.target.kind, bundle.target.name, bundle.target.profile]
        .filter(Boolean)
        .join('--');
      await attachPackageInspection(bundle, row.root, o.outputRoot, fileStem);
      const file = fileStem + '.json';
      bundlePath = path.join(o.outputRoot, file);
      await writeFile(bundlePath, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
    }
    targets.push({
      targetName: bundle.target.name,
      kind: bundle.target.kind,
      profile: bundle.target.profile,
      digest: bundle.target.sourceDigest,
      bundlePath,
      bundle: o.outputRoot ? undefined : bundle,
    });
  }
  process.stdout.write(
    JSON.stringify(
      {
        schemaVersion: 1,
        plugin: manifest.name,
        repository: path.basename(repositoryRoot) || 'aw-workspace',
        reviewTargets: targets,
      },
      null,
      2,
    ) + '\n',
  );
}
main().catch((e) => {
  process.stderr.write('[ERROR] ' + e.message + '\n');
  process.exit(1);
});
