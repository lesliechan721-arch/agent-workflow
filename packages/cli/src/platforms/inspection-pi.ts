import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import type { AgentConsumerObservation, DeploymentBinding, DeploymentObservation, ReadContext, ScopeRef } from './contracts.js';
import { resolvePlatformConfigRoot } from './discovery.js';
import type { DeploymentLayout } from './layout.js';
import { queryNativeDeployment } from './inspection-query.js';
import { rethrowFatalError } from '../utils/codex-executable-discovery.js';
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

/** Pi 1.5 list reports configured packages. It does not report activation or trust. */
function nativeRegistration(text: string, binding: DeploymentBinding, layout: DeploymentLayout, agentRoot: string,
  home: string): DeploymentObservation['registration'] | 'scope-not-visible' {
  const lines = text.replace(/\u001b\[[0-9;]*m/gu, '').trimEnd().split(/\r?\n/u);
  if (lines.length === 1 && lines[0] === 'No packages installed.') return binding.scope.kind === 'user' ? 'absent' : 'scope-not-visible';
  let scope: 'user' | 'project' | undefined;
  const seen = new Set<string>();
  const entries: Array<{ scope: 'user' | 'project'; source: string; installedPath?: string }> = [];
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
      entries.push({ scope, source });
    } else throw new Error('piNativeListInvalid');
  }
  if (!seen.size || [...seen].some((scope) => !entries.some((entry) => entry.scope === scope))) throw new Error('piNativeListInvalid');
  if (!seen.has(binding.scope.kind)) return binding.scope.kind === 'project' ? 'scope-not-visible' : 'unknown';
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
  try {
    const registration = nativeRegistration(await queryNativeDeployment(ctx, binding, ['list']), binding, layout,
      agentRoot, resolveUserHome(ctx.env ?? process.env, ctx.platform ?? process.platform));
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
  try { await inspectPiConfiguration(ctx, binding, layout, result, agentRoot); }
  catch (error) {
    rethrowFatalError(error); ctx.signal?.throwIfAborted();
    result.configuration = { scope: binding.scope.kind, activation: 'unknown', trust: 'unknown', reasonCodes: ['piConfigurationUnconfirmed'] };
    result.prerequisites.agentConsumers = { observation: 'unknown', candidates: [], reasonCodes: ['agentConsumerDiscoveryUnverified'] };
    result.diagnostics.push({ code: 'piConfigurationUnconfirmed', severity: 'warning',
      message: 'Pi supplemental configuration or Agent consumer settings could not be read.', subject: { target: 'pi', scope: binding.scope.kind } });
  }
}

