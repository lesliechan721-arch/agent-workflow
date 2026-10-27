import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, terminalPattern, testTimeoutMs, blocks, field, bounded, successful } from './fixtures/subagent-integration.mjs';

// Test Value Gate: a copied installation must preserve caller text, argv, installed
// helpers and captured configuration after the short start command exits.
test('installed start preserves UTF-8 input, environment and one captured execution', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'bundle');
  const clock = await f.clock(['start'], { stepMs: 1000 });
  const instructions = 'Explicit fixture role.\r\n保留指令。\n';
  await fs.writeFile(path.join(f.directory, 'instructions.md'), instructions);
  Object.assign(f.snapshot.effectiveValues.subagentCommands[0], {
    args: ['--region', 'literal; $(touch escaped)', ''], env: { SOURCE: 'replacement', EMPTY: '' },
    envFrom: { SERVICE_DATA: 'SOURCE', EMPTY_REFERENCE: 'EMPTY_HOST' },
  });
  await f.save();
  const prompt = '  原始任务 🧪\r\n$(touch escaped); `literal`\n';
  const selectors = [' missing/**/*.ts , docs/absent.md ', '!**/*.test.ts', ' missing/**/*.ts , docs/absent.md '];
  const started = await f.start({ communication: false, readyGate: true }, { prompt: '-', stdin: Buffer.from(prompt), cwd: f.directory,
    extra: ['--name', 'api-review_2.1', '--instructions-file', 'instructions.md', '--model', 'explicit-model', '--reasoning-effort', 'high',
      ...selectors.flatMap((selector) => ['--file', selector])],
    env: { ...clock.environment, SOURCE: 'host-value', EMPTY_HOST: '', ORDINARY_HOST: 'inherited', AW_PLUGIN_CONTEXT: 'private', AW_SUBAGENT_TEMP_DIR: 'foreign' } });
  await f.initialized(started);
  const observations = await clock.acknowledgements();
  assert.equal(observations.length, 1); assert.equal(observations[0].now - clock.origin, 10000);
  assert.equal(field(started.stdout, 'agent'), 'api-review_2.1');
  if (started.code === 0) assert.equal(field(started.stdout, 'communication'), 'false');
  assert.deepEqual(blocks(started.stdout, 'FINAL'), []);
  const observed = await started.observed();
  assert.equal(observed.request.protocolVersion, 5); assert.equal(observed.request.type, 'start');
  assert.equal(observed.request.run.deadlineAt, null); assert.equal(observed.request.run.name, 'api-review_2.1');
  assert.ok(observed.request.prompt.includes(instructions)); assert.ok(observed.request.prompt.endsWith(prompt));
  assert.deepEqual(observed.request.execution, { executor: 'fixture', model: 'explicit-model', reasoningEffort: 'high' });
  assert.deepEqual(observed.request.fileSelectors, selectors);
  assert.deepEqual(observed.request.fileResolver, { command: process.execPath, args: [path.join(f.installed, 'scripts/resolve-files.mjs')] });
  assert.ok(Object.values(observed.request.runtime.toolkit).every((value) => value === process.execPath || value.startsWith(f.installed + path.sep)));
  assert.equal(observed.cwd, f.workspace); assert.deepEqual(observed.argv, []);
  assert.deepEqual(observed.request.args, f.snapshot.effectiveValues.subagentCommands[0].args);
  assert.equal(observed.environment.SOURCE, 'replacement'); assert.equal(observed.environment.SERVICE_DATA, 'host-value');
  assert.equal(observed.environment.EMPTY, ''); assert.equal(observed.environment.EMPTY_REFERENCE, '');
  assert.equal(observed.environment.ORDINARY_HOST, 'inherited'); assert.equal(observed.environment.AW_PLUGIN_CONTEXT, undefined);
  assert.notEqual(observed.environment.AW_SUBAGENT_TEMP_DIR, 'foreign');
  assert.equal(JSON.stringify(observed.request).includes('host-value'), false);
  assert.equal(await fs.stat(path.join(f.workspace, 'escaped')).catch(() => null), null);
  await fs.writeFile(path.join(f.directory, 'instructions.md'), 'changed role');
  f.snapshot.effectiveValues.subagentCommands = []; await f.save();
  const initialized = await f.command(['wait', '--run', started.run, '--timeout-ms', '0']);
  successful(initialized, 'wait');
  if (started.code === 1) assert.equal(field(initialized.stdout, 'communication'), 'false');
  await started.finish(); await f.waitTerminal(started.run);
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result'); assert.deepEqual(blocks(result.stdout, 'FINAL'), ['Complete final answer.']);
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\n');
});

