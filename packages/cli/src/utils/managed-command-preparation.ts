import path from 'node:path';

import fs from 'fs-extra';
import {
  assertAgentCommandContext,
  canonicalizeIdentityValue,
  getCommandPackageId,
  normalizeCommandSetArtifact,
  validateCommandEntryFiles,
  type AgentCommandContextV1,
  type CommandSetArtifact,
  type ExpectedComponentSet,
  type InstalledCommandProducer,
  type ManagedCommandProducerRef,
  type ManagedCommandSet,
  type PlatformId,
  type ProducerIdentity,
} from '@lesliechan721/aw-plugin-core/manifest';

import type { RenderUnit } from '../platforms/contracts.js';
import type { PluginMeta } from '../types.js';
import { selectPlatformRenderConfig } from './artifact-request.js';
import { resolveArtifactRenderConfig, runPreparedArtifactRenderer, type ArtifactRenderEvent } from './artifact-renderer.js';
import {
  managedCommandProducerIdentity,
  nativeToolsForCommandSets,
  type ManagedCommandCandidate,
} from './managed-command-materialization.js';
import { ManagedCommandError, validateManagedCommandResource, type InstalledCommandSet } from './managed-command-store.js';
import { collectSensitivePluginConfigValues } from './plugin-scripts.js';

type SkillProducerRef = Exclude<ManagedCommandProducerRef, { kind: 'package' }>;
type NativePlatform = Exclude<PlatformId, 'generic'>;
interface SkillProducerBase {
  producer: ProducerIdentity;
  producerRef: SkillProducerRef;
  componentId: string;
  sets: ManagedCommandSet[];
}
export interface ReadyManagedCommandSkillProducer extends SkillProducerBase {
  state: 'ready';
  resourceRoot: string;
}
export type ManagedCommandSkillProducerResolution = ReadyManagedCommandSkillProducer
  | (SkillProducerBase & { state: 'omitted'; reason: 'not-offered' | 'config-disabled' | 'scope-excluded' })
  | (SkillProducerBase & { state: 'unmet'; reasonCode: string })
  | (SkillProducerBase & { state: 'failed'; error: Error });

function producerRefKey(producer: SkillProducerRef): string {
  return `${producer.kind}/${producer.platform}/${producer.kind === 'artifact' ? producer.artifactId : producer.skillKey}`;
}

/** Resolve only the current complete component set and its verified physical candidates. */
export async function resolveManagedCommandSkillProducers(options: {
  plugin: PluginMeta;
  platform: NativePlatform;
  renderUnit: Pick<RenderUnit, 'physicalKey' | 'renderScope'>;
  components: ExpectedComponentSet;
  skillResources: readonly { componentId: string; resourceRoot: string; physicalKey: string }[];
  dynamicScopeOffered?: boolean;
  cwd: string;
}): Promise<ManagedCommandSkillProducerResolution[]> {
  const groups = new Map<string, { producerRef: SkillProducerRef; sets: ManagedCommandSet[] }>();
  for (const set of options.plugin.manifest.managedCommands?.sets ?? []) {
    if (set.producer.kind === 'package' || set.producer.platform !== options.platform) continue;
    const key = producerRefKey(set.producer);
    const group = groups.get(key) ?? { producerRef: set.producer, sets: [] };
    group.sets.push(set);
    groups.set(key, group);
  }
  const results: ManagedCommandSkillProducerResolution[] = [];
  for (const { producerRef, sets } of groups.values()) {
    const producer = await managedCommandProducerIdentity({ ...options, scope: options.renderUnit.renderScope.kind, producer: producerRef });
    const componentId = producerRef.kind === 'artifact' ? producerRef.artifactId : `skill:${producerRef.skillKey}`;
    const base = { producer, producerRef, componentId, sets };
    try {
      const scopes = options.plugin.manifest.artifacts?.scopes;
      if (producerRef.kind === 'artifact' && (options.dynamicScopeOffered === false
        || scopes !== undefined && !scopes.includes(options.renderUnit.renderScope.kind))) {
        results.push({ ...base, state: 'omitted', reason: 'scope-excluded' });
        continue;
      }
      const components = options.components.components.filter((component) => component.id === componentId);
      const omitted = options.components.omitted.filter((component) => component.id === componentId);
      const unmet = options.components.unmet.filter((component) => component.id === componentId);
      if (components.length + omitted.length + unmet.length !== 1) throw new Error('commandReferenceInvalid: the current complete component set must identify exactly one Skill producer or its explicit unavailable state.');
      const component = components[0] ?? omitted[0] ?? unmet[0]!;
      if (component.kind !== 'skill') throw new Error('commandReferenceInvalid: the command producer component is not a Skill.');
      const expectedSource = producerRef.kind === 'artifact' ? 'dynamic' : 'static';
      if (options.components.sources[componentId] !== expectedSource) throw new Error('commandReferenceInvalid: the command producer component has another source owner.');
      if (omitted[0]) {
        results.push({ ...base, state: 'omitted', reason: omitted[0].reason });
        continue;
      }
      if (unmet[0]) {
        results.push({ ...base, state: 'unmet', reasonCode: unmet[0].reasonCode });
        continue;
      }
      const resources = options.skillResources.filter((resource) => resource.componentId === componentId);
      if (resources.length !== 1 || resources[0]!.physicalKey !== producer.placementKey) throw new Error('commandReferenceInvalid: the Skill resource does not belong to this exact physical producer.');
      const resourceRoot = path.resolve(resources[0]!.resourceRoot);
      await validateManagedCommandResource(resourceRoot);
      const skill = await fs.lstat(path.join(resourceRoot, 'SKILL.md'));
      if (!skill.isFile() || skill.isSymbolicLink()) throw new Error('commandReferenceInvalid: the Skill candidate has no regular SKILL.md.');
      results.push({ ...base, state: 'ready', resourceRoot });
    } catch (error) {
      results.push({ ...base, state: 'failed', error: error instanceof Error ? error : new Error('commandReferenceInvalid: the Skill producer could not be prepared.') });
    }
  }
  return results;
}

