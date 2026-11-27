import path from 'node:path';

import fs from 'fs-extra';
import { computeCanonicalDirectoryDigest } from '@lesliechan721/agent-skill-eval';
import {
  COMPONENT_KINDS,
  type ComponentKind,
  type PlatformCapabilitiesV3,
} from '@lesliechan721/aw-plugin-core/manifest';

import { bundleLocalPlugin, prepareLocalPluginBundleSource } from '../generators/local-plugin.js';
import type { PlatformTarget, PluginMeta, Scope } from '../types.js';
import type { RenderUnit } from '../platforms/contracts.js';
import { resolveDeployments } from '../platforms/layout.js';
import { getQualifiedPlatformProfile } from '../platforms/capabilities.js';
import { projectPlatform, projectSkillDocument } from '../platforms/projection.js';
import { artifactValueDigest, mergeExpectedComponentSets } from '../utils/artifact-plan.js';
import { preparePlatformComponents, resolveArtifactRenderConfig, type ResolvedArtifactRenderConfig } from '../utils/artifact-renderer.js';
import { createCatalogRuntimeImportResolver } from '../utils/catalog-runtime-projection.js';
import { skillAgentBinding, type RawPlatformUnit } from '../utils/component-agent-binding.js';
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
  declaredGapIds?: string[];
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

