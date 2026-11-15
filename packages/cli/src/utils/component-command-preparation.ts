import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import { computeCanonicalDirectoryDigest } from '@lesliechan721/agent-skill-eval';
import {
  createAwPluginRequirementsReceipt,
  createRuntimeConfigOrigin,
  COMMAND_PRODUCER_RECORD_FILE,
  getCommandPackageId,
  normalizeInstalledCommandProducer,
  parseManagedCommandPlaceholders,
  validatePortableSkillName,
  resolveInvocationPolicy,
  type ManagedCommandReference,
  type PluginComponent,
  type ProducerIdentity,
} from '@lesliechan721/aw-plugin-core/manifest';

import type { RenderUnit } from '../platforms/contracts.js';
import type { PlatformTarget, PluginMeta } from '../types.js';
import { artifactValueDigest } from './artifact-plan.js';
import type { PreparedPlatformComponents } from './artifact-renderer.js';
import { type DynamicSkillTree, writeDynamicSkillTree } from './dynamic-skill-tree.js';
import {
  createManagedCommandReferenceResolver,
  injectNativeToolClosureFiles,
  managedCommandProducerIdentity,
  prepareManagedCommandPackage,
  resolveSkillManagedCommandReferences,
  type ManagedCommandCandidate,
} from './managed-command-materialization.js';
import { prepareAgentCommandSets, resolveManagedCommandSkillProducers, type ManagedCommandSkillProducerResolution } from './managed-command-preparation.js';
import { readSafeOperationError } from './safe-operation-diagnostic.js';
import { injectInstalledRuntimeConfig } from './runtime-config.js';
import { validateRuntimeSkillClosure } from './runtime-skill-closure.js';

export interface FinalizedPlatformComponents {
  prepared: PreparedPlatformComponents;
  commandCandidates: ManagedCommandCandidate[];
  producerResolutions: ManagedCommandSkillProducerResolution[];
  commandResolver?: (reference: ManagedCommandReference) => string;
  skills: Array<{ componentId: string; resourceRoot: string; tree: DynamicSkillTree }>;
  cleanup(): Promise<void>;
}

