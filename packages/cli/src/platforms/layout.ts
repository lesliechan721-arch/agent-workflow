import path from 'node:path';
import { getGrokPermissionConfigPath } from './grok-permission-config.js';
import { getAntigravityGlobalPermissionPath } from './antigravity-permissions.js';
import { isPermissionHost, type PermissionHost } from './host-permission-policy.js';
import { canonicalizePathThroughExistingAncestor, readEnvironmentValue, resolveAwHome, resolveUserHome } from '../utils/state-paths.js';
import { SKILL_OWNER_MARKER } from '../utils/ownership.js';
import { getNamespacedMarketplaceName } from '../utils/local-marketplace.js';
import { assertSafeFileMutationPath } from '../utils/safe-fs.js';
import { canonicalNamespaceRoot, getPhysicalKey, identityDigest } from './identity.js';
import { resolvePlatformConfigRoot, selectNativeProduct } from './discovery.js';
import type { ComponentKind, DeploymentBinding, InstallRoute, NativeIdentity, PhysicalIdentity, PluginIdentity, ReadContext, RenderUnit, Resolution, ResolveRequest, ScopeRef } from './contracts.js';

const ALL_KINDS: ComponentKind[] = ['skill', 'mcp', 'agent', 'hook', 'instruction'];
const SHARED_USER_PACKAGES = new Set<DeploymentBinding['platform']>(['codex', 'claude', 'copilot']);
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
export function isAntigravityProjectDirectory(binding: DeploymentBinding): boolean {
  return binding.route === 'antigravity-directory' && binding.scope.kind === 'project';
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
/** The exact previous slot of a short-name Project binding. */
export function antigravityLegacyProjectSlot(binding: DeploymentBinding, layout: DeploymentLayout):
  { path: string; physicalKey: string } | undefined {
  if (!isAntigravityProjectDirectory(binding) || layout.physicalIdentity.resourceKey !== getNativePackageName(binding.plugin)) return undefined;
  const identity = { ...layout.physicalIdentity, resourceKey: getDeploymentResourceKey(binding.plugin) };
  return { path: path.join(identity.namespaceRoot, identity.resourceKey), physicalKey: getPhysicalKey(identity) };
}
export function getInstallRoute(platform: DeploymentBinding['platform'], scope: ScopeRef, product: DeploymentBinding['consumers'][number]): InstallRoute {
  switch (platform) {
    case 'codex': return 'codex-marketplace';
    case 'claude': return 'claude-marketplace';
    case 'cursor': return 'cursor-workspace-hook';
    case 'antigravity': return scope.kind === 'user' && product.entry?.kind === 'cli' ? 'antigravity-cli' : 'antigravity-directory';
    case 'opencode': return 'opencode-directory';
    case 'pi': return 'pi-package';
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
export function getManagedPlatformRoot(awRoot: string, platform: DeploymentBinding['platform'], route: InstallRoute, namespaceRoot: string): string {
  const namespaceId = identityDigest({ platform, route, namespaceRoot }).slice(7);
  return path.join(awRoot, 'platforms', platform, namespaceId);
}
export async function getDeploymentLayout(ctx: ReadContext, binding: DeploymentBinding): Promise<DeploymentLayout> {
  const pluginName = getNativePackageName(binding.plugin);
  let resourceKey = getDeploymentResourceKey(binding.plugin);
  const hostRoot = await canonicalNamespaceRoot(configRoot(binding));
  const scope: ScopeRef = binding.scope.kind === 'project' ? { kind: 'project', projectRoot: await canonicalNamespaceRoot(binding.scope.projectRoot) } : { kind: 'user' };
  const home = resolveUserHome(ctx.env ?? process.env, ctx.platform);
  const scopeRoot = scope.kind === 'project' ? scope.projectRoot : home;
  const awRoot = await canonicalNamespaceRoot(resolveAwHome(ctx.env));
  const managedRoot = getManagedPlatformRoot(awRoot, binding.platform, binding.route, hostRoot);
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
      marketplaceName = getNamespacedMarketplaceName(binding.plugin.sourceId);
      packageRoot = path.join(marketplaceRoot, 'plugins', pluginName);
      activationPath = scope.kind === 'user' ? hostRoot : path.join(scopeRoot, binding.platform === 'copilot' ? '.github/copilot' : `.${binding.platform}`);
      if (binding.platform === 'codex') {
        kinds = kinds.filter((kind) => kind !== 'agent');
        supplementRoot = path.join(activationPath, 'agents');
      }
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
      activationPath = namespaceRoot;
      // Check the declared directory chain before canonicalization can follow
      // a project link into another project's or the user's plugin store.
      if (scope.kind === 'project') {
        await assertSafeFileMutationPath({ filePath: path.join(namespaceRoot, SKILL_OWNER_MARKER),
          allowedRoot: scopeRoot, label: 'Antigravity plugin directory' });
        const legacyKey = getPhysicalKey({ sourceIdentity: binding.plugin.sourceIdentity, pluginId: binding.plugin.pluginId,
          platform: binding.platform, route: binding.route, namespaceRoot, resourceKey });
        if (binding.physicalKey !== legacyKey) resourceKey = pluginName;
      }
      packageRoot = path.join(namespaceRoot, resourceKey);
      if (scope.kind === 'user') {
        await assertSafeFileMutationPath({ filePath: path.join(packageRoot, SKILL_OWNER_MARKER),
          allowedRoot: hostRoot, label: 'Antigravity plugin directory' });
      }
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
  // Keep the declared Project path. A symlink introduced in the plugin slot
  // is a collision for the directory owner reader.
  if (!isAntigravityProjectDirectory(binding)) {
    namespaceRoot = await canonicalNamespaceRoot(namespaceRoot);
    packageRoot = await canonicalizePathThroughExistingAncestor(packageRoot);
    activationPath = await canonicalizePathThroughExistingAncestor(activationPath);
  }
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
  const userAntigravityCli = request.discovery.platform === 'antigravity' && request.scope.kind === 'user'
    ? selectNativeProduct(request.discovery.installations) : undefined;
  for (const product of request.discovery.installations) {
    if (!['available', 'notApplicable'].includes(product.availability) || !product.entry) {
      result.exclusions.push({ productId: product.id, reasonCode: product.reasonCodes[0] ?? 'client-missing' }); continue;
    }
    // App and CLI use the same personal store. The CLI owns registration
    // when it is available and the App reads the resulting copy.
    const sharedAntigravityUserStore = userAntigravityCli?.entry?.kind === 'cli' && product.entry.kind === 'directory'
      && product.entry.configRoot === userAntigravityCli.entry.configRoot;
    const binding: DeploymentBinding = { id: '', plugin: request.plugin, platform: request.discovery.platform, scope: request.scope,
      route: getInstallRoute(request.discovery.platform, request.scope, sharedAntigravityUserStore ? userAntigravityCli : product),
      consumers: [product], physicalKey: '', activationKey: '', renderUnitIds: [] };
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

/** OpenCode's service replaces its global configuration root when this override is set. */
export function getOpenCodePermissionRoot(ctx: ReadContext, discovered?: string): string | undefined {
  const override = readEnvironmentValue(ctx.env ?? process.env, 'OPENCODE_CONFIG_DIR', ctx.platform);
  if (!override) return discovered ?? resolvePlatformConfigRoot('opencode', ctx);
  // A detached service may have changed its cwd. Only an absolute override
  // identifies the same writable directory for all observed products.
  return !override.includes('\0') && path.isAbsolute(override) ? path.normalize(override) : undefined;
}

/** Resolve the selected host settings independently of the plugin discovery directory. */
export async function scopedPermissionPath(ctx: ReadContext, platform: PermissionHost, scope: ScopeRef, discovered?: string): Promise<string | undefined> {
  if (platform === 'grok') {
    const root = scope.kind === 'project' ? path.join(await canonicalNamespaceRoot(scope.projectRoot), '.grok')
      : await canonicalNamespaceRoot(path.dirname(getGrokPermissionConfigPath(ctx, scope)));
    return path.join(root, 'config.toml');
  }
  if (platform === 'antigravity') return scope.kind === 'user' ? getAntigravityGlobalPermissionPath(ctx) : undefined;
  const user = getOpenCodePermissionRoot(ctx, discovered);
  if (!user) return undefined;
  return path.join(await canonicalNamespaceRoot(scope.kind === 'project' ? scope.projectRoot : user), 'opencode.json');
}

/** Host configuration or rule directory for the selected native scope. */
export async function getInvocationPolicyPath(ctx: ReadContext, binding: DeploymentBinding, existingLayout?: DeploymentLayout): Promise<string> {
  if (isPermissionHost(binding.platform)) {
    const destination = await scopedPermissionPath(ctx, binding.platform, binding.scope, configRoot(binding));
    if (!destination) throw new Error('permissionConfigurationPathUnconfirmed');
    return destination;
  }
  const layout = existingLayout ?? await getDeploymentLayout(ctx, binding);
  if (binding.platform === 'codex') return path.join(layout.activationPath, 'rules');
  if (binding.platform === 'claude') return path.join(layout.activationPath, binding.scope.kind === 'project' ? 'settings.local.json' : 'settings.json');
  throw new Error('platformInvocationPolicyUnsupported');
}

/** Invocation policy is a scope-local host contribution, independent of shared package bytes. */
export async function getInvocationPolicyPhysicalKey(ctx: ReadContext, binding: DeploymentBinding): Promise<string> {
  const layout = await getDeploymentLayout(ctx, binding);
  const destination = await getInvocationPolicyPath(ctx, binding, layout);
  // Keep previously issued Claude owner identities valid.
  const namespaceRoot = isPermissionHost(binding.platform) ? destination
    : await canonicalNamespaceRoot(binding.platform === 'claude' ? path.dirname(destination) : destination);
  return getPhysicalKey({ ...layout.physicalIdentity, namespaceRoot,
    resourceKey: `${getDeploymentResourceKey(binding.plugin)}:permission` });
}
