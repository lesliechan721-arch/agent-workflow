import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import type {
  ArtifactPlan,
  ArtifactSurface,
  DistributionName,
  PlatformName,
  PluginArtifactRenderScriptEntry,
  PluginConfigSchema,
  NormalizedPluginManifest,
  PluginMeta,
  Scope,
} from '../types.js';
import type {
  PluginConfigIssue,
  PluginConfigSource,
  PluginConfigStore,
  PluginConfigValue,
} from './plugin-config.js';
import {
  assertReadyPluginConfigStore,
  readPluginConfigStore,
  resolveEffectivePluginConfig,
} from './plugin-config.js';
import {
  assertNoSensitiveConfigValues,
  buildNodeScriptInvocation,
  buildPluginScriptSpawnEnv,
  calculateFileDigest,
  collectSensitivePluginConfigValues,
  defaultPluginProcessRunner,
  redactPluginScriptOutput,
  resolveBundledPluginFilePath,
  resolvePluginScriptTimeoutMs,
  summarizePluginScriptOutput,
  truncatePluginScriptOutput,
  type PluginProcessRunner,
  type PluginProcessResult,
  type PluginScriptInvocation,
} from './plugin-scripts.js';
import { getArtifactSourceBundleRelativePath } from './artifact-sources.js';
import { resolveArtifactRequest } from './artifact-request.js';
import { validateArtifactPlan } from './artifact-plan.js';

export type ArtifactRenderEvent = 'install' | 'refresh' | 'materialize';

export interface ResolvedArtifactRenderConfig {
  mode: 'artifact-render';
  targetScope: Scope;
  schema?: PluginConfigSchema['fields'];
  values: Record<string, PluginConfigValue>;
  sources: Record<string, PluginConfigSource>;
  issues: PluginConfigIssue[];
  stores: Partial<Record<Scope, PluginConfigStore>>;
}

export interface ArtifactRendererContext {
  event: ArtifactRenderEvent;
  surface: ArtifactSurface;
  platform?: PlatformName;
  distribution?: DistributionName;
  scope: Scope;
  plugin: {
    name: string;
    version: string;
    rootDir: string;
  };
  config: {
    mode: 'artifact-render';
    targetScope: Scope;
    schema?: PluginConfigSchema['fields'];
    values: Record<string, PluginConfigValue>;
    sources: Record<string, PluginConfigSource>;
    issues: PluginConfigIssue[];
  };
  changedConfigKeys: string[];
  requestedArtifactIds: string[];
  previousArtifacts: unknown[];
  artifactSources: Array<{
    id: string;
    target: string;
    sourceDirs: string[];
  }>;
  runtimeImports: Array<{
    artifactId: string;
    name: string;
    providerPluginId: string;
    exportName: string;
    path: string;
    digest: string;
  }>;
  paths: {
    awHome: string;
    codexHome: string;
    claudeHome: string;
    manifestPath: string;
  };
  renderer: {
    runner: PluginArtifactRenderScriptEntry['runner'];
    path: string;
    args: string[];
    manifestDigest: string;
    rendererDigest: string;
  };
}

export interface ArtifactRendererTarget {
  noOp: boolean;
  entry?: PluginArtifactRenderScriptEntry;
  entryPath?: string;
  bundleRoot?: string;
  sourceManifest?: NormalizedPluginManifest;
  manifestPath?: string;
  manifestDigest?: string;
  rendererDigest?: string;
}

export interface WrittenArtifactRendererContext {
  context: ArtifactRendererContext;
  contextPath: string;
  tempDir: string;
  sensitiveValues: string[];
  cleanup: () => Promise<void>;
}

