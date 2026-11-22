import fs from 'fs-extra';
import {
  getManagedCommandArtifactTargets,
  type CommandRoutes,
  type CommandRoutesArtifact,
} from '@lesliechan721/aw-plugin-core/manifest';

import { validateCommandRoutesPlan } from './artifact-plan.js';
import { resolveArtifactRenderConfig, runPreparedArtifactRenderer, type ArtifactRenderEvent } from './artifact-renderer.js';
import { selectManagedCommandRenderConfig } from './artifact-request.js';
import { ManagedCommandError } from './managed-command-errors.js';
import type { ManagedCommandRoutesRenderOptions } from './managed-command-materialization.js';
import { collectSensitivePluginConfigValues } from './plugin-scripts.js';

export interface ManagedCommandRendererContext {
  event: ArtifactRenderEvent;
  surface: { kind: 'aw'; name: 'managed-commands' };
  scope: 'user';
  plugin: { name: string; version: string; rootDir: string };
  config: ReturnType<typeof selectManagedCommandRenderConfig> & { mode: 'artifact-render'; targetScope: 'user' };
  changedConfigKeys: string[];
  requestedArtifactIds: ['command-routes'];
  previousArtifacts: CommandRoutesArtifact[];
  artifactSources: [];
  commandSources: [{ sourceDir: string }];
  runtimeImports: [];
}

export async function renderManagedCommandRoutes(options: ManagedCommandRoutesRenderOptions): Promise<CommandRoutes> {
  const { plugin, cwd, env, previous, event, signal } = options;
  const { manifest } = plugin;
  const [request] = getManagedCommandArtifactTargets(manifest);
  if (!request) throw new ManagedCommandError('commandDefinitionInvalid', 'The plugin does not declare dynamic command routes.');

  signal?.throwIfAborted();
  const resolved = options.commonConfig ?? await resolveArtifactRenderConfig({ manifest, sourceId: plugin.sourceId,
    sourceIdentity: plugin.sourceIdentity, logicalIdentity: plugin.catalogLogicalIdentity,
    scope: 'user', cwd, env, referencePlugins: options.referencePlugins });
  const config = selectManagedCommandRenderConfig(resolved, request.refreshKeys);
  if (config.issues.length) {
    throw new ManagedCommandError('commandDefinitionInvalid', 'The common configuration for command routes is invalid.');
  }
  const rootDir = await fs.realpath(plugin.rootDir);
  const context: ManagedCommandRendererContext = {
    event, surface: request.surface, scope: 'user', plugin: { name: manifest.name, version: manifest.version, rootDir },
    config: { ...config, mode: 'artifact-render', targetScope: 'user' },
    changedConfigKeys: (options.changedConfigKeys ?? []).filter((key) => Object.hasOwn(config.sources, key)),
    requestedArtifactIds: [request.id],
    previousArtifacts: previous?.dynamicRefreshKeys === undefined ? [] : [{
      id: request.id, target: request.target, kind: request.kind,
      refreshKeys: previous.dynamicRefreshKeys, routes: previous.routes,
    }],
    artifactSources: [], commandSources: [{ sourceDir: options.sourceDir }], runtimeImports: [],
  };
  const result = await runPreparedArtifactRenderer({ plugin, context, event, cwd: rootDir, commandEnv: env,
    signal, scriptTimeoutMs: options.scriptTimeoutMs, sensitiveValues: collectSensitivePluginConfigValues(manifest, resolved.values) });
  signal?.throwIfAborted();
  return validateCommandRoutesPlan(result.value, request.refreshKeys).routes;
}
