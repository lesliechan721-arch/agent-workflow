import { createElement } from 'react';

import type { PlatformSelection, PluginConfigSchemaField, Scope } from '../types.js';
import { createRebuildProgressFeed } from '../output/rebuild-progress.js';
import { CommandWizard } from '../tui/wizard.js';
import type { LiveConsoleItem, LiveStatusTarget } from './status.js';
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
  description?: string;
  targets: LiveStatusTarget[];
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
  error?: unknown;
}

export function toWizardCandidates(items: LiveConsoleItem[]): CommandWizardPluginCandidate[] {
  return items.map((item) => ({
    pluginName: item.pluginName,
    description: item.plugin?.manifest.description,
    targets: item.targets,
    configSchema: item.plugin?.manifest.config?.schema,
  }));
}

export async function runCommandWizard<T>(
  context: CliExecutionContext,
  request: CommandWizardRequest<T>,
): Promise<CommandWizardResult<T>> {
  const progress = createRebuildProgressFeed();
  const sessionReporter: CommandReporter = {
    event: (event) => progress.addEvent(event),
    notice: (notice) => progress.addNotice(notice),
  };
  const result = await withCommandReporterSession(context.reporter, sessionReporter, () =>
    context.tuiRunner.launch<CommandWizardResult<T>>({
      input: context.stdin,
      output: context.tuiOutput,
      render: (complete) => createElement(CommandWizard<T>, {
        request,
        progress,
        onComplete: complete,
      }),
    }));
  if (result.error !== undefined) throw result.error;
  return result;
}
