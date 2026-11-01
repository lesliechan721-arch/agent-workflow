#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let root = process.cwd();
while (!fs.existsSync(path.join(root, 'fixture-control.json'))) {
  const parent = path.dirname(root);
  if (parent === root) throw new Error('Fixture control missing.');
  root = parent;
}

const control = JSON.parse(fs.readFileSync(path.join(root, 'fixture-control.json'), 'utf8'));
const args = process.argv.slice(2);
const logRoot = path.join(root, '_simplify-log');
fs.mkdirSync(logRoot, { recursive: true });
fs.appendFileSync(path.join(logRoot, 'commands.jsonl'), `${JSON.stringify({ args, cwd: process.cwd(), testDouble: true })}\n`);

const resolveRoot = (value) => path.resolve(root, value);
const sourceWorkspace = resolveRoot(control.sourceWorkspace);
const sourceSkill = path.join(sourceWorkspace, control.skillRelative);
const sourceManifest = path.join(sourceWorkspace, control.manifestRelative);
const sourceProvider = path.join(sourceWorkspace, control.providerRelative);
const sha256 = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const send = (value, code = 0) => {
  console.log(JSON.stringify(value));
  process.exitCode = code;
};
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
};

function hasExactOptions(start, allowed) {
  const seen = new Set();
  for (let index = start; index < args.length; index += 1) {
    const flag = args[index];
    if (!allowed.has(flag) || seen.has(flag)) return false;
    seen.add(flag);
    if (flag === '--json') continue;
    const value = args[++index];
    if (!value || value.startsWith('--')) return false;
  }
  return true;
}

function snapshotForTarget(target) {
  for (const kind of ['baseline', 'candidate']) {
    const workspace = resolveRoot(control[`${kind}Workspace`]);
    const skill = path.join(workspace, control.skillRelative);
    if (path.resolve(target) === skill) {
      return {
        kind,
        workspace,
        skill,
        manifest: path.join(workspace, control.manifestRelative),
        provider: path.join(workspace, control.providerRelative),
        output: resolveRoot(control[`${kind}Output`]),
      };
    }
  }
  return null;
}

function completeSnapshot(snapshot) {
  const required = [
    path.join(snapshot.workspace, '.aw-workspace.json'),
    path.join(snapshot.workspace, 'plugins', 'marketplace-source.json'),
    snapshot.manifest,
    path.join(snapshot.skill, 'SKILL.md'),
    snapshot.provider,
    ...(control.additionalInputs ?? []).map(relative => path.join(snapshot.workspace, relative)),
  ];
  if (!required.every((file) => fs.existsSync(file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink())) {
    return false;
  }
  const unchanged = [
    '.aw-workspace.json',
    'plugins/marketplace-source.json',
    control.manifestRelative,
    control.providerRelative,
    ...(control.additionalInputs ?? []),
  ];
  if (snapshot.kind === 'baseline') unchanged.push(path.join(control.skillRelative, 'SKILL.md'));
  return unchanged.every((relative) => fs.readFileSync(path.join(snapshot.workspace, relative)).equals(
    fs.readFileSync(path.join(sourceWorkspace, relative)),
  ));
}

if (
  args[0] === 'self'
  && args[1] === 'check'
  && hasExactOptions(2, new Set(['--from', '--json']))
  && option('--from')
  && args.includes('--json')
) {
  send({ ok: true, missingCapabilities: [], fixture: true });
} else if (args[0] === 'review' && args[1] === 'prepare' && args.includes('--help')) {
  send('TEST DOUBLE: aw review prepare <source> --workspace-root <root> --platform codex --scope project --out <dir> --json');
} else if (args[0] === 'review' && args[1] === 'inspect') {
  const target = path.resolve(process.cwd(), args[2] ?? '');
  if (
    !hasExactOptions(3, new Set(['--view', '--json']))
    || option('--view') !== 'review'
    || !args.includes('--json')
    || target !== sourceSkill
    || !fs.existsSync(sourceManifest)
    || !fs.existsSync(sourceProvider)
  ) {
    send({
      schemaVersion: 2,
      command: 'review:inspect',
      ok: false,
      issues: [{
        code: 'fixtureTargetMismatch',
        path: target,
        message: 'TEST DOUBLE: target must be the configured source Skill with its manifest and provider.',
      }],
    }, 2);
  } else {
    send({
      schemaVersion: 2,
      command: 'review:inspect',
      view: 'review',
      ok: true,
      target: { kind: 'skill', path: sourceSkill },
      sources: [sourceManifest, sourceProvider],
      skills: [{
        skill: 'demo-skill',
        sourcePath: sourceSkill,
        profile: { platform: 'codex', scope: 'project', inputDigest: sha256('{}') },
        finalPath: null,
        state: 'missing',
      }],
      issues: [{ code: 'requiredFinalMissing', path: sourceSkill }],
      fixture: true,
    });
  }
} else if (args[0] === 'review' && args[1] === 'prepare') {
  const target = path.resolve(process.cwd(), args[2] ?? '');
  const snapshot = snapshotForTarget(target);
  const workspace = option('--workspace-root');
  const output = option('--out');
  const validOptions = snapshot
    && hasExactOptions(3, new Set(['--workspace-root', '--platform', '--scope', '--out', '--json']))
    && workspace
    && path.resolve(process.cwd(), workspace) === snapshot.workspace
    && output
    && path.resolve(process.cwd(), output) === snapshot.output
    && option('--platform') === 'codex'
    && option('--scope') === 'project'
    && args.includes('--json');
  if (!validOptions || !snapshot || !completeSnapshot(snapshot) || fs.existsSync(snapshot.output)) {
    send({
      schemaVersion: 1,
      command: 'review:prepare',
      ok: false,
      sourceBindingPath: null,
      skills: [],
      issues: [{ code: 'fixturePreparationRejected', message: 'TEST DOUBLE: exact complete isolated snapshot and output are required.' }],
    }, 2);
  } else {
    const final = path.join(snapshot.output, 'skills', 'demo-skill');
    const reference = path.join(final, 'references', 'policy.md');
    fs.mkdirSync(path.dirname(reference), { recursive: true });
    fs.copyFileSync(path.join(snapshot.skill, 'SKILL.md'), path.join(final, 'SKILL.md'));
    fs.copyFileSync(snapshot.provider, reference);
    const binding = path.join(snapshot.output, 'aw-source-binding.json');
    const sourceDigest = sha256(
      fs.readFileSync(path.join(snapshot.skill, 'SKILL.md'))
      + fs.readFileSync(snapshot.provider)
      + fs.readFileSync(snapshot.manifest),
    );
    fs.writeFileSync(binding, `${JSON.stringify({
      testDouble: true,
      snapshot: snapshot.kind,
      sourceDigest,
      profile: { platform: 'codex', scope: 'project', inputDigest: sha256('{}') },
    }, null, 2)}\n`);
    send({
      schemaVersion: 1,
      command: 'review:prepare',
      ok: true,
      sourceBindingPath: binding,
      skills: [{
        skill: 'demo-skill',
        sourcePath: snapshot.skill,
        finalPath: final,
        sourceBindingPath: binding,
        profile: { platform: 'codex', scope: 'project', inputDigest: sha256('{}') },
        state: 'ready',
      }],
      issues: [],
      fixture: true,
    });
  }
} else {
  send({ ok: false, fixture: true, error: 'Unlisted command.' }, 64);
}
