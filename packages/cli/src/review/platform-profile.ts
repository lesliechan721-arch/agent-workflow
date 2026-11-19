import type { PlatformCapabilitiesV2, PlatformTarget, Scope } from '@lesliechan721/aw-plugin-core/manifest';

import { getQualifiedPlatformProfile, getQualifiedKindsForScope, toPlatformCapabilitiesView } from '../platforms/capabilities.js';

/** An explicit author profile describes an interface; it is never local discovery evidence. */
export function getAuthoringPlatformCapabilities(platform: PlatformTarget, scope: Scope): PlatformCapabilitiesV2 {
  const profile = getQualifiedPlatformProfile(platform);
  return toPlatformCapabilitiesView({
    schemaVersion: 2,
    platform,
    scope,
    basis: 'profile',
    kinds: getQualifiedKindsForScope(profile, scope),
    features: profile.features,
  });
}
