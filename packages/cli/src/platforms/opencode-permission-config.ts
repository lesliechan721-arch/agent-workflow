import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, createScanner, findNodeAtLocation, getNodeValue, modify, parseTree, SyntaxKind,
  type Node as JsonNode, type ParseError } from 'jsonc-parser';
import { canonicalizePathThroughExistingAncestor, readEnvironmentValue } from '../utils/state-paths.js';
import { parseSkillFrontmatter } from '../utils/skill-validation.js';
import { getOpenCodePermissionRoot } from './layout.js';
import type { ReadContext } from './contracts.js';
import type { OpenCodeLayerRule } from './opencode-permissions.js';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function invalid(): never {
  throw new Error('permissionConfigConflict: Review and repair the OpenCode configuration, then retry.');
}

const opaqueConfiguredPolicy = { configured: 'unresolved' };

function isReadableRule(value: unknown): boolean {
  return record(value) && typeof value.action === 'string' && typeof value.resource === 'string'
    && typeof value.effect === 'string' && /^(?:allow|ask|deny|\{(?:env|file):[^}]+\})$/u.test(value.effect);
}

function auxiliaryRules(config: Record<string, unknown>, topLevel = false): unknown[] {
  // V2 also normalizes V1 settings. A new V2 rule must not overwrite a
  // restriction whose migrated semantics AW cannot establish.
  const unknown = ['permission', 'tools', ...(topLevel ? ['agent', 'mode'] : [])].some((key) => Object.hasOwn(config, key))
    || Object.keys(config).some((key) => /\{(?:file|env):/u.test(key));
  const rules: unknown[] = unknown ? [opaqueConfiguredPolicy] : [];
  if (config.permissions !== undefined) {
    if (Array.isArray(config.permissions)) rules.push(...config.permissions);
    else rules.push(opaqueConfiguredPolicy);
  }
  return rules;
}

function checkUniqueFields(node: JsonNode): void {
  if (node.type === 'object') {
    const keys = node.children?.map((property) => property.children?.[0]?.value) ?? [];
    if (new Set(keys).size !== keys.length) invalid();
  }
  node.children?.forEach(checkUniqueFields);
}

// Preserve every comment and the original bytes of each retained entry. Only
// remove commas outside the entry nodes, where the new ordering determines them.
function withoutComma(trivia: string): string {
  const scanner = createScanner(trivia, true);
  if (scanner.scan() !== SyntaxKind.CommaToken) return trivia;
  const offset = scanner.getTokenOffset();
  return trivia.slice(0, offset) + trivia.slice(offset + 1);
}

export function parseOpenCodePermissionDocument(text: string, requireValidRules = true) {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length || !root || root.type !== 'object') invalid();
  checkUniqueFields(root);
  const config: unknown = getNodeValue(root);
  if (!record(config)) invalid();
  const array = findNodeAtLocation(root, ['permissions']);
  if (array && array.type !== 'array') invalid();
  const permissions: unknown[] = (config.permissions as unknown[]) ?? [];
  if (requireValidRules && !permissions.every(isReadableRule)) invalid();
  const { permissions: _permissions, ...rest } = config;
  const agentRules = auxiliaryRules(rest, true);
  if (record(config.agents)) {
    for (const agent of Object.values(config.agents)) agentRules.push(...(record(agent) ? auxiliaryRules(agent) : [opaqueConfiguredPolicy]));
  } else if (config.agents !== undefined) agentRules.push(opaqueConfiguredPolicy);
  // Conditional policy statements can impose additional restrictions.
  for (const policies of [config.policies, record(config.experimental) ? config.experimental.policies : undefined]) {
    if (Array.isArray(policies)) for (const policy of policies) {
      if (record(policy)) agentRules.push(...auxiliaryRules(policy));
    }
  }

  function writePermissions(entries: unknown[]): string {
    if (isDeepStrictEqual(permissions, entries)) return text;
    if (!array) return applyEdits(text, modify(text, ['permissions'], entries, {}));
    const nodes = array.children ?? [];
    const known = new Set(permissions);
    const first = entries.findIndex((entry) => known.has(entry));
    const last = entries.map((entry) => known.has(entry)).lastIndexOf(true);
    const before = first < 0 ? entries : entries.slice(0, first);
    const after = first < 0 ? [] : entries.slice(last + 1);
    const retained = new Set(first < 0 ? [] : entries.slice(first, last + 1));
    let offset = array.offset + 1;
    let result = text.slice(0, offset) + before.map((entry) => JSON.stringify(entry)).join(',');
    let remaining = entries.length - before.length;
    if (before.length && remaining) result += ',';
    for (const [index, node] of nodes.entries()) {
      result += withoutComma(text.slice(offset, node.offset));
      offset = node.offset + node.length;
      if (retained.has(permissions[index])) {
        result += text.slice(node.offset, offset);
        if (--remaining) result += ',';
      }
    }
    const end = array.offset + array.length - 1;
    return result + withoutComma(text.slice(offset, end)) + after.map((entry) => JSON.stringify(entry)).join(',') + text.slice(end);
  }
  return { permissions, agentRules, writePermissions };
}

type PermissionDocument = ReturnType<typeof parseOpenCodePermissionDocument>;
export type OpenCodeGlobalPolicy = Pick<PermissionDocument, 'permissions' | 'agentRules'> & { path: string };

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readRules(file: string, parse: (bytes: string) => unknown[]): Promise<unknown[]> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return [null];
    return parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    return missing(error) ? [] : [null];
  }
}

