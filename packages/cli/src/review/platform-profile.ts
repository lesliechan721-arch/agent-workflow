import type { PlatformCapabilitiesV1, PlatformTarget, Scope } from '@lesliechan721/aw-plugin-core/manifest';

import { getQualifiedPlatformProfile } from '../platforms/capabilities.js';

/** An explicit author profile describes an interface; it is never local discovery evidence. */
export function getAuthoringPlatformCapabilities(platform: PlatformTarget, scope: Scope): PlatformCapabilitiesV1 {
  const profile = getQualifiedPlatformProfile(platform);
  return {
    schemaVersion: 1,
    platform,
    scope,
    basis: 'profile',
    profileId: profile.id,
    consumers: [],
    kinds: structuredClone(profile.kinds),
    features: structuredClone(profile.features),
  };
}