// Test Value Gate: one wait window must observe all targets and continue reading
// valid targets when another handle is unavailable, without replaying old results.
test('multi-target wait wakes for B and does not replay the settled A result', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const a = await f.start({ finishImmediately: true, finalText: 'A complete.' }, { extra: ['--name', 'duplicate'] });
  const b = await f.start({ echo: true }, { extra: ['--name', 'duplicate'] });
  await f.initialized(a); await f.initialized(b); await f.waitTerminal(a.run);
  const baseline = await f.command(['wait', '--run', b.run, '--timeout-ms', '0']);
  successful(baseline, 'wait'); assert.deepEqual(blocks(baseline.stdout, 'MESSAGE'), []);
  const pendingWait = f.command(['wait', '--run', a.run, '--run', b.run]);
  successful(await f.command(['send', '--run', b.run, '--text', 'B changed.']), 'send');
  const changed = await pendingWait;
  successful(changed, 'wait'); bounded(changed);
  assert.deepEqual(blocks(changed.stdout, 'MESSAGE'), ['B changed.'], changed.stdout + changed.stderr);
  assert.equal(field(changed.stdout, 'run'), b.run); assert.deepEqual(blocks(changed.stdout, 'FINAL'), []);
  const timeout = await f.command(['wait', '--run', a.run, '--run', b.run, '--timeout-ms', '0']);
  assert.equal(timeout.stdout, 'wait: timeout\n');
  successful(await f.command(['send', '--run', b.run, '--text', 'Still readable.']), 'send'); await b.inputs(2);
  const mixed = await f.command(['wait', '--run', 'unavailable', '--run', b.run, '--timeout-ms', '1000']);
  assert.equal(mixed.code, 1); bounded(mixed); assert.match(mixed.stdout, /^wait: changed\n/);
  assert.match(mixed.stdout, /^code: runUnavailable$/m); assert.deepEqual(blocks(mixed.stdout, 'MESSAGE'), ['Still readable.']);
  successful(await f.command(['stop', '--run', b.run]), 'stop');
  const terminal = (await f.waitTerminal(b.run)).find((response) => terminalPattern.test(response.stdout));
  assert.equal(field(terminal.stdout, 'state'), 'cancelled');
  assert.equal((await f.command(['wait', '--run', a.run, '--run', b.run])).stdout, 'wait: settled\n');
});

// Test Value Gate: unsupported capability and an explicit deadline must remain
// independent from the parent wait window and never launch a second backend.
test('unsupported communication rejects send and explicit deadline stops one backend', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const clock = await f.clock(['worker']);
  const deadlineMs = 1200;
  const started = await f.start({ communication: false }, { extra: ['--deadline-ms', String(deadlineMs)], env: clock.environment });
  await f.initialized(started); if (started.code === 0) assert.equal(field(started.stdout, 'communication'), 'false');
  const observed = await started.observed();
  assert.deepEqual(observed.request.execution, { executor: 'fixture' });
  assert.equal(observed.request.run.deadlineAt, clock.origin + deadlineMs);
  await clock.advance(deadlineMs - 1);
  const rejected = await f.command(['send', '--run', started.run, '--text', 'Do not submit.']);
  assert.equal(rejected.code, 1); assert.equal(field(rejected.stdout, 'code'), 'communicationUnsupported');
  assert.equal(field(rejected.stdout, 'state'), 'running');
  assert.equal((await started.observed()).request.run.deadlineAt, clock.origin + deadlineMs);
  await clock.advance(1);
  const terminal = (await f.waitTerminal(started.run)).find((response) => terminalPattern.test(response.stdout));
  assert.equal(field(terminal.stdout, 'state'), 'cancelled');
  assert.equal(field(terminal.stdout, 'remote_stop_confirmed'), 'true');
  assert.throws(() => process.kill(observed.backendPid, 0), { code: 'ESRCH' });
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\n');
});

// Test Value Gate: a completed task must retain unknown input delivery in its fixed
// result even after a parent has consumed the corresponding process notification.
test('completed result preserves unresolved input delivery without replaying notifications', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const started = await f.start({ delivery: 'unknown' });
  await f.initialized(started);
  const input = '  追加检查。\r\nDo not retry automatically.\n';
  successful(await f.command(['send', '--run', started.run, '--text', '-'], { stdin: Buffer.from(input) }), 'send');
  await started.inputs(1);
  const notification = await f.command(['wait', '--run', started.run, '--timeout-ms', '1000']);
  successful(notification, 'wait');
  assert.equal(field(notification.stdout, 'delivery'), 'unknown');
  assert.deepEqual(blocks(notification.stdout, 'INPUT'), [input]);
  await started.finish(); await f.waitTerminal(started.run);
  for (let index = 0; index < 2; index++) {
    const result = await f.command(['result', '--run', started.run]);
    successful(result, 'result');
    assert.equal(field(result.stdout, 'state'), 'completed'); assert.equal(field(result.stdout, 'delivery_gaps'), '1');
    assert.equal(field(result.stdout, 'delivery'), 'unknown'); assert.deepEqual(blocks(result.stdout, 'INPUT'), [input]);
    assert.ok(result.stdout.indexOf('BEGIN_INPUT:') < result.stdout.indexOf('BEGIN_FINAL:'));
  }
  assert.equal((await started.inputs(1)).length, 1);
});

