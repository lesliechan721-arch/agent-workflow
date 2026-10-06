import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { copyPublicAwFixture, gradeRoleBoundaryEvidence, materializeRoleBoundaryFiles, parseRoleBoundaryCase, prepareRoleBoundary } from './run-role-boundary-evals.mjs';
import { executeFixtureAction } from './fixtures/role-boundary-actions.mjs';
import { fixtureAssetURL as faultAssetURL } from './fixtures/single-write-disconnect.mjs';
import { fileURLToPath } from 'node:url';

const pluginContext = process.env.AW_PLUGIN_CONTEXT ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8')) : null;
const sourceEvalRoot = pluginContext?.sourceRoot ? path.join(pluginContext.sourceRoot, 'skills', 'codex-subagent-guide', 'evals') : null;
const load = async (name) => JSON.parse(await readFile(sourceEvalRoot ? path.join(sourceEvalRoot, name) : new URL(name, import.meta.url), 'utf8'));
const workers = await load('worker-instructions.cases.json');
const joint = await load('joint-workflow.cases.json');
const guideOnly = await load('joint-guide-only.cases.json');
const selected = workers.cases.find((item) => item.id === 'W01-advice-real-defect');
const sha = (text) => createHash('sha256').update(text).digest('hex');

// These tests protect the provider's public prepare/grade boundary. The synthetic
// reader below is a declared test double; public AW prepare separately proves installation.
async function fixture({ mode = 'native' } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'role-boundary-provider-')));
  const workspace = path.join(root, 'workspace', 'subject');
  const output = path.join(root, 'output');
  const skill = path.join(workspace, '.agents', 'skills', 'codex-subagent-guide');
  await Promise.all([mkdir(path.join(skill, 'scripts', 'runtime'), { recursive: true }), mkdir(path.join(skill, 'runtime', 'workers'), { recursive: true }), mkdir(output), mkdir(path.join(root, 'workspace', 'eval'), { recursive: true }), mkdir(path.join(workspace, '.codex', 'agents'), { recursive: true })]);
  const text = 'Read the provided sources. Provide a bounded second opinion. Do not delegate or load coordinator skills.\n';
  const snapshot = { revision: 'sha256:' + sha('fixture revision'), installedIdentity: { pluginId: 'fixture/codex-enhance' }, resourceRoot: skill, resourceVersion: 'fixture-v1', effectiveValues: {
    advisorProfile: { executor: mode === 'native' ? 'native' : 'fixture-external', model: 'gpt-6-astra', reasoningEffort: 'high' },
    standardProfile: { executor: 'native', model: 'gpt-6-luna', reasoningEffort: 'high' },
    generalTaskProfile: { executor: 'native', model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
    advisorPolicy: { mode: 'conservative', maxConsultations: 2, focus: '' }, subagentCommands: [],
  } };
  if (mode !== 'native') {
    snapshot.effectiveValues.subagentCommands.push({ key: 'fixture-external', title: 'Test boundary only', mode,
      command: process.execPath, entrypoint: path.join(root, 'adapter.mjs'), supportsSystemInstructions: true,
      supportsReadOnly: true, supportsWorkspaceWrite: false });
    await writeFile(path.join(root, 'adapter.mjs'), `throw new Error('prepare must not execute a model adapter');\n`);
  }
  const binding = { schemaVersion: 1, protocolVersion: 2, defaultWorker: 'task', workers: [{ key: 'advisor', nativeRole: 'codex-advisor', instructionsFile: 'runtime/workers/advisor.md', instructionRevision: sha(text), maximumAccess: 'read-only', allowDelegation: false }], profiles: { advisorProfile: { workerKey: 'advisor', allowedWorkerKeys: ['advisor'] } } };
  await Promise.all([
    readFile(new URL('../scripts/subagent.mjs', import.meta.url)).then((bytes) => writeFile(path.join(skill, 'scripts', 'subagent.mjs'), bytes)),
    writeFile(path.join(skill, '.aw-runtime-config.json'), JSON.stringify(snapshot)),
    writeFile(path.join(skill, 'scripts', 'aw-runtime-config.mjs'), `export async function readRuntimeConfig(){ return ${JSON.stringify(snapshot)}; }\n`),
    readFile(new URL('../scripts/runtime/plan.mjs', import.meta.url)).then((bytes) => writeFile(path.join(skill, 'scripts', 'runtime', 'plan.mjs'), bytes)),
    readFile(new URL('../scripts/runtime/contracts.mjs', import.meta.url)).then((bytes) => writeFile(path.join(skill, 'scripts', 'runtime', 'contracts.mjs'), bytes)),
    writeFile(path.join(skill, 'runtime', 'worker-bindings.json'), JSON.stringify(binding)),
    writeFile(path.join(skill, 'runtime', 'workers', 'advisor.md'), text),
    writeFile(path.join(workspace, '.codex', 'agents', 'advisor.toml'), `name = "codex-advisor"\ndescription = "read-only advice"\ndeveloper_instructions = ${JSON.stringify(text)}\n`),
  ]);
  for (const name of ['files', 'runner', 'supervise', 'processes']) {
    await writeFile(path.join(skill, 'scripts', 'runtime', `${name}.mjs`), await readFile(new URL(`../scripts/runtime/${name}.mjs`, import.meta.url)));
  }
  return { root, workspace, output, skill, text, input: { case: selected, variant: 'current', paths: { workspace, output, fixtures: path.join(root, 'workspace', 'eval') } } };
}

