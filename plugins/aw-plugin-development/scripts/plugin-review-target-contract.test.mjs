import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { reviewSkillLeafPlan } from './review-skill-leaf-plan.mjs';

const execFileAsync = promisify(execFile);
const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const runtimeRoot = context?.platform ? path.join(localRoot, context.platform) : localRoot;
const discover = path.join(runtimeRoot, 'skills/review-aw-plugin/scripts/discover-aw-review-targets.mjs');
const releaseCheck = path.join(runtimeRoot, 'skills/review-aw-plugin/scripts/check-aw-plugin-release.mjs');
const skillCheck = path.join(runtimeRoot, 'skills/review-aw-plugin/scripts/check-agent-skill.mjs');
const sourceRoot = context?.sourceRoot ?? localRoot;
const skillValidatorBin = path.resolve(sourceRoot, '..', '..', 'packages', 'cli', 'dist', 'index.js');
const temps = [];
const dimensions = [
  'specification', 'problem_value', 'triggering', 'scope_composition',
  'instruction_design', 'minimum_control', 'context_disclosure', 'architecture',
  'scripts', 'evals', 'reliability', 'maintainability',
];
after(async () => Promise.all(temps.map((entry) => rm(entry, { recursive: true, force: true }))));

async function awPath(temp, name, command) {
  const bin = path.join(temp, `bin-${name}`);
  const aw = path.join(bin, 'aw');
  await mkdir(bin, { recursive: true });
  await writeFile(aw, command);
  await chmod(aw, 0o755);
  return `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
}

async function passingAwPath(temp) {
  return awPath(temp, 'passing', `#!/bin/sh
if [ "$1" = "plugin" ]; then
  printf '%s\\n' '{"ok":true,"errors":[]}'
  exit 0
fi
exec "${process.execPath}" "${skillValidatorBin}" "$@"
`);
}

async function builtAwPath(temp) {
  return awPath(temp, 'built', `#!/bin/sh\nexec "${process.execPath}" "${skillValidatorBin}" "$@"\n`);
}

test('target discovery emits one bounded single-plugin review inventory', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-plugin-review-target-'));
  temps.push(temp);
  const plugin = path.join(temp, 'review-chain');
  const inspect = path.join(plugin, 'skills', 'inspect');
  const review = path.join(plugin, 'skills', 'review');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(inspect, { recursive: true });
  await mkdir(review, { recursive: true });
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'),
    JSON.stringify({ name: 'review-chain', version: '0.1.0', skills: './skills' }));
  await writeFile(path.join(inspect, 'SKILL.md'),
    '---\nname: inspect\ndescription: Inspect one plugin.\n---\n');
  await writeFile(path.join(review, 'SKILL.md'),
    '---\nname: review\ndescription: Review one plugin.\n---\n');
  const overrideSentinel = path.join(temp, 'skill-validator-override-ran');
  const overrideValidator = path.join(temp, 'skill-validator-override.mjs');
  await writeFile(overrideValidator, `
import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(overrideSentinel)}, 'executed');
process.stdout.write('{}');
`);

  const { stdout } = await execFileAsync(process.execPath, [
    discover, plugin, '--workspace-root', temp, '--format', 'json',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: await passingAwPath(temp),
      AW_SKILL_VALIDATOR_BIN: overrideValidator,
    },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.plugin, 'review-chain');
  assert.equal(result.targets.length, 2);
  assert.equal(result.pluginReview.id, 'aw-plugin:review-chain');
  assert.deepEqual(result.pluginReview.targetIds, result.targets.map((target) => target.id));
  assert.equal('providedStages' in result, false);
  assert.equal('releaseReadiness' in result, false);
  await assert.rejects(readFile(overrideSentinel), /ENOENT/u);
});

