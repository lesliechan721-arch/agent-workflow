import path from 'node:path';
import fs from 'fs-extra';

import { isCanonicalCodexMarketplaceRegistration } from '../utils/codex-shared-native.js';
import { readCodexConfigFile, readCodexPluginTable, type CodexMarketplaceSnapshot } from '../utils/codex-config.js';
import { canonicalMarketplaceRegistrationPath } from '../utils/local-marketplace.js';
import { resolveAwHome, resolveClaudeProjectKey } from '../utils/state-paths.js';
import { NativeCliError } from '../utils/native-cli.js';
import { createCodexNativeObservationSession } from '../utils/codex-native-observation.js';
import { rethrowFatalError } from '../utils/codex-executable-discovery.js';
import { inspectOwnedComponents, readSkillOwnerMarker } from '../utils/ownership.js';
import { readPlatformPackageContentDigest } from '../utils/platform-empty-state.js';
import { installationInvocation, selectNativeProduct } from './discovery.js';
import type { DeploymentBinding, DeploymentConfigurationObservation, DeploymentObservation, ReadContext } from './contracts.js';
import type { DeploymentLayout } from './layout.js';
import { inspectPiDeployment } from './inspection-pi.js';
import { inspectGrokDeployment } from './inspection-grok.js';
import { canonicalNamespaceRoot, getPhysicalKey, identityDigest } from './identity.js';
import { queryNativeDeployment } from './inspection-query.js';
import { assertSafeFileMutationPath } from '../utils/safe-fs.js';
import { inspectRetirementMarketplace, sharedMarketplaceRoute } from './retirement-native.js';

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

/** Read both the materialized marketplace and declarations; a conflicting layer is never authority. */
async function claudeKnownMarketplace(binding: DeploymentBinding, layout: DeploymentLayout, pathMatches: typeof nativeSourceMatches): Promise<'absent' | 'canonical' | 'foreign'> {
  const root = layout.physicalIdentity.namespaceRoot;
  const name = layout.marketplaceName!;
  const expected = layout.marketplaceRoot!;
  const knownFile = path.join(root, 'plugins', 'known_marketplaces.json');
  await assertSafeFileMutationPath({ filePath: knownFile, allowedRoot: root, label: 'Claude known marketplaces' });
  const known = await jsonFile(knownFile);
  const matches = (value: unknown): boolean => {
    if (typeof value === 'string') return pathMatches(value, expected);
    const descriptor = object(value);
    if (descriptor.path !== undefined && !pathMatches(descriptor.path, expected)
      || descriptor.installLocation !== undefined && !pathMatches(descriptor.installLocation, expected)) return false;
    if (descriptor.source && typeof descriptor.source === 'object') return matches(descriptor.source);
    return descriptor.source === 'directory' && pathMatches(descriptor.path, expected);
  };
  const registrations = [known[name], known.marketplaces === undefined ? undefined : object(known.marketplaces)[name]]
    .filter((value) => value !== undefined);
  for (const value of registrations) {
    const entry = object(value);
    if (entry.installLocation === undefined && entry.source === undefined
      || entry.path !== undefined && !pathMatches(entry.path, expected)
      || entry.installLocation !== undefined && !pathMatches(entry.installLocation, expected)
      || entry.source !== undefined && !matches(entry.source)) return 'foreign';
  }
  const settingsFiles = [{ file: path.join(root, 'settings.json'), allowedRoot: root }];
  if (binding.scope.kind === 'project') {
    for (const file of ['settings.json', 'settings.local.json']) {
      settingsFiles.push({ file: path.join(binding.scope.projectRoot, '.claude', file), allowedRoot: binding.scope.projectRoot });
    }
  }
  for (const { file, allowedRoot } of settingsFiles) {
    await assertSafeFileMutationPath({ filePath: file, allowedRoot, label: 'Claude retirement settings' });
    const settings = await jsonFile(file);
    const declaration = settings.extraKnownMarketplaces === undefined ? undefined : object(settings.extraKnownMarketplaces)[name];
    if (declaration !== undefined && !matches(declaration)) return 'foreign';
  }
  return registrations.length ? 'canonical' : 'absent';
}

