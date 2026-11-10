import path from 'node:path';

import fs from 'fs-extra';
import { computeCanonicalDirectoryDigest } from '@lesliechan721/agent-skill-eval';
import {
  COMPONENT_KINDS,
  normalizeStaticPluginComponents,
  resolveInvocationPolicy,
  type ComponentKind,
  type PlatformCapabilitiesV1,
} from '@lesliechan721/aw-plugin-core/manifest';

import { bundleLocalPlugin, prepareLocalPluginBundleSource } from '../generators/local-plugin.js';
import type { PlatformTarget, PluginMeta, Scope } from '../types.js';
import { resolveDeployments } from '../platforms/layout.js';
import { projectPlatform } from '../platforms/projection.js';
import { artifactValueDigest } from '../utils/artifact-plan.js';
import { preparePlatformComponents, resolveArtifactRenderConfig, type ResolvedArtifactRenderConfig } from '../utils/artifact-renderer.js';
import { createCatalogRuntimeImportResolver } from '../utils/catalog-runtime-projection.js';
import { finalizePlatformSkillProducers } from '../utils/component-command-preparation.js';
import { getAuthoringPlatformCapabilities } from './platform-profile.js';

export interface ComponentPreparationBinding {
  plugin: string;
  platform: PlatformTarget;
  renderScope: Scope;
  profileId: string;
  capabilitiesDigest: string;
  expectedDigest: string;
  resourceDigest: string;
  renderInputDigest: string;
  outputs: Array<{ path: string; digest: string }>;
  components: Array<{ id: string; kind: ComponentKind; name: string; source: 'static' | 'dynamic' }>;
  omitted: import('@lesliechan721/aw-plugin-core/manifest').ExpectedComponentSet['omitted'];
  unmet: import('@lesliechan721/aw-plugin-core/manifest').ExpectedComponentSet['unmet'];
}

export interface PreparedSkillPluginBundle {
  bundleRoot: string;
  bundlePlugin: PluginMeta;
  cleanup(): Promise<void>;
}