test('target discovery rejects redirected plugin, manifest, source, and final collection roots', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-plugin-review-links-'));
  temps.push(temp);
  const outside = path.join(temp, 'outside');
  const outsideSkill = path.join(outside, 'skill');
  await mkdir(outsideSkill, { recursive: true });
  await writeFile(path.join(outsideSkill, 'SKILL.md'), '---\nname: outside\ndescription: Outside sentinel.\n---\nprivate-review-sentinel\n');

  const sourcePlugin = path.join(temp, 'source-plugin');
  await mkdir(path.join(sourcePlugin, '.agents-plugin'), { recursive: true });
  await writeFile(path.join(sourcePlugin, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name: 'source-plugin', version: '0.1.0', skills: './skills',
  }));
  await symlink(outside, path.join(sourcePlugin, 'skills'));

  const manifestPlugin = path.join(temp, 'manifest-plugin');
  await mkdir(manifestPlugin, { recursive: true });
  await symlink(path.join(sourcePlugin, '.agents-plugin'), path.join(manifestPlugin, '.agents-plugin'));

  const linkedPlugin = path.join(temp, 'linked-plugin');
  await symlink(sourcePlugin, linkedPlugin);

  const safePlugin = path.join(temp, 'safe-plugin');
  await mkdir(path.join(safePlugin, '.agents-plugin'), { recursive: true });
  await writeFile(path.join(safePlugin, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name: 'safe-plugin', version: '0.1.0',
    scripts: { node: { build: { runner: 'node', path: './build.mjs' } } },
  }));
  const linkedFinal = path.join(temp, 'linked-final');
  await symlink(outside, linkedFinal);
  const PATH = await passingAwPath(temp);

  for (const [plugin, extra, expected] of [
    [linkedPlugin, [], /Plugin root must be a regular directory/u],
    [manifestPlugin, [], /.agents-plugin must be a regular directory/u],
    [sourcePlugin, [], /Skill collection root must be a regular directory/u],
    [safePlugin, ['--final', `codex-project=${linkedFinal}`], /Skill collection root must be a regular directory/u],
  ]) {
    await assert.rejects(execFileAsync(process.execPath, [
      discover, plugin, '--workspace-root', temp, ...extra, '--format', 'json',
    ], { encoding: 'utf8', env: { ...process.env, PATH } }), expected);
  }

  const unreadReview = path.join(temp, 'unread-review.json');
  await writeFile(unreadReview, 'private-review-sentinel\n');
  await assert.rejects(execFileAsync(process.execPath, [
    releaseCheck,
    safePlugin,
    '--workspace-root', temp,
    '--review', unreadReview,
    '--profile', 'codex-project',
    '--final', `codex-project=${linkedFinal}`,
    '--format', 'json',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH },
  }), /Skill collection root must be a regular directory/u);
});

test('target discovery stops after public validation rejects an escaping skills collection', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-plugin-review-escape-'));
  temps.push(temp);
  const plugin = path.join(temp, 'plugins', 'escaping-plugin');
  const outside = path.join(temp, 'plugins', 'outside');
  const sentinel = path.join(temp, 'outside-sentinel.md');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(sentinel, 'private-review-sentinel\n');
  await symlink(sentinel, path.join(outside, 'SKILL.md'));
  await writeFile(path.join(plugin, 'README.md'), '# Escaping Plugin\n');
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'), JSON.stringify({
    schemaVersion: 2,
    name: 'escaping-plugin',
    version: '0.1.0',
    description: 'Escaping fixture.',
    skills: '../outside',
    marketplace: {
      category: 'workflow', strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
    },
  }));
  await writeFile(path.join(temp, 'plugins', 'marketplace-source.json'), JSON.stringify({
    owner: { name: 'Fixture', url: 'https://example.invalid/fixture' },
    interface: { displayName: 'Fixture' },
    catalog: { version: '1.0.0' },
  }));
  let result;
  try {
    await execFileAsync(process.execPath, [
      discover, plugin, '--workspace-root', temp, '--format', 'json',
    ], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { ...process.env, PATH: await builtAwPath(temp) },
    });
  } catch (error) {
    result = JSON.parse(error.stdout);
  }
  assert.equal(result.pluginReview.machineCheck.ok, false);
  assert.deepEqual(result.targets, []);
  assert.match(JSON.stringify(result.pluginReview.machineCheck.errors), /skills|outside|escape/u);
  assert.doesNotMatch(JSON.stringify(result), /private-review-sentinel/u);
});

