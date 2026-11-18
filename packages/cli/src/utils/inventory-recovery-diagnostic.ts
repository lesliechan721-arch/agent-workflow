import type { RecoveryDiagnostic } from '../recovery/receipt.js';
import type { CatalogSourceInventoryError } from './catalog-source-references.js';

/** Scanner facts describe uncertainty. They do not authorize ownership or deletion. */
export function inventoryRecoveryDiagnostic(error: CatalogSourceInventoryError): RecoveryDiagnostic {
  const relevance = error.relevance;
  return { code: error.kind === 'nativeStateRead' ? 'nativeStateUnreadable' : error.code, message: 'The local output inventory is incomplete. Inspect the detected location before recovery.',
    ...(!relevance.global ? { subject: {
      ...(relevance.sourceId ? { sourceId: relevance.sourceId } : {}),
      ...(relevance.sourceId && relevance.pluginName ? { pluginId: `${relevance.sourceId}/${relevance.pluginName}` } : {}),
      ...(relevance.platform ? { target: relevance.platform } : {}),
      ...(relevance.scope ? { scope: relevance.scope } : {}),
    } } : {}),
    detail: { reasonCode: error.kind, ...(error.recoveryPath ? { path: error.recoveryPath } : {}),
      ...(error.configKey ? { configKey: error.configKey } : {}) },
  };
}