function profileHostRoot(home: string, platform: PlatformTarget): string {
  return path.join(home, 'profile-host', platform);
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
  portable?: boolean;
  kinds?: readonly ComponentKind[];
  config?: ResolvedArtifactRenderConfig;
  userConfig?: ResolvedArtifactRenderConfig;
  commandRecord?: Parameters<typeof finalizePlatformSkillProducers>[0]['commandRecord'];
  signal?: AbortSignal;
  scriptTimeoutMs?: number;
}): Promise<{
  skills: Array<{ id: string; name: string; path: string; dynamic: boolean }>;
  codexRoleFiles: string[];
  preparation: ComponentPreparationBinding[];
}> {
  const sourceId = options.plugin.sourceId ?? 'authoring';
  const pluginId = options.plugin.pluginId ?? `${sourceId}/${options.plugin.manifest.name}`;
  const sourceIdentity = options.plugin.sourceIdentity ?? await computeCanonicalDirectoryDigest(options.plugin.rootDir);
  options = { ...options, plugin: { ...options.plugin, sourceId, sourceIdentity, pluginId } };
  const productRoot = profileHostRoot(options.env.HOME!, options.platform);
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
  const skills: Array<{ id: string; name: string; path: string; dynamic: boolean }> = [];
  const codexRoleFiles: string[] = [];
  const rawUnits: RawPlatformUnit[] = [];
  const preparedUnits: Array<{ unit: RenderUnit; capabilities: PlatformCapabilitiesV3;
    finalized: Awaited<ReturnType<typeof finalizePlatformSkillProducers>> }> = [];
  try {
    for (const unit of resolution.renderUnits) {
      const kinds = unit.output === 'generic' && options.portable && options.kinds ? options.kinds
        : unit.kinds.filter((kind) => (options.kinds ?? COMPONENT_KINDS).includes(kind));
      if (!kinds.length) continue;
      const capabilities: PlatformCapabilitiesV3 = getAuthoringPlatformCapabilities(options.platform, unit.renderScope.kind, {
        portable: options.portable,
      });
      const sharedCodexPackage = options.platform === 'codex' && unit.output === 'package' && unit.renderScope.kind === 'user';
      const supplied = sharedCodexPackage && options.config?.targetScope === 'project' ? options.userConfig : options.config;
      const config = supplied ? { ...supplied, targetScope: unit.renderScope.kind } : await resolveArtifactRenderConfig({
        pluginName: options.plugin.manifest.name, manifest: options.plugin.manifest,
        referencePlugins: options.plugins, sourceId: options.plugin.sourceId,
        sourceIdentity: options.plugin.sourceIdentity, logicalIdentity: options.plugin.catalogLogicalIdentity,
        platform: options.platform, scope: unit.renderScope.kind, cwd: options.cwd, env: options.env,
      });
      const platformResourceRoot = path.join(options.plugin.rootDir, options.platform);
      const staticResourceRoot = await fs.pathExists(platformResourceRoot) ? platformResourceRoot : options.plugin.rootDir;
      const grokRoleUnit = options.platform === 'grok' && unit.output === 'supplement' ? rawUnits.find((entry) =>
        entry.unit.output === 'package' && artifactValueDigest(entry.unit.renderScope) === artifactValueDigest(unit.renderScope)) : undefined;
      const request: RawPlatformUnit['request'] = {
        ...options, renderScope: unit.renderScope.kind, kinds, capabilities, config,
        staticResourceRoot, hasInstructionAgentRecipients: grokRoleUnit?.prepared.expected.components.some(({ kind }) => kind === 'agent'),
        commandEnv: options.env,
      };
      rawUnits.push({ unit, request, prepared: await preparePlatformComponents(request) });
    }
    for (const raw of rawUnits) {
      const { unit, prepared, request: { capabilities } } = raw;
      const finalized = await finalizePlatformSkillProducers({
        ...options, renderUnit: unit, prepared, agentBinding: skillAgentBinding(raw, rawUnits),
        skillWorkRoot: path.join(options.outputRoot, '.prepare-skills', unit.id.replace(/[^a-z0-9]/gu, '')),
      });
      preparedUnits.push({ unit, capabilities, finalized });
    }
    for (const { unit, capabilities, finalized } of preparedUnits) {
      const current = finalized.prepared;
      const sameScope = options.platform === 'grok' ? preparedUnits.filter((entry) =>
        artifactValueDigest(entry.unit.renderScope) === artifactValueDigest(unit.renderScope)) : [];
      const components = sameScope.length <= 1 ? current.expected.components : mergeExpectedComponentSets(
        sameScope.map((entry) => entry.finalized.prepared.expected)).components.filter((component) =>
        unit.output !== 'supplement' || component.kind === 'instruction' || component.kind === 'agent');
      const relativeNativeRoot = `native/${unit.id.replace(/[^a-z0-9]/gu, '')}`;
      const nativeRoot = path.join(options.outputRoot, relativeNativeRoot);
      // Portable generic uses the original Skill name. A namespaced native supplement
      // would validate a different name, which can exceed the portable length limit.
      const portableGeneric = options.portable && options.platform === 'generic';
      const projection = portableGeneric || current.empty === 'unmet' && !finalized.invocationPolicy.policy.permissions.length ? null : await projectPlatform({
        cwd: options.cwd, env: options.env,
        stagingRoot: nativeRoot,
      }, {
        binding, renderUnit: unit, capabilities,
        components,
        resources: current.resources,
        policy: finalized.invocationPolicy.policy,
      });
      if (options.platform === 'codex' && unit.output === 'supplement' && projection) {
        codexRoleFiles.push(...projection.supplements.map(({ stagingPath }) => stagingPath));
      }
      const outputs = projection && await fs.pathExists(nativeRoot)
        ? [{ path: relativeNativeRoot, digest: await computeCanonicalDirectoryDigest(nativeRoot) }] : [];
      for (const skill of finalized.skills) {
        const component = current.expected.components.find((entry) => entry.id === skill.componentId)!;
        if (options.selectedSkills?.length && !options.selectedSkills.includes(component.name)) continue;
        const destination = path.join(options.outputRoot, 'skills', component.name);
        // Codex sidecars and OpenCode metadata already fit the standard Skill directory.
        const portableDocument = options.platform === 'generic' || options.portable && options.platform !== 'codex' && options.platform !== 'opencode';
        const source = !portableDocument && projection?.bundle
          ? path.join(projection.bundle.stagingRoot, 'skills', component.name) : skill.resourceRoot;
        await fs.copy(source, destination, { overwrite: false, errorOnExist: true, dereference: false });
        if (portableDocument) {
          const original = skill.tree.files['SKILL.md']!;
          const portable = projectSkillDocument('generic', component, component.name, original);
          if (portable !== original) await fs.writeFile(path.join(destination, 'SKILL.md'), portable);
        }
        skills.push({ id: component.id, name: component.name, path: destination,
          dynamic: current.expected.sources[component.id] === 'dynamic' });
      }
      const declaredGapIds = current.expected.unmet.filter((gap) => current.expected.sources[gap.id] === 'static'
        || current.expected.declaredComponentIds?.includes(gap.componentId ?? gap.id)).map(({ id }) => id);
      preparation.push({
        plugin: options.plugin.manifest.name, platform: options.platform, renderScope: unit.renderScope.kind, profileId: getQualifiedPlatformProfile(options.platform).id,
        capabilitiesDigest: current.evidence.capabilitiesDigest,
        expectedDigest: artifactValueDigest(current.expected),
        resourceDigest: current.evidence.resourceDigest,
        renderInputDigest: current.evidence.renderInputDigest,
        outputs,
        components: current.expected.components.map(({ id, kind, name }) => ({ id, kind, name, source: current.expected.sources[id]! })),
        omitted: current.expected.omitted, unmet: current.expected.unmet,
        ...(portableGeneric && declaredGapIds.length ? { declaredGapIds } : {}),
      });
    }
  } finally {
    await fs.remove(path.join(options.outputRoot, '.prepare-skills'));
  }
  await fs.ensureDir(path.join(options.outputRoot, 'skills'));
  for (const selected of options.selectedSkills ?? []) {
    if (skills.some((skill) => skill.name === selected)
      || preparation.some((unit) => unit.unmet.some((entry) => entry.kind === 'skill' && entry.name === selected)
        || unit.omitted.some((entry) => entry.kind === 'skill' && entry.id === `skill:${selected}`))) continue;
    throw new Error(`Selected Skill was not produced by the complete component set: ${selected}.`);
  }
  return { skills, codexRoleFiles, preparation };
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
    GROK_HOME: profileHostRoot(home, 'grok'),
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
    fs.ensureDir(env.GROK_HOME!),
  ]);
  return env;
}