export function validateAgentCommandPlan(options: {
  plan: unknown;
  context: AgentCommandContextV1;
  sets: readonly ManagedCommandSet[];
}): CommandSetArtifact[] {
  assertAgentCommandContext(options.context);
  const plan = options.plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
    || Object.keys(plan).some((key) => !['version', 'artifacts'].includes(key))
    || !('version' in plan) || plan.version !== 2 || !('artifacts' in plan) || !Array.isArray(plan.artifacts)) {
    throw new ManagedCommandError('commandDefinitionInvalid', 'The agent command renderer must return one v2 command set plan.');
  }
  const requested = new Set(options.context.requestedArtifactIds);
  const seen = new Set<string>();
  const artifacts = plan.artifacts.map((value, index) => {
    const artifact = normalizeCommandSetArtifact(value, `agent command artifacts[${index}]`);
    const set = options.sets.find((set) => set.mode === 'dynamic' && `command-set.${set.set}` === artifact.id);
    if (!requested.has(artifact.id) || seen.has(artifact.id) || !set || set.mode !== 'dynamic'
      || artifact.platform !== options.context.platform || JSON.stringify(artifact.refreshKeys) !== JSON.stringify(set.refreshKeys)) {
      throw new ManagedCommandError('commandDefinitionInvalid', 'The agent command output must match each requested ID, platform, and refresh key list exactly.');
    }
    seen.add(artifact.id);
    return artifact;
  });
  if (seen.size !== requested.size) throw new ManagedCommandError('commandDefinitionInvalid', 'The agent command output omitted a requested command set.');
  return artifacts;
}

