import path from 'node:path';
import fs from 'fs-extra';

import { isCanonicalCodexMarketplaceRegistration } from '../utils/codex-shared-native.js';
import { DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS } from '../constants.js';
import { readCodexConfigFile } from '../utils/codex-config.js';
import { runNativeCli, runNativeCliChecked } from '../utils/native-cli.js';
import { createCodexNativeObservationSession } from '../utils/codex-native-observation.js';
import { getClaudeHome } from '../utils/state-paths.js';
import { installationInvocation } from './discovery.js';
import type { DeploymentBinding, DeploymentObservation, ReadContext } from './contracts.js';
import type { DeploymentLayout } from './layout.js';
import { inspectPiDeployment } from './inspection-pi.js';
import { inspectGrokDeployment } from './inspection-grok.js';
import { getQualifiedPlatformProfile } from './capabilities.js';
import { geminiActivationRules, geminiExtensionPaths, geminiPathEnabled, geminiScopePattern, geminiUserActivation,
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
async function probe(ctx: ReadContext, binding: DeploymentBinding, args: string[]): Promise<string> {
  const product = binding.consumers.find((item) => item.entry?.kind === 'cli' && item.availability === 'available');
  if (!product) throw new Error('nativeEntryUnavailable');
  const cwd = binding.scope.kind === 'project' ? binding.scope.projectRoot : ctx.cwd;
  const invocation = await installationInvocation(product, { ...ctx, cwd }, args);
  const output = await runNativeCliChecked({ ...invocation, timeoutMs: DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS }, ctx.runner);
  if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > 1024 * 1024) throw new Error('nativeObservationOutputLimit');
  return output.stdout;
}
function nativeSourceMatches(source: unknown, expected: string): boolean {
  return typeof source === 'string' && path.isAbsolute(source) && path.normalize(source) === path.normalize(expected);
}

/** Only documented local-directory marketplace sources can establish ownership. */
export async function inspectClaudeMarketplaceSource(ctx: ReadContext, binding: DeploymentBinding,
  name: string, root: string): Promise<'absent' | 'canonical' | 'foreign'> {
  const home = getClaudeHome(ctx.env);
  const known = await jsonFile(path.join(home, 'plugins', 'known_marketplaces.json'));
  const user = await jsonFile(path.join(home, 'settings.json'));
  const project = binding.scope.kind === 'project' ? await jsonFile(path.join(binding.scope.projectRoot, '.claude', 'settings.local.json')) : {};
  const sources: unknown[] = [];
  const knownEntry = known[name];
  if (knownEntry !== undefined) {
    const entry = object(knownEntry);
    if (entry.installLocation !== undefined) sources.push(entry.installLocation);
    if (entry.source !== undefined) sources.push(entry.source);
  }
  for (const settings of [user, project]) {
    if (settings.extraKnownMarketplaces === undefined) continue;
    const entry = object(settings.extraKnownMarketplaces)[name];
    if (entry !== undefined) sources.push(object(entry).source);
  }
  if (!sources.length) return 'absent';
  const location = (source: unknown): unknown => {
    if (typeof source === 'string') return source;
    const descriptor = object(source);
    return descriptor.source === 'directory' ? descriptor.path : null;
  };
  return sources.every((source) => nativeSourceMatches(location(source), root)) ? 'canonical' : 'foreign';
}

