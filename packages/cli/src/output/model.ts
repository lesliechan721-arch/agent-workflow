import type {
  CodexProjectManagedKind,
  CommandAction,
  NextStepInstruction,
  NextStepsPayloadBoundary,
  NativeRecoveryState,
  PlatformName,
  Scope,
} from '../types.js';

export type OutputLevel = 'success' | 'info' | 'notice' | 'warning' | 'debug';
export type OutputTarget = 'stdout' | 'stderr' | 'debugLog';
export type NativeEventPhase = 'start' | 'success' | 'error';

export interface NativeMarketplaceEventData {
  platform: PlatformName;
  scope: Scope;
  plugin: string;
  marketplaceName: string;
  marketplacePath: string;
  operation: 'add' | 'verify';
  phase: NativeEventPhase;
  errorCategory?: string;
  suggestion?: string;
}

export interface NativeRpcEventData {
  platform: PlatformName;
  scope: Scope;
  plugin: string;
  pluginId: string;
  method: 'plugin/install' | 'plugin/uninstall';
  phase: NativeEventPhase;
  durationMs: number;
  nativeWriteSucceeded?: boolean;
  errorCategory?: string;
  suggestion?: string;
}

export interface NativeRecoveryEventData {
  platform: PlatformName;
  scope: Scope;
  plugin: string;
  pluginId: string;
  operation: 'write' | 'update' | 'delete';
  phase: NativeEventPhase;
  state: NativeRecoveryState;
  nativeWriteSucceeded: boolean;
  recoveryBreadcrumbPersisted: boolean;
  errorCategory?: string;
  suggestion?: string;
}

export interface NativePostCheckEventData {
  platform: PlatformName;
  scope: Scope;
  plugin: string;
  pluginId: string;
  operation: 'install' | 'uninstall';
  phase: NativeEventPhase;
  pluginEnabled: boolean | null;
  configEntryPresent: boolean | null;
  pluginInstalled: boolean | null;
  activeCachePath: string | null;
  errorCategory?: string;
  suggestion?: string;
}

export interface NativeSkippedEventData {
  platform: PlatformName;
  scope: Scope;
  plugin: string;
  reason: string;
  requiresNativeRuntime: boolean;
  repoManagedArtifactKinds: CodexProjectManagedKind[];
}

export type CommandEventType =
  | 'native:marketplace'
  | 'native:rpc'
  | 'native:recovery'
  | 'native:post-check'
  | 'native:skipped'
  | string;

export type CommandEventData =
  | Record<string, unknown>
  | NativeMarketplaceEventData
  | NativeRpcEventData
  | NativeRecoveryEventData
  | NativePostCheckEventData
  | NativeSkippedEventData;

export interface CommandOutputSource {
  platform?: PlatformName;
  plugin?: string;
  scope?: Scope;
  action?: CommandAction | string;
}

export interface CommandEvent {
  type: CommandEventType;
  commandName?: string;
  message?: string;
  data?: CommandEventData;
  source?: CommandOutputSource;
  level?: OutputLevel;
  target?: OutputTarget;
}

export interface CommandNotice {
  level: OutputLevel;
  message: string;
  identity?: string;
  target?: OutputTarget;
  source?: CommandOutputSource;
}

export interface CommandReporter {
  event: (event: CommandEvent) => void | Promise<void>;
  notice: (notice: CommandNotice) => void | Promise<void>;
}

export interface DebugLogger {
  readonly logFile?: string;
  log: (event: CommandEvent) => void | Promise<void>;
  flush?: () => void | Promise<void>;
}

function ensureSentence(text: string): string {
  const normalized = text.trim();
  if (normalized === '') {
    return '';
  }
  return /[。！？]$/.test(normalized) ? normalized : `${normalized}。`;
}

export function createManualNextStep(
  label: string,
  description: string,
): NextStepInstruction {
  return {
    kind: 'manual',
    label,
    description,
  };
}

export function createCliCommandNextStep(
  label: string,
  description: string,
  command: string,
): NextStepInstruction {
  return {
    kind: 'cliCommand',
    label,
    description,
    command,
  };
}

export function createUiActionNextStep(
  label: string,
  description: string,
  uiAction: string,
  command?: string,
): NextStepInstruction {
  return {
    kind: 'uiAction',
    label,
    description,
    uiAction,
    ...(command ? { command } : {}),
  };
}

export function createLegacyNextStepText(step: NextStepInstruction): string {
  if (step.command) {
    return `${step.label}：${step.command}`;
  }
  return step.description.trim() === '' ? step.label : `${step.label}：${step.description}`;
}

export function dedupeNextSteps(steps: NextStepInstruction[]): NextStepInstruction[] {
  const seen = new Set<string>();
  const deduped: NextStepInstruction[] = [];
  for (const step of steps) {
    const key = [
      step.kind,
      step.label.trim(),
      step.description.trim(),
      step.uiAction ?? '',
      step.command ?? '',
    ].join('\0');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(step);
  }
  return deduped;
}

export function createNextStepsBoundary(
  steps: NextStepInstruction[],
  legacyNextSteps?: string[],
): NextStepsPayloadBoundary {
  const nextSteps = dedupeNextSteps(steps);
  const legacy = legacyNextSteps ?? nextSteps.map(createLegacyNextStepText);
  return {
    nextStepsSchemaVersion: 1,
    nextSteps,
    ...(legacy.length > 0 ? { legacyNextSteps: [...new Set(legacy)] } : {}),
  };
}

export function formatNextStepForHuman(step: NextStepInstruction | string): string {
  if (typeof step === 'string') {
    return ensureSentence(step);
  }
  const label = ensureSentence(step.label);
  if (step.command) {
    return `${label}运行 ${step.command} 后，${ensureSentence(step.description)}`;
  }
  return `${label}${ensureSentence(step.description)}`;
}

export function formatNextStepForUi(step: NextStepInstruction | string): string {
  if (typeof step === 'string') {
    return step;
  }
  if (step.description.trim() === '') {
    return step.label;
  }
  return `${step.label}：${step.description}`;
}

export function stripCommandFromNextStep(step: NextStepInstruction): NextStepInstruction {
  const base = {
    label: step.label,
    description: step.description,
  };
  if (step.kind === 'uiAction' && step.uiAction) {
    return {
      kind: 'uiAction',
      ...base,
      uiAction: step.uiAction,
    };
  }
  return {
    kind: step.uiAction ? 'uiAction' : 'manual',
    ...base,
    ...(step.uiAction ? { uiAction: step.uiAction } : {}),
  };
}

export function createLegacyCommandNextStep(
  command: string,
  options: {
    label?: string;
    description?: string;
    uiAction?: string;
  } = {},
): NextStepInstruction {
  if (options.uiAction) {
    return createUiActionNextStep(
      options.label ?? '继续处理',
      options.description ?? '可以进入下一步处理流程。',
      options.uiAction,
      command,
    );
  }
  return createCliCommandNextStep(
    options.label ?? '继续处理',
    options.description ?? '可以进入下一步处理流程。',
    command,
  );
}
