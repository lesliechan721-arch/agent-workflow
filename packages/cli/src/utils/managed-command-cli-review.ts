import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalizeIdentityValue, type CommandLaunch, type CommandRoutes } from '@lesliechan721/aw-plugin-core/manifest';

import { managedCommandRouteIsReachable } from '../generators/permissions.js';
import { antigravityCommandTokens, readAntigravityGlobalPermissions } from '../platforms/antigravity-permissions.js';
import { inspectGrokPermissionConfig } from '../platforms/grok-permission-config.js';
import { getOpenCodePermissionRoot } from '../platforms/layout.js';
import { openCodePermissionMayMatch, parseOpenCodePermissionDocument, readOpenCodePermissionChain } from '../platforms/opencode-permissions.js';
import { getClaudeHome, getCodexHome, resolveRepoRoot } from './state-paths.js';

type LaunchReview = Pick<CommandLaunch, 'runner' | 'entry' | 'args' | 'cwd'> & { route: 'subcommand' | 'fallback' };
type RouteReview = { argv: string[]; before: LaunchReview | null; after: LaunchReview | null };
type PermissionReview = {
  platform: 'codex' | 'claude' | 'opencode' | 'antigravity' | 'grok';
  path: string;
  action: 'allow' | 'ask' | 'deny' | 'sandbox';
  argvPrefix: string[];
  handlerUnavailable?: true;
  resourcePattern?: string;
};

export interface ManagedCommandRouteReview {
  routeChanges: RouteReview[];
  affectedPermissions: PermissionReview[];
  permissionReadFailures: string[];
  codexRulesDigest?: string;
  unverifiedGrokProjectPath?: string;
  otherProjects: 'unobserved';
  userOnly?: true;
  existingApprovalsMayMatch: boolean;
}

function selectLaunch(routes: CommandRoutes | undefined, word: string | undefined): { route: LaunchReview['route']; launch: CommandLaunch } | null {
  const subcommand = routes?.subcommands.find(({ name }) => name === word);
  if (!subcommand) return routes?.fallback ? { route: 'fallback', launch: routes.fallback } : null;
  const { name: _name, ...launch } = subcommand;
  return { route: 'subcommand', launch };
}

function showLaunch(match: ReturnType<typeof selectLaunch>): LaunchReview | null {
  if (!match) return null;
  const { runner, entry, args, cwd } = match.launch;
  return { route: match.route, runner, entry, args, cwd };
}

const codexDecisions = { allow: 'allow', prompt: 'ask', forbidden: 'deny' } as const;
const codexRuleFields = ['pattern', 'decision', 'match', 'not_match', 'justification', 'canonical_matching'];
const codexStringEscapes: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
type CodexLiteral = string | boolean | CodexLiteral[];
type CodexPrefixRule = { action: typeof codexDecisions[keyof typeof codexDecisions]; pattern: (string | string[])[] };
type CodexStatement = { tokens: string[]; indent: number; inlineSuite: boolean; bindsRuleName: boolean };

