import { assertProcessTreeInspectionAvailable } from './codex-eval-process-tree.js';
import type { PluginEvalProcessManagementEvidence } from './plugin-eval-contract.js';

const RESTRICTED_CODEX_PERMISSION_PROFILES = new Set(['workspace', 'read-only']);
const OBSERVED_PROCESS_LIMITATION =
  'Process-tree inspection observes and cleans known descendants but does not guarantee descendant cleanup.';

function normalizedPermissionProfile(sourceEnv: NodeJS.ProcessEnv): string | null {
  const value = sourceEnv.CODEX_PERMISSION_PROFILE?.trim();
  if (!value) return null;
  return value.replace(/^:/u, '');
}

function restrictedSessionError(profile: string): Error {
  return new Error(
    `Model eval is blocked because CODEX_PERMISSION_PROFILE=${profile} identifies a ` +
    'restricted Codex session. A one-off sandbox_permissions=require_escalated request ' +
    'is not Full Access. Do not retry this command with one-off elevation. Ask the user ' +
    'to choose either switching the entire Codex session to Full Access or explicitly ' +
    'confirming --allow-unmanaged-processes. No keychain check, process-tree inspection, ' +
    'report directory, or model process was started.',
  );
}

export async function resolveCodexEvalProcessManagement(options: {
  allowUnmanaged: boolean;
  sourceEnv?: NodeJS.ProcessEnv;
  preflight?: () => Promise<void>;
  inspect?: () => Promise<void>;
  platform?: NodeJS.Platform;
}): Promise<PluginEvalProcessManagementEvidence> {
  const profile = normalizedPermissionProfile(options.sourceEnv ?? process.env);
  if (profile && RESTRICTED_CODEX_PERMISSION_PROFILES.has(profile)) {
    if (!options.allowUnmanaged) {
      throw restrictedSessionError(profile);
    }
    await options.preflight?.();
    return {
      mode: 'unmanaged-confirmed',
      inspectionAvailable: false,
      userAcknowledged: true,
      descendantCleanupGuaranteed: false,
      diagnostic:
        `Restricted Codex permission profile ${profile} was explicitly confirmed; ` +
        'process-tree inspection was not attempted.',
    };
  }

  await options.preflight?.();
  try {
    if (options.inspect) {
      await options.inspect();
    } else {
      await assertProcessTreeInspectionAvailable({ platform: options.platform });
    }
    return {
      mode: 'observed',
      inspectionAvailable: true,
      userAcknowledged: options.allowUnmanaged,
      descendantCleanupGuaranteed: false,
      limitation: OBSERVED_PROCESS_LIMITATION,
    };
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    if (!options.allowUnmanaged) {
      throw new Error(
        `Full Access is required for managed model eval process cleanup. ${diagnostic} ` +
        'No model process was started. A one-off sandbox_permissions=require_escalated ' +
        'request is not Full Access. Do not retry this command with one-off elevation. ' +
        'Ask the user to choose either switching the entire Codex session to Full Access ' +
        'or explicitly confirming --allow-unmanaged-processes for a run that cannot track ' +
        'or verify descendants.',
      );
    }
    return {
      mode: 'unmanaged-confirmed',
      inspectionAvailable: false,
      userAcknowledged: true,
      descendantCleanupGuaranteed: false,
      diagnostic,
    };
  }
}
