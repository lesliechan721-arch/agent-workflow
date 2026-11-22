import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { applyEdits, findNodeAtLocation, modify, parseTree, type ParseError } from 'jsonc-parser';

import { assertSafeFileMutationPath } from '../utils/safe-fs.js';
import { resolveUserHome } from '../utils/state-paths.js';
import { assertTestReadablePath } from '../utils/test-path-fence.js';
import type { DeploymentBinding, ReadContext } from './contracts.js';
import { canonicalNamespaceRoot } from './identity.js';
import { permissionConflict, readPermissionHost, type HostPermissionAdjustment, type PermissionClaim } from './permission-sidecar.js';

const actions = ['allow', 'ask', 'deny'] as const;
const shellAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const commandRule = /^command\(([^\r\n]+)\)$/u;
const literalWord = /^[^\p{C}\s"'\\*;&|<>`$()]+$/u;
const plainWord = /^[\p{L}\p{M}\p{N}\p{So}_./:@%+=,-]+$/u;
const regexRulePrefix = 'command(regex:';
type Action = PermissionClaim['effect'];
type Rule = { effect: Action; resource: string; action?: 'shell'; sourceLiteral?: string };
export type AntigravityPermission = Rule & { action: 'shell' };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAction(value: unknown): value is Action {
  return actions.some((action) => action === value);
}

function literalPrefix(tokens: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  const executable = tokens[0];
  return !!executable && !shellAssignment.test(executable)
    && tokens.every((token) => literalWord.test(token)
      || platform === 'win32' && token.includes('\\') && literalWord.test(token.replace(/\\/gu, '/')));
}

export function antigravityCommandTokens(rule: string): string[] | undefined {
  const tokens = commandRule.exec(rule)?.[1]?.trim().split(/\s+/u);
  return tokens && !tokens[0]?.startsWith('regex:') && literalPrefix(tokens)
    && !innerCommand(tokens).adjusted && !developerToolRequiresExactMatch(tokens) ? tokens : undefined;
}

function literalResource(tokens: readonly string[]): string {
  if (tokens[0]?.startsWith('regex:')) return regexRulePrefix + tokens.map(escapeRegexWord).join(' ') + ')';
  return 'command(' + tokens.join(' ') + ')';
}

function escapeRegexWord(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function isAntigravityPermission(value: unknown): value is AntigravityPermission {
  return record(value) && Object.keys(value).length === 3 && value.action === 'shell' && isAction(value.effect) && typeof value.resource === 'string'
    && commandRule.test(value.resource);
}

export function parseAntigravityPermissionDocument(text: string) {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true });
  if (!root || root.type !== 'object' || errors.length) throw permissionConflict();
  for (const node of [root, findNodeAtLocation(root, ['permissions'])]) {
    if (node?.type !== 'object') continue;
    const keys = node.children?.map((item) => item.children?.[0]?.value) ?? [];
    if (new Set(keys).size !== keys.length) throw permissionConflict();
  }

  const settings = JSON.parse(text) as Record<string, unknown>;
  if (settings.permissions !== undefined && !record(settings.permissions)) throw permissionConflict();
  if (settings.toolPermission !== undefined && (typeof settings.toolPermission !== 'string'
    || !['request-review', 'proceed-in-sandbox', 'always-proceed', 'strict'].includes(settings.toolPermission))) throw permissionConflict();
  const lists: Record<string, unknown> = settings.permissions ?? {};
  const permissions = actions.flatMap((effect) => {
    const resources = lists[effect];
    if (resources === undefined) return [];
    if (!Array.isArray(resources) || resources.some((value) => typeof value !== 'string')) throw permissionConflict();
    return resources.map((resource: string, index: number): Rule => {
      const node = findNodeAtLocation(root, ['permissions', effect, index])!;
      const literal = text.slice(node.offset, node.offset + node.length);
      const rule: Rule = commandRule.test(resource) ? { action: 'shell', effect, resource } : { effect, resource };
      // A user can adopt an entry by spelling the same string differently.
      if (literal !== JSON.stringify(resource)) rule.sourceLiteral = literal;
      return rule;
    });
  });
  const permissionGroup = (entry: unknown): Action => {
    if (!record(entry) || !isAction(entry.effect) || typeof entry.resource !== 'string') throw permissionConflict();
    return entry.effect;
  };

  function writePermissions(entries: unknown[]): string {
    const grouped: Record<Action, Rule[]> = { allow: [], ask: [], deny: [] };
    for (const entry of entries as Rule[]) grouped[permissionGroup(entry)].push(entry);
    let result = text;
    for (const action of actions) {
      const resources = grouped[action].map((rule) => rule.resource);
      if (isDeepStrictEqual(lists[action] ?? [], resources)) continue;
      result = applyEdits(result, modify(result, ['permissions', action], resources, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' },
      }));
      const array = findNodeAtLocation(parseTree(result)!, ['permissions', action]);
      const spellings = grouped[action].flatMap(({ sourceLiteral }, index) => {
        const node = array?.children?.[index];
        return sourceLiteral && node ? [{ offset: node.offset, length: node.length, content: sourceLiteral }] : [];
      });
      result = applyEdits(result, spellings);
    }
    return result;
  }

  return { strict: settings.toolPermission === 'strict', permissions, permissionGroup, writePermissions };
}

