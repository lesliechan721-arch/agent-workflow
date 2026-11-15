import path from 'node:path';
import type { Scope, CatalogManifestV7Entry } from '../types.js';
import { commandResult, type CommandResult, type Diagnostic } from '../output/public-result.js';
import { publicDiagnostic, projectTarget } from './public-lifecycle-result.js';
import { createCommandExecutionContext, type CommandExecutionContextInput } from './runtime.js';
import { observeIntent } from '../intent/intent-store.js';
import { observePreferences, normalizeAgents } from '../intent/deployment-preferences.js';
import { resolveWorkContext } from '../intent/work-context.js';
import { resolvePartialCatalogOperationContext } from '../utils/catalog-operation-context.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { readPluginManifest } from '../utils/manifest.js';
import { resolveSupportedPlatforms } from '../utils/platform-support.js';
import { readRecoveryStatus } from '../recovery/status.js';

export interface PublicPluginQueryOptions {
  cwd: string; env?: NodeJS.ProcessEnv; cliVersion?: string; scope?: string; context?: string;
  requested?: boolean; target?: string[]; targets?: string[];
  observeNative?: boolean;
}
function invalid(command: string, field: string, message: string): CommandResult {
  return commandResult(command, {}, { status: 'failed', diagnostics: [{ code: 'invalidOptionValue', severity: 'error', message, subject: { field } }] });
}
function queryFailure(command: string, code: string): CommandResult {
  return commandResult(command, {}, { status: 'blocked', diagnostics: [publicDiagnostic(code)] });
}
function failureCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9-]*$/u.test(code)) return code;
  const prefix = error instanceof Error ? error.message.split(':')[0] : '';
  return prefix && /^[A-Za-z][A-Za-z0-9-]*$/u.test(prefix) ? prefix : fallback;
}
function item(sourceId: string, entry: CatalogManifestV7Entry) {
  return { pluginId: `${sourceId}/${entry.name}`, sourceId, name: entry.name, version: entry.version,
    description: entry.description, category: entry.category, ...(entry.interface ? { interface: entry.interface } : {}),
    tags: entry.tags ?? [], dependencies: entry.dependencies.map((name) => `${sourceId}/${name}`), requires: entry.requires };
}

export async function runPublicPluginList(options: PublicPluginQueryOptions, input: CommandExecutionContextInput = {}): Promise<CommandResult> {
  const command = 'plugin.list'; const env = options.env ?? input.env ?? process.env;
  if (options.scope !== undefined && !['user', 'project'].includes(options.scope)) return invalid(command, 'scope', 'Expected user or project.');
  if (options.requested && !options.scope) return invalid(command, 'scope', 'Requested plugin listing requires an explicit scope.');
  if (!options.requested && options.scope) return invalid(command, 'scope', 'Scope is only valid with --requested.');
  try {
    if (options.requested) {
      await resolveWorkContext({ cwd: options.cwd, scope: options.scope as Scope });
      const observation = await observeIntent({ cwd: options.cwd, env, scope: options.scope as Scope });
      const roots = observation.state === 'valid' ? observation.value.roots.map((root) => root.pluginId) : observation.state === 'absent' ? [] : null;
      return commandResult(command, { requested: true, scope: options.scope, requirements: { state: observation.state, roots }, items: roots?.map((pluginId) => ({ pluginId, sourceId: parsePluginId(pluginId).sourceId!, direct: true })) ?? null },
        { status: roots === null ? 'blocked' : 'success', diagnostics: roots === null ? [publicDiagnostic('pluginIntentStateInvalid')] : [] });
    }
    const catalog = await resolvePartialCatalogOperationContext({ env });
    const valid = catalog.catalog.sources.filter((source) => source.resolution);
    const diagnostics = catalog.catalog.sources.filter((source) => source.error).map((source) => publicDiagnostic('sourceActiveUnavailable', { sourceId: source.sourceId }));
    return commandResult(command, { requested: false, items: valid.flatMap((source) => source.resolution!.manifest.entries.map((entry) => item(source.sourceId, entry))),
      coverage: { sources: valid.map((source) => source.sourceId), complete: diagnostics.length === 0 } },
    { status: diagnostics.length ? valid.length ? 'partial' : 'blocked' : 'success', diagnostics });
  } catch { return queryFailure(command, options.requested ? 'projectRootUnavailable' : 'catalogReadFailed'); }
}

