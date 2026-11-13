import type { DependencyScopeOverride, PlatformName, Scope } from '../types.js';

export interface NativeSharedReference {
  pluginId: string;
  sourceIdentity: string;
  platform: PlatformName;
  scope: Scope;
  projectRoot: string | null;
  physicalKey?: string;
}
export interface NativeSharedReferenceView {
  scopes: Scope[];
  projectRoot: string | null;
  desiredComplete: boolean;
  desired: NativeSharedReference[];
  observed: NativeSharedReference[];
  observations: Array<NativeSharedReference & { complete: boolean }>;
}

/** In-memory protection input for Native execution; never a persisted declaration. */
export interface NativeDemandView {
  roots: Array<{ pluginId: string; platforms: PlatformName[] }>;
  dependencyScopeOverrides: DependencyScopeOverride[];
  sharedReferenceView?: NativeSharedReferenceView;
}

export function createEmptyNativeDemandView(): NativeDemandView {
  return { roots: [], dependencyScopeOverrides: [] };
}
