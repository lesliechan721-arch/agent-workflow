import { minimatch } from 'minimatch';
import { GROK_WRAPPER_TARGET_NOT_COVERED } from '../output/component-delivery.js';
import type { HostPermissionRule } from './host-permission-policy.js';
import type { OpenCodeLayerRule } from './opencode-permissions.js';
import type { HostPermissionAdjustment, PermissionClaim } from './permission-sidecar.js';

const actions = ['allow', 'ask', 'deny'] as const;
const shellWord = /^[^\s"'\\*;&|<>`$()\p{Cc}]+$/u;
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const maxConsecutivePrefixes = 8;
const maxNormalizationRounds = 16;
const wrapperOptions = new Map([
  ['timeout', { arguments: 1, withValue: ['-k', '-s', '--kill-after', '--signal'] }],
  ['chrt', { arguments: 1, withValue: [] }],
  ['nice', { arguments: 0, withValue: ['-n', '--adjustment'] }],
  ['ionice', { arguments: 0, withValue: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid'] }],
  ['stdbuf', { arguments: 0, withValue: ['-i', '-o', '-e'] }],
]);

export function grokPermissionResource(claim: PermissionClaim): string {
  return (claim.effect === 'allow' ? normalizeAllowWords(claim.tokens)?.words : claim.tokens)?.join(' ') ?? '';
}

export function isGrokPermission(value: unknown): value is HostPermissionRule {
  if (typeof value !== 'object' || value === null) return false;
  const rule = value as Partial<HostPermissionRule>;
  return rule.action === 'shell' && actions.includes(rule.effect!) && typeof rule.resource === 'string'
    && rule.resource.split(' ').every((word) => shellWord.test(word));
}

export function grokPrefixesOverlap(a: readonly string[], b: readonly string[]): boolean {
  const normalizedForms = (words: readonly string[]) => [words.join(' '), normalizeAllowWords(words)?.words.join(' ') ?? ''].filter(Boolean);
  return normalizedForms(a).some((first) => normalizedForms(b).some((second) => first.startsWith(second) || second.startsWith(first)));
}

function matchesInlineShellPrefix(resource: string): boolean {
  const [program, ...args] = resource.split(' ');
  if (!['bash', 'sh', 'dash', 'zsh', 'ksh'].includes(program?.split(/[\\/]/u).at(-1) ?? '')) return false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === '-' || option === '--' || !/^[-+]/u.test(option)) return false;
    if (['--init-file', '--rcfile', '-o', '+o', '-O', '+O'].includes(option)) {
      index += 1;
      continue;
    }
    if (/^(?:--|\+|-O)/u.test(option)) continue;
    const flags = option.slice(1);
    if (/[oO]/u.test(flags)) return false;
    if (flags.includes('c')) return true;
  }
  return false;
}

export function describeGrokPermissionMatch(rule: Pick<HostPermissionRule, 'effect' | 'resource'>, words?: readonly string[],
  missingCommand = false): string {
  const boundary = rule.effect === 'allow' ? 'on hosts that use a character prefix' : 'because Grok uses a character prefix';
  const glob = /[?\[]/u.test(rule.resource) ? ' The pattern contains characters Grok can interpret as wildcards.' : '';
  const original = words?.join(' ');
  const wrapped = original && original !== rule.resource
    ? ` Grok strips the prefix before ${JSON.stringify(rule.resource)} in ${JSON.stringify(original)}. Calling the inner command directly can also be allowed.` : '';
  const inline = rule.effect === 'allow' && matchesInlineShellPrefix(rule.resource)
    ? ' This rule covers the outer shell invocation. Grok checks the commands inside the inline script separately.' : '';
  const commands = missingCommand
    ? 'Grok keeps this pattern for the wrapper without an inner command. If additional arguments name an inner command, Grok checks it separately.'
    : 'Quoted arguments joined with spaces and commands inside supported wrappers can match.';
  return `Grok Bash ${rule.effect} pattern ${JSON.stringify(rule.resource)} compares command text. ${commands} A longer final word can also match ${boundary}.${glob}${wrapped}${inline}`;
}

export function readGrokShellRule(rule: unknown): HostPermissionRule[] {
  if (!rule || typeof rule !== 'object') return [];
  const candidate = rule as Partial<HostPermissionRule> & { tool?: unknown; pattern?: unknown };
  if (candidate.action === 'shell' && actions.includes(candidate.effect!) && typeof candidate.resource === 'string') {
    return [candidate as HostPermissionRule];
  }
  const effect = candidate.action as HostPermissionRule['effect'];
  if (actions.includes(effect) && (candidate.tool === undefined || candidate.tool === '*' || candidate.tool === 'any'
    || typeof candidate.tool === 'string' && /^(?:bash|shell|run_terminal_command|run_terminal_cmd)$/iu.test(candidate.tool))
    && (candidate.pattern === undefined || typeof candidate.pattern === 'string')) {
    return [{ action: 'shell', effect, resource: candidate.pattern ?? '*' }];
  }
  return [];
}

function restrictionPrefix(pattern: string): string {
  return pattern.endsWith(':*') ? pattern.slice(0, -2) : pattern;
}

function matchesRestriction(resource: string, prefix: string): boolean {
  if (resource.startsWith(prefix)) return true;
  // Grok's freeform Bash glob matches across path separators.
  return minimatch(resource.replaceAll('/', '\u0001'), prefix.replaceAll('/', '\u0001'), {
    nocase: false, dot: true, noglobstar: true, noext: true, nobrace: true, nonegate: true, nocomment: true,
  });
}

function envCommandIndex(tokens: readonly string[]): number | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const word = tokens[index]!;
    if (word === '--') return index + 1;
    if (assignment.test(word) || /^-[iv0]*$/u.test(word)
      || ['--ignore-environment', '--null', '--debug', '--version', '--help'].includes(word)) continue;
    if (/^--(?:unset|chdir|path|argv0)=/u.test(word)) continue;
    const shortOption = /^-[iv0]*[uCPa](.*)$/u.exec(word);
    if (shortOption?.[1]) continue;
    if (shortOption || ['--unset', '--chdir', '--path', '--argv0'].includes(word)) {
      index += 1;
      if (!tokens[index]) return null;
      continue;
    }
    // Grok stops approval normalization at split-string and unrecognized env options.
    return word.startsWith('-') ? null : index;
  }
  return tokens.length;
}

