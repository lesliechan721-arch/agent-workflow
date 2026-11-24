import path from 'node:path';
import fs from 'fs-extra';
import {
  assertFeatureRequirement, COMPONENT_KINDS, getComponentFeatureRequirements, getPlatformCapabilityFact, normalizeStaticPluginComponents, partitionStaticPluginComponents, resolveInvocationPolicy,
  type CommandRoutes, type ComponentUnmet, type PlatformCapabilitiesV2, type PluginComponent,
} from '@lesliechan721/aw-plugin-core/manifest';

import type { PluginMeta } from '../types.js';
import type { DeploymentBinding, ProjectionResult, RenderUnit } from '../platforms/contracts.js';
import { toPlatformCapabilitiesView } from '../platforms/capabilities.js';
import { managedCommandRouteIsReachable } from '../generators/permissions.js';
import { isDeliveryCapabilityGap } from './component-gap.js';
import { artifactValueDigest } from './artifact-plan.js';
import { resolvePlatformComponentBatches } from './artifact-request.js';
import type { ResolvedArtifactRenderConfig } from './artifact-renderer.js';
import { calculatePluginBundleFingerprint } from './bundle-integrity.js';
import { readStaticComponentResourceInputs, resolvePlatformComponentResources, resolveStaticPlatformResourceRoot } from './component-resources.js';
import { assertSafeFileMutationPath, atomicReplaceSafeFile } from './safe-fs.js';
import { resolveAbsoluteAwHome } from './state-paths.js';
import { assertTestReadablePath, assertTestWritablePath } from './test-path-fence.js';
import { SKILL_OWNER_MARKER } from './ownership.js';
import { readPackageContentDigest } from './package-content.js';
import { INVOCATION_POLICY_NOT_APPLIED, isSkippedPermissionReason, safeComponentIdentity, safeSkippedPermissionActions,
  type PermissionAction } from '../output/component-delivery.js';
import type { Diagnostic } from '../output/public-result.js';

export interface PlatformInputEvidence {
  schemaVersion: 1;
  kind: 'aw-platform-input';
  plugin: DeploymentBinding['plugin'];
  platform: DeploymentBinding['platform'];
  binding: Pick<DeploymentBinding, 'id' | 'physicalKey' | 'scope'>;
  units: Array<Pick<RenderUnit, 'id' | 'physicalKey' | 'renderScope' | 'output' | 'kinds'> & { inputDigest: string }>;
}
interface PermissionNotice {
  field: string;
  reasonCode: string;
  skippedPermissionActions: PermissionAction[];
}
type PlatformDeliveryState = { permissionNotices?: PermissionNotice[] } & (
  { result: 'intentional-empty' }
  | { result: 'intentional-empty-package'; installedComponentIds: string[] }
  | { result: 'capability-gaps'; gaps: ComponentUnmet[]; installedComponentIds: string[] }
);
export type PlatformEmptyState = Omit<PlatformInputEvidence, 'kind'> & { kind: 'aw-platform-empty-state' } & PlatformDeliveryState;

/** Keep only the declaration label and fixed tokens needed for the next status read. */
export function platformPermissionNotices(diagnostics: readonly Diagnostic[]): PermissionNotice[] {
  const notices = diagnostics.flatMap(({ code, subject, detail }) => {
    const field = subject?.field;
    const reasonCode = detail?.reasonCode;
    const skippedPermissionActions = safeSkippedPermissionActions(detail?.skippedPermissionActions);
    return code === INVOCATION_POLICY_NOT_APPLIED && field && safeComponentIdentity(field) === field
      && reasonCode && isSkippedPermissionReason(reasonCode) && skippedPermissionActions.length
      ? [{ field, reasonCode, skippedPermissionActions }] : [];
  });
  return [...new Map(notices.map((notice) => [JSON.stringify(notice), notice])).values()];
}

export interface PlatformInputEvidenceOptions {
  plugin: PluginMeta;
  binding: DeploymentBinding;
  commandRoutes?: CommandRoutes;
  units: Array<{
    renderUnit: RenderUnit;
    capabilities: PlatformCapabilitiesV2;
    config: ResolvedArtifactRenderConfig;
  }>;
}

