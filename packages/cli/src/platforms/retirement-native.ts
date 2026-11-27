import path from 'node:path';
import { readStrictNamespacedMarketplaceRoot } from '../utils/local-marketplace.js';
import { atomicReplaceSafeFile, assertSafeFileMutationPath } from '../utils/safe-fs.js';
import { resolveAwHome } from '../utils/state-paths.js';
import { SKILL_OWNER_MARKER } from '../utils/ownership.js';
import { canonicalNamespaceRoot, getPhysicalKey, identityDigest } from './identity.js';
import { getDeploymentLayout, getManagedPlatformRoot, getNativePackageName, type DeploymentLayout } from './layout.js';
import type { DeploymentBinding, DeploymentObservation, MutationOutcome, ReadContext } from './contracts.js';

export function sharedMarketplaceRoute(binding: DeploymentBinding): boolean {
  return ['codex', 'claude', 'copilot'].includes(binding.platform) && binding.route === `${binding.platform}-marketplace`;
}

const exactEntry = (entry: unknown, name: string): boolean => !!entry && typeof entry === 'object'
  && 'name' in entry && entry.name === name && 'source' in entry && entry.source === `./plugins/${name}`;

/** Marketplace proof is deliberately separate from the package owner marker. */
async function readRetirementMarketplace(ctx: ReadContext, binding: DeploymentBinding, layout: DeploymentLayout) {
  const platform = binding.platform;
  if (platform !== 'codex' && platform !== 'claude' && platform !== 'copilot' || !sharedMarketplaceRoute(binding)
    || !layout.marketplaceRoot || !layout.marketplaceName || getPhysicalKey(layout.physicalIdentity) !== binding.physicalKey) {
    throw new Error('deploymentOwnershipUnconfirmed');
  }
  const awRoot = await canonicalNamespaceRoot(resolveAwHome(ctx.env));
  const root = path.join(getManagedPlatformRoot(awRoot, platform, binding.route, layout.physicalIdentity.namespaceRoot),
    'marketplaces', binding.plugin.sourceId);
  const name = getNativePackageName(binding.plugin);
  const packageRoot = path.join(root, 'plugins', name);
  if (root !== layout.marketplaceRoot || packageRoot !== layout.packageRoot) throw new Error('deploymentOwnershipUnconfirmed');
  const manifestPath = path.join(root, platform === 'codex' ? '.agents/plugins/marketplace.json'
    : platform === 'claude' ? '.claude-plugin/marketplace.json' : '.github/plugin/marketplace.json');
  // Refuse links anywhere within AW_HOME, including in the package and manifest
  // ancestor chain, before using the canonical path as authority.
  for (const filePath of [manifestPath, path.join(root, 'config.json'), path.join(packageRoot, SKILL_OWNER_MARKER)]) {
    await assertSafeFileMutationPath({ filePath, allowedRoot: awRoot, label: 'Native retirement marketplace' });
  }
  const marketplace = await readStrictNamespacedMarketplaceRoot({ trustedMarketplaceRoot: path.dirname(root), rootDir: root,
    platform, sourceId: binding.plugin.sourceId, sourceIdentity: binding.plugin.sourceIdentity, marketplaceName: layout.marketplaceName });
  if (!marketplace) throw new Error('deploymentOwnershipUnconfirmed');
  const entries = marketplace.manifest.plugins as unknown[];
  if (entries.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry)
    || typeof (entry as Record<string, unknown>).name !== 'string' || !('source' in entry)
    || typeof entry.source !== 'string' && (!entry.source || typeof entry.source !== 'object' || Array.isArray(entry.source)))) {
    throw new Error('marketplaceRootInvalid');
  }
  // A same-name entry redirected to a different source could cause the
  // native uninstall to reach a different plugin under the same ID.
  if (entries.some((entry) => (entry as Record<string, unknown>).name === name && !exactEntry(entry, name))) {
    throw new Error('deploymentOwnershipUnconfirmed');
  }
  const targetEntries = entries.filter((entry) => exactEntry(entry, name));
  const proof = { manifestPath, fingerprint: identityDigest({ config: marketplace.config, entries: targetEntries }),
    entryPresent: targetEntries.length > 0 };
  return { proof, root, manifest: marketplace.manifest, entries, name };
}

export async function inspectRetirementMarketplace(ctx: ReadContext, binding: DeploymentBinding, layout: DeploymentLayout):
Promise<NonNullable<DeploymentObservation['retirement']>['marketplaceProof']> {
  try { return (await readRetirementMarketplace(ctx, binding, layout)).proof; }
  catch (error) { ctx.signal?.throwIfAborted(); return null; }
}

/** Replace only this source's exact plugin entry; preserve the marketplace and all other entries. */
export async function removeRetirementMarketplaceEntry(ctx: ReadContext, binding: DeploymentBinding,
  expected: NonNullable<DeploymentObservation['retirement']>['marketplaceProof']): Promise<MutationOutcome> {
  if (!expected) throw Object.assign(new Error('deploymentOwnershipUnconfirmed'), { code: 'deploymentOwnershipUnconfirmed', mutation: 'none' });
  const read = async () => {
    try { return await readRetirementMarketplace(ctx, binding, await getDeploymentLayout(ctx, binding)); }
    catch (cause) { throw Object.assign(new Error('operationPlanStale', { cause }), { code: 'operationPlanStale', mutation: 'none' }); }
  };
  const current = await read();
  const verify = (value: typeof current) => {
    if (value.proof.manifestPath !== expected.manifestPath || value.proof.fingerprint !== expected.fingerprint) {
      throw Object.assign(new Error('operationPlanStale'), { code: 'operationPlanStale', mutation: 'none' });
    }
  };
  verify(current);
  if (!current.proof.entryPresent) return { changed: false, mutation: 'none' };
  await atomicReplaceSafeFile({ filePath: current.proof.manifestPath, allowedRoot: current.root,
    content: `${JSON.stringify({ ...current.manifest, plugins: current.entries.filter((entry) => !exactEntry(entry, current.name)) }, null, 2)}\n`,
    label: 'Native retirement marketplace', beforeRename: async () => {
      const latest = await read();
      verify(latest);
      // The replacement includes all siblings from our read, so recheck them at the write boundary.
      if (identityDigest(latest.manifest) !== identityDigest(current.manifest)) {
        throw Object.assign(new Error('operationPlanStale'), { code: 'operationPlanStale', mutation: 'none' });
      }
    } });
  return { changed: true, mutation: 'confirmed' };
}
