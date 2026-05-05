import type { EnvironmentDetection, PlatformName, PluginManifestSource, PluginMeta, ResolvedInstallOptions, Scope, SkillTriggerPreference } from '../types.js';
import {
  createPluginConfigFormModel,
  createPluginConfigSchemaIdentity,
  resolveEffectivePluginConfig,
  type PluginConfigFormModel,
  type ResolvedEffectivePluginConfig,
} from '../utils/plugin-config.js';
import type { ResolvedPluginTarget } from './common.js';
import type { PluginConsoleActionKind } from './console-model.js';
import { getCodexProjectInstallability } from './codex-project-installability.js';
import {
  CodexProjectWriteSafetyError,
  preflightCodexProjectWriteSafety,
} from './codex-project-safety.js';
import { canExecuteCodexProjectWithoutNative } from './platform-resolution.js';

export type ConsoleWriteWizardOperation = 'install' | 'upgrade';
export type ConsoleWriteIntent = ConsoleWriteWizardOperation | 'repairInstall' | 'cleanupRecovery';

export type ConsoleWriteBlockedReasonCode =
  | 'unsupportedProjectTarget'
  | 'userCodexConfigUnreadable'
  | 'projectCodexConfigUnreadable'
  | 'externalOwnership'
  | 'trackingIdentityBroken'
  | 'roleOrMcpConflict'
  | 'unmanagedArtifactConflict'
  | 'catalogUnavailable'
  | 'cleanupRecoveryUnmatched'
  | 'custom';

export interface ConsoleWriteBlockedReason {
  code: ConsoleWriteBlockedReasonCode;
  message: string;
  nextSteps: string[];
}

export interface ConsoleWritePreflightResult {
  ok: boolean;
  operation: ConsoleWriteWizardOperation;
  blockedReason?: ConsoleWriteBlockedReason;
  nextSteps: string[];
  notes: string[];
}

export interface ConsoleRequiredConfigPrompt {
  pluginName: string;
  schemaSourceIdentity: string;
  manifest: PluginManifestSource;
  effective: ResolvedEffectivePluginConfig;
  form: PluginConfigFormModel;
}

export interface ConsoleSkillTriggerOption {
  value: SkillTriggerPreference;
  label: '默认' | '手动' | '自动';
}

export interface ConsoleSkillTriggerDecision {
  show: boolean;
  selected: SkillTriggerPreference;
  options: ConsoleSkillTriggerOption[];
}

export type ConsoleWizardStepStatus = 'completed' | 'ready' | 'blocked' | 'skipped';

export interface ConsoleWizardStep {
  kind:
    | 'selectPlugin'
    | 'selectPlatform'
    | 'selectLocation'
    | 'selectSkillTrigger'
    | 'readOnlyPreflight'
    | 'requiredConfig'
    | 'runCommand';
  status: ConsoleWizardStepStatus;
  detail?: string;
}

export interface ConsoleInstallWizardDecision {
  intent: ConsoleWriteIntent;
  operation: ConsoleWriteWizardOperation;
  commandAction: 'install' | 'upgrade' | 'uninstall';
  steps: ConsoleWizardStep[];
  blockedReason?: ConsoleWriteBlockedReason;
  nextSteps: string[];
  notes: string[];
  shouldPromptConfig: boolean;
  configPrompts: ConsoleRequiredConfigPrompt[];
  skillTrigger: ConsoleSkillTriggerDecision;
}

export type ConsoleWriteActionPlan =
  | {
    kind: 'wizardWrite';
    operation: ConsoleWriteWizardOperation;
    intent: ConsoleWriteIntent;
  }
  | {
    kind: 'directCommand';
    operation: 'uninstall';
    intent: ConsoleWriteIntent;
  };

export interface ResolveConsoleWriteActionPlanOptions {
  intent: ConsoleWriteIntent;
  repairOperation?: ConsoleWriteWizardOperation;
  cleanupRecoveryEvidenceMatches?: boolean;
}

export interface PrepareConsoleWritePreflightOptions {
  intent: ConsoleWriteIntent;
  repairOperation?: ConsoleWriteWizardOperation;
  cleanupRecoveryEvidenceMatches?: boolean;
  targets: ResolvedPluginTarget[];
  platforms: PlatformName[];
  cwd: string;
  scope: Scope;
  env?: NodeJS.ProcessEnv;
  detection?: EnvironmentDetection;
  additionalChecks?: Array<
    (context: {
      operation: ConsoleWriteWizardOperation;
      targets: ResolvedPluginTarget[];
      platforms: PlatformName[];
      cwd: string;
      scope: Scope;
      env?: NodeJS.ProcessEnv;
      detection?: EnvironmentDetection;
    }) => Promise<ConsoleWriteBlockedReason | null> | ConsoleWriteBlockedReason | null
  >;
}

