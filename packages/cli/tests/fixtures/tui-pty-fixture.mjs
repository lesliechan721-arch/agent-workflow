import fs from 'node:fs';
import path from 'node:path';

import React from 'react';

import { ConsoleAppV4 } from '../../dist/src/tui/console-app-v4.js';
import { TuiController } from '../../dist/src/tui/controller.js';
import { createInkTuiRunner } from '../../dist/src/tui/runner.js';
import {
  CONFIG_PLUGIN_ID,
  configEvidence,
  configRetryEvidence,
  createConfigPage,
  partialConfigExecution,
  successfulSingleConfigRetry,
} from '../helpers/tui-pty-config-fixture.mjs';

const evidence = {
  catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
  source: {
    sourceId: 'official',
    sourceIdentity: 'identity:official',
    snapshotDigest: 'sha256:snapshot',
    contentDigest: 'sha256:content',
  },
  targetFingerprint: 'sha256:target',
};

function source(id, primary) {
  return {
    id,
    identity: `identity:${id}`,
    type: 'path',
    primary,
    requestedRef: 'path',
    freshness: 'active',
  };
}

function claudeTarget(pluginName, sourceId, state) {
  return {
    pluginName,
    pluginId: `${sourceId}/${pluginName}`,
    sourceId,
    sourceIdentity: `identity:${sourceId}`,
    version: sourceId === 'team-tools' ? '0.4.2' : '0.3.1',
    cwd: process.cwd(),
    platform: 'claude',
    scope: 'user',
    state: state === 'present' ? 'ready' : 'absent',
    components: [{ kind: 'ownership', key: 'fixture', state }],
    reasons: [],
    recoveryActions: [],
  };
}

function codexTarget(pluginName, sourceId, state) {
  const placement = {
    scope: 'project',
    state: state === 'present' ? 'ready' : 'absent',
    components: [{ kind: 'ownership', key: 'fixture', state }],
    reasons: [],
    recoveryActions: [],
  };
  return {
    pluginName,
    pluginId: `${sourceId}/${pluginName}`,
    sourceId,
    sourceIdentity: `identity:${sourceId}`,
    version: '0.3.1',
    cwd: process.cwd(),
    platform: 'codex',
    state: placement.state,
    components: [],
    reasons: [],
    recoveryActions: [],
    placements: [placement],
  };
}

function loadResult() {
  const summaries = [
    {
      pluginName: 'agent-lab',
      pluginId: 'official/agent-lab',
      displayName: '代理实验室',
      description: '用于本地试验的 Agent 工具集合，包含中文宽字符。',
      version: '0.3.1',
      supportedTargets: { codex: ['user', 'project'], claude: ['user'] },
      configFieldCount: 0,
    },
    {
      pluginName: 'review-gate',
      pluginId: 'team-tools/review-gate',
      displayName: 'Review Gate 审查门禁',
      description: '团队发布审查、证据检查与发布门禁。',
      version: '0.4.2',
      supportedTargets: { codex: [], claude: ['user'] },
      configFieldCount: 1,
    },
  ];
  const result = {
    payload: {
      schemaVersion: 8,
      catalog: {
        primarySourceId: 'official',
        configDigest: 'sha256:config',
        compositeDigest: 'sha256:composite',
        sources: [source('official', true), source('team-tools', false)],
      },
      filters: { plugins: [], platform: 'both', cwd: process.cwd() },
      targets: [
        codexTarget('agent-lab', 'official', 'absent'),
        claudeTarget('agent-lab', 'official', 'absent'),
        claudeTarget('review-gate', 'team-tools', 'present'),
      ],
      errors: [],
    },
    pluginSummaries: summaries,
    configuredSources: [
      { id: 'official', type: 'path', primary: true, path: process.cwd(), autoCheck: false },
      { id: 'team-tools', type: 'path', primary: false, path: process.cwd(), autoCheck: false },
    ],
    sourceDetails: [
      {
        id: 'official', type: 'path', primary: true, autoCheck: false,
        locationSummary: '隔离测试来源', pluginCount: 1,
        sourceIdentity: 'identity:official', requestedRef: 'path',
        configDigest: 'sha256:config',
      },
      {
        id: 'team-tools', type: 'path', primary: false, autoCheck: false,
        locationSummary: '隔离测试来源', pluginCount: 1,
        sourceIdentity: 'identity:team-tools', requestedRef: 'path',
        configDigest: 'sha256:config',
      },
    ],
    catalogGenerations: [
      {
        sourceId: 'official', sourceType: 'path',
        active: {
          catalogVersion: '1.0.0', channel: 'latest', requestedRef: 'path',
          resolvedCommit: 'path', storeKey: 'official-active', digestShort: 'official',
        },
        syncInstruction: 'aw catalog source sync official',
      },
      {
        sourceId: 'team-tools', sourceType: 'path',
        active: {
          catalogVersion: '2.4.0', channel: 'latest', requestedRef: 'path',
          resolvedCommit: 'path', storeKey: 'team-tools-active', digestShort: 'teamtool',
        },
        syncInstruction: 'aw catalog source sync team-tools',
      },
    ],
  };
  if (scenario === 'scoped-inventory') return { ...result, projectRoot: process.cwd() };
  if (scenario === 'portable-recheck' || scenario === 'portable-flow') {
    return { ...result, portablePluginIds: ['official/agent-lab'] };
  }
  return result;
}

