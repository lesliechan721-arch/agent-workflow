import crypto from 'node:crypto';
import type { Stats } from 'node:fs';
import path from 'node:path';
import fs from 'fs-extra';
import { minimatch } from 'minimatch';
import type { AgentConsumerObservation, DeploymentBinding, DeploymentObservation, Diagnostic, ReadContext, ScopeRef } from './contracts.js';
import { resolvePlatformConfigRoot } from './discovery.js';
import { getPhysicalKey } from './identity.js';
import type { DeploymentLayout } from './layout.js';
import { queryNativeDeployment } from './inspection-query.js';
import { rethrowFatalError } from '../utils/codex-executable-discovery.js';
import { readSkillOwnerMarker } from '../utils/ownership.js';
import { resolveUserHome } from '../utils/state-paths.js';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('piConfigurationInvalid');
  return value as ObjectValue;
}
const digest = (value: unknown): string => `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

function localSource(source: string, root: string, home: string): string | null {
  if (source.startsWith('~/')) return path.resolve(home, source.slice(2));
  if (path.isAbsolute(source) || /^\.\.?[/\\]/u.test(source) || /^aw-packages[/\\]/u.test(source)) return path.resolve(root, source);
  return null;
}

interface ConfiguredPackage {
  scope: ScopeRef['kind'];
  source: string;
  installedPath?: string;
  filtered?: boolean;
}

const projectUserSkillSources = new WeakMap<DeploymentObservation, Set<string>>();

/** Exact, unfiltered User registrations visible to Pi in this project. */
export function piProjectListsUserSkills(observation: DeploymentObservation, source: string): boolean {
  return projectUserSkillSources.get(observation)?.has(source) === true;
}

const projectRegistrations = new WeakMap<DeploymentObservation, (string | null)[]>();

/** Keep exact native sources available to the current write without exposing them in status. */
export function piProjectListContainsOnly(observation: DeploymentObservation, knownRoots: ReadonlySet<string>): boolean {
  const roots = projectRegistrations.get(observation);
  return !!roots?.length && roots.length === knownRoots.size && new Set(roots).size === roots.length
    && roots.every((root) => root !== null && knownRoots.has(root));
}

/** Pi list reports configured packages and resolved paths. */
function nativePackages(text: string): ConfiguredPackage[] {
  const lines = text.replace(/\u001b\[[0-9;]*m/gu, '').trimEnd().split(/\r?\n/u);
  if (lines.length === 1 && lines[0] === 'No packages installed.') return [];
  let scope: 'user' | 'project' | undefined;
  const seen = new Set<string>();
  const entries: ConfiguredPackage[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (line === 'User packages:' || line === 'Project packages:') {
      scope = line === 'User packages:' ? 'user' : 'project';
      if (seen.has(scope)) throw new Error('piNativeListInvalid');
      seen.add(scope);
    } else if (line.startsWith('    ')) {
      const previous = entries.at(-1);
      const installedPath = line.slice(4);
      if (!previous || previous.scope !== scope || previous.installedPath || !path.isAbsolute(installedPath)) throw new Error('piNativeListInvalid');
      previous.installedPath = path.normalize(installedPath);
    } else if (line.startsWith('  ') && scope) {
      const source = line.slice(2).replace(/ \(filtered\)$/u, '');
      if (!source || source.trim() !== source) throw new Error('piNativeListInvalid');
      entries.push({ scope, source, ...(line.endsWith(' (filtered)') ? { filtered: true } : {}) });
    } else throw new Error('piNativeListInvalid');
  }
  if (!seen.size || [...seen].some((scope) => !entries.some((entry) => entry.scope === scope))) throw new Error('piNativeListInvalid');
  return entries;
}

function nativeRegistration(entries: ConfiguredPackage[], binding: DeploymentBinding, layout: DeploymentLayout, agentRoot: string,
  home: string): DeploymentObservation['registration'] | 'scope-not-visible' {
  if (!entries.length && binding.scope.kind === 'user') return 'absent';
  if (!entries.some((entry) => entry.scope === binding.scope.kind)) return binding.scope.kind === 'project' ? 'scope-not-visible' : 'unknown';
  const settingsRoot = binding.scope.kind === 'user' ? agentRoot : path.join(binding.scope.projectRoot, '.pi');
  const matches = entries.filter((entry) => entry.scope === binding.scope.kind
    && (localSource(entry.source, settingsRoot, home) === layout.packageRoot || entry.installedPath === layout.packageRoot));
  if (!matches.length) return 'absent';
  return matches.length === 1 && matches[0]!.installedPath === layout.packageRoot
    && localSource(matches[0]!.source, settingsRoot, home) === layout.packageRoot ? 'present' : 'unknown';
}

export async function inspectPiDeployment(ctx: ReadContext, binding: DeploymentBinding, layout: DeploymentLayout,
  result: DeploymentObservation): Promise<void> {
  const entry = binding.consumers.find((consumer) => consumer.entry?.kind === 'cli')?.entry;
  const agentRoot = entry?.kind === 'cli' ? entry.configRoot : resolvePlatformConfigRoot('pi', ctx);
  let listed: ConfiguredPackage[] = [];
  try {
    listed = nativePackages(await queryNativeDeployment(ctx, binding, ['list']));
    const home = resolveUserHome(ctx.env ?? process.env, ctx.platform ?? process.platform);
    const registration = nativeRegistration(listed, binding, layout, agentRoot, home);
    if (binding.scope.kind === 'project') {
      const projectSettingsRoot = path.join(binding.scope.projectRoot, '.pi');
      projectRegistrations.set(result, listed.filter((entry) => entry.scope === 'project').map((entry) => {
        const source = localSource(entry.source, projectSettingsRoot, home);
        return source === entry.installedPath ? source : null;
      }));
    }
    result.registration = registration === 'scope-not-visible' ? 'unknown' : registration;
    if (registration === 'scope-not-visible') result.diagnostics.push({ code: 'piProjectRegistrationNotVisible', severity: 'warning',
      message: 'Pi did not expose a Project package section. This does not prove that the project has no packages.',
      subject: { target: 'pi', scope: 'project' } });
    for (const consumer of result.consumers) consumer.load = 'not-observed';
  } catch (error) {
    rethrowFatalError(error); ctx.signal?.throwIfAborted();
    result.diagnostics.push({ code: 'piNativeObservationUnconfirmed', severity: 'warning',
      message: 'Pi package registration could not be confirmed with the native package list.', subject: { target: 'pi', scope: binding.scope.kind } });
  }
  try { await inspectPiConfiguration(ctx, binding, layout, result, agentRoot, listed); }
  catch (error) {
    rethrowFatalError(error); ctx.signal?.throwIfAborted();
    result.configuration ??= { scope: binding.scope.kind, activation: 'unknown', reasonCodes: ['piConfigurationUnconfirmed'] };
    result.prerequisites.agentConsumers = { observation: 'unknown', candidates: [], reasonCodes: ['agentConsumerDiscoveryUnverified', 'piConfigurationUnconfirmed'] };
    result.diagnostics.push({ code: 'piConfigurationUnconfirmed', severity: 'warning',
      message: 'Pi supplemental configuration or Agent consumer settings could not be read.', subject: { target: 'pi', scope: binding.scope.kind } });
  }
}

const piAgentConsumers = ['pi-subagents', '@tintinweb/pi-subagents'];
const observedPiSubagentsLocalSources = new Set(['0.87.0', '0.89.1']);

const consumerRemedies = {
  piAgentConsumerMissing: 'Pi did not find a compatible Agent extension. Enable pi-subagents or @tintinweb/pi-subagents and reload Pi.',
  piAgentConsumerDisabled: 'Pi settings disable the detected Agent extensions. Enable a compatible extension and reload Pi.',
  piAgentPackageAccessDenied: 'The detected Agent extensions refuse this package. Check packageAgents in subagents.json and reload Pi.',
  piAgentPackageSourceUnsupported: 'The detected pi-subagents version cannot read this Pi package source. Enable a compatible extension such as @tintinweb/pi-subagents and reload Pi.',
  piProjectTrustRequired: 'Pi project trust blocks access to the roles. In Pi, review the trust decision for this project and reload if you choose to trust it.',
  piAgentConsumerUnavailable: 'The detected Agent extensions are disabled or cannot access this package. Check Pi extension and package access settings, then reload Pi.',
  piConfigurationUnconfirmed: 'Pi Agent extension settings could not be read. Execution availability remains unknown. Check the settings and reload Pi.',
};
type ConsumerWarningReason = keyof typeof consumerRemedies;

/** Called once the role files have been delivered in the requested scope. */
export function piAgentConsumerDiagnostic(binding: DeploymentBinding, observation: DeploymentObservation,
  deliveredAgentIds: readonly string[]): Diagnostic | undefined {
  if (binding.platform !== 'pi' || !deliveredAgentIds.length) return undefined;
  const { observation: discovery, candidates, reasonCodes } = observation.prerequisites.agentConsumers;
  const reasons = new Set<ConsumerWarningReason>();
  if (discovery !== 'complete') {
    // An actual configuration read failure is actionable. Other unknown
    // discovery results do not establish whether any executor is available.
    if (!reasonCodes.includes('piConfigurationUnconfirmed')) return undefined;
    reasons.add('piConfigurationUnconfirmed');
  } else {
    const projectBlocked = reasonCodes.includes('piProjectTrustRequired');
    for (const candidate of candidates) {
      if (projectBlocked || candidate.trust === 'blocked') reasons.add('piProjectTrustRequired');
      else if (candidate.enabled === 'no') reasons.add('piAgentConsumerDisabled');
      else if (candidate.packageAccess === 'denied') reasons.add(candidate.reasonCodes.includes('piAgentPackageSourceUnsupported')
        ? 'piAgentPackageSourceUnsupported' : 'piAgentPackageAccessDenied');
      else return undefined; // A configured or unresolved candidate is enough to avoid asserting unavailability.
    }
  }
  const reasonCode = reasons.size === 0 ? 'piAgentConsumerMissing'
    : reasons.size === 1 ? [...reasons][0]! : 'piAgentConsumerUnavailable';
  return { code: 'piAgentConsumerUnavailable', severity: 'warning',
    message: `Pi ${deliveredAgentIds.length === 1 ? 'role installed' : 'roles installed'}. ${consumerRemedies[reasonCode]}`,
    subject: { pluginId: binding.plugin.pluginId, target: 'pi', scope: binding.scope.kind }, detail: { reasonCode } };
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

async function statIfPresent(file: string): Promise<Stats | undefined> {
  try { return await fs.stat(file); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

function sourceLocation(source: string, root: string, home: string): { identity: string; root: string } | undefined {
  if (source.startsWith('npm:')) {
    const name = source.slice(4).trim().match(/^(@[\w.-]+\/[\w.-]+|[\w.-]+)(?:@.+)?$/u)?.[1];
    if (name && !name.split('/').some((part) => part === '.' || part === '..')) {
      return { identity: `npm:${name}`, root: path.join(root, 'npm', 'node_modules', name) };
    }
    return undefined;
  }
  const local = localSource(source, root, home);
  if (local) return { identity: local, root: local };
  const git = source.replace(/^git:/u, '').replace(/^https?:\/\//u, '')
    .match(/^([\w.-]+\.[\w.-]+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@[^/]+)?$/u);
  if (git && !git.slice(1, 4).some((part) => part === '.' || part === '..')) {
    return { identity: `git:${git[1]}/${git[2]}/${git[3]}`, root: path.join(root, 'git', git[1]!, git[2]!, git[3]!) };
  }
  if (/^[^:]+$/u.test(source) && !source.startsWith('~')) {
    const relative = path.resolve(root, source.trim());
    return { identity: relative, root: relative };
  }
  return undefined;
}

function matchesExtension(file: string, root: string, pattern: string, exact: boolean): boolean {
  const normalized = pattern.replace(/\\/gu, '/').replace(/^\.\//u, '');
  const relative = path.relative(root, file).split(path.sep).join('/');
  const absolute = file.split(path.sep).join('/');
  if (exact) {
    const fullPath = path.posix.normalize(normalized);
    return fullPath === relative || fullPath === absolute;
  }
  return [relative, path.basename(file), absolute].some((value) => minimatch(value, normalized));
}

/** Evaluate Pi's filter precedence for concrete manifest files. */
function extensionSelected(file: string, root: string, patterns: string[]): boolean {
  if (!patterns.length) return false;
  const plain = patterns.filter((pattern) => !/^[!+-]/u.test(pattern));
  const matches = (prefix: string) => patterns.some((pattern) => pattern.startsWith(prefix)
    && matchesExtension(file, root, pattern.slice(1), prefix !== '!'));
  const included = (!plain.length || plain.some((pattern) => matchesExtension(file, root, pattern, false))) && !matches('!');
  return (included || matches('+')) && !matches('-');
}

function extensionDelta(file: string, root: string, patterns: string[]): boolean | undefined {
  for (const pattern of [...patterns].reverse()) {
    const prefix = pattern[0] ?? '';
    if (matchesExtension(file, root, /^[!+-]/u.test(prefix) ? pattern.slice(1) : pattern, prefix === '+' || prefix === '-')) {
      return prefix !== '!' && prefix !== '-';
    }
  }
  return undefined;
}

function packageAccess(id: string, version: string | null, settings: ObjectValue,
  names: readonly string[]): AgentConsumerObservation['packageAccess'] {
  const minor = Number(/^0\.(\d+)\.\d+$/u.exec(version ?? '')?.[1]);
  if (id === 'pi-subagents') return version && observedPiSubagentsLocalSources.has(version) ? 'allowed' : 'unknown';
  // Unfamiliar releases remain possible consumers without asserting their policy.
  if (id !== '@tintinweb/pi-subagents' || !(minor >= 22 && minor <= 26)) return 'unknown';
  const gate = settings.packageAgents;
  if (gate === undefined || gate === true) return 'allowed';
  if (gate === false) return 'denied';
  const allowlist = typeof gate === 'string' ? [gate] : gate;
  if (!stringArray(allowlist)) return 'unknown';
  return allowlist.some((value) => names.includes(value.trim().toLowerCase())) ? 'allowed' : 'denied';
}

/** AW's generated Hook, MCP and Instruction extension does not consume Pi roles. */
async function isGeneratedPiExtension(root: string, namespaceRoot: string, scope: ScopeRef['kind'], name: string): Promise<boolean> {
  if (path.dirname(root) !== path.join(namespaceRoot, 'aw-packages') || !path.basename(root).startsWith('aw-')) return false;
  try {
    const marker = await readSkillOwnerMarker({ skillRoot: root, allowedRoot: namespaceRoot });
    const projection = marker?.nativeProjection;
    if (!marker || !projection?.piExtensionDigest || marker.scope !== scope || marker.plugin !== name
      || marker.artifactKey !== `aw-${marker.sourceId}-${marker.plugin}`
      || projection.physicalIdentity.route !== 'pi-package' || projection.physicalIdentity.namespaceRoot !== namespaceRoot
      || projection.physicalIdentity.resourceKey !== marker.artifactKey
      || getPhysicalKey(projection.physicalIdentity) !== marker.physicalKey) return false;
    const file = path.join(root, 'index.mjs');
    if (!(await fs.lstat(file)).isFile()) return false;
    return `sha256:${crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')}` === projection.piExtensionDigest;
  } catch (error) {
    rethrowFatalError(error);
    return false;
  }
}

