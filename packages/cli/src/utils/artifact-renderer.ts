import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import {
  normalizeStaticPluginComponents,
  assertPlatformRenderContext,
  selectPluginConfigProfile,
  type ComponentKind,
  type ExpectedComponentSet,
  type PlatformCapabilitiesV1,
  type PlatformRenderContextV1,
  assertNoDuplicateHookHandlers,
  type PlatformTarget,
  type PluginConfigCompiledDefinition,
  type PluginConfigReferenceContext,
  type RuntimeConfigSnapshot,
} from '@lesliechan721/aw-plugin-core/manifest';
import type { NormalizedPluginManifest, PluginArtifactRenderScriptEntry, PluginConfigSchema, PluginMeta, Scope } from '../types.js';
import type { PluginConfigIssue, PluginConfigSource, PluginConfigStore, PluginConfigValue } from './plugin-config.js';
import { assertReadyPluginConfigStore, readPluginConfigStore, resolveEffectivePluginConfig } from './plugin-config.js';
import {
  assertNoSensitiveConfigValues, buildNodeScriptInvocation, buildPluginScriptSpawnEnv,
  calculateFileDigest, collectSensitivePluginConfigValues, defaultPluginProcessRunner,
  preparePluginScriptDirectories, redactPluginScriptOutput, resolveBundledPluginFilePath,
  resolvePluginScriptTimeoutMs, summarizePluginScriptOutput,
  type PluginProcessRunner, type PluginProcessResult,
} from './plugin-scripts.js';
import { resolveArtifactRequest, resolvePlatformComponentBatches, selectPlatformRenderConfig, selectPlatformRenderConfigKeys } from './artifact-request.js';
import { artifactValueDigest, mergeExpectedComponentSets, validateArtifactPlan, validatePlatformComponentPlan, type ValidatedArtifactPlan } from './artifact-plan.js';
import { resolveCommandSourceDirectory } from './artifact-sources.js';
import { resolvePlatformComponentResources, verifyPlatformComponentResources, type VerifiedResourceClosure } from './component-resources.js';
import { createArtifactRuntimeConfigSnapshots } from './runtime-config.js';
import { prepareWindowsJobHelper } from './process-tree.js';
import { attachSafeOperationError, readSafeOperationError } from './safe-operation-diagnostic.js';