const portableCandidates = [
  { name: 'author-skill', description: '创建 Skill', providerPluginId: 'official/agent-lab', providerDisplayName: '代理实验室', relation: 'requested', dynamic: false, filesDigest: 'sha256:a' },
  { name: 'review-skill', description: '评审 Skill', providerPluginId: 'official/agent-lab', providerDisplayName: '代理实验室', relation: 'requested', dynamic: true, filesDigest: 'sha256:b' },
];

function portableReview(intent) {
  const selected = intent.selectedSkills.length === 0
    ? portableCandidates : portableCandidates.filter((candidate) => intent.selectedSkills.includes(candidate.name));
  return {
    pluginId: intent.pluginId, sourceId: 'official', sourceIdentity: 'identity:official', pluginVersion: '0.3.1',
    scope: intent.scope, selected, requestedSkills: intent.selectedSkills,
    agentMode: intent.requestedAgents ? 'explicit' : 'automatic', requestedAgents: intent.requestedAgents ?? [], skillsCliVersion: '1.5.23', collisions: [], dependencies: [],
    materializationDigest: 'sha256:portable', configDigest: 'sha256:config',
    evidenceDigest: JSON.stringify({ scope: intent.scope, selected: selected.map((candidate) => candidate.name) }),
  };
}

function portableReceipt(intent, verified) {
  const portable = portableReview(intent);
  return {
    receiptSchemaVersion: 5, command: 'skill:install', ok: verified, status: verified ? 'succeeded' : 'partial',
    plugin: { id: intent.pluginId }, scope: intent.scope, selectedSkills: portable.selected,
    requestedSkills: intent.selectedSkills, agentMode: portable.agentMode, requestedAgents: portable.requestedAgents,
    skillsCliVersion: portable.skillsCliVersion, collisions: [], dependencies: [],
    materializationDigest: portable.materializationDigest,
    verification: verified
      ? { records: portable.selected.map((skill) => ({ name: skill.name, scope: intent.scope, agents: ['codex'] })), missing: [], unknown: [] }
      : { records: [], missing: [], unknown: portable.selected.map((skill) => ({ skill: skill.name, agent: 'codex' })) },
    warnings: [], failures: verified ? [] : [{ code: 'portableSkillsCliVerificationFailed', message: '无法确认。', recovery: '重新检查。' }],
  };
}

