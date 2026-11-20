import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import type { DeploymentBinding, DeploymentObservation, GrokOrderEntry, ReadContext } from './contracts.js';
import type { DeploymentLayout } from './layout.js';
import { queryNativeDeployment } from './inspection-query.js';
import { grokUserWorkspace } from '../intent/scope-context.js';
import { resolvePlatformConfigRoot, selectNativeProduct } from './discovery.js';
import { readPlatformPackageContentDigest } from '../utils/platform-empty-state.js';
import { rethrowFatalError } from '../utils/codex-executable-discovery.js';
import { tryParseStrictSemVer } from '@lesliechan721/aw-plugin-core/semver';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('grokObservationInvalid');
  return value;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 4096) throw new Error('grokObservationInvalid');
  return value.map(object);
}
function within(root: string, file: unknown): boolean {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function evidenceDigest(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
function isPackageHook(hook: unknown, name: string, root: string): boolean {
  return isRecord(hook) && hook.event === '(plugin)' && hook.hookType === 'file' && hook.matcher === null
    && typeof hook.target === 'string' && path.normalize(hook.target) === path.join(root, 'hooks', 'hooks.json')
    && isRecord(hook.source) && hook.source.type === 'plugin' && hook.source.plugin_name === name
    && typeof hook.source.path === 'string' && path.normalize(hook.source.path) === root;
}

async function grokUserFolderAuthorization(hostRoot: string, workspace: string,
  hostTrusted: unknown): Promise<DeploymentObservation['grokScopeAuthorization']> {
  if (hostTrusted === false) return 'denied';
  if (hostTrusted !== true) return 'unknown';
  // With no active Hook, Grok 1.0.77 may return projectTrusted=true even
  // when the user explicitly refused this folder. Require both observations
  // before a refresh can uninstall the registered copy and trust a new one.
  const file = path.join(hostRoot, 'trusted_folders.toml');
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return 'unknown';
    const content = await fs.readFile(file);
    if (content.length > 1024 * 1024) return 'unknown';
    const folders = object(getStaticTOMLValue(parseTOML(content.toString('utf8')))).folders;
    const decision = isRecord(folders) && Object.hasOwn(folders, workspace) ? folders[workspace] : undefined;
    if (!isRecord(decision) || !Number.isSafeInteger(decision.decided_at)) return 'unknown';
    return decision.trusted === true ? 'granted' : decision.trusted === false ? 'denied' : 'unknown';
  } catch (error) {
    rethrowFatalError(error);
    return 'unknown';
  }
}

/** 1.0.77's list is an install inventory; inspect.enabled is not load evidence. */
export async function inspectGrokDeployment(ctx: ReadContext, binding: DeploymentBinding, layout: DeploymentLayout,
  result: DeploymentObservation): Promise<void> {
  const workspace = binding.scope.kind === 'user' ? await grokUserWorkspace(ctx.env ?? process.env) : undefined;
  const list = rows(JSON.parse(await queryNativeDeployment(ctx, binding, ['plugin', 'list', '--json'], workspace)));
  const name = layout.nativeIdentity.packageId;
  const matches = list.filter((row) => row.name === name);
  if (matches.length > 1) throw new Error('nativeIdentityDuplicate');
  const installed = matches[0];
  if (installed && (installed.status !== 'installed' || typeof installed.repo_key !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(installed.repo_key)
    || typeof installed.version !== 'string' || typeof installed.path !== 'string' || !path.isAbsolute(installed.path)
    || typeof installed.source !== 'string' || !path.isAbsolute(installed.source))) throw new Error('grokRegistrationInvalid');
  result.registration = binding.route === 'grok-directory' ? 'not-applicable' : installed ? 'present' : 'absent';
  const entry = binding.consumers.find((consumer) => consumer.entry?.kind === 'cli')?.entry;
  const hostRoot = entry?.kind === 'cli' ? entry.configRoot : await resolvePlatformConfigRoot('grok', ctx);
  if (binding.route === 'grok-cli' && installed) {
    result.nativeIdentity = { ...layout.nativeIdentity, registrationId: installed.repo_key as string, sourceLocation: installed.source as string };
    try {
      const installedRoot = path.join(hostRoot, 'installed-plugins');
      if (path.normalize(installed.path as string) !== path.join(installedRoot, installed.repo_key as string)) throw new Error('grokRegistrationPathUnconfirmed');
      for (const directory of [hostRoot, installedRoot, installed.path as string]) {
        const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('grokRegistrationPathUnconfirmed');
        if (directory === installed.path) result.nativePackage = stat ? 'present' : 'absent';
      }
      if (path.normalize(installed.source as string) !== layout.packageRoot) result.ownership = 'foreign';
      else if (list.some((row) => row !== installed && (row.repo_key === installed.repo_key || row.path === installed.path || row.source === installed.source))) result.ownership = 'shared';
      else if (result.ownership === 'aw') {
        const [sourceDigest, installedDigest] = await Promise.all([
          readPlatformPackageContentDigest(layout.packageRoot), readPlatformPackageContentDigest(installed.path as string),
        ]);
        result.nativePackageContentDigest = installedDigest;
        const reason = !sourceDigest || !installedDigest ? 'nativePackageContentUnconfirmed'
          : sourceDigest !== installedDigest ? 'nativePackageContentDrift' : null;
        if (reason) {
          result.components = result.components.map((component) => ({ ...component, presence: 'unknown', reasonCodes: [...component.reasonCodes, reason] }));
          result.diagnostics.push({ code: reason, severity: 'warning',
            message: 'The Grok installation does not confirm the current AW package bytes. Run sync to replace the native copy.',
            subject: { target: 'grok', pluginId: binding.plugin.pluginId, scope: binding.scope.kind } });
        }
      }
    } catch (error) {
      rethrowFatalError(error); ctx.signal?.throwIfAborted();
      result.ownership = 'unknown';
      result.diagnostics.push({ code: 'grokInstallationUnconfirmed', severity: 'warning',
        message: 'The Grok installation path or package bytes could not be confirmed for maintenance.', subject: { target: 'grok', scope: binding.scope.kind } });
    }
  }
  const inspect = object(JSON.parse(await queryNativeDeployment(ctx, binding, ['inspect', '--json'], workspace)));
  const product = selectNativeProduct(binding.consumers);
  if (typeof inspect.grokVersion !== 'string' || !tryParseStrictSemVer(inspect.grokVersion)
    || !product || product.version !== null && product.version !== inspect.grokVersion) throw new Error('grokObservationVersionUnverified');
  const plugins = rows(inspect.plugins);
  const nativeRoot = binding.route === 'grok-directory' ? layout.packageRoot : installed?.path as string | undefined;
  for (const plugin of plugins) {
    if (typeof plugin.name !== 'string' || typeof plugin.path !== 'string' || !path.isAbsolute(plugin.path)
      || typeof plugin.scope !== 'string') throw new Error('grokPluginIdentityInvalid');
  }
  const effectiveKinds = ['skills', 'agents', 'mcpServers'];
  const effective = effectiveKinds.flatMap((kind) => rows(inspect[kind]).map((row) => ({ kind, row, source: object(row.source) })));
  const own = nativeRoot === undefined ? [] : plugins.filter((plugin) => plugin.name === name
    && path.normalize(plugin.path as string) === path.normalize(nativeRoot) && plugin.scope === binding.scope.kind);
  const hasLoadedResources = own.length === 1 && effective.some(({ source }) => source.plugin_name === name && within(nativeRoot!, source.path));
  // Scoped host authorization remains separate from consent to install a new source.
  if (binding.scope.kind === 'user') {
    result.grokScopeAuthorization = workspace && inspect.projectRoot === null
      ? await grokUserFolderAuthorization(hostRoot, workspace, inspect.projectTrusted) : 'unknown';
  } else {
    result.grokScopeAuthorization = inspect.projectTrusted === true ? 'granted' : inspect.projectTrusted === false ? 'denied' : 'unknown';
  }
  for (const consumer of result.consumers) {
    if (consumer.productId !== product.id) continue;
    consumer.activation = own.length === 1 && typeof own[0]!.enabled === 'boolean' ? own[0]!.enabled ? 'enabled' : 'disabled' : 'unknown';
    consumer.load = hasLoadedResources ? 'observed' : 'not-observed';
  }
  const projectRoot = binding.scope.kind === 'project' ? binding.scope.projectRoot : undefined;
  const configPaths = [path.join(hostRoot, 'config.toml'), ...(projectRoot ? [path.join(projectRoot, '.grok', 'config.toml')] : [])];
  const scopedConfig = configPaths.at(-1)!;
  // Query cwd and detected projectRoot describe the temporary observation
  // context. Stable policy, resources and sources still invalidate a plan.
  const nativeEvidence = Object.fromEntries(['grokVersion', 'projectTrusted', 'projectInstructions', 'permissions', 'loginPolicy',
    'hooks', 'skills', 'agents', 'plugins', 'marketplaces', 'mcpServers', 'lspServers', 'configSources', 'experiments', 'externalCompat']
    .map((key) => [key, inspect[key]]));
  const evidence: unknown[] = [binding.scope, list, nativeEvidence];
  result.configuration = { scope: binding.scope.kind, activation: 'absent', reasonCodes: [] };
  for (const file of configPaths) {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('grokConfigLimit');
      const text = await fs.readFile(file, 'utf8');
      evidence.push([file, text]);
      const config = object(getStaticTOMLValue(parseTOML(text)));
      const section = config.plugins === undefined ? {} : object(config.plugins);
      const enabled = section.enabled ?? []; const disabled = section.disabled ?? [];
      if (![enabled, disabled].every((values) => Array.isArray(values) && values.every((value) => typeof value === 'string'))) throw new Error('grokConfigInvalid');
      if (file === scopedConfig) {
        const on = (enabled as string[]).includes(name); const off = (disabled as string[]).includes(name);
        result.configuration.activation = on && off ? 'unknown' : off ? 'disabled' : on ? 'enabled' : 'absent';
        if (on && off) result.configuration.reasonCodes.push('configurationActivationConflict');
      }
    } catch (error) {
      rethrowFatalError(error); ctx.signal?.throwIfAborted();
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) evidence.push([file, null]);
      else {
        evidence.push([file, 'configurationUnreadable']);
        if (file === scopedConfig) result.configuration.activation = 'unknown';
        result.configuration.reasonCodes.push('grokConfigurationUnconfirmed');
        result.diagnostics.push({ code: 'grokConfigurationUnconfirmed', severity: 'warning',
          message: 'Grok supplemental configuration could not be read.', subject: { target: 'grok', scope: binding.scope.kind } });
      }
    }
  }
  const configEvidence = evidence.slice(3);
  const resourceOrderEntries = new Map<Record<string, unknown>, GrokOrderEntry>();
  const hooks: unknown[] | undefined = Array.isArray(inspect.hooks) ? inspect.hooks : undefined;
  const hookPackages = new Map<unknown, GrokOrderEntry>();
  const sourceDigests: string[] = [];
  const scopedList = [...list];
  let sourcesComplete = true;
  const sources: NonNullable<DeploymentObservation['prerequisites']['nativeSources']>['sources'] = [];
  for (const plugin of plugins) {
    if (typeof plugin.name !== 'string' || typeof plugin.path !== 'string' || !path.isAbsolute(plugin.path)
      || typeof plugin.scope !== 'string') throw new Error('grokPluginIdentityInvalid');
    const native = within(path.join(hostRoot, 'installed-plugins'), plugin.path) || within(path.join(hostRoot, 'plugins'), plugin.path)
      || !!projectRoot && within(path.join(projectRoot, '.grok', 'plugins'), plugin.path);
    let origin: 'native' | 'compatibility' | 'unknown' = native ? 'native' : 'unknown';
    const inventory = list.find((row) => row.name === plugin.name && row.path === plugin.path);
    let version = typeof inventory?.version === 'string' ? inventory.version : typeof plugin.version === 'string' ? plugin.version : null;
    const evidenceStart = evidence.length;
    // Public manifests provide version evidence for compatibility discoveries;
    // this read never grants AW ownership or cleanup authority.
    for (const descriptor of native ? ['.grok-plugin'] : ['.grok-plugin', '.claude-plugin']) {
      if (version !== null && origin !== 'unknown') break;
      const manifest = path.join(plugin.path, descriptor, 'plugin.json');
      try {
        const stat = await fs.stat(manifest); if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('grokManifestLimit');
        const text = await fs.readFile(manifest, 'utf8'); evidence.push([manifest, text]);
        const parsed = object(JSON.parse(text));
        if (parsed.name === plugin.name) {
          origin = descriptor === '.grok-plugin' ? 'native' : 'compatibility';
          if (typeof parsed.version === 'string') version = parsed.version;
          break;
        }
      } catch (error) {
        rethrowFatalError(error); ctx.signal?.throwIfAborted();
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          evidence.push([manifest, 'manifestUnreadable']); sourcesComplete = false;
        }
      }
    }
    const resources = effective.filter(({ source }) => source.plugin_name === plugin.name && within(plugin.path as string, source.path));
    sources.push({ name: plugin.name, version, path: plugin.path, scope: plugin.scope, origin,
      enabled: typeof plugin.enabled === 'boolean' ? plugin.enabled : null,
      effectiveComponents: resources.map(({ kind, row }) => `${kind}:${String(row.name)}`).sort() });
    // Only the installed version of an observed User plugin moves with its
    // package. The scope retains the complete registration identity and order.
    if (!projectRoot && inventory?.status === 'installed' && plugin.scope === 'user' && typeof inventory.version === 'string'
      && within(path.join(hostRoot, 'installed-plugins'), plugin.path)) {
      scopedList[list.indexOf(inventory)] = { ...inventory, version: null };
    }
    // Grok reports this file pointer for a plugin's hooks. Other hook formats
    // (including global commands) remain part of the frozen scope.
    const packageRoot = path.normalize(plugin.path);
    const packageHooks = plugin.scope === binding.scope.kind ? hooks?.filter((hook) => isPackageHook(hook, plugin.name as string, packageRoot)) ?? [] : [];
    if (packageHooks.length === 1) hookPackages.set(packageHooks[0], { sourceRoot: packageRoot, key: packageRoot });
    // Only uniquely named rows with explicit plugin provenance can move with
    // this package. Keep ambiguous or unbound rows frozen in full.
    const uniqueResources = new Map<string, Record<string, unknown> | null>();
    for (const { kind, row, source } of resources) {
      if (source.type !== 'plugin' || typeof row.name !== 'string' || !row.name) continue;
      const key = evidenceDigest([packageRoot, kind, row.name]);
      uniqueResources.set(key, uniqueResources.has(key) ? null : row);
    }
    for (const [key, row] of uniqueResources) {
      if (row) resourceOrderEntries.set(row, { sourceRoot: packageRoot, key });
    }
    sourceDigests.push(evidenceDigest([plugin, ...(inventory ? [inventory.version] : []), resources.map(({ kind, row }) => [kind, row]), packageHooks, ...evidence.slice(evidenceStart)]));
  }
  // Rule rows have no plugin source. Keep every row in order so execution can
  // compare the complete inventory after accounting for its own exact writes.
  const instructions = Array.isArray(inspect.projectInstructions) ? inspect.projectInstructions.map((row: unknown) => ({
    rulePath: isRecord(row) && row.scope === (projectRoot ? 'project' : 'global') && row.fileType === 'rules' && typeof row.path === 'string' && path.isAbsolute(row.path)
      && path.dirname(path.normalize(row.path)) === layout.supplementRoot ? path.normalize(row.path) : null,
    digest: evidenceDigest(row),
  })) : undefined;
  // Keep unbound runtime resources, policy and configuration bound to the scope.
  const scopeEvidence = {
    scopeDigest: evidenceDigest([binding.scope, scopedList, {
      ...nativeEvidence, plugins: undefined,
      hooks: hooks ? [] : nativeEvidence.hooks,
      projectInstructions: instructions ? [] : nativeEvidence.projectInstructions,
      ...Object.fromEntries(effectiveKinds.map((kind) => [kind,
        effective.filter((entry) => entry.kind === kind && !resourceOrderEntries.has(entry.row)).map(({ row }) => row)])),
    }, ...configEvidence]),
    sourceDigests, instructions: instructions ?? [],
    // A bound hook's full row is in its source digest. Keep hook order across packages, too.
    hookOrder: hooks?.map((hook) => hookPackages.get(hook) ?? { sourceRoot: null, key: evidenceDigest(hook) }) ?? [],
    // Per-package digests retain row contents. A surviving identity also
    // binds its position relative to other packages and unbound runtime rows.
    resourceOrder: effectiveKinds.map((kind) => effective.filter((entry) => entry.kind === kind)
      .map(({ row }) => resourceOrderEntries.get(row) ?? { sourceRoot: null, key: evidenceDigest(row) })),
  };
  const overlaps = [...new Set(sources.filter((source) => sources.some((other) => other !== source && other.name === source.name)).map((source) => source.name))].sort();
  result.prerequisites.nativeSources = { observation: sourcesComplete ? 'complete' : 'unknown', sources, overlaps,
    configurationEvidence: evidenceDigest(evidence), grokScopeEvidence: scopeEvidence };
  if (overlaps.length) result.diagnostics.push({ code: 'nativeCompatibilityOverlap', severity: 'warning',
    message: 'Grok discovered overlapping plugin sources. Effective component sources are reported; compatibility files remain outside AW cleanup authority.', subject: { target: 'grok' } });
  if (sources.some((source) => source.origin === 'compatibility' && source.name === name)) result.diagnostics.push({
    code: 'nativeCompatibilitySourcePresent', severity: 'warning', message: 'A compatibility source with this plugin name is present. Its components are separate from the AW native package.', subject: { target: 'grok' } });
}