export function supportsAntigravityGlobalPermissions(binding: DeploymentBinding): boolean {
  return binding.platform === 'antigravity' && binding.scope.kind === 'user' && binding.route === 'antigravity-cli'
    && binding.consumers.some((consumer) => consumer.product === 'cli' && consumer.entry?.kind === 'cli' && consumer.availability === 'available');
}

async function antigravityHome(ctx: ReadContext): Promise<string> {
  return canonicalNamespaceRoot(resolveUserHome(ctx.env ?? process.env, ctx.platform));
}

function settingsPath(home: string): string {
  return path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
}

export async function getAntigravityGlobalPermissionPath(ctx: ReadContext): Promise<string | undefined> {
  try { return settingsPath(await antigravityHome(ctx)); } catch { return undefined; }
}

export async function assertAntigravityGlobalPermissionPath(ctx: ReadContext, destination: string): Promise<void> {
  try {
    const home = await antigravityHome(ctx);
    if (destination !== settingsPath(home)) throw permissionConflict();
    await assertSafeFileMutationPath({ allowedRoot: home, filePath: destination, label: 'Antigravity permissions' });
  } catch {
    throw permissionConflict();
  }
}

export async function readAntigravityGlobalPermissions(ctx: ReadContext) {
  const file = await getAntigravityGlobalPermissionPath(ctx);
  if (!file) return undefined;
  try {
    assertTestReadablePath(file, 'Antigravity permission review');
    await assertAntigravityGlobalPermissionPath(ctx, file);
    const { strict, permissions } = parseAntigravityPermissionDocument(await readPermissionHost(file) ?? '{}');
    return { path: file, rules: permissions, strict, unreadable: false };
  } catch {
    return { path: file, rules: [], strict: false, unreadable: true };
  }
}

function windowsLiteralPrefix(tokens: readonly string[]): boolean {
  // Keep words passed literally by both cmd and PowerShell. A drive/path as
  // command or syntax like %var% can take a native exact-line matching path.
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(tokens[0] ?? '') && tokens.every((token) => /^[A-Za-z0-9_./-]+$/u.test(token));
}

function executableName(token: string): string {
  return path.win32.basename(token).toLowerCase().replace(/\.(?:exe|cmd)$/u, '');
}

function isTransparentWrapper(token: string): boolean {
  return ['timeout', 'nohup', 'nice', 'env'].includes(executableName(token));
}