function staticCapabilityInputs(components: readonly PluginComponent[], capabilities: PlatformCapabilitiesV2): unknown {
  const { deliveryFeatures } = capabilities;
  return components.map((component) => {
    const kind = capabilities.kinds[component.kind];
    const features = getComponentFeatureRequirements(component, { deliveryOnly: true })
      .filter(({ feature }) => !deliveryFeatures || feature !== `component.kind.${component.kind}`)
      .map(({ feature, values }) => {
        const maxBytes = component.kind === 'instruction' && feature === 'instruction.coverage'
          && ['codex', 'claude'].includes(capabilities.platform) ? capabilities.features[feature]?.maxBytes : undefined;
        // The writer handles a component's own fields. Cross-kind requirements still depend on the host.
        if (deliveryFeatures && feature.startsWith(`${component.kind}.`)) {
          const mapping = deliveryFeatures.find((entry) => entry.feature === feature);
          const delivery = mapping ? { values: values?.filter((value) => mapping.values?.includes(value)) } : null;
          return { feature, delivery, maxBytes };
        }
        const fact = getPlatformCapabilityFact(feature, capabilities);
        return { feature, status: fact.status, reasonCodes: fact.reasonCodes,
          ...(values ? { values: (fact.values ?? []).filter((value) => values.includes(value)) } : {}), maxBytes };
      });
    return { id: component.id, kind: deliveryFeatures ? { delivery: kind.delivery } : kind, features };
  });
}

/** Currentness evidence only. This state never grants ownership or removal rights. */
export async function createPlatformInputEvidence(input: PlatformInputEvidenceOptions): Promise<PlatformInputEvidence> {
  const { plugin, binding } = input;
  const { platform } = binding;
  const { manifest } = plugin;
  if (platform === 'generic' || plugin.pluginId !== binding.plugin.pluginId
    || plugin.sourceIdentity !== binding.plugin.sourceIdentity || plugin.manifest.version !== binding.plugin.version
    || new Set(input.units.map(({ renderUnit }) => renderUnit.id)).size !== input.units.length
    || input.units.length !== binding.renderUnitIds.length
    || binding.renderUnitIds.some((id) => !input.units.some(({ renderUnit }) => renderUnit.id === id))) {
    throw new Error('platformEmptyStateIdentityInvalid');
  }
  const commandApplies = manifest.command?.platforms.includes(platform);
  const commandRoutes = input.commandRoutes ?? null;
  const staticResourceRoot = await resolveStaticPlatformResourceRoot(plugin.rootDir, platform);
  const prepared = await Promise.all(input.units.map(async ({ renderUnit, capabilities, config }) => {
    if (capabilities.platform !== platform || capabilities.scope !== renderUnit.renderScope.kind
      || config.targetScope !== renderUnit.renderScope.kind) throw new Error('platformEmptyStateUnitInvalid');
    const { renderScope, kinds } = renderUnit;
    const capabilityView = toPlatformCapabilitiesView(capabilities);
    const batches = resolvePlatformComponentBatches({ manifest, platform, renderScope: renderScope.kind, kinds, config });
    const declared = await normalizeStaticPluginComponents({ pluginRoot: plugin.rootDir, staticResourceRoot, manifest, platform,
      capabilities: capabilityView, allowedOutputKinds: kinds, deferPartition: true });
    const expected = partitionStaticPluginComponents(declared.components, capabilityView);
    if (batches.some((batch) => batch.config.issues.length)) throw new Error('platformEmptyStateConfigInvalid');
    return { renderUnit, capabilityView, declared, expected, batches };
  }));
  // A running renderer can read its bundle via AW_PLUGIN_ROOT, in addition to the declared resource roots.
  const sourceDigest = prepared.some(({ batches }) => batches.length) ? await calculatePluginBundleFingerprint(plugin.rootDir) : undefined;
  const resources = prepared.some(({ batches }) => batches.length)
    ? (await resolvePlatformComponentResources(plugin)).map(({ kind, name, digest }) => ({ kind, name, digest })) : undefined;
  const units = await Promise.all(prepared.map(async ({ renderUnit, capabilityView, declared, expected, batches }) => {
    const { id, physicalKey, renderScope, output, kinds } = renderUnit;
    const dynamic = batches.length ? { sourceDigest, manifest, batches, capabilities: capabilityView, resources } : undefined;
    const staticResources = await readStaticComponentResourceInputs({ plugin, expected: declared, staticResourceRoot, capabilities: capabilityView });
    const instructionUnit = platform === 'grok' && output === 'package'
      && (expected.components.some(({ kind }) => kind === 'agent') || batches.some((batch) => batch.allowedOutputKinds.includes('agent')))
      ? prepared.find(({ renderUnit: unit }) => unit.output === 'supplement'
        && artifactValueDigest(unit.renderScope) === artifactValueDigest(renderScope)) : undefined;
    const instructions = instructionUnit?.declared.components.filter((component) => component.kind === 'instruction'
      && component.content.coverage.includes('plugin-agents'));
    const instructionRenderer = instructionUnit?.batches.length ? { sourceDigest, manifest, resources,
      batches: instructionUnit.batches, capabilities: instructionUnit.capabilityView } : undefined;
    const invocationPolicy = output === 'package' ? resolveInvocationPolicy(manifest, platform, binding.plugin.pluginId) : undefined;
    const policy = invocationPolicy?.permissions;
    const hasSkills = expected.components.some((component) => component.kind === 'skill');
    // Host delivery depends on the applied reachability, even when the declarations have stayed the same.
    const commandSkillAvailable = commandApplies && (hasSkills || batches.some((batch) => batch.allowedOutputKinds.includes('skill')))
      ? managedCommandRouteIsReachable(commandRoutes, []) : undefined;
    const commandPermissions = commandApplies ? policy?.flatMap(({ allow, sandbox }) =>
      [...(allow ?? []), ...(sandbox?.excludedCommands ?? [])].flatMap((rule) =>
        typeof rule === 'string' ? [] : [managedCommandRouteIsReachable(commandRoutes, rule.argsPrefix)])) : undefined;
    return { id, physicalKey, renderScope, output, kinds: [...kinds],
      inputDigest: artifactValueDigest({ plugin: binding.plugin, platform, route: binding.route, renderScope, dynamic, declared, expected,
        capabilities: staticCapabilityInputs(declared.components, capabilityView), staticResources, instructions, instructionRenderer, policy,
        ...(hasSkills ? { requires: manifest.requires?.aw, nativeTools: manifest.nativeTools } : {}),
        invocationSelector: invocationPolicy?.invocationSelector, commandSkillAvailable, commandPermissions }) };
  }));
  units.sort((left, right) => left.id.localeCompare(right.id));
  return { schemaVersion: 1, kind: 'aw-platform-input', plugin: { ...binding.plugin }, platform: binding.platform,
    binding: { id: binding.id, physicalKey: binding.physicalKey, scope: binding.scope }, units };
}

