import crypto from 'node:crypto';

import type { CliExecutionContext } from '../commands/runtime.js';
import type { PlatformName } from '../types.js';
import { statusCommandV4 } from '../commands/status-v4.js';
import {
  cleanupWriteCommand,
  installWriteCommand,
  reinstallWriteCommand,
  uninstallWriteCommand,
  upgradeWriteCommand,
} from '../commands/write-commands.js';
import { readCliPackageInfo } from '../utils/local-marketplace.js';
import {
  readCatalogSourcesConfigSnapshot,
} from '../utils/catalog-sources.js';
import {
  withResolvedCatalogPlugin,
  withResolvedMultiSourceCatalog,
  parsePluginId,
} from '../utils/multi-source-catalog.js';
import {
  coercePluginConfigUpdates,
  readPluginConfigStore,
  resolveConfigRead,
} from '../utils/plugin-config.js';
import {
  applyPluginConfigWrite,
  resetPluginConfigWithHelper,
} from '../utils/plugin-config-write.js';
import type { RebuildProgressFeed } from '../output/rebuild-progress.js';
import type { RebuildReviewPreflightEvidence } from '../commands/rebuild-command.js';
import {
  acquireLifecycleOperationLock,
} from '../utils/lifecycle-active-store.js';
import { releaseRebuildOperationLease } from '../commands/rebuild-operations.js';
import {
  operationEvidenceFingerprint,
  TuiController,
  TuiOperationBlockedError,
  type OperationEvidence,
  type OperationIntent,
  type TuiControllerDependencies,
} from './controller.js';
import { buildConfigGroups, buildConfigPage } from './model.js';

