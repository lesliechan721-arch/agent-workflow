import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  evaluateModelSelectionRun,
  modelEvalRunCase,
} from '../skills/codex-explore/evals/run-model-selection-evals.mjs';
import * as modelProvider from '../skills/codex-explore/evals/run-model-selection-evals.mjs';
import * as workflowProvider from '../skills/codex-explore/evals/run-workflow-evals.mjs';
import * as livenessProvider from '../skills/codex-explore/evals/run-liveness-evals.mjs';
import modelManifestDocument from '../skills/codex-explore/evals/manifest.json' with { type: 'json' };
import modelCorpusDocument from '../skills/codex-explore/evals/evals.json' with { type: 'json' };
import {
  readRolloutEvidenceFromRollouts,
  readSpawnCallsFromRollouts,
  recoverV1SpawnCallsFromExecEvents,
  shouldStopEarly,
} from '../skills/codex-explore/evals/eval-harness.mjs';

async function testProviderManifestComposition() {
  const manifest = modelManifestDocument;
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.plugin, 'codex-enhance');
  assert.equal(manifest.skill, 'codex-explore');
  const providerSuites = manifest.suites.filter((suite) => suite.kind === 'provider');
  assert.deepEqual(providerSuites.map((suite) => suite.id), [
    'model-selection',
    'workflow',
    'liveness',
  ]);
  const entryModules = {
    'run-model-selection-evals.mjs': modelProvider,
    'run-workflow-evals.mjs': workflowProvider,
    'run-liveness-evals.mjs': livenessProvider,
  };
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
    const provider = suite.provider;
    assert.ok(provider && typeof provider === 'object');
    assert.equal(typeof provider.id, 'string');
    assert.equal(typeof provider.entry, 'string');
    assert.equal(path.isAbsolute(provider.entry), false);
    assert.equal(provider.entry.startsWith('../'), false);
    assert.match(provider.entry, /^run-[a-z-]+-evals\.mjs$/u);
    assert.equal(Array.isArray(provider.assets), true);
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
  assert.equal(modelCorpusDocument.skill_name, 'codex-explore');
  assert.ok(Array.isArray(modelCorpusDocument.evals));
  assert.equal(modelCorpusDocument.evals.length > 0, true);
  assert.equal(
    new Set(modelCorpusDocument.evals.map((entry) => entry.id)).size,
    modelCorpusDocument.evals.length,
  );
  for (const entry of modelCorpusDocument.evals) {
    assert.equal(entry.assertions.length > 0, true);
    assert.equal(['routing', 'gate'].includes(entry.eval_type), true);
    assert.equal(typeof entry.scenario_family, 'string');
    assert.equal(typeof entry.preconditions, 'object');
    assert.equal(typeof entry.oracle?.rationale, 'string');
    assert.equal(
      entry.assertions.every((assertion) => (
        typeof assertion.text === 'string' &&
        assertion.grader === 'script' &&
        typeof assertion.allowed_variance === 'string'
      )),
      true,
    );
    assert.equal(Object.hasOwn(entry, 'runs'), false);
    assert.equal(Object.hasOwn(entry, 'profiles'), false);
  }

  assert.deepEqual(
    modelEvalRunCase({
      prompt: 'inspect',
      parent_model: 'parent-model',
      wait_for_completion: true,
      expected: { spawn_calls: { min: 1 } },
      codex_config: { feature: true },
    }),
    {
      query: 'inspect',
      explicit_skill: false,
      should_load_skill: true,
      should_spawn_agent: true,
      wait_for_completion: true,
      stop_after_nested_evidence: false,
      expected: { spawn_calls: { min: 1 } },
      parent_model: 'parent-model',
      enable_features: undefined,
      disable_features: undefined,
      codex_config: { feature: true },
    },
  );

  assert.equal(
    modelEvalRunCase({
      prompt: '$codex-explore inspect',
      expected: { spawn_calls: { min: 1 } },
    }).explicit_skill,
    true,
  );
}

