function projectTarget(pluginName, state) {
  const blocked = state === 'blocked';
  return {
    pluginName,
    pluginId: `official/${pluginName}`,
    sourceId: 'official',
    sourceIdentity: 'identity:official',
    version: '0.3.1',
    cwd: process.cwd(),
    platform: 'claude',
    scope: 'project',
    state: blocked ? 'blocked' : 'needsSync',
    components: [
      { kind: 'ownership', key: 'fixture', state: 'absent' },
      {
        kind: 'intent', key: 'desired', state: 'desired',
        metadata: { enabled: true, scopes: ['project'], relation: 'root' },
      },
    ],
    reasons: blocked
      ? [{ code: 'catalogSourceUnavailable', message: '来源当前不可用。', severity: 'blocking' }]
      : [],
    recoveryActions: [],
  };
}

export function withProjectRecoveryStatus(base) {
  const targets = [
    projectTarget('agent-lab', 'needsSync'),
    projectTarget('content-toolkit', 'needsSync'),
    projectTarget('source-blocked', 'blocked'),
  ];
  return {
    ...base,
    projectRoot: process.cwd(),
    projectIntent: {
      state: 'ready',
      roots: targets.map((target) => ({
        pluginId: target.pluginId,
        platforms: [target.platform],
      })),
    },
    payload: { ...base.payload, targets },
    pluginSummaries: targets.map((target) => ({
      pluginName: target.pluginName,
      pluginId: target.pluginId,
      displayName: target.pluginName === 'agent-lab' ? '代理实验室'
        : target.pluginName === 'content-toolkit' ? '内容工具包' : '受阻插件',
      description: '项目共享插件',
      version: target.version,
      supportedTargets: { codex: [], claude: ['project'] },
      configFieldCount: 0,
    })),
  };
}

function operationPlan(targets) {
  return {
    intentChanges: [],
    actions: [],
    changes: targets.map((target) => `${target.pluginId}:${target.platform}:${target.scope}:sync`),
    warnings: [],
    evidence: {
      catalogDigests: [{ sourceId: 'official', digest: 'sha256:catalog' }],
      intentDigests: [{ scope: 'project', digest: 'sha256:project-intent' }],
      configDigests: [],
      targetOwnerFingerprints: [],
    },
    planFingerprint: 'sha256:project-plan',
  };
}

export function projectBatchEvidence(intent) {
  const targets = intent.selection.targets;
  const receiptTargets = targets.map((target) => ({
    ...target,
    pluginName: target.pluginId.split('/').at(-1),
    sourceId: 'official',
  }));
  return {
    catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
    requestedPluginIds: [...new Set(targets.map((target) => target.pluginId))],
    projectIntentDigest: 'sha256:project-intent',
    groups: [{
      groupId: 'official\0claude\0project',
      sourceId: 'official',
      platform: 'claude',
      scope: 'project',
      requestedPluginIds: targets.map((target) => target.pluginId),
      executable: true,
      preview: {
        platforms: ['claude'],
        plugins: targets.map((target) => target.pluginId),
        warnings: [], rebuildResults: [], targetResults: [], receiptTargets,
        overallState: 'succeeded',
        operationPlan: operationPlan(targets),
      },
    }],
  };
}

export function projectBatchExecution(intent, attempt) {
  const targets = intent.selection.targets;
  const targetResults = targets.map((target) => {
    const failed = attempt === 1 && target.pluginId === 'official/content-toolkit';
    return {
      target: {
        ...target,
        pluginName: target.pluginId.split('/').at(-1),
        sourceId: 'official',
      },
      action: 'sync',
      state: failed ? 'failed' : 'completed',
      relation: 'requested',
      requiredBy: [],
      ...(failed ? { errorCode: 'preApplyExited' } : {}),
    };
  });
  const overallState = targetResults.some((target) => target.state === 'failed')
    ? targetResults.some((target) => target.state === 'completed') ? 'partial' : 'failed'
    : 'succeeded';
  const groupResult = {
    platforms: ['claude'],
    plugins: targets.map((target) => target.pluginId),
    warnings: [], rebuildResults: [], receiptTargets: [], targetResults, overallState,
  };
  return {
    ...groupResult,
    requestedPluginIds: targets.map((target) => target.pluginId),
    groupResults: [{
      groupId: 'official\0claude\0project',
      sourceId: 'official', platform: 'claude', scope: 'project',
      requestedPluginIds: targets.map((target) => target.pluginId),
      result: groupResult,
    }],
  };
}
