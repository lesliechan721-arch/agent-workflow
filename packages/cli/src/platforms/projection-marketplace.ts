import type { MarketplaceInterfaceMeta, MarketplaceManifestEntry, MarketplaceOwner } from '@lesliechan721/aw-plugin-core/manifest';
import type { DeploymentBinding } from './contracts.js';
import { getNativePackageName } from './layout.js';

export interface PlatformMarketplaceProjectionInput {
  binding: DeploymentBinding;
  marketplaceName: string;
  entries: readonly (MarketplaceManifestEntry & { version?: string })[];
  identity?: { owner: MarketplaceOwner; interface: MarketplaceInterfaceMeta };
}
export interface PlatformMarketplaceDescriptor { relativePath: string; bytes: Buffer }

/** Projects a complete, verified marketplace generation without filesystem IO. */
export function projectPlatformMarketplace(input: PlatformMarketplaceProjectionInput): PlatformMarketplaceDescriptor {
  const platform = input.binding.platform;
  if (!['codex', 'claude', 'copilot'].includes(platform)) throw new Error('platformMarketplaceRouteUnsupported');
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(input.marketplaceName)) throw new Error('platformMarketplaceNameInvalid');
  const names = new Set<string>();
  const entries = [...input.entries].sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of entries) {
    getNativePackageName({ ...input.binding.plugin, pluginId: `${input.binding.plugin.sourceId}/${entry.name}` });
    if (names.has(entry.name.toLowerCase())) throw new Error('platformMarketplaceNameConflict');
    names.add(entry.name.toLowerCase());
    if (entry.source !== `./plugins/${entry.name}`) throw new Error('platformMarketplaceSourceInvalid');
  }
  const identity = input.identity ?? {
    owner: { name: 'Agent Workflows', url: 'https://github.com/lesliechan721-arch/agent-workflow' },
    interface: { displayName: input.marketplaceName },
  };
  let relativePath: string;
  let manifest: unknown;
  if (platform === 'copilot') {
    // Copilot's public marketplace is a distinct format. Its documented entry
    // fields have no Codex policy or interface namespace.
    relativePath = '.github/plugin/marketplace.json';
    manifest = { name: input.marketplaceName, owner: { name: identity.owner.name }, plugins: entries.map((entry) => ({
      name: entry.name, source: entry.source, description: entry.description,
      ...(entry.version ? { version: entry.version } : {}), category: entry.category,
      ...(entry.tags ? { tags: [...entry.tags] } : {}), strict: entry.strict,
    })) };
  } else {
    relativePath = platform === 'codex' ? '.agents/plugins/marketplace.json' : '.claude-plugin/marketplace.json';
    manifest = { name: input.marketplaceName, owner: structuredClone(identity.owner), interface: structuredClone(identity.interface),
      plugins: entries.map((entry) => ({ ...structuredClone(entry), policy: { ...structuredClone(entry.policy), products: [platform === 'codex' ? 'CODEX' : 'CLAUDE'] } })) };
  }
  return { relativePath, bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) };
}