async function testRolloutArgumentEvidence() {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'codex-rollout-eval-'));
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
          agent_type: 'codex-explore-custom',
          message: 'trace the evidence',
          task_name: 'trace_evidence',
          model: 'gpt-5.6-sol',
          fork_turns: 'none',
        }),
        call_id: 'call-1',
      },
    };
    const parentMeta = {
      type: 'session_meta',
      payload: { id: 'parent-thread', source: 'cli' },
    };
    const childMeta = {
      type: 'session_meta',
      payload: {
        id: 'child-thread',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: 'parent-thread',
            agent_path: '/root/trace_evidence',
            agent_role: 'codex-explore-standard',
            },
          },
        },
      },
    };
    await writeFile(
      path.join(sessionDir, 'rollout-test.jsonl'),
      `${JSON.stringify(parentMeta)}\n${JSON.stringify(line)}\n${JSON.stringify(line)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(sessionDir, 'rollout-leaf.jsonl'),
      `${JSON.stringify(childMeta)}\n${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id: 'leaf-call-1',
            command: ['/bin/zsh', '-lc', 'pwd && node docs/liveness/verify-records.mjs'],
            parsed_cmd: [
              { type: 'read', cmd: 'pwd' },
              { type: 'unknown', cmd: 'node docs/liveness/verify-records.mjs' },
            ],
            status: 'completed',
            exit_code: 0,
          },
        },
      })}\n${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<environment_context>\n  <cwd>/tmp/eval</cwd>\n</environment_context>',
          }],
        },
      })}\n${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'agent_message',
          content: [
            { type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/trace\nSender: /root\nPayload:\n' },
            { type: 'encrypted_content', encrypted_content: 'enc-task' },
          ],
        },
      })}\n${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'leaf-code-call-1',
          input: 'const result = await tools.exec_command({cmd:"node docs/liveness/verify-records.mjs"}); text(result.output);',
        },
      })}\n${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'leaf-code-call-1',
          output: 'Script completed',
        },
      })}\n`,
      'utf8',
    );
    await writeFile(
      path.join(sessionDir, 'rollout-unlinked.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'unlinked-thread',
          source: {
            subagent: {
              thread_spawn: { parent_thread_id: 'other-parent' },
            },
          },
        },
      })}\n${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id: 'unlinked-call-1',
            command: ['/bin/zsh', '-lc', 'node unrelated.mjs'],
            parsed_cmd: [{ type: 'unknown', cmd: 'node unrelated.mjs' }],
            status: 'completed',
            exit_code: 0,
          },
        },
      })}\n`,
      'utf8',
    );

    const calls = await readSpawnCallsFromRollouts(codexHome);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].arguments, {
      agent_type: 'codex-explore-custom',
      message: 'trace the evidence',
      task_name: 'trace_evidence',
      model: 'gpt-5.6-sol',
      fork_turns: 'none',
    });
    const evidence = await readRolloutEvidenceFromRollouts(codexHome);
    assert.equal(evidence.leaf_trace_available, true);
    assert.deepEqual(evidence.leaf_trace.child_threads, [{
      thread_id: 'child-thread',
      parent_thread_id: 'parent-thread',
      agent_path: '/root/trace_evidence',
      agent_role: 'codex-explore-standard',
      initial_user_message: null,
      initial_encrypted_message: 'enc-task',
      developer_context: {
        developer_message_count: 0,
        has_multi_agent_mode_gate: false,
        has_nested_agent_capability: false,
        has_codex_explore_developer_authorization: false,
      },
    }]);
    assert.deepEqual(
      recoverV1SpawnCallsFromExecEvents([
        {
          type: 'item.completed',
          item: {
            id: 'item-v1-spawn',
            type: 'collab_tool_call',
            tool: 'spawn_agent',
            prompt: 'trace the evidence',
            receiver_thread_ids: ['child-thread'],
            status: 'completed',
          },
        },
      ], evidence.thread_identities),
      [{
        call_id: 'item-v1-spawn',
        namespace: 'multi_agent_v1',
        tool: 'spawn_agent',
        arguments: {
          agent_type: 'codex-explore-standard',
          fork_context: false,
          message: 'trace the evidence',
        },
        output: { agent_id: 'child-thread' },
        rollout_file: path.join('sessions', '2026', '08', '03', 'rollout-leaf.jsonl'),
        line_number: null,
        evidence_source: 'exec_collab_tool_call+child_session_meta',
      }],
    );
    assert.equal(evidence.parent_calls.length, 1);
    assert.equal(evidence.leaf_calls.length, 2);
    const commandCall = evidence.leaf_calls.find((call) => call.tool === 'exec_command');
    assert.deepEqual(commandCall.arguments, {
      cmd: 'pwd && node docs/liveness/verify-records.mjs',
    });
    const codeCall = evidence.leaf_calls.find((call) => call.tool === 'exec');
    assert.deepEqual(codeCall.arguments, {
      input: 'const result = await tools.exec_command({cmd:"node docs/liveness/verify-records.mjs"}); text(result.output);',
    });
    assert.equal(codeCall.output, 'Script completed');
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