async function agentFiles(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const groups = await Promise.all(entries.map(async (entry): Promise<string[]> => {
      const file = path.join(root, entry.name);
      if (entry.isSymbolicLink()) return [file]; // Unresolved directory aliases are opaque.
      if (entry.isDirectory()) return agentFiles(file);
      return entry.name.endsWith('.md') ? [file] : [];
    }));
    return groups.flat().sort();
  } catch (error) {
    return missing(error) ? [] : [root];
  }
}

export async function readOpenCodePermissionChain(ctx: ReadContext, destination: string,
  hostConfigRoot: string | undefined, projectRoot: string | undefined, doc?: Pick<PermissionDocument, 'agentRules'>,
  globalPolicy?: OpenCodeGlobalPolicy, priorProjects?: ReadonlyMap<string, OpenCodeGlobalPolicy>): Promise<OpenCodeLayerRule[]> {
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const environment = (key: string) => readEnvironmentValue(env, key, platform);
  const paths: string[] = [];
  const directories: string[] = [];
  const resolveLayerPath = (file: string) => {
    const resolved = canonicalizePathThroughExistingAncestor(file);
    // A read-only scan can report an unreadable layer at its original path.
    return doc ? resolved : resolved.catch(() => path.resolve(file));
  };
  const addFiles = (dir: string, withAgents: boolean) => {
    paths.push(path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc'));
    if (withAgents) directories.push(path.join(dir, 'agents'));
  };
  const userRoot = getOpenCodePermissionRoot(ctx, hostConfigRoot);
  if (userRoot) addFiles(await resolveLayerPath(userRoot), true);
  const customFile = environment('OPENCODE_CONFIG');
  if (customFile) paths.push(path.resolve(ctx.invocationCwd ?? ctx.cwd, customFile));
  if (projectRoot) {
    const ancestors: string[] = [];
    const scope = await resolveLayerPath(projectRoot);
    const working = await resolveLayerPath(ctx.invocationCwd ?? ctx.cwd);
    const relative = path.relative(scope, working);
    const inside = !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
    for (let dir = inside ? working : scope; ; dir = path.dirname(dir)) {
      ancestors.unshift(dir);
      if (dir === path.dirname(dir)) break;
    }
    ancestors.forEach((dir) => addFiles(dir, false));
    ancestors.forEach((dir) => addFiles(path.join(dir, '.opencode'), true));
  }
  const system = platform === 'darwin' ? '/Library/Application Support/opencode'
    : platform === 'win32' ? path.join(environment('ProgramData') ?? 'C:\\ProgramData', 'opencode') : '/etc/opencode';
  addFiles(system, true);
  const target = await resolveLayerPath(destination);
  const isTarget = (file: string) => {
    const candidate = path.resolve(file);
    return candidate === destination || candidate === target;
  };
  const position = paths.findIndex(isTarget);
  const append = (file: string, rules: unknown[], layer: OpenCodeLayerRule['layer'], source?: OpenCodeLayerRule['source']): OpenCodeLayerRule[] =>
    rules.map((rule) => ({ path: file, rule, layer, ...(source ? { source } : {}) }));
  const layers = await Promise.all(paths.map(async (candidate, index) => {
    ctx.signal?.throwIfAborted();
    const targetFile = isTarget(candidate);
    if (targetFile && doc) return append(candidate, doc.agentRules, 'higher', 'agent');
    if (targetFile && index !== position) return [];
    const file = targetFile ? destination : candidate;
    const layer = index < position ? 'lower' : 'higher';
    const resolved = path.resolve(file);
    const policy = globalPolicy && resolved === globalPolicy.path ? globalPolicy : priorProjects?.get(resolved);
    if (policy) {
      return [...append(file, policy.permissions, layer, 'config'), ...append(file, policy.agentRules, 'higher', 'agent')];
    }
    // Agent and conditional policy rules retain their precedence even when
    // their enclosing configuration document is below the target.
    let agents: unknown[] = [];
    const rules = await readRules(file, (bytes) => {
      const value = parseOpenCodePermissionDocument(bytes, false);
      agents = value.agentRules;
      return value.permissions.map((rule) => isReadableRule(rule) ? rule : null);
    });
    return [...append(file, rules, layer, 'config'), ...append(file, agents, 'higher', 'agent')];
  }));
  if (!userRoot) layers.push(append('OPENCODE_CONFIG_DIR', [null], 'higher'));
  for (const dir of new Set(directories)) {
    for (const file of await agentFiles(dir)) {
      const rules = await readRules(file, (text) => {
        const { frontmatter, errors } = parseSkillFrontmatter(text, file);
        return errors.length || !frontmatter ? [null] : auxiliaryRules(frontmatter);
      });
      layers.push(append(file, rules, 'higher'));
    }
  }
  const content = environment('OPENCODE_CONFIG_CONTENT');
  if (content) {
    try {
      const inline = parseOpenCodePermissionDocument(content, false);
      layers.push(append('OPENCODE_CONFIG_CONTENT', [...inline.permissions.map((rule) => isReadableRule(rule) ? rule : null), ...inline.agentRules], 'higher'));
    } catch { layers.push(append('OPENCODE_CONFIG_CONTENT', [null], 'higher')); }
  }
  if (platform === 'darwin') {
    for (const directory of ['/Library/Managed Preferences', path.join('/Library/Managed Preferences', os.userInfo().username)]) {
      const file = path.join(directory, 'ai.opencode.managed.plist');
      try { await fs.access(file); }
      catch (error) { if (missing(error)) continue; }
      layers.push(append(file, [null], 'higher'));
    }
  }
  if (projectRoot && /^(?:1|true)$/iu.test(environment('OPENCODE_CONFIG_PROJECT_DISABLE') ?? environment('OPENCODE_DISABLE_PROJECT_CONFIG') ?? '')) {
    layers.push(append(destination, [null], 'disabled'));
  }
  return layers.flat();
}