test('release checking propagates a special-file machine failure from a final Skill', async () => {
  if (process.platform === 'win32') return;
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-plugin-review-special-'));
  temps.push(temp);
  const plugin = path.join(temp, 'special-plugin');
  const sourceSkill = path.join(plugin, 'skills', 'demo');
  const finalRoot = path.join(temp, 'final');
  const finalSkill = path.join(finalRoot, 'demo');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  for (const skillRoot of [sourceSkill, finalSkill]) {
    await mkdir(path.join(skillRoot, 'agents'), { recursive: true });
    await writeFile(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: demo\ndescription: Check one release fixture.\n---\n',
    );
  }
  await execFileAsync('mkfifo', [path.join(finalSkill, 'blocking.pipe')]);
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name: 'special-plugin', version: '0.1.0', skills: './skills',
  }));
  const review = path.join(temp, 'review.json');
  await writeFile(review, JSON.stringify({ target: { digest: `sha256:${'0'.repeat(64)}` } }));

  let result;
  try {
    await execFileAsync(process.execPath, [
      releaseCheck,
      plugin,
      '--workspace-root', temp,
      '--review', review,
      '--profile', 'codex-project',
      '--final', `codex-project=${finalRoot}`,
      '--format', 'json',
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: await passingAwPath(temp) },
    });
  } catch (error) {
    result = JSON.parse(error.stdout);
  }
  assert.equal(result.ready, false);
  assert.ok(result.targets.some((target) =>
    target.kind === 'materialized' && target.machineCheck === 'fail'));
  assert.ok(result.reasons.some((reason) => reason.includes('failed machine check')));
});

