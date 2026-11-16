import path from 'node:path';
import fs from 'fs-extra';

import { isCanonicalCodexMarketplaceRegistration } from '../utils/codex-shared-native.js';
import { DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS } from '../constants.js';
import { readCodexConfigFile } from '../utils/codex-config.js';
import { runNativeCli } from '../utils/native-cli.js';
import { createCodexNativeObservationSession } from '../utils/codex-native-observation.js';
import { rethrowFatalError } from '../utils/codex-executable-discovery.js';
import { inspectOwnedComponents, readSkillOwnerMarker } from '../utils/ownership.js';
import { readPlatformPackageContentDigest } from '../utils/platform-empty-state.js';
import { installationInvocation } from './discovery.js';
import type { DeploymentBinding, DeploymentConfigurationObservation, DeploymentObservation, ReadContext } from './contracts.js';
import type { DeploymentLayout } from './layout.js';
import { inspectPiDeployment } from './inspection-pi.js';
import { inspectGrokDeployment } from './inspection-grok.js';
import { getQualifiedPlatformProfile } from './capabilities.js';
import { getPhysicalKey } from './identity.js';
import { queryNativeDeployment } from './inspection-query.js';
import { geminiActivationRules, geminiExtensionPaths, geminiScopePattern, geminiUserActivation,
  readGeminiActivationSnapshot, readGeminiNativeCopyContentDigest } from './gemini-activation.js';

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
  if (!row) { setActivation(result, 'disabled'); return; }
  if (typeof row.enabled !== 'boolean') throw new Error('nativeActivationInvalid');
  setActivation(result, row.enabled ? 'enabled' : 'disabled');
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
      const product = binding.consumers.find((item) => item.entry?.kind === 'cli' && item.availability === 'available');
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
        if (ctx.observeNative && binding.scope.kind === 'project' && product.product === 'cli'
          && product.version === '0.167.0' && getQualifiedPlatformProfile('codex', ctx).qualifiedConsumers?.skill?.some((qualified) =>
            qualified.product === product.product && qualified.version === product.version)) {
          session.setManager(manager);
          const trust = await session.inspectProjectTrust(binding.scope.projectRoot);
          for (const consumer of result.consumers) if (consumer.productId === product.id && consumer.trust === 'unknown'
            && trust.state === 'observed') consumer.trust = trust.trust === 'trusted' ? 'trusted' : 'blocked';
          if (trust.state === 'failed') result.diagnostics.push({ code: 'nativeObservationFailed', severity: 'warning',
            message: 'The native client could not complete its effective project trust observation.',
            subject: { target: binding.platform, pluginId: binding.plugin.pluginId, scope: binding.scope.kind } });
        }
        if (observed.observation.state !== 'observed') {
          result.registration = 'unknown';
          setActivation(result, 'unknown');
          result.diagnostics.push({ code: observed.observation.state === 'failed' ? 'nativeObservationFailed' : 'nativeObservationUnconfirmed',
            severity: 'warning', message: 'The selected native client could not confirm its registration.',
            subject: { target: binding.platform, pluginId: binding.plugin.pluginId, scope: binding.scope.kind } });
          break;
        }
        result.registration = observed.observation.value === 'installed' ? 'present' : 'absent';
        const active = observed.activations[binding.scope.kind];
        setActivation(result, active === true ? 'enabled' : active === false ? 'disabled' : 'unknown');
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
        diagnostic(result, binding, 'nativeMarketplaceUnconfirmed', 'The native marketplace source could not be confirmed. Keep the shared package.');
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
      await inspectConfiguration(ctx, binding, result, async () => {
        const settings = await jsonFile(path.join(layout.activationPath, binding.scope.kind === 'project' ? 'settings.local.json' : 'settings.json'));
        return { activation: configuredActivation(settings.enabledPlugins === undefined ? undefined : object(settings.enabledPlugins)[nativeId]) };
      });
      // These inventories are independent. Finish both reads before returning,
      // including when one fails, so no native read outlives this inspection.
      const [marketplaceRead, pluginsRead] = await Promise.allSettled([
        inspectCopilotMarketplaceSource(ctx, binding, layout.marketplaceName!, layout.marketplaceRoot!),
        queryNativeDeployment(ctx, binding, ['plugin', 'list', '--json']),
      ]);
      const marketplace = marketplaceRead.status === 'fulfilled' ? marketplaceRead.value : 'unknown';
      if (marketplaceRead.status === 'rejected') {
        rethrowFatalError(marketplaceRead.reason); ctx.signal?.throwIfAborted();
        diagnostic(result, binding, 'nativeMarketplaceUnconfirmed', 'The native marketplace source could not be confirmed. Keep the shared package.');
      }
      if (marketplace === 'foreign') result.ownership = 'foreign';
      if (marketplace === 'unknown' && !['foreign', 'shared'].includes(result.ownership)) result.ownership = 'unknown';
      if (pluginsRead.status === 'rejected') throw pluginsRead.reason;
      const matches = rows(pluginsRead.value).filter((row) => row.name === layout.nativeIdentity.packageId && row.marketplace === layout.marketplaceName);
      if (matches.length > 1) throw new Error('nativeIdentityDuplicate');
      result.registration = matches.length ? 'present' : 'absent';
      const row = matches[0];
      if (row && marketplace !== 'canonical' && !nativeSourceMatches(row.source, layout.marketplaceRoot!)
        && !nativeSourceMatches(row.installedFrom, layout.marketplaceRoot!) && !['foreign', 'shared'].includes(result.ownership)) {
        // Unrecognized source shapes remain unknown and cannot authorize mutation.
        result.ownership = 'unknown';
      }
      setActivation(result, row?.enabled === true ? 'enabled' : row?.enabled === false ? 'disabled' : 'unknown');
      break;
    }
    case 'pi-package':
      await inspectPiDeployment(ctx, binding, layout, result);
      break;
    case 'gemini-extension': {
      await inspectConfiguration(ctx, binding, result, async () => {
        const snapshot = await readGeminiActivationSnapshot(ctx);
        const rules = geminiActivationRules(snapshot, nativeId);
        if (binding.scope.kind === 'project') {
          const target = geminiScopePattern(binding.scope.projectRoot);
          const explicit = rules.filter((rule) => rule === target || rule === `!${target}`).at(-1);
          return { activation: explicit === undefined ? 'absent' : explicit === target ? 'enabled' : 'disabled' };
        }
        if (!rules.some((rule) => rule === '*' || rule === '!*')) return { activation: 'absent' };
        const enabled = geminiUserActivation(snapshot, nativeId, geminiExtensionPaths(ctx).home);
        return { activation: enabled === 'unknown' ? 'unknown' : enabled ? 'enabled' : 'disabled' };
      });
      const inventory = rows(await queryNativeDeployment(ctx, binding, ['extensions', 'list', '--output-format', 'json']));
      const matches = inventory.filter((row) => row.name === nativeId);
      if (matches.length > 1) throw new Error('nativeIdentityDuplicate');
      result.registration = matches.length ? 'present' : 'absent';
      const row = matches[0];
      setActivation(result, row?.isActive === true ? 'enabled' : row?.isActive === false ? 'disabled' : 'unknown');
      if (!row) break;
      // Identity and content checks protect mutation. They cannot negate list facts.
      try {
        const { root } = geminiExtensionPaths(ctx);
        const directory = path.join(root, nativeId);
        if (!nativeSourceMatches(row.path, directory)) { result.ownership = 'foreign'; break; }
        const stats = await fs.lstat(directory);
        if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('nativeExtensionPathUnconfirmed');
        const metadata = await jsonFile(path.join(directory, '.gemini-extension-install.json'));
        const manifest = await jsonFile(path.join(directory, 'gemini-extension.json'));
        if (typeof metadata.source !== 'string' || typeof metadata.type !== 'string' || typeof manifest.name !== 'string') {
          throw new Error('nativeExtensionIdentityUnknown');
        }
        if (!['local', 'link'].includes(metadata.type) || !nativeSourceMatches(metadata.source, layout.packageRoot)
          || manifest.name !== nativeId) result.ownership = 'foreign';
        if (result.ownership === 'aw') {
          result.nativePackageContentDigest = await readGeminiNativeCopyContentDigest(ctx, layout.nativeIdentity, {
            owner: 'agent-workflows', plugin: nativeId, pluginId: binding.plugin.pluginId,
            sourceId: binding.plugin.sourceId, sourceIdentity: binding.plugin.sourceIdentity,
            platform: binding.platform, scope: 'user', physicalKey: binding.physicalKey, artifactKey: path.basename(layout.packageRoot),
          });
          if (!result.nativePackageContentDigest) diagnostic(result, binding, 'nativePackageContentUnconfirmed',
            'The installed extension content could not be confirmed. Keep the native copy until its ownership is checked.');
        }
      } catch (error) {
        rethrowFatalError(error); ctx.signal?.throwIfAborted();
        if (!['foreign', 'shared'].includes(result.ownership)) result.ownership = 'unknown';
        diagnostic(result, binding, 'nativePackageContentUnconfirmed', 'The installed extension identity or content could not be read. Native observations are retained.');
      }
      break;
    }
    case 'grok-cli':
    case 'grok-directory':
      await inspectGrokDeployment(ctx, binding, layout, result,
        JSON.parse(await queryNativeDeployment(ctx, binding, ['plugin', 'list', '--json'])),
        JSON.parse(await queryNativeDeployment(ctx, binding, ['inspect', '--json'])));
      break;
    default: break;
  }
}
