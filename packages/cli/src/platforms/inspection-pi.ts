import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import type { AgentConsumerObservation, DeploymentBinding, DeploymentObservation, ReadContext, ScopeRef } from './contracts.js';
import { resolvePlatformConfigRoot } from './discovery.js';
import type { DeploymentLayout } from './layout.js';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('piConfigurationInvalid');
  return value as ObjectValue;
}
const digest = (value: unknown): string => `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

/** Read public configuration only. Never use Pi's trust store API: it acquires a write lock. */
export async function inspectPiDeployment(ctx: ReadContext, binding: DeploymentBinding, layout: DeploymentLayout,
  result: DeploymentObservation): Promise<void> {
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
  const entry = binding.consumers.find((consumer) => consumer.entry?.kind === 'cli')?.entry;
  const agentRoot = entry?.kind === 'cli' ? entry.configRoot : await resolvePlatformConfigRoot('pi', ctx);
  const user = await read(path.join(agentRoot, 'settings.json'), false);
  const projectRoot = binding.scope.kind === 'project' ? binding.scope.projectRoot : ctx.cwd;
  const project = await read(path.join(projectRoot, '.pi', 'settings.json'), false);
  // Package registrations are outputs of installation. Record actual consumer
  // manifests and filters below, not unrelated package registration text.
  for (const [root, config] of [[agentRoot, user], [path.join(projectRoot, '.pi'), project]] as const) {
    const { packages: _packages, ...consumerSettings } = config;
    evidence.push([path.join(root, 'settings.json'), consumerSettings]);
  }
  const trustFile = await read(path.join(agentRoot, 'trust.json'));
  let projectTrust: AgentConsumerObservation['trust'] = 'required';
  let cursor = await fs.realpath(projectRoot).catch(() => path.resolve(projectRoot));
  while (true) {
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
  function localSource(source: string, root: string): string | null {
    if (source.startsWith('~/')) return path.resolve(ctx.env?.HOME ?? path.dirname(path.dirname(agentRoot)), source.slice(2));
    if (path.isAbsolute(source) || source.startsWith('./') || source.startsWith('../')) return path.resolve(root, source);
    // Pi persists packages below its settings root as bare relative paths.
    // Recognize the AW namespace without treating remote/unknown sources as local.
    if (/^aw-packages[/\\]/u.test(source)) return path.resolve(root, source);
    return null;
  }
  result.registration = packages.some((entry) => {
    const source = typeof entry === 'string' ? entry : object(entry).source;
    return typeof source === 'string' && localSource(source, path.dirname(layout.activationPath)) === layout.packageRoot;
  }) ? 'present' : 'absent';
  for (const consumer of result.consumers) {
    consumer.trust = binding.scope.kind === 'user' ? 'trusted' : projectTrust;
    consumer.activation = result.registration === 'absent' ? 'disabled' : consumer.trust === 'trusted' ? 'enabled' : 'blocked';
  }
  // Pi 1.5's public package/filter and trust formats are observed separately
  // from qualification of any consumer's invocation protocol.
  if (binding.consumers.some((consumer) => consumer.version !== '1.5.0')) complete = false;
  const candidates: AgentConsumerObservation[] = [];
  const userSubagents = await read(path.join(agentRoot, 'subagents.json'));
  const projectSubagents = await read(path.join(projectRoot, '.pi', 'subagents.json'));
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
  if (binding.scope.kind === 'project') scopes.push({ root: path.join(projectRoot, '.pi'), scope: binding.scope, settings: project, trust: projectTrust });
  for (const entry of scopes) {
    const sources = entry.settings.packages ?? [];
    const explicit = entry.settings.extensions ?? [];
    if (!Array.isArray(sources) || !Array.isArray(explicit) || sources.length + explicit.length > 256) throw new Error('piDiscoveryLimit');
    for (const sourceEntry of sources) {
      const filter = typeof sourceEntry === 'string' ? { source: sourceEntry } : object(sourceEntry);
      const source = filter.source;
      if (typeof source !== 'string') throw new Error('piPackageSourceInvalid');
      let root = localSource(source, entry.root);
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
      const root = localSource(extension, entry.root);
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