test('release checking plans a manifest-only dynamic Codex Skill leaf and requires Eval', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-plugin-review-dynamic-'));
  temps.push(temp);
  const plugin = path.join(temp, 'dynamic-plugin');
  const sourceSkill = path.join(plugin, 'skills', 'dynamic-demo');
  const finalRoot = path.join(temp, 'final');
  const finalSkill = path.join(finalRoot, 'dynamic-demo');
  for (const skillRoot of [sourceSkill, finalSkill]) {
    await mkdir(path.join(skillRoot, 'agents'), { recursive: true });
    await writeFile(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: dynamic-demo\ndescription: Run one dynamic fixture.\n---\n',
    );
    await writeFile(path.join(skillRoot, 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n');
  }
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name: 'dynamic-plugin',
    version: '0.1.0',
    marketplace: { policy: { products: ['CODEX'] } },
    artifacts: {
      targets: [{
        id: 'dynamic-demo-skill',
        platform: 'codex',
        scopes: ['project'],
        target: 'codex.skill',
        skillKey: 'dynamic-demo',
        sourceDirs: ['./skills/dynamic-demo'],
      }],
    },
  }));
  const PATH = await passingAwPath(temp);
  let missingDiscovery;
  try {
    await execFileAsync(process.execPath, [
      discover, plugin, '--workspace-root', temp, '--format', 'json',
    ], { encoding: 'utf8', env: { ...process.env, PATH } });
  } catch (error) {
    missingDiscovery = JSON.parse(error.stdout);
  }
  assert.equal(missingDiscovery.pluginReview.machineCheck.ok, false);
  assert.equal(missingDiscovery.targets[0].dynamicTargetId, 'dynamic-demo-skill');
  assert.equal(missingDiscovery.targets[0].digest, null);
  const finalDiscovery = JSON.parse((await execFileAsync(process.execPath, [
    discover, plugin, '--workspace-root', temp,
    '--final', `codex-project=${finalRoot}`, '--format', 'json',
  ], { encoding: 'utf8', env: { ...process.env, PATH } })).stdout);
  assert.equal(finalDiscovery.pluginReview.machineCheck.ok, true);
  assert.equal(finalDiscovery.targets.length, 1);
  assert.equal(finalDiscovery.targets[0].profile, 'codex-project');
  await assert.rejects(execFileAsync(process.execPath, [
    releaseCheck, plugin, '--workspace-root', temp,
    '--profile', 'codex-project', '--final', `claude-project=${finalRoot}`,
    '--format', 'json',
  ], { encoding: 'utf8', env: { ...process.env, PATH } }),
  /Final profile is not supported by the plugin/u);
  await assert.rejects(execFileAsync(process.execPath, [
    releaseCheck, plugin, '--workspace-root', temp,
    '--profile', 'codex-project', '--format', 'json',
  ], { encoding: 'utf8', env: { ...process.env, PATH } }),
  /non-empty leaf inventory requires Review evidence/u);

  const check = JSON.parse((await execFileAsync(process.execPath, [
    skillCheck, finalSkill, '--root-kind', 'materialized',
    '--profile', 'codex-project', '--format', 'json',
  ], { encoding: 'utf8', env: { ...process.env, PATH } })).stdout);
  const review = path.join(temp, 'review.json');
  await writeFile(review, JSON.stringify({
    schemaVersion: 2,
    target: { name: 'dynamic-demo', digest: check.target.digest },
    mode: 'full',
    design: 'pass',
    complexity: 'proportionate',
    summary: 'The dynamic fixture is focused.',
    findings: [],
    unknowns: [],
    evalEvidence: 'none',
    dimensions: dimensions.map((id) => ({
      id, score: 4, confidence: 'medium', basis: `${id} is supported by the fixture.`,
    })),
  }));
  const baseArgs = [
    releaseCheck, plugin, '--workspace-root', temp,
    '--profile', 'codex-project', '--review', review, '--format', 'json',
  ];
  let ready;
  try {
    await execFileAsync(process.execPath, [
      ...baseArgs,
      '--final', `codex-project=${finalRoot}`,
    ], { encoding: 'utf8', env: { ...process.env, PATH } });
  } catch (error) {
    ready = JSON.parse(error.stdout);
  }
  assert.equal(ready.ready, false);
  assert.equal(ready.targets.length, 1);
  assert.equal(ready.targets[0].dynamicTargetId, 'dynamic-demo-skill');
  assert.equal(ready.targets[0].evalRequired, true);
  assert.ok(ready.reasons.some((reason) => reason.includes('requires evals/manifest.json bound by skillKey')));

  const duplicateRoot = path.join(temp, 'duplicate-final');
  for (const relative of ['one/dynamic-demo', 'two/dynamic-demo']) {
    const leaf = path.join(duplicateRoot, relative);
    await mkdir(leaf, { recursive: true });
    await writeFile(path.join(leaf, 'SKILL.md'),
      '---\nname: dynamic-demo\ndescription: Duplicate final leaf.\n---\n');
  }
  await assert.rejects(execFileAsync(process.execPath, [
    ...baseArgs, '--final', `codex-project=${duplicateRoot}`,
  ], { encoding: 'utf8', env: { ...process.env, PATH } }),
  /Duplicate materialized Skill dynamic-demo for codex-project/u);

  let missing;
  try {
    await execFileAsync(process.execPath, baseArgs, {
      encoding: 'utf8', env: { ...process.env, PATH },
    });
  } catch (error) {
    missing = JSON.parse(error.stdout);
  }
  assert.equal(missing.ready, false);
  assert.ok(missing.reasons.some((reason) => reason.includes('dynamic-demo-skill') && reason.includes('missing')));

  const extraFinal = path.join(finalRoot, 'extra');
  await mkdir(extraFinal, { recursive: true });
  await writeFile(path.join(extraFinal, 'SKILL.md'),
    '---\nname: extra\ndescription: Extra final leaf.\n---\n');
  let extra;
  try {
    await execFileAsync(process.execPath, [
      ...baseArgs, '--final', `codex-project=${finalRoot}`,
    ], { encoding: 'utf8', env: { ...process.env, PATH } });
  } catch (error) {
    extra = JSON.parse(error.stdout);
  }
  assert.equal(extra.ready, false);
  assert.ok(extra.reasons.some((reason) => reason.includes('not consumed by the release plan')));
});