function requiredEnvironment() {
  const names = ['HOME', 'AW_HOME', 'AW_CODEX_HOME', 'AW_CLAUDE_HOME'];
  const values = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  if (names.some((name) => !values[name])) {
    throw new Error(`missing isolated environment: ${names.filter((name) => !values[name]).join(', ')}`);
  }
  const root = path.resolve(process.env.AW_PTY_SANDBOX_ROOT ?? '');
  if (!root || names.some((name) => !path.resolve(values[name]).startsWith(`${root}${path.sep}`))) {
    throw new Error('TUI PTY fixture homes must be below AW_PTY_SANDBOX_ROOT.');
  }
  return values;
}

const eventPath = process.env.AW_PTY_EVENT_LOG;
if (!eventPath) throw new Error('AW_PTY_EVENT_LOG is required.');
const scenario = process.env.AW_PTY_SCENARIO ?? 'browse';

function record(event) {
  fs.appendFileSync(eventPath, `${JSON.stringify({ at: Date.now(), ...event })}\n`, 'utf8');
}

const homes = requiredEnvironment();
record({
  type: 'fixture',
  fakeNative: true,
  fakeExecutor: true,
  scenario,
  sandboxRoot: process.env.AW_PTY_SANDBOX_ROOT,
  homes,
  tty: {
    stdin: Boolean(process.stdin.isTTY),
    stdout: Boolean(process.stdout.isTTY),
    columns: process.stdout.columns,
    rows: process.stdout.rows,
  },
});

const recordResize = () => {
  record({ type: 'resize', columns: process.stdout.columns, rows: process.stdout.rows });
};
process.stdout.on('resize', recordResize);