export async function prepareAgentCommandSets(options: {
  plugin: PluginMeta;
  resolved: ReadyManagedCommandSkillProducer;
  referencePlugins?: readonly PluginMeta[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  event?: ArtifactRenderEvent;
  changedConfigKeys?: string[];
  previousProducer?: { record: InstalledCommandProducer; artifacts: readonly CommandSetArtifact[] };
  signal?: AbortSignal;
  scriptTimeoutMs?: number;
}): Promise<ManagedCommandCandidate & { resourceRoot: string; artifacts: CommandSetArtifact[] }> {
  options.signal?.throwIfAborted();
  const { resolved } = options;
  if (resolved.producer.platform === null || !resolved.producer.placementKey) throw new ManagedCommandError('commandReferenceInvalid', 'Agent command sets require a concrete native Skill producer.');
  if (options.previousProducer && getCommandPackageId(options.previousProducer.record.producer) !== getCommandPackageId(resolved.producer)) throw new ManagedCommandError('commandIdentityConflict', 'Previous command artifacts belong to another physical producer.');
  await validateManagedCommandResource(resolved.resourceRoot);
  const dynamicSets = resolved.sets.filter((set) => set.mode === 'dynamic');
  let artifacts: CommandSetArtifact[] = [];
  if (dynamicSets.length > 0) {
    const config = await resolveArtifactRenderConfig({
      pluginName: options.plugin.manifest.name, manifest: options.plugin.manifest, platform: resolved.producer.platform,
      sourceId: options.plugin.sourceId, sourceIdentity: options.plugin.sourceIdentity, logicalIdentity: options.plugin.catalogLogicalIdentity,
      scope: resolved.producer.scope, cwd: resolved.producer.projectRoot ?? options.cwd, env: options.env, referencePlugins: options.referencePlugins,
    });
    const requestedArtifactIds = dynamicSets.map((set) => `command-set.${set.set}`);
    const previousArtifacts = (options.previousProducer?.artifacts ?? []).filter((artifact) => requestedArtifactIds.includes(artifact.id)).map((artifact) => normalizeCommandSetArtifact(artifact));
    if (previousArtifacts.some((artifact) => artifact.platform !== resolved.producer.platform)) throw new ManagedCommandError('commandIdentityConflict', 'Previous command artifacts identify another platform.');
    for (const artifact of previousArtifacts) {
      const installed = options.previousProducer!.record.sets.find((set) => `command-set.${set.set}` === artifact.id);
      if (!installed || installed.state !== artifact.state || canonicalizeIdentityValue(installed.entries) !== canonicalizeIdentityValue(artifact.entries)) throw new ManagedCommandError('commandIdentityConflict', 'Previous command artifacts do not match their verified producer record.');
    }
    const context: AgentCommandContextV1 = {
      schemaVersion: 1, surface: 'agent-commands', platform: resolved.producer.platform, scope: resolved.producer.scope,
      plugin: { pluginId: `${resolved.producer.sourceId}/${resolved.producer.pluginName}`, name: options.plugin.manifest.name, version: options.plugin.manifest.version },
      config: selectPlatformRenderConfig({ resolved: config, keys: [...new Set(dynamicSets.flatMap((set) => set.refreshKeys))], nonSensitive: true }),
      changedConfigKeys: [], requestedArtifactIds, previousArtifacts,
      producers: dynamicSets.map((set) => ({ set: set.set, componentId: resolved.componentId, resourceRoot: resolved.resourceRoot })),
    };
    context.changedConfigKeys = (options.changedConfigKeys ?? []).filter((key) => Object.hasOwn(context.config.schema.fields, key));
    assertAgentCommandContext(context);
    if (context.config.issues.length > 0) throw new ManagedCommandError('commandDefinitionInvalid', 'Resolve the command set configuration issues before preparing its producer.');
    const rendered = await runPreparedArtifactRenderer({ plugin: options.plugin, context, sensitiveValues: collectSensitivePluginConfigValues(options.plugin.manifest, config.values, resolved.producer.platform), cwd: options.cwd, commandEnv: options.env, event: options.event, scriptTimeoutMs: options.scriptTimeoutMs, signal: options.signal });
    artifacts = validateAgentCommandPlan({ plan: rendered.value, context, sets: resolved.sets });
  }
  const sets: InstalledCommandSet[] = resolved.sets.map((set) => {
    if (set.mode === 'static') return { set: set.set, state: 'present', entries: set.entries };
    const artifact = artifacts.find((artifact) => artifact.id === `command-set.${set.set}`)!;
    return { set: set.set, state: artifact.state, entries: artifact.entries };
  });
  await validateCommandEntryFiles(resolved.resourceRoot, sets.flatMap((set) => set.entries));
  for (const set of sets) for (const entry of set.entries) await validateManagedCommandResource(resolved.resourceRoot, entry);
  const nativeTools = await nativeToolsForCommandSets(options.plugin, sets);
  return { producer: resolved.producer, resourceRoot: resolved.resourceRoot, sets, artifacts, ...(nativeTools ? { nativeTools } : {}) };
}