test('shared leaf plan separates mixed static and platform-scoped dynamic Skills', async () => {
  const manifest = {
    marketplace: { policy: { products: ['CODEX', 'CLAUDE'] } },
    artifacts: { targets: [
      { id: 'codex-dynamic', target: 'codex.skill', skillKey: 'dynamic-demo', scopes: ['project'] },
      { id: 'claude-dynamic', target: 'claude.skill', skillKey: 'dynamic-demo', scopes: ['project'] },
    ] },
  };
  for (const profile of ['codex-user', 'claude-user']) {
    const plan = reviewSkillLeafPlan(manifest, ['static-demo', 'dynamic-demo'], [profile]);
    assert.deepEqual(plan.finalLeaves.map((leaf) => leaf.name), ['static-demo']);
  }
  for (const [profile, id] of [
    ['codex-project', 'codex-dynamic'],
    ['claude-project', 'claude-dynamic'],
  ]) {
    const plan = reviewSkillLeafPlan(manifest, ['static-demo', 'dynamic-demo'], [profile]);
    assert.deepEqual(plan.finalLeaves.map((leaf) => leaf.name).sort(), ['dynamic-demo', 'static-demo']);
    assert.equal(plan.dynamicLeaves[0].id, id);
    assert.equal(plan.dynamicLeaves[0].requiresEval, true);
  }
});

test('review collection discovery rejects special nodes without treating them as empty', async () => {
  if (process.platform === 'win32') return;
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-plugin-review-special-collection-'));
  temps.push(temp);
  const plugin = path.join(temp, 'special-collection-plugin');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name: 'special-collection-plugin', version: '0.1.0',
  }));
  const fifoOnly = path.join(temp, 'fifo-only');
  const mixed = path.join(temp, 'mixed');
  const specialSkill = path.join(temp, 'special-skill');
  await mkdir(fifoOnly, { recursive: true });
  await mkdir(path.join(mixed, 'valid'), { recursive: true });
  await mkdir(specialSkill, { recursive: true });
  await writeFile(path.join(mixed, 'valid', 'SKILL.md'),
    '---\nname: valid\ndescription: Valid leaf.\n---\n');
  await execFileAsync('mkfifo', [path.join(fifoOnly, 'only.pipe')]);
  await execFileAsync('mkfifo', [path.join(mixed, 'blocking.pipe')]);
  await execFileAsync('mkfifo', [path.join(specialSkill, 'SKILL.md')]);
  const PATH = await passingAwPath(temp);

  for (const [root, expected] of [
    [fifoOnly, /Skill collection contains a non-regular node/u],
    [mixed, /Skill collection contains a non-regular node/u],
    [specialSkill, /SKILL.md must be a non-symlink regular file/u],
  ]) {
    for (const command of [discover, releaseCheck]) {
      const args = command === discover
        ? [command, plugin, '--workspace-root', temp, '--final', `codex-project=${root}`, '--format', 'json']
        : [command, plugin, '--workspace-root', temp, '--profile', 'codex-project', '--final', `codex-project=${root}`, '--format', 'json'];
      await assert.rejects(execFileAsync(process.execPath, args, {
        encoding: 'utf8', timeout: 2000, env: { ...process.env, PATH },
      }), (error) => {
        assert.match(error.stderr, expected);
        assert.notEqual(error.killed, true);
        return true;
      });
    }
  }
});

