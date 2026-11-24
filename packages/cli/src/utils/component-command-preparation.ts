import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import {
  assertManagedCommandPlatform,
  createAwPluginRequirementsReceipt,
  createRuntimeConfigOrigin,
  parseManagedCommandPlaceholders,
  replaceManagedCommandPlaceholders,
  resolveInvocationPolicy,
  validatePortableSkillName,
  type InstalledCommandProducer,
  type PluginComponent,
} from '@lesliechan721/aw-plugin-core/manifest';

import { managedCommandRouteIsReachable, selectPlatformInvocationPolicy } from '../generators/permissions.js';
import { COMMAND_ROUTE_UNREACHABLE } from '../output/component-delivery.js';
import type { RenderUnit } from '../platforms/contracts.js';
import type { PlatformTarget, PluginMeta } from '../types.js';
import { artifactValueDigest } from './artifact-plan.js';
import type { PreparedPlatformComponents } from './artifact-renderer.js';
import { type DynamicSkillTree, writeDynamicSkillTree } from './dynamic-skill-tree.js';
import { managedCommandProducerIdentity, prepareManagedCommandPackage } from './managed-command-materialization.js';
import { injectInstalledRuntimeConfig } from './runtime-config.js';
import { validateRuntimeSkillClosure } from './runtime-skill-closure.js';

export interface FinalizedPlatformComponents {
  prepared: PreparedPlatformComponents;
  invocationPolicy: ReturnType<typeof selectPlatformInvocationPolicy>;
  skills: Array<{ componentId: string; resourceRoot: string; tree: DynamicSkillTree }>;
}

/** Finalize each Skill and the host policy against one command package record. */
export async function finalizePlatformSkillProducers(options: {
  plugin: PluginMeta;
  plugins?: readonly PluginMeta[];
  platform: PlatformTarget;
  renderUnit: Pick<RenderUnit, 'renderScope' | 'kinds'>;
  prepared: PreparedPlatformComponents;
  skillWorkRoot: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Deployments supply the frozen candidate or installed record. Null means no usable package. */
  commandRecord?: InstalledCommandProducer | null;
  portable?: boolean;
  signal?: AbortSignal;
  scriptTimeoutMs?: number;
}): Promise<FinalizedPlatformComponents> {
  const { plugin, platform, renderUnit } = options;
  const subject = { pluginId: plugin.pluginId, target: platform, scope: renderUnit.renderScope.kind };
  if (!renderUnit.kinds.includes('skill')) {
    return { prepared: options.prepared, invocationPolicy: selectPlatformInvocationPolicy({ platform, permissions: [] }, subject), skills: [] };
  }

  const skills = options.prepared.expected.components.flatMap((component) => {
    if (component.kind !== 'skill') return [];
    validatePortableSkillName(component.name, 'Skill component name');
    const files = options.prepared.resources.files.filter((file) => file.componentId === component.id);
    const tree: DynamicSkillTree = {
      skillKey: component.name,
      files: Object.fromEntries(files.map((file) => [file.path, Buffer.from(file.bytes)])),
      fileModes: Object.fromEntries(files.filter((file) => (file.mode ?? 0) & 0o111).map((file) => [file.path, 0o755 as const])),
    };
    const referencedFiles = Object.entries(tree.files).filter(([file, bytes]) =>
      file.endsWith('.md') && parseManagedCommandPlaceholders(bytes.toString('utf8')).length > 0).map(([file]) => file);
    return [{ componentId: component.id, resourceRoot: path.join(options.skillWorkRoot, component.name), tree, referencedFiles }];
  });
  const referencesCommand = skills.some(({ referencedFiles }) => referencedFiles.length > 0);
  if (referencesCommand) {
    if (platform === 'generic' || options.portable) {
      throw new Error('commandReferenceInvalid: Portable Skills cannot bind native managed commands.');
    }
    if (!plugin.manifest.requires?.aw.capabilities?.includes('aw.managed-commands.v2')) {
      throw new Error('commandReferenceInvalid: Managed command references require aw.managed-commands.v2.');
    }
    try {
      assertManagedCommandPlatform(plugin.manifest, platform, 'Skill {{aw.command}}');
    } catch (error) {
      throw new Error('commandReferenceInvalid: The command package is unavailable on this platform.', { cause: error });
    }
  }

  const policy = resolveInvocationPolicy(plugin.manifest, platform,
    plugin.sourceId ? `${plugin.sourceId}/${plugin.manifest.name}` : undefined);
  const hasManagedPermissions = policy.permissions.some((permission) =>
    [permission.allow, permission.ask, permission.deny, permission.sandbox?.excludedCommands]
      .some((entries) => entries?.some((entry) => typeof entry !== 'string')));
  const usesCommand = referencesCommand || hasManagedPermissions;
  let commandRecord = options.commandRecord;
  if (commandRecord === undefined && usesCommand && !options.portable && platform !== 'generic'
    && plugin.manifest.command?.platforms.includes(platform)) {
    const candidate = await prepareManagedCommandPackage({
      ...options, referencePlugins: options.plugins, operation: { kind: 'materialize' },
    });
    commandRecord = candidate.record;
    await candidate.cleanup();
  }
  if (commandRecord) {
    const producer = managedCommandProducerIdentity(options);
    if (commandRecord.producer.sourceId !== producer.sourceId || commandRecord.producer.sourceIdentity !== producer.sourceIdentity
      || commandRecord.producer.pluginName !== producer.pluginName) {
      throw new Error('commandReferenceInvalid: The command package does not belong to this plugin source.');
    }
  }

  const routes = commandRecord?.routes ?? null;
  const invocationPolicy = selectPlatformInvocationPolicy(policy, subject, routes, options.portable);
  const hasCommand = managedCommandRouteIsReachable(routes, []);
  const blockedSkills = new Set(skills.filter(({ referencedFiles }) => referencedFiles.length > 0 && !hasCommand).map(({ componentId }) => componentId));
  const retainedSkills = skills.filter(({ componentId }) => !blockedSkills.has(componentId));
  const receipt = Buffer.from(`${JSON.stringify(createAwPluginRequirementsReceipt(
    { name: plugin.manifest.name, version: plugin.manifest.version },
    plugin.manifest.requires?.aw.capabilities ?? [],
  ), null, 2)}\n`);
  const components: PluginComponent[] = structuredClone(options.prepared.expected.components.filter((component) => !blockedSkills.has(component.id)));
  const unmet = [...options.prepared.expected.unmet,
    ...options.prepared.expected.components.filter((component) => blockedSkills.has(component.id))
      .map((component) => ({ id: component.id, kind: component.kind, name: component.name,
        requiredFeatures: [], reasonCode: COMMAND_ROUTE_UNREACHABLE }))];
  for (const skill of retainedSkills) {
    for (const file of skill.referencedFiles) {
      const text = replaceManagedCommandPlaceholders(skill.tree.files[file]!.toString('utf8'), policy.invocationSelector!);
      skill.tree.files[file] = Buffer.from(text);
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
  const prepared: PreparedPlatformComponents = {
    ...options.prepared,
    expected: { ...options.prepared.expected, components, unmet },
    empty: components.length ? null : unmet.length ? 'unmet' : 'intentional',
    resources: { ...options.prepared.resources, files, digest: resourceDigest },
    evidence: { ...options.prepared.evidence, resourceDigest, renderInputDigest: artifactValueDigest({
      components: options.prepared.evidence.renderInputDigest,
      ...(usesCommand ? { command: commandRecord ?? null } : {}),
    }) },
  };
  return { prepared, invocationPolicy, skills: retainedSkills };
}
