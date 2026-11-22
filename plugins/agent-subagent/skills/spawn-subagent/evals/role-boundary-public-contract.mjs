#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { guide, inspectGuideCommand } from './fixtures/role-boundary-actions.mjs';

// Verifies the public preparation, installation, configuration and framed
// command consumer together. The only adapters are explicit local controls.
const evalRoot = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(evalRoot, '../../../../..');

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

async function json(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function action(fixture, { command, input }) {
  const result = await run(process.execPath, [path.join(fixture.fixtures, command[1])], {
    env: fixture.env, cwd: fixture.workspace,
    input: JSON.stringify({ version: 1, paths: { workspace: fixture.workspace, fixtures: fixture.fixtures }, input }),
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.completed, true);
  return receipt.evidence;
}

async function prepareSpec(root, env, config, suite, profile) {
  await writeFile(path.join(root, `${suite}-config.json`), JSON.stringify(config));
  const prepared = path.join(root, suite);
  const result = await run('aw', ['dev', 'eval', 'prepare', 'agent-subagent', 'spawn-subagent', '--workspace-root', repo,
    '--suite', suite, '--profile', profile, '--config-file', path.join(root, `${suite}-config.json`), '--output', prepared, '--json'], { cwd: repo, env });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const spec = await json(path.join(prepared, 'spec.json'));
  const command = await json(path.join(prepared, 'workspace', 'eval', '.aw-command-fixture', 'command.json'));
  assert.equal(command.platform, 'codex');
  assert.deepEqual(command.command.runtimeConfig.keys, ['subagentCommands', 'subagentRetentionHours']);
  const selected = await json(path.join(prepared, 'cases.json'));
  return { prepared, spec, cases: selected.cases };
}

async function fixture(root, env, source, id) {
  const location = path.join(root, id), workspace = path.join(location, 'workspace', 'subject');
  const fixtures = path.join(location, 'workspace', 'eval'), output = path.join(location, 'output');
  await cp(path.join(source.prepared, 'workspace'), path.join(location, 'workspace'), { recursive: true });
  await cp(path.join(source.prepared, source.spec.target.path), path.join(workspace, '.agents', 'skills', 'spawn-subagent'), { recursive: true });
  await mkdir(output);
  const selected = source.cases.find((item) => item.id === id);
  assert.ok(selected);
  const provider = source.spec.provider.command[1];
  const result = await run(process.execPath, [path.join(location, provider)], {
    env, cwd: location, input: JSON.stringify({ version: 1, phase: 'prepare', case: selected, variant: 'current', attempt: 1, paths: { workspace, fixtures, output } }),
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return { workspace, fixtures, env, request: JSON.parse(result.stdout) };
}

function invocation(fixture, state) {
  return { selector: state.commandSelector, env: { ...fixture.env, ...state.commandEnvironment } };
}

async function calls(capture, workspace) {
  return readFile(capture, 'utf8').then((text) => text.trim().split('\n').map(JSON.parse)
    .filter(({ request }) => request.workspace === workspace)).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}

async function main() {
  const parsed = parseArgs({ options: { cli: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (parsed.values.help) {
    process.stdout.write('Usage: node role-boundary-public-contract.mjs --cli PATH_TO_COMPILED_AW\nUses isolated homes, local catalogs and fake adapters. No models are called.\n');
    return;
  }
  assert.ok(parsed.values.cli, 'Supply --cli PATH_TO_COMPILED_AW.');
  const cli = await realpath(path.resolve(parsed.values.cli));
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-role-boundary-public-')));
  const checks = [];
  try {
    const bin = path.join(root, 'bin'), temp = path.join(root, 'tmp'), home = path.join(root, 'home');
    const forbidden = path.join(root, 'forbidden-model-call'), capture = path.join(root, 'adapter-calls.jsonl');
    const entrypoint = path.join(root, 'adapter.mjs');
    await Promise.all([mkdir(bin), mkdir(temp), mkdir(home)]);
    await writeFile(path.join(bin, 'aw'), `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nconst result=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},...process.argv.slice(2)],{stdio:'inherit'});if(result.error)throw result.error;process.exitCode=result.status??1;\n`, { mode: 0o700 });
    for (const backend of ['codex', 'claude', 'oracle', 'agy']) {
      await writeFile(path.join(bin, backend), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nif (process.argv.length === 3 && process.argv[2] === '--version') {\n  console.log(${JSON.stringify(`${backend === 'codex' ? 'codex-cli' : backend} 0.140.0`)});\n} else {\n  writeFileSync(${JSON.stringify(forbidden)},'unexpected model CLI');process.exitCode=127;\n}\n`, { mode: 0o700 });
    }
    await writeFile(entrypoint, `import { appendFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const lines = createInterface({ input: process.stdin });
lines.once('line', async (line) => {
  const request = JSON.parse(line);
  const revision = process.env.FIXTURE_REVISION;
  await appendFile(${JSON.stringify(capture)}, JSON.stringify({ request, revision, environmentValue: process.env.FIXTURE_TARGET }) + '\\n');
  const emit = (event) => process.stdout.write(JSON.stringify({ protocolVersion: 5, ...event }) + '\\n');
  emit({ type: 'ready', initialization: { environment: { status: 'available' }, capabilities: {
    communication: { status: request.communication ? 'unsupported' : 'disabled' },
    resume: { status: request.resume ? 'unsupported' : 'disabled' },
  } } });
  if (revision === 'original') {
    const deadline = Date.now() + 30000;
    const gate = path.join(request.workspace, '.role-boundary-fixture', 'finish');
    while (!(await stat(gate).catch(() => null))) {
      if (Date.now() >= deadline) process.exit(3);
      await sleep(25);
    }
  }
  emit({ type: 'closing', reason: 'completed' });
  emit({ type: 'result', state: 'completed', generationStarted: true, backendExitCode: 0, text: '# Local fixture result\\n\\n' });
  process.exit(0);
});
`);
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home, USERPROFILE: home,
      AW_HOME: path.join(home, 'aw'), TMPDIR: temp, CI: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(root, 'unused-git-config'), LANG: 'C.UTF-8', npm_config_offline: 'true',
      ...(process.env.npm_config_store_dir && { npm_config_store_dir: process.env.npm_config_store_dir }),
      PUBLIC_FIXTURE_VALUE: 'explicit-local-value' };
    const agentSubagent = {
      subagentCommands: [{ key: 'fixture-external', adapter: 'custom', mode: 'workspace', command: process.execPath, entrypoint,
        env: { FIXTURE_REVISION: 'original' }, envFrom: { FIXTURE_TARGET: 'PUBLIC_FIXTURE_VALUE' }, communication: false },
      { key: 'fixture-builtin', adapter: 'codex' }],
      generalTaskProfile: { executor: 'fixture-external' },
    };
    const composition = await prepareSpec(root, env, { 'agent-subagent': agentSubagent,
      'codex-enhance': { advisorGeneralProfile: { executor: 'fixture-external' } } }, 'joint-workflow', 'project-composition');
    const guideOnly = await prepareSpec(root, env, { 'agent-subagent': agentSubagent }, 'joint-guide-only', 'project-default');
    for (const id of ['J11', 'J17']) {
      const current = await fixture(root, env, composition, id);
      const state = await action(current, current.request.evaluation.setupActions[0]);
      const options = invocation(current, state);
      const installed = await inspectGuideCommand(current.workspace, state.commandSelector, options.env);
      assert.deepEqual(installed.runtimeConfigPlatforms, ['codex']);
      assert.equal(installed.owner.kind, 'plugin');
      assert.deepEqual(state.execution, { executor: 'fixture-external' });
      const manifest = await json(path.join(current.workspace, '.role-boundary-fixture', 'catalog', 'plugins', 'role-boundary-lab', '.agents-plugin', 'plugin.json'));
      assert.equal(manifest.schemaVersion, 4);
      assert.equal(manifest.config.schemaVersion, 5);
      assert.equal(manifest.config.fields.subagentCommands.default.find(({ adapter }) => adapter === 'codex').mode, undefined);

      const args = ['start', '--executor', state.execution.executor, '--prompt-file', state.promptFile, '--instructions-file', state.instructionsFile];
      const prompt = await readFile(state.promptFile, 'utf8');
      const started = await guide(current.workspace, [...args, '--diagnostics'], { ...options, follow: false, allowFailure: true });
      assert.ok(['started', 'starting'].includes(started.value.event), JSON.stringify(started.value));
      assert.ok(started.value.run);
      if (started.value.event === 'starting') {
        const ready = await guide(current.workspace, ['wait', '--run', started.value.run, '--timeout-ms', '10000'], options);
        assert.equal(ready.value.event, 'ready', JSON.stringify(ready.value));
      }
      const waiting = await guide(current.workspace, ['wait', '--run', started.value.run, '--timeout-ms', '0'], options);
      assert.equal(waiting.value.stdout, 'timeout\n');

      const transitioned = await action(current, current.request.evaluation.interactions[0].action);
      assert.deepEqual(transitioned.before, transitioned.saved);
      assert.equal(transitioned.after.subagentCommands[0].env.FIXTURE_REVISION, 'updated');
      assert.equal(transitioned.before.subagentRetentionHours, transitioned.after.subagentRetentionHours);
      assert.equal(transitioned.installedIdentity.sourceContentDigest, state.installedIdentity.sourceContentDigest);
      assert.equal(id === 'J11', transitioned.instructionsBefore === transitioned.instructionsAfter);
      await writeFile(path.join(current.workspace, '.role-boundary-fixture', 'finish'), '');
      await guide(current.workspace, ['wait', '--run', started.value.run, '--timeout-ms', '10000'], options);
      const original = (await guide(current.workspace, ['result', '--run', started.value.run], options)).value;
      const fresh = (await guide(current.workspace, args, options)).value;
      assert.equal(original.state, 'completed');
      assert.equal(fresh.state, 'completed');
      assert.equal(original.run, started.value.run);
      assert.notEqual(fresh.run, original.run);
      assert.match(fresh.stdout, /# Local fixture result/);
      const observed = await calls(capture, current.workspace);
      assert.deepEqual(observed.map(({ revision }) => revision), ['original', 'updated']);
      for (const [index, expected] of [transitioned.instructionsBefore, transitioned.instructionsAfter].entries()) {
        const { request, environmentValue } = observed[index];
        assert.equal(request.protocolVersion, 5);
        assert.equal(request.prompt, `Instructions:\n${expected}\n\nTask:\n${prompt}`);
        assert.equal(request.execution.model, undefined);
        assert.equal(request.execution.reasoningEffort, undefined);
        assert.equal(environmentValue, 'explicit-local-value');
        assert.equal(request.fileSelectors, undefined);
      }
      await mkdir(path.join(current.workspace, 'provided'), { recursive: true });
      await writeFile(path.join(current.workspace, 'provided', 'original-result.txt'), original.stdout);
      await writeFile(path.join(current.workspace, 'provided', 'new-result.txt'), fresh.stdout);
      const foreground = await action(current, current.request.evaluation.finalActions[0]);
      assert.equal(foreground.observation, 'captured');
      assert.equal(foreground.results.original.state, 'completed');
      assert.equal(foreground.results.new.state, 'completed');
      checks.push(`${id} saved values keep the original run active; Codex apply updates the next invocation`);
    }

    const j15 = await fixture(root, env, guideOnly, 'J15');
    assert.deepEqual(j15.request.roles, []);
    const custom = await action(j15, j15.request.evaluation.setupActions[0]);
    await assert.rejects(readFile(path.join(j15.workspace, '.agents', 'skills', 'codex-advisor', 'SKILL.md')), { code: 'ENOENT' });
    await writeFile(path.join(j15.workspace, '.role-boundary-fixture', 'finish'), '');
    const result = await guide(j15.workspace, ['start', '--executor', custom.execution.executor,
      '--prompt-file', custom.promptFile, '--instructions-file', custom.instructionsFile], invocation(j15, custom));
    assert.equal(result.value.state, 'completed');
    const seen = await calls(capture, j15.workspace);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].request.prompt, `Instructions:\n${await readFile(custom.instructionsFile, 'utf8')}\n\nTask:\n${await readFile(custom.promptFile, 'utf8')}`);
    checks.push('J15 loaded Guide uses one unregistered instructions file and file-based task input');

    const j16 = await fixture(root, env, composition, 'J16');
    const rejected = await action(j16, j16.request.evaluation.setupActions[0]);
    assert.equal(rejected.preflight.exitCode, 2);
    assert.equal(rejected.preflight.code, 'filesNotAllowedInWorkspace');
    assert.equal(rejected.adapterExecutionCounter, null);
    checks.push('J16 public start rejects the empty workspace file selector before adapter execution');

    const j12 = await fixture(root, env, composition, 'J12');
    const partial = await action(j12, j12.request.evaluation.setupActions[0]);
    assert.equal(partial.result.state, 'unknown');
    assert.equal(partial.result.exitCode, 0);
    assert.deepEqual(partial.counter, { submissions: 1, writes: 1 });
    checks.push('J12 local disconnect preserves unknown, one submission and one write');
    await assert.rejects(readFile(forbidden), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  process.stdout.write(JSON.stringify({ status: 'passed', checks, scope: 'Compiled public CLI and isolated local adapter controls.' }, null, 2) + '\n');
}

main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