export async function inspectCopilotMarketplaceSource(ctx: ReadContext, binding: DeploymentBinding,
  name: string, root: string): Promise<'absent' | 'canonical' | 'foreign' | 'unknown'> {
  const value: unknown = JSON.parse(await probe(ctx, binding, ['plugin', 'marketplace', 'list', '--json']));
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
      const product = binding.consumers.find((item) => item.entry?.kind === 'cli' && item.availability === 'available');
      if (!product || product.entry?.kind !== 'cli') {
        const config = await readCodexConfigFile(path.join(layout.activationPath, 'config.toml'));
        const host = await readCodexConfigFile(path.join(layout.physicalIdentity.namespaceRoot, 'config.toml'));
        for (const snapshot of [host.snapshot, config.snapshot]) {
          const marketplace = snapshot.marketplaces[layout.marketplaceName!];
          if (marketplace && !isCanonicalCodexMarketplaceRegistration(marketplace, layout.marketplaceRoot!)) result.ownership = 'foreign';
        }
        const activation = config.snapshot.plugins[nativeId];
        result.registration = 'unknown';
        setActivation(result, activation?.enabled === true ? 'enabled'
          : activation?.enabled === false || binding.scope.kind === 'project' ? 'disabled' : 'unknown');
        result.diagnostics.push({ code: 'nativeEntryUnavailable', severity: 'warning',
          message: 'The native client is unavailable. Only the exact local activation can be observed; the shared registration is retained.',
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
        if (binding.scope.kind === 'project') {
          const project = await readCodexConfigFile(path.join(binding.scope.projectRoot, '.codex', 'config.toml'));
          const explicit = project.snapshot.plugins[nativeId];
          // The exact native list includes inherited User activation. Only an
          // explicit, effective project entry establishes a separate reference.
          setActivation(result, !explicit || explicit.enabled === false || result.registration === 'absent' ? 'disabled'
            : explicit.enabled === true && observed.activations.project === true ? 'enabled' : 'unknown');
        } else {
          const active = observed.activations.user;
          setActivation(result, active === true ? 'enabled' : active === false || result.registration === 'absent' ? 'disabled' : 'unknown');
        }
      } finally { if (!ctx.codexObservationSession) await session.dispose(); }
      const config = await readCodexConfigFile(path.join(product.entry.configRoot, 'config.toml'));
      const marketplace = config.snapshot.marketplaces[layout.marketplaceName!];
      // A cached installed plugin cannot replace the missing source registration.
      if (!marketplace) result.registration = 'absent';
      else if (!isCanonicalCodexMarketplaceRegistration(marketplace, layout.marketplaceRoot!)) result.ownership = 'foreign';
      break;
    }
    case 'claude-marketplace': {
      const home = getClaudeHome(ctx.env);
      if (await inspectClaudeMarketplaceSource(ctx, binding, layout.marketplaceName!, layout.marketplaceRoot!) === 'foreign') result.ownership = 'foreign';
      const installed = await jsonFile(path.join(home, 'plugins', 'installed_plugins.json'));
      const plugins = installed.plugins === undefined ? {} : object(installed.plugins);
      // Bare entries cannot be associated with or removed through a marketplace.
      if (plugins[layout.nativeIdentity.packageId] !== undefined) result.ownership = 'foreign';
      const raw = plugins[nativeId];
      const records = raw === undefined ? [] : Array.isArray(raw) ? raw.map(object) : [object(raw)];
      const scope = binding.scope.kind === 'project' ? 'local' : 'user';
      const matching = records.filter((record) => record.scope === scope && (scope === 'user'
        || nativeSourceMatches(record.projectPath, binding.scope.kind === 'project' ? binding.scope.projectRoot : '')));
      result.registration = matching.length ? 'present' : 'absent';
      const settingsPath = binding.scope.kind === 'project' ? path.join(binding.scope.projectRoot, '.claude', 'settings.local.json') : path.join(home, 'settings.json');
      const settings = await jsonFile(settingsPath);
      const enabled = settings.enabledPlugins === undefined ? undefined : object(settings.enabledPlugins)[nativeId];
      if (enabled !== undefined && typeof enabled !== 'boolean' && !Array.isArray(enabled)) throw new Error('nativeActivationInvalid');
      setActivation(result, enabled === true || Array.isArray(enabled) ? 'enabled' : enabled === false ? 'disabled' : 'unknown');
      break;
    }
    case 'antigravity-cli': {
      const value: unknown = JSON.parse(await probe(ctx, binding, ['plugin', 'list', '--json']));
      if (!Array.isArray(value)) throw new Error('nativeObservationInvalid');
      const matches = value.map(object).filter((row) => row.name === layout.nativeIdentity.packageId);
      if (matches.length > 1) throw new Error('nativeIdentityDuplicate');
      result.registration = matches.length ? 'present' : 'absent';
      const row = matches[0];
      if (row) {
        if (!nativeSourceMatches(row.source, layout.packageRoot)) result.ownership = 'foreign';
        if (typeof row.enabled !== 'boolean') throw new Error('nativeActivationInvalid');
        setActivation(result, row.enabled ? 'enabled' : 'disabled');
      } else setActivation(result, 'disabled');
      break;
    }
    case 'copilot-marketplace': {
      // These inventories are independent. Finish both reads before returning,
      // including when one fails, so no native read outlives this inspection.
      const [marketplaceRead, pluginsRead] = await Promise.allSettled([
        inspectCopilotMarketplaceSource(ctx, binding, layout.marketplaceName!, layout.marketplaceRoot!),
        probe(ctx, binding, ['plugin', 'list', '--json']),
      ]);
      if (marketplaceRead.status === 'rejected') throw marketplaceRead.reason;
      const marketplace = marketplaceRead.value;
      if (marketplace === 'foreign') result.ownership = 'foreign';
      if (marketplace === 'unknown') result.ownership = 'unknown';
      if (pluginsRead.status === 'rejected') throw pluginsRead.reason;
      const value: unknown = JSON.parse(pluginsRead.value);
      if (!Array.isArray(value)) throw new Error('nativeObservationInvalid');
      const matches = value.map(object).filter((row) => row.name === layout.nativeIdentity.packageId && row.marketplace === layout.marketplaceName);
      if (matches.length > 1) throw new Error('nativeIdentityDuplicate');
      result.registration = matches.length ? 'present' : 'absent';
      const row = matches[0];
      if (row && marketplace !== 'canonical' && !nativeSourceMatches(row.source, layout.marketplaceRoot!) && !nativeSourceMatches(row.installedFrom, layout.marketplaceRoot!)) {
        // Unrecognized source shapes remain unknown and cannot authorize mutation.
        result.ownership = 'unknown';
      }
      const settings = await jsonFile(path.join(layout.activationPath, binding.scope.kind === 'project' ? 'settings.local.json' : 'settings.json'));
      const enabled = settings.enabledPlugins === undefined ? undefined : object(settings.enabledPlugins)[nativeId];
      setActivation(result, typeof enabled === 'boolean' ? enabled ? 'enabled' : 'disabled' : row?.enabled === false ? 'disabled' : 'unknown');
      break;
    }
    case 'pi-package':
      await inspectPiDeployment(ctx, binding, layout, result);
      break;
    case 'gemini-extension': {
      // Gemini stores exact local-source metadata separately from its human list.
      // Discovery confirms the client. The unused list output adds no evidence
      // to these metadata and activation reads, and does not prove host loading.
      ctx.signal?.throwIfAborted();
      if (!binding.consumers.some((item) => item.entry?.kind === 'cli' && item.availability === 'available')) {
        throw new Error('nativeEntryUnavailable');
      }
      const { home, root } = geminiExtensionPaths(ctx);
      const directory = path.join(root, layout.nativeIdentity.packageId);
      try {
        const stats = await fs.lstat(directory);
        if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('nativeExtensionPathUnconfirmed');
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          result.registration = 'absent';
          setActivation(result, 'disabled');
          break;
        }
        throw error;
      }
      const metadata = await jsonFile(path.join(directory, '.gemini-extension-install.json'));
      const manifest = await jsonFile(path.join(directory, 'gemini-extension.json'));
      if (typeof metadata.source !== 'string' || typeof metadata.type !== 'string' || typeof manifest.name !== 'string') {
        throw new Error('nativeExtensionIdentityUnknown');
      }
      result.registration = 'present';
      if (!['local', 'link'].includes(metadata.type) || !nativeSourceMatches(metadata.source, layout.packageRoot)
        || manifest.name !== layout.nativeIdentity.packageId) result.ownership = 'foreign';
      if (result.ownership === 'aw') {
        result.nativePackageContentDigest = await readGeminiNativeCopyContentDigest(ctx, layout.nativeIdentity, {
          owner: 'agent-workflows', plugin: layout.nativeIdentity.packageId, pluginId: binding.plugin.pluginId,
          sourceId: binding.plugin.sourceId, sourceIdentity: binding.plugin.sourceIdentity,
          platform: binding.platform, scope: 'user', physicalKey: binding.physicalKey, artifactKey: path.basename(layout.packageRoot),
        });
      }
      const snapshot = await readGeminiActivationSnapshot(ctx);
      const rules = geminiActivationRules(snapshot, manifest.name);
      const userActivation = geminiUserActivation(snapshot, manifest.name, home);
      if (binding.scope.kind === 'project') {
        const target = geminiScopePattern(binding.scope.projectRoot);
        const explicit = rules.filter((rule) => rule === target || rule === `!${target}`).at(-1);
        // Inherited global activation is not an independent project reference.
        setActivation(result, explicit === target && geminiPathEnabled(rules, binding.scope.projectRoot) ? 'enabled' : 'disabled');
      } else setActivation(result, userActivation === 'unknown' ? 'unknown' : userActivation ? 'enabled' : 'disabled');
      if (userActivation === 'unknown') result.diagnostics.push({ code: 'nativeActivationScopeLimited', severity: 'warning',
        message: 'The extension rules do not confirm a global user activation. Check the native configuration before changing its scope.', subject: { target: binding.platform } });
      break;
    }
    case 'grok-cli':
    case 'grok-directory':
      await inspectGrokDeployment(ctx, binding, layout, result,
        JSON.parse(await probe(ctx, binding, ['plugin', 'list', '--json'])),
        JSON.parse(await probe(ctx, binding, ['inspect', '--json'])));
      break;
    default: break;
  }
}
