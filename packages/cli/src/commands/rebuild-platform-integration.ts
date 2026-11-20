import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { createMarketplaceManifestEntry, getComponentFeatureRequirements, normalizeStaticPluginComponents, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';
import type { DeploymentBinding, DeploymentExclusion, DeploymentObservation, DeploymentReceipt, FrozenDeploymentPlan, HostContribution, MutationOutcome, PreparedDeployment,
  GrokOrderEntry, PreparationEvidence, ProjectionResult, ReadContext, RenderUnit, Resolution } from '../platforms/contracts.js';
import { selectNativeProduct, supportsSharedNativeProbe, type PlacementProbeGroup } from '../platforms/discovery.js';
import type { NativeObservationBatch } from '../platforms/inspection-query.js';
import { getAgentPluginAdapter } from '../platforms/registry.js';
import { getAntigravityUnsupportedSkillControls, getQualifiedPlatformProfile } from '../platforms/capabilities.js';
import { getDeploymentLayout, getDeploymentResourceKey, getInvocationPolicyPhysicalKey, isAntigravityProjectDirectory } from '../platforms/layout.js';
import { getPhysicalKey } from '../platforms/identity.js';
import { antigravityLegacyProjectComponent, deploymentPackageComponent, inspectStaticSupplements, requiredDeploymentActivation } from '../platforms/inspection.js';
import { hasCompleteDeliveryDeclaration, type PlatformDriverState } from '../platforms/lifecycle.js';
import { piAgentConsumerDiagnostic, piProjectListContainsOnly } from '../platforms/inspection-pi.js';
import { grokRegistrationOwned, piProjectEmptyDeliveryObserved, piProjectRegistrationHidden, piProjectRemovalConfirmed } from '../platforms/lifecycle-native.js';
import { createNativeLifecycleServices } from '../platforms/lifecycle-native-services.js';
import { cursorWorkspaceOpenCommand } from '../platforms/projection.js';
import { cursorHookEntryCommand, cursorHooks } from '../platforms/cursor-workspace-hook.js';
import { gapSupplementFiles, ownedSupplementFile, staticSupplementFiles } from '../platforms/supplement-layout.js';
import { projectPlatformMarketplace } from '../platforms/projection-marketplace.js';
import { readStrictNamespacedMarketplaceRoot } from '../utils/local-marketplace.js';
import { isDeliveryCapabilityGap } from '../utils/component-gap.js';
import { artifactValueDigest, mergeExpectedComponentSets } from '../utils/artifact-plan.js';
import { preparePlatformComponents, resolveArtifactRenderConfig, type PreparedPlatformComponents } from '../utils/artifact-renderer.js';
import { finalizePlatformSkillProducers, type FinalizedPlatformComponents } from '../utils/component-command-preparation.js';
import { cleanupOwnedComponents, createSharedOwnerToken, inspectOwnedComponents, renderOwnedTextFile, writeOwnedTextFile,
  writeSkillOwnerMarker, type NativeProjectionEvidence, type OwnedComponent, type OwnedComponentExecutor } from '../utils/ownership.js';
import type { CleanupResult } from '../utils/ownership.js';
import { createPlatformInputEvidence, platformPackageInputDigest, platformPermissionNotices, readPlatformPackageContentDigest, writePlatformEmptyState, type PlatformEmptyState } from '../utils/platform-empty-state.js';
import { writePlatformSupplementState } from '../platforms/supplement-state.js';
import { atomicReplaceSafeFile, assertSafeFileMutationPath } from '../utils/safe-fs.js';
import { assertManagedCommandBindingIdentities, captureManagedCommandBindingRecoveryEvidence, publishManagedCommandBindings, listManagedCommands, readInstalledCommandProducer, revokeManagedCommandBindings,
  type ManagedCommandBindingRecoveryEvidence } from '../utils/managed-command-store.js';
import { captureNativeToolChanges, type NativeToolChange } from '../utils/native-tool-review.js';
import { captureManagedCommandReviewEvidence } from '../utils/managed-command-review.js';
import { readClaudeSettings } from '../adapters/helpers.js';
import { skillInvocationWarning } from '../utils/skill-invocation-warning.js';
import { readCodexConfigFile } from '../utils/codex-config.js';
import { parseOwnedTextHeader, readSkillOwnerMarker } from '../utils/ownership.js';
import type { RebuildExecutionContext, RebuildIntegration } from './rebuild-integration.js';
import { applyPlannedOperationAction, isNativeActivationOnlyTarget } from './rebuild-integration.js';
import { recoveryInterruptionCode } from '../recovery/interruption.js';
import type { InstallResource } from '../recovery/install-concurrency.js';
import type { DesiredTarget } from './rebuild-operations.js';

type TargetInput = Parameters<RebuildIntegration['buildTarget']>[0];
export interface PreparedPlatformTarget {
  deployments: PreparedDeployment<PlatformDriverState>[];
  plans: FrozenDeploymentPlan[];
  readonly blockedReceipts: readonly DeploymentReceipt[];
  readonly cleanupResults: readonly CleanupResult[];
  readonly writesManagedCommands?: boolean;
  privatePackage?: { prepare(): Promise<void>; dispose(): Promise<void> };
  captureNativeToolChanges(): Promise<NativeToolChange[]>;
  verify(batch?: NativeObservationBatch): Promise<void>;
  canVerifyAtExecution(): boolean;
  execute(options?: { verifyBeforeExecution: true }): Promise<DeploymentReceipt[]>;
  postcheck(receipts: readonly DeploymentReceipt[], options?: { refresh?: true; deliveredSkillsOnly?: true }): Promise<void>;
}
/** Resources touched by the frozen adapter plans, including host-managed writes. */
export function nativeInstallResources(plans: readonly FrozenDeploymentPlan[]): InstallResource[] {
  if (!plans.length) return [{ kind: 'exclusive' }];
  const paths = new Set<string>();
  for (const plan of plans) {
    const { binding, evidence } = plan;
    const { layout } = evidence;
    paths.add(layout.packageRoot);
    for (const { component } of evidence.ownership) {
      if ('path' in component) paths.add(component.path);
      else if (component.kind === 'shared-config' && component.locator.kind === 'claude-permissions') paths.add(component.locator.settingsPath);
      else if (component.kind === 'shared-config' && component.locator.kind === 'cursor-workspace-hook') paths.add(component.locator.hooksPath);
    }
    for (const projection of plan.projections) {
      for (const supplement of projection.supplements) paths.add(supplement.destination);
    }
    if (layout.marketplaceRoot) {
      for (const file of evidence.marketplace?.files ?? []) paths.add(path.join(layout.marketplaceRoot, file.relativePath));
    }
    // Grok inspects the entire project's packages and rules in one inventory.
    // Keep peers out until this write and its confirming inspection finish.
    if (binding.route === 'grok-directory') {
      if (plan.effects.length) paths.add(layout.activationPath);
      continue;
    }
    // These routes publish an entire, plugin-specific directory. activationPath
    // is its parent and is never replaced by the directory publisher.
    if (binding.route === 'opencode-directory' || binding.route === 'antigravity-directory') continue;
    paths.add(layout.activationPath);
    if (binding.route === 'pi-package' || binding.route === 'cursor-workspace-hook') continue;
    for (const consumer of binding.consumers) {
      if (!consumer.entry || consumer.entry.kind === 'generic') return [{ kind: 'exclusive' }];
      paths.add(consumer.entry.configRoot);
    }
  }
  return [...paths].map((value) => ({ kind: 'path', value }));
}
interface UnitPreparation {
  unit: RenderUnit;
  prepared: PreparedPlatformComponents;
  finalized: FinalizedPlatformComponents;
  evidenceInput: Parameters<typeof createPlatformInputEvidence>[0]['units'][number];
}
interface GrokPublication {
  scope: DeploymentBinding['scope']['kind'];
  scopeRoot: string;
  installedRoot?: string;
  nativeDigest: string;
  contentDigest: string;
  owner: Extract<OwnedComponent, { kind: 'owned-directory' | 'owned-text-file' }>;
  priorNativeDigest?: string;
  orderAfter?: NonNullable<NativeSources['grokScopeEvidence']>;
  shadowedUser?: GrokShadowedUser;
  sourceOrderAfter?: string[];
}
interface GrokShadowedUser {
  installedRoot: string;
  owner: ReturnType<typeof deploymentPackageComponent>;
  nativeDigest: string;
  contentDigest: string;
}
type NativeSources = NonNullable<DeploymentObservation['prerequisites']['nativeSources']>;
interface GrokProjectRetirement {
  projectRoot: string;
  name: string;
  projectPackage: string;
  projectDigest: string;
  userPackage: string;
  userDigest: string;
  userSource: string;
  userContentDigest: string;
  userPhysicalKey: string;
}
function matchesGrokComponentOrder(before: GrokOrderEntry[], after: GrokOrderEntry[], publishedRoots: ReadonlySet<string>): boolean {
  // Leave newly added or removed identities out of both sides. Every other
  // row, including a surviving component of an upgraded package, anchors order.
  const retained = (order: GrokOrderEntry[], other: GrokOrderEntry[]) => {
    const otherKeys = new Set(other.map(({ key }) => key));
    return order.filter(({ sourceRoot, key }) => sourceRoot === null || !publishedRoots.has(sourceRoot) || otherKeys.has(key));
  };
  const previous = retained(before, after);
  const current = retained(after, before);
  return previous.length === current.length && previous.every((row, index) => row.key === current[index]!.key);
}
function grokSourceDigest(sources: NativeSources, root: string, name: string, scope: DeploymentBinding['scope']['kind'], version?: string): string | undefined {
  const index = sources.sources.findIndex((source) => path.normalize(source.path) === root);
  const source = sources.sources[index];
  if (!sources.overlaps.includes(name) && source?.name === name && source.version
    && (!version || source.version === version) && source.scope === scope && source.origin === 'native' && source.enabled === true) {
    return sources.grokScopeEvidence?.sourceDigests[index];
  }
}
async function grokUserContentDigest(installedRoot: string, owner: GrokShadowedUser['owner']): Promise<string | undefined> {
  try {
    await assertSafeFileMutationPath({ filePath: path.join(installedRoot, '.grok-plugin', 'plugin.json'),
      allowedRoot: path.dirname(path.dirname(installedRoot)), label: 'Grok installed package' });
    const marker = await readSkillOwnerMarker({ skillRoot: owner.path, allowedRoot: owner.allowedRoot, expectedIdentity: owner.identity });
    const digest = marker?.nativeProjection?.contentDigest;
    if (digest && (await Promise.all([owner.path, installedRoot].map(readPlatformPackageContentDigest))).every((value) => value === digest)) return digest;
  } catch { /* Unverified bytes cannot explain the change of visible source. */ }
}
async function grokUserBehindProject(ctx: ReadContext, binding: DeploymentBinding,
  before: DeploymentObservation): Promise<Omit<GrokShadowedUser, 'contentDigest'> | undefined> {
  const sources = before.prerequisites.nativeSources;
  const registration = sources?.grokScopeEvidence?.userRegistrationDigest;
  if (binding.route !== 'grok-directory' || before.package !== 'absent' || before.ownership !== 'absent'
    || sources?.observation !== 'complete' || !registration) return;
  const name = before.nativeIdentity?.packageId;
  const user = sources.sources.find((source) => source.name === name && source.scope === 'user');
  if (!user) return;
  const nativeDigest = grokSourceDigest(sources, user.path, user.name, 'user', binding.plugin.version);
  if (!nativeDigest) return;
  const personal: DeploymentBinding = { ...binding, route: 'grok-cli', scope: { kind: 'user' } };
  const layout = await getDeploymentLayout(ctx, personal);
  if (registration !== artifactValueDigest([user.path, layout.packageRoot])) return;
  const owner = deploymentPackageComponent({ ...personal, physicalKey: getPhysicalKey(layout.physicalIdentity) }, layout);
  return { installedRoot: user.path, owner, nativeDigest };
}
interface TargetResolution extends Resolution {
  ordinaryEvidence?: { discovery: string; observations: Map<string, string> };
}

function nativeCopyIncomplete(binding: DeploymentBinding, after: DeploymentObservation, contentDigest: string): boolean {
  return ['antigravity-cli', 'grok-cli'].includes(binding.route)
    && after.nativePackageContentDigest !== contentDigest;
}

function piProjectInventoryKey(binding: DeploymentBinding, settingsPath: string): string | undefined {
  if (binding.route !== 'pi-package' || binding.scope.kind !== 'project') return undefined;
  const product = selectNativeProduct(binding.consumers);
  return product ? JSON.stringify([binding.scope.projectRoot, settingsPath, product.id]) : undefined;
}

function packageDeliveryConfirmed(binding: DeploymentBinding, after: DeploymentObservation, contentDigest: string,
  requireIndependentActivation: boolean): boolean {
  return after.package === 'present' && ['aw', 'shared'].includes(after.ownership)
    && !nativeCopyIncomplete(binding, after, contentDigest)
    && ['present', 'not-applicable'].includes(after.registration)
    && ['enabled', 'not-applicable'].includes(requiredDeploymentActivation(binding, after, requireIndependentActivation))
    && (binding.route !== 'cursor-workspace-hook' || after.workspaceOpen === 'present')
    && (binding.route !== 'claude-marketplace' || after.scopeRegistration === undefined || after.scopeRegistration === 'present');
}

function componentSupplementFiles(plan: FrozenDeploymentPlan): HostContribution[] {
  return plan.projections.filter((projection) => plan.evidence.renderUnits?.some((unit) =>
    unit.id === projection.renderUnitId && unit.output === 'supplement')).flatMap((projection) => projection.supplements
    .filter((contribution) => contribution.kind === 'owned-file'));
}

export function nativeDeploymentHasVerifiedComponentWrite(plan: FrozenDeploymentPlan, receipt: DeploymentReceipt): boolean {
  const { after, effects, unmet } = receipt;
  if (receipt.bindingId !== plan.binding.id || after.physicalKey !== plan.binding.physicalKey) return false;
  const delivered = after.components.filter(({ id, presence, reasonCodes }) => presence === 'present' && !reasonCodes.length
    && !unmet.some((gap) => !isDeliveryCapabilityGap(gap) && (gap.componentId ?? gap.id) === id));
  if (!delivered.length) return false;

  const bundle = plan.projections.find((projection) => projection.bundle)?.bundle;
  const supplementFiles = componentSupplementFiles(plan);
  return plan.effects.some((effect) => {
    if (!effects.some(({ id, status, mutation }) => id === effect.id && status === 'applied' && mutation === 'confirmed')) return false;
    const deliversComponents = effect.kind === 'publish-package'
      ? !plan.evidence.retainPackage && bundle && packageDeliveryConfirmed(plan.binding, after, bundle.contentDigest, true)
      : effect.kind === 'write-supplement' && supplementFiles.some((file) => file.destination === effect.destination);
    return deliversComponents && effect.componentIds.some((id) => delivered.some((component) => component.id === id));
  });
}

function recheckCopilotMarketplaceTimeout(receipt: DeploymentReceipt, fresh: DeploymentObservation): void {
  const { ownership, registration, diagnostics } = receipt.after;
  const [timeout] = diagnostics;
  if (ownership !== 'unknown' || registration !== 'present' || diagnostics.length !== 1
    || timeout?.code !== 'nativeMarketplaceUnconfirmed' || timeout.detail?.reasonCode !== 'nativeCliTimedOut') return;
  // Keep the local owner, marketplace, registration and activation from the same
  // read. Postcheck may annotate the receipt's components independently of rebase.
  receipt.after = structuredClone(fresh);
  receipt.diagnostics = receipt.diagnostics.filter((entry) => entry !== timeout);
  receipt.diagnostics.push(...receipt.after.diagnostics);
}

/** Fingerprints are operation-local evidence; they confer no ownership or deletion rights. */
async function pathEvidence(location: string): Promise<unknown> {
  const stat = await fs.lstat(location).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { link: await fs.readlink(location) };
  if (stat.isDirectory()) return Promise.all((await fs.readdir(location)).sort().map(async (name) =>
    [name, await pathEvidence(path.join(location, name))]));
  if (!stat.isFile()) throw new Error('deploymentEvidenceInvalid: a deployment resource is not a regular file.');
  return { mode: stat.mode & 0o777, digest: crypto.createHash('sha256').update(await fs.readFile(location)).digest('hex') };
}

async function ownedContentDigest(component: OwnedComponent): Promise<string | undefined> {
  if (component.kind === 'owned-directory' || component.kind === 'skill-directory') return readPlatformPackageContentDigest(component.path);
  if (component.kind === 'shared-config') {
    let value: unknown;
    if (component.locator.kind === 'claude-permissions') {
      const permissions = (await readClaudeSettings(component.locator.settingsPath)).awGenerated?.permissions?.[component.locator.ownerKey];
      if (permissions) value = { kind: 'claude-permissions', permissions };
    } else if (component.locator.kind === 'cursor-workspace-hook') {
      const locator = component.locator;
      const entries = cursorHooks(await jsonObject(locator.hooksPath)).entries;
      if (entries.some((entry) => cursorHookEntryCommand(entry) === locator.command)) value = { version: 1, hooks: { workspaceOpen: [{ command: locator.command }] } };
    }
    return value === undefined ? undefined : `sha256:${crypto.createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex')}`;
  }
  if (component.kind !== 'owned-text-file') return undefined;
  try {
    const parsed = parseOwnedTextHeader(await fs.readFile(component.path, 'utf8'), component.identity);
    return parsed ? `sha256:${crypto.createHash('sha256').update(parsed.content).digest('hex')}` : undefined;
  } catch { return undefined; }
}
async function ownedSupplements(binding: DeploymentBinding, root: string | null, physicalKey: string | undefined): Promise<OwnedComponent[]> {
  if (!root || !physicalKey) return [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  });
  const result: OwnedComponent[] = [];
  for (const entry of entries) {
    const location = path.join(root, entry.name);
    let identity;
    if (entry.isDirectory() && !entry.isSymbolicLink()) identity = (await readSkillOwnerMarker({ skillRoot: location, allowedRoot: root }).catch(() => null)) ?? undefined;
    else if (entry.isFile()) identity = parseOwnedTextHeader(await fs.readFile(location, 'utf8').catch(() => ''))?.identity;
    if (!identity || identity.sourceId !== binding.plugin.sourceId || identity.pluginId !== binding.plugin.pluginId
      || identity.sourceIdentity !== binding.plugin.sourceIdentity || identity.physicalKey !== physicalKey
      || identity.platform !== binding.platform || identity.scope !== binding.scope.kind) continue;
    result.push({ kind: entry.isDirectory() ? 'owned-directory' : 'owned-text-file', path: location, allowedRoot: root, identity });
  }
  return result;
}
function readContext(context: RebuildExecutionContext, cwd: string): ReadContext {
  return { cwd, env: context.env, runner: context.nativeCliRunner, signal: context.signal,
    codexObservationSession: context.codexObservationSession };
}
function operation(input: TargetInput): 'ensure' | 'reinstall' | 'remove' | 'cleanup' {
  return input.command === 'uninstall' ? 'remove' : input.command === 'cleanup' ? 'cleanup'
    : input.command === 'reinstall' ? 'reinstall' : 'ensure';
}
function sourceIdentity(input: TargetInput): DeploymentBinding['plugin'] {
  const sourceId = input.sourceId ?? input.plugin.sourceId;
  const sourceIdentity = input.sourceIdentity ?? input.plugin.sourceIdentity;
  const pluginId = input.pluginId ?? input.plugin.pluginId;
  if (!sourceId || !sourceIdentity || !pluginId) throw new Error('deploymentSourceIdentityMissing: a native deployment requires a verified catalog source.');
  return { sourceId, sourceIdentity, pluginId, version: input.plugin.manifest.version };
}
function targetIdentity(input: TargetInput): DesiredTarget['identity'] {
  return { ...sourceIdentity(input), pluginName: input.plugin.manifest.name,
    pluginVersion: input.plugin.manifest.version, platform: input.platform, scope: input.scope, cwd: input.cwd };
}
function contributionComponent(binding: DeploymentBinding, contribution: HostContribution, physicalKey: string): OwnedComponent {
  if (contribution.kind === 'owned-file') return ownedSupplementFile(binding, physicalKey, contribution.destination);
  const identity = { owner: 'agent-workflows' as const, sourceId: binding.plugin.sourceId,
    pluginId: binding.plugin.pluginId, plugin: binding.plugin.pluginId.split('/').at(-1)!,
    sourceIdentity: binding.plugin.sourceIdentity, physicalKey,
    platform: binding.platform, scope: binding.scope.kind, artifactKey: path.basename(contribution.destination) };
  if (contribution.kind === 'config-entry') {
    if (binding.platform === 'claude' && contribution.mergeKey?.startsWith('claude-permissions:')) {
      const owner = { ...identity, artifactKey: contribution.mergeKey.replace(':', '-') };
      return { kind: 'shared-config', identity: owner, label: contribution.destination,
        locator: { kind: 'claude-permissions', settingsPath: contribution.destination, ownerKey: createSharedOwnerToken(owner) } };
    }
    if (binding.platform !== 'cursor' || !contribution.mergeKey) throw new Error('platformContributionUnsupported');
    return { kind: 'shared-config', identity: { ...identity, artifactKey: `workspaceOpen-${identity.plugin}` },
      label: contribution.destination, locator: { kind: 'cursor-workspace-hook', hooksPath: contribution.destination,
        ownerKey: contribution.mergeKey, command: '' } };
  }
  return { kind: 'owned-directory',
    path: contribution.destination, allowedRoot: path.dirname(contribution.destination), identity };
}
async function jsonObject(file: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await fs.readJson(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('sharedConfigurationInvalid');
  return value as Record<string, unknown>;
}

export const platformOwnership: OwnedComponentExecutor = {
  async inspectShared(component) {
    if (component.locator.kind !== 'cursor-workspace-hook') throw new Error('sharedOwnershipUnsupported');
    const locator = component.locator;
    const { entries } = cursorHooks(await jsonObject(locator.hooksPath));
    return entries.some((entry) => cursorHookEntryCommand(entry) === locator.command) ? 'present' : 'absent';
  },
  async removeShared(component) {
    if (component.locator.kind !== 'cursor-workspace-hook') throw new Error('sharedOwnershipUnsupported');
    const locator = component.locator;
    const value = await jsonObject(locator.hooksPath);
    const { hooks, entries } = cursorHooks(value);
    const retained = entries.filter((entry) => cursorHookEntryCommand(entry) !== locator.command);
    if (retained.length === entries.length) return;
    await atomicReplaceSafeFile({ filePath: component.locator.hooksPath, allowedRoot: path.dirname(component.locator.hooksPath),
      content: `${JSON.stringify({ ...value, hooks: { ...hooks, workspaceOpen: retained } }, null, 2)}\n`, label: 'Cursor workspaceOpen' });
  },
};

async function requireWritable(component: OwnedComponent, executor: OwnedComponentExecutor = platformOwnership): Promise<'present' | 'absent'> {
  const inspection = await inspectOwnedComponents({ components: [component], executor });
  const state = inspection.components[0]!.state;
  if (state !== 'present' && state !== 'absent') throw new Error('operationPlanStale: deployment ownership changed.');
  return state;
}
async function publishDirectory(source: string, component: OwnedComponent, nativeProjection?: NativeProjectionEvidence, staged?: string): Promise<{ mutation: 'confirmed'; changed: true }> {
  if (component.kind !== 'owned-directory') throw new Error('deploymentPackageOwnerInvalid');
  await requireWritable(component);
  await assertSafeFileMutationPath({ filePath: path.join(component.allowedRoot, '.aw-publication-probe'),
    allowedRoot: component.allowedRoot, label: 'Native package', createParent: true });
  const staging = await fs.mkdtemp(path.join(component.allowedRoot, '.aw-package-'));
  const candidate = path.join(staging, component.identity.artifactKey);
  const verifiesContents = component.identity.platform === 'antigravity' && component.identity.scope === 'project';
  const backupRoot = `${staging}.previous`;
  const backup = verifiesContents ? path.join(backupRoot, component.identity.artifactKey) : backupRoot;
  let moved = false;
  try {
    if (staged && nativeProjection) {
      // A queued package can outlive its staging step. Verify its bytes before
      // consuming it and keep the final rename on the destination filesystem.
      if (await readPlatformPackageContentDigest(staged) !== nativeProjection.contentDigest) {
        throw new Error('operationPlanStale: staged native package content changed.');
      }
      try { await fs.rename(staged, candidate); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        await fs.copy(staged, candidate, { dereference: false });
      }
    } else await fs.copy(source, candidate, { dereference: false });
    await writeSkillOwnerMarker({ skillRoot: candidate, allowedRoot: staging, identity: component.identity, nativeProjection });
    const state = await requireWritable(component);
    if (verifiesContents ? state === 'present' : await fs.pathExists(component.path)) {
      await fs.move(component.path, backup);
      moved = true;
    }
    try {
      if (verifiesContents && moved && await requireWritable({ ...component, path: backup, allowedRoot: backupRoot }) !== 'present') {
        throw new Error('operationPlanStale: deployment backup could not be verified.');
      }
      await fs.move(candidate, component.path);
    }
    catch (error) { if (moved && !await fs.pathExists(component.path)) await fs.move(backup, component.path); throw error; }
    await fs.remove(backup);
    return { mutation: 'confirmed', changed: true };
  } finally {
    await fs.remove(staging);
    if (verifiesContents) await fs.rmdir(backupRoot).catch(() => undefined);
  }
}


async function sharedReferences(context: RebuildExecutionContext, binding: DeploymentBinding,
  observation: Awaited<ReturnType<ReturnType<typeof getAgentPluginAdapter>['inspect']>>,
  layout: Awaited<ReturnType<typeof getDeploymentLayout>>): Promise<PreparationEvidence['sharedReferences']> {
  if (!['codex-marketplace', 'claude-marketplace', 'copilot-marketplace'].includes(binding.route)) return 'none';
  const view = context.sharedReferenceView;
  const same = (reference: NonNullable<typeof view>['desired'][number]): boolean => reference.pluginId === binding.plugin.pluginId
    && reference.sourceIdentity === binding.plugin.sourceIdentity && reference.platform === binding.platform
    && (reference.physicalKey === undefined || reference.physicalKey === binding.physicalKey);
  const current = (reference: NonNullable<typeof view>['desired'][number]): boolean => reference.scope === binding.scope.kind
    && (reference.scope !== 'project' || binding.scope.kind === 'project' && reference.projectRoot === binding.scope.projectRoot);
  if (view && [...view.desired, ...view.observed].some((reference) => same(reference) && !current(reference))) return 'present';
  const host = binding.consumers.find((consumer) => consumer.entry?.kind === 'cli')?.entry;
  if (!host || host.kind !== 'cli' || observation.registration === 'unknown') return 'unknown';
  if (binding.route === 'claude-marketplace') {
    try {
      const installed = await jsonObject(path.join(host.configRoot, 'plugins', 'installed_plugins.json'));
      const plugins = installed.plugins;
      if (plugins !== undefined && (!plugins || typeof plugins !== 'object' || Array.isArray(plugins))) return 'unknown';
      const raw = (plugins as Record<string, unknown> | undefined)?.[layout.nativeIdentity.registrationId!];
      const records = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      for (const rawRecord of records) {
        if (!rawRecord || typeof rawRecord !== 'object') return 'unknown';
        const record = rawRecord as Record<string, unknown>;
        if (record.scope !== 'user' && record.scope !== 'local') return 'unknown';
        if (record.scope === 'local' && (typeof record.projectPath !== 'string' || !path.isAbsolute(record.projectPath))) return 'unknown';
        if (record.scope === 'user' ? binding.scope.kind !== 'user'
          : binding.scope.kind !== 'project' || path.resolve(record.projectPath as string) !== path.resolve(binding.scope.projectRoot)) return 'present';
      }
      return view && !view.desiredComplete ? 'unknown' : 'none';
    } catch { return 'unknown'; }
  }
  if (binding.route === 'codex-marketplace' && view?.desiredComplete && view.scopes.includes('user')
    && view.scopes.includes('project') && view.projectRoot) {
    const covered = view.observations.filter((reference) => same(reference) && reference.physicalKey === binding.physicalKey && reference.complete);
    if (covered.some((reference) => reference.scope === 'user')
      && covered.some((reference) => reference.scope === 'project' && reference.projectRoot === view.projectRoot)) {
      try {
        const config = await readCodexConfigFile(path.join(host.configRoot, 'config.toml'));
        // Only the already authorized project is read. Any additional native
        // project reference keeps the shared payload until its scope is observed.
        if (Object.values(config.snapshot.projects).some((project) => path.resolve(project.path) !== path.resolve(view.projectRoot!))) return 'unknown';
        if (binding.scope.kind === 'project' && config.snapshot.plugins[layout.nativeIdentity.registrationId!]?.enabled === true) return 'present';
        const project = await readCodexConfigFile(path.join(view.projectRoot, '.codex', 'config.toml'));
        if (binding.scope.kind === 'user' && project.snapshot.plugins[layout.nativeIdentity.registrationId!]?.enabled === true) return 'present';
        return 'none';
      } catch { return 'unknown'; }
    }
  }
  // These routes do not expose a complete global activation inventory. An absent
  // registration is sufficient for orphan payload cleanup; otherwise keep it.
  return observation.registration === 'absent' && view?.desiredComplete === true
    && view.scopes.includes('user') && view.scopes.includes('project') ? 'none' : 'unknown';
}

export class PlatformRebuildSession {
  private readonly targets = new Map<string, Promise<DesiredTarget>>();
  private readonly resolutions = new Map<string, Promise<TargetResolution>>();
  private readonly units = new Map<string, Promise<UnitPreparation>>();
  private readonly published = new Map<string, Promise<{ mutation: 'none' | 'confirmed' | 'possible'; changed: boolean }>>();
  private readonly nativeEffects = new Map<string, Promise<MutationOutcome>>();
  private readonly piProjectRegisteredRoots = new Map<string, Set<string>>();
  private readonly grokPublications = new Map<string, GrokPublication>();
  private readonly grokProjectRetirements = new Map<string, GrokProjectRetirement>();
  private readonly exclusions = new Map<string, DeploymentExclusion[]>();
  private readonly contexts = new Set<ReadContext>();
  private readonly mutableChecks = new Map<string, { physicalKey: string; marketplaceRoot: string | null;
    sourceId: string; sourceIdentity: string; assertStable(): Promise<void>;
    acceptMarketplaceRegistration(): Promise<void>;
    rebase(writtenFiles?: ReadonlyMap<string, { digest: string; componentIds: string[] }>): Promise<{
      observation: DeploymentObservation; verifiedSupplementIds: string[];
    }> }>();
  private readonly requestedOperations = new Map<string, TargetInput>();
  private readonly marketplaceTargets = new Set<DesiredTarget>();
  private marketplaceCandidatesFrozen = false;
  private ownership: OwnedComponentExecutor = platformOwnership;
  private readonly marketplaces = new Map<string, {
    evidence: NonNullable<PreparationEvidence['marketplace']>;
    currentFingerprint: string;
    publication?: Promise<void>;
  }>();
  private closedObservationBatch?: RebuildExecutionContext['nativeObservationBatch'];
  private staging?: Promise<string>;
  constructor(private context: RebuildExecutionContext,
    private readonly adapterFor: typeof getAgentPluginAdapter = getAgentPluginAdapter) {}
  updateContext(context: RebuildExecutionContext): void {
    this.context = context;
    for (const ctx of this.contexts) Object.assign(ctx, readContext(context, ctx.cwd));
  }
  setOwnershipExecutor(executor: OwnedComponentExecutor): void { this.ownership = executor; }
  private root(): Promise<string> { return this.staging ??= fs.mkdtemp(path.join(os.tmpdir(), 'aw-deployment-')); }
  private ordinaryReadContext(ctx: ReadContext, platform: TargetInput['platform']): ReadContext {
    const batch = this.context.nativeObservationBatch;
    // A locked re-Review starts its own observation batch. Cached targets of
    // the earlier Review do not close the new batch before its first build.
    const open = platform === 'pi'
      ? batch !== this.closedObservationBatch : this.targets.size === 0 && platform !== 'codex';
    return open && batch ? { ...ctx, ...batch } : ctx;
  }
  private recordGrokWrites(prepared: PreparedDeployment<PlatformDriverState>, receipt: DeploymentReceipt,
    packagePublished: boolean, writtenFiles: ReadonlyMap<string, { digest: string }>, shadowedUser?: GrokShadowedUser): void {
    const { binding, operation, evidence: { layout } } = prepared.plan;
    const sources = receipt.after.prerequisites.nativeSources;
    const evidence = sources?.grokScopeEvidence;
    if (!['grok-cli', 'grok-directory'].includes(binding.route) || operation !== 'ensure'
      || receipt.diagnostics.some((item) => item.severity === 'error') || sources?.observation !== 'complete' || !evidence) return;
    const scope = binding.scope.kind;
    const scopeRoot = binding.scope.kind === 'project' ? binding.scope.projectRoot : layout.activationPath;
    const { before, packageComponent: owner, bundle, contributions } = prepared.driverState;
    const priorSources = before.prerequisites.nativeSources;
    const identity = receipt.after.nativeIdentity;
    const registrationId = identity?.registrationId;
    const refreshed = binding.route === 'grok-cli' && registrationId && bundle
      && before.grokScopeAuthorization === 'granted' && receipt.after.grokScopeAuthorization === 'granted'
      && grokRegistrationOwned(binding, prepared.plan.evidence, before, identity)
      && grokRegistrationOwned(binding, prepared.plan.evidence, receipt.after, identity)
      && receipt.after.nativePackageContentDigest === bundle.contentDigest
      && prepared.plan.effects.some((effect) => effect.kind === 'refresh' && receipt.effects.some((result) =>
        result.id === effect.id && result.status === 'applied' && result.mutation === 'confirmed'));
    // A previous refusal can leave the AW source up to date. Only the confirmed
    // native refresh explains a change to the User inventory in this operation.
    const installedRoot = refreshed ? path.join(scopeRoot, 'installed-plugins', registrationId) : undefined;
    const root = installedRoot ?? path.normalize(layout.packageRoot);
    if ((refreshed || binding.route === 'grok-directory' && packagePublished) && priorSources?.observation === 'complete'
      && receipt.after.package === 'present' && receipt.after.ownership === 'aw' && bundle
      && owner?.kind === 'owned-directory' && owner.path === layout.packageRoot && identity?.route === binding.route
      && identity.sourceLocation === layout.packageRoot) {
      const newlyInstalled = binding.route === 'grok-directory' && before.package === 'absent' && before.ownership === 'absent'
        && !priorSources.sources.some((source) => path.normalize(source.path) === root
          || source.name === identity.packageId && source.path !== shadowedUser?.installedRoot)
        && (!shadowedUser || !sources.sources.some((source) => source.path === shadowedUser.installedRoot));
      const priorNativeDigest = before.package === 'present' && before.ownership === 'aw' && (refreshed || before.packageVersion)
        ? grokSourceDigest(priorSources, root, identity.packageId, scope, refreshed ? undefined : before.packageVersion) : undefined;
      const nativeDigest = grokSourceDigest(sources, root, identity.packageId, scope, binding.plugin.version);
      const knownHooks = !evidence.hookOrder.some((row) => row.sourceRoot === root) || prepared.plan.projections.some((projection) => projection.bundle
        && projection.components.some((component) => component.relativeOutputs.includes('hooks/hooks.json')));
      if ((newlyInstalled || priorNativeDigest) && nativeDigest && knownHooks) {
        this.grokPublications.set(root, { scope, scopeRoot, installedRoot, nativeDigest, priorNativeDigest, contentDigest: bundle.contentDigest,
          owner, orderAfter: evidence, shadowedUser,
          sourceOrderAfter: shadowedUser && sources.sources.map((source) => path.normalize(source.path)) });
      }
    }
    const prior = priorSources?.grokScopeEvidence?.instructions;
    for (const { effectId, component } of contributions) {
      if (component.kind !== 'owned-text-file' || !prior) continue;
      const written = writtenFiles.get(component.path);
      const rows = evidence.instructions.filter((row) => row.rulePath === component.path);
      const previous = prior.filter((row) => row.rulePath === component.path);
      if (written && rows.length === 1 && previous.length <= 1 && receipt.effects.some((effect) =>
        effect.id === effectId && effect.status === 'applied' && effect.mutation === 'confirmed')) {
        this.grokPublications.set(component.path, { scope, scopeRoot, nativeDigest: rows[0]!.digest,
          priorNativeDigest: previous[0]?.digest, contentDigest: written.digest, owner: component });
      }
    }
  }
  recordGrokProjectRetirement(projectRoot: string, project: DeploymentObservation, user: DeploymentObservation,
    removed: readonly string[]): void {
    const old = project.nativeIdentity;
    const replacement = user.nativeIdentity;
    if (old?.route !== 'grok-directory' || project.ownership !== 'aw' || project.package !== 'present'
      || replacement?.route !== 'grok-cli' || replacement.packageId !== old.packageId || !replacement.registrationId
      || user.ownership !== 'aw' || user.registration !== 'present' || user.nativePackage !== 'present' || !user.nativePackageContentDigest
      || path.dirname(old.sourceLocation) !== path.join(projectRoot, '.grok', 'plugins') || !removed.includes(path.basename(old.sourceLocation))) return;
    const before = project.prerequisites.nativeSources;
    const personal = user.prerequisites.nativeSources;
    if (before?.observation !== 'complete' || personal?.observation !== 'complete') return;
    const source = personal.sources.find(({ name, path: location }) => name === old.packageId
      && path.basename(location) === replacement.registrationId && path.basename(path.dirname(location)) === 'installed-plugins');
    const projectDigest = grokSourceDigest(before, old.sourceLocation, old.packageId, 'project');
    const userDigest = source && grokSourceDigest(personal, source.path, old.packageId, 'user');
    if (!projectDigest || !source || !userDigest) return;
    this.grokProjectRetirements.set(old.sourceLocation, { projectRoot, name: old.packageId, projectPackage: old.sourceLocation,
      projectDigest, userPackage: source.path, userDigest, userSource: replacement.sourceLocation,
      userContentDigest: user.nativePackageContentDigest, userPhysicalKey: user.physicalKey });
  }
  async dispose(): Promise<void> {
    for (const result of await Promise.allSettled(this.units.values())) if (result.status === 'fulfilled') await result.value.finalized.cleanup();
    if (this.staging) await fs.remove(await this.staging);
    this.staging = undefined;
    this.targets.clear(); this.resolutions.clear(); this.units.clear(); this.published.clear();
    this.nativeEffects.clear(); this.piProjectRegisteredRoots.clear(); this.exclusions.clear();
    this.grokPublications.clear();
    this.grokProjectRetirements.clear();
    this.contexts.clear(); this.mutableChecks.clear(); this.requestedOperations.clear(); this.marketplaces.clear();
    this.marketplaceTargets.clear(); this.marketplaceCandidatesFrozen = false;
  }
  freezeMarketplaceCandidates(): void { this.marketplaceCandidatesFrozen = true; }
  private key(input: TargetInput): string { return artifactValueDigest({ plugin: sourceIdentity(input), platform: input.platform, scope: input.scope, cwd: input.scope === 'project' ? input.cwd : null, operation: operation(input) }); }
  private resolve(input: TargetInput, placementProbeGroup?: PlacementProbeGroup): Promise<TargetResolution> {
    const key = this.key(input);
    // Inspection of a shared package does not request activation in that scope.
    if (!input.readOnlyInspectionPlan) this.requestedOperations.set(key, input);
    let result = this.resolutions.get(key);
    if (!result) {
      result = (async () => {
        const adapter = this.adapterFor(input.platform);
        const ctx = input.readOnlyInspectionPlan && input.observationBatch ? { ...readContext(this.context, input.cwd), ...input.observationBatch }
          : this.ordinaryReadContext(readContext(this.context, input.cwd), input.platform);
        const plugin = sourceIdentity(input);
        const recoveryCandidates = (this.context.recoveryCandidates ?? []).filter((candidate) => candidate.binding.platform === input.platform
          && candidate.binding.plugin.sourceIdentity === plugin.sourceIdentity && candidate.binding.plugin.pluginId === plugin.pluginId
          && candidate.binding.scope.kind === input.scope && (candidate.binding.scope.kind !== 'project' || candidate.binding.scope.projectRoot === input.cwd));
        const scope = input.scope === 'project' ? { kind: 'project' as const, projectRoot: input.cwd } : { kind: 'user' as const };
        const discovery = await adapter.discover(placementProbeGroup ? { ...ctx, placementProbeGroup } : ctx);
        const resolution = await adapter.resolve(ctx, { plugin, scope, operation: operation(input), discovery, recoveryCandidates });
        this.exclusions.set(key, resolution.exclusions.flatMap((exclusion): DeploymentExclusion[] => {
          if (!exclusion.productId) return [];
          const product = discovery.installations.find((item) => item.id === exclusion.productId) ?? null;
          if (product?.availability === 'missing' || product?.availability === 'notApplicable') return [];
          return [{ platform: input.platform, pluginId: plugin.pluginId, scope, productId: exclusion.productId,
            product: product ? structuredClone(product) : null, reasonCode: exclusion.reasonCode, execution: 'not-run',
            recoveryActions: ['Check the identified client version and installation entry, then retry this product.'] }];
        }));
        if (recoveryCandidates.length) {
          const allowed = new Set(recoveryCandidates.map((candidate) => candidate.binding.physicalKey));
          resolution.bindings = resolution.bindings.filter((binding) => allowed.has(binding.physicalKey));
          const unitIds = new Set(resolution.bindings.flatMap((binding) => binding.renderUnitIds));
          resolution.renderUnits = resolution.renderUnits.filter((unit) => unitIds.has(unit.id));
        }
        return ctx.discoveryCache ? { ...resolution,
          ordinaryEvidence: { discovery: artifactValueDigest(discovery), observations: new Map<string, string>() } } : resolution;
      })();
      this.resolutions.set(key, result);
    }
    return result;
  }
  /** Resolve the whole selected scope before any physical unit is rendered. */
  async resolveAll(inputs: readonly TargetInput[]): Promise<void> {
    const first = inputs[0];
    const samePlacement = supportsSharedNativeProbe && first && inputs.length > 1
      && this.context.batchInstallPlatform === first.platform && this.context.nativeObservationBatch?.scriptFreePlacement === true
      && inputs.every((input) => input.platform === first.platform && input.scope === first.scope && input.cwd === first.cwd
        && operation(input) === 'ensure');
    const group = samePlacement ? { scope: first.scope, probes: new Map() } : undefined;
    await Promise.allSettled(inputs.map((input) => this.resolve(input, group)));
  }
  private async freezeSharedPreApplyActions(targets: readonly DesiredTarget[]): Promise<void> {
    const prepared = (await Promise.allSettled(this.targets.values())).flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    for (const target of targets) {
      if (target.identity.scope !== 'project' || !target.operationActions?.some((action) => action.kind === 'runPreApply')) continue;
      const plans = target.platformDeployment?.plans ?? [];
      if (!plans.length || plans.some((plan) => !['codex-marketplace', 'claude-marketplace', 'copilot-marketplace'].includes(plan.binding.route)
        || plan.effects.some((effect) => effect.physicalKey !== plan.binding.physicalKey)
        || plan.projections.some((projection) => projection.supplements.length > 0)
        || !plan.evidence.renderUnits?.some((unit) => unit.output === 'package' && unit.renderScope.kind === 'user'))) continue;
      const provider = prepared.find((candidate) => candidate.identity.scope === 'user' && candidate.identity.platform === target.identity.platform
        && candidate.identity.pluginId === target.identity.pluginId && candidate.identity.sourceIdentity === target.identity.sourceIdentity
        && candidate.operationActions?.some((action) => action.kind === 'runPreApply')
        && plans.every((plan) => candidate.platformDeployment?.plans.some((other) => other.binding.physicalKey === plan.binding.physicalKey)));
      if (!provider) continue;
      const input = { sourceId: target.identity.sourceId!, sourceIdentity: target.identity.sourceIdentity!,
        pluginName: target.plugin.manifest.name, manifest: target.plugin.manifest, platform: target.identity.platform,
        logicalIdentity: target.plugin.catalogLogicalIdentity, cwd: target.identity.cwd,
        env: this.context.env, referencePlugins: this.context.referencePlugins };
      const [userConfig, projectConfig] = await Promise.all([
        resolveArtifactRenderConfig({ ...input, scope: 'user' }), resolveArtifactRenderConfig({ ...input, scope: 'project' }),
      ]);
      if (artifactValueDigest(userConfig.values) !== artifactValueDigest(projectConfig.values)) continue;
      target.operationActions = target.operationActions.filter((action) => action.kind !== 'runPreApply');
    }
  }
  /** Freeze one complete source descriptor after all eligible packages have been prepared. */
  async sealMarketplaceGenerations(targets: readonly DesiredTarget[]): Promise<void> {
    if (this.marketplaceCandidatesFrozen && targets.some((target) => !this.marketplaceTargets.has(target))) {
      throw new Error('operationPlanStale: the reviewed marketplace candidates changed.');
    }
    for (const target of targets) this.marketplaceTargets.add(target);
    targets = [...this.marketplaceTargets];
    await this.freezeSharedPreApplyActions(targets);
    const retained = new Map(targets.flatMap((target) => (target.platformDeployment?.plans ?? [])
      .filter((plan) => plan.evidence.retainPackage).map((plan) => [plan.binding.physicalKey, plan.expected.unmet] as const)));
    for (const target of targets) for (const deployment of [...target.platformDeployment?.deployments ?? []]) {
      const unmet = retained.get(deployment.plan.binding.physicalKey);
      if (!unmet || deployment.plan.evidence.retainPackage) continue;
      const next = this.adapterFor(deployment.plan.binding.platform).lifecycle.prepare({ ...deployment.plan,
        observation: deployment.driverState.before, expected: { ...deployment.plan.expected,
          unmet: [...deployment.plan.expected.unmet, ...unmet] }, evidence: { ...deployment.plan.evidence, retainPackage: true } });
      if (next.status !== 'ready') throw new Error('sharedPackageRetentionUnconfirmed');
      const prepared = target.platformDeployment!;
      prepared.deployments.splice(prepared.deployments.indexOf(deployment), 1, next.prepared);
      prepared.plans.splice(prepared.plans.findIndex((plan) => plan.binding.id === deployment.plan.binding.id), 1, next.prepared.plan);
    }
    const groups = new Map<string, Array<{ target: DesiredTarget; deployment: PreparedDeployment<PlatformDriverState> }>>();
    for (const target of targets) for (const deployment of target.platformDeployment?.deployments ?? []) {
      const root = deployment.plan.evidence.layout.marketplaceRoot;
      if (!root || deployment.plan.evidence.retainPackage || !deployment.plan.projections.some((projection) => projection.bundle)) continue;
      const values = groups.get(root) ?? []; values.push({ target, deployment }); groups.set(root, values);
    }
    for (const [root, entries] of groups) {
      const first = entries[0]!;
      const binding = first.deployment.plan.binding;
      if (binding.platform !== 'codex' && binding.platform !== 'claude' && binding.platform !== 'copilot') throw new Error('platformMarketplaceRouteUnsupported');
      const marketplaceName = first.deployment.plan.evidence.layout.marketplaceName!;
      const previous = await readStrictNamespacedMarketplaceRoot({ rootDir: root, sourceId: binding.plugin.sourceId,
        sourceIdentity: binding.plugin.sourceIdentity, marketplaceName, platform: binding.platform });
      const candidates = [...new Map(entries.map(({ target }) => [target.plugin.manifest.name,
        { ...createMarketplaceManifestEntry(target.plugin), version: target.plugin.manifest.version }])).values()];
      const descriptor = projectPlatformMarketplace({ binding, marketplaceName, entries: candidates });
      const projected = JSON.parse(descriptor.bytes.toString('utf8')) as Record<string, unknown>;
      const previousEntries = previous?.manifest.plugins ?? [];
      if (!Array.isArray(previousEntries)) throw new Error('marketplaceRootInvalid: plugins must be an array.');
      const retained = previousEntries.filter((item: unknown) => {
        if (!item || typeof item !== 'object' || !('name' in item) || typeof item.name !== 'string'
          || !('source' in item) || item.source !== `./plugins/${item.name}`
          || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item.name)) throw new Error('marketplaceRootInvalid: an existing entry has an unverified location.');
        return !candidates.some((candidate) => candidate.name === item.name);
      });
      if (!Array.isArray(projected.plugins)) throw new Error('platformMarketplaceProjectionInvalid');
      projected.plugins = [...retained, ...projected.plugins].sort((left, right) => String(left.name).localeCompare(String(right.name)));
      const contents = [{ relativePath: descriptor.relativePath, bytes: Buffer.from(`${JSON.stringify(projected, null, 2)}\n`) },
        { relativePath: 'config.json', bytes: Buffer.from(`${JSON.stringify({ schemaVersion: 2, sourceId: binding.plugin.sourceId,
          sourceIdentity: binding.plugin.sourceIdentity, marketplaceName, logicalIdentity: first.target.plugin.catalogLogicalIdentity }, null, 2)}\n`) }];
      const files = contents.map(({ relativePath, bytes }) => ({ relativePath, contentBase64: bytes.toString('base64'),
        contentDigest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` }));
      const currentFingerprint = artifactValueDigest(await Promise.all(files.map((file) => pathEvidence(path.join(root, file.relativePath)))));
      const previousGeneration = this.marketplaces.get(root);
      const candidatesChanged = previousGeneration !== undefined
        && artifactValueDigest(previousGeneration.evidence.files) !== artifactValueDigest(files);
      if (previousGeneration && (previousGeneration.currentFingerprint !== currentFingerprint
        || candidatesChanged && (this.marketplaceCandidatesFrozen || previousGeneration.publication))) {
        throw new Error('operationPlanStale: the shared marketplace generation changed.');
      }
      // Scope plans can arrive separately during preparation. Complete the same
      // generation before Review; once frozen or published, its bytes cannot grow.
      const evidence = previousGeneration && !candidatesChanged ? previousGeneration.evidence
        : { files, fingerprint: artifactValueDigest({ currentFingerprint, files }) };
      this.marketplaces.set(root, previousGeneration && !candidatesChanged ? previousGeneration : { evidence, currentFingerprint });
      for (const { target, deployment } of entries) {
        const adapter = this.adapterFor(deployment.plan.binding.platform);
        const next = adapter.lifecycle.prepare({ ...deployment.plan, observation: deployment.driverState.before,
          evidence: { ...deployment.plan.evidence, marketplace: evidence } });
        if (next.status !== 'ready') throw new Error('operationPlanStale: the marketplace generation could not be sealed.');
        const prepared = target.platformDeployment!;
        prepared.deployments.splice(prepared.deployments.indexOf(deployment), 1, next.prepared);
        prepared.plans.splice(prepared.plans.findIndex((plan) => plan.binding.id === deployment.plan.binding.id), 1, next.prepared.plan);
      }
    }
    for (const target of targets) if (target.platformDeployment) {
      target.nativeToolChanges = await target.platformDeployment.captureNativeToolChanges();
    }
  }
  private async verifyMarketplace(plan: FrozenDeploymentPlan): Promise<boolean> {
    if (!plan.evidence.layout.marketplaceRoot || !plan.evidence.marketplace) return true;
    const root = plan.evidence.layout.marketplaceRoot;
    const generation = this.marketplaces.get(root);
    return !!generation && artifactValueDigest(await Promise.all(generation.evidence.files.map((file) => pathEvidence(path.join(root, file.relativePath))))) === generation.currentFingerprint;
  }
  private async publishMarketplace(plan: FrozenDeploymentPlan): Promise<void> {
    const root = plan.evidence.layout.marketplaceRoot;
    if (!root) return;
    const generation = this.marketplaces.get(root);
    if (!generation || !plan.evidence.marketplace) throw new Error('marketplaceGenerationNotPrepared');
    if (!generation.publication) generation.publication = (async () => {
      if (!await this.verifyMarketplace(plan)) throw new Error('operationPlanStale: the marketplace source changed.');
      for (const file of generation.evidence.files) {
        await atomicReplaceSafeFile({ filePath: path.join(root, file.relativePath), allowedRoot: root,
          content: Buffer.from(file.contentBase64, 'base64').toString('utf8'), label: 'Native marketplace source' });
      }
      generation.currentFingerprint = artifactValueDigest(await Promise.all(generation.evidence.files.map((file) => pathEvidence(path.join(root, file.relativePath)))));
    })();
    await generation.publication;
  }
  async buildTarget(input: TargetInput): Promise<DesiredTarget> {
    if (input.readOnlyInspectionPlan) return this.build(input);
    const key = this.key(input);
    let verifyInitial: (() => Promise<void>) | undefined;
    let target = this.targets.get(key);
    if (!target) {
      target = this.build(input, (check) => { verifyInitial = check; });
      this.targets.set(key, target);
    }
    // A writable build or cached-target verification ends ordinary sharing,
    // before any renderer, plan verification or mutation can consume it.
    if (this.context.nativeObservationBatch) this.closedObservationBatch = this.context.nativeObservationBatch;
    const result = await target;
    if (verifyInitial) await verifyInitial();
    else await result.platformDeployment?.verify(input.observationBatch);
    return result;
  }
  private async build(input: TargetInput, receiveInitialVerifier?: (check: () => Promise<void>) => void): Promise<DesiredTarget> {
    const ctx = readContext(this.context, input.cwd);
    const ordinaryCtx = input.readOnlyInspectionPlan && input.observationBatch ? { ...ctx, ...input.observationBatch }
      : this.ordinaryReadContext(ctx, input.platform);
    const resolution = await this.resolve(input);
    if (!resolution.bindings.length) throw Object.assign(
      new Error(`platformUnavailable: ${resolution.exclusions.map((item) => item.reasonCode).join(', ') || input.platform}`),
      { deploymentExclusions: this.exclusions.get(this.key(input)) ?? [] });
    const adapter = this.adapterFor(input.platform);
    // An activation-only Project action restores access to its existing User provider.
    const requireIndependentActivation = input.platform !== 'codex' || !isNativeActivationOnlyTarget(this.context, {
      pluginId: sourceIdentity(input).pluginId, platform: input.platform, scope: input.scope,
    });
    this.contexts.add(ctx);
    const observed = await Promise.all(resolution.bindings.map(async (binding) => ({ binding,
      observation: await adapter.inspect(ordinaryCtx, binding), layout: await getDeploymentLayout(ctx, binding) })));
    const { ordinaryEvidence } = resolution;
    if (ordinaryEvidence && (ordinaryCtx.nativeQuerySession || !input.readOnlyInspectionPlan)) {
      // Keep the first observation used for placement, including for targets
      // built after the observation batch has already ended.
      for (const { binding, observation } of observed) {
        const digest = artifactValueDigest(observation);
        const previous = ordinaryEvidence.observations.get(binding.id);
        if (previous === undefined) ordinaryEvidence.observations.set(binding.id, digest);
        else if (!input.readOnlyInspectionPlan && previous !== digest) {
          throw new Error('operationPlanStale: deployment evidence changed after the ordinary observation.');
        }
      }
    }
    if (input.readOnlyInspectionPlan && !input.readOnlyShallowInspectionPlan) for (const entry of observed) {
      const unit = entry.layout.renderUnits.find((candidate) => candidate.output === 'supplement');
      if (!unit) continue;
      const expected = await normalizeStaticPluginComponents({ pluginRoot: input.plugin.rootDir, manifest: input.plugin.manifest,
        platform: input.platform, capabilities: adapter.capabilities({ binding: entry.binding, renderUnit: unit,
          observation: entry.observation, profile: getQualifiedPlatformProfile(input.platform) }), allowedOutputKinds: unit.kinds });
      const supplements = await inspectStaticSupplements(ctx, entry.binding, expected.components);
      entry.observation.components.push(...supplements.components);
    }
    const owned = observed.flatMap(({ binding, layout }) => [deploymentPackageComponent(binding, layout),
      ...(input.readOnlyInspectionPlan ? staticSupplementFiles(binding, layout, input.plugin.manifest) : [])]);
    const target: DesiredTarget = { plugin: input.plugin, identity: targetIdentity(input), ownedComponents: owned,
      platformObservations: observed.map(({ binding, observation }) => ({ binding, observation })),
      desiredOwnedComponents: owned, requiresNative: false, writeNativeRequired: false, artifacts: [], preApplySource: input.plugin,
      deploymentExclusions: this.exclusions.get(this.key(input)) ?? [] };
    if (input.readOnlyInspectionPlan) return target;
    const removing = operation(input) === 'remove' || operation(input) === 'cleanup';
    const preparedUnits = new Map<string, UnitPreparation>();
    if (!removing) for (const unit of resolution.renderUnits) {
      const bindingEntry = observed.find(({ binding }) => binding.renderUnitIds.includes(unit.id));
      if (!bindingEntry) throw new Error('deploymentRenderUnitUnbound');
      const compatible = (await Promise.allSettled([...this.resolutions.values()])).flatMap((result) => result.status === 'fulfilled' ? result.value.renderUnits : []).filter((item) => item.physicalKey === unit.physicalKey);
      if (compatible.some((item) => artifactValueDigest({ scope: item.renderScope, kinds: item.kinds, output: item.output })
        !== artifactValueDigest({ scope: unit.renderScope, kinds: unit.kinds, output: unit.output }))) throw new Error('shared-projection-conflict');
      const commonUnit = { ...unit, consumers: [...new Map(compatible.flatMap((item) => item.consumers).map((consumer) => [consumer.id, consumer])).values()] };
      let promise = this.units.get(unit.physicalKey);
      if (!promise) {
        promise = (async () => {
          const capabilities = adapter.capabilities({ ...bindingEntry, renderUnit: commonUnit, profile: getQualifiedPlatformProfile(input.platform) });
          const config = await resolveArtifactRenderConfig({ ...sourceIdentity(input), logicalIdentity: input.plugin.catalogLogicalIdentity,
            pluginName: input.plugin.manifest.name, manifest: input.plugin.manifest, platform: input.platform,
            scope: unit.renderScope.kind, cwd: unit.renderScope.kind === 'project' ? unit.renderScope.projectRoot : input.cwd,
            env: this.context.env, referencePlugins: this.context.referencePlugins });
          const platformRoot = path.join(input.plugin.rootDir, input.platform);
          const staticResourceRoot = await fs.pathExists(platformRoot) ? platformRoot : input.plugin.rootDir;
          // Grok prepares the package before its rules. Only roles prepared for this same target can receive the text.
          const grokRoleUnit = input.platform === 'grok' && unit.output === 'supplement'
            ? bindingEntry.layout.renderUnits.find((candidate) => candidate.output === 'package'
              && artifactValueDigest(candidate.renderScope) === artifactValueDigest(unit.renderScope)) : undefined;
          const prepared = await preparePlatformComponents({ plugin: input.plugin, platform: input.platform, staticResourceRoot,
            renderScope: unit.renderScope.kind, kinds: unit.kinds, capabilities, config, cwd: input.cwd,
            hasInstructionAgentRecipients: grokRoleUnit && preparedUnits.get(grokRoleUnit.id)?.prepared.expected.components.some(({ kind }) => kind === 'agent'),
            commandEnv: this.context.env, signal: this.context.signal, scriptTimeoutMs: this.context.scriptTimeoutMs,
            preparedResults: this.context.preparedArtifactRenderResults });
          const finalized = await finalizePlatformSkillProducers({ plugin: input.plugin, plugins: this.context.referencePlugins,
            platform: input.platform, renderUnit: commonUnit, prepared, skillWorkRoot: path.join(await this.root(), artifactValueDigest(unit.physicalKey).slice(7), 'skills'),
            cwd: input.cwd, env: this.context.env, signal: this.context.signal, scriptTimeoutMs: this.context.scriptTimeoutMs,
            packagePreparationCache: this.context.packagePreparationCache });
          return { unit: commonUnit, prepared: finalized.prepared, finalized,
            evidenceInput: { renderUnit: commonUnit, capabilities, config } };
        })();
        this.units.set(unit.physicalKey, promise);
      }
      preparedUnits.set(unit.id, await promise);
    }
    const deployments: PreparedDeployment<PlatformDriverState>[] = [];
    const plans: FrozenDeploymentPlan[] = [];
    const blockedReceipts: DeploymentReceipt[] = [];
    const cleanupResults: CleanupResult[] = [];
    const checks = new Map<string, (batch?: NativeObservationBatch) => Promise<boolean>>();
    const shadowedUsers = new Map<string, GrokShadowedUser>();
    let initialDiscoveryCheck: (() => Promise<boolean>) | undefined;
    const priorProducers = new Map<string, ProducerIdentity[]>();
    const priorResourceRoots = new Map<string, string[]>();
    const bindingRecoveryEvidence: ManagedCommandBindingRecoveryEvidence[] = [];
    const emptyStates = new Map<string, PlatformEmptyState>();
    const gapStates = new Map<string, PlatformEmptyState>();
    const inputDigests = new Map<string, string>();
    const supplementInputDigests = new Map<string, string>();
    const commandInventory = await listManagedCommands(this.context.env);
    for (const entry of observed) priorProducers.set(entry.binding.id, commandInventory.commands.flatMap((command) => {
      if (command.owner.kind !== 'plugin') return [];
      const producer = command.owner.producer;
      return producer.kind !== 'package' && producer.sourceId === entry.binding.plugin.sourceId
        && producer.sourceIdentity === entry.binding.plugin.sourceIdentity && producer.pluginName === input.plugin.manifest.name
        && producer.platform === entry.binding.platform && producer.placementKey === entry.binding.physicalKey ? [producer] : [];
    }));
    for (const entry of observed) {
      const component = deploymentPackageComponent(entry.binding, entry.layout);
      if (component.kind !== 'owned-directory') continue;
      const marker = await readSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot,
        expectedIdentity: component.identity }).catch(() => null);
      for (const mapping of marker?.nativeProjection?.components ?? []) {
        if (!mapping.relativeOutputs.includes(`skills/${mapping.nativeName}/SKILL.md`)) continue;
        const root = path.join(component.path, 'skills', mapping.nativeName);
        const record = await readInstalledCommandProducer(root).catch(() => null);
        const producer = record?.producer;
        if (!producer || producer.kind === 'package' || producer.sourceId !== entry.binding.plugin.sourceId
          || producer.sourceIdentity !== entry.binding.plugin.sourceIdentity || producer.pluginName !== input.plugin.manifest.name
          || producer.platform !== entry.binding.platform || producer.placementKey !== entry.binding.physicalKey
          || mapping.id !== (producer.kind === 'static-skill' ? `skill:${producer.key}` : producer.key)) continue;
        priorProducers.get(entry.binding.id)!.push(producer);
        priorResourceRoots.set(entry.binding.id, [...priorResourceRoots.get(entry.binding.id) ?? [], root]);
        if (!removing) {
          // An unreadable index has no authority. Only the installed canonical
          // producer and its owned resources can establish its former identity.
          const recovery = await captureManagedCommandBindingRecoveryEvidence({ producer, resourceRoot: root,
            env: this.context.env }).catch(() => null);
          if (recovery) bindingRecoveryEvidence.push(recovery);
        }
      }
    }
    await assertManagedCommandBindingIdentities({ producers: [...preparedUnits.values()].flatMap((unit) => unit.finalized.commandCandidates),
      env: this.context.env, bindingRecoveryEvidence });
    for (const entry of observed) {
      const units = entry.binding.renderUnitIds.flatMap((id) => preparedUnits.has(id) ? [preparedUnits.get(id)!] : []);
      const projections: ProjectionResult[] = [];
      for (const unit of units) {
        const sameScope = units.filter((candidate) => artifactValueDigest(candidate.unit.renderScope) === artifactValueDigest(unit.unit.renderScope));
        const components = mergeExpectedComponentSets(sameScope.map((candidate) => candidate.prepared.expected)).components;
        const resources = { resources: sameScope.flatMap((candidate) => candidate.prepared.resources.resources),
          bundleFiles: sameScope.flatMap((candidate) => candidate.prepared.resources.bundleFiles),
          files: sameScope.flatMap((candidate) => candidate.prepared.resources.files),
          commandResources: sameScope.flatMap((candidate) => candidate.prepared.resources.commandResources),
          digest: artifactValueDigest(sameScope.map((candidate) => candidate.prepared.resources.digest)) };
        const projection = await adapter.project({ ...ctx, stagingRoot: path.join(await this.root(), 'projection'), commandResolver: unit.finalized.commandResolver }, {
          binding: entry.binding, renderUnit: unit.unit, capabilities: adapter.capabilities({ ...entry, renderUnit: unit.unit, profile: getQualifiedPlatformProfile(input.platform) }),
          components, resources, policy: components.length ? unit.finalized.invocationPolicy.policy : { platform: input.platform, permissions: [] } });
        for (const notice of unit.finalized.invocationPolicy.diagnostics) {
          projection.diagnostics.push({ ...notice, subject: { ...notice.subject, scope: entry.binding.scope.kind } });
        }
        projections.push(projection);
      }
      const policyKey = input.platform === 'codex' || input.platform === 'claude' ? await getInvocationPolicyPhysicalKey(ctx, entry.binding) : undefined;
      const expected = mergeExpectedComponentSets(units.map((unit) => unit.prepared.expected));
      const currentComponents = [deploymentPackageComponent(entry.binding, entry.layout),
        ...projections.flatMap((projection) => projection.supplements.map((contribution) => contributionComponent(entry.binding, contribution,
          policyKey && (contribution.mergeKey?.startsWith('claude-permissions:') || input.platform === 'codex' && contribution.destination.endsWith('.rules'))
            ? policyKey : entry.layout.renderUnits.find((unit) => unit.id === projection.renderUnitId)!.physicalKey)))];
      const historical = await ownedSupplements(entry.binding, entry.layout.supplementRoot,
        entry.layout.renderUnits.find((unit) => unit.output === 'supplement')?.physicalKey);
      const antigravityProject = isAntigravityProjectDirectory(entry.binding);
      const legacyPackage = entry.observation.antigravityLegacyProjectPackage?.state === 'owned'
        ? antigravityLegacyProjectComponent(entry.binding, entry.layout) : undefined;
      if (legacyPackage) historical.push(legacyPackage);
      if (entry.binding.platform === 'codex' && policyKey) historical.push(...await ownedSupplements(entry.binding, path.join(entry.layout.activationPath, 'rules'), policyKey));
      if (entry.binding.platform === 'claude' && policyKey) {
        const destination = path.join(entry.layout.activationPath, entry.binding.scope.kind === 'project' ? 'settings.local.json' : 'settings.json');
        historical.push(contributionComponent(entry.binding, { id: 'policy:claude-permissions', componentIds: [], kind: 'config-entry',
          destination, contentDigest: '', stagingPath: '', mergeKey: `claude-permissions:${getDeploymentResourceKey(entry.binding.plugin)}` }, policyKey));
      }
      if (entry.binding.platform === 'cursor' && !projections.some((projection) => projection.supplements.some((item) => item.kind === 'config-entry'))) {
        const component = contributionComponent(entry.binding, { id: 'cursor-workspace-open', componentIds: [], kind: 'config-entry',
          destination: entry.layout.activationPath, stagingPath: '', contentDigest: '', mergeKey: `workspaceOpen:${getDeploymentResourceKey(entry.binding.plugin)}` }, entry.binding.physicalKey);
        if (component.kind === 'shared-config' && component.locator.kind === 'cursor-workspace-hook') component.locator.command = cursorWorkspaceOpenCommand(entry.binding, ctx.platform);
        historical.push(component);
      }
      for (const slot of gapSupplementFiles(entry.binding, entry.layout, expected.unmet)) {
        if (!historical.some((component) => 'path' in component && component.path === slot.path)) historical.push(slot);
      }
      const components = [...currentComponents, ...historical.filter((component) => !currentComponents.some((current) =>
        'path' in current && 'path' in component && current.path === component.path
        || current.kind === 'shared-config' && component.kind === 'shared-config' && artifactValueDigest(current.locator) === artifactValueDigest(component.locator)))];
      for (const component of components) if (component.kind === 'shared-config' && component.locator.kind === 'cursor-workspace-hook') {
        const locator = component.locator;
        const contribution = projections.flatMap((projection) => projection.supplements).find((item) => item.destination === locator.hooksPath);
        if (!contribution) continue;
        const { entries } = cursorHooks(await jsonObject(contribution.stagingPath));
        const command = entries.map(cursorHookEntryCommand).find((value) => value !== undefined);
        if (!command) throw new Error('cursorWorkspaceHookInvalid');
        component.locator.command = command;
      }
      const inspected = await inspectOwnedComponents({ components, executor: this.ownership });
      const managedCommandReview = await captureManagedCommandReviewEvidence({ binding: entry.binding,
        renderUnits: entry.layout.renderUnits, components: units.flatMap((unit) => unit.prepared.expected.components), projections });
      const currentMutable = async (batch?: NativeObservationBatch) => {
        const observation = await adapter.inspect(batch ? { ...ctx, ...batch } : ctx, entry.binding);
        return { observation, references: await sharedReferences(this.context, entry.binding, observation, entry.layout),
          paths: await Promise.all(components.map(async (component) => 'path' in component ? pathEvidence(component.path) : {
            ownership: await inspectOwnedComponents({ components: [component], executor: this.ownership }), contentDigest: await ownedContentDigest(component),
          })) };
      };
      const shadowedUser = operation(input) === 'ensure' ? await grokUserBehindProject(ctx, entry.binding, entry.observation) : undefined;
      const fingerprintParts = async (discovery?: { value: unknown }) => ({
        ...(shadowedUser && { grokUserContent: await grokUserContentDigest(shadowedUser.installedRoot, shadowedUser.owner) }),
        managedCommandReview,
        source: removing ? null : await pathEvidence(input.plugin.rootDir),
        discovery: discovery ? discovery.value : removing ? { consumers: entry.binding.consumers, executables: await Promise.all(entry.binding.consumers.map((consumer) =>
          consumer.entry?.kind === 'cli' ? pathEvidence(consumer.entry.executable) : null)) } : await adapter.discover(ctx),
        sharedReferenceView: this.context.sharedReferenceView,
        layout: await getDeploymentLayout(ctx, entry.binding),
        config: await Promise.all(units.map((unit) => resolveArtifactRenderConfig({ ...sourceIdentity(input), pluginName: input.plugin.manifest.name,
          logicalIdentity: input.plugin.catalogLogicalIdentity, manifest: input.plugin.manifest, platform: input.platform,
          scope: unit.unit.renderScope.kind, cwd: input.cwd, env: this.context.env, referencePlugins: this.context.referencePlugins }))),
        staging: await Promise.all(projections.map(async (projection) => ({
          bundle: projection.bundle ? await pathEvidence(projection.bundle.stagingRoot) : null,
          supplements: await Promise.all(projection.supplements.map((contribution) => pathEvidence(contribution.stagingPath))),
        }))),
      });
      // Discovery and inspection are independent reads for these routes. Settle
      // both before comparing or throwing, while preserving immutable priority.
      const parallelNativeReads = ['copilot-marketplace', 'pi-package'].includes(entry.binding.route);
      const initialReads = parallelNativeReads
        ? await Promise.allSettled([fingerprintParts(), currentMutable()]) : null;
      if (initialReads?.[0].status === 'rejected') throw initialReads[0].reason;
      const initialParts = initialReads?.[0].status === 'fulfilled' ? initialReads[0].value : await fingerprintParts();
      if (shadowedUser && initialParts.grokUserContent) {
        shadowedUsers.set(entry.binding.id, { ...shadowedUser, contentDigest: initialParts.grokUserContent });
      }
      if (!removing && ordinaryEvidence && ordinaryEvidence.discovery !== artifactValueDigest(initialParts.discovery)) {
        throw new Error('operationPlanStale: client discovery changed after the ordinary observation.');
      }
      const initial = artifactValueDigest(initialParts);
      const fingerprint = async (discovery?: { value: unknown }): Promise<string> =>
        artifactValueDigest(await fingerprintParts(discovery));
      if (initialReads?.[1].status === 'rejected') throw initialReads[1].reason;
      let mutableBaseline = initialReads?.[1].status === 'fulfilled' ? initialReads[1].value : await currentMutable();
      const ordinaryObservation = ordinaryEvidence?.observations.get(entry.binding.id);
      if (ordinaryObservation !== undefined && ordinaryObservation !== artifactValueDigest(mutableBaseline.observation)) {
        throw new Error('operationPlanStale: deployment evidence changed after the ordinary observation.');
      }
      const preparationObservation = entry.binding.route === 'antigravity-cli' || antigravityProject
        ? mutableBaseline.observation : entry.observation;
      const piInventoryKey = piProjectInventoryKey(entry.binding, entry.layout.activationPath);
      const matchesMutable = (current: Awaited<ReturnType<typeof currentMutable>>): boolean => {
        const currentDigest = artifactValueDigest(current);
        if (currentDigest === artifactValueDigest(mutableBaseline)) return true;
        const registered = piInventoryKey && this.piProjectRegisteredRoots.get(piInventoryKey);
        if (!registered || operation(input) !== 'ensure' || !piProjectEmptyDeliveryObserved(entry.binding, mutableBaseline.observation)
          || current.observation.registration !== 'absent' || !piProjectListContainsOnly(current.observation, registered)) return false;
        // The first successful register in an empty Project can expose its
        // section. Compare every other fact with the original empty target.
        const { observation: before, ...baseline } = mutableBaseline;
        return currentDigest === artifactValueDigest({ ...baseline,
          observation: { ...before, registration: 'absent',
            diagnostics: before.diagnostics.filter(({ code }) => code !== 'piProjectRegistrationNotVisible') } });
      };
      const matchesAfterGrokPublications = async (current: Awaited<ReturnType<typeof currentMutable>>): Promise<boolean> => {
        const { binding } = entry;
        const scopeRoot = binding.route === 'grok-cli' ? entry.layout.activationPath
          : binding.route === 'grok-directory' && binding.scope.kind === 'project' ? binding.scope.projectRoot : null;
        const publications = scopeRoot && operation(input) === 'ensure' ? [...this.grokPublications.values()].filter(
          (item) => item.scope === binding.scope.kind && item.scopeRoot === scopeRoot && item.owner.identity.pluginId !== binding.plugin.pluginId) : [];
        const retirements = binding.route === 'grok-directory' && operation(input) === 'ensure'
          ? [...this.grokProjectRetirements.values()].filter((item) => item.projectRoot === scopeRoot) : [];
        const baselineDigest = artifactValueDigest(mutableBaseline);
        if (!publications.length && !retirements.length) return artifactValueDigest(current) === baselineDigest;
        const before = mutableBaseline.observation.prerequisites.nativeSources;
        const after = current.observation.prerequisites.nativeSources;
        const priorEvidence = before?.grokScopeEvidence;
        const scopeEvidence = after?.grokScopeEvidence;
        if (before?.observation !== 'complete' || after?.observation !== 'complete' || !scopeEvidence || !priorEvidence
          || scopeEvidence.scopeDigest !== priorEvidence.scopeDigest) return false;
        const paths = after.sources.map((source) => path.normalize(source.path));
        const priorPaths = before.sources.map((source) => path.normalize(source.path));
        if (new Set(paths).size !== paths.length || new Set(priorPaths).size !== priorPaths.length) return false;
        const sources = [...after.sources];
        const sourceDigests = [...scopeEvidence.sourceDigests];
        const addedSources = new Set<string>();
        const publishedRoots = new Set<string>();
        const orderChecks = [priorEvidence];
        const instructions = [...scopeEvidence.instructions];
        const retiredSources = new Set<string>();
        let adjusted = false;
        for (const retirement of retirements) {
          const { name, projectPackage, projectDigest, userPackage, userDigest, userSource, userContentDigest, userPhysicalKey } = retirement;
          if (!priorPaths.includes(projectPackage)) continue;
          if (name === entry.layout.nativeIdentity.packageId || priorPaths.includes(userPackage) || paths.includes(projectPackage)
            || grokSourceDigest(before, projectPackage, name, 'project') !== projectDigest
            || grokSourceDigest(after, userPackage, name, 'user') !== userDigest
            || await pathEvidence(projectPackage) !== null) return false;
          await assertSafeFileMutationPath({ filePath: path.join(userPackage, '.grok-plugin', 'plugin.json'),
            allowedRoot: path.dirname(path.dirname(userPackage)), label: 'Grok installed package' });
          const [installed, source, marker] = await Promise.all([readPlatformPackageContentDigest(userPackage), readPlatformPackageContentDigest(userSource),
            readSkillOwnerMarker({ skillRoot: userSource, allowedRoot: path.dirname(userSource) })]);
          if (installed !== userContentDigest || source !== userContentDigest || marker?.physicalKey !== userPhysicalKey) return false;
          // The Project copy hid this exact User copy. Both may leave their
          // old positions, and the remaining sources and components keep theirs.
          retiredSources.add(projectPackage);
          addedSources.add(userPackage);
          publishedRoots.add(projectPackage);
          publishedRoots.add(userPackage);
          adjusted = true;
        }
        for (const { owner, scopeRoot: publishedRoot, installedRoot, nativeDigest, contentDigest, priorNativeDigest, orderAfter, shadowedUser } of publications) {
          ctx.signal?.throwIfAborted();
          if (owner.kind === 'owned-directory') {
            const root = installedRoot ?? owner.path;
            const index = paths.indexOf(root);
            if (scopeEvidence.sourceDigests[index] !== nativeDigest || after.sources[index]?.name === entry.layout.nativeIdentity.packageId) return false;
            const priorIndex = priorPaths.indexOf(root);
            const priorDigest = priorEvidence.sourceDigests[priorIndex];
            if (shadowedUser) {
              const hidden = shadowedUser.installedRoot;
              if (paths.includes(hidden) || await grokUserContentDigest(hidden, shadowedUser.owner) !== shadowedUser.contentDigest) return false;
              if (priorIndex < 0) {
                if (grokSourceDigest(before, hidden, owner.identity.plugin, 'user') !== shadowedUser.nativeDigest) return false;
                retiredSources.add(hidden);
                publishedRoots.add(hidden);
              }
            }
            if (priorDigest !== nativeDigest) {
              if (priorDigest !== priorNativeDigest) return false;
              publishedRoots.add(root);
              if (orderAfter) orderChecks.push(orderAfter);
              // Restore the frozen source at its current position. Moving a
              // source or changing any other source still invalidates the plan.
              if (priorIndex < 0) addedSources.add(root);
              else {
                sources[index] = before.sources[priorIndex]!;
                sourceDigests[index] = priorDigest!;
              }
              adjusted = true;
            }
            const marker = await readSkillOwnerMarker({ skillRoot: owner.path, allowedRoot: owner.allowedRoot,
              expectedIdentity: owner.identity }).catch(() => null);
            const observedContent = marker?.nativeProjection?.contentDigest === contentDigest
              ? await readPlatformPackageContentDigest(owner.path).catch(() => undefined) : undefined;
            if (observedContent !== contentDigest) return false;
            if (installedRoot) {
              try {
                await assertSafeFileMutationPath({ filePath: path.join(installedRoot, '.grok-plugin', 'plugin.json'),
                  allowedRoot: publishedRoot, label: 'Grok installed package' });
                if (await readPlatformPackageContentDigest(installedRoot) !== contentDigest) return false;
              } catch { ctx.signal?.throwIfAborted(); return false; }
            }
          } else {
            const matches = instructions.filter((row) => row.rulePath === owner.path);
            if (matches.length !== 1 || matches[0]!.digest !== nativeDigest) return false;
            const index = instructions.indexOf(matches[0]!);
            const prior = priorEvidence.instructions.find((row) => row.rulePath === owner.path);
            if (prior?.digest !== nativeDigest) {
              if (prior?.digest !== priorNativeDigest) return false;
              instructions.splice(index, 1, ...(prior ? [prior] : []));
              adjusted = true;
            }
            // The written hash includes the exact owner header. Grok's size
            // and token count alone cannot detect a same-length external edit.
            try {
              await assertSafeFileMutationPath({ filePath: owner.path, allowedRoot: publishedRoot, label: 'Grok rule' });
              const bytes = await fs.readFile(owner.path);
              if (crypto.createHash('sha256').update(bytes).digest('hex') !== contentDigest) return false;
            } catch { ctx.signal?.throwIfAborted(); return false; }
          }
        }
        ctx.signal?.throwIfAborted();
        if (!adjusted) return artifactValueDigest(current) === baselineDigest;
        for (const { sourceOrderAfter } of publications) {
          if (!sourceOrderAfter) continue;
          // Sources that remained visible since the Project publication keep their receipt order.
          if (artifactValueDigest(sourceOrderAfter.filter((root) => paths.includes(root)))
            !== artifactValueDigest(paths.filter((root) => sourceOrderAfter.includes(root)))) return false;
        }
        // The reviewed order anchors surviving rows. Each publication's receipt
        // also anchors its new rows against later cross-package moves.
        for (const previous of orderChecks) {
          if (!matchesGrokComponentOrder(previous.hookOrder, scopeEvidence.hookOrder, publishedRoots)
            || !scopeEvidence.resourceOrder.every((order, index) => matchesGrokComponentOrder(previous.resourceOrder[index]!, order, publishedRoots))) return false;
        }
        const normalizedSources = { ...after, sources: sources.filter((_, index) => !addedSources.has(paths[index]!)),
          configurationEvidence: before.configurationEvidence, grokScopeEvidence: { ...scopeEvidence, instructions,
            hookOrder: priorEvidence.hookOrder, resourceOrder: priorEvidence.resourceOrder,
            sourceDigests: sourceDigests.filter((_, index) => !addedSources.has(paths[index]!)) } };
        const observation = { ...current.observation, prerequisites: { ...current.observation.prerequisites, nativeSources: normalizedSources } };
        const normalizedBefore = { ...before, sources: before.sources.filter((_, index) => !retiredSources.has(priorPaths[index]!)),
          grokScopeEvidence: { ...priorEvidence, sourceDigests: priorEvidence.sourceDigests.filter((_, index) => !retiredSources.has(priorPaths[index]!)) } };
        const baselineObservation = { ...mutableBaseline.observation, prerequisites: { ...mutableBaseline.observation.prerequisites,
          nativeSources: normalizedBefore } };
        return artifactValueDigest({ ...current, observation }) === artifactValueDigest({ ...mutableBaseline, observation: baselineObservation });
      };
      const check = async (discovery?: { value: unknown }, batch?: NativeObservationBatch): Promise<boolean> => {
        if (!parallelNativeReads) return await fingerprint(discovery) === initial
          && await matchesAfterGrokPublications(await currentMutable(batch));
        const [immutableRead, mutableRead] = await Promise.allSettled([fingerprint(discovery), currentMutable(batch)]);
        if (immutableRead.status === 'rejected') throw immutableRead.reason;
        if (immutableRead.value !== initial) return false;
        if (mutableRead.status === 'rejected') throw mutableRead.reason;
        return matchesMutable(mutableRead.value);
      };
      checks.set(entry.binding.id, (batch) => check(undefined, batch));
      if (resolution.bindings.length === 1 && entry.binding.route === 'pi-package') {
        initialDiscoveryCheck = () => check({ value: initialParts.discovery });
      }
      this.mutableChecks.set(entry.binding.id, { physicalKey: entry.binding.physicalKey,
        marketplaceRoot: entry.layout.marketplaceRoot, sourceId: entry.binding.plugin.sourceId,
        sourceIdentity: entry.binding.plugin.sourceIdentity,
        assertStable: async () => {
          if (!await checks.get(entry.binding.id)!()) throw new Error('operationPlanStale: deployment evidence changed before source registration.');
        },
        acceptMarketplaceRegistration: async () => {
          const current = await currentMutable();
          if (artifactValueDigest(current) === artifactValueDigest(mutableBaseline)) return;
          const withoutRegistration = { ...current, observation: { ...current.observation,
            registration: mutableBaseline.observation.registration } };
          const onlyRegistration = mutableBaseline.observation.registration === 'absent' && current.observation.registration === 'present'
            && artifactValueDigest(withoutRegistration) === artifactValueDigest(mutableBaseline);
          const onlyMarketplace = ['codex-marketplace', 'claude-marketplace'].includes(entry.binding.route)
            && current.observation.configuration?.marketplace === 'canonical'
            && mutableBaseline.observation.configuration?.marketplace === 'absent'
            && (current.observation.registration === mutableBaseline.observation.registration
              || mutableBaseline.observation.registration === 'absent' && current.observation.registration === 'present')
            && artifactValueDigest({ ...withoutRegistration, observation: { ...withoutRegistration.observation,
              configuration: { ...current.observation.configuration, marketplace: mutableBaseline.observation.configuration.marketplace },
            } }) === artifactValueDigest(mutableBaseline);
          if ((!onlyRegistration && !onlyMarketplace) || await fingerprint() !== initial) {
            throw new Error('operationPlanStale: deployment evidence changed during source registration.');
          }
          // This is the one shared observation changed by our confirmed source
          // registration. The reviewed package, references and bytes stay frozen.
          mutableBaseline = current;
        },
        rebase: async (writtenFiles) => {
          const reads = parallelNativeReads
            ? await Promise.allSettled([fingerprintParts(), currentMutable()]) : null;
          if (reads?.[0].status === 'rejected') throw reads[0].reason;
          const current = reads?.[0].status === 'fulfilled' ? reads[0].value : await fingerprintParts();
          if (artifactValueDigest(current) !== initial) {
            const changed = (Object.keys(initialParts) as Array<keyof typeof initialParts>)
              .filter((key) => artifactValueDigest(current[key]) !== artifactValueDigest(initialParts[key]));
            throw new Error(`operationPlanStale: immutable deployment input changed (${changed.join(', ')}).`);
          }
          if (reads?.[1].status === 'rejected') throw reads[1].reason;
          const mutable = reads?.[1].status === 'fulfilled' ? reads[1].value : await currentMutable();
          mutableBaseline = mutable;
          // The same rebase already hashes the exact paths. Match the owner's
          // header and the desired bytes without opening each file again.
          const verifiedSupplementIds = writtenFiles?.size ? components.flatMap((component, index) => {
            if (component.kind !== 'owned-text-file') return [];
            const written = writtenFiles.get(component.path);
            const observed = mutable.paths[index];
            return written && observed && typeof observed === 'object' && 'digest' in observed && observed.digest === written.digest
              ? written.componentIds : [];
          }) : [];
          return { observation: mutable.observation, verifiedSupplementIds };
        } });
      const evidence: PreparationEvidence = { fingerprint: initial, managedCommandReview, layout: entry.layout, renderUnits: entry.layout.renderUnits,
        ownership: await Promise.all(inspected.components.map(async ({ component, state }) => ({ component, state,
          contentDigest: state === 'present' ? await ownedContentDigest(component) : undefined,
          physicalKey: component.identity.physicalKey ?? entry.binding.physicalKey }))),
        sharedReferences: await sharedReferences(this.context, entry.binding, preparationObservation, entry.layout),
        nativeIdentity: preparationObservation.nativeIdentity ?? entry.layout.nativeIdentity,
        contentMatches: projections.some((projection) => projection.bundle !== null)
          && (!antigravityProject || preparationObservation.ownership === 'aw')
          && await readPlatformPackageContentDigest(entry.layout.packageRoot) === projections.find((projection) => projection.bundle !== null)?.bundle?.contentDigest };
      if (entry.binding.platform === 'codex') {
        const hostEntry = entry.binding.consumers.find((consumer) => consumer.entry?.kind === 'cli'
          || removing && consumer.entry?.kind === 'directory')?.entry;
        if (!hostEntry || hostEntry.kind === 'generic') throw new Error('nativeActivationEvidenceUnknown');
        const config = await readCodexConfigFile(path.join(hostEntry.configRoot, 'config.toml'));
        evidence.userActivationEnabled = config.snapshot.plugins[entry.layout.nativeIdentity.registrationId!]?.enabled === true;
      }
      if (entry.binding.platform === 'copilot') {
        const hostEntry = entry.binding.consumers.find((consumer) => consumer.entry?.kind === 'cli')?.entry;
        if (hostEntry?.kind === 'cli') {
          const settings = await jsonObject(path.join(hostEntry.configRoot, 'settings.json'));
          const enabled = settings.enabledPlugins;
          evidence.userActivationEnabled = enabled === undefined ? false : enabled && typeof enabled === 'object' && !Array.isArray(enabled)
            ? (enabled as Record<string, unknown>)[entry.layout.nativeIdentity.registrationId!] === true : 'unknown';
        }
      }
      if (entry.binding.scope.kind === 'project' && ['codex', 'copilot'].includes(entry.binding.platform)) {
        const plannedUser = [...this.requestedOperations.values()].find((request) => request.scope === 'user'
          && request.platform === input.platform && sourceIdentity(request).sourceIdentity === entry.binding.plugin.sourceIdentity
          && sourceIdentity(request).pluginId === entry.binding.plugin.pluginId);
        if (plannedUser) {
          evidence.userActivationEnabled = !['remove', 'cleanup'].includes(operation(plannedUser));
        }
      }
      const priorPackage = inspected.components.find((slot) => 'path' in slot.component
        && slot.component.path === entry.layout.packageRoot && ['present', 'partial'].includes(slot.state))?.component;
      if (!removing && expected.unmet.length && priorPackage?.kind === 'owned-directory') {
        const complete = hasCompleteDeliveryDeclaration(expected);
        const old = await readSkillOwnerMarker({ skillRoot: priorPackage.path, allowedRoot: priorPackage.allowedRoot,
          expectedIdentity: priorPackage.identity }).catch(() => null);
        const next = new Set(projections.filter((item) => item.bundle).flatMap((item) => item.components.map(({ id }) => id)));
        const dropsPriorComponent = !old?.nativeProjection || old.nativeProjection.components.some(({ id }) => !next.has(id));
        const currentDigest = evidence.ownership.find((slot) => slot.component === priorPackage)?.contentDigest;
        // The marker identifies the directory. Only its recorded digest proves
        // that replacing or withdrawing the whole tree would discard exclusively AW bytes.
        const previousContentsVerified = !!old?.nativeProjection && old.nativeProjection.contentDigest === currentDigest;
        const hasNativeCopy = ['grok-cli', 'antigravity-cli'].includes(entry.binding.route) && preparationObservation.registration === 'present';
        const previousCopyUnconfirmed = hasNativeCopy && (!old?.nativeProjection
          || old.nativeProjection.contentDigest !== preparationObservation.nativePackageContentDigest);
        evidence.retainPackage = expected.unmet.some((gap) => !isDeliveryCapabilityGap(gap)) || previousCopyUnconfirmed
          || !evidence.contentMatches && (!previousContentsVerified || dropsPriorComponent
            && (!complete || evidence.sharedReferences !== 'none' || preparationObservation.ownership !== 'aw'));
      }
      if (!removing) {
        const inputEvidence = await createPlatformInputEvidence({ plugin: input.plugin, binding: entry.binding, units: units.map((unit) => unit.evidenceInput) });
        const packageComponents = projections.find((projection) => projection.bundle)?.components;
        inputDigests.set(entry.binding.id, platformPackageInputDigest(inputEvidence, packageComponents));
        if (expected.unmet.every(isDeliveryCapabilityGap)) {
          const permissionNotices = platformPermissionNotices(projections.flatMap(({ diagnostics }) => diagnostics));
          const noticeFields = permissionNotices.length ? { permissionNotices } : {};
          if (expected.unmet.length || expected.components.length && permissionNotices.length) gapStates.set(entry.binding.id, { ...inputEvidence,
            kind: 'aw-platform-empty-state', result: 'capability-gaps', gaps: expected.unmet,
            installedComponentIds: expected.components.map(({ id }) => id), ...noticeFields });
          if (expected.components.length === 0 && expected.unmet.length === 0) {
            emptyStates.set(entry.binding.id, { ...inputEvidence, kind: 'aw-platform-empty-state', result: 'intentional-empty', ...noticeFields });
          } else if (entry.layout.supplementRoot && input.plugin.manifest.artifacts) {
            const supplement = inputEvidence.units.find((unit) => unit.output === 'supplement');
            if (supplement) {
              supplementInputDigests.set(entry.binding.id, supplement.inputDigest);
              if (!expected.unmet.length && !projections.some((projection) => projection.bundle)) {
                emptyStates.set(entry.binding.id, { ...inputEvidence, kind: 'aw-platform-empty-state',
                  result: 'intentional-empty-package', installedComponentIds: expected.components.map(({ id }) => id).sort(), ...noticeFields });
              }
            }
          }
        }
      }
      const result = adapter.lifecycle.prepare({ operation: operation(input), binding: entry.binding, observation: preparationObservation,
        projections, expected, evidence });
      if (result.status === 'blocked') {
        plans.push({ operation: operation(input), binding: entry.binding, projections, expected, evidence, effects: [] });
        blockedReceipts.push({ bindingId: entry.binding.id, effects: [], after: preparationObservation,
          unmet: expected.unmet.map((gap) => ({ ...gap, productIds: entry.binding.consumers.map((consumer) => consumer.id) })),
          reload: 'none', diagnostics: result.diagnostics });
      } else { deployments.push(result.prepared); plans.push(result.prepared.plan); }
    }
    target.ownedComponents = plans.flatMap((plan) => plan.evidence.ownership.map((item) => item.component));
    target.desiredOwnedComponents = target.ownedComponents;
    let frozenNativeTools: { signature: string; changes: NativeToolChange[] } | undefined;
    const verifyChecks = async (selected: Iterable<(batch?: NativeObservationBatch) => Promise<boolean>>, batch?: NativeObservationBatch): Promise<void> => {
      for (const check of selected) if (!await check(batch)) throw new Error('operationPlanStale: deployment evidence changed.');
      for (const plan of plans) if (!await this.verifyMarketplace(plan)) throw new Error('operationPlanStale: marketplace evidence changed.');
    };
    const verify = (batch?: NativeObservationBatch): Promise<void> => verifyChecks(checks.values(), batch);
    const canVerifyAtExecution = (): boolean => {
      const prepared = deployments[0];
      if (!prepared || deployments.length !== 1 || plans.length !== 1 || plans[0] !== prepared.plan || blockedReceipts.length
        || target.operationActions === undefined || target.operationActions.some((action) =>
          action.kind === 'runPreApply' || action.kind === 'syncManagedCommandPackage')) return false;
      const { plan, driverState } = prepared;
      const hiddenEmptyPiProject = piProjectRegistrationHidden(plan.binding, driverState.before)
        && driverState.before.package === 'absent' && driverState.before.ownership === 'absent'
        && plan.evidence.sharedReferences === 'none' && plan.evidence.ownership.every((item) => item.state === 'absent')
        && plan.effects.every((effect) => ['publish-package', 'register'].includes(effect.kind));
      const checkedBatch = this.context.batchInstallPlatform === plan.binding.platform && plan.binding.platform !== 'codex';
      return plan.operation === 'ensure' && (checkedBatch || ['copilot-marketplace', 'pi-package'].includes(plan.binding.route))
        && plan.binding.platform === target.identity.platform && plan.expected.components.length > 0 && plan.expected.unmet.every(isDeliveryCapabilityGap)
        && driverState.before.package !== 'unknown' && (driverState.before.registration !== 'unknown' || hiddenEmptyPiProject)
        && ['absent', 'aw', 'shared'].includes(driverState.before.ownership)
        && plan.effects.every((effect) => ['publish-package', 'register', 'refresh', 'activate'].includes(effect.kind));
    };
    let privateStaging: string | undefined;
    let stagedPackage: string | undefined;
    const packagePlan = plans.length === 1 ? plans[0] : undefined;
    const bundle = packagePlan?.projections.find((projection) => projection.bundle)?.bundle;
    // Registration mutates a shared client. Copy independent bytes outside its
    // namespace first; publication still checks the original frozen live plan.
    const privatePackage = packagePlan && bundle && packagePlan.operation === 'ensure'
      && ['pi-package', 'claude-marketplace'].includes(packagePlan.binding.route)
      && packagePlan.effects.some((effect) => effect.kind === 'publish-package') ? {
        prepare: async () => {
          privateStaging = await fs.mkdtemp(path.join(await this.root(), 'private-package-'));
          stagedPackage = path.join(privateStaging, input.plugin.manifest.name);
          await fs.copy(bundle.stagingRoot, stagedPackage, { dereference: false });
        },
        dispose: async () => {
          if (privateStaging) await fs.remove(privateStaging);
          privateStaging = undefined;
          stagedPackage = undefined;
        },
      } : undefined;
    target.platformDeployment = { deployments, plans, blockedReceipts, cleanupResults, privatePackage,
      writesManagedCommands: [...preparedUnits.values()].some((unit) => unit.finalized.commandCandidates.length > 0)
        || [...priorProducers.values()].some((producers) => producers.length > 0),
      canVerifyAtExecution,
      captureNativeToolChanges: async () => {
        const signature = artifactValueDigest(deployments.map(({ plan }) => ({ bindingId: plan.binding.id,
          retainPackage: plan.evidence.retainPackage, effects: plan.effects })));
        if (frozenNativeTools?.signature === signature) return frozenNativeTools.changes;
        const changes: NativeToolChange[] = [];
        for (const { plan } of deployments) {
          const root = plan.evidence.layout.packageRoot;
          const publishes = plan.effects.some((effect) => effect.kind === 'publish-package' && effect.destination === root);
          const removes = plan.effects.some((effect) => effect.kind === 'remove-owned' && effect.destination === root);
          if (plan.evidence.retainPackage || !publishes && !removes) continue;
          const next = publishes ? [...preparedUnits.values()].flatMap((unit) => unit.finalized.commandCandidates)
            .filter((candidate) => candidate.producer.kind !== 'package' && candidate.producer.placementKey === plan.binding.physicalKey) : [];
          changes.push(...await captureNativeToolChanges({ actions: [],
            producers: [...priorProducers.get(plan.binding.id) ?? [], ...next.map((candidate) => candidate.producer)],
            nextProducers: next, removed: removes, env: this.context.env,
            resourceRoots: [...priorResourceRoots.get(plan.binding.id) ?? [], ...(removes ? [root] : [])] }));
        }
        frozenNativeTools = { signature, changes };
        return changes;
      },
      verify,
      postcheck: async (receipts, options) => {
        let incomplete = false;
        for (const { plan } of deployments) {
          if (!['ensure', 'reinstall'].includes(plan.operation) || !plan.expected.components.length) continue;
          const receipt = receipts.find((entry) => entry.bindingId === plan.binding.id);
          if (!receipt || options?.deliveredSkillsOnly && plan.evidence.retainPackage) continue;
          const after = options?.refresh ? await adapter.inspect(ctx, plan.binding) : receipt.after;
          const supplementFiles = componentSupplementFiles(plan);
          const supplementIds = new Set(supplementFiles.flatMap((contribution) => contribution.componentIds));
          if (!options?.deliveredSkillsOnly) {
            const supplements = await inspectStaticSupplements(ctx, plan.binding,
              plan.expected.components.filter((component) => supplementIds.has(component.id)));
            after.components = [...after.components.filter((component) => !supplementIds.has(component.id)), ...supplements.components];
          }
          if (options?.refresh) {
            receipt.after = after;
            receipt.diagnostics.push(...after.diagnostics);
          }
          const packageIds = new Set(plan.projections.filter((projection) => projection.bundle)
            .flatMap((projection) => projection.components.map((component) => component.id)));
          const bundle = plan.projections.find((projection) => projection.bundle)?.bundle;
          const requiredActivation = requiredDeploymentActivation(plan.binding, after, requireIndependentActivation);
          if (!options?.deliveredSkillsOnly && !requireIndependentActivation && requiredActivation === 'enabled') {
            receipt.diagnostics = receipt.diagnostics.filter((entry) => entry.code !== 'codexProjectActivationUnconfirmed');
          }
          const nativeContentIncomplete = bundle && nativeCopyIncomplete(plan.binding, after, bundle.contentDigest);
          // Partial execution already verified the frozen plan and recorded each package publication.
          const publication = options?.deliveredSkillsOnly && plan.effects.find((effect) => effect.kind === 'publish-package');
          const packageIncomplete = bundle && (!packageDeliveryConfirmed(plan.binding, after, bundle.contentDigest, requireIndependentActivation)
            || (options?.deliveredSkillsOnly
              ? !plan.evidence.contentMatches && !receipt.effects.some((effect) => publication && effect.id === publication.id
                && effect.status === 'applied' && effect.mutation === 'confirmed')
              : await readPlatformPackageContentDigest(plan.evidence.layout.packageRoot) !== bundle.contentDigest));
          const delivered = new Set(after.components.filter((component) => component.presence === 'present' && !component.reasonCodes.length)
            .map((component) => component.id));
          const roleIds = plan.expected.components.filter((component) => component.kind === 'agent' && delivered.has(component.id)
            && packageIds.has(component.id) && !packageIncomplete && !plan.evidence.retainPackage).map(({ id }) => id);
          const roleDiagnostic = piAgentConsumerDiagnostic(plan.binding, after, roleIds);
          if (roleDiagnostic) receipt.diagnostics.push(roleDiagnostic);
          const gaps = plan.expected.components.filter((component) => packageIncomplete && packageIds.has(component.id) || !delivered.has(component.id));
          if (bundle && !packageIncomplete && !plan.evidence.retainPackage) {
            for (const unitId of plan.binding.renderUnitIds) {
              const unit = preparedUnits.get(unitId);
              if (!unit?.finalized.skills.length) continue;
              const capabilityInput = { binding: plan.binding, renderUnit: unit.unit,
                observation: after, profile: getQualifiedPlatformProfile(input.platform) };
              const capabilities = adapter.capabilities(capabilityInput);
              const cliReaders = unit.unit.consumers.filter(({ product }) => product === 'cli');
              // Only attribute a shared package's limitation to Desktop if the same
              // check passes for its CLI readers and an App reader was observed.
              const codexCliCapabilities = plan.binding.platform === 'codex'
                && cliReaders.some(({ availability }) => availability === 'available')
                && unit.unit.consumers.some(({ product, availability }) => product === 'app' && availability === 'available')
                && unit.unit.consumers.every(({ product, availability, entry }) => product === 'app'
                  || product === 'cli' && availability === 'available' && entry?.kind === 'cli')
                ? adapter.capabilities({ ...capabilityInput, renderUnit: { ...unit.unit, consumers: cliReaders } }) : undefined;
              const antigravityReaders = plan.binding.platform === 'antigravity'
                ? unit.unit.consumers.flatMap((reader) => reader.availability === 'available' && reader.product !== 'generic'
                  ? [{ id: reader.id, product: reader.product,
                    unsupported: getAntigravityUnsupportedSkillControls(capabilityInput.profile, plan.binding.scope.kind, reader) }]
                  : []) : [];
              for (const skill of unit.finalized.skills) {
                if (!packageIds.has(skill.componentId) || !delivered.has(skill.componentId)) continue;
                const component = unit.prepared.expected.components.find((item) => item.id === skill.componentId)!;
                const requested = getComponentFeatureRequirements(component, { skillText: skill.tree.files['SKILL.md']!.toString('utf8') });
                const warning = skillInvocationWarning(component.name, requested,
                  { pluginId: plan.binding.plugin.pluginId, target: plan.binding.platform, scope: plan.binding.scope.kind },
                  capabilities, codexCliCapabilities, antigravityReaders.map((reader) => ({ ...reader,
                    observed: after.skillInvocationPolicies?.find(({ componentId, productId }) => componentId === component.id
                      && productId === reader.id)?.features })));
                if (warning) receipt.diagnostics.push(warning);
              }
            }
          }
          if (options?.deliveredSkillsOnly) continue;
          const inputDigest = supplementInputDigests.get(plan.binding.id);
          if (inputDigest && [...supplementIds].every((id) => delivered.has(id))
            && receipt.unmet.every(isDeliveryCapabilityGap) && !receipt.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
            try {
              await writePlatformSupplementState(ctx, plan.binding, inputDigest, supplementFiles.map((file) => ({
                id: file.id, fileName: path.basename(file.destination), contentDigest: file.contentDigest,
              })));
              const emptyPackage = emptyStates.get(plan.binding.id);
              if (!gaps.length && emptyPackage?.result === 'intentional-empty-package'
                && supplementIds.size === emptyPackage.installedComponentIds.length
                && emptyPackage.installedComponentIds.every((id) => supplementIds.has(id))
                && after.package === 'absent' && ['absent', 'not-applicable'].includes(after.registration)) {
                // The package absence and permission notices describe the same binding.
                await writePlatformEmptyState({ state: emptyPackage, env: this.context.env });
                continue;
              }
            } catch {
              ctx.signal?.throwIfAborted();
              receipt.diagnostics.push({ code: 'componentOutputUnconfirmed', severity: 'warning',
                message: 'The scope-local supplemental output could not be recorded. Run sync to restore the status evidence.',
                subject: { target: plan.binding.platform, pluginId: plan.binding.plugin.pluginId, scope: plan.binding.scope.kind } });
            }
          }
          if (!gaps.length) {
            const gapState = gapStates.get(plan.binding.id);
            if (gapState && !receipt.diagnostics.some((entry) => entry.severity === 'error')) {
              if (gapState.result === 'capability-gaps' && !gapState.gaps.length) {
                // A notice alone is optional status evidence. Failure to retain it does not undo verified delivery.
                await writePlatformEmptyState({ state: gapState, env: this.context.env }).catch(() => ctx.signal?.throwIfAborted());
              } else {
                await writePlatformEmptyState({ state: gapState, env: this.context.env });
              }
            }
            continue;
          }
          incomplete = true;
          const code = plan.binding.route === 'grok-directory' && requiredActivation === 'blocked' ? 'grokProjectAuthorizationDenied'
            : plan.binding.route === 'codex-marketplace' && requireIndependentActivation && after.scopeActivation === 'unknown'
              ? 'codexProjectActivationUnconfirmed'
              : nativeContentIncomplete ? 'nativeInstallContentPostcheckFailed' : 'deploymentPostcheckFailed';
          receipt.diagnostics.push({ code, severity: 'error',
            message: code === 'nativeInstallContentPostcheckFailed'
                ? 'The installed native copy does not confirm the frozen package bytes. Check status and sync the affected target.'
                : code === 'grokProjectAuthorizationDenied'
                  ? 'Grok denied authorization for the selected project. Review the project in Grok before syncing.'
                  : code === 'codexProjectActivationUnconfirmed'
                    ? 'Codex reports effective activation but does not distinguish this project from User inheritance.'
                    : 'The final observation does not confirm the requested deployment. Check status and sync the affected target.',
            subject: { target: plan.binding.platform, pluginId: plan.binding.plugin.pluginId, scope: plan.binding.scope.kind } });
          receipt.unmet.push(...gaps.map((component) => ({ id: `postcheck:${plan.binding.id}:${component.id}`,
            componentId: component.id, kind: component.kind, reasonCode: code, requiredFeatures: [],
            productIds: plan.binding.consumers.map((consumer) => consumer.id) })));
        }
        if (incomplete) throw new Error('deploymentPostcheckFailed: the final observation does not confirm the requested deployment.');
      },
      execute: async (options) => {
        let verifiedPlan: FrozenDeploymentPlan | undefined;
        if (options?.verifyBeforeExecution) {
          if (!canVerifyAtExecution()) throw new Error('deploymentExecutionVerificationUnsupported');
          // Keep failures outside the lifecycle catch so the caller retains its
          // preflight error classification. Only this call can consume success.
          await verify();
          verifiedPlan = deployments[0]!.plan;
        }
        cleanupResults.length = 0;
        const receipts: DeploymentReceipt[] = [...blockedReceipts];
        for (const prepared of deployments) {
          const supplementFiles = componentSupplementFiles(prepared.plan);
          const writtenFiles = new Map<string, { digest: string; componentIds: string[] }>();
          const commandPreparationFailed = prepared.plan.binding.renderUnitIds.some((unitId) => preparedUnits.get(unitId)?.finalized.producerResolutions
            .some((resolution) => resolution.state === 'failed'));
          let receipt: DeploymentReceipt;
          const peers = prepared.plan.binding.route === 'codex-marketplace' ? [...this.mutableChecks.values()].filter((check) =>
            check.physicalKey !== prepared.plan.binding.physicalKey && check.marketplaceRoot === prepared.plan.evidence.layout.marketplaceRoot
            && check.sourceId === prepared.plan.binding.plugin.sourceId && check.sourceIdentity === prepared.plan.binding.plugin.sourceIdentity) : [];
          const nativeServices = createNativeLifecycleServices(ctx, prepared.plan.evidence, peers.length ? async () => {
            for (const peer of peers) await peer.assertStable();
          } : undefined);
          try { receipt = await adapter.lifecycle.execute({ ...ctx, nativeEffects: this.nativeEffects, inspect: (binding) => adapter.inspect(ctx, binding), services: {
            ...nativeServices,
            registerMarketplace: async (binding, identity) => {
              const outcome = await nativeServices.registerMarketplace(binding, identity);
              if (outcome.mutation === 'confirmed') {
                ctx.codexObservationSession?.invalidate(prepared.plan.evidence.layout.marketplaceName ?? undefined);
                for (const peer of peers) await peer.acceptMarketplaceRegistration();
              }
              return outcome;
            },
            verifyEvidence: async (plan) => {
              const verified = verifiedPlan === plan;
              verifiedPlan = undefined;
              return verified || await checks.get(plan.binding.id)!() && await this.verifyMarketplace(plan);
            },
            publishPackage: async (_binding, bundle, _destination, component) => {
              if (!('path' in component) || component.path !== _destination) throw new Error('deploymentDestinationMismatch');
              await this.publishMarketplace(prepared.plan);
              let publication = this.published.get(prepared.plan.binding.physicalKey);
              if (!publication) {
                publication = publishDirectory(bundle.stagingRoot, component, {
                  components: prepared.plan.projections.filter((projection) => projection.bundle !== null).flatMap((projection) => projection.components),
                  inputDigest: inputDigests.get(prepared.plan.binding.id)!, contentDigest: bundle.contentDigest,
                  ...(bundle.piExtensionDigest ? { piExtensionDigest: bundle.piExtensionDigest } : {}),
                  preparation: prepared.plan.expected.unmet.some((gap) => !isDeliveryCapabilityGap(gap)) || commandPreparationFailed ? 'partial' : 'complete',
                  physicalIdentity: (await getDeploymentLayout(ctx, prepared.plan.binding)).physicalIdentity,
                }, stagedPackage);
                this.published.set(prepared.plan.binding.physicalKey, publication);
              }
              return publication;
            },
            writeContribution: async (_binding, contribution, component) => {
              await requireWritable(component, this.ownership);
              if (component.kind === 'owned-directory') return publishDirectory(contribution.stagingPath, component);
              if (component.kind === 'owned-text-file') {
                const content = await fs.readFile(contribution.stagingPath, 'utf8');
                await writeOwnedTextFile({ ...component, content });
                if (supplementFiles.includes(contribution)) {
                  writtenFiles.set(component.path, { componentIds: contribution.componentIds,
                    digest: crypto.createHash('sha256').update(renderOwnedTextFile(content, component.identity)).digest('hex') });
                }
              } else if (component.kind === 'shared-config' && component.locator.kind === 'cursor-workspace-hook') {
                const locator = component.locator;
                const value = await jsonObject(locator.hooksPath);
                const { hooks, entries } = cursorHooks(value);
                const desired = cursorHooks(await jsonObject(contribution.stagingPath)).entries;
                await atomicReplaceSafeFile({ filePath: component.locator.hooksPath, allowedRoot: path.dirname(component.locator.hooksPath), label: 'Cursor workspaceOpen',
                  content: `${JSON.stringify({ ...value, hooks: { ...hooks, workspaceOpen: [...entries.filter((item) => cursorHookEntryCommand(item) !== locator.command), ...desired] } }, null, 2)}\n` });
              } else if (component.kind === 'shared-config' && component.locator.kind === 'claude-permissions') {
                const content = await jsonObject(contribution.stagingPath);
                if (content.kind !== 'claude-permissions') throw new Error('platformContributionUnsupported');
                await applyPlannedOperationAction({ kind: 'updateSharedConfig', pluginId: prepared.plan.binding.plugin.pluginId,
                  platform: 'claude', scope: prepared.plan.binding.scope.kind, owner: component.identity, locator: component.locator,
                  contentDigest: contribution.contentDigest, mutation: { kind: 'claude-permissions', permissions: content.permissions } });
              } else throw new Error('platformContributionUnsupported');
              return { mutation: 'confirmed', changed: true };
            },
            removeOwned: async (binding, component) => {
              if (isAntigravityProjectDirectory(binding) && component.kind === 'owned-directory'
                && component.path !== prepared.plan.evidence.layout.packageRoot && prepared.driverState.bundle) {
                const replacement = prepared.driverState.packageComponent;
                if (replacement?.kind !== 'owned-directory' || await requireWritable(replacement, this.ownership) !== 'present'
                  || await readPlatformPackageContentDigest(replacement.path) !== prepared.driverState.bundle.contentDigest) {
                  throw Object.assign(new Error('The Antigravity replacement package could not be verified.'), {
                    code: 'operationPlanStale', mutation: 'none',
                  });
                }
              }
              const result = await cleanupOwnedComponents({ components: [component], executor: this.ownership });
              cleanupResults.push(result);
              if (result.failures.length || result.residual.length || result.quarantined.length) {
                throw Object.assign(new Error('deploymentCleanupIncomplete'), result.removed.length || result.quarantined.length
                  ? { mutation: 'confirmed' } : {});
              }
              return { mutation: result.removed.length ? 'confirmed' : 'none', changed: result.removed.length > 0 };
            },
          } }, prepared); } catch (error) {
            const diagnostic = { code: recoveryInterruptionCode(error) ?? 'platformExecutionFailed', severity: 'error' as const,
              message: error instanceof Error ? error.message : String(error),
              subject: { target: prepared.plan.binding.platform, pluginId: prepared.plan.binding.plugin.pluginId, scope: prepared.plan.binding.scope.kind } };
            receipt = { bindingId: prepared.plan.binding.id, effects: prepared.plan.effects.map((effect) => ({
              id: effect.id, status: 'unknown', mutation: 'possible', diagnostics: [diagnostic] })),
              after: await adapter.inspect(ctx, prepared.plan.binding).catch(() => prepared.driverState.before),
              unmet: prepared.plan.expected.unmet.map((gap) => ({ ...gap, productIds: prepared.plan.binding.consumers.map(({ id }) => id) })),
              reload: 'unknown', diagnostics: [diagnostic] };
          }
          receipts.push(receipt);
          if (receipt.diagnostics.some(({ code }) => code === 'processCleanupUnconfirmed')) return receipts;
          if ((prepared.plan.operation === 'remove' || prepared.plan.operation === 'cleanup'
            || prepared.plan.expected.components.length === 0 && prepared.plan.expected.unmet.length === 0)
            && prepared.plan.evidence.sharedReferences !== 'none' && receipt.after.package === 'present') {
            receipt.diagnostics.push({ code: prepared.plan.evidence.sharedReferences === 'unknown' ? 'sharedReferenceUnknown' : 'sharedPackageRetained', severity: 'warning',
              message: prepared.plan.evidence.sharedReferences === 'unknown'
                ? 'The shared package was kept because references outside the observed scope could not be ruled out.'
                : 'The shared package was kept for another scope.',
              subject: { target: prepared.plan.binding.platform, pluginId: prepared.plan.binding.plugin.pluginId, scope: prepared.plan.binding.scope.kind } });
          }
          for (const unitId of prepared.plan.binding.renderUnitIds) for (const resolution of preparedUnits.get(unitId)?.finalized.producerResolutions ?? []) {
            if (resolution.state !== 'failed') continue;
            receipt.diagnostics.push({ code: 'managedCommandProducerFailed', severity: 'error', message: resolution.error.message,
              subject: { target: prepared.plan.binding.platform, pluginId: prepared.plan.binding.plugin.pluginId, scope: prepared.plan.binding.scope.kind } });
          }
          const publish = prepared.plan.effects.find((effect) => effect.kind === 'publish-package');
          const publication = receipt.effects.find((result) => result.id === publish?.id && result.status === 'applied');
          try {
            if (receipt.effects.some((effect) => effect.mutation !== 'none')) {
              for (const [bindingId, check] of this.mutableChecks) if (check.physicalKey === prepared.plan.binding.physicalKey) {
                const { observation: fresh, verifiedSupplementIds } = await check.rebase(bindingId === receipt.bindingId ? writtenFiles : undefined);
                if (verifiedSupplementIds.length) {
                  receipt.after.components = [
                    ...receipt.after.components.filter(({ id }) => !verifiedSupplementIds.includes(id)),
                    ...verifiedSupplementIds.map((id) => ({ id, presence: 'present' as const, reasonCodes: [] })),
                  ];
                }
                if (bindingId === receipt.bindingId && prepared.plan.binding.route === 'copilot-marketplace'
                  && publication?.mutation === 'confirmed') {
                  recheckCopilotMarketplaceTimeout(receipt, fresh);
                }
              }
            }
          } catch (error) {
            receipt.diagnostics.push({ code: recoveryInterruptionCode(error) ?? 'operationPlanStale', severity: 'error', message: error instanceof Error ? error.message : String(error),
              subject: { target: prepared.plan.binding.platform, pluginId: prepared.plan.binding.plugin.pluginId, scope: prepared.plan.binding.scope.kind } });
            continue;
          }
          if (prepared.plan.evidence.retainPackage || receipt.diagnostics.some((diagnostic) => diagnostic.code === 'operationPlanStale')
            || receipt.effects.some((effect) => ['failed', 'unknown', 'blocked', 'skipped'].includes(effect.status))) continue;
          this.recordGrokWrites(prepared, receipt, publication?.mutation === 'confirmed', writtenFiles, shadowedUsers.get(prepared.plan.binding.id));
          const piInventoryKey = piProjectInventoryKey(prepared.plan.binding, prepared.plan.evidence.layout.activationPath);
          if (piInventoryKey && piProjectEmptyDeliveryObserved(prepared.plan.binding, prepared.driverState.before)
            && receipt.after.registration === 'present' && receipt.after.ownership === 'aw' && receipt.after.configuration?.activation === 'enabled'
            && prepared.plan.effects.some((effect) => effect.kind === 'register' && receipt.effects.some((result) =>
              result.id === effect.id && result.status === 'applied' && result.mutation === 'confirmed'))) {
            const registered = this.piProjectRegisteredRoots.get(piInventoryKey) ?? new Set<string>();
            registered.add(prepared.plan.evidence.layout.packageRoot);
            this.piProjectRegisteredRoots.set(piInventoryKey, registered);
          }
          try {
            const candidates = [...preparedUnits.values()].flatMap((unit) => unit.finalized.commandCandidates)
              .filter((candidate) => candidate.producer.kind !== 'package' && candidate.producer.placementKey === prepared.plan.binding.physicalKey);
            const root = prepared.plan.evidence.layout.packageRoot;
            const mappings = prepared.plan.projections.filter((projection) => projection.bundle !== null).flatMap((projection) => projection.components);
            for (const candidate of candidates) {
              const componentId = candidate.producer.kind === 'static-skill' ? `skill:${candidate.producer.key}` : candidate.producer.key;
              const mapping = mappings.find((item) => item.id === componentId);
              if (!mapping || !mapping.relativeOutputs.some((output) => output === `skills/${mapping.nativeName}/SKILL.md`)) throw new Error('commandProducerProjectionMissing');
              await publishManagedCommandBindings({ ...candidate, resourceRoot: path.join(root, 'skills', mapping.nativeName),
                env: this.context.env, bindingRecoveryEvidence });
            }
            const bundle = prepared.plan.projections.find((projection) => projection.bundle)?.bundle;
            const packageOwner = prepared.plan.evidence.ownership.find((slot) => 'path' in slot.component && slot.component.path === root)?.component;
            if (bundle && packageOwner?.kind === 'owned-directory' && prepared.plan.evidence.contentMatches
              && !receipt.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
              && packageDeliveryConfirmed(prepared.plan.binding, receipt.after, bundle.contentDigest, requireIndependentActivation)
              && await readPlatformPackageContentDigest(root) === bundle.contentDigest) {
              const marker = await readSkillOwnerMarker({ skillRoot: root, allowedRoot: packageOwner.allowedRoot, expectedIdentity: packageOwner.identity });
              const projection: NativeProjectionEvidence = { components: mappings, contentDigest: bundle.contentDigest,
                inputDigest: inputDigests.get(prepared.plan.binding.id)!, preparation: prepared.plan.expected.unmet.some((gap) => !isDeliveryCapabilityGap(gap)) || commandPreparationFailed ? 'partial' : 'complete',
                ...(bundle.piExtensionDigest && marker?.nativeProjection?.piExtensionDigest === bundle.piExtensionDigest
                  ? { piExtensionDigest: bundle.piExtensionDigest } : {}),
                physicalIdentity: (await getDeploymentLayout(ctx, prepared.plan.binding)).physicalIdentity };
              if (marker && (!marker.nativeProjection || artifactValueDigest(marker.nativeProjection) !== artifactValueDigest(projection))) {
                await writeSkillOwnerMarker({ skillRoot: root, allowedRoot: packageOwner.allowedRoot, identity: packageOwner.identity, nativeProjection: projection });
                for (const check of this.mutableChecks.values()) if (check.physicalKey === prepared.plan.binding.physicalKey) await check.rebase();
                receipt.after = await adapter.inspect(ctx, prepared.plan.binding);
              }
            }
            const packageRemoved = !await fs.pathExists(root);
            for (const producer of priorProducers.get(prepared.plan.binding.id) ?? []) {
              if (candidates.some((candidate) => artifactValueDigest(candidate.producer) === artifactValueDigest(producer))) continue;
              const componentId = producer.kind === 'static-skill' ? `skill:${producer.key}` : producer.key;
              if (packageRemoved || publication && !prepared.plan.expected.unmet.some((gap) => gap.id === componentId)) {
                await revokeManagedCommandBindings(producer, this.context.env);
              }
            }
            const emptyState = gapStates.get(prepared.plan.binding.id) ?? emptyStates.get(prepared.plan.binding.id);
            const removedByCommand = piProjectRemovalConfirmed(prepared.plan, receipt);
            const inactiveScope = removedByCommand || receipt.after.registration === 'absent'
              || receipt.after.package === 'absent' && receipt.after.registration === 'not-applicable'
              || receipt.after.scopeRegistration === 'absent'
              || prepared.plan.binding.scope.kind === 'project'
                && ['codex-marketplace', 'copilot-marketplace'].includes(prepared.plan.binding.route)
                && receipt.after.configuration?.activation === 'absent'
              || receipt.after.consumers.every((consumer) => ['disabled', 'not-applicable'].includes(consumer.activation));
            if (emptyState && !prepared.plan.expected.components.length && receipt.unmet.every(isDeliveryCapabilityGap)
              && !receipt.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
              const residual = await inspectOwnedComponents({ components: prepared.plan.evidence.ownership
                .filter((slot) => !('path' in slot.component) || slot.component.path !== root)
                .map((slot) => slot.component), executor: this.ownership });
              const hiddenEmptyPi = emptyState.result === 'capability-gaps' && piProjectEmptyDeliveryObserved(prepared.plan.binding, receipt.after);
              const clear = (receipt.after.registration !== 'unknown' || removedByCommand || hiddenEmptyPi)
                && (emptyState.result !== 'capability-gaps' || prepared.plan.binding.route !== 'pi-package' || receipt.after.configuration?.activation === 'absent')
                && receipt.after.package !== 'unknown' && !['foreign', 'unknown'].includes(receipt.after.ownership)
                && (inactiveScope || hiddenEmptyPi)
                && (emptyState.result === 'intentional-empty' || receipt.after.package === 'absent')
                && residual.components.every((slot) => slot.state === 'absent');
              if (clear) await writePlatformEmptyState({ state: emptyState, env: this.context.env });
              else if (emptyState.result === 'capability-gaps') receipt.diagnostics.push({ code: 'previousDeploymentRetained', severity: 'error',
                message: 'Previous output or registration could not be confirmed absent. Check the scoped deployment before retrying.',
                subject: { target: prepared.plan.binding.platform, pluginId: prepared.plan.binding.plugin.pluginId, scope: prepared.plan.binding.scope.kind },
                detail: { reasonCode: 'previousDeploymentRetained', path: root } });
            }
          } catch (error) {
            receipt.diagnostics.push({ code: 'managedCommandPublicationFailed', severity: 'error',
              message: error instanceof Error ? error.message : String(error),
              subject: { target: prepared.plan.binding.platform, pluginId: prepared.plan.binding.plugin.pluginId, scope: prepared.plan.binding.scope.kind } });
          }
        }
        return receipts;
      },
    };
    if (initialDiscoveryCheck) {
      const firstCheck = initialDiscoveryCheck;
      const canReuseDiscovery = () => this.targets.size === 1 && deployments.length === 1 && plans.length === 1
        && plans[0] === deployments[0]!.plan && !blockedReceipts.length && plans[0]!.operation === 'ensure'
        && plans[0]!.expected.components.length > 0 && !plans[0]!.expected.unmet.length;
      receiveInitialVerifier?.(async () => {
        if (!canReuseDiscovery()) return verify();
        // Only this creator reuses the discovery captured after rendering.
        // Inspect still rereads all native facts and local copy/config evidence.
        await verifyChecks([firstCheck]);
        if (!canReuseDiscovery()) await verify();
      });
    }
    return target;
  }
}