let configExecutionCount = 0;
let portablePrepareCaptureCount = 0;
let portableReviewBlocked = false;
let portableReviewPrepared = false;
const scopedReceipt = {
  schemaVersion: 1, kind: 'aw-recovery', scope: 'user', command: 'sync', ok: true,
  intent: { state: 'valid', roots: ['official/agent-lab'] },
  requestedRoots: ['official/agent-lab'], requestedTargets: [],
  selection: { agents: ['codex'], origin: 'preference', preferences: 'valid' },
  blockers: [], errors: [], targetResults: [], remainingTargets: [], recoveryActions: [],
  declarationChanged: false, preferencesChanged: false, configChanged: false,
  outputsMayHaveChanged: false,
};
const controller = new TuiController({
  prepareScopedTask: scenario === 'scoped-inventory' ? async (request) => {
    record({ type: 'scoped-prepare', scope: request.scope, selectors: request.selectors });
    return { kind: 'recovery', scope: request.scope, plan: {
      receipt: { ...scopedReceipt, scope: request.scope },
      plannedImpact: { declaration: false, preferences: false, config: false, outputs: true },
      changes: ['精确同步所选插件与工具'], warnings: [], context: { dispose: async () => {} },
      nativeGroups: [{ preview: { codexReconcilePlans: [{ review: {
        requiresConfirmation: true, sharedImpact: { warning: '共享原生内容可能影响其他项目。' },
      } }] } }], portableGroups: [],
    } };
  } : undefined,
  executeScopedTask: scenario === 'scoped-inventory' ? async (plan) => {
    record({ type: 'scoped-execute', scope: plan.scope });
    return { kind: 'recovery', receipt: { ...scopedReceipt, scope: plan.scope } };
  } : undefined,
  loadScopedStatus: async (scope) => {
    record({ type: 'scoped-status-load', scope });
    return { scope, intent: { state: 'valid' }, selection: { agents: ['codex'], preferences: 'valid' },
      inventory: [{ pluginId: 'official/agent-lab', source: 'official', sourceState: 'ready', blockers: [],
        targetResults: [{ pluginId: 'official/agent-lab', agent: 'codex', scope,
          delivery: { kind: 'native', platform: 'codex' }, execution: 'not-run', observation: 'missing',
          content: 'absent', blockers: [], requiredBy: [] }] }],
      extraObserved: [], errors: [], allSatisfied: false,
      nativeSnapshot: { payload: { ...loadResult().payload, targets: [] }, pluginSummaries: loadResult().pluginSummaries, targetRevisions: [], dependencyOverviews: [] } };
  },
  loadStatus: async () => {
    return loadResult();
  },
  captureEvidence: async (intent) => intent.kind === 'configSaveBatch'
    ? configEvidence(intent)
    : intent.kind === 'configSave' ? configRetryEvidence(intent)
      : intent.kind === 'portableInstall' ? (async () => {
            if (intent.selectedSkills.length === 0) portablePrepareCaptureCount += 1;
            else if (scenario === 'portable-flow') portableReviewPrepared = true;
            if (scenario === 'portable-flow' && !portableReviewPrepared
              && intent.selectedSkills.length === 0 && portablePrepareCaptureCount <= 2) {
              await new Promise((resolve) => setTimeout(resolve, 450));
            }
            if (scenario === 'portable-flow' && portableReviewPrepared && !portableReviewBlocked
              && intent.selectedSkills.length === 0 && portablePrepareCaptureCount <= 4) {
              if (portablePrepareCaptureCount === 4) portableReviewBlocked = true;
              throw Object.assign(new Error('synthetic portable validation failed'), {
                code: 'portableValidationFailed', diagnosticCode: 'portableSkillInvalid',
              });
            }
            const portable = portableReview(intent);
            if (scenario === 'portable-flow' && portablePrepareCaptureCount > 2) {
              portable.selected = [...portable.selected, {
                name: 'new-skill', description: '重查新增 Skill', providerPluginId: 'official/agent-lab',
                providerDisplayName: '代理实验室', relation: 'requested', dynamic: false, filesDigest: 'sha256:new',
              }];
            }
            return { catalog: { configDigest: 'sha256:config', compositeDigest: portable.evidenceDigest }, portable };
          })() : evidence,
  recheckPortableInstall: async (receipt) => {
    record({ type: 'portable-recheck', readOnly: true, selectedSkills: receipt.selectedSkills.map((skill) => skill.name) });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { ...receipt, ok: true, status: 'succeeded', verification: {
      records: receipt.selectedSkills.map((skill) => ({ name: skill.name, scope: receipt.scope, agents: ['codex'] })),
      missing: [], unknown: [],
    }, warnings: [], failures: [] };
  },
  executeIntent: async (intent) => {
    record({ type: 'fake-execute', intentKind: intent.kind });
    if (intent.kind === 'configSaveBatch') {
      configExecutionCount += 1;
      record({
        type: 'config-execute',
        attempt: configExecutionCount,
        scopes: intent.groups.map((group) => group.scope),
        updates: intent.groups.map((group) => ({
          scope: group.scope,
          keys: Object.keys(group.updates ?? {}),
          values: group.updates ?? {},
        })),
      });
      return partialConfigExecution(intent);
    }
    if (intent.kind === 'configSave') {
      configExecutionCount += 1;
      record({
        type: 'config-execute',
        attempt: configExecutionCount,
        scopes: [intent.scope],
        updates: [{
          scope: intent.scope,
          keys: Object.keys(intent.updates ?? {}),
          values: intent.updates ?? {},
        }],
        retryApply: intent.retryApply === true,
      });
      return successfulSingleConfigRetry();
    }
    if (intent.kind === 'portableInstall') {
      record({
        type: 'portable-execute',
        selectedSkills: intent.selectedSkills,
        agentMode: intent.requestedAgents === undefined ? 'automatic' : 'explicit',
        requestedAgents: intent.requestedAgents ?? [],
        scope: intent.scope,
      });
      return portableReceipt(intent, false);
    }
    if (intent.kind === 'pluginWrite') {
      return {
        platforms: [intent.platform],
        plugins: [intent.pluginId],
        warnings: [], rebuildResults: [], receiptTargets: [],
        targetResults: [{
          target: {
            pluginId: intent.pluginId,
            pluginName: intent.pluginId.split('/').at(-1),
            sourceId: intent.pluginId.split('/')[0],
            platform: intent.platform,
            scope: intent.scope,
          },
          action: intent.action,
          state: 'completed',
          requiredBy: [],
        }],
        overallState: 'succeeded',
      };
    }
    return { overallState: 'succeeded', targetResults: [] };
  },
  ...(scenario === 'source-check' ? {
    probeCatalogFreshness: async (sourceId) => {
      record({ type: 'source-probe-start', sourceId });
      await new Promise((resolve) => setTimeout(resolve, 450));
      record({ type: 'source-probe-failure', sourceId });
      throw new Error('synthetic offline source');
    },
  } : {}),
  ...(scenario === 'config-partial' ? {
    getConfigPage: async (pluginId, layer) => createConfigPage(pluginId, layer),
  } : {}),
  now: () => Date.now(),
});

