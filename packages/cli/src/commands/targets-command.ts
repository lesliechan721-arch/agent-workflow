import { observePreferences, resetTargets, setAgents } from '../intent/deployment-preferences.js';
import { intentReceipt, type IntentCommandOptions } from './intent-command.js';
import type { RecoveryReceipt } from '../recovery/receipt.js';

function failure(error: unknown) {
  const code = error instanceof Error && /^[A-Za-z][A-Za-z0-9-]*(?=:|$)/u.test(error.message)
    ? error.message.split(':')[0]! : 'deploymentPreferencesInvalid';
  return { code, message: '部署偏好无效或不可读。' };
}

export async function targetsSet(options: IntentCommandOptions & { agents: readonly string[] }): Promise<RecoveryReceipt> {
  try {
    if (!options.agents.length) throw new Error('invalidArguments');
    const saved = await setAgents(options, options.agents);
    return intentReceipt('targets:set', options, { changed: false, roots: [], errors: [] }, saved.changed);
  } catch (error) {
    return intentReceipt('targets:set', options, { changed: false, roots: [], errors: [failure(error)] });
  }
}

export async function targetsReset(options: IntentCommandOptions): Promise<RecoveryReceipt> {
  try {
    const saved = await resetTargets(options);
    return intentReceipt('targets:reset', options, { changed: false, roots: [], errors: [] }, saved.changed);
  } catch (error) {
    return intentReceipt('targets:reset', options, { changed: false, roots: [], errors: [failure(error)] });
  }
}

export async function targetsList(options: IntentCommandOptions): Promise<RecoveryReceipt> {
  const observation = await observePreferences(options);
  return intentReceipt('targets:list', options, { changed: false, roots: [], errors:
    observation.state === 'valid' || observation.state === 'absent' ? [] : [failure(new Error(observation.code))] });
}