/** Supplemental public files never replace native package or consumer facts. */
async function inspectPiConfiguration(ctx: ReadContext, binding: DeploymentBinding, layout: DeploymentLayout,
  result: DeploymentObservation, agentRoot: string, listed: ConfiguredPackage[]): Promise<void> {
  const evidence: unknown[] = [];
  let complete = true;
  async function read(file: string, record = true): Promise<ObjectValue> {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('piObservationLimit');
      const text = await fs.readFile(file, 'utf8'); if (record) evidence.push([file, text]);
      return object(JSON.parse(text));
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) { if (record) evidence.push([file, null]); return {}; }
      throw error;
    }
  }
  const user = await read(path.join(agentRoot, 'settings.json'), false);
  const projectRoot = binding.scope.kind === 'project' ? binding.scope.projectRoot : undefined;
  const project = projectRoot ? await read(path.join(projectRoot, '.pi', 'settings.json'), false) : {};
  // Package registrations are outputs of installation. Record actual consumer
  // manifests and filters below, not unrelated package registration text.
  // User execution uses operation-owned neutral directories. Their paths and
  // project files are not inputs to a User binding.
  const settingsRoots: Array<readonly [string, ObjectValue]> = [[agentRoot, user]];
  if (projectRoot) settingsRoots.push([path.join(projectRoot, '.pi'), project]);
  for (const [root, config] of settingsRoots) {
    const { packages: _packages, ...consumerSettings } = config;
    evidence.push([path.join(root, 'settings.json'), consumerSettings]);
  }
  const settings = binding.scope.kind === 'user' ? user : project;
  const packages = settings.packages ?? [];
  if (!Array.isArray(packages)) throw new Error('piPackagesInvalid');
  const home = resolveUserHome(ctx.env ?? process.env, ctx.platform ?? process.platform);
  const installedSources: string[] = packages.flatMap((entry) => {
    const source = typeof entry === 'string' ? entry : object(entry).source;
    return typeof source === 'string' && localSource(source, path.dirname(layout.activationPath), home) === layout.packageRoot ? [source] : [];
  });
  result.configuration = { scope: binding.scope.kind, activation: installedSources.length ? 'enabled' : 'absent', reasonCodes: [] };

  const trustFile = projectRoot ? await read(path.join(agentRoot, 'trust.json')) : {};
  let projectTrust: AgentConsumerObservation['trust'] = 'required';
  let cursor = projectRoot ? await fs.realpath(projectRoot).catch(() => path.resolve(projectRoot)) : undefined;
  while (cursor) {
    if (typeof trustFile[cursor] === 'boolean') { projectTrust = trustFile[cursor] ? 'trusted' : 'blocked'; break; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  if (projectTrust === 'required') {
    if (user.defaultProjectTrust === 'always') projectTrust = 'trusted';
    if (user.defaultProjectTrust === 'never') projectTrust = 'blocked';
  }
  const candidates: AgentConsumerObservation[] = [];
  const packageNames = [layout.nativeIdentity.packageId, layout.nativeIdentity.packageId.split('/').pop()!, ...installedSources]
    .map((name) => name.toLowerCase());
  const subagentSettings = { ...await read(path.join(agentRoot, 'subagents.json')),
    ...(projectRoot ? await read(path.join(projectRoot, '.pi', 'subagents.json')) : {}) };
  interface SourceScope {
    root: string;
    scope: ScopeRef;
    settings: ObjectValue;
    trust: AgentConsumerObservation['trust'];
  }
  async function inspectRoot(root: string, entry: SourceScope, patterns?: string[], delta?: string[],
    mode: 'package' | 'direct' | 'auto' = 'package', autoload = true): Promise<void> {
    const manifest = await read(path.join(root, 'package.json'), false);
    const id = typeof manifest.name === 'string' ? manifest.name : '';
    const pi = manifest.pi === undefined ? {} : object(manifest.pi);
    const extensions = pi.extensions;
    const selected = (file: string): boolean => {
      if (mode === 'auto') return extensionDelta(file, entry.root, patterns ?? []) ?? true;
      const overridden = delta && extensionDelta(file, root, delta);
      if (overridden !== undefined) return overridden;
      if (!autoload) return extensionDelta(file, root, patterns ?? []) === true;
      return patterns === undefined || extensionSelected(file, root, patterns);
    };
    if (Array.isArray(extensions) && extensions.length === 1 && extensions[0] === './index.mjs'
      && selected(path.join(root, 'index.mjs')) && await isGeneratedPiExtension(root, entry.root, entry.scope.kind, id)) return;
    if (Array.isArray(extensions) && extensions.length > 256) throw new Error('piDiscoveryLimit');
    const files = stringArray(extensions) && extensions.every((value) => !/[*!?\[\]{}()]/u.test(value))
      ? extensions.map((value) => path.resolve(root, value)) : undefined;
    let enabled: AgentConsumerObservation['enabled'];
    if (mode === 'package' && !delta && (autoload ? patterns?.length === 0 : !patterns?.length)) enabled = 'no';
    else if (files) {
      const eligible = files.filter(selected);
      const stats = await Promise.all(eligible.map(statIfPresent));
      enabled = stats.some((item) => item?.isFile()) ? 'yes' : eligible.length ? 'unknown' : 'no';
    } else if (extensions === undefined) {
      const source = await statIfPresent(root);
      const conventional = [path.join(root, 'index.ts'), path.join(root, 'index.js')];
      if (mode === 'package') conventional.push(path.join(root, 'extensions'));
      const entries = await Promise.all(conventional.filter(selected).map(statIfPresent));
      enabled = !source || (source.isFile() && selected(root)) || entries.some(Boolean) ? 'unknown' : 'no';
    } else enabled = 'unknown';
    if (!piAgentConsumers.includes(id)) {
      if (enabled !== 'no' && entry.trust !== 'blocked') {
        evidence.push([root, id, extensions ?? null, patterns, delta, enabled]);
        complete = false;
      }
      return;
    }
    const version = typeof manifest.version === 'string' ? manifest.version : null;
    // The observed releases require explicit local paths such as ./aw-packages/….
    // Pi itself omits ./ in the registration. See native-pi-package-agents evidence.
    const unsupportedSource = id === 'pi-subagents' && version && observedPiSubagentsLocalSources.has(version)
      && installedSources.length > 0 && installedSources.every((source) => /^aw-packages[/\\]/u.test(source));
    const access = unsupportedSource ? 'denied' : packageAccess(id, version, subagentSettings, packageNames);
    const reasonCodes = ['agentConsumerProtocolUnqualified', ...(unsupportedSource ? ['piAgentPackageSourceUnsupported'] : [])];
    evidence.push([root, id, version, extensions ?? null, patterns, delta, autoload, enabled, access, reasonCodes]);
    for (const product of binding.consumers) candidates.push({ productId: product.id, id, version,
      scope: entry.scope, enabled, trust: entry.trust, packageAccess: access,
      settings: { promptMode: 'unknown', loadExtensions: 'unknown' }, configurationEvidence: '', reasonCodes });
  }
  const scopes: SourceScope[] = [
    { root: agentRoot, scope: { kind: 'user' }, settings: user, trust: 'trusted' },
  ];
  if (binding.scope.kind === 'project') {
    scopes.push({ root: path.join(binding.scope.projectRoot, '.pi'), scope: binding.scope, settings: project, trust: projectTrust });
  }
  const userSkillSources = new Set(listed.flatMap((entry) =>
    entry.scope === 'user' && !entry.filtered && entry.installedPath && localSource(entry.source, agentRoot, home) === entry.installedPath
      ? [entry.installedPath] : []));
  const sourcesByIdentity = new Map<string, { root: string; entry: SourceScope; patterns?: string[]; delta?: string[]; autoload: boolean }>();
  for (const entry of scopes) {
    const sources = entry.settings.packages ?? [];
    const explicit = entry.settings.extensions ?? [];
    if (!Array.isArray(sources) || !stringArray(explicit) || sources.length + explicit.length > 256) throw new Error('piDiscoveryLimit');
    for (const sourceEntry of sources) {
      const filter = typeof sourceEntry === 'string' ? { source: sourceEntry } : object(sourceEntry);
      const source = filter.source;
      if (typeof source !== 'string') throw new Error('piPackageSourceInvalid');
      const patterns = filter.extensions;
      if (patterns !== undefined && (!stringArray(patterns) || patterns.length > 256)) throw new Error('piExtensionFilterInvalid');
      const native = listed.find((candidate) => candidate.scope === entry.scope.kind && candidate.source === source);
      const parsed = sourceLocation(source, entry.root, home);
      const root = native?.installedPath ?? parsed?.root;
      const identity = parsed?.identity ?? root;
      if (root && (filter.autoload === false || filter.skills !== undefined)) userSkillSources.delete(root);
      if (!root || !identity) {
        if (entry.trust !== 'blocked' && patterns?.length !== 0) complete = false;
        continue;
      }
      const key = entry.scope.kind === 'project' && entry.trust !== 'trusted' ? `untrusted:${identity}` : identity;
      const previous = sourcesByIdentity.get(key);
      if (previous?.entry.scope.kind === entry.scope.kind) continue;
      if (previous && filter.autoload === false) {
        previous.delta = patterns ?? [];
      } else if (!native || native.installedPath) {
        sourcesByIdentity.set(key, { root, entry, patterns, autoload: filter.autoload !== false });
      } else {
        sourcesByIdentity.delete(key);
      }
    }
    for (const extension of explicit.filter((value) => !/^(?:[!+-]|builtin:)/u.test(value))) {
      await inspectRoot(path.resolve(entry.root, extension.startsWith('~/') ? path.join(home, extension.slice(2)) : extension), entry,
        undefined, undefined, 'direct');
    }
    const autoRoot = path.join(entry.root, 'extensions');
    const entries = await fs.readdir(autoRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    if (entries.length > 256) throw new Error('piDiscoveryLimit');
    for (const item of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      const root = path.join(autoRoot, item.name);
      if (item.isDirectory() || item.isSymbolicLink()) await inspectRoot(root, entry, explicit, undefined, 'auto');
      else if (entry.trust !== 'blocked' && /\.[jt]s$/u.test(item.name) && (extensionDelta(root, entry.root, explicit) ?? true)) {
        evidence.push([root]);
        complete = false;
      }
    }
  }
  for (const { root, entry, patterns, delta, autoload } of sourcesByIdentity.values()) {
    await inspectRoot(root, entry, patterns, delta, 'package', autoload);
  }
  if (binding.scope.kind === 'project') projectUserSkillSources.set(result, userSkillSources);
  const configurationEvidence = digest(evidence);
  for (const candidate of candidates) candidate.configurationEvidence = configurationEvidence;
  result.prerequisites.agentConsumers = { observation: complete ? 'complete' : 'unknown', candidates,
    configurationEvidence, reasonCodes: [
      ...(complete ? [] : ['agentConsumerDiscoveryUnverified']),
      ...(binding.scope.kind === 'project' && projectTrust === 'blocked' ? ['piProjectTrustRequired'] : []),
    ] };
}
