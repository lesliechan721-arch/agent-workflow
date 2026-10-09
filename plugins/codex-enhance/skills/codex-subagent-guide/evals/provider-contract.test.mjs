import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const evalRoot = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const pluginContext = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceEvalRoot = pluginContext?.sourceRoot
  ? path.join(pluginContext.sourceRoot, 'skills', 'codex-subagent-guide', 'evals')
  : evalRoot;
const roles = [
  'codex-subagent',
];

async function invoke(runner, input, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(evalRoot, runner)], {
      cwd: path.dirname(input.paths.output), env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function writeWorkspace(root) {
  const roleRoot = path.join(root, '.codex', 'agents');
  const skillRoot = path.join(root, '.agents', 'skills', 'codex-subagent-guide');
  await Promise.all([mkdir(roleRoot, { recursive: true }), mkdir(skillRoot, { recursive: true })]);
  await writeFile(path.join(skillRoot, 'SKILL.md'), '# Codex Subagent Guide\n');
  await Promise.all(roles.map((name) => writeFile(
    path.join(roleRoot, `${name}.toml`),
    `name = ${JSON.stringify(name)}\ndescription = ${JSON.stringify(`${name} role`)}\ndeveloper_instructions = "Do the task."\n`,
  )));
}

function adapterInput(phase, selectedCase, root) {
  const output = path.join(root, 'output');
  return {
    version: 1, phase, case: selectedCase, variant: 'current', attempt: 1,
    paths: {
      workspace: path.join(root, 'workspace', 'subject'),
      fixtures: path.join(root, 'workspace', 'eval'),
      output,
      ...(phase === 'grade' ? {
        evidence: path.join(output, 'workflow-evidence.json'),
        modelOutput: path.join(output, 'model-output.txt'),
      } : {}),
    },
  };
}

function evidence(calls) {
  return {
    version: 1,
    rootThreadId: 'root',
    completion: { status: 'completed', turnStatus: 'completed', durationMs: 80_000 },
    termination: { reason: 'completed', appServerProcessTreeCleanupConfirmed: true },
    usage: { inputTokens: 10, outputTokens: 5 },
    finalMessage: 'done',
    workspaceDiff: { added: [], removed: [], modified: [] },
    skillLoads: [{ threadId: 'root', skill: 'codex-subagent-guide', callId: 'load' }],
    threadGraph: [{
      threadId: 'root', parentThreadId: null, agentRole: null,
      initialMessage: { kind: 'plaintext', text: 'root' },
      developerContext: {
        present: true, messageCount: 1, sha256: 'sha256:root',
        hasMultiAgentModeGate: true, hasNestedAgentCapability: true,
        hasCodexExploreDeveloperAuthorization: false,
      },
    }],
    collaborationCalls: calls.map((call, index) => ({
      ordinal: index + 1, threadId: 'root', parentThreadId: null,
      callId: `call-${index + 1}`, namespace: 'collaboration', status: 'completed', ...call,
    })),
    leafCalls: [],
    cleanup: { isolatedCodexHomeRemoved: true },
  };
}

function v1RoutingEvidence() {
  const spawn = {
    ordinal: 1, threadId: 'root', parentThreadId: null,
    callId: 'spawn-simple', namespace: 'collaboration', tool: 'spawn_agent', status: 'completed',
    arguments: {
      agent_type: 'codex-subagent', message: 'work', fork_context: false,
      model: 'gpt-6-luna', reasoning_effort: 'max',
    },
    output: { agent_id: 'child', status: 'running' },
  };
  return {
    version: 1,
    rootThreadId: 'root',
    completion: { status: 'completed', turnStatus: 'completed', durationMs: 50 },
    termination: { reason: 'completed', appServerProcessTreeCleanupConfirmed: true },
    usage: { inputTokens: 10, outputTokens: 5 },
    finalMessage: 'done',
    workspaceDiff: { added: [], removed: [], modified: [] },
    skillLoads: [{ threadId: 'root', skill: 'codex-subagent-guide', callId: 'load' }],
    threadGraph: [{
      threadId: 'root', parentThreadId: null, agentRole: null,
      initialMessage: { kind: 'plaintext', text: 'root' },
      developerContext: {
        present: true, messageCount: 1, sha256: 'sha256:root',
        hasMultiAgentModeGate: false, hasNestedAgentCapability: false,
        hasCodexExploreDeveloperAuthorization: false,
      },
    }, {
      threadId: 'child', parentThreadId: 'root',
      agentRole: 'codex-subagent',
      initialMessage: { kind: 'plaintext', text: 'work' },
      developerContext: {
        present: true, messageCount: 1, sha256: 'sha256:child',
        hasMultiAgentModeGate: false, hasNestedAgentCapability: false,
        hasCodexExploreDeveloperAuthorization: false,
      },
    }],
    collaborationCalls: [spawn],
    leafCalls: [],
    cleanup: { isolatedCodexHomeRemoved: true },
  };
}

test('all Subagent Guide commands prepare bounded requests without starting Codex', async () => {
  const manifest = JSON.parse(await readFile(path.join(evalRoot, 'manifest.json'), 'utf8'));
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'subagent-workflow-adapter-')));
  const trap = path.join(root, 'trap');
  const marker = path.join(root, 'codex-started');
  try {
    await Promise.all([
      writeWorkspace(path.join(root, 'workspace', 'subject')),
      mkdir(path.join(root, 'workspace', 'eval'), { recursive: true }),
      mkdir(path.join(root, 'output')),
      mkdir(trap),
    ]);
    const codex = path.join(trap, 'codex');
    await writeFile(codex, `#!/bin/sh\necho started > ${JSON.stringify(marker)}\n`);
    await chmod(codex, 0o755);
    const env = { PATH: `${trap}${path.delimiter}${process.env.PATH ?? ''}` };
    for (const suite of manifest.suites.filter((entry) => ['routing', 'lifecycle', 'lifecycle-timeout'].includes(entry.id))) {
      const document = JSON.parse(await readFile(path.join(sourceEvalRoot, suite.cases), 'utf8'));
      const result = await invoke(suite.provider.command[1], adapterInput('prepare', document.cases[0], root), env);
      assert.equal(result.code, 0, result.stderr);
      const request = JSON.parse(result.stdout);
      assert.equal(request.model, null);
      assert.equal(request.roles.every((role) => !path.isAbsolute(role.configFile)), true);
      assert.deepEqual(request.multiAgent, {
        protocol: suite.id === 'routing' && document.cases[0].input.runtimeProfile === 'v1' ? 'v1' : 'v2',
        maxDepth: 1,
        hideSpawnAgentMetadata: !(suite.id === 'routing' && document.cases[0].input.runtimeProfile === 'v1'),
        exposeSpawnAgentModelOverrides: !(suite.id === 'routing' && document.cases[0].input.runtimeProfile === 'v1'),
      });
    }
    const routing = JSON.parse(await readFile(path.join(sourceEvalRoot, 'provider-evals.json'), 'utf8'));
    const v2 = routing.cases.find((entry) => entry.id === 'simple_preset_fresh-v2');
    const v2Request = JSON.parse((await invoke(
      'run-routing-evals.mjs',
      adapterInput('prepare', v2, root),
      env,
    )).stdout);
    assert.equal(v2Request.model, null);
    assert.match(v2Request.prompt, /固定单行最终确认 `ROUTING_SPAWNED`/u);
    await assert.rejects(readFile(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('routing and lifecycle grade normalized evidence and fail closed', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'subagent-workflow-grade-')));
  try {
    await Promise.all([
      writeWorkspace(path.join(root, 'workspace', 'subject')),
      mkdir(path.join(root, 'workspace', 'eval'), { recursive: true }),
      mkdir(path.join(root, 'output')),
    ]);
    const routing = JSON.parse(await readFile(path.join(sourceEvalRoot, 'provider-evals.json'), 'utf8'));
    const selected = routing.cases.find((entry) => entry.id === 'simple_preset_fresh-v2');
    const input = adapterInput('grade', selected, root);
    const spawn = {
      tool: 'spawn_agent',
      linkedThreadId: 'child',
      arguments: {
        agent_type: 'codex-subagent', model: 'gpt-6-luna', reasoning_effort: 'max',
        message: 'work', task_name: 'work', fork_turns: 'none',
      },
      output: { agent_id: 'child', status: 'running' },
    };
    await Promise.all([
      writeFile(input.paths.evidence, JSON.stringify(evidence([spawn]))),
      writeFile(input.paths.modelOutput, 'done\n'),
      writeFile(path.join(root, 'output', 'workflow-trace.json'), '{not-json'),
    ]);
    const passing = await invoke('run-routing-evals.mjs', input);
    assert.equal(passing.code, 0, passing.stderr);
    assert.equal(JSON.parse(passing.stdout).passed, true);
    await writeFile(input.paths.evidence, JSON.stringify(evidence([])));
    assert.equal(JSON.parse((await invoke('run-routing-evals.mjs', input)).stdout).passed, false);

    const lifecycle = JSON.parse(await readFile(path.join(sourceEvalRoot, 'lifecycle-timeout-evals.json'), 'utf8'));
    const lifecycleInput = adapterInput('grade', lifecycle.cases[0], root);
    await writeFile(lifecycleInput.paths.evidence, JSON.stringify(evidence([
      spawn,
      {
        tool: 'wait_agent', linkedThreadId: 'child',
        arguments: { timeout_ms: 60_000, receiver_thread_ids: ['child'] },
        output: { timed_out: true, status: { child: 'running' } },
      },
      {
        tool: 'wait_agent', linkedThreadId: 'child',
        arguments: { timeout_ms: 60_000, receiver_thread_ids: ['child'] },
        output: { status: { child: { completed: 'done' } } },
      },
      {
        tool: 'agent_message', linkedThreadId: 'child', arguments: null,
        output: { messageType: 'FINAL_ANSWER', taskName: '/root', payload: 'done' },
      },
    ])));
    const lifecycleGrade = await invoke('run-lifecycle-evals.mjs', lifecycleInput);
    assert.equal(lifecycleGrade.code, 0, lifecycleGrade.stderr);
    assert.equal(JSON.parse(lifecycleGrade.stdout).passed, true);
    await writeFile(lifecycleInput.paths.evidence, JSON.stringify({ version: 1 }));
    assert.notEqual((await invoke('run-lifecycle-evals.mjs', lifecycleInput)).code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery preparation supplies a helper with observable partial progress and duplicate execution', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'subagent-recovery-')));
  try {
    await Promise.all([
      writeWorkspace(path.join(root, 'workspace', 'subject')),
      mkdir(path.join(root, 'workspace', 'eval'), { recursive: true }),
      mkdir(path.join(root, 'output')),
    ]);
    const corpus = JSON.parse(await readFile(path.join(sourceEvalRoot, 'lifecycle-evals.json'), 'utf8'));
    const selected = corpus.cases.find((entry) => entry.id === 'resume_after_partial_execution');
    const input = adapterInput('prepare', selected, root);
    const prepared = await invoke('run-lifecycle-evals.mjs', input);
    assert.equal(prepared.code, 0, prepared.stderr);
    assert.equal(JSON.parse(prepared.stdout).sandbox, 'workspace-write');
    const helper = path.join(input.paths.workspace, 'scripts/recoverable.mjs');
    const progress = path.join(input.paths.workspace, 'results/progress.json');
    await assert.rejects(execFileAsync(process.execPath, [helper, 'start']), { code: 1 });
    assert.deepEqual(JSON.parse(await readFile(progress, 'utf8')), { applied: 1, finished: false });
    await execFileAsync(process.execPath, [helper, 'finish']);
    assert.deepEqual(JSON.parse(await readFile(progress, 'utf8')), { applied: 1, finished: true });
    await assert.rejects(execFileAsync(process.execPath, [helper, 'start']), { code: 1 });
    await assert.rejects(execFileAsync(process.execPath, [helper, 'finish']), { code: 1 });
    assert.equal(JSON.parse(await readFile(progress, 'utf8')).applied, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Subagent Guide routing consumes canonical V1 Engine evidence', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'subagent-v1-routing-')));
  try {
    await Promise.all([
      writeWorkspace(path.join(root, 'workspace', 'subject')),
      mkdir(path.join(root, 'workspace', 'eval'), { recursive: true }),
      mkdir(path.join(root, 'output')),
    ]);
    const routing = JSON.parse(await readFile(path.join(sourceEvalRoot, 'provider-evals.json'), 'utf8'));
    const selected = routing.cases.find((entry) => entry.id === 'simple_preset_fresh-v1');
    const input = adapterInput('grade', selected, root);
    await Promise.all([
      writeFile(input.paths.evidence, JSON.stringify(v1RoutingEvidence())),
      writeFile(input.paths.modelOutput, 'done\n'),
    ]);
    const result = await invoke('run-routing-evals.mjs', input);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).passed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Subagent Guide adapter rejects attempt path escapes, symlinks, and wrong artifact names', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'subagent-path-fence-')));
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'subagent-path-outside-')));
  try {
    await Promise.all([
      writeWorkspace(path.join(root, 'workspace', 'subject')),
      mkdir(path.join(root, 'workspace', 'eval'), { recursive: true }),
      mkdir(path.join(root, 'output')),
    ]);
    const base = adapterInput('prepare', {}, root);
    const dotDot = structuredClone(base);
    dotDot.paths.workspace = `${root}${path.sep}nested${path.sep}..${path.sep}workspace`;
    assert.notEqual((await invoke('run-routing-evals.mjs', dotDot)).code, 0);
    const external = structuredClone(base);
    external.paths.workspace = outside;
    assert.notEqual((await invoke('run-routing-evals.mjs', external)).code, 0);
    await rm(path.join(root, 'workspace', 'eval'), { recursive: true });
    await symlink(outside, path.join(root, 'workspace', 'eval'));
    assert.notEqual((await invoke('run-routing-evals.mjs', base)).code, 0);
    await rm(path.join(root, 'workspace', 'eval'));
    await mkdir(path.join(root, 'workspace', 'eval'));

    const grade = adapterInput('grade', {}, root);
    await Promise.all([
      writeFile(grade.paths.evidence, '{}'),
      writeFile(grade.paths.modelOutput, 'done\n'),
      writeFile(path.join(root, 'output', 'other-evidence.json'), '{}'),
      writeFile(path.join(root, 'output', 'other-output.txt'), 'done\n'),
    ]);
    const wrongEvidence = structuredClone(grade);
    wrongEvidence.paths.evidence = path.join(root, 'output', 'other-evidence.json');
    assert.notEqual((await invoke('run-routing-evals.mjs', wrongEvidence)).code, 0);
    const wrongOutput = structuredClone(grade);
    wrongOutput.paths.modelOutput = path.join(root, 'output', 'other-output.txt');
    assert.notEqual((await invoke('run-routing-evals.mjs', wrongOutput)).code, 0);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test('Subagent Guide adapters contain no direct Codex or raw-trace path', async () => {
  for (const file of [
    'codex-workflow-adapter.mjs',
    'run-routing-evals.mjs',
    'run-lifecycle-evals.mjs',
  ]) {
    const source = await readFile(path.join(evalRoot, file), 'utf8');
    assert.doesNotMatch(source, /codex\s+exec|node:child_process|workflow-trace\.json|provider-evidence\.json/u);
  }
});
