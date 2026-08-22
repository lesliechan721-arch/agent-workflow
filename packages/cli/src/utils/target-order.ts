import type { PlatformName, Scope } from '../types.js';

const PLATFORM_ORDER: readonly PlatformName[] = ['claude', 'codex'];
const SCOPE_ORDER: readonly Scope[] = ['project', 'user'];

export interface PlatformScopeTarget {
  platform: PlatformName;
  scope: Scope;
}

export function comparePlatformScopeTarget(
  left: PlatformScopeTarget,
  right: PlatformScopeTarget,
): number {
  return PLATFORM_ORDER.indexOf(left.platform) - PLATFORM_ORDER.indexOf(right.platform)
    || SCOPE_ORDER.indexOf(left.scope) - SCOPE_ORDER.indexOf(right.scope);
}

export function canonicalPlatformScopeTargets<T extends PlatformScopeTarget>(targets: readonly T[]): T[] {
  return [...targets].sort(comparePlatformScopeTarget);
}
