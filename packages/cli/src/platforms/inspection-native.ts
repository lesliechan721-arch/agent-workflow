import path from 'node:path';
import fs from 'fs-extra';

import { isCanonicalCodexMarketplaceRegistration } from '../utils/codex-shared-native.js';
import { DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS } from '../constants.js';
import { readCodexConfigFile } from '../utils/codex-config.js';
import { NativeCliError, runNativeCli } from '../utils/native-cli.js';
import { createCodexNativeObservationSession } from '../utils/codex-native-observation.js';
import { rethrowFatalError } from '../utils/codex-executable-discovery.js';
import { inspectOwnedComponents, readSkillOwnerMarker } from '../utils/ownership.js';
import { readPlatformPackageContentDigest } from '../utils/platform-empty-state.js';
import { installationInvocation, selectNativeProduct } from './discovery.js';
import type { DeploymentBinding, DeploymentConfigurationObservation, DeploymentObservation, ReadContext } from './contracts.js';
import type { DeploymentLayout } from './layout.js';
import { inspectPiDeployment } from './inspection-pi.js';
import { inspectGrokDeployment } from './inspection-grok.js';
import { getPhysicalKey } from './identity.js';
import { queryNativeDeployment } from './inspection-query.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('nativeObservationInvalid');
  return value as Record<string, unknown>;
}
async function jsonFile(file: string): Promise<Record<string, unknown>> {
  try { return object(JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return {}; throw error; }
}
function setActivation(result: DeploymentObservation, activation: DeploymentObservation['consumers'][number]['activation']): void {
  for (const consumer of result.consumers) consumer.activation = activation;
}
function rows(stdout: string): Record<string, unknown>[] {
  const value: unknown = JSON.parse(stdout);
  if (!Array.isArray(value) || value.length > 4096) throw new Error('nativeObservationInvalid');
  return value.map(object);
}
function diagnostic(result: DeploymentObservation, binding: DeploymentBinding, code: string, message: string): void {
  result.diagnostics.push({ code, severity: 'warning', message,
    subject: { target: binding.platform, pluginId: binding.plugin.pluginId, scope: binding.scope.kind } });
}
function marketplaceReadDiagnostic(binding: DeploymentBinding, error: unknown): DeploymentObservation['diagnostics'][number] {
  // Keep ambiguous identities unconfirmed. A reasonCode identifies a failed command or unreadable response.
  const reasonCode = error instanceof NativeCliError ? error.operationDiagnostic.code
    : error instanceof SyntaxError ? 'nativeObservationInvalid'
    : error instanceof Error && ['nativeObservationInvalid', 'nativeObservationOutputLimit'].includes(error.message) ? error.message : undefined;
  return { code: 'nativeMarketplaceUnconfirmed', severity: 'warning',
    message: 'The native marketplace source could not be confirmed. Keep the shared package.',
    subject: { target: binding.platform, pluginId: binding.plugin.pluginId, scope: binding.scope.kind },
    ...(reasonCode ? { detail: { reasonCode } } : {}) };
}
async function inspectConfiguration(ctx: ReadContext, binding: DeploymentBinding, result: DeploymentObservation,
  read: () => Promise<Omit<DeploymentConfigurationObservation, 'scope' | 'reasonCodes'>>): Promise<void> {
  try { result.configuration = { scope: binding.scope.kind, ...await read(), reasonCodes: [] }; }
  catch (error) {
    rethrowFatalError(error); ctx.signal?.throwIfAborted();
    result.configuration = { scope: binding.scope.kind, activation: 'unknown', reasonCodes: ['nativeConfigurationUnreadable'] };
    if (!['foreign', 'shared'].includes(result.ownership)) result.ownership = 'unknown';
    diagnostic(result, binding, 'nativeConfigurationUnreadable', 'Local configuration could not be read. Native observations are retained.');
  }
}
function configuredActivation(value: unknown, allowServerList = false): DeploymentConfigurationObservation['activation'] {
  if (value === undefined) return 'absent';
  if (typeof value === 'boolean') return value ? 'enabled' : 'disabled';
  if (allowServerList && Array.isArray(value) && value.every((item) => typeof item === 'string')) return 'enabled';
  throw new Error('nativeActivationInvalid');
}
async function copilotConfiguredActivation(file: string, nativeId: string): Promise<DeploymentConfigurationObservation['activation']> {
  const settings = await jsonFile(file);
  return configuredActivation(settings.enabledPlugins === undefined ? undefined : object(settings.enabledPlugins)[nativeId]);
}
function nativeSourceMatches(source: unknown, expected: string): boolean {
  return typeof source === 'string' && path.isAbsolute(source) && path.normalize(source) === path.normalize(expected);
}

/** Antigravity lists a source type and a copied package path, not the AW source directory. */
async function inspectAntigravityCopy(binding: DeploymentBinding, layout: DeploymentLayout,
  result: DeploymentObservation, rows: Record<string, unknown>[]): Promise<void> {
  const matches = rows.filter((row) => row.name === layout.nativeIdentity.packageId);
  if (matches.length > 1) throw new Error('nativeIdentityDuplicate');
  result.registration = matches.length ? 'present' : 'absent';
  const row = matches[0];
  const cli = selectNativeProduct(binding.consumers);
  const consumer = result.consumers.find(({ productId }) => productId === cli?.id);
  if (!row) { if (consumer) consumer.activation = 'disabled'; return; }
  if (typeof row.enabled !== 'boolean') throw new Error('nativeActivationInvalid');
  if (consumer) consumer.activation = row.enabled ? 'enabled' : 'disabled';
  const root = layout.physicalIdentity.namespaceRoot;
  const directory = path.join(root, 'plugins', layout.nativeIdentity.packageId);
  if (row.source !== 'antigravity' || row.path !== directory) { result.ownership = 'foreign'; return; }
  if (rows.some((other) => other !== row && nativeSourceMatches(other.path, directory))) {
    result.ownership = 'shared'; return;
  }
  const component = { kind: 'owned-directory' as const, path: directory, allowedRoot: root,
    identity: { owner: 'agent-workflows' as const, plugin: layout.nativeIdentity.packageId,
      sourceId: binding.plugin.sourceId, sourceIdentity: binding.plugin.sourceIdentity, pluginId: binding.plugin.pluginId,
      platform: binding.platform, scope: binding.scope.kind, physicalKey: binding.physicalKey, artifactKey: path.basename(layout.packageRoot) } };
  const inspected = (await inspectOwnedComponents({ components: [component] })).components[0]!;
  result.nativePackage = inspected.state === 'absent' ? 'absent'
    : inspected.state === 'error' ? 'unknown' : 'present';
  if (inspected.state !== 'present') {
    result.ownership = inspected.state === 'foreign' ? 'foreign' : 'unknown';
    return;
  }
  const marker = await readSkillOwnerMarker({ skillRoot: directory, allowedRoot: root, expectedIdentity: component.identity });
  const digest = await readPlatformPackageContentDigest(directory);
  if (!marker?.nativeProjection || getPhysicalKey(marker.nativeProjection.physicalIdentity) !== binding.physicalKey
    || !digest || digest !== marker.nativeProjection.contentDigest) {
    result.ownership = 'unknown';
    result.diagnostics.push({ code: 'nativePackageContentUnconfirmed', severity: 'warning',
      message: 'The Antigravity copy has unconfirmed content. Keep local data and check its ownership before retrying.',
      subject: { target: binding.platform, pluginId: binding.plugin.pluginId, scope: binding.scope.kind } });
    return;
  }
  // The copy's own exact owner remains usable for removal if the AW source is missing.
  if (result.ownership === 'absent') result.ownership = 'aw';
  if (result.ownership !== 'aw') return;
  result.nativePackageContentDigest = digest;
  const sourceDigest = await readPlatformPackageContentDigest(layout.packageRoot);
  const reason = !sourceDigest ? 'nativePackageContentUnconfirmed' : sourceDigest !== digest ? 'nativePackageContentDrift' : null;
  if (reason) {
    result.components = result.components.map((component) => ({ ...component, presence: 'unknown', reasonCodes: [...component.reasonCodes, reason] }));
    result.diagnostics.push({ code: reason, severity: 'warning',
      message: 'The Antigravity copy does not confirm the current AW package bytes. Run sync to refresh the native copy.',
      subject: { target: binding.platform, pluginId: binding.plugin.pluginId, scope: binding.scope.kind } });
  }
}

/** Only documented local-directory marketplace sources can establish ownership. */
export async function inspectClaudeMarketplaceSource(ctx: ReadContext, binding: DeploymentBinding,
  name: string, root: string): Promise<'absent' | 'canonical' | 'foreign'> {
  const inventory = rows(await queryNativeDeployment(ctx, binding, ['plugin', 'marketplace', 'list', '--json']));
  const matching = inventory.filter((row) => row.name === name);
  if (!matching.length) return 'absent';
  if (matching.length !== 1) throw new Error('nativeIdentityDuplicate');
  const row = matching[0]!;
  return row.source === 'directory' && nativeSourceMatches(row.path, root)
    && (row.installLocation === undefined || nativeSourceMatches(row.installLocation, root)) ? 'canonical' : 'foreign';
}

export async function inspectCopilotMarketplaceSource(ctx: ReadContext, binding: DeploymentBinding,
  name: string, root: string): Promise<'absent' | 'canonical' | 'foreign' | 'unknown'> {
  const value: unknown = JSON.parse(await queryNativeDeployment(ctx, binding, ['plugin', 'marketplace', 'list', '--json']));
  if (!Array.isArray(value)) return 'unknown';
  const rows = value.map(object);
  if (rows.some((row) => typeof row.name !== 'string')) return 'unknown';
  const matching = rows.filter((row) => row.name === name);
  if (!matching.length) return 'absent';
  if (matching.length !== 1) return 'unknown';
  const source = matching[0]!.source;
  if (typeof source === 'string') {
    // Copilot 1.0.95 renders directory sources with this display prefix.
    const location = source.startsWith('Local: ') ? source.slice('Local: '.length) : source;
    return nativeSourceMatches(location, root) ? 'canonical' : 'foreign';
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return 'unknown';
  const descriptor = source as Record<string, unknown>;
  if (descriptor.source !== 'directory') return typeof descriptor.source === 'string' ? 'foreign' : 'unknown';
  return nativeSourceMatches(descriptor.path, root) ? 'canonical' : 'foreign';
}

export async function inspectNativeDeployment(ctx: ReadContext, binding: DeploymentBinding,
  layout: DeploymentLayout, result: DeploymentObservation): Promise<void> {
  const nativeId = layout.nativeIdentity.registrationId ?? layout.nativeIdentity.packageId;
  switch (binding.route) {
    case 'codex-marketplace': {
      await inspectConfiguration(ctx, binding, result, async () => {
        const config = await readCodexConfigFile(path.join(layout.activationPath, 'config.toml'));
        const host = binding.scope.kind === 'user' ? config : await readCodexConfigFile(path.join(layout.physicalIdentity.namespaceRoot, 'config.toml'));
        const marketplaces = [host.snapshot, config.snapshot].map((snapshot) => snapshot.marketplaces[layout.marketplaceName!]).filter((entry) => entry !== undefined);
        const marketplace = marketplaces.some((entry) => !isCanonicalCodexMarketplaceRegistration(entry, layout.marketplaceRoot!))
          ? 'foreign' : marketplaces.length ? 'canonical' : 'absent';
        if (marketplace === 'foreign') result.ownership = 'foreign';
        return { activation: configuredActivation(config.snapshot.plugins[nativeId]?.enabled), marketplace };
      });
      const product = selectNativeProduct(binding.consumers);
      if (!product || product.entry?.kind !== 'cli') {
        result.registration = 'unknown';
        setActivation(result, 'unknown');
        result.diagnostics.push({ code: 'nativeEntryUnavailable', severity: 'warning',
          message: 'The native client is unavailable. Its registration and effective activation are unknown.',
          subject: { target: binding.platform, pluginId: binding.plugin.pluginId, scope: binding.scope.kind } });
        break;
      }
      const invocation = await installationInvocation(product, ctx, []);
      const manager = { kind: product.product === 'app' ? 'app' as const : 'system' as const,
        version: product.version ?? 'unknown', command: invocation.command, argsPrefix: invocation.args };
      const session = ctx.codexObservationSession ?? await createCodexNativeObservationSession({ exactCwd: binding.scope.kind === 'project' ? binding.scope.projectRoot : ctx.cwd,
        env: ctx.env ?? process.env, manager,
        runner: async (request) => {
          const response = await runNativeCli({ ...request, signal: ctx.signal, timeoutMs: DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS }, ctx.runner);
          if (Buffer.byteLength(response.stdout) + Buffer.byteLength(response.stderr) > 1024 * 1024) throw new Error('nativeObservationOutputLimit');
          return response;
        } });
      try {
        // inspectPlugin binds both list invocations synchronously before yielding.
        // A concurrent product can invalidate the cache, not change these reads.
        session.setManager(manager);
        const observed = await session.inspectPlugin({ pluginId: nativeId, scope: binding.scope.kind });
        const active = observed.activations[binding.scope.kind];
        setActivation(result, active === true ? 'enabled' : active === false ? 'disabled' : 'unknown');
        if (binding.scope.kind === 'project' && active !== undefined) {
          // Both lists can report enabled from User inheritance alone.
          const independent = active === true && observed.observations.user && observed.activations.user !== true;
          result.scopeActivation = independent ? 'enabled' : active === false ? 'disabled' : 'unknown';
        }
        if (observed.observation.state !== 'observed') {
          result.registration = observed.activations.user !== undefined || observed.activations.project !== undefined ? 'present' : 'unknown';
          result.diagnostics.push({ code: observed.observation.state === 'failed' ? 'nativeObservationFailed' : 'nativeObservationUnconfirmed',
            severity: 'warning', message: 'The selected native client could not confirm its registration.',
            subject: { target: binding.platform, pluginId: binding.plugin.pluginId, scope: binding.scope.kind } });
          break;
        }
        result.registration = observed.observation.value === 'installed' ? 'present' : 'absent';
        if (binding.scope.kind === 'project' && result.registration === 'present'
          && (active === undefined || result.scopeActivation === 'unknown')) {
          diagnostic(result, binding, 'codexProjectActivationUnconfirmed',
            'The scoped Codex plugin list did not confirm the required Project activation. Check the workspace configuration in Codex.');
        }
      } finally { if (!ctx.codexObservationSession) await session.dispose(); }
      break;
    }
    case 'claude-marketplace': {
      result.scopeRegistration = 'unknown';
      await inspectConfiguration(ctx, binding, result, async () => {
        const settings = await jsonFile(path.join(layout.activationPath, binding.scope.kind === 'project' ? 'settings.local.json' : 'settings.json'));
        return { activation: configuredActivation(settings.enabledPlugins === undefined ? undefined : object(settings.enabledPlugins)[nativeId], true) };
      });
      const [marketplaceRead, pluginsRead] = await Promise.allSettled([
        inspectClaudeMarketplaceSource(ctx, binding, layout.marketplaceName!, layout.marketplaceRoot!),
        queryNativeDeployment(ctx, binding, ['plugin', 'list', '--json']),
      ]);
      if (marketplaceRead.status === 'rejected') {
        rethrowFatalError(marketplaceRead.reason); ctx.signal?.throwIfAborted();
        if (!['foreign', 'shared'].includes(result.ownership)) result.ownership = 'unknown';
        result.diagnostics.push(marketplaceReadDiagnostic(binding, marketplaceRead.reason));
      } else if (marketplaceRead.value === 'foreign') result.ownership = 'foreign';
      if (pluginsRead.status === 'rejected') throw pluginsRead.reason;
      const inventory = rows(pluginsRead.value);
      if (inventory.some((row) => row.id === layout.nativeIdentity.packageId)) result.ownership = 'foreign';
      const matching = inventory.filter((row) => row.id === nativeId && (['user', 'managed'].includes(String(row.scope))
        || binding.scope.kind === 'project' && ['project', 'local'].includes(String(row.scope))
          && nativeSourceMatches(row.projectPath, binding.scope.projectRoot)));
      result.registration = matching.length ? 'present' : 'absent';
      result.scopeRegistration = matching.some((row) => binding.scope.kind === 'user' ? row.scope === 'user'
        : row.scope === 'local' && nativeSourceMatches(row.projectPath, binding.scope.projectRoot)) ? 'present' : 'absent';
      const states = matching.map((row) => row.enabled);
      setActivation(result, states.length && states.every((enabled) => enabled === true) ? 'enabled'
        : states.length && states.every((enabled) => enabled === false) ? 'disabled' : 'unknown');
      // The native path identifies the actual folder used for in-place loading.
      if (matching.some((row) => row.readFromFolder !== undefined && !nativeSourceMatches(row.readFromFolder, layout.packageRoot))) result.ownership = 'foreign';
      if (matching.length && marketplaceRead.status === 'fulfilled' && marketplaceRead.value === 'absent'
        && matching.some((row) => !nativeSourceMatches(row.readFromFolder, layout.packageRoot))
        && !['foreign', 'shared'].includes(result.ownership)) result.ownership = 'unknown';
      break;
    }
    case 'antigravity-cli': {
      const value: unknown = JSON.parse(await queryNativeDeployment(ctx, binding, ['plugin', 'list', '--json']));
      if (!Array.isArray(value) || value.length > 4096) throw new Error('nativeObservationInvalid');
      await inspectAntigravityCopy(binding, layout, result, value.map(object));
      break;
    }
    case 'copilot-marketplace': {
      const settingsPath = path.join(layout.activationPath, binding.scope.kind === 'project' ? 'settings.local.json' : 'settings.json');
      await inspectConfiguration(ctx, binding, result, async () => ({ activation: await copilotConfiguredActivation(settingsPath, nativeId) }));
      // These inventories are independent. Finish both reads before returning,
      // including when one fails, so no native read outlives this inspection.
      const [marketplaceRead, pluginsRead] = await Promise.allSettled([
        inspectCopilotMarketplaceSource(ctx, binding, layout.marketplaceName!, layout.marketplaceRoot!),
        queryNativeDeployment(ctx, binding, ['plugin', 'list', '--json']),
      ]);
      const marketplace = marketplaceRead.status === 'fulfilled' ? marketplaceRead.value : 'unknown';
      if (marketplaceRead.status === 'rejected') {
        const error = marketplaceRead.reason;
        rethrowFatalError(error); ctx.signal?.throwIfAborted();
        result.diagnostics.push(marketplaceReadDiagnostic(binding, error));
      }
      if (marketplace === 'foreign') result.ownership = 'foreign';
      if (marketplace === 'unknown' && !['foreign', 'shared'].includes(result.ownership)) result.ownership = 'unknown';
      if (pluginsRead.status === 'rejected') throw pluginsRead.reason;
      const matches = rows(pluginsRead.value).filter((row) => row.name === layout.nativeIdentity.packageId && row.marketplace === layout.marketplaceName);
      if (matches.length > 1) throw new Error('nativeIdentityDuplicate');
      const row = matches[0];
      result.registration = row ? 'present' : 'absent';
      if (!row) break;
      if (row.source === 'live') {
        const location = row.installedFrom;
        const exactSource = nativeSourceMatches(location, layout.marketplaceRoot!);
        if (!exactSource && typeof location === 'string' && path.isAbsolute(location)) result.ownership = 'foreign';
        else if ((!exactSource || marketplace !== 'canonical') && !['foreign', 'shared'].includes(result.ownership)) result.ownership = 'unknown';
        if (exactSource && marketplace === 'canonical' && row.enabled === false && result.package === 'absent'
          && result.ownership === 'absent' && result.configuration?.activation === 'absent') {
          // Registering a local marketplace can list its unpublished siblings.
          // Require the exact source, missing live package and no scope entry.
          if (binding.scope.kind === 'user') {
            result.registration = 'absent';
            break;
          }
          const otherActivations = await Promise.all([
            copilotConfiguredActivation(path.join(layout.physicalIdentity.namespaceRoot, 'settings.json'), nativeId),
            copilotConfiguredActivation(path.join(layout.activationPath, 'settings.json'), nativeId),
          ]).catch((error) => {
            rethrowFatalError(error); ctx.signal?.throwIfAborted();
            result.registration = 'unknown';
            result.ownership = 'unknown';
            diagnostic(result, binding, 'nativeConfigurationUnreadable', 'The other Copilot settings layers could not be read. Registration is unknown.');
            return null;
          });
          if (!otherActivations) break;
          if (otherActivations.every((activation) => activation === 'absent')) {
            result.registration = 'absent';
            break;
          }
        }
      } else if (marketplace !== 'canonical' && !nativeSourceMatches(row.source, layout.marketplaceRoot!)
        && !nativeSourceMatches(row.installedFrom, layout.marketplaceRoot!) && !['foreign', 'shared'].includes(result.ownership)) {
        // Unrecognized source shapes remain unknown and cannot authorize mutation.
        result.ownership = 'unknown';
      }
      setActivation(result, row.enabled === true ? 'enabled' : row.enabled === false ? 'disabled' : 'unknown');
      break;
    }
    case 'pi-package':
      await inspectPiDeployment(ctx, binding, layout, result);
      break;
    case 'grok-cli':
    case 'grok-directory':
      await inspectGrokDeployment(ctx, binding, layout, result);
      break;
    default: break;
  }
}
