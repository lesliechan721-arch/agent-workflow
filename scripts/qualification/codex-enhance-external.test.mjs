import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { qualificationArguments, checkQualification, runQualification } from './codex-enhance-external.mjs';
import { RUNTIME_KEYS } from '../../plugins/codex-enhance/skills/codex-subagent-guide/scripts/runtime/contracts.mjs';

// Test Value Gate: real qualification must not submit a model call by default or
// mistake a matching fake CLI version for model/platform qualification evidence.
test('qualification defaults to local preflight and requires all actual call inputs', () => {
  assert.equal(qualificationArguments(['--binary', '/absolute/codex']).run, false);
  assert.throws(() => qualificationArguments(['--run', '--binary', '/absolute/codex']), { code: 'qualificationInputsRequired' });
  assert.throws(() => qualificationArguments(['--run', '--binary', '/absolute/codex', '--guide-root', '/installed/guide', '--advisor-root', '/installed/advisor', '--explore-root', '/installed/explore', '--out', '/new/output', '--model', 'explicit-model']), { code: 'qualificationNotAuthorized' });
  assert.throws(() => qualificationArguments(['--binary', 'codex']), { code: 'codexExecutableMissing' });
});

test('fake preflight proves exact-version rejection and zero generation only', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-subagent-qualification-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'fake-codex');
  const observed = path.join(directory, 'arguments.json');
  await fs.writeFile(binary, `#!${await fs.realpath(process.execPath)}
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify(process.argv.slice(2)));
process.stdout.write('codex-cli 0.160.1\\n');
`, { mode: 0o700 });
  const result = await checkQualification({ binary });
  assert.equal(result.generationStarted, false);
  assert.equal(result.qualification, 'not-established');
  assert.deepEqual(JSON.parse(await fs.readFile(observed, 'utf8')), ['--version']);
  await fs.writeFile(binary, `#!${await fs.realpath(process.execPath)}\nprocess.stdout.write('codex-cli 0.160.0\\n');\n`, { mode: 0o700 });
  await assert.rejects(checkQualification({ binary }), { code: 'codexVersionUnsupported' });
});

// Test Value Gate: the public qualification matrix must use the current foreground
// interfaces and preserve unknown attempts without retry. This fake backend is not
// evidence of real service support, model behavior, or sandbox containment.
test('the six explicit instruction probes use v3 and preserve an unknown attempt', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-qualification-v3-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const guide = path.join(directory, 'codex-subagent-guide');
  const advisor = path.join(directory, 'advisor-input');
  const explore = path.join(directory, 'explore-input');
  const roots = { 'guide-root': guide, 'advisor-root': advisor, 'explore-root': explore };
  for (const [root, file, text] of [[guide, 'task-instructions.md', 'task instructions'],
    [advisor, 'advisor-instructions.md', 'advisor instructions'], [explore, 'explore-instructions.md', 'explore instructions']]) {
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    await fs.writeFile(path.join(root, 'assets', file), text);
  }
  await fs.cp(path.join(repoRoot, 'plugins/codex-enhance/skills/codex-subagent-guide/scripts'), path.join(guide, 'scripts'), { recursive: true });
  await fs.copyFile(path.join(repoRoot, 'packages/cli/authoring/assets/aw-runtime-config.mjs'), path.join(guide, 'scripts/aw-runtime-config.mjs'));
  await fs.writeFile(path.join(guide, 'SKILL.md'), 'qualification fixture');
  const identity = { sourceId: 'fixture', sourceIdentity: 'fixture-source', pluginId: 'fixture/fixture-plugin',
    pluginName: 'fixture-plugin', pluginVersion: '1.0.0', platform: 'codex', scope: 'user', configScope: 'user',
    artifactId: 'fixture-guide', skillKey: 'codex-subagent-guide' };
  await fs.writeFile(path.join(guide, '.aw-runtime-config.json'), JSON.stringify({ schemaVersion: 2, kind: 'aw-runtime-config',
    installedIdentity: identity, allowedKeys: RUNTIME_KEYS,
    effectiveValues: { generalTaskProfile: { model: 'configured-model', reasoningEffort: 'medium' },
      advisorProfile: { model: 'configured-model', reasoningEffort: 'high' }, standardProfile: { model: 'configured-model', reasoningEffort: 'high' }, subagentCommands: [] } }));
  const observed = path.join(directory, 'generations.jsonl');
  const binary = path.join(directory, 'fake-codex');
  await fs.writeFile(binary, `#!${await fs.realpath(process.execPath)}
import fs from 'node:fs';
if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.160.1\\n'); process.exit(0); }
const args = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const instruction = args.find((arg) => arg.startsWith('developer_instructions='));
const instructions = JSON.parse(instruction.slice('developer_instructions='.length));
const mode = args.includes('features.shell_tool=false') ? 'bundle' : 'workspace';
fs.appendFileSync(${JSON.stringify(observed)}, JSON.stringify({ instructions, mode, payload, model: args[args.indexOf('-m') + 1] }) + '\\n');
fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], 'bounded answer');
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-session' }) + '\\n');
if (instructions !== 'advisor instructions' || mode !== 'workspace') process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
`, { mode: 0o700 });
  const home = path.join(directory, 'home');
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome, { recursive: true });
  const result = await runQualification({ binary, ...roots, run: true, out: path.join(directory, 'output'),
    model: 'explicit-model', effort: 'high', 'allow-model-cost': true, 'allow-material-transfer': true },
  { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome });
  assert.equal(result.cases.length, 6);
  assert.equal(result.cases.filter((item) => item.programState === 'unknown').length, 1);
  assert.equal(result.cases.filter((item) => item.programState === 'completed').length, 5);
  assert.ok(result.cases.every((item) => item.fixtureUnchanged));
  assert.ok(result.cases.every((item) => item.modelBehavior === 'requires-independent-eval'));
  assert.equal(result.qualification, 'program-evidence-only');
  const submissions = (await fs.readFile(observed, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(submissions.length, 6);
  assert.deepEqual(submissions.map(({ instructions }) => instructions),
    ['task instructions', 'task instructions', 'advisor instructions', 'advisor instructions', 'explore instructions', 'explore instructions']);
  assert.ok(submissions.every((item) => item.model === 'explicit-model'));
  assert.deepEqual(submissions.map(({ mode, payload }) => [mode, payload.materials.length]),
    [['workspace', 0], ['bundle', 3], ['workspace', 0], ['bundle', 3], ['workspace', 0], ['bundle', 3]]);
  const stored = JSON.parse(await fs.readFile(path.join(directory, 'output/codex-advisor-workspace/request.json'), 'utf8'));
  assert.equal(stored.protocolVersion, 3);
  assert.equal(typeof stored.instructions, 'string');
  assert.equal(stored.execution.model, 'explicit-model');
});
