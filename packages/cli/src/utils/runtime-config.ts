import path from 'node:path';
import fs from 'fs-extra';

import {
  AW_RUNTIME_CONFIG_BINDING_PATH,
  AW_RUNTIME_CONFIG_READER_PATH,
  AW_RUNTIME_NATIVE_RECEIPT_PATH,
  createRuntimeConfigBinding,
  createRuntimeConfigSnapshot,
  selectPluginConfigProfile,
  getPluginConfigDependencyKeys,
  type RuntimeConfigSnapshot,
  type RuntimeConfigOrigin,
  type RuntimeInstalledIdentity,
  type PluginComponent,
} from '@lesliechan721/aw-plugin-core';
import type { NormalizedPluginManifest, Scope, PlatformTarget } from '../types.js';
import type { ResolvedArtifactRenderConfig } from './artifact-renderer.js';
import type { DynamicSkillTree } from './dynamic-skill-tree.js';
import { resolveCliPackageRoot } from './paths.js';

export function createArtifactRuntimeConfigSnapshots(options: {
  sourceId?: string;
  sourceIdentity?: string;
  logicalIdentity?: string;
  manifest: NormalizedPluginManifest;
  platform: PlatformTarget;
  scope: Scope;
  config: ResolvedArtifactRenderConfig;
  components: readonly PluginComponent[];
}): Record<string, RuntimeConfigSnapshot> {
  const snapshots: Record<string, RuntimeConfigSnapshot> = Object.create(null);
  for (const target of options.components) {
    if (target.kind !== 'skill' || !target.runtimeConfig) continue;
    if (options.platform === 'generic') throw new Error('runtimeConfigUnsupported: Generic Skills do not support installed runtime config.');
    if (!options.manifest.requires?.aw.capabilities?.includes('aw.installed-runtime-config.v2')) throw new Error('runtimeConfigInvalid: Runtime config requires aw.installed-runtime-config.v2.');
    const sourceId = options.sourceId ?? 'authoring';
    const installedIdentity: RuntimeInstalledIdentity = {
      sourceId,
      sourceIdentity: options.sourceIdentity ?? 'authoring',
      ...(options.logicalIdentity ? { logicalIdentity: options.logicalIdentity } : {}),
      pluginId: `${sourceId}/${options.manifest.name}`,
      pluginName: options.manifest.name,
      pluginVersion: options.manifest.version,
      platform: options.platform,
      scope: options.scope,
      configScope: options.config.targetScope,
      artifactId: target.id,
      skillKey: target.name,
    };
    if (!options.manifest.config) throw new Error('runtimeConfigInvalid: Runtime config requires a config definition.');
    const definition = options.config.definition ?? selectPluginConfigProfile(options.manifest.config, options.platform);
    const dependencyKeys = new Set(getPluginConfigDependencyKeys(definition, target.runtimeConfig.keys));
    if (options.config.issues.some((issue) => dependencyKeys.has(issue.key))) {
      throw new Error('runtimeConfigInvalid: Effective runtime config dependencies are invalid; fix config and sync or reinstall.');
    }
    snapshots[target.id] = createRuntimeConfigSnapshot({
      installedIdentity,
      declaration: target.runtimeConfig,
      definition,
      values: options.config.values,
      referenceContext: options.config.referenceContext,
    });
  }
  return snapshots;
}

/** Add AW-owned weak runtime resources before the existing Skill staging/commit boundary. */
export async function injectInstalledRuntimeConfig(
  tree: DynamicSkillTree,
  snapshot: RuntimeConfigSnapshot | undefined,
  options: { origin?: RuntimeConfigOrigin } = {},
): Promise<void> {
  for (const reserved of [AW_RUNTIME_CONFIG_BINDING_PATH, AW_RUNTIME_CONFIG_READER_PATH]) {
    if (Object.hasOwn(tree.files, reserved)) throw new Error('runtimeConfigReservedResource: Plugin cannot issue AW runtime resources.');
  }
  if (Object.hasOwn(tree.files, AW_RUNTIME_NATIVE_RECEIPT_PATH)) {
    throw new Error('runtimeConfigReservedResource: Plugin cannot issue AW runtime snapshot resources.');
  }
  if (!snapshot || Object.keys(tree.files).length === 0) return;
  const helper = path.join(resolveCliPackageRoot(), 'authoring', 'assets', 'aw-runtime-config.mjs');
  const builtHelper = path.join(resolveCliPackageRoot(), 'dist', 'authoring', 'assets', 'aw-runtime-config.mjs');
  tree.files[AW_RUNTIME_CONFIG_READER_PATH] = await fs.readFile(await fs.pathExists(helper) ? helper : builtHelper);
  if (options.origin) {
    tree.files[AW_RUNTIME_NATIVE_RECEIPT_PATH] = Buffer.from(`${JSON.stringify(options.origin, null, 2)}\n`);
  }
  tree.files[AW_RUNTIME_CONFIG_BINDING_PATH] = Buffer.from(`${JSON.stringify(createRuntimeConfigBinding(snapshot,
    options.origin ? { originPath: AW_RUNTIME_NATIVE_RECEIPT_PATH } : {}), null, 2)}\n`);
}