export async function runPublicPluginShow(pluginId: string, options: PublicPluginQueryOptions, input: CommandExecutionContextInput = {}): Promise<CommandResult> {
  const command = 'plugin.show'; const env = options.env ?? input.env ?? process.env;
  let parsed: ReturnType<typeof parsePluginId>;
  try { parsed = parsePluginId(pluginId); } catch { return invalid(command, 'plugin', 'Specify a valid source-qualified plugin ID.'); }
  if (!parsed.sourceId) return invalid(command, 'plugin', 'Plugin show requires a source-qualified plugin ID.');
  try {
    const catalog = await resolvePartialCatalogOperationContext({ env, sourceIds: [parsed.sourceId] });
    const source = catalog.catalog.sources[0]?.resolution;
    if (!source) return queryFailure(command, 'sourceActiveUnavailable');
    const entry = source.manifest.entries.find((entry) => entry.name === parsed.pluginName);
    if (!entry) return queryFailure(command, 'pluginUnavailable');
    const plugin = await readPluginManifest(path.join(source.rootDir, 'plugins', parsed.pluginName), { mode: 'bundle' });
    const manifest = plugin.manifest;
    return commandResult(command, { ...item(parsed.sourceId, entry), targets: [...resolveSupportedPlatforms(manifest)],
      components: {
        skill: { staticDeclared: Boolean(manifest.skills) },
        mcp: { staticDeclared: Boolean(manifest.mcpServers) },
        agent: { staticDeclarations: manifest.extensions?.agents?.length ?? 0 },
        hook: { staticDeclarations: manifest.extensions?.hooks?.length ?? 0,
          nativeDeclarations: Object.fromEntries(Object.entries(manifest.extensions?.nativeHooks ?? {}).map(([platform, entries]) => [platform, entries.length])) },
        instruction: { staticDeclarations: manifest.extensions?.instructions?.length ?? 0 },
      },
      dynamicComponents: { declared: Boolean(manifest.artifacts), state: manifest.artifacts ? 'unprepared' : 'not-declared',
        kinds: manifest.artifacts ? null : [], names: manifest.artifacts ? null : [], count: manifest.artifacts ? null : 0,
        configKeys: manifest.artifacts?.configKeys ?? [], scopes: manifest.artifacts ? manifest.artifacts.scopes ?? ['user', 'project'] : [] },
      invocationPolicy: { declarations: manifest.extensions?.permissions?.length ?? 0 },
      config: { available: Boolean(manifest.config), schemaCommand: ['aw', 'plugin', 'config', 'schema', pluginId] } });
  } catch { return queryFailure(command, 'pluginManifestUnavailable'); }
}

