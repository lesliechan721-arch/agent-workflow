import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import type { DeploymentBinding, DeploymentObservation, ReadContext } from './contracts.js';
import type { DeploymentLayout } from './layout.js';
import { resolvePlatformConfigRoot } from './discovery.js';
import { readPlatformPackageContentDigest } from '../utils/platform-empty-state.js';
import { rethrowFatalError } from '../utils/codex-executable-discovery.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('grokObservationInvalid');
  return value as Record<string, unknown>;
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

/** 1.0.77's list is an install inventory; inspect.enabled is not load evidence. */
export async function inspectGrokDeployment(ctx: ReadContext, binding: DeploymentBinding, layout: DeploymentLayout,
  result: DeploymentObservation, listValue: unknown, inspectValue: unknown): Promise<void> {
  const list = rows(listValue);
  const inspect = object(inspectValue);
  if (inspect.grokVersion !== '1.0.77') throw new Error('grokObservationVersionUnverified');
  const plugins = rows(inspect.plugins);
  const name = layout.nativeIdentity.packageId;
  const matches = list.filter((row) => row.name === name);
  if (matches.length > 1) throw new Error('nativeIdentityDuplicate');
  const installed = matches[0];
  if (installed && (installed.status !== 'installed' || typeof installed.repo_key !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(installed.repo_key)
    || typeof installed.version !== 'string' || typeof installed.path !== 'string' || !path.isAbsolute(installed.path)
    || typeof installed.source !== 'string' || !path.isAbsolute(installed.source))) throw new Error('grokRegistrationInvalid');
  result.registration = binding.route === 'grok-directory' ? 'not-applicable' : installed ? 'present' : 'absent';
  const nativeRoot = binding.route === 'grok-directory' ? layout.packageRoot : installed?.path as string | undefined;
  for (const plugin of plugins) {
    if (typeof plugin.name !== 'string' || typeof plugin.path !== 'string' || !path.isAbsolute(plugin.path)
      || typeof plugin.scope !== 'string') throw new Error('grokPluginIdentityInvalid');
  }
  const effective = ['skills', 'agents', 'mcpServers'].flatMap((kind) => rows(inspect[kind]).map((row) => ({ kind, row, source: object(row.source) })));
  const own = plugins.filter((plugin) => plugin.name === name && plugin.path === nativeRoot && plugin.scope === binding.scope.kind);
  const hasLoadedResources = own.length === 1 && effective.some(({ source }) => source.plugin_name === name && within(nativeRoot!, source.path));
  for (const consumer of result.consumers) {
    consumer.activation = own.length === 1 && typeof own[0]!.enabled === 'boolean' ? own[0]!.enabled ? 'enabled' : 'disabled' : 'unknown';
    // Runtime/folder trust is distinct from consent to install a new source.
    consumer.trust = typeof inspect.projectTrusted === 'boolean'
      ? inspect.projectTrusted ? 'trusted' : 'required' : 'unknown';
    consumer.load = hasLoadedResources ? 'observed' : 'not-observed';
  }
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
    sources.push({ name: plugin.name, version, path: plugin.path, scope: plugin.scope, origin,
      enabled: typeof plugin.enabled === 'boolean' ? plugin.enabled : null,
      effectiveComponents: effective.filter(({ source }) => source.plugin_name === plugin.name && within(plugin.path as string, source.path))
        .map(({ kind, row }) => `${kind}:${String(row.name)}`).sort() });
  }
  const overlaps = [...new Set(sources.filter((source) => sources.some((other) => other !== source && other.name === source.name)).map((source) => source.name))].sort();
  result.prerequisites.nativeSources = { observation: sourcesComplete ? 'complete' : 'unknown', sources, overlaps,
    configurationEvidence: `sha256:${crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}` };
  if (overlaps.length) result.diagnostics.push({ code: 'nativeCompatibilityOverlap', severity: 'warning',
    message: 'Grok discovered overlapping plugin sources. Effective component sources are reported; compatibility files remain outside AW cleanup authority.', subject: { target: 'grok' } });
  if (sources.some((source) => source.origin === 'compatibility' && source.name === name)) result.diagnostics.push({
    code: 'nativeCompatibilitySourcePresent', severity: 'warning', message: 'A compatibility source with this plugin name is present. Its components are separate from the AW native package.', subject: { target: 'grok' } });
}
