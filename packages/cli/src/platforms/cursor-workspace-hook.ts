import path from 'node:path';
import fs from 'fs-extra';
import type { PluginMeta, Scope } from '../types.js';
import { readDemand, type DemandSnapshot } from '../recovery/demand.js';
import { canonicalPluginId } from '../intent/intent-codec.js';
import { resolvePluginMetaDependencyClosure } from '../utils/plugin-dependencies.js';
import { supportsPlatform } from '../utils/platform-support.js';
import { readSkillOwnerMarker, SKILL_OWNER_MARKER } from '../utils/ownership.js';
import { assertSafeFileMutationPath } from '../utils/safe-fs.js';
import { assertTestReadablePath } from '../utils/test-path-fence.js';
import { resolveUserHome } from '../utils/state-paths.js';
import { getDeploymentResourceKey, resolveCursorPackageRoot } from './layout.js';
import { canonicalNamespaceRoot, getPhysicalKey } from './identity.js';
import { resolvePlatformConfigRoot, type ReadContext } from './discovery.js';
import type { PluginIdentity, ScopeRef } from './contracts.js';

export interface CursorWorkspaceHookResult { pluginPaths: string[] }
export interface CursorWorkspaceHookOptions {
  scope: Scope;
  projectRoot?: string;
  pluginId?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

function requiredPlugins(demand: DemandSnapshot): PluginMeta[] {
  if (demand.preferences.state !== 'valid' || !demand.preferences.value.targets.includes('cursor')) return [];
  const excluded = new Set(demand.preferences.value.exclusions.filter((item) => item.target === 'cursor').map((item) => item.plugin));
  const selected = new Map<string, PluginMeta>();
  for (const root of demand.roots ?? []) {
    if (!root.plugin || root.blockers.length || root.sourceState !== 'ready' || excluded.has(root.pluginId)) continue;
    try {
      const closure = resolvePluginMetaDependencyClosure(demand.plugins.filter((plugin) => plugin.sourceId === root.sourceId), [root.plugin.manifest.name]);
      if (closure.some((plugin) => !supportsPlatform(plugin.manifest, 'cursor') || !plugin.pluginId || excluded.has(plugin.pluginId))) continue;
      for (const plugin of closure) selected.set(plugin.pluginId!, plugin);
    } catch { /* An unreadable dependency does not authorize loading a partial root. */ }
  }
  return [...selected.values()];
}

async function workspaceRoots(input: unknown): Promise<string[]> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('cursorHookInputInvalid');
  const roots = (input as { workspace_roots?: unknown }).workspace_roots;
  if (roots === undefined) return [];
  if (!Array.isArray(roots) || roots.length > 64 || roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0'))) {
    throw new Error('cursorHookInputInvalid');
  }
  const canonical: string[] = [];
  for (const root of roots as string[]) {
    assertTestReadablePath(root, 'Cursor Hook workspace', '使用隔离 workspace_roots。');
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error('cursorHookWorkspaceInvalid');
    canonical.push(await fs.realpath(root));
  }
  return [...new Set(canonical)];
}