function innerCommand(tokens: readonly string[]): { tokens: readonly string[]; adjusted: boolean } {
  let offset = 0;
  while (offset < tokens.length) {
    const command = tokens[offset]!;
    if (shellAssignment.test(command)) {
      offset++;
      continue;
    }
    if (!isTransparentWrapper(command)) break;
    const wrapper = executableName(command);
    let next = offset + 1;
    if (wrapper === 'env') {
      while (next < tokens.length) {
        const token = tokens[next]!;
        if (['-i', '--ignore-environment'].includes(token) || /^--(?:unset|chdir)=.+$/u.test(token)) next++;
        else if (['-u', '--unset', '-C', '--chdir'].includes(token) && tokens[next + 1]) next += 2;
        else break;
      }
    }
    if (wrapper === 'nice') {
      if (['-n', '--adjustment'].includes(tokens[next] ?? '')) {
        if (!/^[+-]?\d+$/u.test(tokens[next + 1] ?? '')) break;
        next += 2;
      } else if (/^--adjustment=[+-]?\d+$/u.test(tokens[next] ?? '')) next++;
    }
    if (wrapper === 'timeout') {
      if (!/^\d+(?:\.\d+)?[smhd]?$/u.test(tokens[next] ?? '')) break;
      next++;
    }
    if (tokens[next] === '--') next++;
    else if (tokens[next]?.startsWith('-')) break;
    if (wrapper !== 'env' && shellAssignment.test(tokens[next] ?? '')) break;
    if (!tokens[next]) break;
    offset = next;
  }
  return { tokens: tokens.slice(offset), adjusted: offset > 0 };
}

export function antigravityPrefixesOverlap(
  allow: readonly string[], restriction: readonly string[], platform: NodeJS.Platform = process.platform,
): boolean {
  const left = innerCommand(allow).tokens;
  const right = innerCommand(restriction).tokens;
  return left.length > 0 && right.length > 0 && (containsPrefix(left, right, platform) || containsPrefix(right, left, platform));
}

function developerToolRequiresExactMatch(tokens: readonly string[]): boolean {
  const executable = executableName(tokens[0]!);
  return executable === 'git' && tokens.some((token, index) => token === '-c' && /^core\.pager=/iu.test(tokens[index + 1] ?? ''))
    || executable === 'tar' && tokens.some((token) => token === '--to-command' || token.startsWith('--to-command='));
}

function containsPrefix(tokens: readonly string[], prefix: readonly string[], platform: NodeJS.Platform): boolean {
  return prefix.length <= tokens.length && prefix.every((word, index) => {
    const token = tokens[index]!;
    if (platform !== 'win32') return word === token;
    return index === 0 ? executableName(word) === executableName(token)
      : word.replace(/\\/gu, '/').toLowerCase() === token.replace(/\\/gu, '/').toLowerCase();
  });
}

type DecisionPrefix = { effect: Action; tokens: readonly string[] };
type ResourceDecision = Pick<Rule, 'resource' | 'effect'>;
type ManualFormConflict = { effect: Action; form: 'raw command form' | 'parsed command words' };

function prefixDecisionConflict(declared: DecisionPrefix, existing: DecisionPrefix[], platform: NodeJS.Platform):
{ covering?: DecisionPrefix; matching?: DecisionPrefix } {
  let matching: DecisionPrefix | undefined;
  for (const rule of existing) {
    if (actions.indexOf(rule.effect) <= actions.indexOf(declared.effect)) continue;
    if (containsPrefix(declared.tokens, rule.tokens, platform)) return { covering: rule };
    if (!matching && containsPrefix(rule.tokens, declared.tokens, platform)) matching = rule;
  }
  return { matching };
}

function rawPermissionResources(tokens: readonly string[], platform: NodeJS.Platform) {
  const blank = String.raw`[\x20\t]`;
  const quotedWord = (word: string, index: number) => {
    const windowsPath = platform === 'win32' && (word.includes('\\') || index === 0 && word.includes('/'));
    const escaped = windowsPath ? word.split(/[\\/]/u).map(escapeRegexWord).join(String.raw`[\\/]`) : escapeRegexWord(word);
    const forms = [];
    if (plainWord.test(windowsPath ? word.replace(/\\/gu, '/') : word)) forms.push(escaped);
    if (platform !== 'win32') forms.push(`'${escaped}'`);
    if (!windowsPath || !/[\\/]$/u.test(word)) forms.push(`"${escaped}"`);
    return `(?:${forms.join('|')})`;
  };
  // Match trailing literal arguments only. Antigravity uses this pattern for
  // a whole unparsed line and would otherwise include unrelated shell actions.
  const plain = platform === 'win32' ? String.raw`[-\p{L}\p{M}\p{N}_./:@+=,]` : String.raw`[-\p{L}\p{M}\p{N}_./:@%+=,]`;
  const quoted = platform === 'win32' ? String.raw`"[^"\r\n%!?^&|<>]*"`
    : String.raw`'[^'\r\n]*'|"(?:[^"\\$\x60\r\n]|\\[^\r\n])*"|\\[^\r\n]`;
  const prefix = tokens.map(quotedWord).join(blank + '+');
  const rule = (plainPart: string) =>
    `${regexRulePrefix}${blank}*${prefix}(?:${blank}+(?:${plainPart}|${quoted})+)*${blank}*)`;
  // The outer repetition already matches runs of plain characters. Keep the
  // former spelling for identifying rules in existing settings and sidecars.
  return { current: rule(plain), legacy: rule(plain + '+') };
}

