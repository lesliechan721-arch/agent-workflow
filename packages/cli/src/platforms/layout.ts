import path from 'node:path';
import { canonicalizePathThroughExistingAncestor, resolveAwHome, resolveUserHome } from '../utils/state-paths.js';
import { canonicalNamespaceRoot, getPhysicalKey, identityDigest } from './identity.js';
import { resolvePlatformConfigRoot } from './discovery.js';
import type { ComponentKind, DeploymentBinding, InstallRoute, NativeIdentity, PhysicalIdentity, PluginIdentity, ReadContext, RenderUnit, Resolution, ResolveRequest, ScopeRef } from './contracts.js';

const ALL_KINDS: ComponentKind[] = ['skill', 'mcp', 'agent', 'hook', 'instruction'];
const SHARED_USER_PACKAGES = new Set<DeploymentBinding['platform']>(['codex', 'claude', 'gemini', 'copilot']);
export function hasSharedUserPackage(platform: DeploymentBinding['platform']): boolean {
  return SHARED_USER_PACKAGES.has(platform);
}
export function getNativePackageName(plugin: PluginIdentity): string {
  const name = plugin.pluginId.split('/').at(-1)!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(plugin.sourceId)) throw new Error('platformPluginIdentityInvalid');
  return name;
}
export function getDeploymentResourceKey(plugin: PluginIdentity): string {
  return `aw-${plugin.sourceId}-${getNativePackageName(plugin)}`;
}
export interface DeploymentLayout {
  physicalIdentity: PhysicalIdentity;
  packageRoot: string;
  activationPath: string;
  supplementRoot: string | null;
  renderUnits: RenderUnit[];
  nativeIdentity: NativeIdentity;
  marketplaceRoot: string | null;
  marketplaceName: string | null;
}
export function getInstallRoute(platform: DeploymentBinding['platform'], scope: ScopeRef, product: DeploymentBinding['consumers'][number]): InstallRoute {
  switch (platform) {
    case 'codex': return 'codex-marketplace';
    case 'claude': return 'claude-marketplace';
    case 'cursor': return 'cursor-workspace-hook';
    case 'antigravity': return scope.kind === 'user' && product.entry?.kind === 'cli' ? 'antigravity-cli' : 'antigravity-directory';
    case 'opencode': return 'opencode-directory';
    case 'pi': return 'pi-package';
    case 'gemini': return 'gemini-extension';
    case 'copilot': return 'copilot-marketplace';
    case 'grok': return scope.kind === 'user' ? 'grok-cli' : 'grok-directory';
    case 'generic': return 'generic-skills';
  }
}
function configRoot(binding: DeploymentBinding): string {
  const entry = binding.consumers[0]?.entry;
  if (!entry) throw new Error('platformNamespaceUnconfirmed');
  return entry.kind === 'generic' ? entry.root : entry.configRoot;
}
export async function getDeploymentLayout(ctx: ReadContext, binding: DeploymentBinding): Promise<DeploymentLayout> {
  const pluginName = getNativePackageName(binding.plugin);
  const resourceKey = getDeploymentResourceKey(binding.plugin);
  const hostRoot = await canonicalNamespaceRoot(configRoot(binding));
  const scope: ScopeRef = binding.scope.kind === 'project' ? { kind: 'project', projectRoot: await canonicalNamespaceRoot(binding.scope.projectRoot) } : { kind: 'user' };
  const home = resolveUserHome(ctx.env ?? process.env, ctx.platform);
  const scopeRoot = scope.kind === 'project' ? scope.projectRoot : home;
  const awRoot = await canonicalNamespaceRoot(resolveAwHome(ctx.env));
  const namespaceId = identityDigest({ platform: binding.platform, route: binding.route, namespaceRoot: hostRoot }).slice(7);
  const managedRoot = path.join(awRoot, 'platforms', binding.platform, namespaceId);
  let namespaceRoot = hostRoot;
  let packageRoot = path.join(managedRoot, 'packages', binding.plugin.sourceId, pluginName);
  let activationPath = hostRoot;
  let supplementRoot: string | null = null;
  let marketplaceRoot: string | null = null;
  let marketplaceName: string | null = null;
  const renderScope: ScopeRef = hasSharedUserPackage(binding.platform) ? { kind: 'user' } : scope;
  let kinds = [...ALL_KINDS];
  switch (binding.route) {
    case 'codex-marketplace':
    case 'claude-marketplace':
    case 'copilot-marketplace':
      marketplaceRoot = path.join(managedRoot, 'marketplaces', binding.plugin.sourceId);
      marketplaceName = `aw-${binding.plugin.sourceId.toLowerCase().replace(/[^a-z0-9.-]/gu, '-').slice(0, 47)}-${identityDigest({ namespaceId, sourceId: binding.plugin.sourceId }).slice(7, 19)}`;
      packageRoot = path.join(marketplaceRoot, 'plugins', pluginName);
      activationPath = scope.kind === 'user' ? hostRoot : path.join(scopeRoot, binding.platform === 'copilot' ? '.github/copilot' : `.${binding.platform}`);
      if (binding.platform === 'codex') {
        kinds = kinds.filter((kind) => kind !== 'agent');
        supplementRoot = path.join(activationPath, 'agents');
      }
      break;
    case 'gemini-extension':
      activationPath = scope.kind === 'user' ? hostRoot : path.join(scopeRoot, '.gemini');
      break;
    case 'cursor-workspace-hook':
      namespaceRoot = scope.kind === 'user' ? hostRoot : path.join(scopeRoot, '.cursor');
      packageRoot = await resolveCursorPackageRoot(ctx, binding.plugin, scope, hostRoot);
      activationPath = path.join(namespaceRoot, 'hooks.json');
      break;
    case 'antigravity-cli':
      if (scope.kind !== 'user') throw new Error('scope-unsupported');
      break;
    case 'antigravity-directory':
      namespaceRoot = scope.kind === 'user' ? path.join(hostRoot, 'plugins') : path.join(scopeRoot, '.agents', 'plugins');
      packageRoot = path.join(namespaceRoot, resourceKey);
      activationPath = namespaceRoot;
      break;
    case 'opencode-directory':
      namespaceRoot = scope.kind === 'user' ? path.join(hostRoot, 'plugins') : path.join(scopeRoot, '.opencode', 'plugins');
      packageRoot = path.join(namespaceRoot, resourceKey);
      activationPath = namespaceRoot;
      break;
    case 'pi-package':
      namespaceRoot = scope.kind === 'user' ? hostRoot : path.join(scopeRoot, '.pi');
      packageRoot = path.join(namespaceRoot, 'aw-packages', resourceKey);
      activationPath = path.join(namespaceRoot, 'settings.json');
      break;
    case 'grok-cli':
      if (scope.kind !== 'user') throw new Error('scope-unsupported');
      supplementRoot = path.join(hostRoot, 'rules');
      kinds = kinds.filter((kind) => kind !== 'instruction');
      break;
    case 'grok-directory':
      if (scope.kind !== 'project') throw new Error('scope-unsupported');
      namespaceRoot = path.join(scopeRoot, '.grok', 'plugins');
      packageRoot = path.join(namespaceRoot, resourceKey);
      activationPath = path.join(scopeRoot, '.grok');
      supplementRoot = path.join(scopeRoot, '.grok', 'rules');
      kinds = kinds.filter((kind) => kind !== 'instruction');
      break;
    case 'generic-skills':
      namespaceRoot = scope.kind === 'user' ? hostRoot : path.join(scopeRoot, '.agents', 'skills');
      packageRoot = namespaceRoot;
      activationPath = namespaceRoot;
      kinds = ['skill'];
      break;
  }
  namespaceRoot = await canonicalNamespaceRoot(namespaceRoot);
  packageRoot = await canonicalizePathThroughExistingAncestor(packageRoot);
  activationPath = await canonicalizePathThroughExistingAncestor(activationPath);
  const physicalIdentity: PhysicalIdentity = { sourceIdentity: binding.plugin.sourceIdentity, pluginId: binding.plugin.pluginId,
    platform: binding.platform, route: binding.route, namespaceRoot, resourceKey };
  const physicalKey = getPhysicalKey(physicalIdentity);
  const renderUnits: RenderUnit[] = [{ id: identityDigest({ physicalKey, output: binding.platform === 'generic' ? 'generic' : 'package' }), physicalKey,
    renderScope, output: binding.platform === 'generic' ? 'generic' : 'package', kinds, consumers: binding.consumers }];
  if (supplementRoot) {
    supplementRoot = await canonicalNamespaceRoot(supplementRoot);
    const supplementKinds: ComponentKind[] = binding.platform === 'codex' ? ['agent'] : ['instruction'];
    const supplementKey = getPhysicalKey({ ...physicalIdentity, namespaceRoot: supplementRoot, resourceKey: `${resourceKey}:${supplementKinds[0]}` });
    renderUnits.push({ id: identityDigest({ physicalKey: supplementKey, output: 'supplement' }), physicalKey: supplementKey,
      renderScope: scope, output: 'supplement', kinds: supplementKinds, consumers: binding.consumers });
  }
  return { physicalIdentity, packageRoot, activationPath, supplementRoot, renderUnits, marketplaceRoot, marketplaceName,
    nativeIdentity: { route: binding.route, packageId: pluginName, ...(marketplaceName ? { registrationId: `${pluginName}@${marketplaceName}` } : {}), sourceLocation: packageRoot } };
}
export async function resolveDeployments(ctx: ReadContext, request: ResolveRequest): Promise<Resolution> {
  request = { ...request, scope: request.scope.kind === 'project'
    ? { kind: 'project', projectRoot: await canonicalNamespaceRoot(request.scope.projectRoot) } : { kind: 'user' } };
  const result: Resolution = { bindings: [], renderUnits: [], exclusions: [], diagnostics: [] };
  const bindings = new Map<string, DeploymentBinding>();
  for (const product of request.discovery.installations) {
    if (!['available', 'notApplicable'].includes(product.availability) || !product.entry) {
      result.exclusions.push({ productId: product.id, reasonCode: product.reasonCodes[0] ?? 'client-missing' }); continue;
    }
    const binding: DeploymentBinding = { id: '', plugin: request.plugin, platform: request.discovery.platform, scope: request.scope,
      route: getInstallRoute(request.discovery.platform, request.scope, product), consumers: [product], physicalKey: '', activationKey: '', renderUnitIds: [] };
    let layout: DeploymentLayout;
    try { layout = await getDeploymentLayout(ctx, binding); } catch {
      result.exclusions.push({ productId: product.id, reasonCode: 'deploymentLayoutUnconfirmed' });
      result.diagnostics.push({ code: 'deploymentLayoutUnconfirmed', severity: 'warning', message: 'The deployment path could not be verified.', subject: { target: binding.platform } });
      continue;
    }
    if (binding.platform === 'codex' && binding.scope.kind === 'project'
      && layout.activationPath === layout.physicalIdentity.namespaceRoot
      && (request.operation === 'ensure' || request.operation === 'reinstall')) {
      result.exclusions.push({ productId: product.id, reasonCode: 'codexScopePathAlias' });
      continue;
    }
    binding.physicalKey = getPhysicalKey(layout.physicalIdentity);
    binding.activationKey = identityDigest({ physicalKey: binding.physicalKey, scope: request.scope, activationPath: layout.activationPath });
    binding.id = identityDigest({ sourceIdentity: request.plugin.sourceIdentity, pluginId: request.plugin.pluginId, platform: binding.platform,
      scope: request.scope, route: binding.route, physicalKey: binding.physicalKey });
    const previous = bindings.get(binding.id);
    if (previous) previous.consumers.push(product);
    else bindings.set(binding.id, binding);
  }
  if (request.operation === 'remove' || request.operation === 'cleanup') for (const candidate of request.recoveryCandidates) {
    const binding = candidate.binding;
    let candidateKey: string;
    try { candidateKey = getPhysicalKey(candidate.physicalIdentity); } catch { continue; }
    if (candidate.evidence !== 'verified' || binding.plugin.sourceIdentity !== request.plugin.sourceIdentity || binding.plugin.pluginId !== request.plugin.pluginId
      || binding.platform !== request.discovery.platform || identityDigest(binding.scope) !== identityDigest(request.scope)
      || binding.physicalKey !== candidateKey) continue;
    if (!bindings.has(binding.id)) bindings.set(binding.id, binding);
  }
  for (const binding of bindings.values()) {
    let layout: DeploymentLayout;
    try { layout = await getDeploymentLayout(ctx, binding); } catch {
      result.exclusions.push({ productId: null, reasonCode: 'deploymentLayoutUnconfirmed' });
      continue;
    }
    if (getPhysicalKey(layout.physicalIdentity) !== binding.physicalKey) {
      result.exclusions.push({ productId: null, reasonCode: 'deploymentEvidenceMismatch' });
      continue;
    }
    binding.renderUnitIds = layout.renderUnits.map((unit) => unit.id);
    result.bindings.push(binding);
    for (const unit of layout.renderUnits) {
      const previous = result.renderUnits.find((entry) => entry.id === unit.id);
      if (previous) previous.consumers = [...new Map([...previous.consumers, ...unit.consumers].map((consumer) => [consumer.id, consumer])).values()];
      else result.renderUnits.push(unit);
    }
  }
  if (!result.bindings.length && !result.exclusions.length) result.exclusions.push({ productId: null, reasonCode: 'client-missing' });
  return result;
}