export interface ResolveConsoleRequiredConfigPromptsOptions {
  targets: ResolvedPluginTarget[];
  cwd: string;
  defaultScope: Scope;
  env?: NodeJS.ProcessEnv;
}

export interface CreateInstallWizardDecisionOptions {
  intent: ConsoleWriteIntent;
  targets: ResolvedPluginTarget[];
  platforms: PlatformName[];
  cwd: string;
  scope: Scope;
  env?: NodeJS.ProcessEnv;
  detection?: EnvironmentDetection;
  resolvedInstallOptions?: Array<{
    platform: PlatformName;
    pluginName: string;
    options: ResolvedInstallOptions;
  }>;
  preparePreflight?: (
    options: PrepareConsoleWritePreflightOptions,
  ) => Promise<ConsoleWritePreflightResult>;
  resolveRequiredConfigPrompts?: (
    options: ResolveConsoleRequiredConfigPromptsOptions,
  ) => Promise<ConsoleRequiredConfigPrompt[]>;
  repairOperation?: ConsoleWriteWizardOperation;
  cleanupRecoveryEvidenceMatches?: boolean;
  additionalChecks?: PrepareConsoleWritePreflightOptions['additionalChecks'];
}

export interface ExecuteInstallWizardDecisionOptions<T> {
  decision: ConsoleInstallWizardDecision;
  promptRequiredConfig?: (
    prompts: ConsoleRequiredConfigPrompt[],
  ) => Promise<void>;
  runCommand: (decision: ConsoleInstallWizardDecision) => Promise<T>;
}

export interface ExecuteInstallWizardDecisionResult<T> {
  blocked: boolean;
  promptedConfig: boolean;
  decision: ConsoleInstallWizardDecision;
  commandResult?: T;
}

const SKILL_TRIGGER_OPTIONS: ConsoleSkillTriggerOption[] = [
  { value: 'default', label: '默认' },
  { value: 'manual', label: '手动' },
  { value: 'auto', label: '自动' },
];

function resolveWizardOperation(
  options: ResolveConsoleWriteActionPlanOptions,
): ConsoleWriteWizardOperation {
  if (options.intent === 'repairInstall') {
    return options.repairOperation ?? 'install';
  }

  if (options.intent === 'cleanupRecovery') {
    throw new Error('cleanupRecovery does not map to an install/upgrade wizard operation.');
  }

  return options.intent;
}

