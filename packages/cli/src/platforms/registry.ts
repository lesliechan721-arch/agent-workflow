import { PLATFORM_TARGETS } from '@lesliechan721/aw-plugin-core';
import type { AgentPluginAdapter, PlatformId } from './contracts.js';
import { discoverPlatform } from './discovery.js';
import { resolveDeployments } from './layout.js';
import { getPlatformCapabilities } from './capabilities.js';
import { inspectDeployment } from './inspection.js';
import { projectPlatform } from './projection.js';
import { preparePlatformLifecycle, executePlatformLifecycle, type PlatformDriverState } from './lifecycle.js';

const adapters = new Map<PlatformId, AgentPluginAdapter<PlatformDriverState>>(PLATFORM_TARGETS.map((platform) => [platform, {
  platform,
  discover: (ctx) => discoverPlatform(platform, ctx),
  resolve: (ctx, request) => {
    if (request.discovery.platform !== platform) throw new Error('platformResolutionMismatch');
    return resolveDeployments(ctx, request);
  },
  inspect: inspectDeployment,
  capabilities: getPlatformCapabilities,
  project: projectPlatform,
  lifecycle: { prepare: preparePlatformLifecycle, execute: executePlatformLifecycle },
}]));
export function getAgentPluginAdapter(platform: PlatformId): AgentPluginAdapter<PlatformDriverState> {
  const adapter = adapters.get(platform);
  if (!adapter) throw new Error('platformAdapterUnsupported');
  return adapter;
}
export function getAgentPluginAdapters(): readonly AgentPluginAdapter<PlatformDriverState>[] {
  return [...adapters.values()];
}