const codexToken = /"""(?:\\[\s\S]|(?!""")[^\\])*"""|'''(?:\\[\s\S]|(?!''')[^\\])*'''|"(?!"")(?:[^"\\\r\n]|\\(?:\r\n|[\s\S]))*"|'(?!'')(?:[^'\\\r\n]|\\(?:\r\n|[\s\S]))*'|#[^\r\n]*|\\(?:\r\n?|\n)|\r\n?|\n|[ \t]+|[A-Za-z_]\w*|[=!<>]=|(?:\/\/|<<|>>|[-+*/%&|^])=|[\s\S]/gu;
const codexSuiteHeaders = new Set(['def', 'for', 'if', 'elif', 'else']);
const codexClosingDelimiter = new Map([['(', ')'], ['[', ']'], ['{', '}']]);

// A newline inside a delimiter, string, or explicit continuation cannot begin a new statement.
function* codexStatements(contents: string): Generator<CodexStatement | null> {
  const closing: string[] = [];
  let tokens: string[] = [];
  let indent = 0;
  let lineStart = true;
  let inlineSuite = false;
  let bindsRuleName = false;
  function finishStatement(): CodexStatement {
    const statement = { tokens, indent, inlineSuite, bindsRuleName };
    tokens = [];
    bindsRuleName = false;
    return statement;
  }

  for (const [token] of contents.matchAll(codexToken)) {
    if (token.startsWith('#')) continue;
    if (/^[ \t]+$/u.test(token)) {
      if (lineStart) indent += token.length;
      continue;
    }
    if (token === '\\\n' || token === '\\\r\n' || token === '\\\r') {
      lineStart = false;
      continue;
    }
    if (token === '\n' || token === '\r\n' || token === '\r') {
      if (closing.length) continue;
      if (tokens.length) yield finishStatement();
      indent = 0;
      lineStart = true;
      inlineSuite = false;
      continue;
    }
    lineStart = false;
    if (token === '"' || token === "'") {
      yield null;
      return;
    }
    const first = tokens[0];
    if (!closing.length) {
      if (token === ':' && first !== undefined && codexSuiteHeaders.has(first) && !inlineSuite) {
        bindsRuleName ||= first === 'def' && tokens[1] === 'prefix_rule';
        yield finishStatement();
        inlineSuite = true;
        continue;
      }
      if (token === ';') {
        if (tokens.length) yield finishStatement();
        continue;
      }
      if (/^(?:=|(?:\/\/|<<|>>|[-+*/%&|^])=)$/u.test(token) || (first === 'for' && token === 'in')) {
        bindsRuleName ||= tokens.includes('prefix_rule');
      }
    }
    const expected = codexClosingDelimiter.get(token);
    if (expected) closing.push(expected);
    else if ((token === ')' || token === ']' || token === '}') && closing.pop() !== token) {
      yield null;
      return;
    }
    tokens.push(token);
  }
  if (closing.length) yield null;
  else if (tokens.length) yield finishStatement();
}

function readCodexPrefixRule(tokens: string[]): CodexPrefixRule | undefined {
  let cursor = 0;
  const unsupported = (): never => { throw new SyntaxError('Unsupported Codex rule syntax.'); };
  const peek = () => tokens[cursor];
  const expect = (token: string) => { if (peek() !== token) unsupported(); cursor++; };

  function readLiteral(depth = 0): CodexLiteral {
    const token = peek();
    cursor++;
    if (token === '[' && depth < 2) {
      const values: CodexLiteral[] = [];
      while (peek() !== ']') {
        values.push(readLiteral(depth + 1));
        if (peek() === ']') break;
        expect(',');
      }
      expect(']');
      return values;
    }
    if (token === 'True' || token === 'False') return token === 'True';
    if (token && token.length >= 2 && (token[0] === '"' || token[0] === "'")) {
      const quoteSize = token.startsWith(token[0].repeat(3)) ? 3 : 1;
      return token.slice(quoteSize, -quoteSize).replace(/\\([\s\S])/gu, (_escape, character: string) => {
        if (Object.hasOwn(codexStringEscapes, character)) return codexStringEscapes[character]!;
        return '"\'\\'.includes(character) ? character : unsupported();
      });
    }
    return unsupported();
  }

  try {
    expect('prefix_rule');
    expect('(');
    const fields = new Map<string, CodexLiteral>();
    let positionalIndex = 0;
    let named = false;
    while (peek() !== ')') {
      let field = codexRuleFields[positionalIndex++];
      if (tokens[cursor + 1] === '=') {
        field = tokens[cursor];
        cursor += 2;
        named = true;
      } else if (named) unsupported();
      if (!field || !codexRuleFields.includes(field) || fields.has(field)) unsupported();
      fields.set(field!, readLiteral());
      if (peek() === ')') break;
      expect(',');
    }
    expect(')');
    if (peek() !== undefined) return undefined;
    const pattern = fields.get('pattern');
    const decision = fields.get('decision') ?? 'allow';
    const isPatternToken = (value: CodexLiteral): value is string | string[] => typeof value === 'string'
      || (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string'));
    if (!Array.isArray(pattern) || !pattern.length || !pattern.every(isPatternToken)
      || typeof decision !== 'string' || !Object.hasOwn(codexDecisions, decision)
      || (fields.has('canonical_matching') && fields.get('canonical_matching') !== false)) return undefined;
    return { action: codexDecisions[decision as keyof typeof codexDecisions], pattern };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

// Inspect independent declarative calls. Other Starlark leaves the file partially unverified.
function readCodexPrefixRules(contents: string): { rules: CodexPrefixRule[]; incomplete: boolean } {
  const rules: CodexPrefixRule[] = [];
  let incomplete = false;
  let functionIndent: number | undefined;
  for (const statement of codexStatements(contents)) {
    if (!statement) return { rules, incomplete: true };
    const { tokens, indent, inlineSuite, bindsRuleName } = statement;
    if (functionIndent !== undefined && (indent > functionIndent || (indent === functionIndent && inlineSuite))) continue;
    functionIndent = tokens[0] === 'def' ? indent : undefined;
    // A module binding shadows the builtin throughout the file.
    if (bindsRuleName) return { rules: [], incomplete: true };
    const rule = indent === 0 && !inlineSuite && tokens[0] === 'prefix_rule' ? readCodexPrefixRule(tokens) : undefined;
    if (rule) rules.push(rule);
    else incomplete = true;
  }
  return { rules, incomplete };
}

export async function inspectManagedCommandRouteChanges(options: {
  selector: string;
  before?: CommandRoutes;
  after?: CommandRoutes;
  cwd: string;
  userOnly?: boolean;
  inspectInactiveRestrictions?: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<ManagedCommandRouteReview> {
  const { selector, before, after, cwd, env } = options;
  const argv = ['aw', 'command', 'run', selector, '--'];
  const names = new Set([...before?.subcommands ?? [], ...after?.subcommands ?? []].map(({ name }) => name));
  const changed = (word: string | undefined): boolean =>
    canonicalizeIdentityValue(selectLaunch(before, word)) !== canonicalizeIdentityValue(selectLaunch(after, word));
  const routeChanges = [...[...names].sort(), undefined].filter(changed).map((word) => ({
    argv: word === undefined ? argv : [...argv, word],
    before: showLaunch(selectLaunch(before, word)),
    after: showLaunch(selectLaunch(after, word)),
  }));
  const review: ManagedCommandRouteReview = {
    routeChanges,
    affectedPermissions: [],
    permissionReadFailures: [],
    otherProjects: 'unobserved',
    ...(options.userOnly ? { userOnly: true as const } : {}),
    existingApprovalsMayMatch: before === undefined && after !== undefined && routeChanges.length > 0,
  };
  if (routeChanges.length === 0 && !options.inspectInactiveRestrictions) return review;

  function add(platform: PermissionReview['platform'], file: string, action: PermissionReview['action'], tokens: unknown, resourcePattern?: string): void {
    if (!Array.isArray(tokens) || !argv.slice(0, tokens.length).every((token, index) => token === tokens[index])) return;
    const argsPrefix = tokens.slice(argv.length);
    if (argsPrefix.some((token) => typeof token !== 'string' || (platform !== 'codex' && !/^[A-Za-z0-9_./:@%+=,-]+$/u.test(token)))) return;
    const inactive = options.inspectInactiveRestrictions && tokens.length >= argv.length
      && (action === 'ask' || action === 'deny') && !managedCommandRouteIsReachable(after ?? null, argsPrefix);
    if (inactive || (routeChanges.length > 0 && (argsPrefix.length === 0 || changed(argsPrefix[0])))) {
      review.affectedPermissions.push({ platform, path: file, action, argvPrefix: tokens,
        ...(inactive ? { handlerUnavailable: true } : {}), ...(resourcePattern === undefined ? {} : { resourcePattern }) });
    }
  }
  function readFailure(error: unknown, file: string): void {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') review.permissionReadFailures.push(file);
  }
  const projectRoot = options.userOnly ? undefined : await resolveRepoRoot(cwd);
  const claudeFiles = [path.join(getClaudeHome(env), 'settings.json')];
  if (projectRoot) claudeFiles.push(path.join(projectRoot, '.claude', 'settings.json'), path.join(projectRoot, '.claude', 'settings.local.json'));
  for (const file of new Set(claudeFiles)) {
    try {
      const settings = JSON.parse(await fs.readFile(file, 'utf8')) as { permissions?: Record<string, unknown>; sandbox?: Record<string, unknown> };
      for (const action of ['allow', 'ask', 'deny', 'sandbox'] as const) {
        const entries = action === 'sandbox' ? settings.sandbox?.excludedCommands : settings.permissions?.[action];
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (typeof entry !== 'string') continue;
          const body = action === 'sandbox' ? entry : /^Bash\((.*)\)$/u.exec(entry)?.[1];
          if (body === undefined) continue;
          add('claude', file, action, body === '*' ? [] : body.replace(/(?: |:)\*$/u, '').split(' '));
        }
      }
    } catch (error) { readFailure(error, file); }
  }
  const codexDirectories = [path.join(getCodexHome(env), 'rules')];
  if (projectRoot) codexDirectories.push(path.join(projectRoot, '.codex', 'rules'));
  const codexEvidence = createHash('sha256');
  let hasCodexEvidence = false;
  for (const directory of new Set(codexDirectories)) {
    const files = await fs.readdir(directory, { withFileTypes: true }).catch((error) => { readFailure(error, directory); return []; });
    for (const entry of files.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.name.endsWith('.rules')) continue;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await fs.readlink(file, { encoding: 'buffer' }).catch(() => undefined);
        codexEvidence.update(JSON.stringify([file, 'symlink', target?.length ?? null]));
        if (target) codexEvidence.update(target);
        hasCodexEvidence = true;
        review.permissionReadFailures.push(file);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const bytes = await fs.readFile(file);
        codexEvidence.update(JSON.stringify([file, bytes.length])).update(bytes);
        hasCodexEvidence = true;
        const { rules, incomplete } = readCodexPrefixRules(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (incomplete) review.permissionReadFailures.push(file);
        for (const { action, pattern } of rules) {
          const fixed = argv.slice(0, pattern.length);
          if (!fixed.every((word, index) => typeof pattern[index] === 'string'
            ? pattern[index] === word : pattern[index]?.includes(word))) continue;
          const [first, ...rest] = pattern.slice(argv.length);
          const resourcePattern = pattern.some(Array.isArray) ? JSON.stringify(pattern) : undefined;
          if (first === undefined) add('codex', file, action, fixed, resourcePattern);
          else {
            const tail = rest.map((token) => typeof token === 'string' ? token : token[0]!);
            for (const word of typeof first === 'string' ? [first] : new Set(first)) {
              add('codex', file, action, [...fixed, word, ...tail], resourcePattern);
            }
          }
        }
      } catch (error) { readFailure(error, file); }
    }
  }
  if (hasCodexEvidence) review.codexRulesDigest = codexEvidence.digest('hex');
  const ctx = { cwd, env };
  const antigravity = await readAntigravityGlobalPermissions(ctx);
  if (antigravity) {
    if (antigravity.unreadable) review.permissionReadFailures.push(antigravity.path);
    for (const { effect, resource } of antigravity.rules) {
      const literal = antigravityCommandTokens(resource);
      if (literal) add('antigravity', antigravity.path, effect, literal);
      else if (resource.startsWith('command(') && routeChanges.length) {
        const resourcePattern = resource === 'command(*)' ? resource : 'configured command pattern';
        review.affectedPermissions.push({ platform: 'antigravity', path: antigravity.path, action: effect, argvPrefix: argv, resourcePattern });
      }
    }
  }
  const grok = await inspectGrokPermissionConfig(ctx, argv, projectRoot);
  for (const rule of grok.rules) review.affectedPermissions.push({ platform: 'grok', action: rule.action,
    path: rule.path, argvPrefix: argv, resourcePattern: rule.pattern });
  review.permissionReadFailures.push(...grok.readFailures);
  if (grok.unverifiedProjectPath) review.unverifiedGrokProjectPath = grok.unverifiedProjectPath;
  const hostConfigRoot = getOpenCodePermissionRoot(ctx);
  const destinationRoot = projectRoot ?? hostConfigRoot;
  if (!destinationRoot) {
    review.permissionReadFailures.push('OPENCODE_CONFIG_DIR');
    return review;
  }
  const destination = path.join(destinationRoot, 'opencode.json');
  try {
    const raw = await fs.readFile(destination, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return '{}';
    });
    const doc = parseOpenCodePermissionDocument(raw);
    const layers = await readOpenCodePermissionChain(ctx, destination, hostConfigRoot, projectRoot, doc);
    const known = [...doc.permissions.map((rule) => ({ path: destination, rule })), ...layers];
    for (const { path: file, rule } of known) {
      if (!rule || typeof rule !== 'object') {
        if (!review.permissionReadFailures.includes(file)) review.permissionReadFailures.push(file);
        continue;
      }
      const { action, effect, resource = '*' } = rule as Record<string, unknown>;
      if (effect !== 'allow' && effect !== 'ask' && effect !== 'deny' || typeof resource !== 'string') continue;
      if (!openCodePermissionMayMatch(rule, argv)) continue;
      const literal = resource.replace(/ \*$/u, '').split(' ');
      if ((action === 'shell' || action === '*') && literal.every((word) => /^[A-Za-z0-9_./:@%+=,-]+$/u.test(word))) {
        add('opencode', file, effect, literal);
      } else if (routeChanges.some((change) => openCodePermissionMayMatch(rule, change.argv))) {
        review.affectedPermissions.push({ platform: 'opencode', path: file, action: effect, argvPrefix: argv, resourcePattern: resource });
      }
    }
  } catch (error) {
    readFailure(error, destination);
  }
  return review;
}

export function describeManagedCommandRouteReview(review: ManagedCommandRouteReview): string[] {
  const entry = (launch: LaunchReview | null) => launch ? `${launch.route}: ${launch.runner} ${JSON.stringify([launch.entry, ...launch.args])} (cwd=${launch.cwd})` : 'unavailable';
  return [
    ...review.routeChanges.map(({ argv, before, after }) => `${argv.join(' ')}  ${entry(before)} → ${entry(after)}`),
    ...review.affectedPermissions.map(({ platform, path: file, action, argvPrefix, handlerUnavailable, resourcePattern }) =>
      platform === 'antigravity'
        ? `Antigravity CLI Global has ${action} ${JSON.stringify(resourcePattern ?? argvPrefix)} configured in ${file}.${handlerUnavailable ? ' This prefix has no executable handler.' : ''} The live approval decision remains unverified.`
        : platform === 'grok' ? `Grok Build has a configured ${action} rule ${JSON.stringify(resourcePattern)} in ${file}. Its effective decision is unverified.`
        : platform === 'codex' && resourcePattern
          ? `codex ${action} ${JSON.stringify(argvPrefix)} from pattern ${resourcePattern} in ${file}.${handlerUnavailable ? ' This prefix has no executable handler.' : ' The rule may apply to a changed route.'}`
          : `${platform} ${action} ${JSON.stringify(resourcePattern ?? argvPrefix)} in ${file}${handlerUnavailable ? ' remains enforced for this prefix, which has no executable handler.' : ' may apply to a changed route.'}`),
    ...(review.unverifiedGrokProjectPath ? [`Grok project permissions in ${review.unverifiedGrokProjectPath} were left unread because project trust could not be verified.`] : []),
    ...review.permissionReadFailures.map((file) => `Could not inspect permissions in ${file}.`),
    ...(review.existingApprovalsMayMatch ? ['Existing approvals match the invocation text and can apply to this package after a source rebind.'] : []),
    ...(review.routeChanges.length ? [review.userOnly ? 'Permission review covers user settings. Projects may carry matching approvals.'
      : 'Permission review covers user settings and the current project. Other projects may carry matching approvals.'] : []),
  ];
}

export function describeManagedCommandRuntimeConfigChanges(changes: readonly { platform: string; before?: unknown; after?: unknown }[]): string[] {
  return changes.map(({ platform, before, after }) =>
    `Runtime configuration for ${platform}: ${JSON.stringify(before ?? null)} → ${JSON.stringify(after ?? null)}`);
}
