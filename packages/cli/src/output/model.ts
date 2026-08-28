import type {
  CodexProjectManagedKind,
  CommandAction,
  PlatformName,
  RebuildActionEvent as SharedRebuildActionEvent,
  RebuildActionEventData as SharedRebuildActionEventData,
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
  operation: 'add' | 'list' | 'remove' | 'verify';
  phase: NativeEventPhase;
  errorCategory?: string;
  suggestion?: string;
}

export interface NativeRpcEventData {
  platform: PlatformName;
  scope: Scope;
  plugin: string;
  pluginId: string;
  method:
    | 'plugin/install'
    | 'plugin/uninstall'
    | 'codex plugin add'
    | 'codex plugin remove';
  phase: NativeEventPhase;
  durationMs: number;
  nativeWriteSucceeded?: boolean;
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

export type RebuildActionEventData = SharedRebuildActionEventData;
export type RebuildActionEvent = SharedRebuildActionEvent;

export type CommandEventType =
  | 'native:marketplace'
  | 'native:rpc'
  | 'native:post-check'
  | 'native:skipped'
  | string;

export type CommandEventData =
  | Record<string, unknown>
  | RebuildActionEventData
  | NativeMarketplaceEventData
  | NativeRpcEventData
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