function shellBuiltinCommandIndex(program: 'command' | 'exec' | 'builtin', tokens: readonly string[]): number | 'query' | null {
  if (program === 'builtin') {
    const target = tokens[1];
    if (!target) return tokens.length;
    return target.startsWith('-') && target !== '-' ? null : 1;
  }
  for (let index = 1; index < tokens.length; index += 1) {
    const word = tokens[index]!;
    if (word === '--') return index + 1;
    if (word === '-' || !word.startsWith('-')) return index;
    if (program === 'command') {
      // Grok keeps display/query forms in their original spelling.
      if (word === '--help' || word === '--version' || /^-(?!-).*[vV]/u.test(word)) return 'query';
      if (/^-p+$/u.test(word)) continue;
    } else {
      if (/^-[cl]+$/u.test(word) || word.startsWith('-a') && word.length > 2) continue;
      if (word === '-a' && tokens[index + 1]) {
        index += 1;
        continue;
      }
    }
    return null;
  }
  return tokens.length;
}

function normalizeAllowWords(tokens: readonly string[]): { words: readonly string[]; missingCommand?: true } | undefined {
  while (tokens[0] && assignment.test(tokens[0])) tokens = tokens.slice(1);
  // Grok alternates consecutive wrapper and shell-builtin passes. Prefixes
  // beyond either native budget prompt, even if the final command is known.
  let previous: 'wrapper' | 'builtin' | undefined;
  let sameKindCount = 0;
  let rounds = 0;
  while (tokens[0]) {
    const program = tokens[0].split(/[\\/]/u).at(-1)!;
    let kind: typeof previous = 'wrapper';
    let index: number | 'query' | null = 1;
    if (program === 'env') {
      index = envCommandIndex(tokens);
    } else if (program === 'command' || program === 'exec' || program === 'builtin') {
      kind = 'builtin';
      index = shellBuiltinCommandIndex(program, tokens);
    } else {
      const wrapper = wrapperOptions.get(program);
      if (!wrapper) break;
      while (tokens[index]?.startsWith('-')) index += wrapper.withValue.includes(tokens[index]!) ? 2 : 1;
      index += wrapper.arguments;
    }
    if (index === null) return;
    if (index === 'query') return { words: tokens };
    if (index >= tokens.length) return { words: tokens, missingCommand: true };
    if (kind !== previous) {
      if (kind === 'wrapper' || previous === undefined) rounds += 1;
      previous = kind;
      sameKindCount = 0;
    }
    sameKindCount += 1;
    if (sameKindCount > maxConsecutivePrefixes || rounds > maxNormalizationRounds) return;
    tokens = tokens.slice(index);
  }
  return { words: tokens };
}

