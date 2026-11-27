import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import {
  normalizeStaticPluginComponents,
  partitionPluginComponents,
  assertPlatformRenderContext,
  selectPluginConfigProfile,
  type ComponentKind,
  type ExpectedComponentSet,
  type PlatformCapabilitiesV2,
  type PlatformRenderContextV2,
  assertNoDuplicateHookHandlers,
  type PlatformTarget,
  type PluginConfigCompiledDefinition,
  type PluginConfigReferenceContext,
  type RuntimeConfigSnapshot,
} from '@lesliechan721/aw-plugin-core/manifest';
import type { NormalizedPluginManifest, PluginArtifactRenderScriptEntry, PluginConfigSchema, PluginMeta, Scope } from '../types.js';
import { toPlatformCapabilitiesView } from '../platforms/capabilities.js';
import type { PluginConfigIssue, PluginConfigSource, PluginConfigStore, PluginConfigValue } from './plugin-config.js';
import { assertReadyPluginConfigStore, readPluginConfigStore, resolveEffectivePluginConfig } from './plugin-config.js';
import {
  assertNoSensitiveConfigValues, buildNodeScriptInvocation, buildPluginScriptSpawnEnv,
  calculateFileDigest, collectSensitivePluginConfigValues, defaultPluginProcessRunner,
  preparePluginScriptDirectories, redactPluginScriptOutput, resolveBundledPluginFilePath,
  resolvePluginScriptTimeoutMs, summarizePluginScriptOutput,
  type PluginProcessRunner, type PluginProcessResult,
} from './plugin-scripts.js';
import { resolvePlatformComponentBatches, selectPlatformRenderConfigKeys } from './artifact-request.js';
import { artifactValueDigest, mergeExpectedComponentSets, validatePlatformComponentPlan } from './artifact-plan.js';
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

/** One preparation window. Share a child only among callers with the same cancellation and runner. */
export type PreparedArtifactRenderResults = Map<string, {
  signal?: AbortSignal;
  runner?: PluginProcessRunner;
  promise: Promise<PluginProcessResult>;
}>;

