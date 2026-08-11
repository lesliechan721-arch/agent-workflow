import { assertProcessTreeInspectionAvailable } from './codex-eval-process-tree.js';
import type { PluginEvalProcessManagementEvidence } from './plugin-eval-contract.js';

export async function resolveCodexEvalProcessManagement(options: {
  allowUnmanaged: boolean;
  inspect?: () => Promise<void>;
  platform?: NodeJS.Platform;
}): Promise<PluginEvalProcessManagementEvidence> {
  try {
    if (options.inspect) {
      await options.inspect();
    } else {
      await assertProcessTreeInspectionAvailable({ platform: options.platform });
    }
    return {
      mode: 'managed',
      inspectionAvailable: true,
      userAcknowledged: options.allowUnmanaged,
      descendantCleanupGuaranteed: true,
    };
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    if (!options.allowUnmanaged) {
      throw new Error(
        `Full Access is required for managed model eval process cleanup. ${diagnostic} ` +
        'No model process was started. Review the risk, then rerun with ' +
        '--allow-unmanaged-processes to confirm a run that cannot track or verify descendants.',
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