/** Claude's disk list can include managed policy and local registrations hidden in other projects. */
function claudeInstalledRows(plugins: unknown, id: string, name: string, marketplace: string): Record<string, unknown>[] {
  const matches: Record<string, unknown>[] = [];
  for (const [key, raw] of Object.entries(object(plugins))) {
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      const row = object(value);
      if (key !== id && !(row.marketplace === marketplace && (row.name ?? key) === name)) continue;
      if (row.name !== undefined && row.name !== name || row.marketplace !== undefined && row.marketplace !== marketplace) {
        throw new Error('nativeObservationInvalid');
      }
      matches.push(row);
    }
  }
  return matches;
}

async function readRetirementConfiguration(binding: DeploymentBinding, layout: DeploymentLayout) {
  const hostRoot = layout.physicalIdentity.namespaceRoot;
  const scopeRoot = binding.scope.kind === 'project' ? binding.scope.projectRoot : hostRoot;
  const id = layout.nativeIdentity.registrationId!;
  const market = layout.marketplaceName!;
  const files = binding.platform === 'codex' ? [path.join(hostRoot, 'config.toml'), path.join(layout.activationPath, 'config.toml')]
    : [path.join(hostRoot, 'settings.json'), path.join(layout.activationPath, binding.scope.kind === 'project' ? 'settings.local.json' : 'settings.json'),
      ...(binding.platform === 'claude' ? [path.join(hostRoot, 'plugins', 'known_marketplaces.json'), path.join(hostRoot, 'plugins', 'installed_plugins.json')] : []),
      ...(binding.scope.kind === 'project' ? [path.join(layout.activationPath, 'settings.json')] : [])];
  let installed: Record<string, unknown>[] | undefined;
  const section = (value: unknown, key: string): unknown => value === undefined ? null : object(value)[key] ?? null;
  const contents = await Promise.all([...new Set(files)].map(async (filePath) => {
    await assertSafeFileMutationPath({ filePath, allowedRoot: filePath.startsWith(`${hostRoot}${path.sep}`) ? hostRoot : scopeRoot,
      label: 'Native retirement configuration' });
    if (binding.platform === 'codex') {
      const config = await readCodexConfigFile(filePath);
      const registration = config.snapshot.marketplaces[market];
      return { registration: registration ? [registration.sourceType, registration.source] : null,
        activation: readCodexPluginTable(config.content, id) };
    }
    if (path.basename(filePath) === 'installed_plugins.json') {
      const raw = await fs.readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (raw !== null) {
        const plugins = object(JSON.parse(raw)).plugins;
        installed = claudeInstalledRows(plugins === undefined ? {} : plugins, id, layout.nativeIdentity.packageId, market);
      }
      return installed ?? [];
    }
    const config = await jsonFile(filePath);
    if (path.basename(filePath) === 'known_marketplaces.json') {
      return [config[market], section(config.marketplaces, market)].map((value) => {
        if (value === null || value === undefined) return null;
        const { source, path: sourcePath, installLocation } = object(value);
        return { source, sourcePath, installLocation };
      });
    }
    return { activation: section(config.enabledPlugins, id), marketplace: section(config.extraKnownMarketplaces, market) };
  }));
  return { fingerprint: identityDigest(contents), installed };
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
  name: string, root: string, pathMatches = nativeSourceMatches): Promise<'absent' | 'canonical' | 'foreign'> {
  const inventory = rows(await queryNativeDeployment(ctx, binding, ['plugin', 'marketplace', 'list', '--json']));
  if (ctx.confirmedCatalogRetirement && inventory.some((row) => typeof row.name !== 'string' || !row.name)) throw new Error('nativeObservationInvalid');
  const matching = inventory.filter((row) => row.name === name);
  if (!matching.length) return 'absent';
  if (matching.length !== 1) throw new Error('nativeIdentityDuplicate');
  const row = matching[0]!;
  return row.source === 'directory' && pathMatches(row.path, root)
    && (row.installLocation === undefined || pathMatches(row.installLocation, root)) ? 'canonical' : 'foreign';
}

