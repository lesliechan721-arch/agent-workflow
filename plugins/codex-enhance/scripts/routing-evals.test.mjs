import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  earlyStopReason,
  extractExecToolCalls,
  readSpawnCallsFromRollouts,
  removeEvalDirectory,
} from '../skills/codex-subagent-guide/evals/eval-harness.mjs';
import {
  evaluateRoutingRun,
  routingRunCase,
} from '../skills/codex-subagent-guide/evals/run-routing-evals.mjs';
import * as routingProvider from '../skills/codex-subagent-guide/evals/run-routing-evals.mjs';
import * as lifecycleProvider from '../skills/codex-subagent-guide/evals/run-lifecycle-evals.mjs';
import routingManifestDocument from '../skills/codex-subagent-guide/evals/manifest.json' with { type: 'json' };
import routingCorpusDocument from '../skills/codex-subagent-guide/evals/provider-evals.json' with { type: 'json' };
import { fileURLToPath } from 'node:url';

async function testProviderManifestComposition() {
  const manifest = routingManifestDocument;
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.plugin, 'codex-enhance');
  assert.equal(manifest.skill, 'codex-subagent-guide');
  const providerSuites = manifest.suites.filter((suite) => suite.kind === 'provider');
  assert.deepEqual(
    providerSuites.map((suite) => suite.id),
    ['routing', 'lifecycle', 'lifecycle-timeout'],
  );

  const entryModules = {
    'run-routing-evals.mjs': routingProvider,
    'run-lifecycle-evals.mjs': lifecycleProvider,
  };
  const evalRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'skills',
    'codex-subagent-guide',
    'evals',
  );
  const capabilityKeys = [
    'cleanContext',
    'conversation',
    'duration',
    'materialization',
    'parallelRuns',
    'previousVersionBaseline',
    'sandbox',
    'skillPathExecution',
    'tokenUsage',
    'toolTrace',
    'triggerDiscovery',
    'withoutSkillBaseline',
  ];
  for (const suite of providerSuites) {
    assert.equal(Object.hasOwn(suite, 'entry'), false);
    assert.equal(Object.hasOwn(suite, 'supports'), false);
    assert.equal(Object.hasOwn(suite, 'suiteTimeoutMs'), false);
    assert.equal(Object.hasOwn(suite, 'command'), false);
    assert.equal(typeof suite.cases, 'string');
    assert.equal(path.isAbsolute(suite.cases), false);
    assert.equal(suite.cases.startsWith('./'), true);
    const provider = suite.provider;
    assert.ok(provider && typeof provider === 'object');
    assert.equal(typeof provider.id, 'string');
    assert.equal(typeof provider.entry, 'string');
    assert.equal(path.isAbsolute(provider.entry), false);
    assert.equal(provider.entry.startsWith('../'), false);
    assert.match(provider.entry, /^run-[a-z-]+-evals\.mjs$/u);
    assert.equal(Array.isArray(provider.assets), true);
    for (const asset of provider.assets) {
      assert.equal(typeof asset, 'string');
      assert.equal(path.isAbsolute(asset), false);
      assert.equal(path.posix.normalize(asset).startsWith('../'), false);
      await readFile(path.join(evalRoot, asset), 'utf8');
    }
    assert.equal(Array.isArray(provider.credentialEnvironment), true);
    assert.ok(provider.credentialEnvironment.length > 0);
    assert.equal(new Set(provider.credentialEnvironment).size, provider.credentialEnvironment.length);
    assert.equal(
      provider.credentialEnvironment.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)),
      true,
    );
    assert.deepEqual(Object.keys(provider.capabilities).sort(), [...capabilityKeys].sort());
    assert.equal(
      Object.values(provider.capabilities).every((value) => typeof value === 'boolean'),
      true,
    );
    const entryModule = entryModules[path.basename(provider.entry)];
    assert.ok(entryModule, `missing bundled provider entry ${provider.entry}`);
    assert.equal(typeof entryModule.runEvalProvider, 'function');
  }

  assert.equal(routingCorpusDocument.skill_name, 'codex-subagent-guide');
  assert.ok(Array.isArray(routingCorpusDocument.evals));
  assert.ok(routingCorpusDocument.evals.length > 0);
  assert.equal(
    new Set(routingCorpusDocument.evals.map((entry) => entry.id)).size,
    routingCorpusDocument.evals.length,
  );
  for (const entry of routingCorpusDocument.evals) {
    assert.equal(typeof entry.sourceCaseId, 'string');
    assert.equal(['v1', 'v2'].includes(entry.runtimeProfile), true);
    assert.deepEqual(Object.keys(entry.expectations), [entry.runtimeProfile]);
    assert.equal(Object.hasOwn(entry, 'runs'), false);
    assert.equal(Object.hasOwn(entry, 'profiles'), false);
  }
}

