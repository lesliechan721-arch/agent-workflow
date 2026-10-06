import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';

import {
  AW_RUNTIME_CONFIG_BINDING_PATH,
  AW_RUNTIME_CONFIG_READER_PATH,
  AW_RUNTIME_NATIVE_RECEIPT_PATH,
  AW_RUNTIME_PEERS_ROOT,
  createRuntimeConfigBinding,
  computeRuntimeConfigDigest,
  computeRuntimeConfigRevision,
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
import { readRuntimeConfig } from '../../authoring/assets/aw-runtime-config.mjs';

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
      sources: options.config.sources,
      ...(target.runtimeConfig.artifactIds ? {
        consistencyGroup: target.runtimeConfig.artifactIds.map((id) => {
          const peer = options.manifest.artifacts!.targets!.find((candidate) => candidate.id === id && candidate.platform === target.platform
            && JSON.stringify([...candidate.scopes].sort()) === JSON.stringify([...target.scopes].sort()))!;
          return { artifactId: id, skillKey: peer.skillKey! };
        }).sort((left, right) => left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0),
      } : {}),
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
  if (Object.keys(tree.files).some((file) => file === AW_RUNTIME_NATIVE_RECEIPT_PATH || file.startsWith(`${AW_RUNTIME_PEERS_ROOT}/`))) {
    throw new Error('runtimeConfigReservedResource: Plugin cannot issue AW runtime snapshot resources.');
  }
  if (!snapshot || Object.keys(tree.files).length === 0) return;
  const helper = path.join(resolveCliPackageRoot(), 'authoring', 'assets', 'aw-runtime-config.mjs');
  const builtHelper = path.join(resolveCliPackageRoot(), 'dist', 'authoring', 'assets', 'aw-runtime-config.mjs');
  tree.files[AW_RUNTIME_CONFIG_READER_PATH] = await fs.readFile(await fs.pathExists(helper) ? helper : builtHelper);
  const resources = Object.fromEntries(Object.entries(tree.files).map(([relative, bytes]) => [
    relative, `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  ]));
  tree.files[AW_RUNTIME_CONFIG_BINDING_PATH] = Buffer.from(`${JSON.stringify(createRuntimeConfigBinding(snapshot, resources, options), null, 2)}\n`);
}

async function readBinding(skillRoot: string): Promise<RuntimeConfigBinding | null> {
  const bindingPath = path.join(skillRoot, AW_RUNTIME_CONFIG_BINDING_PATH);
  if (!await fs.pathExists(bindingPath)) return null;
  const value = await fs.readJson(bindingPath) as RuntimeConfigBinding;
  const { digest, ...payload } = value;
  if (computeRuntimeConfigDigest(payload) !== digest || computeRuntimeConfigRevision(value) !== value.revision) {
    throw new Error('runtimeConfigBindingInvalid: Cannot capture a damaged runtime binding; sync or reinstall.');
  }
  return value;
}

function snapshotOf(binding: RuntimeConfigBinding): RuntimeConfigSnapshot {
  const { digest: _digest, resources: _resources, peerLocators: _peers, nativeReceiptPath: _native, ...snapshot } = binding;
  return snapshot;
}

async function resourceDigests(skillRoot: string, resources: Iterable<string>): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const relative of resources) {
    if (relative === AW_RUNTIME_CONFIG_BINDING_PATH) continue;
    const file = path.join(skillRoot, ...relative.split('/'));
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('runtimeConfigPathUnsafe: Runtime capture requires regular files.');
    result[relative] = `sha256:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`;
  }
  return result;
}

/** AW-owned capture retains the existing native origin receipt when its ancestor will be removed. */
export async function carryRuntimeConfigNativeReceipt(skillRoot: string, receipt: Buffer): Promise<void> {
  const binding = await readBinding(skillRoot);
  if (!binding?.nativeReceiptPath) return;
  await fs.outputFile(path.join(skillRoot, AW_RUNTIME_NATIVE_RECEIPT_PATH), receipt);
  const resources = await resourceDigests(skillRoot, [...Object.keys(binding.resources), AW_RUNTIME_NATIVE_RECEIPT_PATH]);
  const rebound = createRuntimeConfigBinding(snapshotOf(binding), resources, { nativeReceiptPath: AW_RUNTIME_NATIVE_RECEIPT_PATH });
  await fs.outputJson(path.join(skillRoot, AW_RUNTIME_CONFIG_BINDING_PATH), rebound, { spaces: 2 });
}

/** Capture the declared peer resource closure into an independently movable Skill snapshot. */
export async function captureRuntimeConfigPeers(options: { sourceSkillRoot: string; destinationSkillRoot: string }): Promise<void> {
  const sourceBinding = await readBinding(options.sourceSkillRoot);
  if (!sourceBinding) return;
  await readRuntimeConfig({ from: await fs.realpath(path.join(options.sourceSkillRoot, AW_RUNTIME_CONFIG_READER_PATH)), keys: [] });
  const resources = new Set(Object.keys(sourceBinding.resources));
  for (const locator of sourceBinding.peerLocators) {
    if (locator.relativeRoot === '.') continue;
    const sourcePeer = path.resolve(options.sourceSkillRoot, locator.relativeRoot);
    const relativeRoot = `${AW_RUNTIME_PEERS_ROOT}/${locator.skillKey}`;
    const destinationPeer = path.join(options.destinationSkillRoot, relativeRoot);
    await fs.copy(sourcePeer, destinationPeer, { dereference: false, overwrite: false, errorOnExist: true });
    const peerBinding = await readBinding(sourcePeer);
    if (!peerBinding) throw new Error('runtimeConfigBindingMissing: Runtime peer capture is incomplete.');
    const reboundPeer = createRuntimeConfigBinding(snapshotOf(peerBinding), peerBinding.resources, {
      peerLocation: 'snapshot-member', snapshotOwnerSkillKey: sourceBinding.installedIdentity.skillKey,
      ...(peerBinding.nativeReceiptPath ? { nativeReceiptPath: peerBinding.nativeReceiptPath } : {}),
    });
    await fs.outputJson(path.join(destinationPeer, AW_RUNTIME_CONFIG_BINDING_PATH), reboundPeer, { spaces: 2 });
    for (const relative of [...Object.keys(peerBinding.resources), AW_RUNTIME_CONFIG_BINDING_PATH]) {
      resources.add(`${relativeRoot}/${relative}`);
    }
  }
  const rebound = createRuntimeConfigBinding(snapshotOf(sourceBinding), await resourceDigests(options.destinationSkillRoot, resources), {
    peerLocation: 'snapshot',
    ...(sourceBinding.nativeReceiptPath ? { nativeReceiptPath: sourceBinding.nativeReceiptPath } : {}),
  });
  await fs.outputJson(path.join(options.destinationSkillRoot, AW_RUNTIME_CONFIG_BINDING_PATH), rebound, { spaces: 2 });
}