function projectPermission(claim: Pick<PermissionClaim, 'tokens'>, platform: NodeJS.Platform): {
  resources: string[];
  legacyRaw?: string;
  reasonCode?: string;
  adjustments: Array<Pick<HostPermissionAdjustment, 'reasonCode' | 'resource' | 'message'>>;
} {
  const inner = innerCommand(claim.tokens);
  if (!literalPrefix(inner.tokens, platform)) return { resources: [], adjustments: [], reasonCode: 'permission-prefix-unrepresentable' };
  if (isTransparentWrapper(inner.tokens[0]!)) return { resources: [], adjustments: [], reasonCode: 'antigravity-command-matching-unverified' };
  const literal = literalResource(inner.tokens);
  const adjustments = [];
  if (inner.adjusted) adjustments.push({
    resource: literal,
    reasonCode: 'antigravity-unwraps-command',
    message: 'Antigravity checks the inner command of a shell wrapper or environment assignment. This rule also matches the inner command when it is invoked directly or through another recognized wrapper.',
  });
  // Windows normalizes drive/path spellings and may use whole-line matching.
  // Emit the literal rule for parsed commands and a bounded raw alternative.
  const needsRawMatch = platform === 'win32' && !windowsLiteralPrefix(inner.tokens)
    || path.posix.isAbsolute(inner.tokens[0]!) || inner.tokens.some((token) => !plainWord.test(token))
    || developerToolRequiresExactMatch(inner.tokens);
  if (needsRawMatch && platform === 'win32' && claim.tokens.some((word) =>
    /[%!^]/u.test(word) || /\\$/u.test(word) && !plainWord.test(word.replace(/\\/gu, '/')))) {
    adjustments.push({
      resource: literal,
      reasonCode: 'antigravity-windows-command-syntax',
      message: 'Antigravity can match this rule when Windows supplies literal command words. A raw line containing Windows expansion characters may still require separate review.',
    });
  } else if (needsRawMatch) {
    const { current, legacy } = rawPermissionResources(claim.tokens, platform);
    adjustments.push({
      resource: current,
      reasonCode: 'antigravity-command-raw-match',
      message: 'Antigravity can match this command as raw text. The additional rule covers literal trailing arguments and common command spellings, including quoted words and equivalent Windows path separators where applicable.',
    });
    return { resources: [literal, current], legacyRaw: legacy, adjustments };
  }
  return { resources: [literal], adjustments };
}

export function antigravityPermissionResources(
  claim: Pick<PermissionClaim, 'tokens'>, platform: NodeJS.Platform = process.platform,
  { includeLegacyRaw = false } = {},
): string[] {
  const { resources, legacyRaw } = projectPermission(claim, platform);
  return includeLegacyRaw && legacyRaw ? [...resources, legacyRaw] : resources;
}