function testProviderCaseComposition() {
  const runCase = routingRunCase({
    prompt: 'route this task',
    omit_roles: ['unavailable-role'],
    expectations: {
      v2: {
        spawn_calls: { min: 0, max: 0 },
        block_reason: 'preset_role_unavailable',
      },
    },
  }, 'v2', 'with_skill');
  assert.equal(runCase.should_load_skill, true);
  assert.equal(runCase.should_spawn_agent, false);
  assert.equal(runCase.stop_on_spawn, true);
  assert.deepEqual(runCase.omit_roles, ['unavailable-role']);
  assert.match(runCase.query, /ROUTING_BLOCK_REASON=<reason>/u);
  assert.match(runCase.query, /preset_role_unavailable/u);
}

async function testRolloutArgumentEvidence() {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-rollout-'));
  try {
    const sessionDir = path.join(codexHome, 'sessions', '2026', '08', '03');
    await mkdir(sessionDir, { recursive: true });
    const line = {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        namespace: 'collaboration',
        arguments: JSON.stringify({
          agent_type: 'codex-subagent-simple',
          message: 'verify facts',
          fork_turns: '2',
        }),
        call_id: 'call-1',
      },
    };
    await writeFile(
      path.join(sessionDir, 'rollout-test.jsonl'),
      [
        JSON.stringify(line),
        JSON.stringify(line),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-2',
            internal_chat_message_metadata_passthrough: {
              executed_tool_calls: [{
                name: 'collaboration__spawn_agent',
                arguments: {
                  agent_type: 'codex-subagent-complex',
                  message: 'investigate',
                  fork_turns: 'none',
                },
              }],
            },
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'exec-call-1',
            input: [
              'const result = await tools.multi_agent_v1__spawn_agent({',
              '  agent_type: "codex-subagent-simple",',
              '  fork_context: false,',
              '  message: "verify { left: 1, right: 2 }",',
              '  items: [{ type: "text", text: "nested evidence" }],',
              '}); text(result);',
            ].join('\n'),
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'exec-call-1',
            output: { task_name: '/root/verify' },
            internal_chat_message_metadata_passthrough: {
              executed_tool_calls: [{
                name: 'multi_agent_v1__spawn_agent',
                arguments: {
                  agent_type: 'codex-subagent-simple',
                  fork_context: false,
                  message: 'verify { left: 1, right: 2 }',
                  items: [{ type: 'text', text: 'nested evidence' }],
                },
              }],
            },
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'exec-call-2',
            input: 'await tools.multi_agent_v1__spawn_agent(argumentsValue);',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'exec-call-2',
            internal_chat_message_metadata_passthrough: {
              executed_tool_calls: [{
                name: 'multi_agent_v1__spawn_agent',
                arguments: {
                  agent_type: 'codex-subagent-general',
                  message: 'metadata fallback',
                  fork_context: false,
                },
              }],
            },
          },
        }),
        '',
      ].join('\n'),
      'utf8',
    );
    const calls = await readSpawnCallsFromRollouts(codexHome);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[0].arguments, {
      agent_type: 'codex-subagent-simple',
      message: 'verify facts',
      fork_turns: '2',
    });
    assert.deepEqual(calls[1].arguments, {
      agent_type: 'codex-subagent-complex',
      message: 'investigate',
      fork_turns: 'none',
    });
    assert.deepEqual(calls[2].arguments, {
      agent_type: 'codex-subagent-simple',
      fork_context: false,
      message: 'verify { left: 1, right: 2 }',
      items: [{ type: 'text', text: 'nested evidence' }],
    });
    assert.deepEqual(calls[3].arguments, {
      agent_type: 'codex-subagent-general',
      message: 'metadata fallback',
      fork_context: false,
    });
    assert.deepEqual(extractExecToolCalls('await tools.exec_command({ cmd: "pwd" });'), []);
    assert.deepEqual(
      extractExecToolCalls('await tools.multi_agent_v1__spawn_agent(argumentsValue);'),
      [],
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

async function testEvalDirectoryCleanupContract() {
  const root = path.join(os.tmpdir(), 'codex-subagent-guide-eval');
  const calls = [];
  await removeEvalDirectory(root, async (candidate, options) => {
    calls.push({ root: candidate, options });
  });
  assert.deepEqual(calls, [{
    root,
    options: {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    },
  }]);
}

function testMechanicalAssertions() {
  const expected = {
    spawn_calls: { min: 1, max: 1 },
    arguments: {
      agent_type: 'codex-subagent-simple',
      model: null,
      reasoning_effort: null,
      fork_turns: '2',
    },
    present_arguments: ['message'],
  };
  const passingRun = {
    loaded: true,
    load_evidence: 'read SKILL.md',
    execution_error: false,
    termination: 'spawn_observed',
    exit_code: null,
    spawn_calls: [{
      arguments: {
        agent_type: 'codex-subagent-simple',
        message: 'verify',
        fork_turns: '2',
      },
    }],
  };
  assert.equal(evaluateRoutingRun(passingRun, expected, 'with_skill').passed, true);

  const rejectedByToolRouter = {
    ...passingRun,
    stderr: 'ERROR codex_core::tools::router: error=Provide either message or items, but not both',
  };
  const routerEvaluation = evaluateRoutingRun(rejectedByToolRouter, expected, 'with_skill');
  assert.equal(routerEvaluation.passed, false);
  assert.match(
    routerEvaluation.assertions.find((assertion) => assertion.name === 'execution').evidence,
    /router_error/,
  );

  const explicitlyInjected = {
    ...passingRun,
    requested_explicitly: true,
    loaded: false,
    load_evidence: null,
  };
  assert.equal(evaluateRoutingRun(explicitlyInjected, expected, 'with_skill').passed, true);
  assert.equal(
    earlyStopReason(
      { stop_on_spawn: true },
      { spawned: true, spawnCalls: [] },
    ),
    null,
  );
  assert.equal(
    earlyStopReason(
      { stop_on_spawn: true },
      { spawned: true, spawnCalls: [{ arguments: { message: 'verify' } }] },
    ),
    'spawn_observed',
  );

  const inheritedWrongly = {
    ...passingRun,
    spawn_calls: [{ arguments: { message: 'verify', fork_turns: '2' } }],
  };
  assert.equal(
    evaluateRoutingRun(inheritedWrongly, expected, 'with_skill').passed,
    false,
  );

  const baseline = { ...passingRun, loaded: false, load_evidence: null };
  assert.equal(evaluateRoutingRun(baseline, expected, 'without_skill').passed, true);

  const missingRawArguments = {
    loaded: false,
    spawned: true,
    execution_error: false,
    termination: 'spawn_observed',
    exit_code: 0,
    spawn_calls: [],
    final_message: '当前接口不能表达部分历史。\nROUTING_BLOCK_REASON=partial_history_unsupported',
  };
  assert.equal(
    evaluateRoutingRun(
      missingRawArguments,
      {
        spawn_calls: { min: 0, max: 0 },
        block_reason: 'partial_history_unsupported',
      },
      'without_skill',
    ).passed,
    false,
  );

}

async function main() {
  await testProviderManifestComposition();
  testProviderCaseComposition();
  await testRolloutArgumentEvidence();
  await testEvalDirectoryCleanupContract();
  testMechanicalAssertions();
  console.log('routing eval tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
