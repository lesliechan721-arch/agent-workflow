import path from 'node:path';
import fs from 'fs-extra';
import { normalizeProducerIdentity, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';
import { readSkillOwnerMarker } from '../utils/ownership.js';
import { readStrictNamespacedMarketplaceRoot } from '../utils/local-marketplace.js';
import { getDeploymentLayout, getInstallRoute } from './layout.js';
import { getPhysicalKey } from './identity.js';
import type { DeploymentBinding, PhysicalIdentity, ProductInstallation, ReadContext, ScopeRef } from './contracts.js';

function invalid(): never { throw new Error('commandOwnerMismatch: The native Skill does not match its verified deployment placement.'); }
/** Verify the frozen physical identity against the fixed final layout, not the caller's current client home. */
export async function verifyManagedCommandPlacement(options: {
  producer: ProducerIdentity; resourceRoot: string; env?: NodeJS.ProcessEnv;
}): Promise<PhysicalIdentity> {
  const producer = normalizeProducerIdentity(options.producer);
  if (producer.kind === 'package' || !producer.platform || !producer.placementKey) invalid();
  const resourceRoot = path.resolve(options.resourceRoot);
  if (await fs.realpath(resourceRoot) !== resourceRoot) invalid();
  let ancestor = path.parse(resourceRoot).root;
  for (const segment of path.relative(ancestor, resourceRoot).split(path.sep)) {
    ancestor = path.join(ancestor, segment);
    const stat = await fs.lstat(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
  }
  if (path.basename(path.dirname(resourceRoot)) !== 'skills') invalid();
  const packageRoot = path.dirname(path.dirname(resourceRoot));
  const marker = await readSkillOwnerMarker({ skillRoot: packageRoot, allowedRoot: path.dirname(packageRoot) });
  if (!marker || marker.sourceIdentity !== producer.sourceIdentity || marker.physicalKey !== producer.placementKey
    || marker.sourceId !== producer.sourceId || marker.pluginId !== `${producer.sourceId}/${producer.pluginName}` || marker.plugin !== producer.pluginName
    || marker.platform !== producer.platform || marker.scope !== producer.scope || marker.artifactKey !== path.basename(packageRoot)) invalid();
  const physical = marker.nativeProjection?.physicalIdentity;
  if (!physical || physical.sourceIdentity !== producer.sourceIdentity || physical.pluginId !== marker.pluginId
    || physical.platform !== producer.platform || getPhysicalKey(physical) !== producer.placementKey) invalid();
  const directoryRoute = ['antigravity-directory', 'opencode-directory', 'grok-directory'].includes(physical.route);
  if (directoryRoute && path.basename(physical.namespaceRoot) !== 'plugins') invalid();
  const configRoot = directoryRoute ? path.dirname(physical.namespaceRoot) : physical.namespaceRoot;
  const scope: ScopeRef = producer.scope === 'user' ? { kind: 'user' } : { kind: 'project', projectRoot: producer.projectRoot! };
  // This entry only reconstructs a previously verified layout. It claims no current client availability.
  const product: ProductInstallation = { id: 'frozen-placement', product: directoryRoute ? 'app' : 'cli', version: null,
    availability: 'unknown', reasonCodes: [], entry: directoryRoute ? { kind: 'directory', configRoot } : { kind: 'cli', executable: '', configRoot } };
  if (getInstallRoute(producer.platform, scope, product) !== physical.route) invalid();
  const binding: DeploymentBinding = { id: '', plugin: { sourceId: producer.sourceId, sourceIdentity: producer.sourceIdentity,
    pluginId: marker.pluginId!, version: '0.0.0' }, platform: producer.platform, scope, route: physical.route,
    consumers: [product], physicalKey: producer.placementKey, activationKey: '', renderUnitIds: [] };
  const ctx: ReadContext = { cwd: producer.projectRoot ?? configRoot, env: options.env };
  const layout = await getDeploymentLayout(ctx, binding);
  if (layout.packageRoot !== packageRoot || getPhysicalKey(layout.physicalIdentity) !== producer.placementKey) invalid();
  if (layout.marketplaceRoot) {
    if (binding.platform !== 'codex' && binding.platform !== 'claude' && binding.platform !== 'copilot') invalid();
    const source = await readStrictNamespacedMarketplaceRoot({ rootDir: layout.marketplaceRoot,
      trustedMarketplaceRoot: path.dirname(layout.marketplaceRoot), platform: binding.platform,
      sourceId: producer.sourceId, sourceIdentity: producer.sourceIdentity, marketplaceName: layout.marketplaceName! });
    if (!source) invalid();
    const entries = (source.manifest.plugins as unknown[]).filter((entry) => entry && typeof entry === 'object'
      && 'name' in entry && entry.name === producer.pluginName);
    if (entries.length !== 1 || !('source' in (entries[0] as object))
      || (entries[0] as { source: unknown }).source !== `./plugins/${producer.pluginName}`) invalid();
  }
  const componentId = producer.kind === 'static-skill' ? `skill:${producer.key}` : producer.key;
  const components = marker.nativeProjection!.components.filter((component) => component.id === componentId);
  if (components.length !== 1) invalid();
  const component = components[0]!;
  if (path.basename(resourceRoot) !== component.nativeName || !component.relativeOutputs.includes(`skills/${component.nativeName}/SKILL.md`)) invalid();
  const skill = await fs.lstat(path.join(resourceRoot, 'SKILL.md'));
  if (!skill.isFile() || skill.isSymbolicLink()) invalid();
  return layout.physicalIdentity;
}