export async function resolveCursorPackageRoot(ctx: ReadContext, plugin: PluginIdentity, scope: ScopeRef, configRoot = resolvePlatformConfigRoot('cursor', ctx)): Promise<string> {
  const root = scope.kind === 'project' ? path.join(scope.projectRoot, '.cursor') : configRoot;
  return canonicalizePathThroughExistingAncestor(path.join(root, 'aw-plugins', getDeploymentResourceKey(plugin)));
}

export function getProfileRenderScopes(platform: DeploymentBinding['platform'], activationScope: ScopeRef['kind']): ScopeRef['kind'][] {
  if (platform === 'codex') return activationScope === 'project' ? ['user', 'project'] : ['user'];
  if (hasSharedUserPackage(platform)) return ['user'];
  return [activationScope];
}

/** Invocation policy is a scope-local host contribution, independent of shared package bytes. */
export async function getInvocationPolicyPhysicalKey(ctx: ReadContext, binding: DeploymentBinding): Promise<string> {
  if (binding.platform !== 'codex' && binding.platform !== 'claude') throw new Error('platformInvocationPolicyUnsupported');
  const layout = await getDeploymentLayout(ctx, binding);
  const namespaceRoot = await canonicalNamespaceRoot(binding.platform === 'codex'
    ? path.join(layout.activationPath, 'rules') : layout.activationPath);
  return getPhysicalKey({ ...layout.physicalIdentity, namespaceRoot,
    resourceKey: `${getDeploymentResourceKey(binding.plugin)}:permission` });
}
