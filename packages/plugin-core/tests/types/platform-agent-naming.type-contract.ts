import type { Support, PlatformCapabilitiesV3 } from '../../src/manifest.js';
import type { SupportV3, PlatformRenderContextV3, PlatformAgentNamingMode, PlatformAgentNaming } from '../../src/index.js';

export const support: Support = 'supported' satisfies SupportV3;
// @ts-expect-error V3 capability facts are deterministic; no third runtime state.
export const obsoleteSupport: Support = 'unverified';
export const mode: PlatformAgentNamingMode = 'aw-prefix';
export const naming: PlatformAgentNaming = { mode, filePrefix: 'aw-official-demo-', invocationPrefix: 'aw-official-demo-' };
export const capabilities: PlatformCapabilitiesV3 = {
  schemaVersion: 3, platform: 'codex', scope: 'user', basis: 'profile', agentNamingMode: mode,
  kinds: {
    skill: { status: support, reasonCodes: [], delivery: ['native-package'] },
    mcp: { status: support, reasonCodes: [], delivery: ['native-package'] },
    agent: { status: support, reasonCodes: [], delivery: ['managed-host-resource'] },
    hook: { status: support, reasonCodes: [], delivery: ['native-package'] },
    instruction: { status: support, reasonCodes: [], delivery: ['native-package'] },
  },
  features: { 'agent.model': { status: support, reasonCodes: [], values: ['model'] } },
};
export const context: PlatformRenderContextV3 = {
  schemaVersion: 3, surface: 'agent-plugin', platform: 'codex', scope: 'user',
  plugin: { pluginId: 'official/demo', name: 'demo', version: '1.0.0' },
  config: { schema: { schemaVersion: 5, fields: {} }, values: {}, sources: {}, issues: [] },
  changedConfigKeys: [], allowedOutputKinds: ['agent'], platformCapabilities: capabilities,
  agentNaming: naming, resources: [], previousComponents: [],
};
export const oldCapabilities: PlatformCapabilitiesV3 = {
  ...capabilities,
  // @ts-expect-error Delivery is no longer an independent feature table.
  deliveryFeatures: [],
};
// @ts-expect-error V3 requires plugin-instance naming at the context root.
export const incompleteContext: PlatformRenderContextV3 = { ...context, agentNaming: undefined };