test('installed reviewer supports a real non-Git plugin with MCP and no Skills', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-plugin-review-empty-'));
  temps.push(temp);
  await mkdir(path.join(temp, 'plugins'), { recursive: true });
  await writeFile(path.join(temp, 'plugins', 'marketplace-source.json'), JSON.stringify({
    owner: { name: 'Fixture', url: 'https://example.invalid/fixture' },
    interface: { displayName: 'Fixture' },
    catalog: { version: '1.0.0' },
  }));
  const plugin = path.join(temp, 'plugins', 'mcp-only');
  await execFileAsync(process.execPath, [
    skillValidatorBin,
    'plugin', 'init', 'mcp-only',
    '--description', 'MCP-only fixture.',
    '--workspace-root', temp,
    '--no-skills',
    '--with-mcp',
  ], { cwd: tmpdir(), encoding: 'utf8' });
  const PATH = await builtAwPath(temp);
  const discovered = JSON.parse((await execFileAsync(process.execPath, [
    discover, plugin, '--workspace-root', temp, '--format', 'json',
  ], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PATH } })).stdout);
  assert.deepEqual(discovered.targets, []);
  assert.equal(discovered.pluginReview.machineCheck.ok, true);
  assert.equal(discovered.pluginReview.targetLevel, 'plugin');

  const checked = JSON.parse((await execFileAsync(process.execPath, [
    releaseCheck,
    plugin,
    '--workspace-root', temp,
    '--format', 'json',
  ], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PATH } })).stdout);
  assert.equal(checked.ready, true);
  assert.deepEqual(checked.targets, []);
  assert.deepEqual(checked.notes, ['empty leaf inventory: plugin declares no Skills']);

  const extraReview = path.join(temp, 'plugin-review.json');
  await writeFile(extraReview, JSON.stringify({ target: { digest: `sha256:${'0'.repeat(64)}` } }));
  await assert.rejects(execFileAsync(process.execPath, [
    releaseCheck,
    plugin,
    '--workspace-root', temp,
    '--review', extraReview,
    '--format', 'json',
  ], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PATH } }),
  /empty leaf inventory must not receive Review or Eval evidence/u);

  const outsideEvidence = path.join(temp, 'outside-evidence.json');
  const linkedEvidence = path.join(temp, 'linked-evidence.json');
  const emptyFinal = path.join(temp, 'empty-final');
  await mkdir(emptyFinal, { recursive: true });
  await writeFile(outsideEvidence, '{}');
  await symlink(outsideEvidence, linkedEvidence);
  for (const flag of ['--review', '--preflight-audit', '--run-bundle', '--triage-audit']) {
    await assert.rejects(execFileAsync(process.execPath, [
      releaseCheck,
      plugin,
      '--workspace-root', temp,
      '--profile', 'codex-project',
      '--final', `codex-project=${emptyFinal}`,
      flag, linkedEvidence,
      '--format', 'json',
    ], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PATH } }),
    /evidence must be a non-symlink regular file/u);
  }
  if (process.platform !== 'win32') {
    const fifoEvidence = path.join(temp, 'blocking-evidence.pipe');
    await execFileAsync('mkfifo', [fifoEvidence]);
    for (const flag of ['--review', '--preflight-audit', '--run-bundle', '--triage-audit']) {
      await assert.rejects(execFileAsync(process.execPath, [
        releaseCheck,
        plugin,
        '--workspace-root', temp,
        '--profile', 'codex-project',
        '--final', `codex-project=${emptyFinal}`,
        flag, fifoEvidence,
        '--format', 'json',
      ], {
        cwd: tmpdir(),
        encoding: 'utf8',
        timeout: 2000,
        env: { ...process.env, PATH },
      }), (error) => {
        assert.match(error.stderr, /evidence must be a non-symlink regular file/u);
        assert.notEqual(error.killed, true);
        return true;
      });
    }
  }
});
