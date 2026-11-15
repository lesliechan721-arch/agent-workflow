import path from 'node:path';
import { resolvePlatformEntries, type PluginComponent } from '@lesliechan721/aw-plugin-core/manifest';

import type { PluginMeta } from '../types.js';
import type { OwnedComponent } from '../utils/ownership.js';
import type { DeploymentBinding } from './contracts.js';
import { getDeploymentResourceKey, getNativePackageName, type DeploymentLayout } from './layout.js';
import { nativeComponentName } from './projection-files.js';

type SupplementIdentity = Pick<PluginComponent, 'kind' | 'name'>;

/** Fixed host locations depend on declared identity, never on component content. */
export function supplementRelativePath(binding: DeploymentBinding, component: SupplementIdentity): string {
  const name = `${getDeploymentResourceKey(binding.plugin)}-${nativeComponentName(component.name)}`;
  if (binding.platform === 'codex' && component.kind === 'agent') return `${name}.toml`;
  if (binding.platform === 'grok' && component.kind === 'instruction') return `${name}.md`;
  throw new Error('platformProjectionSupplementKindUnsupported');
}

export function ownedSupplementFile(binding: DeploymentBinding, physicalKey: string, destination: string): Extract<OwnedComponent, { kind: 'owned-text-file' }> {
  return { kind: 'owned-text-file', path: destination, allowedRoot: path.dirname(destination),
    identity: { owner: 'agent-workflows', sourceId: binding.plugin.sourceId, sourceIdentity: binding.plugin.sourceIdentity,
      pluginId: binding.plugin.pluginId, plugin: getNativePackageName(binding.plugin), platform: binding.platform,
      scope: binding.scope.kind, physicalKey, artifactKey: path.basename(destination) } };
}

/** Active Manifest metadata is sufficient to bound recovery of declared static files. */
export function staticSupplementFiles(binding: DeploymentBinding, layout: DeploymentLayout,
  manifest: Pick<PluginMeta['manifest'], 'extensions'>): Array<Extract<OwnedComponent, { kind: 'owned-text-file' }>> {
  const unit = layout.renderUnits.find((candidate) => candidate.output === 'supplement');
  if (!layout.supplementRoot || !unit) return [];
  const entries: SupplementIdentity[] = binding.platform === 'codex'
    ? resolvePlatformEntries(manifest.extensions?.agents, binding.platform).map((entry) => ({ kind: 'agent', name: entry.name }))
    : binding.platform === 'grok'
      ? resolvePlatformEntries(manifest.extensions?.instructions, binding.platform).map((entry) => ({ kind: 'instruction', name: entry.name })) : [];
  return entries.map((entry) => ownedSupplementFile(binding, unit.physicalKey,
    path.join(layout.supplementRoot!, supplementRelativePath(binding, entry))));
}