/** Host loader: reads current demand and exact package ownership, without probes, rendering, or writes. */
export async function cursorWorkspaceOpen(input: unknown, options: CursorWorkspaceHookOptions): Promise<CursorWorkspaceHookResult> {
  options.signal?.throwIfAborted();
  const roots = await workspaceRoots(input);
  if (!roots.length) return { pluginPaths: [] };
  let scope: ScopeRef = { kind: 'user' };
  let cwd = options.cwd;
  if (options.scope === 'project') {
    if (!options.projectRoot || !path.isAbsolute(options.projectRoot)) throw new Error('cursorHookProjectRootRequired');
    const projectRoot = await fs.realpath(options.projectRoot);
    if (!roots.includes(projectRoot)) return { pluginPaths: [] };
    scope = { kind: 'project', projectRoot }; cwd = projectRoot;
  } else if (options.projectRoot !== undefined) throw new Error('cursorHookArgumentsInvalid');
  const demand = await readDemand({ scope: options.scope, cwd, env: options.env, signal: options.signal });
  const ctx: ReadContext = { cwd, env: options.env, signal: options.signal };
  const paths = new Set<string>();
  for (const plugin of requiredPlugins(demand)) {
    options.signal?.throwIfAborted();
    if (options.pluginId !== undefined && plugin.pluginId !== options.pluginId) continue;
    if (!plugin.pluginId || !plugin.sourceId || !plugin.sourceIdentity) continue;
    const identity: PluginIdentity = { pluginId: plugin.pluginId, sourceId: plugin.sourceId,
      sourceIdentity: plugin.sourceIdentity, version: plugin.manifest.version };
    const packageRoot = await resolveCursorPackageRoot(ctx, identity, scope);
    const namespaceRoot = await canonicalNamespaceRoot(scope.kind === 'project' ? path.join(scope.projectRoot, '.cursor')
      : resolvePlatformConfigRoot('cursor', ctx));
    const physicalKey = getPhysicalKey({ sourceIdentity: identity.sourceIdentity, pluginId: identity.pluginId,
      platform: 'cursor', route: 'cursor-workspace-hook', namespaceRoot, resourceKey: getDeploymentResourceKey(identity) });
    const allowedRoot = scope.kind === 'project' ? scope.projectRoot : resolveUserHome(options.env ?? process.env);
    try {
      // Check the full scope path before reading a canonicalized package location.
      const expectedPath = path.join(scope.kind === 'project' ? scope.projectRoot : allowedRoot, '.cursor', 'aw-plugins', getDeploymentResourceKey(identity));
      if (packageRoot !== expectedPath) continue;
      await assertSafeFileMutationPath({ filePath: path.join(packageRoot, SKILL_OWNER_MARKER), allowedRoot, label: 'Cursor plugin owner' });
      const marker = await readSkillOwnerMarker({ skillRoot: packageRoot, allowedRoot: path.dirname(packageRoot),
        expectedIdentity: { owner: 'agent-workflows', sourceId: identity.sourceId, pluginId: identity.pluginId,
          plugin: plugin.manifest.name, platform: 'cursor', scope: options.scope, artifactKey: path.basename(packageRoot),
          sourceIdentity: identity.sourceIdentity, physicalKey } });
      if (!marker || marker.sourceIdentity !== identity.sourceIdentity || marker.physicalKey !== physicalKey) continue;
      const manifestPath = path.join(packageRoot, '.cursor-plugin', 'plugin.json');
      await assertSafeFileMutationPath({ filePath: manifestPath, allowedRoot: packageRoot, label: 'Cursor native manifest' });
      const manifest = await fs.readJson(manifestPath) as { name?: unknown };
      if (manifest.name !== plugin.manifest.name) continue;
      paths.add(packageRoot);
    } catch { /* Missing, foreign, stale, and unknown packages remain unloaded. */ }
  }
  return { pluginPaths: [...paths].sort() };
}

async function readHookInput(stdin: NodeJS.ReadableStream): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const finish = (error?: Error): void => {
      clearTimeout(timer); stdin.removeListener('data', data); stdin.removeListener('end', end); stdin.removeListener('error', failed); stdin.pause();
      if (error) reject(error);
      else { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('cursorHookInputInvalid')); } }
    };
    const data = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 64 * 1024) { finish(new Error('cursorHookInputTooLarge')); return; }
      chunks.push(bytes);
    };
    const end = (): void => finish();
    const failed = (): void => finish(new Error('cursorHookInputUnreadable'));
    const timer = setTimeout(() => finish(new Error('cursorHookInputTimeout')), 5000);
    stdin.on('data', data); stdin.once('end', end); stdin.once('error', failed);
  });
}

/** Internal host protocol deliberately emits the Cursor Hook object, without the AW result envelope. */
export async function runCursorWorkspaceHookCli(args: readonly string[], options: {
  cwd: string; env?: NodeJS.ProcessEnv; stdin: NodeJS.ReadableStream;
  stdout(text: string): void; stderr(text: string): void;
}): Promise<number> {
  let scope: Scope | undefined; let projectRoot: string | undefined; let pluginId: string | undefined;
  try {
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index], value = args[index + 1];
      if (flag === '--scope' && scope === undefined && (value === 'user' || value === 'project')) scope = value;
      else if (flag === '--project-root' && projectRoot === undefined && value && path.isAbsolute(value)) projectRoot = value;
      else if (flag === '--plugin-id' && pluginId === undefined && value && canonicalPluginId(value) === value) pluginId = value;
      else throw new Error('cursorHookArgumentsInvalid');
    }
    if (!scope || (scope === 'project') !== (projectRoot !== undefined)) throw new Error('cursorHookArgumentsInvalid');
  } catch {
    options.stdout('{"pluginPaths":[]}\n'); options.stderr('cursorHookArgumentsInvalid: Use --scope user, or --scope project --project-root <absolute root>.\n'); return 2;
  }
  try {
    const result = await cursorWorkspaceOpen(await readHookInput(options.stdin), { ...options, scope, projectRoot, pluginId });
    options.stdout(`${JSON.stringify(result)}\n`); return 0;
  } catch {
    options.stdout('{"pluginPaths":[]}\n'); options.stderr('cursorHookUnavailable: The current workspace plugin paths could not be confirmed. Check AW requirements and package ownership.\n'); return 1;
  }
}
