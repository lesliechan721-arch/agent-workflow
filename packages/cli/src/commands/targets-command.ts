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
import { executeRecovery, prepareRecovery, runRecovery } from '../recovery/coordinator.js';
import { effectsForPlan } from './public-lifecycle.js';
import type { Confirmation } from '../output/public-result.js';
import { validateExclusions } from '../recovery/joint-demand.js';
import { intentReceipt } from './intent-command.js';
import type { RecoveryReceipt } from '../recovery/receipt.js';
import { discoverPlatforms, requiresTargetConfirmation, targetAvailabilityViews,
  type ReadContext, type TargetAvailabilityView } from '../platforms/discovery.js';

interface TargetsCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  context?: Scope;
  apply?: boolean;
  yes?: boolean;
  cliVersion?: string;
  runtime?: RebuildCommandRuntime;
  force?: boolean;
  discovery?: Omit<ReadContext, 'cwd' | 'env'>;
}
interface TargetsCommandReceipt extends RecoveryReceipt {
  policy?: DeploymentPreferences;
  apply?: RecoveryReceipt;
  confirmation?: Confirmation;
  availability?: TargetAvailabilityView[];
  forceRetry?: string[];
  warnings?: Array<{ code: string; message: string }>;
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
    const apply: RecoveryReceipt = { ...saved, command: 'sync', ok: false, preferencesChanged: false,
      errors: [issue], blockers: [issue] };
    return { ...saved, ok: false, errors: [issue], blockers: [issue], apply };
  }
}

async function applyCandidatePolicy(
  options: TargetsCommandOptions,
  command: string,
  update: (current: DeploymentPreferences) => DeploymentPreferences,
  validate?: (candidate: DeploymentPreferences) => Promise<void>,
): Promise<TargetsCommandReceipt> {
  const observed = await observePreferences({ ...options, scope: 'user' });
  if (observed.state !== 'valid' && observed.state !== 'absent') throw new Error('deploymentPreferencesInvalid');
  const candidate = update(observed.state === 'valid' ? observed.value : createEmptyPreferences());
  await validate?.(candidate);
  const recoveryOptions = {
    cwd: options.cwd, env: options.env, context: options.context,
    cliVersion: options.cliVersion!, all: true, yes: options.yes,
    retireUnselectedTargets: true, preferences: candidate,
  };
  const plan = await prepareRecovery('sync', [], recoveryOptions, options.runtime);
  let executing = false;
  try {
    const originalEvidence = 'rawDigest' in observed ? `${observed.state}:${observed.rawDigest}` : observed.state;
    if (plan.preferencesEvidence !== originalEvidence) {
      const issue = { code: 'operationReviewStale', message: 'Deployment preferences changed while preparing this operation. Check the current policy and retry.' };
      return { ...plan.receipt, command, ok: false, blockers: [...plan.receipt.blockers, issue],
        errors: [...plan.receipt.errors, issue] };
    }
    const effects = effectsForPlan(plan);
    const confirmation: Confirmation = { required: effects.length > 0, provided: options.yes === true, effects };
    if (effects.length > 0 && options.yes !== true) {
      const issue = { code: 'confirmationRequired', message: 'Repeat the command with --yes to confirm the listed effects.' };
      return { ...plan.receipt, command, ok: false, preferencesChanged: false, outputsMayHaveChanged: false,
        blockers: [...plan.receipt.blockers, issue], errors: [...plan.receipt.errors, issue], confirmation,
        ...(observed.state === 'valid' ? { policy: observed.value } : {}) };
    }
    if (plan.blockExecution) return { ...plan.receipt, command, confirmation,
      ...(observed.state === 'valid' ? { policy: observed.value } : {}) };
    executing = true;
    const applied = await executeRecovery(plan);
    const saved = await observePreferences({ ...options, scope: 'user' });
    return { ...applied, command, apply: applied, confirmation,
      ...(saved.state === 'valid' ? { policy: saved.value } : {}) };
  } finally {
    if (!executing) await plan.context.dispose();
  }
}