export function mergeGrokPermissions(claims: PermissionClaim[], manual: unknown[], otherRules: OpenCodeLayerRule[],
  _platform?: NodeJS.Platform) {
  const skipped: Array<PermissionClaim & { reasonCode: string }> = [];
  const supported = claims.flatMap((claim) => {
    const normalized = normalizeAllowWords(claim.tokens);
    const words = claim.effect === 'allow' ? normalized?.words : claim.tokens;
    if (!claim.tokens.length || !claim.tokens.every((word) => shellWord.test(word))) {
      skipped.push({ ...claim, reasonCode: 'grok-shell-pattern-unrepresentable' });
      return [];
    }
    if (!words?.length) {
      skipped.push({ ...claim, reasonCode: 'grok-shell-prefix-normalized' });
      return [];
    }
    const rule: HostPermissionRule = { action: 'shell', resource: words.join(' '), effect: claim.effect };
    return [{ claim, normalized, rule }];
  });
  const rules = supported.map(({ rule }) => rule);
  const manualRules = [...manual, ...otherRules.map(({ rule }) => rule)].flatMap(readGrokShellRule);
  const effective: HostPermissionRule[] = [];
  const adjusted: HostPermissionAdjustment[] = [];
  for (const { claim, normalized, rule } of supported) {
    const spellings = [rule.resource, claim.tokens.join(' '), normalized?.words.join(' ') ?? ''].filter(Boolean);
    const stronger = [...rules, ...manualRules].filter((candidate) => actions.indexOf(candidate.effect) > actions.indexOf(rule.effect))
      .map((candidate) => restrictionPrefix(candidate.resource));
    const blocked = stronger.some((prefix) => spellings.some((command) => matchesRestriction(command, prefix)));
    if (blocked) {
      skipped.push({ ...claim, reasonCode: 'permission-rule-conflict' });
    }
    // A glob may match the bare command and leave some argument forms usable.
    // A stronger text prefix covers the bare command and every suffix.
    if (stronger.some((prefix) => prefix === '*' || spellings.some((command) => command.startsWith(prefix)))) continue;
    const missingCommand = rule.effect === 'allow' && normalized?.missingCommand === true;
    if (missingCommand) skipped.push({ ...claim, reasonCode: GROK_WRAPPER_TARGET_NOT_COVERED });
    if (!effective.some((entry) => entry.resource === rule.resource && entry.effect === rule.effect)) effective.push(rule);
    adjusted.push({ ...claim, reasonCode: 'grok-shell-text-matching', resource: rule.resource,
      message: describeGrokPermissionMatch(rule, claim.tokens, missingCommand) });
  }
  effective.sort((a, b) => actions.indexOf(a.effect) - actions.indexOf(b.effect) || a.resource.localeCompare(b.resource));
  const currentRules = manual.flatMap(readGrokShellRule);
  const after = effective.filter((rule) => !currentRules.some((entry) => entry.effect === rule.effect && entry.resource === rule.resource));
  return { before: [], after, effective, skipped, adjusted };
}
