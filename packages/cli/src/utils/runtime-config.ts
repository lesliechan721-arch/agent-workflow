import path from 'node:path';
import fs from 'fs-extra';

import {
  AW_RUNTIME_CONFIG_BINDING_PATH,
  AW_RUNTIME_CONFIG_READER_PATH,
  AW_RUNTIME_NATIVE_RECEIPT_PATH,
  createRuntimeConfigBinding,
  createRuntimeConfigSnapshot,
  getPluginConfigDependencyKeys,
  type RuntimeConfigBinding,
  type RuntimeConfigSnapshot,
  type RuntimeInstalledIdentity,
} from '@lesliechan721/aw-plugin-core';
import type { NormalizedPluginManifest, Scope, PlatformName } from '../types.js';
import type { ResolvedArtifactRenderConfig } from './artifact-renderer.js';
import type { DynamicSkillTree } from './dynamic-skill-tree.js';
import { resolveCliPackageRoot } from './paths.js';

export function createArtifactRuntimeConfigSnapshots(options: {
  sourceId?: string;
  sourceIdentity?: string;
  logicalIdentity?: string;
  manifest: NormalizedPluginManifest;
  platform: PlatformName;
  scope: Scope;
  config: ResolvedArtifactRenderConfig;
  requestedArtifactIds: readonly string[];
}): Record<string, RuntimeConfigSnapshot> {
  const snapshots: Record<string, RuntimeConfigSnapshot> = {};
  for (const target of options.manifest.artifacts?.targets ?? []) {
    if (!target.runtimeConfig || target.platform !== options.platform || !target.scopes.includes(options.scope)
      || !options.requestedArtifactIds.includes(target.id)) continue;
    const sourceId = options.sourceId ?? 'authoring';
    const installedIdentity: RuntimeInstalledIdentity = {
      sourceId,
      sourceIdentity: options.sourceIdentity ?? 'authoring',
      ...(options.logicalIdentity ? { logicalIdentity: options.logicalIdentity } : {}),
      pluginId: `${sourceId}/${options.manifest.name}`,
      pluginName: options.manifest.name,
      pluginVersion: options.manifest.version,
      platform: options.platform,
      scope: target.delivery?.mode === 'codex-native' ? 'user' : options.scope,
      configScope: options.config.targetScope,
      artifactId: target.id,
      skillKey: target.skillKey!,
    };
    if (!options.manifest.config) throw new Error('runtimeConfigInvalid: Runtime config requires a config definition.');
    const dependencyKeys = new Set(getPluginConfigDependencyKeys(options.manifest.config, target.runtimeConfig.keys));
    if (options.config.issues.some((issue) => dependencyKeys.has(issue.key))) {
      throw new Error('runtimeConfigInvalid: Effective runtime config dependencies are invalid; fix config and sync or reinstall.');
    }
    snapshots[target.id] = createRuntimeConfigSnapshot({
      installedIdentity,
      declaration: target.runtimeConfig,
      definition: options.manifest.config,
      values: options.config.values,
    });
  }
  return snapshots;
}

/** Add AW-owned weak runtime resources before the existing Skill staging/commit boundary. */
export async function injectInstalledRuntimeConfig(
  tree: DynamicSkillTree,
  snapshot: RuntimeConfigSnapshot | undefined,
  options: { nativeReceiptPath?: string } = {},
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
  tree.files[AW_RUNTIME_CONFIG_BINDING_PATH] = Buffer.from(`${JSON.stringify(createRuntimeConfigBinding(snapshot, options), null, 2)}\n`);
}

async function readBinding(skillRoot: string): Promise<RuntimeConfigBinding | null> {
  const bindingPath = path.join(skillRoot, AW_RUNTIME_CONFIG_BINDING_PATH);
  if (!await fs.pathExists(bindingPath)) return null;
  const value = await fs.readJson(bindingPath) as RuntimeConfigBinding;
  if (value.schemaVersion !== 2 || value.kind !== 'aw-runtime-config') {
    throw new Error('runtimeConfigBindingInvalid: Cannot capture a damaged runtime binding; sync or reinstall.');
  }
  return value;
}

/** AW-owned capture retains the existing native origin receipt when its ancestor will be removed. */
export async function carryRuntimeConfigNativeReceipt(skillRoot: string, receipt: Buffer): Promise<void> {
  const binding = await readBinding(skillRoot);
  if (!binding?.nativeReceiptPath) return;
  await fs.outputFile(path.join(skillRoot, AW_RUNTIME_NATIVE_RECEIPT_PATH), receipt);
  const rebound = createRuntimeConfigBinding(binding, { nativeReceiptPath: AW_RUNTIME_NATIVE_RECEIPT_PATH });
  await fs.outputJson(path.join(skillRoot, AW_RUNTIME_CONFIG_BINDING_PATH), rebound, { spaces: 2 });
}