// Test Value Gate: the installed CLI must map syntax and stdin rejection to exit
// 2 without starting a generation, scanning runs or creating an output path.
test('installed CLI rejects invalid arguments and stdin before side effects', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  for (const args of [['run'], ['result', '--run', 'handle', '--output-file', 'must-not-exist']]) {
    assert.equal((await f.command(args)).code, 2);
  }
  for (const [args, code] of [
    [['--profile', 'advisorProfile'], 'argumentsInvalid'],
    [['--executor', 'native'], 'nativeUnsupported'],
    [['--executor', 'missing'], 'executorUnknown'],
    [['--executor', 'Fixture'], 'executorUnknown'],
    [['--executor', 'fixture', '--executor', 'fixture'], 'argumentsInvalid'],
  ]) {
    const rejected = await f.command(['start', ...args, '--prompt', 'must not start']);
    assert.equal(rejected.code, 2); assert.equal(field(rejected.stderr, 'code'), code);
  }
  const entry = f.snapshot.effectiveValues.subagentCommands[0];
  for (const [registry, code] of [
    [[entry, { ...entry }], 'registryInvalid'],
    [[{ ...entry, title: 'Legacy title' }], 'executorInvalid'],
    [[{ ...entry, key: 'native' }, entry], 'registryInvalid'],
  ]) {
    f.snapshot.effectiveValues.subagentCommands = registry; await f.save();
    const rejected = await f.command(['start', '--executor', 'fixture', '--prompt', 'must not start']);
    assert.equal(rejected.code, 2); assert.equal(field(rejected.stderr, 'code'), code);
  }
  f.snapshot.effectiveValues.subagentCommands = [entry]; await f.save();
  const prompt = await f.command(['start', '--executor', 'fixture', '--workspace', f.workspace, '--prompt', '-'], { stdin: Buffer.from([0xff]) });
  assert.equal(prompt.code, 2);
  const message = await f.command(['send', '--run', 'handle', '--text', '-'], { stdin: Buffer.from(' \r\n') });
  assert.equal(message.code, 2);
  assert.equal((await f.command(['--help'])).code, 0);
  assert.equal(await fs.stat(f.generations).catch(() => null), null); assert.deepEqual(await fs.readdir(f.temporaryRoot), []);
  assert.equal(await fs.stat(path.join(f.workspace, 'must-not-exist')).catch(() => null), null);
});

// Test Value Gate: installed configuration must carry explicit false through
// plan, runner, worker and wire while public send and lifecycle remain correct.
test('installed communication false rejects send and preserves result and stop', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  f.snapshot.effectiveValues.subagentCommands[0].communication = false; await f.save();
  const started = await f.start(); await f.initialized(started);
  assert.equal((await started.observed()).request.communication, false);
  const ready = started.code === 0 ? started : await f.command(['wait', '--run', started.run, '--timeout-ms', '0']);
  assert.equal(field(ready.stdout, 'communication'), 'false');
  assert.equal(field(ready.stdout, 'communication_status'), 'disabled');
  assert.equal(field(ready.stdout, 'communication_transport'), undefined);
  const rejected = await f.command(['send', '--run', started.run, '--text', 'Do not submit.']);
  assert.equal(rejected.code, 1); assert.equal(field(rejected.stdout, 'code'), 'communicationUnsupported');
  await started.finish(); await f.waitTerminal(started.run);
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result'); assert.deepEqual(blocks(result.stdout, 'FINAL'), ['Complete final answer.']);
  successful(await f.command(['stop', '--run', started.run]), 'stop');
});

// Test Value Gate: a send-only question must not keep a completed turn alive
// while the parent has supplied no answer or accepted additional input.
test('a question without active receive closes with its unresolved final result', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const finalText = 'Unfinished: the required parent answer is not available.';
  const started = await f.start({ descriptor: { status: 'enabled', transport: 'command', passiveDelivery: 'turn-boundary', activeReceive: false }, messages: ['Which target is required?'], finishImmediately: true, finalText });
  await f.initialized(started); const terminal = await f.waitTerminal(started.run);
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result'); assert.equal(field(result.stdout, 'state'), 'completed');
  assert.deepEqual([...terminal, result].flatMap((response) => blocks(response.stdout, 'MESSAGE')), ['Which target is required?']);
  assert.deepEqual(blocks(result.stdout, 'FINAL'), [finalText]);
  const send = await f.command(['send', '--run', started.run, '--text', 'A late answer.']);
  assert.equal(send.code, 1); assert.equal(field(send.stdout, 'code'), 'runClosed');
});