export interface RunArtifactRendererResult {
  plan: ArtifactPlan;
  target: ArtifactRendererTarget;
  context: ArtifactRendererContext;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const SUPPORTED_ARTIFACT_RENDER_EVENTS = new Set<ArtifactRenderEvent>([
  'install',
  'refresh',
  'materialize',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertArtifactRenderEvent(value: string): ArtifactRenderEvent {
  if (!SUPPORTED_ARTIFACT_RENDER_EVENTS.has(value as ArtifactRenderEvent)) {
    throw new Error(
      `Artifact renderer only supports install, refresh, and materialize events; received "${value}".`,
    );
  }
  return value as ArtifactRenderEvent;
}

function selectConfigKeys<Value>(
  values: Record<string, Value>,
  selectedKeys: ReadonlySet<string>,
): Record<string, Value> {
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => selectedKeys.has(key)),
  );
}

export async function resolveArtifactRenderConfig(options: {
  sourceId?: string;
  sourceIdentity?: string;
  logicalIdentity?: string;
  pluginName?: string;
  manifest: NormalizedPluginManifest;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedArtifactRenderConfig> {
  const pluginName = options.pluginName ?? options.manifest.name;
  const schema = options.manifest.config?.fields;
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
    const projectStore = options.scope === 'user'
      ? undefined
      : await readPluginConfigStore({
          sourceId: options.sourceId,
          sourceIdentity: options.sourceIdentity,
          logicalIdentity: options.logicalIdentity,
          pluginName,
          scope: 'project',
          cwd: options.cwd,
          env: options.env,
        });
    assertReadyPluginConfigStore(userStore);
    if (projectStore) assertReadyPluginConfigStore(projectStore);
    return {
      mode: 'artifact-render',
      targetScope: options.scope,
      schema: undefined,
      values: {},
      sources: {},
      issues: [],
      stores: {
        user: userStore,
        ...(projectStore ? { project: projectStore } : {}),
      },
    };
  }

  const effective = await resolveEffectivePluginConfig({
    sourceId: options.sourceId,
    sourceIdentity: options.sourceIdentity,
    logicalIdentity: options.logicalIdentity,
    pluginName,
    manifest: options.manifest,
    targetScope: options.scope,
    cwd: options.cwd,
    env: options.env,
  });

  return {
    mode: 'artifact-render',
    targetScope: options.scope,
    schema,
    values: effective.values,
    sources: effective.sources,
    issues: effective.issues,
    stores: effective.stores,
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

export async function writeArtifactRendererContext(options: {
  sourceId?: string;
  sourceIdentity?: string;
  logicalIdentity?: string;
  target: ArtifactRendererTarget;
  event: ArtifactRenderEvent;
  platform: PlatformName | DistributionName;
  scope: Scope;
  configScope?: Scope;
  cwd: string;
  commandEnv: NodeJS.ProcessEnv;
  changedConfigKeys?: string[];
  previousArtifacts?: unknown[];
  requestedArtifactIds: readonly string[];
}): Promise<WrittenArtifactRendererContext> {
  const event = assertArtifactRenderEvent(options.event);
  if (
    options.target.noOp ||
    !options.target.entry ||
    !options.target.entryPath ||
    !options.target.bundleRoot ||
    !options.target.sourceManifest ||
    !options.target.manifestPath ||
    !options.target.manifestDigest ||
    !options.target.rendererDigest
  ) {
    throw new Error('Cannot write artifact renderer context for a no-op target.');
  }

  const distribution = options.platform === 'agent-skills' ? options.platform : undefined;
  const platform = distribution ? undefined : options.platform as PlatformName;
  const request = resolveArtifactRequest({
    manifest: options.target.sourceManifest,
    platform: options.platform,
    scope: options.scope,
    requestedArtifactIds: options.requestedArtifactIds,
  });
  const requestedConfigKeys = new Set(
    request.declarations.flatMap((target) => target.refreshKeys),
  );
  const config = await resolveArtifactRenderConfig({
    sourceId: options.sourceId,
    sourceIdentity: options.sourceIdentity,
    logicalIdentity: options.logicalIdentity,
    pluginName: options.target.sourceManifest.name,
    manifest: options.target.sourceManifest,
    scope: options.configScope ?? options.scope,
    cwd: options.cwd,
    env: options.commandEnv,
  });
  const rendererConfig = {
    mode: config.mode,
    targetScope: config.targetScope,
    schema: config.schema === undefined
      ? undefined
      : selectConfigKeys(config.schema, requestedConfigKeys),
    values: selectConfigKeys(config.values, requestedConfigKeys),
    sources: selectConfigKeys(config.sources, requestedConfigKeys),
    issues: config.issues.filter((issue) => requestedConfigKeys.has(issue.key)),
  };

  const artifactSources = await Promise.all(
    request.declarations
      .map(async (target) => ({
        id: target.id,
        target: target.target,
        sourceDirs: await Promise.all(
          (target.sourceDirs ?? []).map((_, index) =>
            resolveBundledPluginFilePath({
              bundleRoot: options.target.bundleRoot!,
              pluginRelativePath: `./${getArtifactSourceBundleRelativePath({
                platform: target.platform,
                distribution: target.distribution,
                artifactId: target.id,
                index,
              })}`,
              fieldName: `Artifact source ${target.id}[${index}]`,
            }),
          ),
        ),
      })),
  );

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-artifact-render-'));
  try {
    const context: ArtifactRendererContext = {
      event,
      surface: distribution
        ? { kind: 'distribution', name: distribution }
        : { kind: 'platform', name: platform! },
      platform,
      distribution,
      scope: options.scope,
      plugin: {
        name: options.target.sourceManifest.name,
        version: options.target.sourceManifest.version,
        rootDir: options.target.bundleRoot,
      },
      config: rendererConfig,
      changedConfigKeys: (options.changedConfigKeys ?? [])
        .filter((key) => requestedConfigKeys.has(key)),
      requestedArtifactIds: request.requestedArtifactIds,
      previousArtifacts: options.previousArtifacts ?? [],
      artifactSources,
      runtimeImports: request.declarations
        .flatMap((target) => (target.runtimeImports ?? []).map((runtimeImport) => {
          if (!runtimeImport.resolved) {
            throw new Error(`Artifact runtime import "${target.id}/${runtimeImport.name}" is not resolved in the bundle.`);
          }
          return {
            artifactId: target.id,
            name: runtimeImport.name,
            providerPluginId: runtimeImport.resolved.providerPluginId,
            exportName: runtimeImport.export,
            path: path.join(options.target.bundleRoot!, runtimeImport.resolved.path.replace(/^\.\//u, '')),
            digest: runtimeImport.resolved.digest,
          };
        })),
      paths: {
        awHome: path.join(tempDir, 'aw-home'),
        codexHome: path.join(tempDir, 'codex-home'),
        claudeHome: path.join(tempDir, 'claude-home'),
        manifestPath: options.target.manifestPath,
      },
      renderer: {
        runner: options.target.entry.runner,
        path: options.target.entryPath,
        args: options.target.entry.args ?? [],
        manifestDigest: options.target.manifestDigest,
        rendererDigest: options.target.rendererDigest,
      },
    };

    const contextPath = path.join(tempDir, 'context.json');
    await fs.writeJson(contextPath, context, { spaces: 2 });
    try {
      await fs.chmod(contextPath, 0o600);
    } catch {
      // Best effort on non-POSIX filesystems.
    }

    return {
      context,
      contextPath,
      tempDir,
      sensitiveValues: collectSensitivePluginConfigValues(
        options.target.sourceManifest,
        config.values,
      ),
      cleanup: async () => {
        await fs.remove(tempDir);
      },
    };
  } catch (error) {
    await fs.remove(tempDir).catch(() => undefined);
    throw error;
  }
}

function summarizeRenderOutput(value: string, sensitiveValues: readonly string[]): string {
  const summary = summarizePluginScriptOutput(value, sensitiveValues);
  return summary === '' ? '<empty>' : summary;
}

function assertArtifactPlanEnvelope(
  value: unknown,
  output: { stdoutSummary: string; stderrSummary: string },
): ArtifactPlan {
  if (!isRecord(value)) {
    throw new Error(
      `Artifact renderer must write a JSON object to stdout. stdout: ${output.stdoutSummary}. stderr: ${output.stderrSummary}`,
    );
  }
  if (value.version !== 2) {
    const migrationHint = value.version === 1
      ? ' ArtifactPlan V1 is not supported by AW 1.0.0-beta.30; upgrade or reinstall the plugin.'
      : '';
    throw new Error(
      `Artifact renderer returned unsupported plan version "${String(value.version)}".${migrationHint} stderr: ${output.stderrSummary}`,
    );
  }
  if (!Array.isArray(value.artifacts)) {
    throw new Error(
      `Artifact renderer returned an invalid plan: "artifacts" must be an array. stdout: ${output.stdoutSummary}. stderr: ${output.stderrSummary}`,
    );
  }
  return value as unknown as ArtifactPlan;
}

function buildArtifactRendererInvocation(options: {
  entry: PluginArtifactRenderScriptEntry;
  entryPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): PluginScriptInvocation {
  return buildNodeScriptInvocation({
    entryPath: options.entryPath,
    cwd: options.cwd,
    env: options.env,
    args: options.entry.args,
  });
}

function assertRefreshKeysForEvent(
  event: string,
  changedConfigKeys: readonly string[] | undefined,
): string[] {
  assertArtifactRenderEvent(event);
  const keys = changedConfigKeys ? [...changedConfigKeys] : [];
  if (event === 'refresh' && keys.length === 0) {
    throw new Error('Artifact renderer refresh requires changedConfigKeys.');
  }
  return keys;
}

async function runArtifactRendererProcess(options: {
  invocation: PluginScriptInvocation;
  timeoutMs: number;
  sensitiveValues: readonly string[];
  signal?: AbortSignal;
  runner?: PluginProcessRunner;
}): Promise<PluginProcessResult> {
  const runOptions = {
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  return options.runner
    ? options.runner.run(options.invocation, runOptions)
    : defaultPluginProcessRunner.run(options.invocation, {
        ...runOptions,
        sensitiveValues: options.sensitiveValues,
      });
}

export async function runArtifactRenderer(options: {
  event: ArtifactRenderEvent;
  plugin: PluginMeta;
  platform: PlatformName | DistributionName;
  scope: Scope;
  configScope?: Scope;
  cwd: string;
  commandEnv?: NodeJS.ProcessEnv;
  changedConfigKeys?: string[];
  previousArtifacts?: unknown[];
  requestedArtifactIds: readonly string[];
  scriptTimeoutMs?: number;
  signal?: AbortSignal;
  runner?: PluginProcessRunner;
}): Promise<RunArtifactRendererResult> {
  options.signal?.throwIfAborted();
  const event = assertArtifactRenderEvent(options.event);
  const commandEnv = options.commandEnv ?? process.env;
  const changedConfigKeys = assertRefreshKeysForEvent(
    event,
    options.changedConfigKeys,
  );
  const target = await resolveArtifactRendererTarget(options.plugin);
  if (target.noOp) {
    throw new Error(`Plugin "${options.plugin.manifest.name}" does not declare scripts.artifacts.render.`);
  }

  const writtenContext = await writeArtifactRendererContext({
    sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity,
    logicalIdentity: options.plugin.catalogLogicalIdentity,
    target,
    event,
    platform: options.platform,
    scope: options.scope,
    ...(options.configScope ? { configScope: options.configScope } : {}),
    cwd: options.cwd,
    commandEnv,
    changedConfigKeys,
    previousArtifacts: options.previousArtifacts,
    requestedArtifactIds: options.requestedArtifactIds,
  });

  try {
    if (writtenContext.context.config.issues.length > 0) {
      throw new Error(
        `Invalid AW config for ${writtenContext.context.plugin.name}: ${writtenContext.context.config.issues.map((issue) => `${issue.key} (${issue.type})`).join(', ')}.`,
      );
    }
    await Promise.all([
      fs.ensureDir(path.join(writtenContext.tempDir, 'home')),
      fs.ensureDir(path.join(writtenContext.tempDir, 'tmp')),
      fs.ensureDir(writtenContext.context.paths.awHome),
      fs.ensureDir(writtenContext.context.paths.codexHome),
      fs.ensureDir(writtenContext.context.paths.claudeHome),
    ]);
    const timeoutMs = resolvePluginScriptTimeoutMs({
      cliTimeoutMs: options.scriptTimeoutMs,
      manifestTimeoutMs: undefined,
    });
    const spawnEnv = buildPluginScriptSpawnEnv({
      commandEnv: {
        ...commandEnv,
        AW_HOME: writtenContext.context.paths.awHome,
        AW_CODEX_HOME: writtenContext.context.paths.codexHome,
        AW_CLAUDE_HOME: writtenContext.context.paths.claudeHome,
      },
      contextPath: writtenContext.contextPath,
      tempDir: writtenContext.tempDir,
      plugin: writtenContext.context.plugin,
      event,
      ...(options.platform === 'agent-skills'
        ? { distribution: options.platform }
        : { platform: options.platform }),
      scope: options.scope,
      bundleRoot: writtenContext.context.plugin.rootDir,
    });
    const invocation = buildArtifactRendererInvocation({
      entry: target.entry!,
      entryPath: target.entryPath!,
      cwd: options.cwd,
      env: spawnEnv,
    });

    const result = await runArtifactRendererProcess({
      invocation,
      timeoutMs,
      sensitiveValues: writtenContext.sensitiveValues,
      signal: options.signal,
      runner: options.runner,
    });
    const stdoutSummary = summarizeRenderOutput(
      result.stdout,
      writtenContext.sensitiveValues,
    );
    const stderrSummary = summarizeRenderOutput(
      result.stderr,
      writtenContext.sensitiveValues,
    );

    if (result.timedOut) {
      throw new Error(
        `Artifact renderer timed out after ${timeoutMs} ms. stderr: ${stderrSummary}`,
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Artifact renderer failed with exit code ${result.exitCode}. stderr: ${stderrSummary}`,
      );
    }

    const rawStdout = truncatePluginScriptOutput(result.stdout).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawStdout);
    } catch {
      throw new Error(
        `Artifact renderer must write JSON to stdout. stdout: ${stdoutSummary}. stderr: ${stderrSummary}`,
      );
    }

    let plan: ArtifactPlan;
    try {
      assertNoSensitiveConfigValues(
        parsed,
        writtenContext.sensitiveValues,
        'artifactRendererSensitiveConfigExposed: Artifact renderer output contains sensitive config.',
      );
      plan = assertArtifactPlanEnvelope(parsed, {
        stdoutSummary,
        stderrSummary,
      });
      validateArtifactPlan({
        manifest: options.plugin.manifest,
        plan,
        platform: options.platform,
        scope: options.scope,
        requestedArtifactIds: writtenContext.context.requestedArtifactIds,
        renderConfig: writtenContext.context.config,
        rendererDigest: target.rendererDigest,
        manifestDigest: target.manifestDigest,
      });
    } catch (error) {
      throw new Error(redactPluginScriptOutput(
        error instanceof Error ? error.message : String(error),
        writtenContext.sensitiveValues,
      ));
    }

    return {
      plan,
      target,
      context: writtenContext.context,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: stdoutSummary,
      stderr: stderrSummary,
      timedOut: result.timedOut,
    };
  } finally {
    await writtenContext.cleanup();
  }
}