export type ArtifactRenderEvent = 'install' | 'refresh' | 'materialize';
export interface ResolvedArtifactRenderConfig {
  mode: 'artifact-render'; targetScope: Scope; schema?: PluginConfigSchema['fields'];
  values: Record<string, PluginConfigValue>; sources: Record<string, PluginConfigSource>;
  issues: PluginConfigIssue[]; stores: Partial<Record<Scope, PluginConfigStore>>;
  definition?: PluginConfigCompiledDefinition; referenceContext?: PluginConfigReferenceContext;
}
export interface ArtifactRendererTarget {
  noOp: boolean; entry?: PluginArtifactRenderScriptEntry; entryPath?: string; bundleRoot?: string;
  sourceManifest?: NormalizedPluginManifest; manifestPath?: string; manifestDigest?: string; rendererDigest?: string;
}
export const ARTIFACT_RENDERER_MAX_STDOUT_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function resolveArtifactRenderConfig(options: {
  referencePlugins?: readonly PluginMeta[];
  sourceId?: string;
  sourceIdentity?: string;
  logicalIdentity?: string;
  pluginName?: string;
  manifest: NormalizedPluginManifest;
  platform?: PlatformTarget;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedArtifactRenderConfig> {
  const pluginName = options.pluginName ?? options.manifest.name;
  const schema = options.manifest.config ? selectPluginConfigProfile(options.manifest.config, options.platform).fields : undefined;
  if (!schema) {
    const userStore = await readPluginConfigStore({
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      logicalIdentity: options.logicalIdentity,
      pluginName,
      scope: 'user',
      cwd: options.cwd,
      env: options.env,
    });
    assertReadyPluginConfigStore(userStore);
    return {
      mode: 'artifact-render',
      targetScope: options.scope,
      schema: undefined,
      values: {},
      sources: {},
      issues: [],
      stores: {
        user: userStore,
      },
    };
  }

  const effective = await resolveEffectivePluginConfig({
    sourceId: options.sourceId,
    sourceIdentity: options.sourceIdentity,
    logicalIdentity: options.logicalIdentity,
    pluginName,
    manifest: options.manifest,
    platform: options.platform,
    referencePlugins: options.referencePlugins,
    targetScope: options.scope,
    cwd: options.cwd,
    env: options.env,
  });

  return {
    mode: 'artifact-render',
    targetScope: options.scope,
    schema: effective.schema,
    definition: effective.definition,
    values: effective.values,
    sources: effective.sources,
    issues: effective.issues,
    stores: effective.stores,
    referenceContext: effective.referenceContext,
  };
}

export async function resolveArtifactRendererTarget(
  plugin: PluginMeta,
): Promise<ArtifactRendererTarget> {
  const entry = plugin.manifest.scripts?.artifacts?.render;
  const bundleRoot = await fs.realpath(plugin.rootDir);
  const manifestPath = await fs.realpath(plugin.manifestPath);
  const manifestDigest = await calculateFileDigest(manifestPath);

  if (!entry) {
    return {
      noOp: true,
      bundleRoot,
      sourceManifest: plugin.manifest,
      manifestPath,
      manifestDigest,
    };
  }

  const entryPath = await resolveBundledPluginFilePath({
    bundleRoot,
    pluginRelativePath: entry.path,
    fieldName: 'Artifact renderer',
  });

  return {
    noOp: false,
    entry,
    entryPath,
    bundleRoot,
    sourceManifest: plugin.manifest,
    manifestPath,
    manifestDigest,
    rendererDigest: await calculateFileDigest(entryPath),
  };
}

export interface PreparedArtifactRendererResult {
  value: unknown;
  target: ArtifactRendererTarget;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** One process boundary for all surfaces. Surface owners validate their response schema. */
export async function runPreparedArtifactRenderer(options: {
  plugin: PluginMeta; context: unknown; sensitiveValues: readonly string[]; cwd: string;
  event?: ArtifactRenderEvent; commandEnv?: NodeJS.ProcessEnv; scriptTimeoutMs?: number;
  signal?: AbortSignal; runner?: PluginProcessRunner; preparedResults?: Map<string, PluginProcessResult>;
}): Promise<PreparedArtifactRendererResult> {
  options.signal?.throwIfAborted();
  if (!isRecord(options.context) || (options.context.scope !== 'user' && options.context.scope !== 'project')) {
    throw new Error('artifactRendererContextInvalid: A prepared context must contain its render scope.');
  }
  const target = await resolveArtifactRendererTarget(options.plugin);
  if (target.noOp) throw new Error(`Plugin "${options.plugin.manifest.name}" does not declare scripts.artifacts.render.`);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-artifact-render-'));
  const isolatedHomes = { awHome: path.join(tempDir, 'aw-home'), codexHome: path.join(tempDir, 'codex-home'), claudeHome: path.join(tempDir, 'claude-home') };
  try {
    const contextPath = path.join(tempDir, 'context.json');
    await fs.writeJson(contextPath, options.context, { spaces: 2 });
    await fs.chmod(contextPath, 0o600).catch(() => undefined);
    await preparePluginScriptDirectories(tempDir);
    if (process.platform === 'win32') await prepareWindowsJobHelper();
    for (const location of Object.values(isolatedHomes)) await fs.ensureDir(location);
    const commandEnv = options.commandEnv ?? process.env;
    const surface = options.context.surface;
    const platform = typeof options.context.platform === 'string' ? options.context.platform as PlatformTarget : undefined;
    const env = buildPluginScriptSpawnEnv({ commandEnv, contextPath, tempDir, isolatedHomes,
      plugin: options.plugin.manifest, event: options.event ?? 'materialize',
      platform, scope: options.context.scope, bundleRoot: target.bundleRoot! });
    env.AW_PLUGIN_SURFACE = typeof surface === 'string' ? surface : 'managed-commands';
    const invocation = buildNodeScriptInvocation({ entryPath: target.entryPath!, cwd: options.cwd, env, args: target.entry!.args });
    const timeoutMs = resolvePluginScriptTimeoutMs({ cliTimeoutMs: options.scriptTimeoutMs });
    const preparationKey = options.preparedResults ? artifactValueDigest({ context: options.context,
      manifestDigest: target.manifestDigest, rendererDigest: target.rendererDigest, cwd: options.cwd,
      commandEnv, scriptTimeoutMs: options.scriptTimeoutMs }) : undefined;
    const runOptions = { timeoutMs, maxStdoutBytes: ARTIFACT_RENDERER_MAX_STDOUT_BYTES, ...(options.signal ? { signal: options.signal } : {}) };
    const result = (preparationKey ? options.preparedResults?.get(preparationKey) : undefined)
      ?? await (options.runner ? options.runner.run(invocation, runOptions)
        : defaultPluginProcessRunner.run(invocation, { ...runOptions, sensitiveValues: options.sensitiveValues }));
    const summary = (text: string): string => summarizePluginScriptOutput(text, options.sensitiveValues) || '<empty>';
    const stdout = summary(result.stdout);
    const stderr = summary(result.stderr);
    if (result.stdoutTruncated || Buffer.byteLength(result.stdout, 'utf8') > ARTIFACT_RENDERER_MAX_STDOUT_BYTES) throw new Error('artifactRendererOutputTooLarge: Artifact renderer JSON exceeds the 16 MiB limit.');
    if (result.timedOut) throw new Error(`Artifact renderer timed out after ${timeoutMs} ms. stderr: ${stderr}`);
    if (result.exitCode !== 0 || result.signal !== null) throw new Error(`Artifact renderer failed with exit code ${result.exitCode}. stderr: ${stderr}`);
    let value: unknown;
    try { value = JSON.parse(result.stdout.trim()); }
    catch { throw new Error(`Artifact renderer must write JSON to stdout. stdout: ${stdout}. stderr: ${stderr}`); }
    assertNoSensitiveConfigValues(value, options.sensitiveValues,
      'artifactRendererSensitiveConfigExposed: Artifact renderer output contains sensitive config.');
    // This cache is scoped to one operation. Every consumer still validates its surface and resources.
    if (preparationKey) options.preparedResults!.set(preparationKey, result);
    return { value, target, exitCode: result.exitCode, signal: result.signal, stdout, stderr, timedOut: result.timedOut };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const redacted = redactPluginScriptOutput(message, options.sensitiveValues);
    if (redacted === message) throw error;
    const failure = new Error(redacted, { cause: error });
    if (error instanceof Error) failure.name = error.name;
    const diagnostic = readSafeOperationError(error);
    throw diagnostic ? attachSafeOperationError(failure, diagnostic) : failure;
  } finally { await fs.remove(tempDir); }
}

export interface PlatformComponentPreparationEvidence {
  manifestDigest: string;
  rendererDigest?: string;
  configDigest: string;
  capabilitiesDigest: string;
  resourceDigest: string;
  renderInputDigest: string;
}
export interface PreparedPlatformComponents {
  expected: ExpectedComponentSet;
  resources: VerifiedResourceClosure;
  evidence: PlatformComponentPreparationEvidence;
  runtimeConfigSnapshots: Record<string, RuntimeConfigSnapshot>;
  empty: 'intentional' | 'unmet' | null;
}

export async function preparePlatformComponents(options: {
  plugin: PluginMeta; platform: PlatformTarget; renderScope: Scope; kinds: readonly ComponentKind[];
  capabilities: PlatformCapabilitiesV1; config: ResolvedArtifactRenderConfig; cwd: string;
  staticExpected?: ExpectedComponentSet; staticResourceRoot?: string; previousComponents?: PlatformRenderContextV1['previousComponents'];
  changedConfigKeys?: string[]; commandEnv?: NodeJS.ProcessEnv; scriptTimeoutMs?: number;
  signal?: AbortSignal; runner?: PluginProcessRunner; preparedResults?: Map<string, PluginProcessResult>;
}): Promise<PreparedPlatformComponents> {
  options.signal?.throwIfAborted();
  if (options.capabilities.platform !== options.platform || options.capabilities.scope !== options.renderScope
    || options.config.targetScope !== options.renderScope) throw new Error('componentRenderUnitMismatch: Config and capability scope must match the render unit.');
  const target = await resolveArtifactRendererTarget(options.plugin);
  const sensitiveValues = collectSensitivePluginConfigValues(options.plugin.manifest, options.config.values, options.platform);
  try {
    const resources = await resolvePlatformComponentResources(options.plugin);
    const sets: ExpectedComponentSet[] = [options.staticExpected ?? await normalizeStaticPluginComponents({
      pluginRoot: options.plugin.rootDir, staticResourceRoot: options.staticResourceRoot, manifest: options.plugin.manifest, platform: options.platform,
      capabilities: options.capabilities, allowedOutputKinds: options.kinds,
    })];
    const contexts: PlatformRenderContextV1[] = [];
    for (const allowedOutputKinds of resolvePlatformComponentBatches({ ...options, manifest: options.plugin.manifest })) {
      const nonSensitive = allowedOutputKinds.includes('skill');
      const keys = options.plugin.manifest.artifacts!.configKeys;
      const config = selectPlatformRenderConfig({ resolved: options.config, keys, nonSensitive });
      if (config.issues.length) throw new Error(`Invalid AW config for ${options.plugin.manifest.name}: ${config.issues.map((issue) => issue.path.field).join(', ')}.`);
      const context: PlatformRenderContextV1 = {
        schemaVersion: 1, surface: 'agent-plugin', platform: options.platform, scope: options.renderScope,
        plugin: { pluginId: options.plugin.pluginId ?? `${options.plugin.sourceId ?? 'authoring'}/${options.plugin.manifest.name}`,
          name: options.plugin.manifest.name, version: options.plugin.manifest.version },
        config, changedConfigKeys: (options.changedConfigKeys ?? []).filter((key) => Object.hasOwn(config.sources, key)),
        allowedOutputKinds, platformCapabilities: options.capabilities, resources,
        previousComponents: (options.previousComponents ?? []).filter((entry) => allowedOutputKinds.includes(entry.kind))
          .map(({ id, kind, name }) => ({ id, kind, name })),
      };
      assertPlatformRenderContext(context);
      contexts.push(context);
      const rendered = await runPreparedArtifactRenderer({ ...options, context, sensitiveValues });
      const plan = validatePlatformComponentPlan({ plan: rendered.value, platform: options.platform, scope: options.renderScope,
        allowedOutputKinds, platformCapabilities: options.capabilities, configKeys: keys,
        nonSensitiveConfigKeys: selectPlatformRenderConfigKeys({ resolved: options.config, keys, nonSensitive: true }),
        resources, sourceDirs: options.plugin.manifest.artifacts?.sourceDirs,
        requiredAwCapabilities: options.plugin.manifest.requires?.aw.capabilities });
      sets.push({ components: plan.components, omitted: plan.omitted, unmet: plan.unmet,
        sources: Object.fromEntries([...plan.components, ...plan.omitted, ...plan.unmet].map((entry) => [entry.id, 'dynamic' as const])) });
    }
    const expected = mergeExpectedComponentSets(sets);
    assertNoDuplicateHookHandlers(expected.components, options.platform);
    const closure = await verifyPlatformComponentResources({ plugin: options.plugin, expected, resources,
      capabilities: options.capabilities, sensitiveValues, staticResourceRoot: options.staticResourceRoot });
    // Only the exact static receipt, already matched to the verified manifest above, is metadata rather than plugin text.
    const scannedComponents = expected.components.map((component) => component.kind === 'skill' && expected.sources[component.id] === 'static'
      ? { ...component, content: { files: Object.fromEntries(Object.entries(component.content.files).filter(([file]) => file !== 'aw-plugin-requirements.json')) } }
      : component);
    assertNoSensitiveConfigValues({ ...expected, components: scannedComponents }, sensitiveValues,
      'componentSensitiveConfigExposed: Components contain sensitive config.');
    const runtimeConfigSnapshots = createArtifactRuntimeConfigSnapshots({
      sourceId: options.plugin.sourceId, sourceIdentity: options.plugin.sourceIdentity,
      logicalIdentity: options.plugin.catalogLogicalIdentity, manifest: options.plugin.manifest,
      platform: options.platform, scope: options.renderScope, config: options.config, components: expected.components,
    });
    const evidence: PlatformComponentPreparationEvidence = {
      manifestDigest: target.manifestDigest!, ...(target.rendererDigest ? { rendererDigest: target.rendererDigest } : {}),
      configDigest: artifactValueDigest(selectPlatformRenderConfig({ resolved: options.config,
        keys: options.plugin.manifest.artifacts?.configKeys ?? [], nonSensitive: false })),
      capabilitiesDigest: artifactValueDigest(options.capabilities), resourceDigest: closure.digest,
      renderInputDigest: artifactValueDigest({ contexts, static: sets[0], manifestDigest: target.manifestDigest,
        rendererDigest: target.rendererDigest, resources: closure.digest }),
    };
    return { expected, resources: closure, evidence, runtimeConfigSnapshots,
      empty: expected.components.length ? null : expected.unmet.length ? 'unmet' : 'intentional' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const redacted = redactPluginScriptOutput(message, sensitiveValues);
    if (message === redacted) throw error;
    const failure = new Error(redacted);
    const diagnostic = readSafeOperationError(error);
    throw diagnostic ? attachSafeOperationError(failure, diagnostic) : failure;
  }
}

/** The independent command-package surface retains its v2 protocol. */
export async function runArtifactRenderer(options: {
  referencePlugins?: readonly PluginMeta[]; event: ArtifactRenderEvent; plugin: PluginMeta;
  platform: 'managed-commands'; scope: Scope; configScope?: Scope; cwd: string;
  commandEnv?: NodeJS.ProcessEnv; changedConfigKeys?: string[]; previousArtifacts?: unknown[];
  requestedArtifactIds: readonly string[]; scriptTimeoutMs?: number; signal?: AbortSignal;
  runner?: PluginProcessRunner; preparedResults?: Map<string, PluginProcessResult>;
}): Promise<{ plan: ValidatedArtifactPlan; target: ArtifactRendererTarget; context: ManagedCommandRendererContext;
  runtimeConfigSnapshots: Record<string, RuntimeConfigSnapshot>; exitCode: number | null;
  signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }> {
  const written = await createManagedCommandRendererContext({ ...options, target: await resolveArtifactRendererTarget(options.plugin),
    sourceId: options.plugin.sourceId, sourceIdentity: options.plugin.sourceIdentity,
    logicalIdentity: options.plugin.catalogLogicalIdentity, commandEnv: options.commandEnv ?? process.env });
  try {
    const rendered = await runPreparedArtifactRenderer({ ...options, context: written.context, sensitiveValues: written.sensitiveValues });
    const plan = validateArtifactPlan({ ...options, manifest: options.plugin.manifest, plan: rendered.value,
      renderConfig: written.renderConfig, manifestDigest: rendered.target.manifestDigest, rendererDigest: rendered.target.rendererDigest });
    return { ...rendered, plan, context: written.context, runtimeConfigSnapshots: {} };
  } finally { await written.cleanup(); }
}

export interface ManagedCommandRendererContext {
  event: ArtifactRenderEvent;
  surface: { kind: 'aw'; name: 'managed-commands' };
  scope: Scope;
  plugin: { name: string; version: string; rootDir: string };
  config: { mode: 'artifact-render'; targetScope: Scope; schema?: PluginConfigSchema['fields'];
    values: Record<string, PluginConfigValue>; sources: Record<string, PluginConfigSource>; issues: PluginConfigIssue[] };
  changedConfigKeys: string[];
  requestedArtifactIds: string[];
  previousArtifacts: unknown[];
  artifactSources: never[];
  commandSources: Array<{ packageKey: string; sourceDir: string }>;
  runtimeImports: never[];
}
async function createManagedCommandRendererContext(options: {
  referencePlugins?: readonly PluginMeta[]; sourceId?: string; sourceIdentity?: string; logicalIdentity?: string;
  target: ArtifactRendererTarget; event: ArtifactRenderEvent; platform: 'managed-commands'; scope: Scope;
  configScope?: Scope; cwd: string; commandEnv: NodeJS.ProcessEnv; changedConfigKeys?: string[];
  previousArtifacts?: unknown[]; requestedArtifactIds: readonly string[];
}): Promise<{ context: ManagedCommandRendererContext; renderConfig: ResolvedArtifactRenderConfig;
  sensitiveValues: string[]; cleanup(): Promise<void> }> {
  if (options.platform !== 'managed-commands') throw new Error('Platform components require preparePlatformComponents and the v3 component protocol.');
  if (!options.target.sourceManifest || !options.target.bundleRoot) throw new Error('Cannot write a command context for an unresolved target.');
  const manifest = options.target.sourceManifest;
  const request = resolveArtifactRequest({ manifest, platform: 'managed-commands', scope: options.scope, requestedArtifactIds: options.requestedArtifactIds });
  const resolved = await resolveArtifactRenderConfig({ ...options, manifest, platform: undefined, scope: options.configScope ?? options.scope, env: options.commandEnv });
  const requestedKeys = request.declarations.flatMap((entry) => entry.refreshKeys);
  const selected = selectPlatformRenderConfig({ resolved, keys: requestedKeys, nonSensitive: true });
  if (requestedKeys.some((key) => !Object.hasOwn(selected.sources, key))) throw new Error('managedCommandSensitiveConfigDenied: Command inputs must be non-sensitive.');
  const keySet = new Set(Object.keys(selected.sources));
  const renderConfig = { ...resolved, schema: selected.schema.fields,
    values: selected.values, sources: selected.sources, issues: resolved.issues.filter((issue) => keySet.has(issue.key)) };
  if (renderConfig.issues.length) throw new Error('Invalid AW config for managed commands.');
  const packageKeys = new Set(request.declarations.flatMap((entry) => entry.producer.kind === 'package' ? [entry.producer.packageKey] : []));
  const commandSources = await Promise.all((manifest.managedCommands?.packages ?? []).filter((entry) => packageKeys.has(entry.key))
    .map(async (entry) => ({ packageKey: entry.key, sourceDir: await resolveCommandSourceDirectory({ bundleRoot: options.target.bundleRoot!, pluginRelativePath: entry.sourceDir }) })));
  return { context: { event: options.event, surface: { kind: 'aw', name: 'managed-commands' }, scope: options.scope,
    plugin: { name: manifest.name, version: manifest.version, rootDir: options.target.bundleRoot },
    config: { mode: 'artifact-render', targetScope: resolved.targetScope, schema: renderConfig.schema,
      values: renderConfig.values, sources: renderConfig.sources, issues: renderConfig.issues },
    changedConfigKeys: (options.changedConfigKeys ?? []).filter((key) => keySet.has(key)),
    requestedArtifactIds: request.requestedArtifactIds,
    previousArtifacts: (options.previousArtifacts ?? []).filter((value) => isRecord(value)
      && request.requestedArtifactIds.includes(String(value.id)) && (value.kind === 'commandSet' || value.kind === 'commandPackage')),
    commandSources, artifactSources: [], runtimeImports: [] }, renderConfig,
    sensitiveValues: collectSensitivePluginConfigValues(manifest, resolved.values), cleanup: async () => undefined };
}