/** Supplemental public files never replace native package or consumer facts. */
async function inspectPiConfiguration(ctx: ReadContext, binding: DeploymentBinding, layout: DeploymentLayout,
  result: DeploymentObservation, agentRoot: string): Promise<void> {
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
  const trustFile = await read(path.join(agentRoot, 'trust.json'));
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
  const settings = binding.scope.kind === 'user' ? user : project;
  const packages = settings.packages ?? [];
  if (!Array.isArray(packages)) throw new Error('piPackagesInvalid');
  const home = resolveUserHome(ctx.env ?? process.env, ctx.platform ?? process.platform);
  const resolveSource = (source: string, root: string) => localSource(source, root, home);
  const configured = packages.some((entry) => {
    const source = typeof entry === 'string' ? entry : object(entry).source;
    return typeof source === 'string' && resolveSource(source, path.dirname(layout.activationPath)) === layout.packageRoot;
  });
  result.configuration = { scope: binding.scope.kind, activation: configured ? 'enabled' : 'absent',
    trust: binding.scope.kind === 'user' ? 'trusted' : projectTrust, reasonCodes: [] };
  // Pi 1.5's public package/filter and trust formats are observed separately
  // from qualification of any consumer's invocation protocol.
  const candidates: AgentConsumerObservation[] = [];
  const userSubagents = await read(path.join(agentRoot, 'subagents.json'));
  const projectSubagents = projectRoot ? await read(path.join(projectRoot, '.pi', 'subagents.json')) : {};
  // The target package name is fixed by the same layout used by projection;
  // it does not depend on whether this operation has published the package yet.
  const packageNames = [layout.nativeIdentity.packageId, layout.nativeIdentity.packageId.split('/').pop()!]
    .map((value) => value.toLowerCase());
  const seen = new Set<string>();
  async function inspectRoot(root: string, scope: ScopeRef, filter: ObjectValue, trust: AgentConsumerObservation['trust']): Promise<void> {
    const key = `${scope.kind}:${root}`; if (seen.has(key)) return; seen.add(key);
    const manifest = await read(path.join(root, 'package.json'), false);
    if (!Object.keys(manifest).length) { evidence.push([root, null, filter]); complete = false; return; }
    if (!['pi-subagents', '@tintinweb/pi-subagents'].includes(String(manifest.name))) return;
    evidence.push([root, manifest, filter]);
    const id = String(manifest.name);
    const pi = manifest.pi === undefined ? {} : object(manifest.pi);
    const extensions = pi.extensions;
    let enabled: AgentConsumerObservation['enabled'] = 'unknown';
    if (filter.extensions !== undefined && !Array.isArray(filter.extensions)) throw new Error('piExtensionFilterInvalid');
    if (Array.isArray(filter.extensions) && filter.extensions.length === 0) enabled = 'no';
    else if (Array.isArray(extensions) && extensions.length && filter.extensions === undefined && filter.autoload !== false) {
      const paths = extensions.filter((value): value is string => typeof value === 'string' && !/[*!?]/u.test(value));
      if (paths.length === extensions.length && (await Promise.all(paths.map((value) => fs.pathExists(path.resolve(root, value))))).every(Boolean)) enabled = 'yes';
    }
    const version = typeof manifest.version === 'string' ? manifest.version : null;
    let packageAccess: AgentConsumerObservation['packageAccess'] = 'unknown';
    // Only the exact documented configuration dialect is decoded. A newer
    // version is still visible, but cannot silently inherit these semantics.
    if (id === '@tintinweb/pi-subagents' && version === '0.22.0') {
      const config = { ...userSubagents, ...projectSubagents };
      const gate = config.packageAgents ?? true;
      packageAccess = gate === true ? 'allowed' : gate === false ? 'denied' : Array.isArray(gate) && gate.every((item) => typeof item === 'string')
        ? gate.some((item: string) => packageNames.includes(item.toLowerCase())) ? 'allowed'
          : gate.some((item: string) => path.isAbsolute(item) || item.startsWith('.') || item.includes(':')) ? 'unknown' : 'denied' : 'unknown';
    } else if (id === 'pi-subagents' && version === '0.87.0') packageAccess = 'allowed';
    for (const product of binding.consumers) candidates.push({ productId: product.id, id, version, scope, enabled, trust, packageAccess,
      settings: { promptMode: 'unknown', loadExtensions: 'unknown' }, configurationEvidence: '', reasonCodes: ['agentConsumerProtocolUnqualified'] });
  }
  const scopes: Array<{ root: string; scope: ScopeRef; settings: ObjectValue; trust: AgentConsumerObservation['trust'] }> = [
    { root: agentRoot, scope: { kind: 'user' }, settings: user, trust: 'trusted' },
  ];
  if (binding.scope.kind === 'project') scopes.push({ root: path.join(binding.scope.projectRoot, '.pi'), scope: binding.scope, settings: project, trust: projectTrust });
  for (const entry of scopes) {
    const sources = entry.settings.packages ?? [];
    const explicit = entry.settings.extensions ?? [];
    if (!Array.isArray(sources) || !Array.isArray(explicit) || sources.length + explicit.length > 256) throw new Error('piDiscoveryLimit');
    for (const sourceEntry of sources) {
      const filter = typeof sourceEntry === 'string' ? { source: sourceEntry } : object(sourceEntry);
      const source = filter.source;
      if (typeof source !== 'string') throw new Error('piPackageSourceInvalid');
      let root = resolveSource(source, entry.root);
      if (source.startsWith('npm:')) {
        const name = source.slice(4).match(/^(@[^/]+\/[^@]+|[^@/]+)(?:@[^/]+)?$/u)?.[1];
        if (name && !name.includes('..')) root = path.join(entry.root, 'npm', 'node_modules', name);
      } else if (source.startsWith('git:') || source.startsWith('https://')) {
        const match = source.replace(/^git:/u, '').replace(/^https:\/\//u, '').match(/^([\w.-]+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@[^/]+)?$/u);
        if (match && !match.slice(1, 4).includes('..')) root = path.join(entry.root, 'git', match[1]!, match[2]!, match[3]!);
      }
      if (root) await inspectRoot(root, entry.scope, filter, entry.trust);
      else { evidence.push(['unresolvedPackage', entry.scope, filter]); complete = false; }
    }
    for (const extension of explicit) {
      if (typeof extension !== 'string') throw new Error('piExtensionSourceInvalid');
      const root = resolveSource(extension, entry.root);
      if (!root || path.extname(root)) complete = false; else await inspectRoot(root, entry.scope, {}, entry.trust);
    }
    const autoRoot = path.join(entry.root, 'extensions');
    const entries = await fs.readdir(autoRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    evidence.push([autoRoot, entries.map((item) => item.name).sort()]);
    if (entries.length > 256) throw new Error('piDiscoveryLimit');
    for (const item of entries) {
      if (item.isDirectory()) await inspectRoot(path.join(autoRoot, item.name), entry.scope, {}, entry.trust);
      else if (item.isSymbolicLink() || /\.[cm]?[jt]s$/u.test(item.name)) complete = false;
    }
  }
  const configurationEvidence = digest(evidence);
  for (const candidate of candidates) candidate.configurationEvidence = configurationEvidence;
  result.prerequisites.agentConsumers = { observation: complete ? 'complete' : 'unknown', candidates,
    configurationEvidence, reasonCodes: complete ? [] : ['agentConsumerDiscoveryUnverified'] };
}
