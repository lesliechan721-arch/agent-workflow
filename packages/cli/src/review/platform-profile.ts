import type { PlatformCapabilitiesV2, PlatformTarget, Scope } from '@lesliechan721/aw-plugin-core/manifest';

import { getQualifiedPlatformProfile, getQualifiedFeaturesForScope, getQualifiedKindsForScope, toPlatformCapabilitiesView } from '../platforms/capabilities.js';

/** An explicit author profile describes an interface; it is never local discovery evidence. */
export function getAuthoringPlatformCapabilities(platform: PlatformTarget, scope: Scope,
  options: { activationScope?: Scope; portable?: boolean } = {}): PlatformCapabilitiesV2 {
  const profile = getQualifiedPlatformProfile(platform);
  const activationScope = options.activationScope ?? scope;
  const features = getQualifiedFeaturesForScope(profile, activationScope);
  // Codex's sidecar and OpenCode's namespaced metadata survive strict Agent Skills export.
  if (options.portable && platform !== 'codex' && platform !== 'opencode') {
    for (const id of ['skill.invocation.manual', 'skill.invocation.model', 'skill.visibility']) {
      if (features[id]?.status === 'supported') features[id] = { status: 'unsupported', reasonCodes: ['interface-unsupported'], values: [] };
    }
  }
  return toPlatformCapabilitiesView({
    schemaVersion: 2,
    platform,
    scope,
    basis: 'profile',
    kinds: getQualifiedKindsForScope(profile, activationScope),
    features,
  });
}