export async function runPublicPluginStatus(plugins: string[], options: PublicPluginQueryOptions, input: CommandExecutionContextInput = {}): Promise<CommandResult> {
  const command = 'plugin.status';
  if (options.context !== undefined && !['user', 'project'].includes(options.context)) return invalid(command, 'context', 'Expected user or project.');
  let filters: string[] | undefined;
  try { if (options.targets ?? options.target) filters = normalizeAgents((options.targets ?? options.target)!); for (const plugin of plugins) parsePluginId(plugin); }
  catch { return invalid(command, 'target', 'Invalid plugin selector or target.'); }
  const observationDiagnostics: Diagnostic[] = options.observeNative ? [{ code: 'nativeObservationSideEffects', severity: 'warning',
    message: 'Native observation can start Codex app-server. It can create an installation ID, logs, SQLite state, and cache, read existing authentication, and access configured cloud services or remote environments.',
    subject: { target: 'codex' } }] : [];
  const context = createCommandExecutionContext({ ...input, env: options.env ?? input.env, interactive: false });
  try {
    const work = await resolveWorkContext({ cwd: options.cwd, context: options.context as Scope | undefined });
    const location = { cwd: work.projectRoot ?? options.cwd, env: context.env };
    const [status, preferences, declarations] = await Promise.all([
      readRecoveryStatus({ ...location, context: work.context, cliVersion: options.cliVersion, nativeCliRunner: context.nativeCliRunner,
        observeNative: options.observeNative }),
      observePreferences({ ...location, scope: 'user' }),
      Promise.all(work.scopes.map(async (scope) => { const observation = await observeIntent({ ...location, scope }); return { scope, state: observation.state,
        roots: observation.state === 'valid' ? observation.value.roots.map((root) => root.pluginId) : observation.state === 'absent' ? [] : null }; })),
    ]);
    const selectedPlugin = (pluginId: string) => !plugins.length || plugins.some((selector) => selector === pluginId || !selector.includes('/') && parsePluginId(pluginId).pluginName === selector);
    const selectedTarget = (target: string | null) => !filters || target !== null && filters.includes(target);
    const inventory = status.inventory?.filter((entry) => selectedPlugin(entry.pluginId)).map((entry) => ({ pluginId: entry.pluginId, sourceId: entry.source, sourceState: entry.sourceState,
      blockerCodes: entry.blockers.map((blocker) => blocker.code), targetResults: entry.targetResults.filter((target) => selectedTarget(target.agent)).map(projectTarget) })) ?? null;
    const diagnostics = [...observationDiagnostics, ...status.errors.map((error) => publicDiagnostic(error))];
    for (const entry of status.inventory ?? []) if (selectedPlugin(entry.pluginId)) {
      diagnostics.push(...entry.blockers.map((error) => publicDiagnostic(error, { pluginId: entry.pluginId })));
      for (const target of entry.targetResults.filter((target) => selectedTarget(target.agent))) {
        const subject = { pluginId: target.pluginId, target: target.agent, scope: target.scope };
        diagnostics.push(...target.blockers.map((error) => publicDiagnostic(error, subject,
          error.code === 'needs-preparation' && ['absent', 'drifted'].includes(target.content ?? '') ? 'warning' : 'error')));
        if (target.agent === 'codex' && target.content === 'unknown' && target.deploymentObservations?.some((deployment) =>
          deployment.after.consumers.some((consumer) => consumer.trust === 'unknown'))) {
          diagnostics.push(publicDiagnostic('nativeTrustUnconfirmed', subject, 'warning'));
        }
      }
    }
    const targets = inventory?.flatMap((entry) => entry.targetResults) ?? [];
    const incomplete = !status.coverage.native || !status.coverage.portable || inventory === null || declarations.some((entry) => entry.roots === null)
      || inventory.some((entry) => entry.sourceState !== 'ready')
      || targets.some((target) => target.content === 'unknown');
    const configurationBlocked = status.errors.some((error) => ['targetsNotConfigured', 'deploymentPreferencesInvalid', 'deploymentPreferencesUnavailable'].includes(error.code));
    const hasSafetyBlocker = (target: (typeof targets)[number]) => target.blockerCodes.some((code) => code !== 'needs-preparation'
      || !['absent', 'drifted'].includes(target.content));
    const hasBlockers = diagnostics.some((entry) => entry.severity === 'error')
      || targets.some((target) => target.content === 'conflict' || hasSafetyBlocker(target));
    const validPartialResults = targets.some((target) => !hasSafetyBlocker(target)
      && target.content !== 'unknown' && target.content !== 'conflict')
      || status.extraObserved.some((target) => selectedPlugin(target.pluginId) && selectedTarget(target.agent)
        && target.observation !== 'unknown' && target.content !== 'conflict');
    return commandResult(command, { context: work.context, requirements: { state: status.intent.state, declarations },
      targetPolicy: { state: preferences.state, targets: preferences.state === 'valid' ? preferences.value.targets : preferences.state === 'absent' ? [] : null,
        exclusions: preferences.state === 'valid' ? preferences.value.exclusions.map(({ plugin, target }) => ({ pluginId: plugin, target })) : preferences.state === 'absent' ? [] : null },
      selection: { plugins, targets: filters ?? status.selection.agents, targetOrigin: filters ? 'argument' : status.selection.origin }, inventory,
      extraObserved: status.extraObserved.filter((entry) => selectedPlugin(entry.pluginId) && selectedTarget(entry.agent)).map(({ pluginId, agent, scope, delivery, observation, content }) => ({ pluginId, target: agent, scope, delivery, observation, content: content ?? 'unknown' })),
      coverage: { scopes: work.scopes, currentProject: work.context === 'project', otherProjects: 'unobserved', native: status.coverage.native, portable: status.coverage.portable },
      counts: { blocked: targets.filter((target) => target.blockerCodes.length).length, pending: targets.filter((target) => target.satisfaction === 'pending').length,
        unconfirmed: targets.filter((target) => target.content === 'unknown').length, ready: targets.filter((target) => target.content === 'satisfied').length },
      allSatisfied: status.allSatisfied, inSync: status.inSync },
    { status: configurationBlocked ? 'blocked' : incomplete || hasBlockers ? validPartialResults ? 'partial' : 'blocked' : 'success', diagnostics: [...new Map(diagnostics.map((entry) => [JSON.stringify(entry), entry])).values()] });
  } catch (error) {
    const result = queryFailure(command, failureCode(error, 'statusUnavailable'));
    result.diagnostics.unshift(...observationDiagnostics);
    return result;
  }
}
