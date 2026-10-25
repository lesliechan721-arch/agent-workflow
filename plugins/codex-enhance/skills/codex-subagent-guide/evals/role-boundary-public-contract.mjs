#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { guide, fixtureProfileSources } from './fixtures/role-boundary-actions.mjs';

// Test Value Gate: the unit fixture cannot prove that the public AW validator,
// installer, installed reader and text consumer agree on the migrated contract.
// All adapters here are explicit local controls. This script never calls a model.
const keys = ['simpleTaskProfile', 'generalTaskProfile', 'complexTaskProfile', 'advancedTaskProfile',
  'quickProfile', 'standardProfile', 'deepProfile', 'advisorGeneralProfile', 'advisorAdvancedProfile', 'advisorExpertProfile', 'subagentCommands'];
const evalRoot = path.dirname(fileURLToPath(import.meta.url));
const guideSource = path.dirname(evalRoot);
const pluginSource = path.resolve(guideSource, '..', '..');
const actions = path.join(evalRoot, 'fixtures', 'role-boundary-actions.mjs');

async function run(command, args, { cwd, env, input } = {}) {
  const child = spawn(command, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.on('error', () => {});
  child.stdin.end(input ?? '');
  const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
  try {
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
  } finally { clearTimeout(timer); }
}
async function action(fixture, input) {
  const result = await run(process.execPath, [actions], { env: fixture.env, cwd: fixture.workspace,
    input: JSON.stringify({ version: 1, paths: { workspace: fixture.workspace, fixtures: evalRoot }, input }) });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.version, 1); assert.equal(receipt.completed, true);
  return receipt;
}
async function json(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function state(fixture) { return json(path.join(fixture.workspace, '.role-boundary-fixture', 'state.json')); }
async function calls(fixture) {
  return readFile(fixture.capture, 'utf8').then((text) => text.trim().split('\n').map(JSON.parse)).catch((error) => {
    if (error.code === 'ENOENT') return []; throw error;
  });
}
function homes(root) {
  return { HOME: path.join(root, 'home'), AW_HOME: path.join(root, 'home', 'aw'), AW_CODEX_HOME: path.join(root, 'home', 'codex'),
    AW_CLAUDE_HOME: path.join(root, 'home', 'claude'), CODEX_HOME: path.join(root, 'home', 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'home', 'claude') };
}
async function prepareGuide(root, env) {
  const staging = path.join(root, 'staging'), guide = path.join(staging, 'skills', 'codex-subagent-guide');
  await mkdir(path.join(staging, 'scripts'), { recursive: true });
  await cp(guideSource, guide, { recursive: true, filter: (source) => path.relative(guideSource, source).split(path.sep)[0] !== 'evals' });
  const build = path.join(staging, 'scripts', 'build-runtime.mjs');
  await cp(path.join(pluginSource, 'scripts', 'build-runtime.mjs'), build);
  await symlink(path.join(pluginSource, 'scripts', 'node_modules'), path.join(staging, 'scripts', 'node_modules'), 'dir');
  const result = await run(process.execPath, [build], { cwd: staging, env });
  assert.equal(result.exitCode, 0, result.stderr);
  return guide;
}
async function fixture(root, name, baseEnv, preparedGuide) {
  const location = path.join(root, name), workspace = path.join(location, 'workspace');
  const guide = path.join(workspace, '.agents', 'skills', 'codex-subagent-guide');
  await mkdir(workspace, { recursive: true });
  await cp(preparedGuide, guide, { recursive: true });
  const capture = path.join(location, 'adapter-calls.jsonl'), entrypoint = path.join(location, 'adapter.mjs');
  await writeFile(entrypoint, `import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const lines=createInterface({input:process.stdin});
lines.once('line',async(line)=>{
const request=JSON.parse(line);
await appendFile(${JSON.stringify(capture)},JSON.stringify({request,environmentValue:process.env.FIXTURE_TARGET})+'\\n');
const emit=(event)=>process.stdout.write(JSON.stringify({protocolVersion:5,...event})+'\\n');
emit({type:'ready',communicationSupported:false});
emit({type:'closing',reason:'completed'});
emit({type:'result',state:'completed',generationStarted:true,backendExitCode:0,text:'# Local fixture result\\n\\nThe public v5 contract reached one local fake Adapter.\\n'});
process.exit(0);
});
`);
  const native = { executor: 'native', model: 'fixture-native-model', reasoningEffort: 'medium' };
  const values = Object.fromEntries(keys.filter((key) => key !== 'subagentCommands').map((key) => [key, { ...native }]));
  values.advisorGeneralProfile = { executor: 'fixture-external' }; // Omission must reach backend defaults unchanged.
  values.subagentCommands = [{ key: 'fixture-external', adapter: 'custom', mode: 'workspace',
    command: process.execPath, entrypoint, envFrom: { FIXTURE_TARGET: 'PUBLIC_FIXTURE_VALUE' } },
  { key: 'fixture-builtin', adapter: 'codex' }];
  await writeFile(path.join(guide, '.aw-runtime-config.json'), JSON.stringify({ schemaVersion: 2, kind: 'aw-runtime-config',
    installedIdentity: { pluginId: 'explicit-local-fixture/codex-enhance' }, allowedKeys: ['subagentCommands'], resourceRoot: guide, effectiveValues: { subagentCommands: values.subagentCommands } }));
  const advisor = path.join(workspace, '.agents', 'skills', 'codex-advisor', 'assets');
  await mkdir(advisor, { recursive: true });
  await writeFile(path.join(advisor, 'advisor-instructions.md'), 'Give this assigned local second opinion. Stay read-only. Do not delegate.\n');
  for (const [relative, source] of Object.entries(fixtureProfileSources(values))) {
    const target = path.join(workspace, '.agents', 'skills', relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return { workspace, capture, env: { ...baseEnv, ...homes(path.join(workspace, '.role-boundary-fixture')), PUBLIC_FIXTURE_VALUE: 'explicit-local-value' } };
}
async function installedRun(fixture, args, input) {
  const installed = await state(fixture);
  const result = await guide(installed.project, ['start', ...args],
    { root: installed.guideRoot, env: fixture.env, input });
  return { exitCode: result.exitCode, stdout: result.value.stdout, stderr: result.value.stderr, observed: result.value };
}

async function main() {
  const parsed = parseArgs({ options: { cli: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (parsed.values.help) { process.stdout.write('Usage: node role-boundary-public-contract.mjs --cli PATH_TO_COMPILED_AW\nAll homes, catalogs and adapters are temporary. No models are called.\n'); return; }
  assert.ok(parsed.values.cli, 'Supply --cli PATH_TO_COMPILED_AW; this contract does not build the CLI.');
  const cli = await realpath(path.resolve(parsed.values.cli));
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-role-boundary-public-')));
  try {
    const bin = path.join(root, 'bin'), temp = path.join(root, 'tmp'), forbidden = path.join(root, 'forbidden-model-call');
    await Promise.all([mkdir(bin), mkdir(temp)]);
    // Only this temporary executable gives fixture actions their public PATH aw.
    await writeFile(path.join(bin, 'aw'), `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nconst result=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},...process.argv.slice(2)],{stdio:'inherit'});if(result.error)throw result.error;process.exitCode=result.status??1;\n`, { mode: 0o700 });
    for (const backend of ['codex', 'claude', 'oracle']) await writeFile(path.join(bin, backend), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';writeFileSync(${JSON.stringify(forbidden)},'unexpected model CLI');process.exitCode=127;\n`, { mode: 0o700 });
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...homes(root), TMPDIR: temp, CI: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'unused-git-config'), LANG: 'C.UTF-8' };
    const preparedGuide = await prepareGuide(root, env);
    const checks = [];

    const updated = await fixture(root, 'save-apply', env, preparedGuide);
    await action(updated, { operation: 'instruction-update-install' });
    const installed = await state(updated);
    const schema = await json(path.join(installed.plugin, '.agents-plugin', 'plugin.json'));
    assert.equal(schema.config.schemaVersion, 4);
    assert.deepEqual(Object.keys(installed.effectiveValues), ['subagentCommands']);
    assert.deepEqual(installed.execution, { executor: 'fixture-external' });
    assert.equal(installed.effectiveValues.subagentCommands.find((item) => item.adapter === 'codex').mode, undefined);
    checks.push('public Config Definition v4 validate/build/source/install; optional external model and fixed builtin mode');

    const prompt = 'The complete task-only prompt.\n';
    const original = await installedRun(updated, ['--executor', 'fixture-external', '--prompt', '-'], prompt);
    assert.equal(original.exitCode, 0, original.stderr); assert.equal(original.observed.state, 'completed');
    assert.match(original.stdout, /^result: read\n/); assert.match(original.stdout, /# Local fixture result/); assert.equal(original.stderr, '');
    let observed = await calls(updated);
    assert.equal(observed.length, 1); assert.equal(observed[0].request.protocolVersion, 5);
    assert.equal(observed[0].request.prompt, prompt); assert.equal(observed[0].request.execution.model, undefined);
    assert.equal(observed[0].request.execution.reasoningEffort, undefined); assert.equal(observed[0].environmentValue, 'explicit-local-value');
    assert.equal(observed[0].request.fileSelectors, undefined); assert.equal(observed[0].request.fileResolver, undefined);
    checks.push('installed provenance reader, stdin and framed text consumer reach one fake v5 Adapter');

    const transitioned = await action(updated, { operation: 'apply-instructions' });
    assert.deepEqual(transitioned.evidence.before, transitioned.evidence.saved);
    assert.notDeepEqual(transitioned.evidence.before.subagentCommands, transitioned.evidence.after.subagentCommands);
    assert.notEqual(transitioned.evidence.instructionsBefore, transitioned.evidence.instructionsAfter);
    const fresh = await installedRun(updated, ['--executor', 'fixture-external', '--prompt', '-', '--instructions-file', installed.instructionsFile], prompt);
    assert.equal(fresh.exitCode, 0, fresh.stderr);
    observed = await calls(updated); assert.equal(observed.length, 2);
    assert.equal(observed[0].request.prompt, prompt);
    assert.equal(observed[1].request.prompt, `Instructions:\n${transitioned.evidence.instructionsAfter}\n\nTask:\n${prompt}`);
    await mkdir(path.join(updated.workspace, 'provided'), { recursive: true });
    await writeFile(path.join(updated.workspace, 'provided', 'original-result.txt'), original.stdout);
    await writeFile(path.join(updated.workspace, 'provided', 'new-result.txt'), fresh.stdout);
    const foreground = await action(updated, { operation: 'verify-foreground' });
    assert.equal(foreground.evidence.observation, 'captured');
    assert.equal(foreground.evidence.results.original.state, 'completed');
    assert.equal(foreground.evidence.results.new.state, 'completed');
    checks.push('public save leaves active values unchanged; apply updates next prompt; run result artifacts are readable');

    const invalid = await fixture(root, 'invalid-input', env, preparedGuide);
    const rejected = await action(invalid, { operation: 'invalid-workspace-files' });
    assert.equal(rejected.evidence.preflight.exitCode, 2);
    assert.equal(rejected.evidence.preflight.code, 'filesNotAllowedInWorkspace');
    assert.equal(rejected.evidence.adapterExecutionCounter, null); assert.deepEqual(await calls(invalid), []);
    checks.push('J16 public workspace file rejection exits 2 with zero Adapter starts');

    const fault = await fixture(root, 'single-write', env, preparedGuide);
    const task = 'Write probe/once.txt once, then stop with an unknown completion state.';
    const partial = await action(fault, { operation: 'single-write-disconnect', task,
      initialRun: { access: 'workspace-write', allowedWorkspaceChanges: ['probe/once.txt'], operation: task, counterOwner: 'explicit-local-contract' } });
    assert.equal(partial.evidence.result.state, 'unknown'); assert.equal(partial.evidence.result.exitCode, 0);
    assert.deepEqual(partial.evidence.counter, { submissions: 1, writes: 1 }); assert.deepEqual(await calls(fault), []);
    checks.push('J12 public fault control performs one write and text consumer preserves unknown');
    await assert.rejects(readFile(forbidden), { code: 'ENOENT' });
    process.stdout.write(JSON.stringify({ status: 'passed', checks, scope: 'Compiled public CLI and isolated synthetic local controls only; no model, native host or packed distribution qualification.' }, null, 2) + '\n');
  } finally { await rm(root, { recursive: true, force: true }); }
}

main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
