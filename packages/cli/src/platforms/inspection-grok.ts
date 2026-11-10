import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import type { DeploymentBinding, DeploymentObservation, ReadContext } from './contracts.js';
import type { DeploymentLayout } from './layout.js';
import { resolvePlatformConfigRoot } from './discovery.js';

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
  if (installed && (typeof installed.repo_key !== 'string' || typeof installed.version !== 'string'
    || typeof installed.path !== 'string' || !path.isAbsolute(installed.path) || typeof installed.source !== 'string')) throw new Error('grokRegistrationInvalid');
  result.registration = binding.route === 'grok-directory' ? 'not-applicable' : installed ? 'present' : 'absent';
  if (installed && path.resolve(String(installed.source)) !== layout.packageRoot) result.ownership = 'foreign';
  const nativeRoot = binding.route === 'grok-directory' ? layout.packageRoot : installed?.path as string | undefined;
  const entry = binding.consumers.find((consumer) => consumer.entry?.kind === 'cli')?.entry;
  const hostRoot = entry?.kind === 'cli' ? entry.configRoot : await resolvePlatformConfigRoot('grok', ctx);
  const projectRoot = binding.scope.kind === 'project' ? binding.scope.projectRoot : ctx.cwd;
  const allowedConfigs = new Set([path.join(hostRoot, 'config.toml'), path.join(projectRoot, '.grok', 'config.toml')]);
  const evidence: unknown[] = [list, inspect];
  const layers = rows(object(inspect.configSources).layers);
  let configComplete = true;
  const enabled = new Set<string>(); const disabled = new Set<string>();
  for (const layer of layers) {
    if (typeof layer.path !== 'string' || !allowedConfigs.has(layer.path)) { configComplete = false; continue; }
    let text: string;
    try {
      const stat = await fs.stat(layer.path);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('grokConfigLimit');
      text = await fs.readFile(layer.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { configComplete = false; continue; }
      throw error;
    }
    evidence.push([layer.path, text]);
    const config = object(getStaticTOMLValue(parseTOML(text)));
    const section = config.plugins === undefined ? {} : object(config.plugins);
    for (const [key, target] of [['enabled', enabled], ['disabled', disabled]] as const) {
      const values = section[key] ?? [];
      if (!Array.isArray(values) || !values.every((value) => typeof value === 'string')) throw new Error('grokConfigInvalid');
      for (const value of values) target.add(value);
    }
  }
  const effective = ['skills', 'agents', 'mcpServers'].flatMap((kind) => rows(inspect[kind]).map((row) => ({ kind, row, source: object(row.source) })));
  const sources: NonNullable<DeploymentObservation['prerequisites']['nativeSources']>['sources'] = [];
  for (const plugin of plugins) {
    if (typeof plugin.name !== 'string' || typeof plugin.path !== 'string' || !path.isAbsolute(plugin.path)
      || typeof plugin.scope !== 'string') throw new Error('grokPluginIdentityInvalid');
    const native = within(path.join(hostRoot, 'installed-plugins'), plugin.path) || within(path.join(hostRoot, 'plugins'), plugin.path)
      || within(path.join(projectRoot, '.grok', 'plugins'), plugin.path);
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
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    sources.push({ name: plugin.name, version, path: plugin.path, scope: plugin.scope, origin,
      enabled: typeof plugin.enabled === 'boolean' ? plugin.enabled : null,
      effectiveComponents: effective.filter(({ source }) => source.plugin_name === plugin.name && within(plugin.path as string, source.path))
        .map(({ kind, row }) => `${kind}:${String(row.name)}`).sort() });
  }
  const overlaps = [...new Set(sources.filter((source) => sources.some((other) => other !== source && other.name === source.name)).map((source) => source.name))].sort();
  result.prerequisites.nativeSources = { observation: configComplete ? 'complete' : 'unknown', sources, overlaps,
    configurationEvidence: `sha256:${crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}` };
  const own = sources.find((source) => source.name === name && source.path === nativeRoot);
  const hasLoadedResources = !!own?.effectiveComponents.some((component) => component.startsWith('skills:') || component.startsWith('mcpServers:'));
  for (const consumer of result.consumers) {
    consumer.activation = !own ? 'disabled' : !configComplete ? 'unknown' : disabled.has(name) ? 'disabled' : enabled.has(name) ? 'enabled' : 'unknown';
    consumer.trust = hasLoadedResources ? 'trusted' : binding.scope.kind === 'project' && inspect.projectTrusted === false ? 'required' : 'unknown';
    consumer.load = hasLoadedResources ? 'observed' : 'not-observed';
  }
  if (overlaps.length) result.diagnostics.push({ code: 'nativeCompatibilityOverlap', severity: 'warning',
    message: 'Grok discovered overlapping plugin sources. Effective component sources are reported; compatibility files remain outside AW cleanup authority.', subject: { target: 'grok' } });
  if (sources.some((source) => source.origin === 'compatibility' && source.name === name)) result.diagnostics.push({
    code: 'nativeCompatibilitySourcePresent', severity: 'warning', message: 'A compatibility source with this plugin name is present. Its components are separate from the AW native package.', subject: { target: 'grok' } });
}