export async function prepareSkillPluginBundle(options: {
  plugin: PluginMeta;
  plugins: readonly PluginMeta[];
  workRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<PreparedSkillPluginBundle> {
  await fs.ensureDir(options.workRoot);
  const tempRoot = await fs.mkdtemp(path.join(options.workRoot, 'bundle-'));
  let prepared: Awaited<ReturnType<typeof prepareLocalPluginBundleSource>> | undefined;
  try {
    prepared = await prepareLocalPluginBundleSource(options.plugin, {
      buildMode: 'staging',
      commandEnv: options.env,
      runtimeResolver: createCatalogRuntimeImportResolver(options.plugins),
    });
    const activePrepared = prepared;
    const bundleRoot = path.join(tempRoot, 'bundle');
    await bundleLocalPlugin(activePrepared.plugin, bundleRoot, {
      buildMode: 'prepared',
      preparedRuntimeContext: activePrepared.runtimeContext,
    });
    const manifestPath = path.join(bundleRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath) as PluginMeta['manifest'];
    return {
      bundleRoot,
      bundlePlugin: {
        ...activePrepared.plugin,
        sourceId: options.plugin.sourceId,
        sourceIdentity: options.plugin.sourceIdentity,
        catalogLogicalIdentity: options.plugin.catalogLogicalIdentity,
        pluginId: options.plugin.pluginId,
        rootDir: bundleRoot,
        manifestPath,
        manifest,
      },
      cleanup: async () => {
        await activePrepared.cleanup();
        await fs.remove(tempRoot);
      },
    };
  } catch (error) {
    await prepared?.cleanup();
    await fs.remove(tempRoot);
    throw error;
  }
}

/** Prepare a fixed author profile without discovery or native registration. */
export async function materializeProfilePluginComponents(options: {
  plugin: PluginMeta;
  plugins?: readonly PluginMeta[];
  platform: PlatformTarget;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  outputRoot: string;
  selectedSkills?: readonly string[];
  kinds?: readonly ComponentKind[];
  config?: ResolvedArtifactRenderConfig;
  packagePreparationCache?: Parameters<typeof finalizePlatformSkillProducers>[0]['packagePreparationCache'];
  signal?: AbortSignal;
  scriptTimeoutMs?: number;
}): Promise<{
  skills: Array<{ id: string; name: string; path: string; dynamic: boolean }>;
  preparation: ComponentPreparationBinding[];
}> {
  const sourceId = options.plugin.sourceId ?? 'authoring';
  const pluginId = options.plugin.pluginId ?? `${sourceId}/${options.plugin.manifest.name}`;
  const sourceIdentity = options.plugin.sourceIdentity ?? await computeCanonicalDirectoryDigest(options.plugin.rootDir);
  options = { ...options, plugin: { ...options.plugin, sourceId, sourceIdentity, pluginId } };
  const productRoot = path.join(options.env.HOME!, 'profile-host', options.platform);
  await fs.ensureDir(productRoot);
  const resolution = await resolveDeployments({ cwd: options.cwd, env: options.env }, {
    plugin: {
      sourceId, sourceIdentity,
      pluginId, version: options.plugin.manifest.version,
    },
    scope: options.scope === 'project' ? { kind: 'project', projectRoot: options.cwd } : { kind: 'user' },
    operation: 'ensure', recoveryCandidates: [],
    discovery: {
      platform: options.platform, availability: 'notApplicable', diagnostics: [],
      installations: [{
        id: `profile:${options.platform}`, product: options.platform === 'generic' ? 'generic' : 'cli',
        version: null, availability: 'notApplicable', reasonCodes: [],
        entry: options.platform === 'generic' ? { kind: 'generic', root: productRoot } : { kind: 'directory', configRoot: productRoot },
      }],
    },
  });
  const binding = resolution.bindings[0];
  if (!binding) throw new Error('authorProfileLayoutMissing');
  const preparation: ComponentPreparationBinding[] = [];
  let packageCommandResolver: Awaited<ReturnType<typeof finalizePlatformSkillProducers>>['commandResolver'];
  const skills: Array<{ id: string; name: string; path: string; dynamic: boolean }> = [];
  for (const unit of resolution.renderUnits) {
    const kinds = unit.kinds.filter((kind) => (options.kinds ?? COMPONENT_KINDS).includes(kind));
    if (!kinds.length) continue;
    const capabilities: PlatformCapabilitiesV1 = getAuthoringPlatformCapabilities(options.platform, unit.renderScope.kind);
    const config = options.config ? { ...options.config, targetScope: unit.renderScope.kind } : await resolveArtifactRenderConfig({
      pluginName: options.plugin.manifest.name, manifest: options.plugin.manifest,
      referencePlugins: options.plugins, sourceId: options.plugin.sourceId,
      sourceIdentity: options.plugin.sourceIdentity, logicalIdentity: options.plugin.catalogLogicalIdentity,
      platform: options.platform, scope: unit.renderScope.kind, cwd: options.cwd, env: options.env,
    });
    const platformResourceRoot = path.join(options.plugin.rootDir, options.platform);
    const staticResourceRoot = await fs.pathExists(platformResourceRoot) ? platformResourceRoot : options.plugin.rootDir;
    const staticExpected = await normalizeStaticPluginComponents({
      pluginRoot: options.plugin.rootDir,
      staticResourceRoot,
      manifest: options.plugin.manifest, platform: options.platform, capabilities, allowedOutputKinds: kinds,
    });
    const prepared = await preparePlatformComponents({
      ...options, renderScope: unit.renderScope.kind, kinds, capabilities, config, staticExpected,
      staticResourceRoot,
      commandEnv: options.env,
    });
    const finalized = await finalizePlatformSkillProducers({
      ...options, renderUnit: unit, prepared,
      skillWorkRoot: path.join(options.outputRoot, '.prepare-skills', unit.id.replace(/[^a-z0-9]/gu, '')),
    });
    if (unit.kinds.includes('skill')) packageCommandResolver = finalized.commandResolver;
    try {
      const current = finalized.prepared;
      const relativeNativeRoot = `native/${unit.id.replace(/[^a-z0-9]/gu, '')}`;
      const nativeRoot = path.join(options.outputRoot, relativeNativeRoot);
      // Preserve a computed capability gap without resolving policy against unavailable producers.
      if (current.empty !== 'unmet') {
        await projectPlatform({
          cwd: options.cwd, env: options.env, commandResolver: finalized.commandResolver ?? packageCommandResolver,
          stagingRoot: nativeRoot,
        }, {
          binding, renderUnit: unit, capabilities,
          components: current.expected.components,
          resources: current.resources,
          policy: resolveInvocationPolicy(options.plugin.manifest, options.platform),
        });
      }
      const outputs = current.empty !== 'unmet' && await fs.pathExists(nativeRoot)
        ? [{ path: relativeNativeRoot, digest: await computeCanonicalDirectoryDigest(nativeRoot) }] : [];
      for (const skill of finalized.skills) {
        const component = current.expected.components.find((entry) => entry.id === skill.componentId)!;
        if (options.selectedSkills?.length && !options.selectedSkills.includes(component.name)) continue;
        const destination = path.join(options.outputRoot, 'skills', component.name);
        await fs.copy(skill.resourceRoot, destination, { overwrite: false, errorOnExist: true, dereference: false });
        skills.push({ id: component.id, name: component.name, path: destination,
          dynamic: current.expected.sources[component.id] === 'dynamic' });
      }
      preparation.push({
        plugin: options.plugin.manifest.name, platform: options.platform, renderScope: unit.renderScope.kind, profileId: capabilities.profileId,
        capabilitiesDigest: current.evidence.capabilitiesDigest,
        expectedDigest: artifactValueDigest(current.expected),
        resourceDigest: current.evidence.resourceDigest,
        renderInputDigest: current.evidence.renderInputDigest,
        outputs,
        components: current.expected.components.map(({ id, kind, name }) => ({ id, kind, name, source: current.expected.sources[id]! })),
        omitted: current.expected.omitted, unmet: current.expected.unmet,
      });
    } finally {
      await finalized.cleanup();
    }
  }
  await fs.remove(path.join(options.outputRoot, '.prepare-skills'));
  await fs.ensureDir(path.join(options.outputRoot, 'skills'));
  for (const selected of options.selectedSkills ?? []) {
    if (skills.some((skill) => skill.name === selected)
      || preparation.some((unit) => unit.unmet.some((entry) => entry.kind === 'skill' && entry.name === selected)
        || unit.omitted.some((entry) => entry.kind === 'skill' && entry.id === `skill:${selected}`))) continue;
    throw new Error(`Selected Skill was not produced by the complete component set: ${selected}.`);
  }
  return { skills, preparation };
}

export async function createIsolatedSkillEnv(
  baseEnv: NodeJS.ProcessEnv,
  scopeRoot: string,
): Promise<NodeJS.ProcessEnv> {
  const home = path.join(scopeRoot, 'home');
  const temp = path.join(scopeRoot, 'tmp');
  const codexHome = path.join(scopeRoot, 'codex-home');
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(scopeRoot, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(scopeRoot, 'xdg-config'),
    XDG_STATE_HOME: path.join(scopeRoot, 'xdg-state'),
    XDG_DATA_HOME: path.join(scopeRoot, 'xdg-data'),
    XDG_RUNTIME_DIR: path.join(scopeRoot, 'xdg-runtime'),
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    AW_HOME: path.join(scopeRoot, 'aw-home'),
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: path.join(scopeRoot, 'claude-home'),
    NODE_PATH: '',
  };
  delete env.AW_CODEX_HOME;
  delete env.AW_CLAUDE_HOME;
  await Promise.all([
    fs.ensureDir(env.HOME!),
    fs.ensureDir(env.XDG_CACHE_HOME!),
    fs.ensureDir(env.XDG_CONFIG_HOME!),
    fs.ensureDir(env.XDG_STATE_HOME!),
    fs.ensureDir(env.XDG_DATA_HOME!),
    fs.ensureDir(env.XDG_RUNTIME_DIR!),
    fs.ensureDir(env.TMPDIR!),
    fs.ensureDir(env.AW_HOME!),
    fs.ensureDir(env.CODEX_HOME!),
    fs.ensureDir(env.CLAUDE_CONFIG_DIR!),
  ]);
  return env;
}