function digest(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function pluginIntent(intent: OperationIntent): intent is Extract<OperationIntent, { pluginId: string }> {
  return 'pluginId' in intent;
}

function assertIntentIsLegal(
  intent: Extract<OperationIntent, { kind: 'pluginWrite' }>,
  targets: Awaited<ReturnType<typeof statusCommandV4>>['payload']['targets'],
): void {
  const platforms: PlatformName[] = intent.platform === 'both'
    ? ['codex', 'claude']
    : [intent.platform];
  for (const platform of platforms) {
    const selected = targets.find((target) => target.platform === platform && target.scope === intent.scope);
    if (!selected || selected.errors.some((error) => error.code === 'unsupportedTarget')) {
      throw new TuiOperationBlockedError('unsupportedTarget', '所选插件不支持这个平台和使用位置。');
    }
    const otherScopeInstalled = targets.some((target) =>
      target.platform === platform
      && target.scope !== intent.scope
      && target.state !== 'absent');
    if (intent.action === 'install' && otherScopeInstalled) {
      throw new TuiOperationBlockedError('scopeConflict', '这个平台已安装在另一个使用位置。请先移除原位置。');
    }
    if (intent.action === 'install' && selected.state !== 'absent') {
      throw new TuiOperationBlockedError('targetAlreadyInstalled', '所选位置已经安装。');
    }
    if ((intent.action === 'upgrade' || intent.action === 'uninstall') && selected.state !== 'present') {
      throw new TuiOperationBlockedError('targetStateChanged', '当前安装状态不允许执行这个操作。');
    }
    if ((intent.action === 'reinstall' || intent.action === 'cleanup') && selected.state === 'absent') {
      throw new TuiOperationBlockedError('targetAbsent', '所选位置没有可处理的 AW 安装。');
    }
  }
}

function resultFailure(result: {
  overallState?: string;
  targetResults?: Array<{ state?: string; errorCode?: string; message?: string }>;
}): TuiOperationBlockedError | undefined {
  if (result.overallState !== 'failed') return undefined;
  if (result.targetResults?.some((entry) => entry.state === 'completed')) return undefined;
  const failure = result.targetResults?.find((entry) => entry.errorCode || entry.message);
  const prefix = failure?.message?.split(':', 1)[0];
  const code = failure?.errorCode
    ?? (prefix && /^[A-Za-z][A-Za-z0-9]*$/u.test(prefix) ? prefix : 'operationFailed');
  return new TuiOperationBlockedError(
    code,
    failure?.message ?? '底层写命令未完成。',
  );
}

function assertLockedPluginEvidence(
  current: RebuildReviewPreflightEvidence,
  expected: OperationEvidence,
): void {
  const source = expected.source;
  if (!source
    || current.configDigest !== expected.catalog.configDigest
    || current.sourceId !== source.sourceId
    || current.sourceIdentity !== source.sourceIdentity
    || current.resolvedCommit !== source.resolvedCommit
    || current.manifestDigest !== source.manifestDigest
    || current.snapshotDigest !== source.snapshotDigest
    || current.contentDigest !== source.contentDigest) {
    throw new Error('operationReviewStale: 确认后 Catalog 或来源证据发生变化。');
  }
}

export function createTuiControllerDependencies(
  context: CliExecutionContext,
): TuiControllerDependencies {
  const loadStatus: TuiControllerDependencies['loadStatus'] = async (signal) => {
    signal.throwIfAborted();
    const packageInfo = await readCliPackageInfo();
    const result = await statusCommandV4({
      cwd: context.cwd,
      env: context.env,
      cliVersion: packageInfo.version,
      verbose: context.diagnostics.verbose,
    });
    signal.throwIfAborted();
    return { payload: result.payload, pluginSummaries: result.pluginSummaries };
  };

  const captureEvidence: TuiControllerDependencies['captureEvidence'] = async (intent, signal) => {
    if (!pluginIntent(intent)) {
      throw new TuiOperationBlockedError('operationNotImplemented', '这个写操作尚未接入新 Controller。');
    }
    signal?.throwIfAborted();
    const packageInfo = await readCliPackageInfo();
    const status = await statusCommandV4({
      plugins: [intent.pluginId],
      ...('platform' in intent ? { platform: intent.platform } : {}),
      ...(intent.kind !== 'pluginWrite' && intent.scope === 'project'
        ? { scope: intent.scope }
        : {}),
      cwd: context.cwd,
      env: context.env,
      cliVersion: packageInfo.version,
    });
    signal?.throwIfAborted();
    const configSnapshot = await readCatalogSourcesConfigSnapshot(context.env);
    const selected = await withResolvedCatalogPlugin({
      selector: intent.pluginId,
      cliVersion: packageInfo.version,
      freshnessPolicy: 'cacheFirst',
      configSnapshot,
      env: context.env,
      ...(signal ? { signal } : {}),
      consume: ({ plugin, source }) => {
        const entry = source.manifest.entries.find((candidate) => candidate.name === plugin.manifest.name)!;
        return {
          pluginName: plugin.manifest.name,
          source: {
            sourceId: source.sourceId,
            sourceIdentity: source.sourceIdentity,
            requestedRef: source.requestedRef,
            resolvedCommit: source.resolvedCommit,
            manifestDigest: source.manifestDigest,
            snapshotDigest: source.snapshotDigest,
            contentDigest: entry.contentDigest,
          },
        };
      },
    });
    const evidence: OperationEvidence = {
      catalog: {
        configDigest: status.payload.catalog.configDigest,
        compositeDigest: status.payload.catalog.compositeDigest,
      },
      source: selected.source,
      targetFingerprint: digest(status.payload.targets.map((target) => ({
        pluginId: target.pluginId,
        sourceIdentity: target.sourceIdentity,
        platform: target.platform,
        scope: target.scope,
        state: target.state,
        errors: target.errors.map((error) => error.code).sort(),
        components: target.components.map((component) => [component.key, component.state])
          .sort(([left], [right]) => left!.localeCompare(right!, 'en')),
      })).sort((left, right) => [left.pluginId, left.platform, left.scope].join('\0')
        .localeCompare([right.pluginId, right.platform, right.scope].join('\0'), 'en'))),
    };
    if (intent.kind === 'configSave' || intent.kind === 'configReset') {
      const store = await readPluginConfigStore({
        sourceId: selected.source.sourceId,
        sourceIdentity: selected.source.sourceIdentity,
        pluginName: selected.pluginName,
        scope: intent.scope,
        projectLayer: intent.projectLayer,
        cwd: context.cwd,
        env: context.env,
      });
      evidence.config = {
        scope: intent.scope,
        projectLayer: intent.projectLayer,
        schemaIdentity: selected.source.manifestDigest,
        storeDigest: digest({ exists: store.exists, values: store.values }),
      };
    }
    return evidence;
  };

  const dependencies: TuiControllerDependencies = {
    loadStatus,
    async validateIntent(intent, signal) {
      if (intent.kind === 'configSave') {
        const packageInfo = await readCliPackageInfo();
        await withResolvedCatalogPlugin({
          selector: intent.pluginId,
          cliVersion: packageInfo.version,
          freshnessPolicy: 'cacheFirst',
          env: context.env,
          signal,
          consume: async ({ plugin }) => {
            if (!plugin.manifest.config) {
              throw new TuiOperationBlockedError('configSchemaUnavailable', '这个插件没有设置 schema。');
            }
            await coercePluginConfigUpdates({
              schema: plugin.manifest.config.schema,
              updates: intent.updates ?? {},
              cwd: context.cwd,
            });
            for (const key of intent.removeKeys ?? []) {
              if (!plugin.manifest.config.schema[key]) {
                throw new TuiOperationBlockedError('unknownConfigKey', '设置字段已变化，请重新检查。');
              }
            }
          },
        });
        return;
      }
      if (intent.kind !== 'pluginWrite') return;
      signal.throwIfAborted();
      const packageInfo = await readCliPackageInfo();
      const status = await statusCommandV4({
        plugins: [intent.pluginId],
        platform: intent.platform,
        cwd: context.cwd,
        env: context.env,
        cliVersion: packageInfo.version,
      });
      signal.throwIfAborted();
      assertIntentIsLegal(intent, status.payload.targets);
    },
    async checkSource(sourceId, signal) {
      const packageInfo = await readCliPackageInfo();
      const configSnapshot = await readCatalogSourcesConfigSnapshot(context.env);
      await withResolvedMultiSourceCatalog({
        cliVersion: packageInfo.version,
        freshnessPolicy: 'forceRemote',
        sourceIds: [sourceId],
        configSnapshot,
        env: context.env,
        signal,
        consume: (catalog) => {
          const item = catalog.sources[0]!;
          if (item.error) throw item.error;
          return { sourceId: item.sourceId, snapshotDigest: item.resolution!.snapshotDigest };
        },
      });
    },
    captureEvidence,
    logError(error, code, logContext) {
      return context.debugLogger.log({
        type: 'tui:controller-error',
        level: 'debug',
        target: 'debugLog',
        message: logContext?.privateConfigOperation
          ? 'TUI config operation failed.'
          : error instanceof Error ? error.message : String(error),
        data: { code },
      });
    },
    async getConfigGroups(pluginId, layer, signal) {
      const packageInfo = await readCliPackageInfo();
      return withResolvedCatalogPlugin({
        selector: pluginId,
        cliVersion: packageInfo.version,
        freshnessPolicy: 'cacheFirst',
        env: context.env,
        signal,
        consume: async ({ plugin }) => {
          if (!plugin.manifest.config) {
            throw new TuiOperationBlockedError('configSchemaUnavailable', '这个插件没有设置 schema。');
          }
          const read = await resolveConfigRead({
            pluginName: plugin.manifest.name,
            plugin,
            scope: layer.scope,
            projectLayer: layer.projectLayer,
            cwd: context.cwd,
            env: context.env,
          });
          return buildConfigGroups({ schema: plugin.manifest.config, read });
        },
      });
    },
    async getConfigPage(pluginId, layer, signal) {
      const packageInfo = await readCliPackageInfo();
      return withResolvedCatalogPlugin({
        selector: pluginId,
        cliVersion: packageInfo.version,
        freshnessPolicy: 'cacheFirst',
        env: context.env,
        signal,
        consume: async ({ plugin }) => {
          if (!plugin.manifest.config) {
            throw new TuiOperationBlockedError('configSchemaUnavailable', '这个插件没有设置 schema。');
          }
          const read = await resolveConfigRead({
            pluginName: plugin.manifest.name,
            plugin,
            scope: layer.scope,
            projectLayer: layer.projectLayer,
            cwd: context.cwd,
            env: context.env,
          });
          return buildConfigPage({ pluginId, schema: plugin.manifest.config, read });
        },
      });
    },
    async executeIntent(intent, expectedEvidence) {
      const currentEvidence = await captureEvidence(intent);
      if (operationEvidenceFingerprint(currentEvidence) !== operationEvidenceFingerprint(expectedEvidence)) {
        throw new TuiOperationBlockedError('operationReviewStale', '确认后状态发生变化。');
      }
      if (intent.kind === 'pluginWrite') {
        const options = { cwd: context.cwd, platform: intent.platform, scope: intent.scope };
        const command = {
          install: installWriteCommand,
          upgrade: upgradeWriteCommand,
          reinstall: reinstallWriteCommand,
          uninstall: uninstallWriteCommand,
          cleanup: cleanupWriteCommand,
        }[intent.action];
        const source = expectedEvidence.source;
        if (!source) {
          throw new TuiOperationBlockedError('operationReviewStale', '确认信息缺少来源身份。');
        }
        const pluginName = parsePluginId(intent.pluginId).pluginName;
        const platforms: PlatformName[] = intent.platform === 'both'
          ? ['codex', 'claude']
          : [intent.platform];
        const leases: Awaited<ReturnType<typeof acquireLifecycleOperationLock>>[] = [];
        try {
          for (const platform of platforms) {
            for (const scope of ['project', 'user'] as const) {
              leases.push(await acquireLifecycleOperationLock({
                sourceId: source.sourceId,
                sourceIdentity: source.sourceIdentity,
                pluginName,
                platform,
                scope,
                cwd: context.cwd,
                env: context.env,
              }));
            }
          }
          let fullEvidenceChecked = false;
          const result = await command([intent.pluginId], options, {
            ...context,
            operationLeaseHeld: true,
            reviewPreflight: async (current) => {
              assertLockedPluginEvidence(current, expectedEvidence);
              const observed = await captureEvidence(intent);
              const observedFingerprint = operationEvidenceFingerprint(fullEvidenceChecked
                ? { ...observed, targetFingerprint: expectedEvidence.targetFingerprint }
                : observed);
              if (observedFingerprint !== operationEvidenceFingerprint(expectedEvidence)) {
                throw new TuiOperationBlockedError(
                  'operationReviewStale',
                  'operationReviewStale: 确认后状态发生变化。',
                );
              }
              fullEvidenceChecked = true;
            },
          });
          const failure = resultFailure(result);
          if (failure) throw failure;
          return result;
        } finally {
          for (const lease of leases.reverse()) {
            try {
              await releaseRebuildOperationLease(lease);
            } catch (error) {
              try {
                process.emitWarning(
                  `TUI operation lock release failed: ${error instanceof Error ? error.message : String(error)}`,
                  { code: 'AW_TUI_OPERATION_LOCK_RELEASE_FAILED' },
                );
              } catch {
                // Release diagnostics cannot replace a durable write result.
              }
            }
          }
        }
      }
      if (intent.kind === 'configSave' || intent.kind === 'configReset') {
        const packageInfo = await readCliPackageInfo();
        const reviewPreflight = async (): Promise<void> => {
          const lockedEvidence = await captureEvidence(intent);
          if (operationEvidenceFingerprint(lockedEvidence)
            !== operationEvidenceFingerprint(expectedEvidence)) {
            throw new TuiOperationBlockedError('operationReviewStale', '确认后状态发生变化。');
          }
        };
        return withResolvedCatalogPlugin({
          selector: intent.pluginId,
          cliVersion: packageInfo.version,
          freshnessPolicy: intent.kind === 'configSave' ? 'requireRemote' : 'cacheFirst',
          env: context.env,
          consume: async ({ plugin }) => {
            const result = intent.kind === 'configSave'
              ? await applyPluginConfigWrite({
                  plugin,
                  pluginName: plugin.manifest.name,
                  scope: intent.scope,
                  projectLayer: intent.projectLayer,
                  cwd: context.cwd,
                  env: context.env,
                  nativeCliRunner: context.nativeCliRunner,
                  rebuildRuntime: context,
                  request: { updates: intent.updates, removeKeys: intent.removeKeys },
                  reviewPreflight,
                })
              : await resetPluginConfigWithHelper({
                  plugin,
                  pluginName: plugin.manifest.name,
                  scope: intent.scope,
                  projectLayer: intent.projectLayer,
                  cwd: context.cwd,
                  env: context.env,
                  nativeCliRunner: context.nativeCliRunner,
                  rebuildRuntime: context,
                  reviewPreflight,
                });
            return result;
          },
        });
      }
      throw new TuiOperationBlockedError('operationNotImplemented', '这个写操作尚未接入新 Controller。');
    },
  };
  return dependencies;
}

export function createConsoleTuiV4Controller(
  context: CliExecutionContext,
  progressFeed?: RebuildProgressFeed,
): TuiController {
  return new TuiController(createTuiControllerDependencies(context), progressFeed);
}