export async function targetsSet(options: TargetsCommandOptions & {
  targets: readonly string[];
}): Promise<TargetsCommandReceipt> {
  try {
    let targets: ReturnType<typeof normalizeAgents>;
    try { targets = normalizeAgents(options.targets); }
    catch { throw new Error('invalidArguments: Unknown target ID. Use aw target list.'); }
    await resolveWorkContext(options);
    const discovery = await discoverPlatforms({ cwd: options.cwd, env: options.env,
      runner: options.runtime?.nativeCliRunner, ...options.discovery });
    const forceRetry = ['aw', 'target', 'set', ...(targets.length ? targets : ['--none']), '--force',
      ...(options.context ? ['--context', options.context] : []), ...(options.apply ? ['--apply'] : []), ...(options.yes ? ['--yes'] : [])];
    const availabilityIssues = (blocked: typeof discovery) => blocked.map((item) => ({ code: 'targetUnavailable',
      message: `${item.platform}: ${item.availability}. ${item.installations.flatMap((product) => product.reasonCodes).join(', ') || 'clientNotFound'}. Repeat with --force to save this selection.` }));
    const decorate = (selected: TargetsCommandReceipt, blocked = false): TargetsCommandReceipt => {
      const availability = targetAvailabilityViews(discovery, selected.policy?.targets ?? []);
      const warnings = availability.filter((item) => item.selected && requiresTargetConfirmation(item.availability))
        .map((item) => ({ code: 'selectedTargetUnavailable', message: `${item.displayName}: ${item.availability}. The saved selection does not bypass installation requirements.` }));
      return { ...selected, availability, warnings, ...(blocked ? { forceRetry } : {}) };
    };
    if (options.apply && options.runtime?.directCli) {
      let blocked: typeof discovery = [];
      try {
        const applied = await applyCandidatePolicy(options, 'targets:set', (current) => {
          blocked = discovery.filter((item) => targets.includes(item.platform)
            && !current.targets.includes(item.platform) && requiresTargetConfirmation(item.availability));
          if (blocked.length && !options.force) throw new Error('targetUnavailable');
          return { ...current, targets };
        });
        return decorate(applied);
      } catch (error) {
        if (blocked.length && !options.force) return decorate(await receipt(options, 'targets:set', false, availabilityIssues(blocked)), true);
        throw error;
      }
    }
    const saved = await withAwHomeMutationLock({ env: options.env, action: async (token) => {
      const location = { ...options, token, scope: 'user' as const };
      const current = await observePreferences(location);
      if (current.state !== 'valid' && current.state !== 'absent') throw new Error('deploymentPreferencesInvalid');
      const previous = current.state === 'valid' ? current.value.targets : [];
      const unavailable = discovery.filter((item) => targets.includes(item.platform)
        && !previous.includes(item.platform) && requiresTargetConfirmation(item.availability));
      if (unavailable.length && !options.force) return { blocked: unavailable, changed: false };
      return { blocked: [], ...await setTargets(location, targets) };
    } });
    const selected = await receipt(options, 'targets:set', saved.changed, availabilityIssues(saved.blocked));
    return decorate(await applySavedPolicy(options, selected), saved.blocked.length > 0);
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
    if (options.apply && options.runtime?.directCli) {
      return await applyCandidatePolicy(options, command, (current) => {
        const exclusions = current.exclusions.filter((entry) => entry.plugin !== options.selector || entry.target !== target);
        if (options.excluded) exclusions.push({ plugin: options.selector, target });
        return { ...current, exclusions };
      }, (candidate) => validateExclusions(options, candidate));
    }
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
  const selected = await receipt(options, 'targets:list', false,
    observation.state === 'valid' || observation.state === 'absent' ? [] : [failure(new Error(observation.code))]);
  const discovery = await discoverPlatforms({ cwd: options.cwd, env: options.env,
    runner: options.runtime?.nativeCliRunner, ...options.discovery });
  return { ...selected, availability: targetAvailabilityViews(discovery, selected.policy?.targets ?? []) };
}
