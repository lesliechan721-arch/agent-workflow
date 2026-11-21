import type { ComponentUnmet } from '@lesliechan721/aw-plugin-core/manifest';

/** A missing host mapping can finish without a write. Missing inputs and execution errors still need recovery. */
export function isDeliveryCapabilityGap(gap: Pick<ComponentUnmet, 'reasonCode' | 'requiredFeatures'>): boolean {
  return Boolean(gap.requiredFeatures.length) && isDeliveryCapabilityGapReason(gap.reasonCode);
}

export function isDeliveryCapabilityGapReason(reasonCode: string): boolean {
  switch (reasonCode) {
    case 'delivery-unavailable':
    case 'interface-unsupported':
    case 'scope-unsupported':
    case 'capability-unverified':
    case 'consumer-missing':
    case 'consumer-disabled':
    case 'policy-blocked':
    case 'version-unsupported':
      return true;
    default:
      return false;
  }
}