export async function inspectCopilotMarketplaceSource(ctx: ReadContext, binding: DeploymentBinding,
  name: string, root: string, pathMatches = nativeSourceMatches): Promise<'absent' | 'canonical' | 'foreign' | 'unknown'> {
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
    return pathMatches(location, root) ? 'canonical' : 'foreign';
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return 'unknown';
  const descriptor = source as Record<string, unknown>;
  if (descriptor.source !== 'directory') return typeof descriptor.source === 'string' ? 'foreign' : 'unknown';
  return pathMatches(descriptor.path, root) ? 'canonical' : 'foreign';
}

export async function inspectNativeDeployment(ctx: ReadContext, binding: DeploymentBinding,
  layout: DeploymentLayout, result: DeploymentObservation): Promise<void> {
  const nativeId = layout.nativeIdentity.registrationId ?? layout.nativeIdentity.packageId;
  const retirement: DeploymentObservation['retirement'] = ctx.confirmedCatalogRetirement && sharedMarketplaceRoute(binding)
    ? { marketplaceProof: await inspectRetirementMarketplace(ctx, binding, layout) } : undefined;
  let pathMatches = nativeSourceMatches;
  let diskRegistrations: Record<string, unknown>[] | undefined;
  if (retirement) {
    result.retirement = retirement;
    try {
      const awHome = resolveAwHome(ctx.env);
      const canonicalAwHome = await canonicalNamespaceRoot(awHome);
      pathMatches = (source, expected) => canonicalMarketplaceRegistrationPath(source, awHome, canonicalAwHome) === expected;
      const config = await readRetirementConfiguration(binding, layout);
      retirement.configurationFingerprint = config.fingerprint;
      diskRegistrations = config.installed;
      if (diskRegistrations?.some(({ scope }) => scope === 'managed')) {
        retirement.claudeRegistrations = { local: false, user: false, managed: true, unsupported: true };
      }
    } catch (error) {
      rethrowFatalError(error); ctx.signal?.throwIfAborted();
      if (result.ownership !== 'foreign' && result.ownership !== 'shared') result.ownership = 'unknown';
      diagnostic(result, binding, 'nativeConfigurationUnreadable', 'Retirement configuration could not be verified.');
    }
  }
  switch (binding.route) {
    case 'codex-marketplace': {
      await inspectConfiguration(ctx, binding, result, async () => {
        const config = await readCodexConfigFile(path.join(layout.activationPath, 'config.toml'));
        const host = binding.scope.kind === 'user' ? config : await readCodexConfigFile(path.join(layout.physicalIdentity.namespaceRoot, 'config.toml'));
        const marketplaces = [host.snapshot, config.snapshot].map((snapshot) => snapshot.marketplaces[layout.marketplaceName!]).filter((entry) => entry !== undefined);
        const canonical = (entry: CodexMarketplaceSnapshot): boolean => retirement
          ? entry.sourceType === 'local' && !entry.sourcePointsToManifest && pathMatches(entry.source, layout.marketplaceRoot!)
          : isCanonicalCodexMarketplaceRegistration(entry, layout.marketplaceRoot!);
        const marketplace = marketplaces.some((entry) => !canonical(entry))
          ? 'foreign' : marketplaces.length ? 'canonical' : 'absent';
        if (marketplace === 'foreign') result.ownership = 'foreign';
        if (retirement) {
          const entry = host.snapshot.plugins[nativeId];
          retirement.userActivation = entry && entry.enabled === undefined ? 'unknown' : configuredActivation(entry?.enabled);
          const registration = host.snapshot.marketplaces[layout.marketplaceName!];
          retirement.userMarketplace = registration ? canonical(registration)
            ? 'canonical' : 'foreign' : 'absent';
          if (config.snapshot.plugins[nativeId] && config.snapshot.plugins[nativeId]!.enabled === undefined) throw new Error('nativeActivationInvalid');
        }
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
        env: ctx.env ?? process.env, manager, runner: ctx.runner, probe: { platform: ctx.platform, signal: ctx.signal } });
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
          result.registration = !retirement && (observed.activations.user !== undefined || observed.activations.project !== undefined) ? 'present' : 'unknown';
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
        if (retirement) {
          retirement.claudeKnownMarketplace = await claudeKnownMarketplace(binding, layout, pathMatches);
          if (retirement.claudeKnownMarketplace === 'foreign') result.ownership = 'foreign';
        }
        const settings = await jsonFile(path.join(layout.activationPath, binding.scope.kind === 'project' ? 'settings.local.json' : 'settings.json'));
        return { activation: configuredActivation(settings.enabledPlugins === undefined ? undefined : object(settings.enabledPlugins)[nativeId], true) };
      });
      const [marketplaceRead, pluginsRead] = await Promise.allSettled([
        inspectClaudeMarketplaceSource(ctx, binding, layout.marketplaceName!, layout.marketplaceRoot!, pathMatches),
        queryNativeDeployment(ctx, binding, ['plugin', 'list', '--json']),
      ]);
      if (marketplaceRead.status === 'rejected') {
        rethrowFatalError(marketplaceRead.reason); ctx.signal?.throwIfAborted();
        if (!['foreign', 'shared'].includes(result.ownership)) result.ownership = 'unknown';
        result.diagnostics.push(marketplaceReadDiagnostic(binding, marketplaceRead.reason));
      } else if (marketplaceRead.value === 'foreign') result.ownership = 'foreign';
      if (retirement && result.configuration) result.configuration.marketplace = marketplaceRead.status === 'fulfilled' ? marketplaceRead.value : 'unknown';
      if (pluginsRead.status === 'rejected') throw pluginsRead.reason;
      const inventory = rows(pluginsRead.value);
      if (retirement && inventory.some((row) => typeof row.id !== 'string' || !row.id || typeof row.scope !== 'string')) {
        throw new Error('nativeObservationInvalid');
      }
      if (inventory.some((row) => row.id === layout.nativeIdentity.packageId)) result.ownership = 'foreign';
      const projectRoot = binding.scope.kind === 'project' ? binding.scope.projectRoot : undefined;
      const projectKey = retirement && projectRoot ? await resolveClaudeProjectKey(projectRoot) : undefined;
      const validProjectPath = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value)
        && !value.split(/[\\/]/u).includes('..');
      // Project scope denotes a physical workspace, not an AW marketplace
      // location. Resolve aliases in both inventories without reading other
      // projects' configuration or relaxing the marketplace path matcher.
      const scopedRows = async (records: Record<string, unknown>[]): Promise<Record<string, unknown>[]> => {
        const matching: Record<string, unknown>[] = [];
        for (const row of records) {
          if (row.scope === 'user' || row.scope === 'managed') matching.push(row);
          else if (projectRoot && ['project', 'local'].includes(String(row.scope))
            && (retirement ? validProjectPath(row.projectPath) && await resolveClaudeProjectKey(row.projectPath) === projectKey
              : nativeSourceMatches(row.projectPath, projectRoot))) matching.push(row);
        }
        return matching;
      };
      const all = inventory.filter((row) => row.id === nativeId);
      const matching = await scopedRows(all);
      result.registration = matching.length ? 'present' : 'absent';
      result.scopeRegistration = matching.some((row) => row.scope === (binding.scope.kind === 'user' ? 'user' : 'local')) ? 'present' : 'absent';
      if (retirement) {
        const disk = diskRegistrations && await scopedRows(diskRegistrations);
        const allRegistrations = [...all, ...(diskRegistrations ?? [])];
        const invalidScope = (row: Record<string, unknown>): boolean => !['local', 'project', 'user', 'managed'].includes(String(row.scope))
          || ['local', 'project'].includes(String(row.scope)) && !validProjectPath(row.projectPath);
        const scopes = (records: Record<string, unknown>[]) => records.map(({ scope }) => String(scope)).sort().join(',');
        retirement.claudeRegistrations = {
          local: matching.some((row) => row.scope === 'local'), user: matching.some((row) => row.scope === 'user'),
          managed: allRegistrations.some((row) => row.scope === 'managed'),
          unsupported: allRegistrations.some(invalidScope) || matching.some((row) => row.scope === 'project')
            || new Set(matching.map(({ scope }) => scope)).size !== matching.length
            || disk !== undefined && scopes(disk) !== scopes(matching),
        };
      }
      const states = matching.map((row) => row.enabled);
      setActivation(result, states.length && states.every((enabled) => enabled === true) ? 'enabled'
        : states.length && states.every((enabled) => enabled === false) ? 'disabled' : 'unknown');
      // The native path identifies the actual folder used for in-place loading.
      if (matching.some((row) => row.readFromFolder !== undefined && !pathMatches(row.readFromFolder, layout.packageRoot))) result.ownership = 'foreign';
      if (matching.length && marketplaceRead.status === 'fulfilled' && marketplaceRead.value === 'absent'
        && matching.some((row) => !pathMatches(row.readFromFolder, layout.packageRoot))
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
      await inspectConfiguration(ctx, binding, result, async () => {
        if (retirement) {
          retirement.userActivation = await copilotConfiguredActivation(path.join(layout.physicalIdentity.namespaceRoot, 'settings.json'), nativeId);
        }
        return { activation: await copilotConfiguredActivation(settingsPath, nativeId) };
      });
      // These inventories are independent. Finish both reads before returning,
      // including when one fails, so no native read outlives this inspection.
      const [marketplaceRead, pluginsRead] = await Promise.allSettled([
        inspectCopilotMarketplaceSource(ctx, binding, layout.marketplaceName!, layout.marketplaceRoot!, pathMatches),
        queryNativeDeployment(ctx, binding, ['plugin', 'list', '--json']),
      ]);
      const marketplace = marketplaceRead.status === 'fulfilled' ? marketplaceRead.value : 'unknown';
      if (retirement && result.configuration) result.configuration.marketplace = marketplace;
      if (marketplaceRead.status === 'rejected') {
        const error = marketplaceRead.reason;
        rethrowFatalError(error); ctx.signal?.throwIfAborted();
        result.diagnostics.push(marketplaceReadDiagnostic(binding, error));
      }
      if (marketplace === 'foreign') result.ownership = 'foreign';
      if (marketplace === 'unknown' && !['foreign', 'shared'].includes(result.ownership)) result.ownership = 'unknown';
      if (pluginsRead.status === 'rejected') throw pluginsRead.reason;
      const inventory = rows(pluginsRead.value);
      if (retirement && inventory.some((row) => typeof row.name !== 'string' || !row.name
        || row.name === layout.nativeIdentity.packageId && typeof row.marketplace !== 'string')) {
        throw new Error('nativeObservationInvalid');
      }
      const matches = inventory.filter((row) => row.name === layout.nativeIdentity.packageId && row.marketplace === layout.marketplaceName);
      if (matches.length > 1) throw new Error('nativeIdentityDuplicate');
      const row = matches[0];
      result.registration = row ? 'present' : 'absent';
      if (!row) break;
      const sources = row.source === 'live' ? [row.installedFrom] : [row.source, row.installedFrom].filter((value) => value !== undefined);
      const foreignSource = sources.some((value) => typeof value === 'string' && path.isAbsolute(value) && !pathMatches(value, layout.marketplaceRoot!));
      if (retirement && row.source !== 'live' && foreignSource) result.ownership = 'foreign';
      if (row.source === 'live') {
        const location = row.installedFrom;
        const exactSource = pathMatches(location, layout.marketplaceRoot!);
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
      } else if (marketplace !== 'canonical' && !pathMatches(row.source, layout.marketplaceRoot!)
        && !pathMatches(row.installedFrom, layout.marketplaceRoot!) && !['foreign', 'shared'].includes(result.ownership)) {
        // Unrecognized source shapes remain unknown and cannot authorize mutation.
        result.ownership = 'unknown';
      }
      // An incomplete row can denote the same identity even though the exact-name filter skipped it.
      const ambiguous = inventory.some((other) => other !== row
        && (typeof other.name !== 'string' || !other.name.trim() || other.name === row.name)
        && (typeof other.marketplace !== 'string' || !other.marketplace.trim() || other.marketplace === row.marketplace));
      const canonical = !ambiguous && sources.length > 0 && sources.every((value) => pathMatches(value, layout.marketplaceRoot!));
      result.copilotRegistration = { marketplace, source: foreignSource ? 'foreign' : canonical ? 'canonical' : 'unknown' };
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
