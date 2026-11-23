import { getStaticTOMLValue, parseTOML, type AST } from 'toml-eslint-parser';
import { identityDigest } from './identity.js';
import type { HostPermissionRule } from './host-permission-policy.js';
import { isGrokPermission } from './grok-permissions.js';
import type { PermissionDocument } from './permission-sidecar.js';

const actions = ['allow', 'ask', 'deny'] as const;
const shellTool = /^(?:bash|shell|run_terminal_command|run_terminal_cmd)$/iu;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Normalize only the native shape AW itself writes. Foreign fields remain part of ownership evidence. */
function permissionEntry(value: unknown): unknown {
  const entry = object(value);
  if (entry?.tool === 'bash' && Object.keys(entry).length === 3 && typeof entry.pattern === 'string'
    && actions.includes(entry.action as HostPermissionRule['effect'])) {
    return { action: 'shell', effect: entry.action, resource: entry.pattern };
  }
  return value;
}

function compactRules(permission: Record<string, unknown> | undefined): HostPermissionRule[] {
  return actions.flatMap((effect) => {
    const list = permission?.[effect];
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) throw new Error('grokPermissionConfigInvalid');
    return list.flatMap((entry: string) => {
      const pattern = /^([^()]+)(?:\(([\s\S]*)\))?$/u.exec(entry.trim());
      return pattern && (shellTool.test(pattern[1]!) || pattern[0] === '*')
        ? [{ action: 'shell' as const, effect, resource: pattern[2] ?? '*' }] : [];
    });
  });
}

function keyMatches(node: AST.TOMLKey, expected: string[]): boolean {
  return node.keys.length === expected.length && node.keys.every((part, index) =>
    (part.type === 'TOMLBare' ? part.name : part.value) === expected[index]);
}

function renderRule(rule: HostPermissionRule): string {
  return `{ action = "${rule.effect}", tool = "bash", pattern = ${JSON.stringify(rule.resource)} }`;
}

type Edit = { start: number; end: number; text: string };
const remove = ([start, end]: [number, number]): Edit => ({ start, end, text: '' });
const insert = (offset: number, text: string): Edit => ({ start: offset, end: offset, text });

function applyEdits(source: string, edits: Edit[]): string {
  for (const { start, end, text } of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, start) + text + source.slice(end);
  }
  return source;
}

function parseDocument(source: string) {
  const ast = parseTOML(source);
  const config = object(getStaticTOMLValue(ast));
  const permission = object(config?.permission);
  if (config?.permission !== undefined && !permission) throw new Error('grokPermissionConfigInvalid');
  const rules = permission?.rules ?? [];
  if (!Array.isArray(rules) || rules.some((entry) => !object(entry))) throw new Error('grokPermissionConfigInvalid');
  return { ast, permissions: rules.map(permissionEntry), compactRules: compactRules(permission) };
}

export function parseGrokPermissionDocument(source: string): PermissionDocument & { compactRules: unknown[] } {
  const { ast, permissions, compactRules: compact } = parseDocument(source);
  const root = ast.body[0]!.body;
  const rootEntries = root.filter((entry): entry is AST.TOMLKeyValue => entry.type === 'TOMLKeyValue');
  const tables = root.filter((entry): entry is AST.TOMLTable => entry.type === 'TOMLTable');
  const section = tables.find((table) => table.kind === 'standard' && keyMatches(table.key, ['permission']));
  const inline = rootEntries.find((entry) => keyMatches(entry.key, ['permission']))?.value;
  const inlineTable = inline?.type === 'TOMLInlineTable' ? inline : undefined;
  const assignment = rootEntries.find((entry) => keyMatches(entry.key, ['permission', 'rules']))
    ?? (section?.body ?? inlineTable?.body ?? []).find((entry) => keyMatches(entry.key, ['rules']));
  const array = assignment?.value.type === 'TOMLArray' ? assignment.value : undefined;
  const tableArray = tables.filter((table) => table.kind === 'array' && keyMatches(table.key, ['permission', 'rules']));
  const eol = source.includes('\r\n') ? '\r\n' : '\n';

  return { permissions, compactRules: compact, writePermissions(entries) {
    if (identityDigest(entries) === identityDigest(permissions)) return source;
    const retained = new Set(entries);
    const additions = entries.filter((entry): entry is HostPermissionRule => !permissions.includes(entry) && isGrokPermission(entry));
    const edits: Edit[] = [];
    if (array) {
      let lastRetained = -1;
      for (const [index, item] of array.elements.entries()) {
        if (retained.has(permissions[index])) {
          lastRetained = index;
          continue;
        }
        edits.push(remove(item.range));
        const next = array.elements[index + 1];
        const comma = ast.tokens.find((token) => token.value === ',' && token.range[0] >= item.range[1]
          && token.range[1] <= (next?.range[0] ?? array.range[1]));
        if (comma) edits.push(remove(comma.range));
      }
      if (additions.length) {
        edits.push(insert(array.range[1] - 1, additions.map(renderRule).join(', ')));
        const last = array.elements[lastRetained];
        if (last && !ast.tokens.some((token) => token.value === ',' && token.range[0] >= last.range[1]
          && token.range[1] <= (array.elements[lastRetained + 1]?.range[0] ?? array.range[1]))) {
          edits.push(insert(last.range[1], ', '));
        }
      }
    } else if (tableArray.length) {
      for (const [index, table] of tableArray.entries()) {
        if (retained.has(permissions[index])) continue;
        if (ast.comments.some((comment) => comment.range[0] >= table.range[0] && comment.range[0] < table.range[1])) {
          for (const token of ast.tokens) {
            if (token.range[0] >= table.range[0] && token.range[1] <= table.range[1]) edits.push(remove(token.range));
          }
        } else {
          edits.push(remove(table.range));
        }
      }
      if (additions.length) {
        const formatted = additions.map((rule) => ['[[permission.rules]]', `action = "${rule.effect}"`,
          'tool = "bash"', `pattern = ${JSON.stringify(rule.resource)}`, ''].join(eol)).join(eol);
        edits.push(insert(source.length, (source.endsWith('\n') ? '' : eol) + formatted));
      }
    } else if (additions.length) {
      const value = '[' + additions.map(renderRule).join(', ') + ']';
      if (inlineTable) {
        edits.push(insert(inlineTable.range[1] - 1, (inlineTable.body.length ? ', ' : '') + 'rules = ' + value));
      } else if (section) {
        const lineEnd = source.indexOf('\n', section.range[1]);
        edits.push(insert(lineEnd < 0 ? source.length : lineEnd + 1,
          (lineEnd < 0 ? eol : '') + 'rules = ' + value + eol));
      } else if (rootEntries.some((entry) => entry.key.keys.length > 1 && keyMatchesPrefix(entry.key, 'permission'))) {
        edits.push(insert(tables[0]?.range[0] ?? source.length,
          (tables.length || source.endsWith('\n') ? '' : eol) + 'permission.rules = ' + value + eol));
      } else {
        edits.push(insert(source.length, (source && !source.endsWith('\n') ? eol : '') + '[permission]' + eol + 'rules = ' + value + eol));
      }
    }
    const result = applyEdits(source, edits);
    if (identityDigest(parseDocument(result).permissions) !== identityDigest(entries)) throw new Error('grokPermissionConfigInvalid');
    return result;
  } };
}

function keyMatchesPrefix(key: AST.TOMLKey, first: string): boolean {
  const part = key.keys[0]!;
  return (part.type === 'TOMLBare' ? part.name : part.value) === first;
}
