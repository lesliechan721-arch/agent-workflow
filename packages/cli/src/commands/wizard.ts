import { createElement } from 'react';

import type { PlatformSelection, PluginConfigSchemaField, Scope } from '../types.js';
import { createRebuildProgressFeed } from '../output/rebuild-progress.js';
import { CommandWizard } from '../tui/wizard.js';
import type { LiveConsoleItem, StatusV6Target } from './status-v6.js';
import {
  type CliExecutionContext,
  type CommandReporter,
  withCommandReporterSession,
} from './runtime.js';

export type CommandWizardCommand =
  | 'install'
  | 'upgrade'
  | 'reinstall'
  | 'uninstall'
  | 'cleanup'
  | 'config:list'
  | 'config:get'
  | 'config:set'
  | 'config:unset'
  | 'config:reset';

export interface CommandWizardSelection {
  plugins: string[];
  platform?: PlatformSelection;
  scope?: Scope;
  projectLayer?: 'shared' | 'local';
  key?: string;
  value?: unknown;
}

export interface CommandWizardPluginCandidate {
  pluginName: string;
  pluginId?: string;
  sourceId?: string;
  sourceIdentity?: string;
  description?: string;
  targets: StatusV6Target[];
  configSchema?: Record<string, PluginConfigSchemaField>;
  configKeys?: string[];
}

export interface CommandWizardRequest<T> {
  command: CommandWizardCommand;
  candidates: CommandWizardPluginCandidate[];
  initial: CommandWizardSelection;
  pluginMode: 'none' | 'single' | 'multiple';
  valueJson?: boolean;
  promptForPlatform?: boolean;
  promptForScope?: boolean;
  promptForKey?: boolean;
  promptForValue?: boolean;
  destructive?: boolean;
  equivalentCommand: (selection: CommandWizardSelection) => string;
  equivalentCommandTokens?: (selection: CommandWizardSelection) => string[];
  commandIsTemplate?: (selection: CommandWizardSelection) => boolean;
  resultState?: (value: T) => 'succeeded' | 'failed';
  isPluginVisible?: (
    candidate: CommandWizardPluginCandidate,
    selection: CommandWizardSelection,
  ) => boolean;
  isPluginSelectable?: (
    candidate: CommandWizardPluginCandidate,
    selection: CommandWizardSelection,
  ) => { selectable: boolean; reason?: string };
  execute: (selection: CommandWizardSelection) => Promise<T>;
}

export interface CommandWizardResult<T> {
  cancelled: boolean;
  selection?: CommandWizardSelection;
  value?: T;
  failed?: boolean;
}

export const WIZARD_FAILURE_MESSAGE = '操作失败。详细原因请使用 --debug 查看日志。';

export class WizardExecutionError extends Error {
  readonly diagnostic: unknown;

  constructor(diagnostic: unknown) {
    super(WIZARD_FAILURE_MESSAGE);
    this.name = 'WizardExecutionError';
    this.diagnostic = diagnostic;
  }
}

export function toWizardCandidates(items: LiveConsoleItem[]): CommandWizardPluginCandidate[] {
  return items.map((item) => ({
    pluginName: item.pluginName,
    pluginId: item.pluginName,
    description: item.pluginSummary?.description,
    targets: item.targets,
    configSchema: item.pluginSummary?.configSchema,
  }));
}

export async function runCommandWizard<T>(
  context: CliExecutionContext,
  request: CommandWizardRequest<T>,
): Promise<CommandWizardResult<T>> {
  const progress = createRebuildProgressFeed();
  let diagnostic: unknown;
  const sessionReporter: CommandReporter = {
    event: (event) => progress.addEvent(event),
    notice: (notice) => progress.addNotice(notice),
  };
  const safeRequest: CommandWizardRequest<T> = {
    ...request,
    execute: async (selection) => {
      try {
        const value = await request.execute(selection);
        if (request.resultState?.(value) === 'failed') diagnostic = value;
        return value;
      } catch (error) {
        diagnostic = error;
        throw error;
      }
    },
  };
  const result = await withCommandReporterSession(context.reporter, sessionReporter, () =>
    context.tuiRunner.launch<CommandWizardResult<T>>({
      input: context.stdin,
      output: context.tuiOutput,
      render: (complete) => createElement(CommandWizard<T>, {
        request: safeRequest,
        progress,
        onComplete: complete,
      }),
    }));
  if (result.failed) throw new WizardExecutionError(diagnostic);
  return result;
}