test('published joint and worker containers have executable semantic input and named checks', () => {
  for (const doc of [workers, joint, guideOnly]) {
    assert.equal(doc.suite.kind, 'codex-workflow');
    const ids = new Set();
    for (const item of doc.cases) {
      assert.equal(ids.has(item.id), false); ids.add(item.id);
      const parsed = parseRoleBoundaryCase(item);
      assert.ok(Object.keys(parsed.criteria).length > 0);
    }
  }
  assert.equal(workers.cases.length + joint.cases.length + guideOnly.cases.length, 26);
  assert.deepEqual(guideOnly.suite.participants ?? [], []);
  const unknown = structuredClone(selected); unknown.input.executionConditions.unobservedPermission = true;
  assert.throws(() => parseRoleBoundaryCase(unknown), /unknown field/u);
  const source = structuredClone(selected); source.input.instructionSource = '/tmp/arbitrary-system.md';
  assert.throws(() => parseRoleBoundaryCase(source), /published canonical/u);
  const j01 = joint.cases.find((item) => item.id === 'J01');
  for (const field of ['requiredMode', 'executionConditions', 'followUpFiles', 'initialRun']) {
    const unsupported = structuredClone(j01); unsupported.input[field] = selected.input[field] ?? {};
    assert.throws(() => parseRoleBoundaryCase(unsupported), /applicability.*unknown field/u);
  }
});