/** One process boundary for all surfaces. Surface owners validate their response schema. */
export async function runPreparedArtifactRenderer(options: {
  plugin: PluginMeta; context: unknown; sensitiveValues: readonly string[]; cwd: string;
  event?: ArtifactRenderEvent; commandEnv?: NodeJS.ProcessEnv; scriptTimeoutMs?: number;
  signal?: AbortSignal; runner?: PluginProcessRunner; preparedResults?: PreparedArtifactRenderResults;
}): Promise<PreparedArtifactRendererResult> {
  options.signal?.throwIfAborted();
  if (!isRecord(options.context) || (options.context.scope !== 'user' && options.context.scope !== 'project')) {
    throw new Error('artifactRendererContextInvalid: A prepared context must contain its render scope.');
  }
  const target = await resolveArtifactRendererTarget(options.plugin);
  if (target.noOp) throw new Error(`Plugin "${options.plugin.manifest.name}" does not declare scripts.artifacts.render.`);
  const context = options.context;
  const scope = options.context.scope;
  const commandEnv = { ...(options.commandEnv ?? process.env) };
  const timeoutMs = resolvePluginScriptTimeoutMs({ cliTimeoutMs: options.scriptTimeoutMs });
  const invocationFor = (tempDir: string) => {
    const isolatedHomes = { awHome: path.join(tempDir, 'aw-home'), codexHome: path.join(tempDir, 'codex-home'),
      claudeHome: path.join(tempDir, 'claude-home') };
    const platform = typeof context.platform === 'string' ? context.platform as PlatformTarget : undefined;
    const env = buildPluginScriptSpawnEnv({ commandEnv, contextPath: path.join(tempDir, 'context.json'),
      tempDir, isolatedHomes, plugin: options.plugin.manifest, event: options.event ?? 'materialize',
      platform, scope, bundleRoot: target.bundleRoot! });
    env.AW_PLUGIN_SURFACE = typeof context.surface === 'string' ? context.surface : 'managed-commands';
    return { isolatedHomes, invocation: buildNodeScriptInvocation({ entryPath: target.entryPath!, cwd: options.cwd,
      env, args: target.entry!.args }) };
  };
  // Bind the actual child environment, not the caller's unused HOME/AW_HOME/etc.
  // Private paths are per invocation and never eligible output resources.
  const preparationKey = options.preparedResults ? artifactValueDigest({
    context, manifestDigest: target.manifestDigest, rendererDigest: target.rendererDigest,
    sourceIdentity: options.plugin.sourceIdentity, logicalIdentity: options.plugin.catalogLogicalIdentity,
    invocation: invocationFor(path.join(os.tmpdir(), 'aw-plugin-artifact-render-request')).invocation,
    timeoutMs, sensitiveValues: options.sensitiveValues,
  }) : undefined;
  const run = async (): Promise<PluginProcessResult> => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-artifact-render-'));
    try {
      const { isolatedHomes, invocation } = invocationFor(tempDir);
      const contextPath = invocation.env.AW_PLUGIN_CONTEXT!;
      await fs.writeJson(contextPath, context, { spaces: 2 });
      await fs.chmod(contextPath, 0o600).catch(() => undefined);
      await preparePluginScriptDirectories(tempDir);
      if (process.platform === 'win32') await prepareWindowsJobHelper();
      for (const location of Object.values(isolatedHomes)) await fs.ensureDir(location);
      options.signal?.throwIfAborted();
      const runOptions = { timeoutMs, maxStdoutBytes: ARTIFACT_RENDERER_MAX_STDOUT_BYTES,
        ...(options.signal ? { signal: options.signal } : {}) };
      return await (options.runner ? options.runner.run(invocation, runOptions)
        : defaultPluginProcessRunner.run(invocation, { ...runOptions, sensitiveValues: options.sensitiveValues }));
    } finally { await fs.remove(tempDir); }
  };
  const existing = preparationKey ? options.preparedResults!.get(preparationKey) : undefined;
  const shared = existing && existing.signal === options.signal && existing.runner === options.runner;
  const pending = shared ? existing : { signal: options.signal, runner: options.runner, promise: run() };
  if (preparationKey && !existing) options.preparedResults!.set(preparationKey, pending);
  try {
    const result = await pending.promise;
    options.signal?.throwIfAborted();
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
    return { value, target, exitCode: result.exitCode, signal: result.signal, stdout, stderr, timedOut: result.timedOut };
  } catch (error) {
    if (preparationKey && options.preparedResults!.get(preparationKey) === pending) {
      options.preparedResults!.delete(preparationKey);
    }
    const message = error instanceof Error ? error.message : String(error);
    const redacted = redactPluginScriptOutput(message, options.sensitiveValues);
    if (redacted === message) throw error;
    const failure = new Error(redacted, { cause: error });
    if (error instanceof Error) failure.name = error.name;
    const diagnostic = readSafeOperationError(error);
    throw diagnostic ? attachSafeOperationError(failure, diagnostic) : failure;
  }
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
  capabilities: PlatformCapabilitiesV2; config: ResolvedArtifactRenderConfig; cwd: string;
  staticResourceRoot?: string; previousComponents?: PlatformRenderContextV2['previousComponents'];
  hasInstructionAgentRecipients?: boolean;
  changedConfigKeys?: string[]; commandEnv?: NodeJS.ProcessEnv; scriptTimeoutMs?: number;
  signal?: AbortSignal; runner?: PluginProcessRunner; preparedResults?: PreparedArtifactRenderResults;
}): Promise<PreparedPlatformComponents> {
  options.signal?.throwIfAborted();
  if (options.capabilities.platform !== options.platform || options.capabilities.scope !== options.renderScope
    || options.config.targetScope !== options.renderScope) throw new Error('componentRenderUnitMismatch: Config and capability scope must match the render unit.');
  const target = await resolveArtifactRendererTarget(options.plugin);
  const sensitiveValues = collectSensitivePluginConfigValues(options.plugin.manifest, options.config.values, options.platform);
  try {
    const capabilities = toPlatformCapabilitiesView(options.capabilities);
    const resources = await resolvePlatformComponentResources(options.plugin);
    const sets: ExpectedComponentSet[] = [await normalizeStaticPluginComponents({
      pluginRoot: options.plugin.rootDir, staticResourceRoot: options.staticResourceRoot, manifest: options.plugin.manifest, platform: options.platform,
      capabilities, allowedOutputKinds: options.kinds, deferPartition: true,
    })];
    const contexts: PlatformRenderContextV2[] = [];
    for (const { allowedOutputKinds, config } of resolvePlatformComponentBatches({ ...options, manifest: options.plugin.manifest })) {
      const keys = options.plugin.manifest.artifacts!.configKeys;
      if (config.issues.length) throw new Error(`Invalid AW config for ${options.plugin.manifest.name}: ${config.issues.map((issue) => issue.path.field).join(', ')}.`);
      const context: PlatformRenderContextV2 = {
        schemaVersion: 2, surface: 'agent-plugin', platform: options.platform, scope: options.renderScope,
        plugin: { pluginId: options.plugin.pluginId ?? `${options.plugin.sourceId ?? 'authoring'}/${options.plugin.manifest.name}`,
          name: options.plugin.manifest.name, version: options.plugin.manifest.version },
        config, changedConfigKeys: (options.changedConfigKeys ?? []).filter((key) => Object.hasOwn(config.sources, key)),
        allowedOutputKinds, platformCapabilities: capabilities, resources,
        previousComponents: (options.previousComponents ?? []).filter((entry) => allowedOutputKinds.includes(entry.kind))
          .map(({ id, kind, name }) => ({ id, kind, name })),
      };
      assertPlatformRenderContext(context);
      contexts.push(context);
      const rendered = await runPreparedArtifactRenderer({ ...options, context, sensitiveValues });
      const plan = validatePlatformComponentPlan({ plan: rendered.value, platform: options.platform, scope: options.renderScope,
        allowedOutputKinds, platformCapabilities: capabilities, configKeys: keys,
        nonSensitiveConfigKeys: selectPlatformRenderConfigKeys({ resolved: options.config, keys, nonSensitive: true }),
        resources, sourceDirs: options.plugin.manifest.artifacts?.sourceDirs,
        requiredAwCapabilities: options.plugin.manifest.requires?.aw.capabilities });
      sets.push({ components: plan.components, omitted: plan.omitted, unmet: plan.unmet,
        sources: Object.fromEntries([...plan.components, ...plan.omitted, ...plan.unmet].map((entry) => [entry.id, 'dynamic' as const])) });
    }
    const declared = mergeExpectedComponentSets(sets);
    assertNoDuplicateHookHandlers(declared.components, options.platform);
    const closure = await verifyPlatformComponentResources({ plugin: options.plugin, expected: declared, resources,
      capabilities, sensitiveValues, staticResourceRoot: options.staticResourceRoot });
    // Only the exact static receipt, already matched to the verified manifest above, is metadata rather than plugin text.
    const scannedComponents = declared.components.map((component) => component.kind === 'skill' && declared.sources[component.id] === 'static'
      ? { ...component, content: { files: Object.fromEntries(Object.entries(component.content.files).filter(([file]) => file !== 'aw-plugin-requirements.json')) } }
      : component);
    assertNoSensitiveConfigValues({ ...declared, components: scannedComponents }, sensitiveValues,
      'componentSensitiveConfigExposed: Components contain sensitive config.');
    const skillTexts = new Map(closure.files.filter(({ path }) => path === 'SKILL.md')
      .map(({ componentId, bytes }) => [componentId, bytes.toString('utf8')]));
    const partition = partitionPluginComponents(declared.components, capabilities, declared.sources, skillTexts, options.hasInstructionAgentRecipients);
    const delivered = new Set(partition.components.map(({ id }) => id));
    const rendererGaps = declared.unmet.map((gap) => {
      if (!gap.componentId || delivered.has(gap.componentId)) return gap;
      // A renderer can split Instruction audiences before AW finds that its remaining body also cannot be delivered.
      const { componentId: _, ...unlinked } = gap;
      return unlinked;
    });
    const expected = mergeExpectedComponentSets([{ ...declared, components: [], unmet: rendererGaps }, partition]);
    // Verify every declared file first. Publish command resources only for their remaining owners.
    closure.files = closure.files.filter(({ componentId }) => delivered.has(componentId));
    closure.commandResources = closure.commandResources.filter(({ componentId }) => delivered.has(componentId));
    closure.bundleFiles = closure.bundleFiles.flatMap((file) => {
      if (!file.componentIds) return [file];
      const componentIds = file.componentIds.filter((id) => delivered.has(id));
      return componentIds.length ? [{ ...file, componentIds }] : [];
    });
    const runtimeConfigSnapshots = createArtifactRuntimeConfigSnapshots({
      sourceId: options.plugin.sourceId, sourceIdentity: options.plugin.sourceIdentity,
      logicalIdentity: options.plugin.catalogLogicalIdentity, manifest: options.plugin.manifest,
      platform: options.platform, scope: options.renderScope, config: options.config, components: expected.components,
    });
    const evidence: PlatformComponentPreparationEvidence = {
      manifestDigest: target.manifestDigest!, ...(target.rendererDigest ? { rendererDigest: target.rendererDigest } : {}),
      configDigest: artifactValueDigest(contexts.map(({ allowedOutputKinds, config }) => ({ allowedOutputKinds, config }))),
      capabilitiesDigest: artifactValueDigest(capabilities), resourceDigest: closure.digest,
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
