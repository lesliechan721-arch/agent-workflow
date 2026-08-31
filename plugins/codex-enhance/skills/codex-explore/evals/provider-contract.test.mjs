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
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const evalRoot = path.dirname(fileURLToPath(import.meta.url));
const roles = [
  'codex-explore-custom',
  'codex-explore-deep',
  'codex-explore-quick',
  'codex-explore-standard',
];

async function invoke(runner, input, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(evalRoot, runner)], {
      cwd: path.dirname(input.paths.output),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
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
  const skillRoot = path.join(root, '.agents', 'skills', 'codex-explore');
  await Promise.all([mkdir(roleRoot, { recursive: true }), mkdir(skillRoot, { recursive: true })]);
  await writeFile(path.join(skillRoot, 'SKILL.md'), '# Codex Explore\n');
  await Promise.all(roles.map((name) => writeFile(
    path.join(roleRoot, `${name}.toml`),
    `name = ${JSON.stringify(name)}\ndescription = ${JSON.stringify(`${name} role`)}\ndeveloper_instructions = "Read evidence."\n`,
  )));
}

function adapterInput(phase, selectedCase, root) {
  const output = path.join(root, 'output');
  return {
    version: 1,
    phase,
    case: selectedCase,
    variant: 'current',
    attempt: 1,
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

function evidence(agentType = 'codex-explore-quick') {
  return {
    version: 1,
    rootThreadId: 'root',
    completion: { status: 'completed', turnStatus: 'completed', durationMs: 50 },
    termination: { reason: 'completed', appServerProcessTreeCleanupConfirmed: true },
    usage: { inputTokens: 10, outputTokens: 5 },
    finalMessage: 'done',
    workspaceDiff: { added: [], removed: [], modified: [] },
    skillLoads: [{ threadId: 'root', skill: 'codex-explore', callId: 'load' }],
    threadGraph: [{
      threadId: 'root', parentThreadId: null, agentPath: null, agentRole: null,
      initialMessage: { kind: 'plaintext', text: 'root' },
      developerContext: {
        present: true, messageCount: 1, sha256: 'sha256:root',
        hasMultiAgentModeGate: true, hasNestedAgentCapability: true,
        hasCodexExploreDeveloperAuthorization: false,
      },
    }],
    collaborationCalls: [{
      ordinal: 1, threadId: 'root', parentThreadId: null, callId: 'spawn',
      namespace: 'collaboration', tool: 'spawn_agent',
      arguments: {
        agent_type: agentType, message: 'inspect', task_name: 'inspect', fork_turns: 'none',
      },
      output: { task_name: '/root/inspect' }, status: 'completed',
    }],
    leafCalls: [],
    cleanup: { isolatedCodexHomeRemoved: true },
  };
}

function thread(threadId, parentThreadId, agentRole, initialMessage, developer = {}) {
  return {
    threadId,
    parentThreadId,
    agentPath: parentThreadId ? `/root/${threadId}` : null,
    agentRole,
    initialMessage,
    developerContext: {
      present: true,
      messageCount: 1,
      sha256: `sha256:${threadId}`,
      hasMultiAgentModeGate: false,
      hasNestedAgentCapability: false,
      hasCodexExploreDeveloperAuthorization: false,
      ...developer,
    },
  };
}

function nestedV1Evidence(initialMessage) {
  const rootSpawn = {
    ordinal: 1, threadId: 'root', parentThreadId: null, callId: 'spawn-plan',
    namespace: 'collaboration', tool: 'spawn_agent', status: 'completed',
    arguments: {
      agent_type: 'codex-subagent-advanced', message: initialMessage, fork_context: false,
    },
    output: { agent_id: 'plan', status: 'running' },
  };
  const skillLoad = {
    ordinal: 2, threadId: 'plan', parentThreadId: 'root', callId: 'load-explore',
    namespace: null, tool: 'exec_command', status: 'completed',
    arguments: { cmd: 'sed -n 1,240p .agents/skills/codex-explore/SKILL.md' },
    output: { exitCode: 0 },
  };
  const nestedSpawn = {
    ordinal: 3, threadId: 'plan', parentThreadId: 'root', callId: 'spawn-deep',
    namespace: 'collaboration', tool: 'spawn_agent', status: 'completed',
    arguments: { agent_type: 'codex-explore-deep', message: 'inspect repo' },
    output: { agent_id: 'deep', status: 'running' },
  };
  return {
    version: 1,
    rootThreadId: 'root',
    completion: { status: 'completed', turnStatus: 'completed', durationMs: 50 },
    termination: { reason: 'completed', appServerProcessTreeCleanupConfirmed: true },
    usage: { inputTokens: 10, outputTokens: 5 },
    finalMessage: 'nested delegation observed',
    workspaceDiff: { added: [], removed: [], modified: [] },
    skillLoads: [
      { threadId: 'root', skill: 'codex-subagent-guide', callId: 'load-guide' },
      { threadId: 'plan', skill: 'codex-explore', callId: 'load-explore' },
    ],
    threadGraph: [
      thread('root', null, null, { kind: 'plaintext', text: 'root' }),
      thread('plan', 'root', 'codex-subagent-advanced', { kind: 'plaintext', text: initialMessage }),
      thread('deep', 'plan', 'codex-explore-deep', { kind: 'plaintext', text: 'inspect repo' }),
    ],
    collaborationCalls: [rootSpawn, skillLoad, nestedSpawn],
    leafCalls: [skillLoad, nestedSpawn],
    cleanup: { isolatedCodexHomeRemoved: true },
  };
}

function scopeIsolationEvidence(finalMessage, leafResult) {
  const rootSpawn = {
    ordinal: 1, threadId: 'root', parentThreadId: null, callId: 'spawn',
    namespace: 'multi_agent_v2', tool: 'spawn_agent', status: 'completed',
    arguments: { agent_type: 'codex-explore-quick', message: 'inspect', fork_turns: 'none' },
    output: { agentId: 'child' },
  };
  const rootWait = {
    ordinal: 2, threadId: 'root', parentThreadId: null, callId: 'wait',
    namespace: 'multi_agent_v2', tool: 'wait_agent', status: 'completed',
    arguments: { timeout_ms: 600_000 },
    output: { status: { child: { completed: leafResult } } },
  };
  const leafRg = {
    ordinal: 3, threadId: 'child', parentThreadId: 'root', callId: 'rg',
    namespace: null, tool: 'rg', status: 'completed',
    arguments: { pattern: 'retry|backoff', path: 'docs/output' }, output: { matches: 2 },
  };
  const leafExec = {
    ordinal: 4, threadId: 'child', parentThreadId: 'root', callId: 'exec',
    namespace: null, tool: 'exec_command', status: 'completed',
    arguments: { cmd: 'sed -n 1,20p docs/output/shared-policy.md' }, output: { exitCode: 0 },
  };
  const leafFinal = {
    ordinal: 5, threadId: 'child', parentThreadId: 'root', callId: null,
    namespace: 'collaboration', tool: 'agent_message', status: 'completed', arguments: null,
    output: { messageType: 'FINAL_ANSWER', status: null, taskName: 'child', payload: leafResult },
  };
  return {
    version: 1,
    rootThreadId: 'root',
    completion: { status: 'completed', turnStatus: 'completed', durationMs: 600_001 },
    termination: { reason: 'completed', appServerProcessTreeCleanupConfirmed: true },
    usage: { inputTokens: 10, outputTokens: 5 },
    finalMessage,
    workspaceDiff: { added: [], removed: [], modified: [] },
    skillLoads: [{ threadId: 'root', skill: 'codex-explore', callId: 'load' }],
    threadGraph: [
      thread('root', null, null, { kind: 'plaintext', text: 'root' }),
      thread('child', 'root', 'codex-explore-quick', {
        kind: 'opaque-link', sha256: 'sha256:child', linkedCallId: 'spawn',
      }),
    ],
    collaborationCalls: [rootSpawn, rootWait, leafRg, leafExec, leafFinal],
    leafCalls: [leafRg, leafExec, leafFinal],
    cleanup: { isolatedCodexHomeRemoved: true },
  };
}

test('all Explore workflow commands prepare bounded requests without starting Codex', async () => {
  const manifest = JSON.parse(await readFile(path.join(evalRoot, 'manifest.json'), 'utf8'));
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'explore-workflow-adapter-')));
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
    for (const suite of manifest.suites.filter((entry) => entry.kind === 'codex-workflow')) {
      const document = JSON.parse(await readFile(path.join(evalRoot, suite.cases), 'utf8'));
      const result = await invoke(suite.provider.command[1], adapterInput('prepare', document.cases[0], root), env);
      assert.equal(result.code, 0, result.stderr);
      const request = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(request).sort(), [
        'developerInstructions', 'model', 'multiAgent', 'prompt', 'roles', 'sandbox', 'version',
      ]);
      assert.equal(request.roles.every((role) => !path.isAbsolute(role.configFile)), true);
      assert.equal(request.model === null || suite.provider.allowedModels.includes(request.model), true);
    }
    await assert.rejects(readFile(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Explore grade consumes only normalized evidence and fails closed', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'explore-workflow-grade-')));
  try {
    await Promise.all([
      writeWorkspace(path.join(root, 'workspace', 'subject')),
      mkdir(path.join(root, 'workspace', 'eval'), { recursive: true }),
      mkdir(path.join(root, 'output')),
    ]);
    const document = JSON.parse(await readFile(path.join(evalRoot, 'evals.json'), 'utf8'));
    const selectedCase = document.cases.find((entry) => entry.id === 'auto_quick');
    const input = adapterInput('grade', selectedCase, root);
    await Promise.all([
      writeFile(input.paths.evidence, JSON.stringify(evidence())),
      writeFile(input.paths.modelOutput, 'done\n'),
      writeFile(path.join(root, 'output', 'workflow-trace.json'), '{not-json'),
    ]);
    const passing = await invoke('run-model-selection-evals.mjs', input);
    assert.equal(passing.code, 0, passing.stderr);
    assert.equal(JSON.parse(passing.stdout).passed, true);
    await writeFile(input.paths.evidence, JSON.stringify(evidence('wrong-role')));
    const failing = await invoke('run-model-selection-evals.mjs', input);
    assert.equal(failing.code, 0, failing.stderr);
    assert.equal(JSON.parse(failing.stdout).passed, false);
    await writeFile(input.paths.evidence, JSON.stringify({ version: 1 }));
    assert.notEqual((await invoke('run-model-selection-evals.mjs', input)).code, 0);
    assert.notEqual((await invoke('run-model-selection-evals.mjs', { ...input, phase: 'unknown' })).code, 0);
    assert.notEqual((await invoke('run-model-selection-evals.mjs', { ...input, extra: true })).code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Explore grade consumes canonical V1 nested evidence and rejects authorization uncertainty', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'explore-v1-nested-grade-')));
  try {
    await Promise.all([
      writeWorkspace(path.join(root, 'workspace', 'subject')),
      mkdir(path.join(root, 'workspace', 'eval'), { recursive: true }),
      mkdir(path.join(root, 'output')),
    ]);
    const document = JSON.parse(await readFile(path.join(evalRoot, 'evals.json'), 'utf8'));
    const selectedCase = document.cases.find((entry) => entry.id === 'nested_skill_authorization_v1');
    const initialMessage = selectedCase.expected.criteria.nested_delegation.child_initial_message;
    const input = adapterInput('grade', selectedCase, root);
    const observed = nestedV1Evidence(initialMessage);
    await Promise.all([
      writeFile(input.paths.evidence, JSON.stringify(observed)),
      writeFile(input.paths.modelOutput, 'nested delegation observed\n'),
    ]);
    const passing = await invoke('run-model-selection-evals.mjs', input);
    assert.equal(passing.code, 0, passing.stderr);
    assert.equal(JSON.parse(passing.stdout).passed, true);

    const authorized = structuredClone(observed);
    authorized.threadGraph[1].developerContext.hasCodexExploreDeveloperAuthorization = true;
    await writeFile(input.paths.evidence, JSON.stringify(authorized));
    assert.equal(JSON.parse((await invoke('run-model-selection-evals.mjs', input)).stdout).passed, false);

    const unknown = structuredClone(observed);
    delete unknown.threadGraph[1].developerContext.hasCodexExploreDeveloperAuthorization;
    await writeFile(input.paths.evidence, JSON.stringify(unknown));
    assert.equal(JSON.parse((await invoke('run-model-selection-evals.mjs', input)).stdout).passed, false);

    const incomplete = structuredClone(observed);
    incomplete.leafCalls = incomplete.leafCalls.filter((call) => call.tool !== 'spawn_agent');
    await writeFile(input.paths.evidence, JSON.stringify(incomplete));
    assert.equal(JSON.parse((await invoke('run-model-selection-evals.mjs', input)).stdout).passed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Explore root timeline excludes child investigation while leaf evidence remains gradeable', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'explore-scope-grade-')));
  try {
    await Promise.all([
      writeWorkspace(path.join(root, 'workspace', 'subject')),
      mkdir(path.join(root, 'workspace', 'eval'), { recursive: true }),
      mkdir(path.join(root, 'output')),
    ]);
    const document = JSON.parse(await readFile(path.join(evalRoot, 'output-contract-evals.json'), 'utf8'));
    const selectedCase = document.cases.find((entry) => entry.id === 'shared_source_direct');
    const finalMessage = [
      'docs/output/shared-policy.md:2 retry limit is 3; docs/output/shared-policy.md:3 backoff is 5.',
      'FACT retry_limit=3',
      'FACT backoff_seconds=5',
    ].join('\n');
    const leafResult = [
      'Status: completed',
      '## Findings',
      '- [direct] retry 3 at docs/output/shared-policy.md:2 and backoff 5 at docs/output/shared-policy.md:3 — direct policy.',
    ].join('\n');
    const input = adapterInput('grade', selectedCase, root);
    await Promise.all([
      writeFile(input.paths.evidence, JSON.stringify(scopeIsolationEvidence(finalMessage, leafResult))),
      writeFile(input.paths.modelOutput, `${finalMessage}\n`),
    ]);
    const result = await invoke('run-workflow-evals.mjs', input);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).passed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Explore V2 liveness keeps root waits and grades the child verifier call from leaf evidence', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'explore-liveness-grade-')));
  try {
    await Promise.all([
      writeWorkspace(path.join(root, 'workspace', 'subject')),
      mkdir(path.join(root, 'workspace', 'eval'), { recursive: true }),
      mkdir(path.join(root, 'output')),
    ]);
    const document = JSON.parse(await readFile(path.join(evalRoot, 'liveness-evals.json'), 'utf8'));
    const selectedCase = document.cases.find((entry) => entry.id === 'v2_long_progress');
    const finalMessage = [
      'Verified docs/liveness/records/ with the child verifier.',
      'FACT records=120',
      'FACT timeout_values=30,45,60',
    ].join('\n');
    const observed = scopeIsolationEvidence(finalMessage, 'done');
    observed.completion.durationMs = 65_000;
    observed.threadGraph[1].agentRole = 'codex-explore-standard';
    const spawn = observed.collaborationCalls[0];
    spawn.arguments.agent_type = 'codex-explore-standard';
    const terminalWait = observed.collaborationCalls[1];
    terminalWait.ordinal = 3;
    terminalWait.arguments.timeout_ms = 60_000;
    const timedOutWait = {
      ...structuredClone(terminalWait),
      ordinal: 2,
      callId: 'wait-timeout',
      output: { timed_out: true, status: { child: 'running' } },
    };
    const leafExec = observed.leafCalls.find((call) => call.tool === 'exec_command');
    leafExec.ordinal = 4;
    leafExec.arguments.cmd = 'node docs/liveness/verify-records.mjs';
    observed.collaborationCalls = [spawn, timedOutWait, terminalWait, leafExec];
    observed.leafCalls = [leafExec];
    const input = adapterInput('grade', selectedCase, root);
    await Promise.all([
      writeFile(input.paths.evidence, JSON.stringify(observed)),
      writeFile(input.paths.modelOutput, `${finalMessage}\n`),
    ]);
    const result = await invoke('run-liveness-evals.mjs', input);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).passed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Explore adapter rejects attempt path escapes, symlinks, and wrong artifact names', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'explore-path-fence-')));
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'explore-path-outside-')));
  try {
    await Promise.all([
      writeWorkspace(path.join(root, 'workspace', 'subject')),
      mkdir(path.join(root, 'workspace', 'eval'), { recursive: true }),
      mkdir(path.join(root, 'output')),
    ]);
    const base = adapterInput('prepare', {}, root);
    const dotDot = structuredClone(base);
    dotDot.paths.workspace = `${root}${path.sep}nested${path.sep}..${path.sep}workspace`;
    assert.notEqual((await invoke('run-model-selection-evals.mjs', dotDot)).code, 0);
    const external = structuredClone(base);
    external.paths.workspace = outside;
    assert.notEqual((await invoke('run-model-selection-evals.mjs', external)).code, 0);
    await rm(path.join(root, 'workspace', 'eval'), { recursive: true });
    await symlink(outside, path.join(root, 'workspace', 'eval'));
    assert.notEqual((await invoke('run-model-selection-evals.mjs', base)).code, 0);
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
    assert.notEqual((await invoke('run-model-selection-evals.mjs', wrongEvidence)).code, 0);
    const wrongOutput = structuredClone(grade);
    wrongOutput.paths.modelOutput = path.join(root, 'output', 'other-output.txt');
    assert.notEqual((await invoke('run-model-selection-evals.mjs', wrongOutput)).code, 0);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test('Explore workflow adapters contain no direct Codex or raw-trace path', async () => {
  for (const file of [
    'codex-workflow-adapter.mjs',
    'run-model-selection-evals.mjs',
    'run-workflow-evals.mjs',
    'run-liveness-evals.mjs',
  ]) {
    const source = await readFile(path.join(evalRoot, file), 'utf8');
    assert.doesNotMatch(source, /codex\s+exec|node:child_process|workflow-trace\.json|provider-evidence\.json/u);
  }
});