export function mergeAntigravityPermissions(
  claims: PermissionClaim[], manual: unknown[], platform: NodeJS.Platform = process.platform, strict = false,
) {
  const skipped: Array<PermissionClaim & { reasonCode: string }> = [];
  const adjusted: HostPermissionAdjustment[] = [];
  const candidates = claims.map((claim) => {
    const projection = projectPermission(claim, platform);
    const reasonCode = strict && claim.effect === 'allow' ? 'antigravity-strict-mode' : projection.reasonCode;
    if (reasonCode) skipped.push({ ...claim, reasonCode });
    return { claim, projection, reasonCode };
  });
  const skippedRestrictions = skipped.filter(({ effect }) => effect !== 'allow');
  const strictest = new Map<string, AntigravityPermission>();
  const active: DecisionPrefix[] = [];
  const manualDecisions = manual.filter((entry): entry is ResourceDecision =>
    record(entry) && isAction(entry.effect) && typeof entry.resource === 'string')
    .sort((a, b) => actions.indexOf(b.effect) - actions.indexOf(a.effect));
  const manualPrefixes = manualDecisions.flatMap(({ effect, resource }): DecisionPrefix[] => {
    const tokens = resource === 'command(*)' ? [] : antigravityCommandTokens(resource);
    return tokens ? [{ effect, tokens }] : [];
  });
  const manualWildcard = manualPrefixes.find(({ tokens }) => !tokens.length);
  const ordered = candidates.sort((a, b) => actions.indexOf(b.claim.effect) - actions.indexOf(a.claim.effect));
  for (const { claim, projection, reasonCode } of ordered) {
    if (reasonCode) continue;
    const declared = { effect: claim.effect, tokens: innerCommand(claim.tokens).tokens };
    const manualConflict = prefixDecisionConflict(declared, manualPrefixes, platform);
    const activeConflict = prefixDecisionConflict(declared, active, platform);
    const blockedForms: ManualFormConflict[] = [];
    const resources = new Map<string, string>();
    for (const [index, resource] of projection.resources.entries()) {
      const exact = manualDecisions.find((rule) => rule.resource === resource || index === 1 && rule.resource === projection.legacyRaw);
      const blocking = exact && actions.indexOf(exact.effect) > actions.indexOf(claim.effect) ? exact
        : !index ? manualConflict.covering : undefined;
      if (blocking) {
        blockedForms.push({ effect: blocking.effect, form: index ? 'raw command form' : 'parsed command words' });
        continue;
      }
      const existing = strictest.get(resource);
      if (!existing || existing.effect === claim.effect) resources.set(resource, exact?.effect === claim.effect ? exact.resource : resource);
    }
    const maskedByWildcard = manualWildcard && actions.indexOf(manualWildcard.effect) > actions.indexOf(claim.effect);
    if (!resources.size || maskedByWildcard || activeConflict.covering
      || claim.effect === 'allow' && skippedRestrictions.some((restriction) => antigravityPrefixesOverlap(claim.tokens, restriction.tokens, platform))) {
      skipped.push({ ...claim, reasonCode: 'permission-rule-conflict' });
      continue;
    }
    const firstResource = resources.keys().next().value!;
    if (activeConflict.matching) adjusted.push({ ...claim, resource: firstResource,
      reasonCode: 'antigravity-rule-precedence',
      message: `Antigravity applies the stronger AW ${activeConflict.matching.effect} to ${activeConflict.matching.tokens.join(' ')} and its arguments. This rule applies to the rest of the declared prefix.` });
    if (manualConflict.matching) adjusted.push({ ...claim, resource: firstResource,
      reasonCode: 'antigravity-user-rule-precedence',
      message: `Antigravity keeps the user's ${manualConflict.matching.effect} for ${manualConflict.matching.tokens.join(' ')} and its arguments. This rule applies to the rest of the declared prefix.` });
    for (const rule of blockedForms) adjusted.push({ ...claim, resource: firstResource,
      reasonCode: 'antigravity-user-rule-precedence',
      message: `Antigravity keeps the user's ${rule.effect} for the ${rule.form} of this declaration. The other matching form remains configured.` });
    for (const adjustment of projection.adjustments) if (resources.has(adjustment.resource)) adjusted.push({ ...claim, ...adjustment });
    if (resources.has(projection.resources[0]!)) active.push(declared);
    for (const [canonical, resource] of resources) {
      strictest.set(canonical, { action: 'shell', resource, effect: claim.effect });
    }
  }
  // The host ranks deny over ask over allow across lists. Distinct overlapping
  // literal prefixes can coexist, and every user's entry retains its position.
  const effective = [...strictest.values()].sort((a, b) => actions.indexOf(a.effect) - actions.indexOf(b.effect)
    || (a.resource === b.resource ? 0 : a.resource < b.resource ? -1 : 1));
  const after = effective.filter((rule) => !manual.some((entry) => record(entry)
    && entry.effect === rule.effect && entry.resource === rule.resource));
  return { before: [], after, effective, skipped,
    adjusted: adjusted.flatMap((adjustment) => {
      const rule = strictest.get(adjustment.resource);
      return rule?.effect === adjustment.effect ? [{ ...adjustment, resource: rule.resource }] : [];
    }) };
}