/** Prepare command bindings and AW runtime files against one already computed component set. */
export async function finalizePlatformSkillProducers(options: {
  plugin: PluginMeta;
  plugins?: readonly PluginMeta[];
  platform: PlatformTarget;
  renderUnit: Pick<RenderUnit, 'physicalKey' | 'renderScope' | 'kinds'>;
  prepared: PreparedPlatformComponents;
  skillWorkRoot: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  scriptTimeoutMs?: number;
  /** An operation-owned cache. Its owner retains and cleans roots after every consumer completes. */
  packagePreparationCache?: Map<string, Promise<Awaited<ReturnType<typeof prepareManagedCommandPackage>>>>;
}): Promise<FinalizedPlatformComponents> {
  if (!options.renderUnit.kinds.includes('skill')) {
    return { prepared: options.prepared, commandCandidates: [], producerResolutions: [], skills: [], cleanup: async () => {} };
  }
  const skills: FinalizedPlatformComponents['skills'] = [];
  const cleanupPackages: Array<() => Promise<void>> = [];
  const commandCandidates: ManagedCommandCandidate[] = [];
  const producerResolutions: ManagedCommandSkillProducerResolution[] = [];
  const skillCandidates = new Map<string, ManagedCommandCandidate>();
  const unavailableProducers: ProducerIdentity[] = [];
  const blockedSkills = new Set<string>();
  const commandResources: Array<{ producer: ProducerIdentity; resourceRoot: string }> = [];
  try {
    for (const component of options.prepared.expected.components) {
      if (component.kind !== 'skill') continue;
      validatePortableSkillName(component.name, 'Skill component name');
      const files = options.prepared.resources.files.filter((file) => file.componentId === component.id);
      const tree: DynamicSkillTree = {
        skillKey: component.name,
        files: Object.fromEntries(files.map((file) => [file.path, Buffer.from(file.bytes)])),
        fileModes: Object.fromEntries(files.filter((file) => (file.mode ?? 0) & 0o111).map((file) => [file.path, 0o755 as const])),
      };
      const resourceRoot = path.join(options.skillWorkRoot, component.name);
      await writeDynamicSkillTree(resourceRoot, tree);
      skills.push({ componentId: component.id, resourceRoot, tree });
    }
    if (options.platform !== 'generic') {
      const resolved = await resolveManagedCommandSkillProducers({
        ...options,
        platform: options.platform,
        components: options.prepared.expected,
        skillResources: skills.map((skill) => ({ ...skill, physicalKey: options.renderUnit.physicalKey })),
        dynamicScopeOffered: options.plugin.manifest.artifacts?.scopes?.includes(options.renderUnit.renderScope.kind) ?? true,
      });
      producerResolutions.push(...resolved);
      for (const producer of resolved) {
        if (producer.state !== 'ready') {
          unavailableProducers.push(producer.producer);
          continue;
        }
        try {
          const candidate = await prepareAgentCommandSets({
            ...options, resolved: producer, referencePlugins: options.plugins,
          });
          commandCandidates.push(candidate);
          skillCandidates.set(producer.componentId, candidate);
          commandResources.push({ producer: candidate.producer, resourceRoot: candidate.resourceRoot });
        } catch (error) {
          options.signal?.throwIfAborted();
          if (readSafeOperationError(error)) throw error;
          producerResolutions[producerResolutions.indexOf(producer)] = { ...producer, state: 'failed',
            error: error instanceof Error ? error : new Error('commandReferenceInvalid: Skill command preparation failed.') };
          unavailableProducers.push(producer.producer);
          blockedSkills.add(producer.componentId);
        }
      }
    }
    const references = skills.filter((skill) => !blockedSkills.has(skill.componentId)).flatMap(({ tree }) => Object.entries(tree.files)
      .filter(([file]) => file.endsWith('.md'))
      .flatMap(([, bytes]) => parseManagedCommandPlaceholders(bytes.toString('utf8'))));
    if (references.length && !options.plugin.manifest.requires?.aw.capabilities?.includes('aw.managed-commands.v1')) {
      throw new Error('commandReferenceInvalid: Managed command references require aw.managed-commands.v1.');
    }
    if (references.length && options.platform === 'generic') {
      throw new Error('commandReferenceInvalid: Generic Skills cannot bind native managed commands.');
    }
    const permissions = resolveInvocationPolicy(options.plugin.manifest, options.platform).permissions;
    const permissionReferences = permissions.flatMap((permission) => [
      ...(permission.allow ?? []), ...(permission.ask ?? []), ...(permission.deny ?? []),
      ...(permission.sandbox?.excludedCommands ?? []),
    ]).flatMap((entry) => typeof entry === 'string' ? [] : [entry.command]);
    const referencedPackages = new Set([...references.map(({ reference }) => reference), ...permissionReferences].flatMap((reference) => {
      const set = options.plugin.manifest.managedCommands?.sets.find((set) => set.set === reference.set);
      if (!set) throw new Error('commandReferenceInvalid: The command set is not declared by this plugin.');
      return set.producer.kind === 'package' ? [set.producer.packageKey] : [];
    }));
    for (const packageKey of referencedPackages) {
      if (options.platform === 'generic') throw new Error('commandReferenceInvalid: Generic Skills cannot bind native command packages.');
      const declaration = options.plugin.manifest.managedCommands?.packages.find((entry) => entry.key === packageKey);
      if (!declaration?.platforms.includes(options.platform)
        || options.renderUnit.renderScope.kind === 'user' && declaration.scope === 'project') {
        throw new Error('commandReferenceInvalid: The command package is unavailable to this consumer.');
      }
      const identity = await managedCommandProducerIdentity({
        ...options, producer: { kind: 'package', packageKey }, scope: declaration.scope,
      });
      const cacheKey = getCommandPackageId(identity);
      let preparation = options.packagePreparationCache?.get(cacheKey);
      if (!preparation) {
        preparation = prepareManagedCommandPackage({
          ...options, referencePlugins: options.plugins, packageKey, scope: declaration.scope, event: 'materialize',
        });
        options.packagePreparationCache?.set(cacheKey, preparation);
      }
      const candidate = await preparation;
      if (!options.packagePreparationCache) cleanupPackages.push(candidate.cleanup);
      commandCandidates.push(candidate);
      commandResources.push({ producer: candidate.producer, resourceRoot: candidate.resourceRoot });
    }
    const skillReferences = new Map(skills.map((skill) => [skill.componentId, Object.entries(skill.tree.files)
      .filter(([file]) => file.endsWith('.md'))
      .flatMap(([, bytes]) => parseManagedCommandPlaceholders(bytes.toString('utf8')).map(({ reference }) => reference))]));
    let commandResolver: FinalizedPlatformComponents['commandResolver'];
    let changed: boolean;
    do {
      changed = false;
      commandResolver = options.platform === 'generic' ? undefined : await createManagedCommandReferenceResolver({
        ...options, platform: options.platform, scope: options.renderUnit.renderScope.kind, candidates: commandCandidates, unavailableProducers,
      });
      for (const skill of skills) {
        if (blockedSkills.has(skill.componentId) || !commandResolver) continue;
        try {
          for (const reference of skillReferences.get(skill.componentId) ?? []) commandResolver(reference);
        } catch (error) {
          blockedSkills.add(skill.componentId);
          changed = true;
          const candidate = skillCandidates.get(skill.componentId);
          if (!candidate) continue;
          commandCandidates.splice(commandCandidates.indexOf(candidate), 1);
          unavailableProducers.push(candidate.producer);
          const index = producerResolutions.findIndex((producer) => producer.componentId === skill.componentId);
          const producer = producerResolutions[index];
          if (producer) producerResolutions[index] = { ...producer, state: 'failed',
            error: error instanceof Error ? error : new Error('commandReferenceInvalid: A required command is unavailable.') };
        }
      }
    } while (changed);
    const retainedSkills = skills.filter((skill) => !blockedSkills.has(skill.componentId));
    if (commandResolver) for (const { tree } of retainedSkills) resolveSkillManagedCommandReferences(tree, commandResolver);
    const receipt = Buffer.from(`${JSON.stringify(createAwPluginRequirementsReceipt(
      { name: options.plugin.manifest.name, version: options.plugin.manifest.version },
      options.plugin.manifest.requires?.aw.capabilities ?? [],
    ), null, 2)}\n`);
    const components: PluginComponent[] = structuredClone(options.prepared.expected.components.filter((component) => !blockedSkills.has(component.id)));
    const unmet = [...options.prepared.expected.unmet,
      ...options.prepared.expected.components.filter((component) => blockedSkills.has(component.id))
        .map((component) => ({ id: component.id, kind: component.kind, name: component.name,
          requiredFeatures: [], reasonCode: 'dependency-unmet' }))];
    for (const skill of retainedSkills) {
      const commandCandidate = skillCandidates.get(skill.componentId);
      if (commandCandidate) {
        const nativeTools = injectNativeToolClosureFiles(skill.tree.files, commandCandidate.nativeTools);
        if (nativeTools) commandCandidate.nativeTools = nativeTools;
        const record = normalizeInstalledCommandProducer({ schemaVersion: 1,
          producer: commandCandidate.producer, sets: commandCandidate.sets,
          ...(nativeTools ? { nativeTools } : {}),
        });
        skill.tree.files[COMMAND_PRODUCER_RECORD_FILE] = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
      }
      skill.tree.files['aw-plugin-requirements.json'] = receipt;
      const snapshot = options.prepared.runtimeConfigSnapshots[skill.componentId];
      await injectInstalledRuntimeConfig(skill.tree, snapshot, snapshot ? { origin: createRuntimeConfigOrigin({
        snapshot, inputDigest: options.prepared.evidence.renderInputDigest,
      }) } : {});
      await fs.remove(skill.resourceRoot);
      await writeDynamicSkillTree(skill.resourceRoot, skill.tree);
      await validateRuntimeSkillClosure(skill.resourceRoot);
      const component = components.find((component) => component.id === skill.componentId);
      if (!component || component.kind !== 'skill') throw new Error('componentSkillIdentityChanged');
      component.content.files = Object.fromEntries(Object.keys(component.content.files).map((file) => {
        const bytes = skill.tree.files[file]!;
        const original = options.prepared.resources.files.find((entry) => entry.componentId === skill.componentId && entry.path === file);
        const resource = component.content.files[file];
        return [file, resource && original?.bytes.equals(bytes) ? resource : { text: bytes.toString('utf8') }];
      }));
    }
    const files = [
      ...options.prepared.resources.files.filter((file) => !skills.some((skill) => skill.componentId === file.componentId)),
      ...retainedSkills.flatMap((skill) => Object.entries(skill.tree.files).map(([file, bytes]) => {
        const original = options.prepared.resources.files.find((entry) => entry.componentId === skill.componentId && entry.path === file);
        return {
          componentId: skill.componentId, path: file, bytes,
          ...(original?.source && original.bytes.equals(bytes) ? { source: original.source } : {}),
          mode: skill.tree.fileModes?.[file] ?? 0o644,
        };
      })),
    ];
    const resourceDigest = artifactValueDigest({ inputDigest: options.prepared.resources.digest, files: files.map(({ componentId, path: file, bytes, mode }) => ({
      componentId, path: file, digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`, mode,
    })) });
    const commands = await Promise.all(commandResources.filter((entry) => commandCandidates.some((candidate) => candidate.producer === entry.producer)).map(async (entry) => ({
      producer: entry.producer,
      resourceDigest: await computeCanonicalDirectoryDigest(entry.resourceRoot),
      sets: commandCandidates.find((candidate) => candidate.producer === entry.producer)?.sets ?? [],
      nativeTools: commandCandidates.find((candidate) => candidate.producer === entry.producer)?.nativeTools,
    })));
    const prepared: PreparedPlatformComponents = {
      ...options.prepared,
      expected: { ...options.prepared.expected, components, unmet },
      empty: components.length ? null : unmet.length ? 'unmet' : 'intentional',
      resources: { ...options.prepared.resources, files, digest: resourceDigest },
      evidence: { ...options.prepared.evidence, resourceDigest,
        renderInputDigest: artifactValueDigest({ components: options.prepared.evidence.renderInputDigest, commands, unavailableProducers }),
      },
    };
    return { prepared, skills: retainedSkills, commandCandidates, producerResolutions, ...(commandResolver ? { commandResolver } : {}), cleanup: async () => { await Promise.all(cleanupPackages.map((cleanup) => cleanup())); } };
  } catch (error) {
    await Promise.all(cleanupPackages.map((cleanup) => cleanup()));
    throw error;
  }
}
