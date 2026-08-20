#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isSkillAuthorArtifact } from './review-artifact-policy.mjs';
function fail(m) {
  throw new Error(m);
}
function sha(d) {
  return 'sha256:' + createHash('sha256').update(d).digest('hex');
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
      if (['.git', 'node_modules'].includes(e.name)) continue;
      const abs = path.join(d, e.name),
        rel = path.join(p, e.name);
      if (e.isDirectory()) await visit(abs, rel);
      else if (e.isFile()) out.push({ abs, rel: rel.split(path.sep).join('/') });
    }
  }
  await visit(root);
  return out;
}
async function digest(root, opts) {
  const h = createHash('sha256');
  for (const f of await walk(root)) {
    if (opts?.excludeAuthor && isSkillAuthorArtifact(f.rel, ['.'])) continue;
    h.update(f.rel);
    h.update('\0');
    h.update(await readFile(f.abs));
    h.update('\0');
  }
  return 'sha256:' + h.digest('hex');
}
function skillName(text, dir) {
  const m = text.match(/^---\s*\n[\s\S]*?^name:\s*([^\n]+)$/mu);
  return m?.[1]?.trim().replace(/^['"]|['"]$/gu, '') || path.basename(dir);
}
async function skillRoots(root) {
  const roots = [];
  async function visit(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'evals', 'reports'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        try {
          if ((await stat(path.join(p, 'SKILL.md'))).isFile()) {
            roots.push(p);
            continue;
          }
        } catch {}
        await visit(p);
      }
    }
  }
  try {
    if ((await stat(path.join(root, 'SKILL.md'))).isFile()) return [root];
  } catch {}
  await visit(root);
  return roots.sort();
}
function normalizedArtifactPath(filePath) {
  return path.normalize(path.resolve(filePath));
}
function inheritedCurrentness(file, digest, pluginBundle) {
  const match = pluginBundle?.artifacts?.find(
    (artifact) =>
      normalizedArtifactPath(artifact.path) === normalizedArtifactPath(file) &&
      artifact.digest === digest,
  );
  return match?.currentness ?? 'unknown';
}
async function artifactRows(root, role, profile, owner, pluginBundle) {
  return Promise.all(
    (await walk(root)).map(async (f) => {
      const fileDigest = sha(await readFile(f.abs));
      return {
        role: role === 'source' && isSkillAuthorArtifact(f.rel, ['.']) ? 'evidence' : role,
        path: f.abs,
        profile,
        digest: fileDigest,
        owner,
        currentness: inheritedCurrentness(f.abs, fileDigest, pluginBundle),
      };
    }),
  );
}
async function target(kind, root, profile, owner, repo, pluginBundle) {
  const text = await readFile(path.join(root, 'SKILL.md'), 'utf8'),
    name = skillName(text, root),
    sourceDigest = await digest(root, { excludeAuthor: kind === 'aw-plugin-skill' });
  const evalAudit =
      pluginBundle?.evalAudit?.targetSkillDigest === sourceDigest ? pluginBundle.evalAudit : null,
    evalResults = (pluginBundle?.evalResults ?? []).filter(
      (r) => r.targetSkillDigest === sourceDigest,
    ),
    providedStages = (pluginBundle?.orchestration?.providedStages ?? []).filter(
      (stage) => stage.subjectDigest === sourceDigest,
    );
  return {
    schemaVersion: 4,
    target: { kind, name, profile, sourceDigest },
    artifacts: await artifactRows(
      root,
      kind === 'aw-plugin-skill' ? 'source' : 'final',
      profile,
      owner,
      pluginBundle,
    ),
    environment: pluginBundle?.environment ?? {
      repository: path.basename(repo) || 'aw-workspace',
      repositoryRoot: repo,
      client: null,
      dependencyMode: 'manual',
      capabilities: [],
    },
    orchestration: { stageOwner: 'caller', providedStages },
    evalAudit,
    evalResults,
  };
}
async function main() {
  const o = parse(process.argv.slice(2)),
    pluginBundle = o.bundlePath ? JSON.parse(await readFile(o.bundlePath, 'utf8')) : null,
    manifest = JSON.parse(
      await readFile(path.join(o.pluginRoot, '.agents-plugin', 'plugin.json'), 'utf8'),
    );
  const skillsPath =
    typeof manifest.skills === 'string'
      ? path.resolve(o.pluginRoot, manifest.skills)
      : path.join(o.pluginRoot, 'skills');
  const rows = [];
  for (const r of await skillRoots(skillsPath))
    rows.push(await target('aw-plugin-skill', r, null, manifest.name, o.repoRoot, pluginBundle));
  for (const f of o.finals)
    for (const r of await skillRoots(f.root))
      rows.push(
        await target('materialized-skill', r, f.profile, manifest.name, o.repoRoot, pluginBundle),
      );
  const seen = new Set(),
    targets = [];
  if (o.outputRoot) await mkdir(o.outputRoot, { recursive: true });
  for (const bundle of rows) {
    const key = [bundle.target.kind, bundle.target.name, bundle.target.profile ?? ''].join(':');
    if (seen.has(key)) fail('Duplicate review target ' + key);
    seen.add(key);
    let bundlePath = null;
    if (o.outputRoot) {
      const file =
        [bundle.target.kind, bundle.target.name, bundle.target.profile].filter(Boolean).join('--') +
        '.json';
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
        repository: path.basename(o.repoRoot) || 'aw-workspace',
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
