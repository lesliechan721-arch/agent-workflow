import path from 'node:path';
import fs from 'fs-extra';
import {
  assertFeatureRequirement, COMPONENT_KINDS, getComponentFeatureRequirements, getPlatformCapabilityFact, normalizeStaticPluginComponents, partitionStaticPluginComponents, resolveInvocationPolicy,
  type ComponentUnmet, type ExpectedComponentSet, type FeatureRequirement, type PlatformCapabilitiesV2,
} from '@lesliechan721/aw-plugin-core/manifest';

import type { PluginMeta } from '../types.js';
import type { DeploymentBinding, RenderUnit } from '../platforms/contracts.js';
import { toPlatformCapabilitiesView } from '../platforms/capabilities.js';
import { isDeliveryCapabilityGap } from './component-gap.js';
import { artifactValueDigest } from './artifact-plan.js';
import { resolvePlatformComponentBatches, selectPlatformRenderConfig } from './artifact-request.js';
import type { ResolvedArtifactRenderConfig } from './artifact-renderer.js';
import { calculatePluginBundleFingerprint } from './bundle-integrity.js';
import { readStaticComponentResourceInputs, resolvePlatformComponentResources, resolveStaticPlatformResourceRoot } from './component-resources.js';
import { assertSafeFileMutationPath, atomicReplaceSafeFile } from './safe-fs.js';
import { resolveAbsoluteAwHome } from './state-paths.js';
import { assertTestReadablePath, assertTestWritablePath } from './test-path-fence.js';
import { SKILL_OWNER_MARKER } from './ownership.js';
import { createDynamicSkillTreeContentDigest } from './dynamic-skill-tree.js';

export interface PlatformInputEvidence {
  schemaVersion: 1;
  kind: 'aw-platform-input';
  plugin: DeploymentBinding['plugin'];
  platform: DeploymentBinding['platform'];
  binding: Pick<DeploymentBinding, 'id' | 'physicalKey' | 'scope'>;
  units: Array<Pick<RenderUnit, 'id' | 'physicalKey' | 'renderScope' | 'output' | 'kinds'> & { inputDigest: string }>;
}
export interface PlatformDeliveryGaps {
  gaps: ComponentUnmet[];
  installedComponentIds: string[];
}
export type PlatformEmptyState = Omit<PlatformInputEvidence, 'kind'> & { kind: 'aw-platform-empty-state' } & (
  { result: 'intentional-empty' } | ({ result: 'capability-gaps' } & PlatformDeliveryGaps)
);

export interface PlatformInputEvidenceOptions {
  plugin: PluginMeta;
  binding: DeploymentBinding;
  units: Array<{
    renderUnit: RenderUnit;
    capabilities: PlatformCapabilitiesV2;
    config: ResolvedArtifactRenderConfig;
  }>;
}

function staticCapabilityInputs(expected: ExpectedComponentSet, capabilities: PlatformCapabilitiesV2): unknown {
  const usedFeatures = (requirements: readonly FeatureRequirement[]) => requirements.map(({ feature, values }) => {
    const fact = getPlatformCapabilityFact(feature, capabilities);
    const mapping = capabilities.deliveryFeatures?.find((entry) => entry.feature === feature);
    return { feature, status: fact.status, reasonCodes: fact.reasonCodes,
      ...(capabilities.deliveryFeatures ? { delivery: mapping
        ? { ...(values ? { values: values.filter((value) => mapping.values?.includes(value)) } : {}) } : null } : {}),
      ...(values ? { values: (fact.values ?? []).filter((value) => values.includes(value)) } : {}),
      ...(feature === 'instruction.coverage' && ['codex', 'claude'].includes(capabilities.platform) ? { maxBytes: fact.maxBytes } : {}) };
  });
  return [
    ...expected.components.map((component) => ({ id: component.id, kind: capabilities.kinds[component.kind],
      features: usedFeatures(getComponentFeatureRequirements(component)) })),
    ...expected.unmet.map((gap) => ({ id: gap.id, kind: capabilities.kinds[gap.kind],
      features: usedFeatures(gap.requiredFeatures) })),
  ];
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
    const skillRender = batches.some((batch) => batch.allowedOutputKinds.includes('skill'));
    const commandSets = kinds.includes('skill') ? (manifest.managedCommands?.sets ?? []).filter(({ producer }) =>
      producer.kind !== 'package' && producer.platform === platform && (producer.kind === 'static-skill' || skillRender)) : [];
    const commandKeys = [...new Set(commandSets.flatMap((set) => set.mode === 'dynamic' ? set.refreshKeys : []))].sort();
    const commandConfig = commandKeys.length ? selectPlatformRenderConfig({ resolved: config, keys: commandKeys, nonSensitive: true }) : undefined;
    if (batches.some((batch) => batch.config.issues.length) || commandConfig?.issues.length) throw new Error('platformEmptyStateConfigInvalid');
    return { renderUnit, capabilityView, declared, expected, batches, commandSets, commandConfig };
  }));
  // A running renderer can read its bundle via AW_PLUGIN_ROOT, in addition to the declared resource roots.
  const sourceDigest = prepared.some(({ batches, commandSets }) => batches.length || commandSets.some((set) => set.mode === 'dynamic'))
    ? await calculatePluginBundleFingerprint(plugin.rootDir) : undefined;
  const resources = prepared.some(({ batches }) => batches.length)
    ? (await resolvePlatformComponentResources(plugin)).map(({ kind, name, digest }) => ({ kind, name, digest })) : undefined;
  const units = await Promise.all(prepared.map(async ({ renderUnit, capabilityView, declared, expected, batches, commandSets, commandConfig }) => {
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
    const policy = output === 'package' ? resolveInvocationPolicy(manifest, platform).permissions : undefined;
    const hasSkills = expected.components.some((component) => component.kind === 'skill');
    return { id, physicalKey, renderScope, output, kinds: [...kinds],
      inputDigest: artifactValueDigest({ plugin: binding.plugin, platform, route: binding.route, renderScope, dynamic, declared, expected,
        capabilities: staticCapabilityInputs(declared, capabilityView), staticResources, instructions, instructionRenderer, policy,
        ...(hasSkills ? { requires: manifest.requires?.aw, nativeTools: manifest.nativeTools } : {}),
        ...(commandSets.length ? { commandSets, commandConfig,
          commandRendererSource: commandSets.some((set) => set.mode === 'dynamic') ? sourceDigest : undefined } : {}) }) };
  }));
  units.sort((left, right) => left.id.localeCompare(right.id));
  return { schemaVersion: 1, kind: 'aw-platform-input', plugin: { ...binding.plugin }, platform: binding.platform,
    binding: { id: binding.id, physicalKey: binding.physicalKey, scope: binding.scope }, units };
}

