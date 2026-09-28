import type { DependencyScopeOverride, PlatformName } from '../types.js';

/** In-memory protection input for Native execution; never a persisted declaration. */
export interface NativeDemandView {
  roots: Array<{ pluginId: string; platforms: PlatformName[] }>;
  dependencyScopeOverrides: DependencyScopeOverride[];
}

export function createEmptyNativeDemandView(): NativeDemandView {
  return { roots: [], dependencyScopeOverrides: [] };
}
