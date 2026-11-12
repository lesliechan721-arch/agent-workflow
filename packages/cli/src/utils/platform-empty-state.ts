import path from 'node:path';
import fs from 'fs-extra';
import type { PlatformCapabilitiesV1 } from '@lesliechan721/aw-plugin-core/manifest';

import type { PluginMeta } from '../types.js';
import type { DeploymentBinding, DeploymentObservation, RenderUnit } from '../platforms/contracts.js';
import { artifactValueDigest } from './artifact-plan.js';
import { selectPlatformRenderConfig } from './artifact-request.js';
import type { ResolvedArtifactRenderConfig } from './artifact-renderer.js';
import { calculatePluginBundleFingerprint } from './bundle-integrity.js';
import { resolvePlatformComponentResources } from './component-resources.js';
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
export type PlatformEmptyState = Omit<PlatformInputEvidence, 'kind'> & {
  kind: 'aw-platform-empty-state'; result: 'intentional-empty';
};

export interface PlatformInputEvidenceOptions {
  plugin: PluginMeta;
  binding: DeploymentBinding;
  units: Array<{
    renderUnit: RenderUnit;
    capabilities: PlatformCapabilitiesV1;
    config: ResolvedArtifactRenderConfig;
    prerequisites: DeploymentObservation['prerequisites'];
  }>;
}

/** Currentness evidence only. This state never grants ownership or removal rights. */
export async function createPlatformInputEvidence(input: PlatformInputEvidenceOptions): Promise<PlatformInputEvidence> {
  const { plugin, binding } = input;
  if (binding.platform === 'generic' || plugin.pluginId !== binding.plugin.pluginId
    || plugin.sourceIdentity !== binding.plugin.sourceIdentity || plugin.manifest.version !== binding.plugin.version
    || new Set(input.units.map(({ renderUnit }) => renderUnit.id)).size !== input.units.length
    || input.units.length !== binding.renderUnitIds.length
    || binding.renderUnitIds.some((id) => !input.units.some(({ renderUnit }) => renderUnit.id === id))) {
    throw new Error('platformEmptyStateIdentityInvalid');
  }
  const [sourceDigest, resources] = await Promise.all([
    calculatePluginBundleFingerprint(plugin.rootDir), resolvePlatformComponentResources(plugin),
  ]);
  const units = input.units.map(({ renderUnit, capabilities, config, prerequisites }) => {
    if (capabilities.platform !== binding.platform || capabilities.scope !== renderUnit.renderScope.kind
      || config.targetScope !== renderUnit.renderScope.kind) throw new Error('platformEmptyStateUnitInvalid');
    const { id, physicalKey, renderScope, output, kinds } = renderUnit;
    const selectedConfig = selectPlatformRenderConfig({ resolved: config, keys: plugin.manifest.artifacts?.configKeys ?? [], nonSensitive: false });
    const commandKeys = kinds.includes('skill') ? [...new Set((plugin.manifest.managedCommands?.sets ?? []).flatMap((set) =>
      set.mode === 'dynamic' && set.producer.kind !== 'package' && set.producer.platform === binding.platform
        && (set.producer.kind !== 'artifact' || !plugin.manifest.artifacts?.scopes
          || plugin.manifest.artifacts.scopes.includes(renderScope.kind)) ? set.refreshKeys : []))].sort() : [];
    const commandConfig = commandKeys.length ? selectPlatformRenderConfig({ resolved: config, keys: commandKeys, nonSensitive: true }) : undefined;
    if (selectedConfig.issues.length || commandConfig?.issues.length) throw new Error('platformEmptyStateConfigInvalid');
    // Grok source inventories are observation outputs, not renderer or capability
    // inputs. The complete observation remains part of the lock-held stale check.
    const { nativeSources: _nativeSources, ...grokRenderPrerequisites } = prerequisites;
    const renderPrerequisites = binding.platform === 'grok' ? grokRenderPrerequisites : prerequisites;
    return { id, physicalKey, renderScope, output, kinds: [...kinds],
      inputDigest: artifactValueDigest({ sourceDigest, manifest: plugin.manifest, config: selectedConfig,
        ...(commandConfig ? { commandConfig } : {}), capabilities, resources, prerequisites: renderPrerequisites }) };
  }).sort((left, right) => left.id.localeCompare(right.id));
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

function statePath(state: PlatformEmptyState, env?: NodeJS.ProcessEnv): { root: string; filePath: string } {
  if (!/^sha256:[0-9a-f]{64}$/u.test(state.binding.id) || state.platform === 'generic'
    || !/^[a-z][a-z0-9-]*$/u.test(state.platform)) throw new Error('platformEmptyStateIdentityInvalid');
  const root = resolveAbsoluteAwHome(env);
  return { root, filePath: path.join(root, 'platforms', state.platform, 'empty-state', `${state.binding.id.slice(7)}.json`) };
}

/** Call only after successful execution and postcheck of a complete intentional empty set. */
export async function writePlatformEmptyState(options: { state: PlatformEmptyState; env?: NodeJS.ProcessEnv }): Promise<void> {
  const { root, filePath } = statePath(options.state, options.env);
  assertTestWritablePath(filePath, 'platform empty state', 'Use an isolated AW_HOME for state writes.');
  await atomicReplaceSafeFile({ filePath, allowedRoot: root, label: 'Platform empty state',
    content: `${JSON.stringify(options.state, null, 2)}\n` });
}

/** Missing, damaged, stale or unreadable weak evidence leaves the expectation unconfirmed. */
export async function matchesPlatformEmptyState(options: { state: PlatformEmptyState; env?: NodeJS.ProcessEnv }): Promise<boolean> {
  try {
    const { root, filePath } = statePath(options.state, options.env);
    assertTestReadablePath(filePath, 'platform empty state', 'Use an isolated AW_HOME for state reads.');
    await assertSafeFileMutationPath({ filePath, allowedRoot: root, label: 'Platform empty state' });
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.size > 1024 * 1024) return false;
    return artifactValueDigest(await fs.readJson(filePath)) === artifactValueDigest(options.state);
  } catch { return false; }
}
