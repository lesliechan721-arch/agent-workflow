import type { CommandAction, PlatformName, Scope } from '../types.js';

export type OutputLevel = 'success' | 'info' | 'notice' | 'warning' | 'debug';
export type OutputTarget = 'stdout' | 'stderr' | 'debugLog';

export interface CommandOutputSource {
  platform?: PlatformName;
  plugin?: string;
  scope?: Scope;
  action?: CommandAction | string;
}

export interface CommandEvent {
  type: string;
  commandName?: string;
  message?: string;
  data?: Record<string, unknown>;
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