export async function createPlatformEmptyState(input: PlatformInputEvidenceOptions): Promise<PlatformEmptyState> {
  return { ...await createPlatformInputEvidence(input), kind: 'aw-platform-empty-state', result: 'intentional-empty' };
}

/** A package is shared by activation scopes; scope-local supplements are checked separately. */
export function platformPackageInputDigest(evidence: PlatformInputEvidence, components: Readonly<ProjectionResult['components']> = []): string {
  const units = evidence.units.filter((unit) => unit.output === 'package');
  if (units.length !== 1) throw new Error('platformPackageInputInvalid');
  // OpenCode packages generated with only location need a refresh before they can provide Skills on newer V2 hosts.
  const openCodeSkills = evidence.platform === 'opencode' && components.some(({ nativeName, relativeOutputs }) =>
    relativeOutputs.includes(`skills/${nativeName}/SKILL.md`));
  return artifactValueDigest({ schemaVersion: evidence.schemaVersion, kind: evidence.kind,
    plugin: evidence.plugin, platform: evidence.platform, units,
    ...(openCodeSkills ? { openCodeSkillRegistration: 'location-and-path' } : {}) });
}

export function readPlatformPackageContentDigest(root: string): Promise<string | undefined> {
  return readPackageContentDigest(root, SKILL_OWNER_MARKER);
}

function statePath(state: Pick<PlatformInputEvidence, 'platform' | 'binding'>, env?: NodeJS.ProcessEnv): { root: string; filePath: string } {
  if (!/^sha256:[0-9a-f]{64}$/u.test(state.binding.id) || state.platform === 'generic'
    || !/^[a-z][a-z0-9-]*$/u.test(state.platform)) throw new Error('platformEmptyStateIdentityInvalid');
  const root = resolveAbsoluteAwHome(env);
  return { root, filePath: path.join(root, 'platforms', state.platform, 'empty-state', `${state.binding.id.slice(7)}.json`) };
}

function storedState(state: PlatformEmptyState): PlatformEmptyState & { deliveryDigest?: string } {
  // Detect accidental edits to the delivered IDs or skipped declarations without rerunning a renderer.
  return state.result !== 'intentional-empty' || state.permissionNotices ? { ...state, deliveryDigest: artifactValueDigest(state) } : state;
}