export async function createPlatformEmptyState(input: PlatformInputEvidenceOptions): Promise<PlatformEmptyState> {
  return { ...await createPlatformInputEvidence(input), kind: 'aw-platform-empty-state', result: 'intentional-empty' };
}

/** A package is shared by activation scopes; scope-local supplements are checked separately. */
export function platformPackageInputDigest(evidence: PlatformInputEvidence): string {
  const units = evidence.units.filter((unit) => unit.output === 'package');
  if (units.length !== 1) throw new Error('platformPackageInputInvalid');
  return artifactValueDigest({ schemaVersion: evidence.schemaVersion, kind: evidence.kind,
    plugin: evidence.plugin, platform: evidence.platform, units });
}

export async function readPlatformPackageContentDigest(root: string): Promise<string | undefined> {
  const stat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return undefined;
  const files: Record<string, Buffer> = {};
  const fileModes: Record<string, 0o755> = {};
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative === SKILL_OWNER_MARKER) continue;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) throw new Error('platformContentInvalid');
      if (entry.isDirectory()) await visit(file, relative);
      else { files[relative] = await fs.readFile(file); if ((await fs.stat(file)).mode & 0o111) fileModes[relative] = 0o755; }
    }
  }
  await visit(root, '');
  return createDynamicSkillTreeContentDigest({ skillKey: '', files, fileModes });
}

function statePath(state: Pick<PlatformInputEvidence, 'platform' | 'binding'>, env?: NodeJS.ProcessEnv): { root: string; filePath: string } {
  if (!/^sha256:[0-9a-f]{64}$/u.test(state.binding.id) || state.platform === 'generic'
    || !/^[a-z][a-z0-9-]*$/u.test(state.platform)) throw new Error('platformEmptyStateIdentityInvalid');
  const root = resolveAbsoluteAwHome(env);
  return { root, filePath: path.join(root, 'platforms', state.platform, 'empty-state', `${state.binding.id.slice(7)}.json`) };
}

function storedState(state: PlatformEmptyState): PlatformEmptyState & { deliveryDigest?: string } {
  // Detect accidental edits to the delivered IDs or skipped declarations without rerunning a renderer.
  return state.result === 'capability-gaps' ? { ...state, deliveryDigest: artifactValueDigest(state) } : state;
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

export async function readPlatformDeliveryGaps(options: { input: PlatformInputEvidence; env?: NodeJS.ProcessEnv }): Promise<PlatformDeliveryGaps | undefined> {
  try {
    const stored = await readState(options.input, options.env);
    if (!stored || typeof stored !== 'object') return;
    const { deliveryDigest, ...record } = stored as Record<string, unknown>;
    const { kind, result, gaps, installedComponentIds, ...evidence } = record;
    if (kind !== 'aw-platform-empty-state' || result !== 'capability-gaps' || artifactValueDigest(record) !== deliveryDigest
      || artifactValueDigest({ ...evidence, kind: 'aw-platform-input' }) !== artifactValueDigest(options.input)
      || !Array.isArray(installedComponentIds) || !installedComponentIds.every((id) => typeof id === 'string' && id.length > 0)
      || new Set(installedComponentIds).size !== installedComponentIds.length || !Array.isArray(gaps) || !gaps.length) return;
    for (const gap of gaps) {
      if (!gap || typeof gap.id !== 'string' || !gap.id || !COMPONENT_KINDS.includes(gap.kind)
        || gap.name !== undefined && typeof gap.name !== 'string' || gap.componentId !== undefined && typeof gap.componentId !== 'string'
        || typeof gap.reasonCode !== 'string' || !Array.isArray(gap.requiredFeatures)) return;
      for (const feature of gap.requiredFeatures) assertFeatureRequirement(feature);
      if (!isDeliveryCapabilityGap(gap)) return;
    }
    return { gaps, installedComponentIds };
  } catch { return undefined; }
}
