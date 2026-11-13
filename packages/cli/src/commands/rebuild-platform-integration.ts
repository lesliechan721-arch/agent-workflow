import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { createMarketplaceManifestEntry, normalizeStaticPluginComponents, resolveInvocationPolicy, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';
import type { DeploymentBinding, DeploymentExclusion, DeploymentReceipt, FrozenDeploymentPlan, HostContribution, MutationContext, MutationOutcome, PreparedDeployment,
  PreparationEvidence, ProjectionResult, ReadContext, RenderUnit, Resolution } from '../platforms/contracts.js';
import { getAgentPluginAdapter } from '../platforms/registry.js';
import { getQualifiedPlatformProfile } from '../platforms/capabilities.js';
import { getDeploymentLayout, getDeploymentResourceKey, getInvocationPolicyPhysicalKey } from '../platforms/layout.js';
import { deploymentPackageComponent, inspectStaticSupplements } from '../platforms/inspection.js';
import type { PlatformDriverState } from '../platforms/lifecycle.js';
import { nativeRoute } from '../platforms/lifecycle-native.js';
import { createNativeLifecycleServices } from '../platforms/lifecycle-native-services.js';
import { assertGeminiProjectRules, geminiActivationEvidence, geminiActivationRules, geminiExtensionPaths, geminiScopePattern,
  geminiUserActivation, readGeminiActivationSnapshot } from '../platforms/gemini-activation.js';
import { cursorWorkspaceOpenCommand } from '../platforms/projection.js';
import { ownedSupplementFile, staticSupplementFiles } from '../platforms/supplement-layout.js';
import { projectPlatformMarketplace } from '../platforms/projection-marketplace.js';
import { readStrictNamespacedMarketplaceRoot } from '../utils/local-marketplace.js';
import { artifactValueDigest, mergeExpectedComponentSets } from '../utils/artifact-plan.js';
import { preparePlatformComponents, resolveArtifactRenderConfig, type PreparedPlatformComponents } from '../utils/artifact-renderer.js';
import { finalizePlatformSkillProducers, type FinalizedPlatformComponents } from '../utils/component-command-preparation.js';
import { cleanupOwnedComponents, createSharedOwnerToken, inspectOwnedComponents, writeOwnedTextFile,
  writeSkillOwnerMarker, type NativeProjectionEvidence, type OwnedComponent, type OwnedComponentExecutor } from '../utils/ownership.js';
import type { CleanupResult } from '../utils/ownership.js';
import { createPlatformEmptyState, createPlatformInputEvidence, platformPackageInputDigest, readPlatformPackageContentDigest, writePlatformEmptyState, type PlatformEmptyState } from '../utils/platform-empty-state.js';
import { atomicReplaceSafeFile, assertSafeFileMutationPath } from '../utils/safe-fs.js';
import { assertManagedCommandBindingIdentities, captureManagedCommandBindingRecoveryEvidence, publishManagedCommandBindings, listManagedCommands, readInstalledCommandProducer, revokeManagedCommandBindings,
  type ManagedCommandBindingRecoveryEvidence } from '../utils/managed-command-store.js';
import { captureNativeToolChanges, type NativeToolChange } from '../utils/native-tool-review.js';
import { captureManagedCommandReviewEvidence } from '../utils/managed-command-review.js';
import { readClaudeSettings } from '../adapters/helpers.js';
import { readCodexConfigFile } from '../utils/codex-config.js';
import { parseOwnedTextHeader, readSkillOwnerMarker } from '../utils/ownership.js';
import type { RebuildExecutionContext, RebuildIntegration } from './rebuild-integration.js';
import { applyPlannedOperationAction } from './rebuild-integration.js';
import type { DesiredTarget } from './rebuild-operations.js';

type TargetInput = Parameters<RebuildIntegration['buildTarget']>[0];
export interface PreparedPlatformTarget {
  deployments: PreparedDeployment<PlatformDriverState>[];
  plans: FrozenDeploymentPlan[];
  readonly blockedReceipts: readonly DeploymentReceipt[];
  readonly cleanupResults: readonly CleanupResult[];
  captureNativeToolChanges(): Promise<NativeToolChange[]>;
  verify(): Promise<void>;
  execute(): Promise<DeploymentReceipt[]>;
  postcheck(receipts: readonly DeploymentReceipt[]): Promise<void>;
}
interface UnitPreparation {
  unit: RenderUnit;
  prepared: PreparedPlatformComponents;
  finalized: FinalizedPlatformComponents;
  emptyInput: Parameters<typeof createPlatformEmptyState>[0]['units'][number];
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
      if (entries.some((entry) => entryCommand(entry) === locator.command)) value = { version: 1, hooks: { workspaceOpen: [{ command: locator.command }] } };
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

/** Cursor has one fixed hook slot; this does not interpret arbitrary JSON patches. */
function cursorHooks(value: Record<string, unknown>): { hooks: Record<string, unknown>; entries: unknown[] } {
  const hooks = value.hooks ?? {};
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error('cursorHooksInvalid');
  const entries = (hooks as Record<string, unknown>).workspaceOpen ?? [];
  if (!Array.isArray(entries)) throw new Error('cursorHooksInvalid');
  return { hooks: hooks as Record<string, unknown>, entries };
}
function entryCommand(value: unknown): string | undefined {
  return value && typeof value === 'object' && 'command' in value && typeof value.command === 'string' ? value.command : undefined;
}
export const platformOwnership: OwnedComponentExecutor = {
  async inspectShared(component) {
    if (component.locator.kind !== 'cursor-workspace-hook') throw new Error('sharedOwnershipUnsupported');
    const locator = component.locator;
    const { entries } = cursorHooks(await jsonObject(locator.hooksPath));
    return entries.some((entry) => entryCommand(entry) === locator.command) ? 'present' : 'absent';
  },
  async removeShared(component) {
    if (component.locator.kind !== 'cursor-workspace-hook') throw new Error('sharedOwnershipUnsupported');
    const locator = component.locator;
    const value = await jsonObject(locator.hooksPath);
    const { hooks, entries } = cursorHooks(value);
    const retained = entries.filter((entry) => entryCommand(entry) !== locator.command);
    if (retained.length === entries.length) return;
    await atomicReplaceSafeFile({ filePath: component.locator.hooksPath, allowedRoot: path.dirname(component.locator.hooksPath),
      content: `${JSON.stringify({ ...value, hooks: { ...hooks, workspaceOpen: retained } }, null, 2)}\n`, label: 'Cursor workspaceOpen' });
  },
};

async function requireWritable(component: OwnedComponent, executor: OwnedComponentExecutor = platformOwnership): Promise<void> {
  const inspection = await inspectOwnedComponents({ components: [component], executor });
  if (!['present', 'absent'].includes(inspection.components[0]!.state)) throw new Error('operationPlanStale: deployment ownership changed.');
}
async function publishDirectory(source: string, component: OwnedComponent, nativeProjection?: NativeProjectionEvidence): Promise<{ mutation: 'confirmed'; changed: true }> {
  if (component.kind !== 'owned-directory') throw new Error('deploymentPackageOwnerInvalid');
  await requireWritable(component);
  await assertSafeFileMutationPath({ filePath: path.join(component.allowedRoot, '.aw-publication-probe'),
    allowedRoot: component.allowedRoot, label: 'Native package', createParent: true });
  const staging = await fs.mkdtemp(path.join(component.allowedRoot, '.aw-package-'));
  const candidate = path.join(staging, component.identity.artifactKey);
  const backup = `${staging}.previous`;
  let moved = false;
  try {
    await fs.copy(source, candidate, { dereference: false });
    await writeSkillOwnerMarker({ skillRoot: candidate, allowedRoot: staging, identity: component.identity, nativeProjection });
    await requireWritable(component);
    if (await fs.pathExists(component.path)) { await fs.move(component.path, backup); moved = true; }
    try { await fs.move(candidate, component.path); }
    catch (error) { if (moved && !await fs.pathExists(component.path)) await fs.move(backup, component.path); throw error; }
    await fs.remove(backup);
    return { mutation: 'confirmed', changed: true };
  } finally { await fs.remove(staging); }
}


async function sharedReferences(context: RebuildExecutionContext, binding: DeploymentBinding,
  observation: Awaited<ReturnType<ReturnType<typeof getAgentPluginAdapter>['inspect']>>,
  layout: Awaited<ReturnType<typeof getDeploymentLayout>>): Promise<PreparationEvidence['sharedReferences']> {
  if (!['codex-marketplace', 'claude-marketplace', 'gemini-extension', 'copilot-marketplace'].includes(binding.route)) return 'none';
  const view = context.sharedReferenceView;
  const same = (reference: NonNullable<typeof view>['desired'][number]): boolean => reference.pluginId === binding.plugin.pluginId
    && reference.sourceIdentity === binding.plugin.sourceIdentity && reference.platform === binding.platform
    && (reference.physicalKey === undefined || reference.physicalKey === binding.physicalKey);
  const current = (reference: NonNullable<typeof view>['desired'][number]): boolean => reference.scope === binding.scope.kind
    && (reference.scope !== 'project' || binding.scope.kind === 'project' && reference.projectRoot === binding.scope.projectRoot);
  if (view && [...view.desired, ...view.observed].some((reference) => same(reference) && !current(reference))) return 'present';
  const host = binding.consumers.find((consumer) => consumer.entry?.kind === 'cli')?.entry;
  if (!host || host.kind !== 'cli' || observation.registration === 'unknown') return 'unknown';
  if (binding.route === 'gemini-extension') {
    try {
      const ctx = readContext(context, binding.scope.kind === 'project' ? binding.scope.projectRoot : layout.packageRoot);
      const snapshot = await readGeminiActivationSnapshot(ctx);
      const rules = geminiActivationRules(snapshot, layout.nativeIdentity.packageId);
      await assertGeminiProjectRules(ctx, binding, rules);
      const home = geminiExtensionPaths(ctx).home;
      const userActivation = geminiUserActivation(snapshot, layout.nativeIdentity.packageId, home);
      if (userActivation === 'unknown') return 'unknown';
      if (binding.scope.kind === 'project' && observation.registration === 'present' && userActivation) return 'present';
      const currentPattern = binding.scope.kind === 'project' ? geminiScopePattern(binding.scope.projectRoot) : null;
      if (rules.some((rule) => {
        const pattern = rule.startsWith('!') ? rule.slice(1) : rule;
        return pattern !== '*' && pattern !== geminiScopePattern(home) && pattern !== currentPattern;
      })) return 'present';
      return view?.desiredComplete && view.scopes.includes('user') ? 'none' : 'unknown';
    } catch { return 'unknown'; }
  }
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
  return observation.registration === 'absent' && observation.consumers.every((consumer) => consumer.activation === 'disabled')
    && view?.desiredComplete === true && view.scopes.includes('user') && view.scopes.includes('project') ? 'none' : 'unknown';
}

export class PlatformRebuildSession {
  private readonly targets = new Map<string, Promise<DesiredTarget>>();
  private readonly resolutions = new Map<string, Promise<Resolution>>();
  private readonly units = new Map<string, Promise<UnitPreparation>>();
  private readonly published = new Map<string, Promise<{ mutation: 'none' | 'confirmed' | 'possible'; changed: boolean }>>();
  private readonly nativeEffects = new Map<string, Promise<MutationOutcome>>();
  private readonly exclusions = new Map<string, DeploymentExclusion[]>();
  private readonly contexts = new Set<ReadContext>();
  private readonly mutableChecks = new Map<string, { physicalKey: string; marketplaceRoot: string | null;
    sourceId: string; sourceIdentity: string; assertStable(): Promise<void>;
    geminiActivationSnapshot?(): MutationContext['geminiActivationSnapshot'];
    acceptMarketplaceRegistration(): Promise<void>; rebase(geminiExpected?: MutationContext['geminiActivationSnapshot']): Promise<void> }>();
  private readonly requestedOperations = new Map<string, TargetInput>();
  private readonly marketplaceTargets = new Set<DesiredTarget>();
  private marketplaceCandidatesFrozen = false;
  private ownership: OwnedComponentExecutor = platformOwnership;
  private readonly marketplaces = new Map<string, {
    evidence: NonNullable<PreparationEvidence['marketplace']>;
    currentFingerprint: string;
    publication?: Promise<void>;
  }>();
  private staging?: Promise<string>;
  constructor(private context: RebuildExecutionContext,
    private readonly adapterFor: typeof getAgentPluginAdapter = getAgentPluginAdapter) {}
  updateContext(context: RebuildExecutionContext): void {
    this.context = context;
    for (const ctx of this.contexts) Object.assign(ctx, readContext(context, ctx.cwd));
  }
  setOwnershipExecutor(executor: OwnedComponentExecutor): void { this.ownership = executor; }
  private root(): Promise<string> { return this.staging ??= fs.mkdtemp(path.join(os.tmpdir(), 'aw-deployment-')); }
  async dispose(): Promise<void> {
    for (const result of await Promise.allSettled(this.units.values())) if (result.status === 'fulfilled') await result.value.finalized.cleanup();
    if (this.staging) await fs.remove(await this.staging);
    this.staging = undefined;
    this.targets.clear(); this.resolutions.clear(); this.units.clear(); this.published.clear();
    this.nativeEffects.clear(); this.exclusions.clear();
    this.contexts.clear(); this.mutableChecks.clear(); this.requestedOperations.clear(); this.marketplaces.clear();
    this.marketplaceTargets.clear(); this.marketplaceCandidatesFrozen = false;
  }
  freezeMarketplaceCandidates(): void { this.marketplaceCandidatesFrozen = true; }
  private key(input: TargetInput): string { return artifactValueDigest({ plugin: sourceIdentity(input), platform: input.platform, scope: input.scope, cwd: input.scope === 'project' ? input.cwd : null, operation: operation(input) }); }
  private resolve(input: TargetInput): Promise<Resolution> {
    const key = this.key(input);
    // Inspection of a shared package does not request activation in that scope.
    if (!input.readOnlyInspectionPlan) this.requestedOperations.set(key, input);
    let result = this.resolutions.get(key);
    if (!result) {
      result = (async () => {
        const adapter = this.adapterFor(input.platform);
        const ctx = readContext(this.context, input.cwd);
        const plugin = sourceIdentity(input);
        const recoveryCandidates = (this.context.recoveryCandidates ?? []).filter((candidate) => candidate.binding.platform === input.platform
          && candidate.binding.plugin.sourceIdentity === plugin.sourceIdentity && candidate.binding.plugin.pluginId === plugin.pluginId
          && candidate.binding.scope.kind === input.scope && (candidate.binding.scope.kind !== 'project' || candidate.binding.scope.projectRoot === input.cwd));
        const scope = input.scope === 'project' ? { kind: 'project' as const, projectRoot: input.cwd } : { kind: 'user' as const };
        const discovery = await adapter.discover(ctx);
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
        return resolution;
      })();
      this.resolutions.set(key, result);
    }
    return result;
  }
  /** Resolve the whole selected scope before any physical unit is rendered. */
  async resolveAll(inputs: readonly TargetInput[]): Promise<void> {
    await Promise.allSettled(inputs.map((input) => this.resolve(input)));
  }
  private async freezeSharedPreApplyActions(targets: readonly DesiredTarget[]): Promise<void> {
    const prepared = (await Promise.allSettled(this.targets.values())).flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    for (const target of targets) {
      if (target.identity.scope !== 'project' || !target.operationActions?.some((action) => action.kind === 'runPreApply')) continue;
      const plans = target.platformDeployment?.plans ?? [];
      if (!plans.length || plans.some((plan) => !['codex-marketplace', 'claude-marketplace', 'gemini-extension', 'copilot-marketplace'].includes(plan.binding.route)
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
    let target = this.targets.get(key);
    if (!target) { target = this.build(input); this.targets.set(key, target); }
    const result = await target;
    await result.platformDeployment?.verify();
    return result;
  }
  private async build(input: TargetInput): Promise<DesiredTarget> {
    const resolution = await this.resolve(input);
    if (!resolution.bindings.length) throw Object.assign(
      new Error(`platformUnavailable: ${resolution.exclusions.map((item) => item.reasonCode).join(', ') || input.platform}`),
      { deploymentExclusions: this.exclusions.get(this.key(input)) ?? [] });
    const adapter = this.adapterFor(input.platform);
    const ctx = readContext(this.context, input.cwd);
    this.contexts.add(ctx);
    const observed = await Promise.all(resolution.bindings.map(async (binding) => ({ binding, observation: await adapter.inspect(ctx, binding), layout: await getDeploymentLayout(ctx, binding) })));
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
          const prepared = await preparePlatformComponents({ plugin: input.plugin, platform: input.platform, staticResourceRoot,
            renderScope: unit.renderScope.kind, kinds: unit.kinds, capabilities, config, cwd: input.cwd,
            commandEnv: this.context.env, signal: this.context.signal, scriptTimeoutMs: this.context.scriptTimeoutMs,
            preparedResults: this.context.preparedArtifactRenderResults });
          const finalized = await finalizePlatformSkillProducers({ plugin: input.plugin, plugins: this.context.referencePlugins,
            platform: input.platform, renderUnit: commonUnit, prepared, skillWorkRoot: path.join(await this.root(), artifactValueDigest(unit.physicalKey).slice(7), 'skills'),
            cwd: input.cwd, env: this.context.env, signal: this.context.signal, scriptTimeoutMs: this.context.scriptTimeoutMs,
            packagePreparationCache: this.context.packagePreparationCache });
          return { unit: commonUnit, prepared: finalized.prepared, finalized,
            emptyInput: { renderUnit: commonUnit, capabilities, config, prerequisites: bindingEntry.observation.prerequisites } };
        })();
        this.units.set(unit.physicalKey, promise);
      }
      preparedUnits.set(unit.id, await promise);
    }
    const deployments: PreparedDeployment<PlatformDriverState>[] = [];
    const plans: FrozenDeploymentPlan[] = [];
    const blockedReceipts: DeploymentReceipt[] = [];
    const cleanupResults: CleanupResult[] = [];
    const checks = new Map<string, () => Promise<boolean>>();
    const priorProducers = new Map<string, ProducerIdentity[]>();
    const priorResourceRoots = new Map<string, string[]>();
    const bindingRecoveryEvidence: ManagedCommandBindingRecoveryEvidence[] = [];
    const emptyStates = new Map<string, PlatformEmptyState>();
    const inputDigests = new Map<string, string>();
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
        projections.push(await adapter.project({ ...ctx, stagingRoot: path.join(await this.root(), 'projection'), commandResolver: unit.finalized.commandResolver }, {
          binding: entry.binding, renderUnit: unit.unit, capabilities: adapter.capabilities({ ...entry, renderUnit: unit.unit, profile: getQualifiedPlatformProfile(input.platform) }),
          components, resources, policy: components.length ? resolveInvocationPolicy(input.plugin.manifest, input.platform) : { ...resolveInvocationPolicy(input.plugin.manifest, input.platform), permissions: [] } }));
      }
      const policyKey = input.platform === 'codex' || input.platform === 'claude' ? await getInvocationPolicyPhysicalKey(ctx, entry.binding) : undefined;
      const currentComponents = [deploymentPackageComponent(entry.binding, entry.layout),
        ...projections.flatMap((projection) => projection.supplements.map((contribution) => contributionComponent(entry.binding, contribution,
          policyKey && (contribution.mergeKey?.startsWith('claude-permissions:') || input.platform === 'codex' && contribution.destination.endsWith('.rules'))
            ? policyKey : entry.layout.renderUnits.find((unit) => unit.id === projection.renderUnitId)!.physicalKey)))];
      const historical = await ownedSupplements(entry.binding, entry.layout.supplementRoot,
        entry.layout.renderUnits.find((unit) => unit.output === 'supplement')?.physicalKey);
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
      const components = [...currentComponents, ...historical.filter((component) => !currentComponents.some((current) =>
        'path' in current && 'path' in component && current.path === component.path
        || current.kind === 'shared-config' && component.kind === 'shared-config' && artifactValueDigest(current.locator) === artifactValueDigest(component.locator)))];
      for (const component of components) if (component.kind === 'shared-config' && component.locator.kind === 'cursor-workspace-hook') {
        const locator = component.locator;
        const contribution = projections.flatMap((projection) => projection.supplements).find((item) => item.destination === locator.hooksPath);
        if (!contribution) continue;
        const { entries } = cursorHooks(await jsonObject(contribution.stagingPath));
        const command = entries.map(entryCommand).find((value) => value !== undefined);
        if (!command) throw new Error('cursorWorkspaceHookInvalid');
        component.locator.command = command;
      }
      const inspected = await inspectOwnedComponents({ components, executor: this.ownership });
      const managedCommandReview = await captureManagedCommandReviewEvidence({ binding: entry.binding,
        renderUnits: entry.layout.renderUnits, components: units.flatMap((unit) => unit.prepared.expected.components), projections });
      const currentMutable = async () => {
        const observation = await adapter.inspect(ctx, entry.binding);
        return { observation, references: await sharedReferences(this.context, entry.binding, observation, entry.layout),
          geminiActivation: entry.binding.route === 'gemini-extension' ? geminiActivationEvidence(await readGeminiActivationSnapshot(ctx)) : undefined,
          paths: await Promise.all(components.map(async (component) => 'path' in component ? pathEvidence(component.path) : {
            ownership: await inspectOwnedComponents({ components: [component], executor: this.ownership }), contentDigest: await ownedContentDigest(component),
          })) };
      };
      const fingerprintParts = async () => ({
        managedCommandReview,
        source: removing ? null : await pathEvidence(input.plugin.rootDir),
        discovery: removing ? { consumers: entry.binding.consumers, executables: await Promise.all(entry.binding.consumers.map((consumer) =>
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
      const initialParts = await fingerprintParts();
      const initial = artifactValueDigest(initialParts);
      const fingerprint = async (): Promise<string> => artifactValueDigest(await fingerprintParts());
      let mutableBaseline = await currentMutable();
      checks.set(entry.binding.id, async () => await fingerprint() === initial
        && artifactValueDigest(await currentMutable()) === artifactValueDigest(mutableBaseline));
      this.mutableChecks.set(entry.binding.id, { physicalKey: entry.binding.physicalKey,
        marketplaceRoot: entry.layout.marketplaceRoot, sourceId: entry.binding.plugin.sourceId,
        sourceIdentity: entry.binding.plugin.sourceIdentity,
        ...(entry.binding.route === 'gemini-extension' ? { geminiActivationSnapshot: () => mutableBaseline.geminiActivation } : {}),
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
          if (!onlyRegistration || await fingerprint() !== initial) {
            throw new Error('operationPlanStale: deployment evidence changed during source registration.');
          }
          // This is the one shared observation changed by our confirmed source
          // registration. The reviewed package, references and bytes stay frozen.
          mutableBaseline = current;
        },
        rebase: async (geminiExpected) => {
          const current = await fingerprintParts();
          if (artifactValueDigest(current) !== initial) {
            const changed = (Object.keys(initialParts) as Array<keyof typeof initialParts>)
              .filter((key) => artifactValueDigest(current[key]) !== artifactValueDigest(initialParts[key]));
            throw new Error(`operationPlanStale: immutable deployment input changed (${changed.join(', ')}).`);
          }
          const mutable = await currentMutable();
          if (artifactValueDigest(mutable.geminiActivation ?? null) !== artifactValueDigest(geminiExpected ?? mutableBaseline.geminiActivation ?? null)) {
            throw new Error('operationPlanStale: Gemini activation changed outside the checked native mutation.');
          }
          mutableBaseline = mutable;
        } });
      const evidence: PreparationEvidence = { fingerprint: initial, managedCommandReview, layout: entry.layout, renderUnits: entry.layout.renderUnits,
        ownership: await Promise.all(inspected.components.map(async ({ component, state }) => ({ component, state,
          contentDigest: state === 'present' ? await ownedContentDigest(component) : undefined,
          physicalKey: component.identity.physicalKey ?? entry.binding.physicalKey }))),
        sharedReferences: await sharedReferences(this.context, entry.binding, entry.observation, entry.layout),
        nativeIdentity: entry.observation.nativeIdentity ?? entry.layout.nativeIdentity,
        contentMatches: projections.some((projection) => projection.bundle !== null)
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
      if (entry.binding.route === 'gemini-extension') {
        evidence.userActivationEnabled = 'unknown';
        const view = this.context.sharedReferenceView;
        try {
          const snapshot = await readGeminiActivationSnapshot(ctx, mutableBaseline.geminiActivation);
          const rules = geminiActivationRules(snapshot, entry.layout.nativeIdentity.packageId);
          await assertGeminiProjectRules(ctx, entry.binding, rules);
          const actual = geminiUserActivation(snapshot, entry.layout.nativeIdentity.packageId, geminiExtensionPaths(ctx).home);
          if (actual !== 'unknown' && entry.observation.registration !== 'unknown'
            && (entry.binding.scope.kind === 'user' || view?.desiredComplete && view.scopes.includes('user'))) {
            // Shared User renderScope does not establish User demand. A fresh
            // project starts disabled globally; an existing global intent stays.
            evidence.userActivationEnabled = entry.observation.registration === 'present' ? actual : entry.binding.scope.kind === 'user'
              || view?.desired.some((reference) => reference.scope === 'user' && reference.platform === 'gemini'
                && reference.pluginId === entry.binding.plugin.pluginId && reference.sourceIdentity === entry.binding.plugin.sourceIdentity) === true;
          }
        } catch { /* Invalid or ambiguous native configuration remains blocked. */ }
      }
      if (entry.binding.scope.kind === 'project' && ['codex', 'copilot', 'gemini'].includes(entry.binding.platform)) {
        const plannedUser = [...this.requestedOperations.values()].find((request) => request.scope === 'user'
          && request.platform === input.platform && sourceIdentity(request).sourceIdentity === entry.binding.plugin.sourceIdentity
          && sourceIdentity(request).pluginId === entry.binding.plugin.pluginId);
        if (plannedUser && (entry.binding.platform !== 'gemini' || typeof evidence.userActivationEnabled === 'boolean')) {
          evidence.userActivationEnabled = !['remove', 'cleanup'].includes(operation(plannedUser));
        }
      }
      const expected = mergeExpectedComponentSets(units.map((unit) => unit.prepared.expected));
      evidence.retainPackage = !removing && expected.unmet.length > 0 && inspected.components.some((slot) =>
        'path' in slot.component && slot.component.path === entry.layout.packageRoot && ['present', 'partial'].includes(slot.state));
      if (!removing) inputDigests.set(entry.binding.id, platformPackageInputDigest(await createPlatformInputEvidence({ plugin: input.plugin, binding: entry.binding, units: units.map((unit) => unit.emptyInput) })));
      if (!removing && expected.components.length === 0 && expected.unmet.length === 0) {
        emptyStates.set(entry.binding.id, await createPlatformEmptyState({ plugin: input.plugin, binding: entry.binding,
          units: units.map((unit) => unit.emptyInput) }));
      }
      const result = adapter.lifecycle.prepare({ operation: operation(input), binding: entry.binding, observation: entry.observation,
        projections, expected, evidence });
      if (result.status === 'blocked') {
        plans.push({ operation: operation(input), binding: entry.binding, projections, expected, evidence, effects: [] });
        blockedReceipts.push({ bindingId: entry.binding.id, effects: [], after: entry.observation,
          unmet: expected.unmet.map((gap) => ({ ...gap, productIds: entry.binding.consumers.map((consumer) => consumer.id) })),
          reload: 'none', diagnostics: result.diagnostics });
      } else { deployments.push(result.prepared); plans.push(result.prepared.plan); }
    }
    target.ownedComponents = plans.flatMap((plan) => plan.evidence.ownership.map((item) => item.component));
    target.desiredOwnedComponents = target.ownedComponents;
    let frozenNativeTools: { signature: string; changes: NativeToolChange[] } | undefined;
    target.platformDeployment = { deployments, plans, blockedReceipts, cleanupResults,
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
      verify: async () => {
        for (const check of checks.values()) if (!await check()) throw new Error('operationPlanStale: deployment evidence changed.');
        for (const plan of plans) if (!await this.verifyMarketplace(plan)) throw new Error('operationPlanStale: marketplace evidence changed.');
      },
      postcheck: async (receipts) => {
        let incomplete = false;
        for (const { plan } of deployments) {
          if (!['ensure', 'reinstall'].includes(plan.operation) || !plan.expected.components.length) continue;
          const receipt = receipts.find((entry) => entry.bindingId === plan.binding.id);
          if (!receipt) continue;
          const after = await adapter.inspect(ctx, plan.binding);
          const supplementIds = new Set(plan.projections.filter((projection) => plan.evidence.renderUnits?.some((unit) =>
            unit.id === projection.renderUnitId && unit.output === 'supplement')).flatMap((projection) => projection.supplements
            .filter((contribution) => contribution.kind === 'owned-file').flatMap((contribution) => contribution.componentIds)));
          const supplements = await inspectStaticSupplements(ctx, plan.binding,
            plan.expected.components.filter((component) => supplementIds.has(component.id)));
          after.components = [...after.components.filter((component) => !supplementIds.has(component.id)), ...supplements.components];
          receipt.after = after;
          const packageIds = new Set(plan.projections.filter((projection) => projection.bundle)
            .flatMap((projection) => projection.components.map((component) => component.id)));
          const untrusted = after.consumers.some((consumer) => consumer.trust === 'required' || consumer.trust === 'blocked');
          const packageIncomplete = packageIds.size > 0 && (after.package !== 'present' || !['aw', 'shared'].includes(after.ownership)
            || nativeRoute(plan.binding.route) && (after.registration !== 'present'
              || after.consumers.some((consumer) => consumer.activation !== 'enabled') || untrusted));
          const gaps = plan.expected.components.filter((component) => packageIncomplete && packageIds.has(component.id)
            || !after.components.some((observed) => observed.id === component.id && observed.presence === 'present' && !observed.reasonCodes.length));
          receipt.diagnostics.push(...after.diagnostics);
          if (!gaps.length) continue;
          incomplete = true;
          const code = untrusted ? 'nativeTrustRequired' : 'deploymentPostcheckFailed';
          receipt.diagnostics.push({ code, severity: 'error',
            message: 'The final grouped observation does not confirm the requested deployment. Check status and sync the affected target.',
            subject: { target: plan.binding.platform, pluginId: plan.binding.plugin.pluginId, scope: plan.binding.scope.kind } });
          receipt.unmet.push(...gaps.map((component) => ({ id: `postcheck:${plan.binding.id}:${component.id}`,
            componentId: component.id, kind: component.kind, reasonCode: code, requiredFeatures: [],
            productIds: plan.binding.consumers.map((consumer) => consumer.id) })));
        }
        if (incomplete) throw new Error('deploymentPostcheckFailed: the final grouped observation does not confirm the requested deployment.');
      },
      execute: async () => {
        cleanupResults.length = 0;
        const receipts: DeploymentReceipt[] = [...blockedReceipts];
        for (const prepared of deployments) {
          const commandPreparationFailed = prepared.plan.binding.renderUnitIds.some((unitId) => preparedUnits.get(unitId)?.finalized.producerResolutions
            .some((resolution) => resolution.state === 'failed' || resolution.state === 'unmet'));
          let receipt: DeploymentReceipt;
          const executionContext = { ...ctx, geminiActivationSnapshot: structuredClone(this.mutableChecks.get(prepared.plan.binding.id)?.geminiActivationSnapshot?.()) };
          const nativeServices = createNativeLifecycleServices(executionContext, prepared.plan.evidence);
          try { receipt = await adapter.lifecycle.execute({ ...executionContext, nativeEffects: this.nativeEffects, inspect: (binding) => adapter.inspect(ctx, binding), services: {
            ...nativeServices,
            registerMarketplace: async (binding, identity) => {
              const peers = binding.route === 'codex-marketplace' ? [...this.mutableChecks.values()].filter((check) =>
                check.physicalKey !== binding.physicalKey && check.marketplaceRoot === prepared.plan.evidence.layout.marketplaceRoot
                && check.sourceId === binding.plugin.sourceId && check.sourceIdentity === binding.plugin.sourceIdentity) : [];
              for (const peer of peers) await peer.assertStable();
              const outcome = await nativeServices.registerMarketplace(binding, identity);
              if (outcome.mutation === 'confirmed') {
                ctx.codexObservationSession?.invalidate(prepared.plan.evidence.layout.marketplaceName ?? undefined);
                for (const peer of peers) await peer.acceptMarketplaceRegistration();
              }
              return outcome;
            },
            verifyEvidence: async (plan) => await checks.get(plan.binding.id)!() && await this.verifyMarketplace(plan),
            publishPackage: async (_binding, bundle, _destination, component) => {
              if (!('path' in component) || component.path !== _destination) throw new Error('deploymentDestinationMismatch');
              await this.publishMarketplace(prepared.plan);
              let publication = this.published.get(prepared.plan.binding.physicalKey);
              if (!publication) {
                publication = publishDirectory(bundle.stagingRoot, component, {
                  components: prepared.plan.projections.filter((projection) => projection.bundle !== null).flatMap((projection) => projection.components),
                  inputDigest: inputDigests.get(prepared.plan.binding.id)!, contentDigest: bundle.contentDigest,
                  preparation: prepared.plan.expected.unmet.length || commandPreparationFailed ? 'partial' : 'complete',
                  physicalIdentity: (await getDeploymentLayout(ctx, prepared.plan.binding)).physicalIdentity,
                });
                this.published.set(prepared.plan.binding.physicalKey, publication);
              }
              return publication;
            },
            writeContribution: async (_binding, contribution, component) => {
              await requireWritable(component, this.ownership);
              if (component.kind === 'owned-directory') return publishDirectory(contribution.stagingPath, component);
              if (component.kind === 'owned-text-file') {
                await writeOwnedTextFile({ ...component, content: await fs.readFile(contribution.stagingPath, 'utf8') });
              } else if (component.kind === 'shared-config' && component.locator.kind === 'cursor-workspace-hook') {
                const locator = component.locator;
                const value = await jsonObject(locator.hooksPath);
                const { hooks, entries } = cursorHooks(value);
                const desired = cursorHooks(await jsonObject(contribution.stagingPath)).entries;
                await atomicReplaceSafeFile({ filePath: component.locator.hooksPath, allowedRoot: path.dirname(component.locator.hooksPath), label: 'Cursor workspaceOpen',
                  content: `${JSON.stringify({ ...value, hooks: { ...hooks, workspaceOpen: [...entries.filter((item) => entryCommand(item) !== locator.command), ...desired] } }, null, 2)}\n` });
              } else if (component.kind === 'shared-config' && component.locator.kind === 'claude-permissions') {
                const content = await jsonObject(contribution.stagingPath);
                if (content.kind !== 'claude-permissions') throw new Error('platformContributionUnsupported');
                await applyPlannedOperationAction({ kind: 'updateSharedConfig', pluginId: prepared.plan.binding.plugin.pluginId,
                  platform: 'claude', scope: prepared.plan.binding.scope.kind, owner: component.identity, locator: component.locator,
                  contentDigest: contribution.contentDigest, mutation: { kind: 'claude-permissions', permissions: content.permissions } });
              } else throw new Error('platformContributionUnsupported');
              return { mutation: 'confirmed', changed: true };
            },
            removeOwned: async (_binding, component) => {
              const result = await cleanupOwnedComponents({ components: [component], executor: this.ownership });
              cleanupResults.push(result);
              if (result.failures.length || result.residual.length || result.quarantined.length) {
                throw Object.assign(new Error('deploymentCleanupIncomplete'), result.removed.length || result.quarantined.length
                  ? { mutation: 'confirmed' } : {});
              }
              return { mutation: result.removed.length ? 'confirmed' : 'none', changed: result.removed.length > 0 };
            },
          } }, prepared); } catch (error) {
            const diagnostic = { code: 'platformExecutionFailed', severity: 'error' as const,
              message: error instanceof Error ? error.message : String(error),
              subject: { target: prepared.plan.binding.platform, pluginId: prepared.plan.binding.plugin.pluginId, scope: prepared.plan.binding.scope.kind } };
            receipt = { bindingId: prepared.plan.binding.id, effects: prepared.plan.effects.map((effect) => ({
              id: effect.id, status: 'unknown', mutation: 'possible', diagnostics: [diagnostic] })),
              after: await adapter.inspect(ctx, prepared.plan.binding).catch(() => prepared.driverState.before),
              unmet: [], reload: 'unknown', diagnostics: [diagnostic] };
          }
          receipts.push(receipt);
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
          try {
            if (receipt.effects.some((effect) => effect.mutation !== 'none')) {
              for (const check of this.mutableChecks.values()) if (check.physicalKey === prepared.plan.binding.physicalKey
                || executionContext.geminiActivationSnapshot && check.geminiActivationSnapshot?.()?.path === executionContext.geminiActivationSnapshot.path) {
                await check.rebase(executionContext.geminiActivationSnapshot);
              }
            }
          } catch (error) {
            receipt.diagnostics.push({ code: 'operationPlanStale', severity: 'error', message: error instanceof Error ? error.message : String(error),
              subject: { target: prepared.plan.binding.platform, pluginId: prepared.plan.binding.plugin.pluginId, scope: prepared.plan.binding.scope.kind } });
            continue;
          }
          if (prepared.plan.evidence.retainPackage || receipt.effects.some((effect) => ['failed', 'unknown', 'blocked', 'skipped'].includes(effect.status))) continue;
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
              && await readPlatformPackageContentDigest(root) === bundle.contentDigest) {
              const projection: NativeProjectionEvidence = { components: mappings, contentDigest: bundle.contentDigest,
                inputDigest: inputDigests.get(prepared.plan.binding.id)!, preparation: prepared.plan.expected.unmet.length || commandPreparationFailed ? 'partial' : 'complete',
                physicalIdentity: (await getDeploymentLayout(ctx, prepared.plan.binding)).physicalIdentity };
              const marker = await readSkillOwnerMarker({ skillRoot: root, allowedRoot: packageOwner.allowedRoot, expectedIdentity: packageOwner.identity });
              if (artifactValueDigest(marker?.nativeProjection) !== artifactValueDigest(projection)) {
                await writeSkillOwnerMarker({ skillRoot: root, allowedRoot: packageOwner.allowedRoot, identity: packageOwner.identity, nativeProjection: projection });
                for (const check of this.mutableChecks.values()) if (check.physicalKey === prepared.plan.binding.physicalKey) await check.rebase();
              }
            }
            const packageRemoved = !await fs.pathExists(root);
            const replaced = receipt.effects.some((effect) => effect.status === 'applied'
              && prepared.plan.effects.some((planned) => planned.id === effect.id && planned.kind === 'publish-package'));
            for (const producer of priorProducers.get(prepared.plan.binding.id) ?? []) {
              if (candidates.some((candidate) => artifactValueDigest(candidate.producer) === artifactValueDigest(producer))) continue;
              const componentId = producer.kind === 'static-skill' ? `skill:${producer.key}` : producer.key;
              if (packageRemoved || replaced && !prepared.plan.expected.unmet.some((gap) => gap.id === componentId)) {
                await revokeManagedCommandBindings(producer, this.context.env);
              }
            }
            const emptyState = emptyStates.get(prepared.plan.binding.id);
            if (emptyState && !receipt.unmet.length && !receipt.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
              && receipt.after.registration !== 'unknown' && receipt.after.package !== 'unknown'
              && !['foreign', 'unknown'].includes(receipt.after.ownership)
              && receipt.after.consumers.every((consumer) => !['unknown', 'enabled'].includes(consumer.activation))) {
              const residual = await inspectOwnedComponents({ components: prepared.plan.evidence.ownership
                .filter((slot) => !('path' in slot.component) || slot.component.path !== prepared.plan.evidence.layout.packageRoot)
                .map((slot) => slot.component), executor: this.ownership });
              if (residual.components.every((component) => component.state === 'absent')) await writePlatformEmptyState({ state: emptyState, env: this.context.env });
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
    return target;
  }
}
