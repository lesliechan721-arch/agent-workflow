import { isPermissionClaim as isOpenCodeClaim, type HostPermissionAdjustment,
  type PermissionClaim as OpenCodeClaim } from './permission-sidecar.js';
export { isOpenCodeClaim, type OpenCodeClaim };
export { parseOpenCodePermissionDocument, readOpenCodePermissionChain } from './opencode-permission-config.js';

const rank = { allow: 0, ask: 1, deny: 2 };
export type OpenCodeEffect = keyof typeof rank;
export interface OpenCodePermission {
  action: 'shell';
  resource: string;
  effect: OpenCodeEffect;
}
interface OpenCodePermissionMerge {
  before: OpenCodePermission[];
  after: OpenCodePermission[];
  effective: OpenCodePermission[];
  skipped: Array<OpenCodeClaim & { reasonCode: string }>;
  adjusted?: HostPermissionAdjustment[];
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function isEffect(value: unknown): value is OpenCodeEffect {
  return typeof value === 'string' && Object.hasOwn(rank, value);
}
function isLiteralWord(word: string): boolean {
  return !!word && !word.startsWith('#') && !/\{(?:env|file):|[\s\p{C}"'\\*;&|<>`$()]/u.test(word);
}
export function isOpenCodePermission(value: unknown): value is OpenCodePermission {
  return record(value) && Object.keys(value).length === 3 && value.action === 'shell' && isEffect(value.effect)
    && typeof value.resource === 'string' && value.resource.endsWith(' *')
    && value.resource.slice(0, -2).split(' ').every(isLiteralWord);
}
export function openCodePermissionResourceKey(value: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = value.replaceAll('\\', '/');
  if (platform !== 'win32') return normalized;
  // OpenCode uses RegExp `i` without `u`, which compares one UTF-16 unit
  // at a time and never folds a non-ASCII character into ASCII.
  return normalized.split('').map((unit) => {
    const upper = unit.toUpperCase();
    return upper.length === 1 && !(unit.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) ? upper : unit;
  }).join('');
}

export function openCodePermissionSpellingNotice(platform: NodeJS.Platform, effects: readonly OpenCodeEffect[]): string {
  const notes = ['OpenCode checks the standard spelling with unquoted words separated by single spaces. Other spacing or quoting can change approval decisions.'];
  if (platform === 'win32') notes.push('On Windows, OpenCode also matches case and slash variants.');
  if (effects.includes('ask')) notes.push('Remembered OpenCode approvals can still satisfy an ask rule.');
  return notes.join(' ');
}

export function openCodePrefixesOverlap(a: readonly string[], b: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    // A wildcard could consume whitespace and change the remaining token
    // boundaries, so only literal prefixes can prove disjointness.
    if (/[*?]/u.test(a[index]!) || /[*?]/u.test(b[index]!)) return true;
    if (openCodePermissionResourceKey(a[index]!, platform) !== openCodePermissionResourceKey(b[index]!, platform)) return false;
  }
  return true;
}

function matchesStandardSpelling(pattern: OpenCodeClaim, requested: OpenCodeClaim, platform: NodeJS.Platform): boolean {
  if (!pattern.tokens.some((token) => token.includes('?'))) {
    return pattern.tokens.length <= requested.tokens.length && pattern.tokens.every((token, index) =>
      openCodePermissionResourceKey(token, platform) === openCodePermissionResourceKey(requested.tokens[index]!, platform));
  }
  const prefix = openCodePermissionResourceKey(pattern.tokens.join(' '), platform)
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('?', '.');
  const standard = openCodePermissionResourceKey(requested.tokens.join(' '), platform);
  return new RegExp(`^${prefix}(?: .*)?$`, 's').test(standard);
}

// Only prove disjointness for a literal command or the native token-prefix shape.
// Other globs and substitutions may select a stricter rule for this command.
export function openCodePermissionMayMatch(rule: unknown, tokens: string[], platform: NodeJS.Platform = process.platform): boolean {
  if (!record(rule) || typeof rule.action !== 'string' || typeof rule.resource !== 'string') return true;
  const action = openCodePermissionResourceKey(rule.action, platform);
  if (!action.includes('?') && isLiteralWord(action) && action !== openCodePermissionResourceKey('shell', platform)) return false;
  const resource = openCodePermissionResourceKey(rule.resource, platform);
  const prefix = resource.endsWith(' *');
  const words = (prefix ? resource.slice(0, -2) : resource).split(' ');
  if (!words.every(isLiteralWord)) return true;
  return openCodePrefixesOverlap(tokens, words, platform)
    && (prefix || words.length >= tokens.length || words.some((word) => word.includes('?')) || tokens.some((word) => word.includes('?')));
}

export type OpenCodeLayerRule = { layer: 'lower' | 'higher' | 'disabled'; path: string; rule: unknown; source?: 'config' | 'agent' };

export function openCodePermissionMayRelax(rule: unknown, claim: Pick<OpenCodeClaim, 'effect' | 'tokens'>, platform: NodeJS.Platform = process.platform): boolean {
  return openCodePermissionMayMatch(rule, claim.tokens, platform)
    && (!record(rule) || !isEffect(rule.effect) || rank[rule.effect] < rank[claim.effect]);
}

/** OpenCode uses the last matching rule. A weaker later rule can undo an exact match. */
export function openCodePermissionConfigured(rule: OpenCodePermission, entries: unknown[], platform: NodeJS.Platform = process.platform): boolean {
  const key = openCodePermissionResourceKey(rule.resource, platform);
  const existing = entries.map((value) => record(value) && typeof value.action === 'string'
    && openCodePermissionResourceKey(value.action, platform) === openCodePermissionResourceKey(rule.action, platform)
    && typeof value.resource === 'string' && openCodePermissionResourceKey(value.resource, platform) === key && value.effect === rule.effect).lastIndexOf(true);
  const tokens = rule.resource.slice(0, -2).split(' ');
  return existing >= 0 && !entries.slice(existing + 1).some((later) =>
    openCodePermissionMayRelax(later, { tokens, effect: rule.effect }, platform));
}

function narrowerManualResource(rule: unknown, claim: OpenCodeClaim, platform: NodeJS.Platform): string | undefined {
  if (!record(rule) || typeof rule.action !== 'string' || typeof rule.resource !== 'string'
    || openCodePermissionResourceKey(rule.action, platform) !== openCodePermissionResourceKey('shell', platform)) return;
  const resource = rule.resource.endsWith(' *') ? rule.resource.slice(0, -2) : rule.resource;
  const words = resource.split(' ');
  if (words.length <= claim.tokens.length || !words.every(isLiteralWord)
    || [...words, ...claim.tokens].some((word) => word.includes('?'))) return;
  if (openCodePrefixesOverlap(words, claim.tokens, platform)) return rule.resource;
}

export function mergeOpenCodePermissions(claims: OpenCodeClaim[], manual: unknown[], otherRules: unknown[],
  platform: NodeJS.Platform = process.platform, userRestrictions: OpenCodeClaim[] = []): OpenCodePermissionMerge {
  const skipped: Array<OpenCodeClaim & { reasonCode: string }> = [];
  const skippedRestrictions: OpenCodeClaim[] = [];
  const runnable: OpenCodeClaim[] = [];
  const preservedManual = new Map<OpenCodeClaim, string[]>();
  const masked = new Set<string>();
  const skip = (claim: OpenCodeClaim, reasonCode: string) => {
    skipped.push({ ...claim, reasonCode });
    if (claim.effect !== 'allow') skippedRestrictions.push(claim);
  };
  const disabled = otherRules.some((item) => record(item) && item.layer === 'disabled');
  const layers = otherRules.filter((item) => !record(item) || item.layer !== 'disabled').map((item) => record(item) && (item.layer === 'higher' || item.layer === 'lower') && Object.hasOwn(item, 'rule')
    ? { layer: item.layer, rule: item.rule, path: typeof item.path === 'string' ? item.path : undefined }
    : { layer: 'higher', rule: item, path: undefined });
  const unverified = layers.filter(({ rule }) => rule === null);
  const knownLayers = layers.filter(({ rule }) => rule !== null);
  for (const claim of claims) {
    // These Windows shell forms can change the meaning of words even in the
    // standard spelling, regardless of OpenCode's raw-text matching.
    if (platform === 'win32' && claim.tokens.some((word) => word === '--%' || word.includes('^')
      || /%[^%]+%|^@[\p{L}\p{M}\p{N}_]+$|^,|,$|,,/u.test(word))) {
      skip(claim, 'opencode-windows-command-syntax');
      continue;
    }
    if (!claim.tokens.every(isLiteralWord)) {
      skip(claim, 'permission-prefix-unrepresentable');
      continue;
    }
    const stricter = (rule: unknown) => (!record(rule) || !isEffect(rule.effect) || rank[rule.effect] > rank[claim.effect])
      && openCodePermissionMayMatch(rule, claim.tokens, platform);
    const matchingManual = manual.filter(stricter);
    const narrower = claim.effect === 'allow' ? matchingManual.flatMap((rule) => {
      const resource = narrowerManualResource(rule, claim, platform);
      return resource ? [resource] : [];
    }) : [];
    if (claim.effect !== 'deny' && (matchingManual.length > narrower.length || knownLayers.some(({ rule }) => stricter(rule))
      || userRestrictions.some((entry) => rank[entry.effect] > rank[claim.effect] && openCodePrefixesOverlap(entry.tokens, claim.tokens, platform)))) {
      skip(claim, 'permission-rule-conflict');
      continue;
    }
    // A later agent or config can relax this restriction. Keep the restriction
    // for other sessions, warn about the overlap, and withhold overlapping AW grants.
    if (claim.effect !== 'allow' && knownLayers.some(({ layer, rule }) => layer === 'higher' && openCodePermissionMayRelax(rule, claim, platform))) {
      skip(claim, 'permission-rule-conflict');
      masked.add(JSON.stringify([claim.effect, openCodePermissionResourceKey(claim.tokens.join(' ') + ' *', platform)]));
    }
    if (narrower.length) preservedManual.set(claim, narrower);
    runnable.push(claim);
  }

  const strictest = new Map<string, OpenCodePermission>();
  for (const claim of runnable) {
    if (claim.effect === 'allow' && skippedRestrictions.some((restriction) => openCodePrefixesOverlap(restriction.tokens, claim.tokens, platform))) {
      skip(claim, 'permission-rule-conflict');
      continue;
    }
    if (runnable.some((stricter) => rank[stricter.effect] > rank[claim.effect] && matchesStandardSpelling(stricter, claim, platform))) {
      skipped.push({ ...claim, reasonCode: 'permission-rule-conflict' });
      continue;
    }
    const resource = claim.tokens.join(' ') + ' *';
    const key = openCodePermissionResourceKey(resource, platform);
    const other = strictest.get(key);
    if (!other || rank[claim.effect] > rank[other.effect] || claim.effect === other.effect && resource < other.resource) {
      strictest.set(key, { action: 'shell', resource, effect: claim.effect });
    }
  }
  const rendered = [...strictest.values()].sort(compareOpenCodePermissions);
  const before: OpenCodePermission[] = [];
  const after: OpenCodePermission[] = [];
  for (const rule of rendered) {
    if (openCodePermissionConfigured(rule, manual, platform)) continue;
    (rule.effect === 'allow' ? before : after).push(rule);
  }
  // The session flag only changes what this client loads. The shared file
  // still serves other sessions and retains every remaining owner's rules.
  if (disabled) return { before, after, effective: [], skipped: claims.map((claim) => ({ ...claim, reasonCode: 'config-disabled' })) };
  const effective = rendered.filter((rule) => !masked.has(JSON.stringify([rule.effect, openCodePermissionResourceKey(rule.resource, platform)])));
  const applied = new Set([...before, ...after]);
  const unverifiedLocations = [...new Set(unverified.flatMap(({ path }) => path ? [path] : []))];
  const adjusted = runnable.flatMap((claim) => {
    const rule = strictest.get(openCodePermissionResourceKey(claim.tokens.join(' ') + ' *', platform));
    if (!rule || !applied.has(rule) || rule.effect !== claim.effect || !effective.includes(rule)) return [];
    const spelling = { ...claim, resource: rule.resource, reasonCode: 'opencode-standard-spelling', message: openCodePermissionSpellingNotice(platform, [rule.effect]) };
    const notices = [spelling];
    if (rule.resource.includes('?')) {
      notices.push({ ...claim, resource: rule.resource, reasonCode: 'opencode-single-character-wildcard',
        message: 'OpenCode treats ? as one wildcard character, including a space. It can match other commands and requires exactly one match at that position.' });
    }
    const manualRestrictions = preservedManual.get(claim);
    if (manualRestrictions) {
      notices.push({ ...claim, resource: rule.resource, reasonCode: 'opencode-manual-restriction-preserved',
        message: `Existing OpenCode restrictions still take precedence where they match: ${[...new Set(manualRestrictions)].join(', ')}.` });
    }
    if (claim.tokens.some((word) => word.startsWith('~') || /\[[^\[\]]+\]|\{[^{}]*(?:,|\.\.)[^{}]*\}/u.test(word))) {
      notices.push({ ...claim, resource: rule.resource, reasonCode: 'opencode-shell-expansion',
        message: 'OpenCode matches the original spelling. The selected shell can expand a path, bracket pattern, or brace expression before running the command.' });
    }
    if (!unverified.length) return notices;
    const locations = unverifiedLocations.length ? ` in ${unverifiedLocations.join(', ')}` : '';
    return [...notices, { ...claim, resource: rule.resource, reasonCode: 'opencode-additional-rules-unverified',
      message: `Additional OpenCode rules${locations} could not be read. They may change this decision.` }];
  });
  return { before, after, effective, skipped, ...(adjusted.length ? { adjusted } : {}) };
}

export function compareOpenCodePermissions(a: OpenCodePermission, b: OpenCodePermission): number {
  return rank[a.effect] - rank[b.effect] || (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0);
}