/** Records only a verified delivery. This weak record grants no ownership. */
export async function writePlatformEmptyState(options: { state: PlatformEmptyState; env?: NodeJS.ProcessEnv }): Promise<void> {
  const { root, filePath } = statePath(options.state, options.env);
  assertTestWritablePath(filePath, 'platform empty state', 'Use an isolated AW_HOME for state writes.');
  if (await matchesPlatformEmptyState(options)) return;
  await atomicReplaceSafeFile({ filePath, allowedRoot: root, label: 'Platform empty state',
    content: `${JSON.stringify(storedState(options.state), null, 2)}\n` });
}

async function readState(state: Pick<PlatformInputEvidence, 'platform' | 'binding'>, env?: NodeJS.ProcessEnv): Promise<unknown> {
  const { root, filePath } = statePath(state, env);
  assertTestReadablePath(filePath, 'platform empty state', 'Use an isolated AW_HOME for state reads.');
  await assertSafeFileMutationPath({ filePath, allowedRoot: root, label: 'Platform empty state' });
  const stat = await fs.lstat(filePath);
  return stat.isFile() && stat.size <= 1024 * 1024 ? fs.readJson(filePath) : undefined;
}

/** Missing, damaged, stale or unreadable weak evidence leaves the expectation unconfirmed. */
export async function matchesPlatformEmptyState(options: { state: PlatformEmptyState; env?: NodeJS.ProcessEnv }): Promise<boolean> {
  try {
    const stored = await readState(options.state, options.env);
    return Boolean(stored && artifactValueDigest(stored) === artifactValueDigest(storedState(options.state)));
  } catch { return false; }
}

export async function readPlatformDeliveryState(options: { input: PlatformInputEvidence; env?: NodeJS.ProcessEnv }): Promise<PlatformDeliveryState | undefined> {
  try {
    const stored = await readState(options.input, options.env);
    if (!stored || typeof stored !== 'object') return;
    const { deliveryDigest, ...record } = stored as Record<string, unknown>;
    const { kind, result, gaps, installedComponentIds, permissionNotices, ...evidence } = record;
    if (kind !== 'aw-platform-empty-state' || (result !== 'capability-gaps' && result !== 'intentional-empty' && result !== 'intentional-empty-package')
      || artifactValueDigest({ ...evidence, kind: 'aw-platform-input' }) !== artifactValueDigest(options.input)) return;
    if (result !== 'intentional-empty' || permissionNotices !== undefined) {
      if (artifactValueDigest(record) !== deliveryDigest) return;
    } else if (deliveryDigest !== undefined) return;
    const notices: PermissionNotice[] = [];
    if (permissionNotices !== undefined) {
      if (!Array.isArray(permissionNotices) || !permissionNotices.length) return;
      for (const notice of permissionNotices) {
        if (!notice || typeof notice.field !== 'string' || safeComponentIdentity(notice.field) !== notice.field
          || typeof notice.reasonCode !== 'string' || !isSkippedPermissionReason(notice.reasonCode)) return;
        const skippedPermissionActions = safeSkippedPermissionActions(notice.skippedPermissionActions);
        if (!skippedPermissionActions.length || skippedPermissionActions.length !== notice.skippedPermissionActions.length) return;
        notices.push({ field: notice.field, reasonCode: notice.reasonCode, skippedPermissionActions });
      }
    }
    const noticeFields = notices.length ? { permissionNotices: notices } : {};
    if (result === 'intentional-empty') return gaps === undefined && installedComponentIds === undefined ? { result, ...noticeFields } : undefined;
    if (!Array.isArray(installedComponentIds) || !installedComponentIds.every((id) => typeof id === 'string' && id.length > 0)
      || new Set(installedComponentIds).size !== installedComponentIds.length) return;
    if (result === 'intentional-empty-package') {
      return gaps === undefined && installedComponentIds.length > 0
        && installedComponentIds.every((id, index) => index === 0 || installedComponentIds[index - 1] < id)
        ? { result, installedComponentIds, ...noticeFields } : undefined;
    }
    if (!Array.isArray(gaps) || !gaps.length && !notices.length) return;
    for (const gap of gaps) {
      if (!gap || typeof gap.id !== 'string' || !gap.id || !COMPONENT_KINDS.includes(gap.kind)
        || gap.name !== undefined && typeof gap.name !== 'string' || gap.componentId !== undefined && typeof gap.componentId !== 'string'
        || typeof gap.reasonCode !== 'string' || !Array.isArray(gap.requiredFeatures)) return;
      for (const feature of gap.requiredFeatures) assertFeatureRequirement(feature);
      if (!isDeliveryCapabilityGap(gap)) return;
    }
    return { result, gaps, installedComponentIds, ...noticeFields };
  } catch { return undefined; }
}
