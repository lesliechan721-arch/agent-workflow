export const CONFIG_PLUGIN_ID = 'team-tools/review-gate';

function field(key, title, type, extra = {}) {
  const base = {
    key,
    title,
    type,
    definition: { type },
    displayValue: '未设置',
    required: false,
    sensitive: false,
    writable: true,
    dirty: false,
    inherited: true,
    configured: false,
    sourceLabel: '插件默认',
    effectiveDisplayValue: '未设置',
    effectiveSourceLabel: '插件默认',
    allowCustom: true,
    advanced: false,
  };
  return { ...base, ...extra };
}

export function createConfigPage(pluginId, layer) {
  return {
    pluginId,
    layer,
    storedCount: 0,
    presets: [],
    groups: [{
      id: 'basic',
      title: '基本设置',
      advanced: false,
      fields: [
        field('profile', '审查 Profile', 'object', {
          definition: {
            type: 'object',
            properties: {
              model: { type: 'string', title: '模型', required: true, validation: { minLength: 1 } },
              reasoningEffort: {
                type: 'string',
                title: '推理强度',
                required: true,
                choices: {
                  allowCustom: false,
                  presets: [
                    { id: 'low', title: 'low', value: 'low' },
                    { id: 'medium', title: 'medium', value: 'medium' },
                    { id: 'high', title: 'high', value: 'high', recommended: true },
                    { id: 'xhigh', title: 'xhigh', value: 'xhigh' },
                    { id: 'max', title: 'max', value: 'max' },
                    { id: 'ultra', title: 'ultra', value: 'ultra' },
                  ],
                },
              },
            },
            additionalProperties: false,
            validation: { minProperties: 2, maxProperties: 2 },
            default: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
          },
          required: true,
          displayValue: '模型=gpt-5.6-sol · 推理强度=high',
          effectiveDisplayValue: '模型=gpt-5.6-sol · 推理强度=high',
          effectiveSourceLabel: '插件默认',
          effectiveValue: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
          draftValue: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
        }),
        field('enabled', '启用审查', 'boolean', {
          definition: { type: 'boolean' },
          displayValue: '关闭',
          effectiveDisplayValue: '关闭',
          effectiveSourceLabel: '插件默认',
          effectiveValue: false,
          draftValue: false,
        }),
      ],
    }],
  };
}

export function configEvidence(intent) {
  return {
    catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
    source: {
      sourceId: 'team-tools', sourceIdentity: 'identity:team-tools',
      snapshotDigest: 'sha256:snapshot', contentDigest: 'sha256:content',
    },
    configBatch: {
      groups: intent.groups.map((group) => ({
        scope: group.scope,
        targetFingerprint: `sha256:config-${group.scope}`,
        config: {
          scope: group.scope,
          storeDigest: `sha256:store-${group.scope}`,
          impactState: 'known',
          affectedTargets: [{ platform: 'codex', scope: group.scope }],
        },
      })),
    },
  };
}

export function configRetryEvidence(intent) {
  return {
    catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
    source: {
      sourceId: 'team-tools', sourceIdentity: 'identity:team-tools',
      snapshotDigest: 'sha256:snapshot', contentDigest: 'sha256:content',
    },
    config: {
      scope: intent.scope,
      storeDigest: `sha256:store-${intent.scope}`,
      impactState: 'known',
      affectedTargets: [{ platform: 'codex', scope: intent.scope }],
    },
  };
}

export function partialConfigExecution(intent) {
  return {
    status: 'partial',
    groups: intent.groups.map((group) => group.scope === 'project'
      ? {
          scope: group.scope,
          status: 'failed',
          configSaved: true,
          applyRequested: true,
          applyStatus: 'failed',
          errorCode: 'runtimeApplyFailed',
        }
      : {
          scope: group.scope,
          status: 'failed',
          configSaved: false,
          applyRequested: true,
          applyStatus: 'notRequested',
          errorCode: 'configWriteFailed',
        }),
  };
}

export function successfulSingleConfigRetry() {
  return {
    configWrite: 'succeeded',
    overallState: 'succeeded',
    apply: { state: 'succeeded', targetResults: [] },
  };
}