const unsubscribe = controller.subscribe((snapshot) => {
  record({
    type: 'controller',
    phase: snapshot.phase,
    route: snapshot.router.current.route,
    context: snapshot.router.current.context,
    catalogFreshness: snapshot.catalogFreshness.map(({ sourceId, state }) => ({ sourceId, state })),
    catalogGenerations: snapshot.catalogGenerations.map(({ sourceId, state, active }) => ({
      sourceId,
      state,
      active: active ? { catalogVersion: active.catalogVersion, storeKey: active.storeKey } : undefined,
    })),
    activeReview: snapshot.activeReview ? {
      operationKind: snapshot.activeReview.operationKind,
      requiresConfirmation: snapshot.activeReview.requiresConfirmation,
    } : undefined,
    scopedInventories: Object.fromEntries(Object.entries(snapshot.scopedInventories).map(([scope, inventory]) =>
      [scope, inventory?.declaredRoots.map((root) => root.pluginId)])),
    portableDraft: snapshot.portableDraft ? {
      selected: snapshot.portableDraft.candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.name),
      candidates: snapshot.portableDraft.candidates.map((candidate) => candidate.name),
      agentMode: snapshot.portableDraft.agentMode,
      requestedAgents: snapshot.portableDraft.requestedAgents,
      scope: snapshot.portableDraft.scope,
    } : undefined,
    result: snapshot.result ? {
      state: snapshot.result.state,
      operationKind: snapshot.result.operationKind,
      summary: snapshot.result.summary,
    } : undefined,
  });
});

if (scenario !== 'browse') {
  await controller.load();
  if (scenario === 'native-install') {
    controller.push({ name: 'pluginList', mode: 'browse' });
    controller.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
  } else if (scenario === 'source-check') {
    controller.push({ name: 'sourceDetail', sourceId: 'team-tools' });
  } else if (scenario === 'config-partial') {
    controller.push({ name: 'pluginList', mode: 'installed' });
    controller.push({ name: 'pluginDetail', pluginId: CONFIG_PLUGIN_ID });
    controller.beginConfigFlow(CONFIG_PLUGIN_ID);
  } else if (scenario === 'scoped-inventory') {
    controller.push({ name: 'intentScopes' });
  } else if (scenario === 'portable-recheck') {
    controller.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    await controller.preparePortableInstall('official/agent-lab');
    controller.togglePortableSkill('author-skill');
    const review = await controller.buildPortableInstallReview();
    await controller.executeOperation(review.reviewToken);
  } else if (scenario === 'portable-flow') {
    controller.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
  } else {
    throw new Error(`unknown AW_PTY_SCENARIO: ${scenario}`);
  }
}

let exitCode = 1;
try {
  const result = await createInkTuiRunner().launch({
    input: process.stdin,
    output: process.stdout,
    render: (complete) => React.createElement(ConsoleAppV4, {
      controller,
      onExit: (request) => {
        record({ type: 'ui-exit-request', ...request });
        queueMicrotask(() => {
          complete({ exitCode: request.code, reason: request.reason });
          record({ type: 'runner-complete-returned' });
        });
      },
    }),
  });
  exitCode = result.exitCode;
  record({ type: 'exit', ...result });
} catch (error) {
  record({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  process.stdout.off('resize', recordResize);
  unsubscribe();
  controller.dispose();
}

process.exitCode = exitCode;
