import type { PlatformCapabilitiesV3, PlatformTarget, Scope } from '@lesliechan721/aw-plugin-core/manifest';

import { getQualifiedPlatformProfile, capabilitiesFromProfile, toPlatformCapabilitiesView } from '../platforms/capabilities.js';

/** An explicit author profile describes an interface; it is never local discovery evidence. */
export function getAuthoringPlatformCapabilities(platform: PlatformTarget, scope: Scope,
  options: { portable?: boolean } = {}): PlatformCapabilitiesV3 {
  const capabilities = capabilitiesFromProfile(getQualifiedPlatformProfile(platform), scope, 'profile');
  // Codex's sidecar and OpenCode's namespaced metadata survive strict Agent Skills export.
  if (options.portable && platform !== 'codex' && platform !== 'opencode') {
    for (const id of ['skill.invocation.manual', 'skill.invocation.model', 'skill.visibility']) {
      capabilities.features[id] = { status: 'unsupported', reasonCodes: ['interface-unsupported'], values: [] };
    }
  }
  return toPlatformCapabilitiesView(capabilities);
}