async function testV1RolloutLineageEvidence() {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'codex-v1-lineage-eval-'));
  try {
    const sessionDir = path.join(codexHome, 'sessions', '2026', '08', '26');
    await mkdir(sessionDir, { recursive: true });
    const commandEvent = (id, command) => ({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id,
          command: ['/bin/zsh', '-lc', command],
          status: 'completed',
          exit_code: 0,
        },
      },
    });
    await writeFile(
      path.join(sessionDir, 'rollout-root.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'v1-root', source: 'cli' },
      })}\n${JSON.stringify(commandEvent(
        'root-skill',
        'sed -n 1,240p .agents/skills/codex-subagent-guide/SKILL.md',
      ))}\n`,
      'utf8',
    );
    await writeFile(
      path.join(sessionDir, 'rollout-plan.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'v1-plan',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'v1-root',
                agent_path: '/root/plan',
                agent_role: 'codex-subagent-advanced',
              },
            },
          },
        },
      })}\n${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<environment_context>\n  <cwd>/tmp/v1-eval</cwd>\n</environment_context>',
          }],
        },
      })}\n${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'plan' }],
        },
      })}\n${JSON.stringify(commandEvent(
        'child-skill',
        'sed -n 1,240p .agents/skills/codex-explore/SKILL.md',
      ))}\n`,
      'utf8',
    );
    await writeFile(
      path.join(sessionDir, 'rollout-grandchild.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'v1-grandchild',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'v1-plan',
                agent_path: '/root/plan/trace',
                agent_role: 'codex-explore-deep',
              },
            },
          },
        },
      })}\n`,
      'utf8',
    );

    const evidence = await readRolloutEvidenceFromRollouts(codexHome);
    assert.equal(evidence.leaf_trace_available, true);
    assert.deepEqual(evidence.leaf_trace.parent_thread_ids, ['v1-root']);
    assert.equal(
      evidence.leaf_trace.child_threads.some((thread) => (
        thread.thread_id === 'v1-plan' && thread.parent_thread_id === 'v1-root'
      )),
      true,
    );
    const nestedSpawn = evidence.leaf_calls.find((call) => (
      call.tool === 'spawn_agent' && call.thread_id === 'v1-plan'
    ));
    assert.deepEqual(nestedSpawn, {
      call_id: 'lineage-spawn:v1-grandchild',
      namespace: 'multi_agent_v1',
      tool: 'spawn_agent',
      arguments: { agent_type: 'codex-explore-deep' },
      output: { agent_id: 'v1-grandchild' },
      rollout_file: path.join('sessions', '2026', '08', '26', 'rollout-grandchild.jsonl'),
      line_number: null,
      thread_id: 'v1-plan',
      parent_thread_id: 'v1-root',
      evidence_source: 'child_session_meta_lineage',
    });
    assert.equal(
      evidence.parent_calls.some((call) => call.tool === 'spawn_agent'),
      false,
    );
    const evaluation = evaluateModelSelectionRun({
      execution_error: false,
      termination: 'expected_nested_outcome_observed',
      exit_code: 0,
      descendant_cleanup_confirmed: true,
      spawn_calls: [{
        arguments: {
          agent_type: 'codex-subagent-advanced',
          message: 'plan',
          fork_context: false,
        },
      }],
      collaboration_timeline: evidence.parent_calls,
      leaf_tool_calls: evidence.leaf_calls,
      leaf_trace: evidence.leaf_trace,
    }, {
      spawn_calls: { min: 1, max: 1 },
      arguments: {
        agent_type: 'codex-subagent-advanced',
        model: null,
        reasoning_effort: null,
        fork_context: false,
        fork_turns: null,
      },
      present_arguments: ['message'],
      nested_delegation: {
        root_skill: 'codex-subagent-guide',
        root_skill_explicitly_invoked: true,
        child_skill: 'codex-explore',
        child_agent_type: 'codex-explore-deep',
        child_initial_message: 'plan',
        expect_early_termination: true,
        forbid_root_child_followup: true,
        grandchild_spawn_calls: { min: 1, max: 4 },
        expect_child_multi_agent_gate: false,
        expect_child_developer_authorization: false,
      },
    });
    assert.equal(evaluation.passed, true);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

function testMechanicalAssertions() {
  const preset = evaluateModelSelectionRun(
    {
      execution_error: false,
      termination: 'expected_outcome_observed',
      exit_code: null,
      spawn_calls: [{
        arguments: {
          agent_type: 'codex-explore-standard',
          message: 'trace',
          task_name: 'trace',
          fork_turns: 'none',
        },
      }],
    },
    {
      spawn_calls: { min: 1, max: 1 },
      arguments: {
        agent_type: 'codex-explore-standard',
        model: null,
        reasoning_effort: null,
        fork_turns: 'none',
      },
      present_arguments: ['message', 'task_name'],
    },
  );
  assert.equal(preset.passed, true);

  const nestedRun = {
      execution_error: false,
      termination: 'expected_nested_outcome_observed',
      exit_code: 0,
      descendant_cleanup_confirmed: true,
      spawn_calls: [{
        arguments: {
          agent_type: 'codex-subagent-advanced',
          message: 'plan with nested delegation authorized',
          task_name: 'plan',
          fork_turns: 'none',
        },
      }],
      collaboration_timeline: [{
        tool: 'exec',
        arguments: { input: 'await tools.exec_command({cmd:"sed -n 1,200p .agents/skills/codex-subagent-guide/SKILL.md"})' },
      }],
      leaf_tool_calls: [
        {
          thread_id: 'plan-thread',
          tool: 'exec_command',
          arguments: { cmd: 'sed -n 1,240p .agents/skills/codex-explore/SKILL.md' },
        },
        {
          thread_id: 'plan-thread',
          tool: 'spawn_agent',
          arguments: { agent_type: 'codex-explore-deep' },
          output: { task_name: '/root/plan/trace' },
        },
        {
          thread_id: 'plan-thread',
          tool: 'spawn_agent',
          arguments: { agent_type: 'codex-explore-deep' },
          output: 'collab spawn failed: agent thread limit reached',
        },
      ],
      leaf_trace: {
        parent_thread_ids: ['root-thread'],
        child_threads: [{
          thread_id: 'plan-thread',
          parent_thread_id: 'root-thread',
          agent_role: 'codex-subagent-advanced',
          initial_user_message: 'plan',
          developer_context: {
            has_multi_agent_mode_gate: true,
            has_codex_explore_developer_authorization: false,
          },
        }, {
          thread_id: 'grandchild-thread',
          parent_thread_id: 'plan-thread',
          agent_role: 'codex-explore-deep',
        }],
      },
    };
  const nestedExpected = {
      spawn_calls: { min: 1, max: 1 },
      arguments: {
        agent_type: 'codex-subagent-advanced',
        model: null,
        reasoning_effort: null,
        fork_turns: 'none',
      },
      present_arguments: ['message', 'task_name'],
      nested_delegation: {
        root_skill: 'codex-subagent-guide',
        root_skill_explicitly_invoked: true,
        child_skill: 'codex-explore',
        child_agent_type: 'codex-explore-deep',
        child_initial_message: 'plan',
        expect_early_termination: true,
        forbid_root_child_followup: true,
        grandchild_spawn_calls: { min: 1, max: 4 },
        expect_child_multi_agent_gate: true,
        expect_child_developer_authorization: false,
      },
    };
  const nested = evaluateModelSelectionRun(nestedRun, nestedExpected);
  assert.equal(nested.passed, true);

  const encryptedNestedRun = structuredClone(nestedRun);
  encryptedNestedRun.spawn_calls[0].arguments.message = 'enc-plan';
  encryptedNestedRun.leaf_trace.child_threads[0].initial_user_message = null;
  encryptedNestedRun.leaf_trace.child_threads[0].initial_encrypted_message = 'enc-plan';
  const encryptedNestedExpected = structuredClone(nestedExpected);
  delete encryptedNestedExpected.nested_delegation.child_initial_message;
  encryptedNestedExpected.nested_delegation.child_initial_encrypted_link = true;
  assert.equal(
    evaluateModelSelectionRun(encryptedNestedRun, encryptedNestedExpected).passed,
    true,
  );
  assert.equal(shouldStopEarly({
    wait_for_completion: false,
    stop_after_nested_evidence: true,
    expected: encryptedNestedExpected,
  }, {
    spawnCalls: encryptedNestedRun.spawn_calls,
    collaborationTimeline: encryptedNestedRun.collaboration_timeline,
    leafToolCalls: encryptedNestedRun.leaf_tool_calls,
    leafTrace: encryptedNestedRun.leaf_trace,
  }), 'expected_nested_outcome_observed');

  const pollutedAuthorizationRun = structuredClone(nestedRun);
  pollutedAuthorizationRun.leaf_trace.child_threads[0].initial_user_message =
    'plan with nested delegation authorized';
  const pollutedAuthorization = evaluateModelSelectionRun(
    pollutedAuthorizationRun,
    nestedExpected,
  );
  assert.equal(pollutedAuthorization.passed, false);
  assert.equal(
    pollutedAuthorization.assertions.find(
      (entry) => entry.name === 'nested.child_initial_message',
    )?.passed,
    false,
  );

  assert.equal(shouldStopEarly({
    wait_for_completion: false,
    stop_after_nested_evidence: true,
    expected: nestedExpected,
  }, {
    spawnCalls: nestedRun.spawn_calls,
    leafToolCalls: nestedRun.leaf_tool_calls,
    leafTrace: nestedRun.leaf_trace,
  }), 'expected_nested_outcome_observed');

  const followupPollutionRun = structuredClone(nestedRun);
  followupPollutionRun.collaboration_timeline.push({
    tool: 'send_message',
    arguments: { target: '/root/plan', message: 'nested delegation authorized' },
  });
  const followupPollution = evaluateModelSelectionRun(
    followupPollutionRun,
    nestedExpected,
  );
  assert.equal(followupPollution.passed, false);
  assert.equal(shouldStopEarly({
    wait_for_completion: false,
    stop_after_nested_evidence: true,
    expected: nestedExpected,
  }, {
    spawnCalls: followupPollutionRun.spawn_calls,
    collaborationTimeline: followupPollutionRun.collaboration_timeline,
    leafToolCalls: followupPollutionRun.leaf_tool_calls,
    leafTrace: followupPollutionRun.leaf_trace,
  }), null);

  const explicitRootSkillRun = structuredClone(nestedRun);
  explicitRootSkillRun.collaboration_timeline = [];
  assert.equal(
    evaluateModelSelectionRun(explicitRootSkillRun, nestedExpected).passed,
    true,
  );

  const wrongLayerRun = structuredClone(nestedRun);
  wrongLayerRun.leaf_tool_calls = wrongLayerRun.leaf_tool_calls.filter(
    (call) => call.tool !== 'spawn_agent',
  );
  wrongLayerRun.leaf_tool_calls.push({
    thread_id: 'grandchild-thread',
    tool: 'spawn_agent',
    arguments: { agent_type: 'codex-explore-deep' },
    output: { task_name: '/root/plan/trace/deeper' },
  });
  const wrongLayer = evaluateModelSelectionRun(wrongLayerRun, nestedExpected);
  assert.equal(wrongLayer.passed, false);
  assert.equal(
    wrongLayer.assertions.find((entry) => entry.name === 'nested.grandchild_spawn_count')?.passed,
    false,
  );

  const wrongRoleRun = structuredClone(nestedRun);
  wrongRoleRun.leaf_tool_calls.push({
    thread_id: 'plan-thread',
    tool: 'spawn_agent',
    arguments: { agent_type: 'codex-explore-quick' },
    output: { task_name: '/root/plan/quick' },
  });
  const wrongRole = evaluateModelSelectionRun(wrongRoleRun, nestedExpected);
  assert.equal(wrongRole.passed, false);
  assert.equal(
    wrongRole.assertions.find((entry) => entry.name === 'nested.grandchild_agent_type')?.passed,
    false,
  );

  const v1Preset = evaluateModelSelectionRun(
    {
      execution_error: false,
      termination: 'expected_outcome_observed',
      exit_code: null,
      spawn_calls: [{
        arguments: {
          agent_type: 'codex-explore-standard',
          message: 'trace',
          fork_context: false,
        },
      }],
    },
    {
      spawn_calls: { min: 1, max: 1 },
      arguments: {
        agent_type: 'codex-explore-standard',
        model: null,
        reasoning_effort: null,
        fork_context: false,
        fork_turns: null,
      },
      present_arguments: ['message'],
    },
  );
  assert.equal(v1Preset.passed, true);

  const wrongPresetOverride = evaluateModelSelectionRun(
    {
      execution_error: false,
      termination: 'expected_outcome_observed',
      exit_code: null,
      spawn_calls: [{
        arguments: {
          agent_type: 'codex-explore-standard',
          model: 'gpt-5.6-luna',
          reasoning_effort: 'high',
        },
      }],
    },
    {
      spawn_calls: { min: 1, max: 1 },
      arguments: {
        agent_type: 'codex-explore-standard',
        model: null,
        reasoning_effort: null,
      },
    },
  );
  assert.equal(wrongPresetOverride.passed, false);

  const silentRetry = evaluateModelSelectionRun(
    {
      execution_error: false,
      termination: 'completed',
      exit_code: 0,
      spawn_calls: [
        {
          arguments: {
            agent_type: 'codex-explore-custom',
            model: 'definitely-unavailable-model',
            reasoning_effort: 'turbo',
          },
          output: 'runtime rejected the model',
        },
        {
          arguments: { agent_type: 'codex-explore-deep' },
          output: { task_name: '/root/retry' },
        },
      ],
    },
    {
      spawn_calls: { min: 1, max: 1 },
      arguments_if_called: {
        agent_type: 'codex-explore-custom',
        model: 'definitely-unavailable-model',
        reasoning_effort: 'turbo',
      },
      spawn_rejected: true,
    },
  );
  assert.equal(silentRetry.passed, false);

  const rejectedWithoutKeyword = evaluateModelSelectionRun(
    {
      execution_error: false,
      termination: 'completed',
      exit_code: 0,
      final_message: '调度器拒绝了这个参数。',
      spawn_calls: [{
        arguments: {
          agent_type: 'codex-explore-custom',
          model: 'definitely-unavailable-model',
          reasoning_effort: 'turbo',
        },
        output: 'runtime rejected the model',
      }],
    },
    {
      spawn_calls: { min: 1, max: 1 },
      arguments_if_called: {
        agent_type: 'codex-explore-custom',
        model: 'definitely-unavailable-model',
        reasoning_effort: 'turbo',
      },
      spawn_rejected: true,
    },
  );
  assert.equal(rejectedWithoutKeyword.passed, true);

  const preflightRejected = evaluateModelSelectionRun(
    {
      execution_error: false,
      termination: 'completed',
      exit_code: 0,
      final_message: 'model=definitely-unavailable-model 与 reasoning_effort=turbo 不能原样传递。',
      spawn_calls: [],
    },
    {
      spawn_calls: { min: 0, max: 1 },
      spawn_rejected: true,
      preflight_rejection_evidence: ['definitely-unavailable-model', 'turbo'],
    },
  );
  assert.equal(preflightRejected.passed, true);

  const unexplainedPreflightStop = evaluateModelSelectionRun(
    {
      execution_error: false,
      termination: 'completed',
      exit_code: 0,
      final_message: '参数不能使用。',
      spawn_calls: [],
    },
    {
      spawn_calls: { min: 0, max: 1 },
      spawn_rejected: true,
      preflight_rejection_evidence: ['definitely-unavailable-model', 'turbo'],
    },
  );
  assert.equal(unexplainedPreflightStop.passed, false);

  const misleadingFailureText = evaluateModelSelectionRun(
    {
      execution_error: false,
      termination: 'completed',
      exit_code: 0,
      final_message: '启动失败。',
      spawn_calls: [{
        arguments: {
          agent_type: 'codex-explore-custom',
          model: 'definitely-unavailable-model',
          reasoning_effort: 'turbo',
        },
        output: { task_name: '/root/unexpected-success' },
      }],
    },
    {
      spawn_calls: { min: 1, max: 1 },
      arguments_if_called: {
        agent_type: 'codex-explore-custom',
        model: 'definitely-unavailable-model',
        reasoning_effort: 'turbo',
      },
      spawn_rejected: true,
    },
  );
  assert.equal(misleadingFailureText.passed, false);
}

async function main() {
  await testProviderManifestComposition();
  await testRolloutArgumentEvidence();
  await testV1RolloutLineageEvidence();
  testMechanicalAssertions();
  console.log('model selection eval tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
