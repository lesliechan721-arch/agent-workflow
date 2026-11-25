import type { RecoveryDiagnostic, RecoveryReceipt } from '../recovery/receipt.js';
import type { PluginConfigIssue } from './plugin-config.js';
import { rethrowFatalError } from './codex-executable-discovery.js';

/** Field names only: never carry the resolved values or exception messages. */
export function configIssueDiagnostic(issues: readonly PluginConfigIssue[],
  invalidCode: 'configInvalid' | 'invalidConfig' = 'configInvalid'): RecoveryDiagnostic | undefined {
  if (!issues.length) return undefined;
  const missing = issues.every((issue) => issue.type === 'missing-required');
  return { code: missing ? 'requiredConfigMissing' : invalidCode,
    message: missing ? 'Required plugin configuration is missing.' : 'Plugin configuration is invalid.',
    detail: { reasonCode: missing ? 'missingRequired' : 'invalidConfig', fieldKeys: [...new Set(issues.map(({ key }) => key))].sort() } };
}

/** Status reports missing and invalid fields separately; a write preflight chooses one blocker. */
export function configStatusDiagnostics(issues: readonly PluginConfigIssue[]): RecoveryDiagnostic[] {
  return (['missing-required', 'invalid-config'] as const).flatMap((type) => {
    const diagnostic = configIssueDiagnostic(issues.filter((issue) => issue.type === type));
    return diagnostic ? [diagnostic] : [];
  });
}

export function configReadDiagnostic(error: unknown, invalidCode: 'configInvalid' | 'invalidConfig' = 'configInvalid'): RecoveryDiagnostic {
  rethrowFatalError(error);
  return { code: invalidCode, message: 'Plugin configuration could not be read.', detail: { reasonCode: 'configReadFailed' } };
}

export function isConfigDiagnostic({ code }: Pick<RecoveryDiagnostic, 'code'>): boolean {
  return code === 'requiredConfigMissing' || code === 'configInvalid' || code === 'invalidConfig';
}

export function isInstallConfigBlocked(receipt: RecoveryReceipt): boolean {
  if (receipt.command !== 'install') return false;
  const candidates = receipt.targetResults.filter(({ satisfaction }) =>
    satisfaction !== 'excluded' && satisfaction !== 'unsupported' && satisfaction !== 'not-applicable');
  return candidates.length > 0 && candidates.every((target) =>
    target.execution === 'not-run' && target.blockers.some(isConfigDiagnostic));
}

export class PluginConfigDiagnosticError extends Error {
  readonly code: string;
  readonly fieldKeys?: string[];
  constructor(readonly diagnostic: RecoveryDiagnostic, readonly diagnostics: RecoveryDiagnostic[] = [diagnostic]) {
    super(diagnostic.message);
    this.code = diagnostic.code;
    this.fieldKeys = diagnostic.detail?.fieldKeys;
  }
}