export function resolveConsoleWriteActionPlan(
  options: ResolveConsoleWriteActionPlanOptions,
): ConsoleWriteActionPlan | ConsoleWriteBlockedReason {
  if (options.intent === 'cleanupRecovery') {
    if (options.cleanupRecoveryEvidenceMatches === true) {
      return {
        kind: 'directCommand',
        operation: 'uninstall',
        intent: options.intent,
      };
    }

    return {
      code: 'cleanupRecoveryUnmatched',
      message: '这次 recovery breadcrumb 证据不匹配，不能直接执行清理。',
      nextSteps: [
        '先查看诊断，确认当前残留是否属于这次未完成安装。',
        '若归属不明确，优先走卸载或人工清理，而不是自动接管。',
      ],
    };
  }

  return {
    kind: 'wizardWrite',
    operation: resolveWizardOperation(options),
    intent: options.intent,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}

function createUnsupportedProjectTargetReason(
  targets: ResolvedPluginTarget[],
  scope: Scope,
  platforms: PlatformName[],
): ConsoleWriteBlockedReason | null {
  if (scope !== 'project' || !platforms.includes('codex')) {
    return null;
  }

  const unsupported = targets
    .map((target) => {
      const installability = getCodexProjectInstallability(target.currentPlugin ?? target.plugin);
      return installability.installable
        ? null
        : {
            pluginName: target.pluginName,
            reason: installability.reason ?? `${target.pluginName} 当前不能安装到 Codex project。`,
          };
    })
    .filter((entry): entry is { pluginName: string; reason: string } => Boolean(entry));

  if (unsupported.length === 0) {
    return null;
  }

  return {
    code: 'unsupportedProjectTarget',
    message: `当前项目位置不支持这组安装目标：${unsupported.map((entry) => entry.reason).join('；')}`,
    nextSteps: [
      '改为安装到个人位置，或拆分插件能力后再试。',
    ],
  };
}

function mapWriteSafetyErrorToBlockedReason(
  error: CodexProjectWriteSafetyError,
): ConsoleWriteBlockedReason {
  switch (error.code) {
    case 'codexProjectUserConfigUnreadable':
      return {
        code: 'userCodexConfigUnreadable',
        message: error.message,
        nextSteps: [
          '先修复用户级 Codex 配置的语法或内容，再重新打开安装/升级向导。',
        ],
      };
    case 'projectConfigUnreadable':
      return {
        code: 'projectCodexConfigUnreadable',
        message: error.message,
        nextSteps: [
          '先修复当前项目的 Codex 配置文件，再继续写入当前项目目标。',
        ],
      };
    case 'externalOwnershipPresent':
      return {
        code: 'externalOwnership',
        message: error.message,
        nextSteps: [
          '先处理同名外部来源的安装，再回到 AW 继续。',
          '如果你想保留现状，可以改选别的平台或位置。',
        ],
      };
    case 'trackingIntegrityError':
      return {
        code: 'trackingIdentityBroken',
        message: error.message,
        nextSteps: [
          '先修复 tracking identity，再决定是继续升级还是先卸载重装。',
        ],
      };
    case 'roleNameConflict':
      return {
        code: 'roleOrMcpConflict',
        message: error.message,
        nextSteps: [
          '先处理同名 role 或 MCP 冲突，再继续安装/升级。',
        ],
      };
    case 'unmanagedRepoArtifactConflict':
      return {
        code: 'unmanagedArtifactConflict',
        message: error.message,
        nextSteps: [
          '先确认冲突文件归属；不要在归属不明时让 AW 自动接管。',
        ],
      };
    case 'catalogNotCurrent':
      return {
        code: 'catalogUnavailable',
        message: error.message,
        nextSteps: [
          '先卸载当前残留，或恢复 current catalog 后再继续。',
        ],
      };
  }
}

function createCodexProjectNativeOptionalNote(options: {
  detection?: EnvironmentDetection;
  scope: Scope;
  platforms: PlatformName[];
  targets: ResolvedPluginTarget[];
  operation: ConsoleWriteWizardOperation;
}): string | null {
  if (options.scope !== 'project' || !options.platforms.includes('codex')) {
    return null;
  }

  if (options.detection?.codex.available !== false) {
    return null;
  }

  const plugins = options.targets.map((target) => target.currentPlugin ?? target.plugin);
  if (!canExecuteCodexProjectWithoutNative({
    action: options.operation,
    scope: options.scope,
    plugins,
  })) {
    return null;
  }

  return '当前环境没有可用的 Codex native runner，但这个目标只会写当前项目文件，所以仍然可以继续。';
}

export async function prepareConsoleWritePreflight(
  options: PrepareConsoleWritePreflightOptions,
): Promise<ConsoleWritePreflightResult> {
  const actionPlan = resolveConsoleWriteActionPlan({
    intent: options.intent,
    repairOperation: options.repairOperation,
    cleanupRecoveryEvidenceMatches: options.cleanupRecoveryEvidenceMatches,
  });
  if ('code' in actionPlan) {
    return {
      ok: false,
      operation: 'install',
      blockedReason: actionPlan,
      nextSteps: [...actionPlan.nextSteps],
      notes: [],
    };
  }

  if (actionPlan.kind !== 'wizardWrite') {
    return {
      ok: false,
      operation: 'install',
      blockedReason: {
        code: 'custom',
        message: `${options.intent} 不是 install/upgrade 向导预检目标。`,
        nextSteps: [],
      },
      nextSteps: [],
      notes: [],
    };
  }

  const blockedByInstallability = createUnsupportedProjectTargetReason(
    options.targets,
    options.scope,
    options.platforms,
  );
  if (blockedByInstallability) {
    return {
      ok: false,
      operation: actionPlan.operation,
      blockedReason: blockedByInstallability,
      nextSteps: [...blockedByInstallability.nextSteps],
      notes: [],
    };
  }

  const notes = uniqueStrings([
    createCodexProjectNativeOptionalNote({
      detection: options.detection,
      scope: options.scope,
      platforms: options.platforms,
      targets: options.targets,
      operation: actionPlan.operation,
    }) ?? '',
  ]);

  try {
    await preflightCodexProjectWriteSafety({
      targets: options.targets,
      platforms: options.platforms,
      cwd: options.cwd,
      scope: options.scope,
      env: options.env,
      operation: actionPlan.operation,
    });
  } catch (error) {
    if (error instanceof CodexProjectWriteSafetyError) {
      const blockedReason = mapWriteSafetyErrorToBlockedReason(error);
      return {
        ok: false,
        operation: actionPlan.operation,
        blockedReason,
        nextSteps: [...blockedReason.nextSteps],
        notes,
      };
    }
    throw error;
  }

  for (const check of options.additionalChecks ?? []) {
    const result = await check({
      operation: actionPlan.operation,
      targets: options.targets,
      platforms: options.platforms,
      cwd: options.cwd,
      scope: options.scope,
      env: options.env,
      detection: options.detection,
    });
    if (!result) {
      continue;
    }
    return {
      ok: false,
      operation: actionPlan.operation,
      blockedReason: result,
      nextSteps: [...result.nextSteps],
      notes,
    };
  }

  return {
    ok: true,
    operation: actionPlan.operation,
    nextSteps: [],
    notes,
  };
}

function createConfigPromptDetail(prompts: ConsoleRequiredConfigPrompt[]): string {
  if (prompts.length === 0) {
    return '不需要补充必填配置';
  }

  if (prompts.length === 1) {
    return `${prompts[0].pluginName} 需要补充必填配置`;
  }

  return `${prompts.length} 个插件需要补充必填配置`;
}

export async function resolveConsoleRequiredConfigPrompts(
  options: ResolveConsoleRequiredConfigPromptsOptions,
): Promise<ConsoleRequiredConfigPrompt[]> {
  const prompts: ConsoleRequiredConfigPrompt[] = [];
  const visited = new Set<string>();

  for (const target of options.targets) {
    const plugin = target.currentPlugin ?? target.plugin;
    if (!plugin.manifest.config?.schema) {
      continue;
    }

    const schemaSourceIdentity = createPluginConfigSchemaIdentity(plugin.manifest);
    const dedupeKey = `${target.pluginName}\0${schemaSourceIdentity}`;
    if (visited.has(dedupeKey)) {
      continue;
    }
    visited.add(dedupeKey);

    const effective = await resolveEffectivePluginConfig({
      pluginName: target.pluginName,
      manifest: plugin.manifest,
      cwd: options.cwd,
      env: options.env,
    });
    const blockingIssues = effective.issues.filter((issue) =>
      issue.type === 'missing-required' || issue.type === 'invalid-config',
    );
    if (blockingIssues.length === 0) {
      continue;
    }

    prompts.push({
      pluginName: target.pluginName,
      schemaSourceIdentity,
      manifest: plugin.manifest,
      effective,
      form: createPluginConfigFormModel({
        pluginName: target.pluginName,
        manifest: plugin.manifest,
        effective,
        initialScope: options.defaultScope,
        allowedScopes: ['user', 'project'],
      }),
    });
  }

  return prompts;
}

function createSkillTriggerDecision(
  resolvedInstallOptions: CreateInstallWizardDecisionOptions['resolvedInstallOptions'],
): ConsoleSkillTriggerDecision {
  const overridable = (resolvedInstallOptions ?? [])
    .map((entry) => entry.options)
    .filter((entry): entry is Extract<ResolvedInstallOptions, { applicability: 'overridable' }> =>
      entry.applicability === 'overridable',
    );

  if (overridable.length === 0) {
    return {
      show: false,
      selected: 'default',
      options: [...SKILL_TRIGGER_OPTIONS],
    };
  }

  const selected = uniqueStrings(
    overridable.map((entry) => entry.skillTriggerPreference),
  );

  return {
    show: true,
    selected: selected.length === 1
      ? selected[0] as SkillTriggerPreference
      : 'default',
    options: [...SKILL_TRIGGER_OPTIONS],
  };
}

function createBaseSteps(skillTrigger: ConsoleSkillTriggerDecision): ConsoleWizardStep[] {
  return [
    { kind: 'selectPlugin', status: 'completed' },
    { kind: 'selectPlatform', status: 'completed' },
    { kind: 'selectLocation', status: 'completed' },
    {
      kind: 'selectSkillTrigger',
      status: skillTrigger.show ? 'ready' : 'skipped',
      ...(skillTrigger.show ? { detail: '可选：默认 / 手动 / 自动' } : {}),
    },
  ];
}

export async function createInstallWizardDecision(
  options: CreateInstallWizardDecisionOptions,
): Promise<ConsoleInstallWizardDecision> {
  const actionPlan = resolveConsoleWriteActionPlan({
    intent: options.intent,
    repairOperation: options.repairOperation,
    cleanupRecoveryEvidenceMatches: options.cleanupRecoveryEvidenceMatches,
  });

  if ('code' in actionPlan) {
    return {
      intent: options.intent,
      operation: options.intent === 'upgrade' ? 'upgrade' : 'install',
      commandAction: 'uninstall',
      steps: [
        ...createBaseSteps({
          show: false,
          selected: 'default',
          options: [...SKILL_TRIGGER_OPTIONS],
        }),
        { kind: 'readOnlyPreflight', status: 'blocked', detail: actionPlan.message },
        { kind: 'requiredConfig', status: 'skipped' },
        { kind: 'runCommand', status: 'skipped' },
      ],
      blockedReason: actionPlan,
      nextSteps: [...actionPlan.nextSteps],
      notes: [],
      shouldPromptConfig: false,
      configPrompts: [],
      skillTrigger: {
        show: false,
        selected: 'default',
        options: [...SKILL_TRIGGER_OPTIONS],
      },
    };
  }

  if (actionPlan.kind !== 'wizardWrite') {
    throw new Error(`Unsupported action plan kind "${actionPlan.kind}" for install wizard.`);
  }

  const skillTrigger = createSkillTriggerDecision(options.resolvedInstallOptions);
  const steps = createBaseSteps(skillTrigger);
  const preflight = await (options.preparePreflight ?? prepareConsoleWritePreflight)({
    intent: options.intent,
    repairOperation: options.repairOperation,
    cleanupRecoveryEvidenceMatches: options.cleanupRecoveryEvidenceMatches,
    targets: options.targets,
    platforms: options.platforms,
    cwd: options.cwd,
    scope: options.scope,
    env: options.env,
    detection: options.detection,
    additionalChecks: options.additionalChecks,
  });

  if (!preflight.ok) {
    return {
      intent: options.intent,
      operation: preflight.operation,
      commandAction: actionPlan.operation,
      steps: [
        ...steps,
        { kind: 'readOnlyPreflight', status: 'blocked', detail: preflight.blockedReason?.message },
        { kind: 'requiredConfig', status: 'skipped' },
        { kind: 'runCommand', status: 'skipped' },
      ],
      blockedReason: preflight.blockedReason,
      nextSteps: [...preflight.nextSteps],
      notes: [...preflight.notes],
      shouldPromptConfig: false,
      configPrompts: [],
      skillTrigger,
    };
  }

  const configPrompts = await (options.resolveRequiredConfigPrompts ?? resolveConsoleRequiredConfigPrompts)({
    targets: options.targets,
    cwd: options.cwd,
    defaultScope: options.scope,
    env: options.env,
  });

  return {
    intent: options.intent,
    operation: preflight.operation,
    commandAction: actionPlan.operation,
    steps: [
      ...steps,
      { kind: 'readOnlyPreflight', status: 'completed' },
      {
        kind: 'requiredConfig',
        status: configPrompts.length > 0 ? 'ready' : 'completed',
        detail: createConfigPromptDetail(configPrompts),
      },
      { kind: 'runCommand', status: 'ready' },
    ],
    nextSteps: [],
    notes: [...preflight.notes],
    shouldPromptConfig: configPrompts.length > 0,
    configPrompts,
    skillTrigger,
  };
}

export async function executeInstallWizardDecision<T>(
  options: ExecuteInstallWizardDecisionOptions<T>,
): Promise<ExecuteInstallWizardDecisionResult<T>> {
  if (options.decision.blockedReason) {
    return {
      blocked: true,
      promptedConfig: false,
      decision: options.decision,
    };
  }

  let promptedConfig = false;
  if (options.decision.shouldPromptConfig && options.decision.configPrompts.length > 0) {
    if (!options.promptRequiredConfig) {
      throw new Error('Missing promptRequiredConfig handler for a wizard decision that requires config input.');
    }
    await options.promptRequiredConfig(options.decision.configPrompts);
    promptedConfig = true;
  }

  const commandResult = await options.runCommand(options.decision);
  return {
    blocked: false,
    promptedConfig,
    decision: options.decision,
    commandResult,
  };
}

export function createResolvedInstallOptionEntry(
  platform: PlatformName,
  plugin: PluginMeta,
  options: ResolvedInstallOptions,
): {
  platform: PlatformName;
  pluginName: string;
  options: ResolvedInstallOptions;
} {
  return {
    platform,
    pluginName: plugin.manifest.name,
    options,
  };
}

export function isConsoleWriteWizardAction(
  action: PluginConsoleActionKind,
): action is 'openInstallWizard' | 'runUpgrade' | 'repairInstall' {
  return action === 'openInstallWizard' ||
    action === 'runUpgrade' ||
    action === 'repairInstall';
}