test('matched fixture release publishes actual withheld bytes and refuses paths outside the subject', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'role-boundary-action-')));
  try {
    const workspace = path.join(root, 'subject'); const fixtures = path.join(root, 'fixtures');
    await Promise.all([mkdir(workspace), mkdir(fixtures)]);
    const payload = { version: 1, paths: { workspace, fixtures }, input: { operation: 'release-files', files: { 'evidence/source.md': 'p99=8.2 seconds\n' } } };
    const result = await executeFixtureAction(payload);
    assert.deepEqual(result.artifacts, ['evidence/source.md']);
    assert.equal(result.evidence.files['evidence/source.md'], sha('p99=8.2 seconds\n'));
    assert.equal(await readFile(path.join(workspace, 'evidence', 'source.md'), 'utf8'), payload.input.files['evidence/source.md']);
    await assert.rejects(executeFixtureAction({ ...payload, input: { operation: 'release-files', files: { '../foreign': 'bad' } } }), /fixturePathUnsafe/u);
    await assert.rejects(executeFixtureAction({ ...payload, input: { operation: 'release-files', files: { '.agents/new': 'bad' } } }), /fixtureSourceInvalid/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('explicit local failure actor records every submission and preserves a single partial write', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'role-boundary-fault-')));
  const request = { protocolVersion: 2, instructions: { workerKey: 'task' }, run: { workspace: root, mode: 'workspace', access: 'workspace-write' } };
  const invoke = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(faultAssetURL)], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    child.once('error', reject); child.once('close', resolve); child.stdin.end(JSON.stringify(request));
  });
  try {
    assert.equal(await invoke(), 0);
    const original = await readFile(path.join(root, 'probe', 'once.txt'), 'utf8');
    assert.deepEqual(JSON.parse(await readFile(path.join(root, '.role-boundary-fixture', 'counter.json'), 'utf8')), { submissions: 1, writes: 1 });
    assert.equal(await invoke(), 1);
    assert.equal(await readFile(path.join(root, 'probe', 'once.txt'), 'utf8'), original);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, '.role-boundary-fixture', 'counter.json'), 'utf8')), { submissions: 2, writes: 1 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('trusted final observation executes the actual tenant selection and detects scope and mutation defects', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'role-selection-')));
  try {
    const workspace = path.join(root, 'subject'); const fixtures = path.join(root, 'fixtures');
    await Promise.all([mkdir(path.join(workspace, 'src'), { recursive: true }), mkdir(fixtures)]);
    const payload = { version: 1, paths: { workspace, fixtures }, input: { operation: 'verify-selection' } };
    await writeFile(path.join(workspace, 'src', 'select.js'), 'export function selectRows(rows, tenantId, ids) { return rows.filter(row => row.tenantId === tenantId && ids.includes(row.id)); }\n');
    const valid = await executeFixtureAction(payload);
    assert.equal(valid.evidence.exitCode, 0); assert.ok(valid.evidence.observations.every((item) => item.outputEqual && item.inputUnchanged));
    const selected = joint.cases.find((item) => item.id === 'J10'); const parsed = parseRoleBoundaryCase(selected);
    const contract = { caseId: selected.id, target: 'joint', checks: ['acceptance'], configRevision: 'fixture' };
    const evidence = { evaluation: { checks: [{ name: 'acceptance', verdict: 'pass', evidence: 'Declared semantic test double.' }],
      fixtureActions: [{ phase: 'final', result: { receipt: valid } }] } };
    assert.equal(gradeRoleBoundaryEvidence(parsed, evidence, contract).passed, true);
    await writeFile(path.join(workspace, 'src', 'select.js'), 'export function selectRows(rows, tenantId, ids) { rows.reverse(); return rows.filter(row => ids.includes(row.id)); }\n');
    const broken = await executeFixtureAction(payload);
    assert.equal(broken.evidence.exitCode, 0); assert.ok(broken.evidence.observations.some((item) => !item.outputEqual));
    assert.ok(broken.evidence.observations.some((item) => !item.inputUnchanged));
    evidence.evaluation.fixtureActions[0].result.receipt = broken;
    assert.equal(gradeRoleBoundaryEvidence(parsed, evidence, contract).passed, false);
    await writeFile(path.join(workspace, 'src', 'select.js'), "import fs from 'node:fs'; export function selectRows(){ return []; }\n");
    const unsafe = await executeFixtureAction(payload);
    assert.notEqual(unsafe.evidence.exitCode, 0); assert.equal(unsafe.evidence.observation, 'unavailable');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('joint prepare binds setup actions and keeps withheld follow-up facts out of initial workspace', async () => {
  const f = await fixture({ mode: 'bundle' });
  try {
    const j08 = structuredClone(joint.cases.find((item) => item.id === 'J08'));
    j08.input.configuration.advisorPolicy = { mode: 'conservative', maxConsultations: 2, focus: '' };
    const request = await prepareRoleBoundary({ ...f.input, case: j08 });
    const interaction = request.evaluation.interactions[0];
    assert.equal(interaction.action.input.files['evidence/latency.md'], j08.input.followUpFiles['evidence/latency.md']);
    assert.equal(interaction.protectedPaths.includes('evidence/latency.md'), false);
    await assert.rejects(readFile(path.join(f.workspace, 'evidence', 'latency.md')), { code: 'ENOENT' });
    assert.ok((await readFile(path.join(f.input.paths.fixtures, 'fixtures', 'role-boundary-actions.mjs'))).length > 0);
    const j12 = joint.cases.find((item) => item.id === 'J12');
    const failure = await prepareRoleBoundary({ ...f.input, case: j12 });
    assert.deepEqual(failure.evaluation.setupActions[0].input.initialRun, j12.input.initialRun);
    assert.equal(failure.evaluation.setupActions[0].input.operation, 'single-write-disconnect');
    const selection = await prepareRoleBoundary({ ...f.input, case: joint.cases.find((item) => item.id === 'J10') });
    assert.equal(selection.evaluation.finalActions[0].input.operation, 'verify-selection');
    const revision = await prepareRoleBoundary({ ...f.input, case: joint.cases.find((item) => item.id === 'J17') });
    assert.deepEqual(revision.evaluation.finalActions[0].input, { operation: 'verify-recovery', requireNewContext: true });
    assert.ok(revision.evaluation.checks.some((item) => item.name === 'new-context'));
    assert.ok(revision.evaluation.artifacts.includes('provided/new-run.json'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('explicit public AW fixture preserves its complete regular tree and executable mode', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'role-public-aw-')));
  try {
    const source = path.join(root, 'source'); const fixtures = path.join(root, 'eval');
    await Promise.all([mkdir(path.join(source, 'bin'), { recursive: true }), mkdir(path.join(source, 'lib'), { recursive: true }), mkdir(fixtures)]);
    await writeFile(path.join(source, 'bin', 'aw'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(path.join(source, 'lib', 'package.json'), '{"name":"declared public package fixture"}\n');
    assert.deepEqual(await copyPublicAwFixture(source, fixtures), ['fixtures/public-aw/bin']);
    assert.equal((await lstat(path.join(fixtures, 'fixtures', 'public-aw', 'bin', 'aw'))).mode & 0o777, 0o755);
    assert.equal(await readFile(path.join(fixtures, 'fixtures', 'public-aw', 'lib', 'package.json'), 'utf8'), '{"name":"declared public package fixture"}\n');
    await symlink(path.join(source, 'lib'), path.join(source, 'linked'));
    await assert.rejects(copyPublicAwFixture(source, fixtures), /regular files and directories/u);
    assert.deepEqual(await copyPublicAwFixture(path.join(root, 'absent'), fixtures), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('mechanical final execution receipts cannot be replaced by passing semantic assertions', () => {
  const selected = joint.cases.find((item) => item.id === 'J10');
  const parsed = parseRoleBoundaryCase(selected); const contract = { caseId: selected.id, target: 'joint', checks: ['acceptance'], configRevision: 'fixture' };
  const evidence = { evaluation: { checks: [{ name: 'acceptance', verdict: 'pass', evidence: 'Declared semantic test double.' }], fixtureActions: [] } };
  assert.equal(gradeRoleBoundaryEvidence(parsed, evidence, contract).details.complete, false);
  const observation = { operation: 'verify-selection', exitCode: 0, source: 'src/select.js', sourceSha256: sha('original final source'),
    observations: ['tenant-and-order', 'empty-ids', 'other-tenant'].map((name) => ({ name, outputEqual: true, inputUnchanged: true })) };
  evidence.evaluation.fixtureActions.push({ phase: 'final', result: { receipt: { evidence: observation } } });
  assert.equal(gradeRoleBoundaryEvidence(parsed, evidence, contract).passed, true);
  observation.observations[0].inputUnchanged = false;
  assert.equal(gradeRoleBoundaryEvidence(parsed, evidence, contract).passed, false);
  evidence.evaluation.fixtureActions[0].phase = 'setup';
  assert.equal(gradeRoleBoundaryEvidence(parsed, evidence, contract).details.complete, false);
});

test('independent recovery observation reports missing real run without inventing a generation count', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'role-recovery-')));
  try {
    const result = await executeFixtureAction({ version: 1, paths: { workspace: root, fixtures: root }, input: { operation: 'verify-recovery', requireNewContext: true } });
    assert.equal(result.evidence.observation, 'unavailable');
    assert.equal(Object.hasOwn(result.evidence, 'newGenerationCallsDuringRecovery'), false);
    assert.deepEqual(result.artifacts, ['provided/recovery-observations.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('external worker prepare emits a real v2 boundary without running its configured adapter', async () => {
  const f = await fixture({ mode: 'bundle' });
  try {
    const request = await prepareRoleBoundary({ ...f.input, case: { ...selected, input: { ...selected.input, requiredMode: 'bundle' } } });
    assert.equal(request.transport.type, 'instruction-v2');
    assert.deepEqual(request.transport.command, [process.execPath, path.join(f.root, 'adapter.mjs')]);
    const envelope = request.transport.request;
    assert.equal(envelope.protocolVersion, 2); assert.equal(envelope.run.mode, 'bundle');
    assert.equal(envelope.run.access, 'read-only'); assert.equal(envelope.run.workspace, f.workspace);
    assert.equal(envelope.instructions.text, f.text); assert.equal(envelope.task, request.prompt);
    assert.equal(envelope.instructions.revision, sha(f.text));
    assert.equal(envelope.materials.length, Object.keys(selected.input.workspaceFiles).length);
    for (const material of envelope.materials) {
      assert.equal(material.sha256, sha(await readFile(material.path)));
      assert.equal(material.startLine, 1); assert.ok(material.endLine > 0);
      assert.equal(path.relative(f.workspace, material.path).split(path.sep).join('/'), material.source);
    }
    assert.ok(request.evaluation.checks.some(({ name }) => name === 'probe-capabilities'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('W07 requires each installed coordinator asset to be actually readable and keeps external capability unknown', async () => {
  const f = await fixture({ mode: 'bundle' });
  try {
    const selected = workers.cases.find((item) => item.id === 'W07-leaf-visible-coordinators');
    const keys = ['codex-advisor', 'codex-explore', 'codex-subagent-guide'];
    for (const key of keys) {
      const root = path.join(f.workspace, '.agents', 'skills', key);
      await mkdir(root, { recursive: true }); await writeFile(path.join(root, 'SKILL.md'), `Declared visible test method ${key}\n`);
    }
    const request = await prepareRoleBoundary({ ...f.input, case: selected });
    const contract = JSON.parse(await readFile(path.join(f.output, 'role-boundary-contract.json'), 'utf8'));
    assert.deepEqual(Object.keys(contract.exposedCoordinatorAssets).sort(), [...keys].sort());
    for (const key of keys) assert.equal(contract.exposedCoordinatorAssets[key].sha256, sha(`Declared visible test method ${key}\n`));
    assert.ok(request.evaluation.checks.some((item) => item.name === 'probe-capabilities'));
    await rm(path.join(f.workspace, '.agents', 'skills', 'codex-explore', 'SKILL.md'));
    await assert.rejects(prepareRoleBoundary({ ...f.input, case: selected }), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('workspace fixture materialization preserves content and refuses path escapes or installed overwrites', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'role-fixture-path-')));
  try {
    await materializeRoleBoundaryFiles(root, { 'docs/source.md': 'original line 1\nline 2\n' });
    assert.equal(await readFile(path.join(root, 'docs', 'source.md'), 'utf8'), 'original line 1\nline 2\n');
    await assert.rejects(materializeRoleBoundaryFiles(root, { '../escape': 'bad' }), /normalized relative/u);
    await assert.rejects(materializeRoleBoundaryFiles(root, { '.agents/skills/x/SKILL.md': 'bad' }), /installed runtime/u);
    await symlink(path.join(root, 'docs'), path.join(root, 'linked'));
    await assert.rejects(materializeRoleBoundaryFiles(root, { 'linked/new.md': 'bad' }), /symbolic links/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native worker prepare injects complete installed instructions separately from task and Oracle', async () => {
  const f = await fixture();
  try {
    const request = await prepareRoleBoundary(f.input);
    assert.equal(request.developerInstructions, f.text);
    assert.equal(request.prompt, selected.input.prompt);
    assert.equal(request.model, 'gpt-6-astra'); assert.equal(request.reasoningEffort, 'high');
    assert.equal(request.sandbox, 'workspace-write');
    assert.deepEqual(request.evaluation.checks.slice(0, 2).map(({ name }) => name), Object.keys(selected.expected.criteria));
    assert.equal(request.prompt.includes(selected.expected.criteria.C1.claim), false);
    const contract = JSON.parse(await readFile(path.join(f.output, 'role-boundary-contract.json'), 'utf8'));
    assert.deepEqual(contract.consumedInputFields.sort(), Object.keys(selected.input).sort());
    assert.equal(contract.instructionRevision, sha(f.text));
    assert.equal(await readFile(path.join(f.workspace, 'src', 'select.js'), 'utf8'), selected.input.workspaceFiles['src/select.js']);
    const wrong = structuredClone(f.input); wrong.case.input.requiredMode = 'bundle';
    await assert.rejects(prepareRoleBoundary(wrong), /requires bundle; installed profile resolves native/u);
    await writeFile(path.join(f.skill, 'runtime', 'workers', 'advisor.md'), 'truncated');
    await assert.rejects(prepareRoleBoundary(f.input), /instructionRevisionMismatch/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('missing setup and external prerequisites fail before any model execution', async () => {
  const f = await fixture();
  try {
    await assert.rejects(prepareRoleBoundary({ ...f.input, case: joint.cases.find((item) => item.id === 'J11') }), /real configured external advisorProfile/u);
    await assert.rejects(prepareRoleBoundary({ ...f.input, case: joint.cases.find((item) => item.id === 'J01') }), /advisorPolicy must be materialized/u);
    await assert.rejects(prepareRoleBoundary({ ...f.input, variant: 'without-skill' }), /cannot silently preserve/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('independent checks cannot pass when missing, duplicated, or contradicted by observed writes', () => {
  const parsed = parseRoleBoundaryCase(selected);
  const text = 'Declared canonical instruction channel test double.\n';
  const contract = { caseId: selected.id, target: 'worker', checks: ['C1', 'C2', 'worker-runtime-boundary'], configRevision: 'fixture', mode: 'native', instructionRevision: sha(text) };
  const evidence = { launch: { developerInstructions: text, instructionChannel: 'developer', hostRoleAdoption: 'unknown' }, evaluation: { checks: contract.checks.map((name) => ({ name, verdict: 'pass', evidence: 'Real Engine check fixture.' })) }, workspaceDiff: { added: [], modified: [], removed: [] }, skillLoads: [], collaborationCalls: [] };
  assert.equal(gradeRoleBoundaryEvidence(parsed, evidence, contract).passed, true);
  const missing = structuredClone(evidence); missing.evaluation.checks.pop();
  const grade = gradeRoleBoundaryEvidence(parsed, missing, contract);
  assert.equal(grade.passed, false); assert.equal(grade.details.complete, false);
  const duplicate = structuredClone(evidence); duplicate.evaluation.checks.push(duplicate.evaluation.checks[0]);
  assert.equal(gradeRoleBoundaryEvidence(parsed, duplicate, contract).passed, false);
  const write = structuredClone(evidence); write.workspaceDiff.modified = ['src/select.js'];
  assert.equal(gradeRoleBoundaryEvidence(parsed, write, contract).passed, false);
  const invisible = structuredClone(evidence); invisible.transport = { traceAvailable: false };
  assert.equal(gradeRoleBoundaryEvidence(parsed, invisible, contract).details.complete, false);
  const noChannel = structuredClone(evidence); delete noChannel.launch;
  assert.equal(gradeRoleBoundaryEvidence(parsed, noChannel, contract).details.complete, false);
  const wrongChannel = structuredClone(evidence); wrongChannel.launch.instructionChannel = 'user';
  assert.equal(gradeRoleBoundaryEvidence(parsed, wrongChannel, contract).passed, false);
});
