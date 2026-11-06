import type { Scope } from '../types.js';
import type { RebuildCommandRuntime } from './rebuild-command.js';
import {
  createEmptyPreferences,
  normalizeAgents,
  observePreferences,
  setExclusions,
  setTargets,
  type DeploymentPreferences,
} from '../intent/deployment-preferences.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { resolveWorkContext } from '../intent/work-context.js';
import { runRecovery } from '../recovery/coordinator.js';
import { validateExclusions } from '../recovery/joint-demand.js';
import { intentReceipt } from './intent-command.js';
import type { RecoveryReceipt } from '../recovery/receipt.js';

interface TargetsCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  context?: Scope;
  apply?: boolean;
  yes?: boolean;
  cliVersion?: string;
  runtime?: RebuildCommandRuntime;
}
interface TargetsCommandReceipt extends RecoveryReceipt {
  policy?: DeploymentPreferences;
  apply?: RecoveryReceipt;
}

function failure(error: unknown) {
  const code = error instanceof Error && /^[A-Za-z][A-Za-z0-9-]*(?=:|$)/u.test(error.message)
    ? error.message.split(':')[0]! : 'deploymentPreferencesInvalid';
  return { code, message: error instanceof Error ? error.message : '部署偏好无效或不可读。' };
}

async function receipt(options: TargetsCommandOptions, command: string, changed: boolean,
  errors: ReturnType<typeof failure>[]): Promise<TargetsCommandReceipt> {
  const location = { ...options, scope: 'user' as const };
  const value: TargetsCommandReceipt = await intentReceipt(command, location,
    { changed: false, roots: [], errors }, changed);
  const preferences = await observePreferences(location);
  if (preferences.state === 'valid') value.policy = preferences.value;
  return value;
}

async function applySavedPolicy(options: TargetsCommandOptions, saved: TargetsCommandReceipt): Promise<TargetsCommandReceipt> {
  if (!saved.ok || !options.apply) return saved;
  try {
    const applied = await runRecovery('sync', [], {
      cwd: options.cwd, env: options.env, context: options.context,
      cliVersion: options.cliVersion!, all: true, yes: options.yes, retireUnselectedTargets: true,
    }, options.runtime);
    return { ...applied, command: saved.command, preferencesChanged: saved.preferencesChanged,
      policy: saved.policy, apply: applied };
  } catch (error) {
    const issue = failure(error);
    return { ...saved, ok: false, errors: [issue], blockers: [issue] };
  }
}

export async function targetsSet(options: TargetsCommandOptions & {
  targets: readonly string[];
}): Promise<TargetsCommandReceipt> {
  try {
    const targets = normalizeAgents(options.targets);
    await resolveWorkContext(options);
    const saved = await setTargets({ ...options, scope: 'user' }, targets);
    return applySavedPolicy(options, await receipt(options, 'targets:set', saved.changed, []));
  } catch (error) {
    return receipt(options, 'targets:set', false, [failure(error)]);
  }
}

export async function targetsChangeExclusion(options: TargetsCommandOptions & {
  selector: string; target: string; excluded: boolean;
}): Promise<TargetsCommandReceipt> {
  const command = `targets:${options.excluded ? 'exclude' : 'include'}`;
  try {
    const parsed = parsePluginId(options.selector);
    if (!parsed.sourceId || `${parsed.sourceId}/${parsed.pluginName}` !== options.selector) throw new Error('invalidArguments');
    const target = normalizeAgents([options.target])[0]!;
    await resolveWorkContext(options);
    const saved = await withAwHomeMutationLock({ env: options.env, action: async (token) => {
      const location = { ...options, scope: 'user' as const, token };
      const current = await observePreferences(location);
      if (current.state !== 'valid' && current.state !== 'absent') throw new Error('deploymentPreferencesInvalid');
      const preferences = current.state === 'valid' ? current.value : createEmptyPreferences();
      const exclusions = preferences.exclusions.filter((entry) => entry.plugin !== options.selector || entry.target !== target);
      if (options.excluded) exclusions.push({ plugin: options.selector, target });
      return setExclusions(location, exclusions, (draft) => validateExclusions(options, draft));
    } });
    return applySavedPolicy(options, await receipt(options, command, saved.changed, []));
  } catch (error) {
    return receipt(options, command, false, [failure(error)]);
  }
}

export async function targetsList(options: TargetsCommandOptions): Promise<TargetsCommandReceipt> {
  const observation = await observePreferences({ ...options, scope: 'user' });
  return receipt(options, 'targets:list', false,
    observation.state === 'valid' || observation.state === 'absent' ? [] : [failure(new Error(observation.code))]);
}
