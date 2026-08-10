import path from 'node:path';

import fs from 'fs-extra';
import { ParseError, parseTOML, type AST } from 'toml-eslint-parser';

import {
  atomicReplaceConfigFile,
  withConfigFileLock,
} from './plugin-config.js';

const AW_MANAGED_PREFIX = '[[aw-managed:';
const MANAGED_INSTRUCTIONS_KIND = 'developer_instructions';
const MANAGED_BLOCK_START_RE =
  /^\[\[aw-managed:start plugin="([^"\n]+)" kind="developer_instructions"\]\]$/;
const MANAGED_BLOCK_END_RE = /^\[\[aw-managed:end plugin="([^"\n]+)"\]\]$/;

type ScalarTomlValue = string | boolean;
type TomlEntry = AST.TOMLKeyValue | AST.TOMLTable;

interface CodexTomlDocument {
  content: string;
  ast: AST.TOMLProgram;
  topLevel: AST.TOMLTopLevelTable;
  newline: string;
}

export type CodexMcpTomlValue =
  | string
  | boolean
  | number
  | CodexMcpTomlValue[]
  | { [key: string]: CodexMcpTomlValue };

export interface CodexMcpServerConfig {
  [key: string]: CodexMcpTomlValue;
}

export interface CodexMcpServerSnapshot {
  key: string;
  value?: CodexMcpServerConfig;
  parseError?: string;
}

export type CodexMcpServerState = 'visible' | 'missing' | 'drifted' | 'orphan';

export interface CodexMcpServerStatusSignal {
  key: string;
  tracked: boolean;
  state: CodexMcpServerState;
  reason?: string;
}

interface ManagedInstructionTextSegment {
  type: 'text';
  value: string;
}

interface ManagedInstructionBlockSegment {
  type: 'block';
  pluginName: string;
  value: string;
}

type ManagedInstructionSegment =
  | ManagedInstructionTextSegment
  | ManagedInstructionBlockSegment;

export interface CodexMarketplaceConfig {
  source: string;
  sourceType: string;
  lastUpdated?: string;
}

export interface CodexPluginEnabledConfig {
  enabled: boolean;
}

export interface CodexManagedInstructionBlock {
  pluginName: string;
  value: string;
}

export interface CodexManagedInstructionFragment {
  artifactId: string;
  value: string;
}

export interface CodexMarketplaceSnapshot {
  name: string;
  source?: string;
  sourceType?: string;
  lastUpdated?: string;
  sourcePointsToManifest: boolean;
}

export interface CodexPluginSnapshot {
  name: string;
  enabled?: boolean;
}

export interface CodexProjectSnapshot {
  path: string;
  trustLevel?: string;
}

export interface CodexAgentRegistrationConfig {
  description?: string;
  configFile?: string;
}

export interface CodexAgentRegistrationSnapshot {
  key: string;
  description?: string;
  configFile?: string;
}

export interface CodexDeveloperInstructionsSnapshot {
  defined: boolean;
  value?: string;
  managedBlocks: Record<string, CodexManagedInstructionBlock>;
}

export interface CodexConfigSnapshot {
  marketplaces: Record<string, CodexMarketplaceSnapshot>;
  plugins: Record<string, CodexPluginSnapshot>;
  projects: Record<string, CodexProjectSnapshot>;
  agents: Record<string, CodexAgentRegistrationSnapshot>;
  mcpServers: Record<string, CodexMcpServerSnapshot>;
  developerInstructions: CodexDeveloperInstructionsSnapshot;
}

export interface CodexConfigTransaction {
  upsertManagedInstructionBlock?: CodexManagedInstructionBlock;
  removeManagedInstructionPluginName?: string;
  upsertAgentRegistrations?: Record<string, CodexAgentRegistrationConfig>;
  removeAgentRegistrations?: string[];
  upsertMcpServers?: Record<string, CodexMcpServerConfig>;
  removeMcpServers?: string[];
}

export interface CodexConfigTransactionResult {
  baselineContent: string | null;
  content: string;
  snapshot: CodexConfigSnapshot;
  wrote: boolean;
}

export interface ConditionalCodexConfigTransactionResult extends CodexConfigTransactionResult {
  applied: boolean;
}

function detectNewline(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function parseTomlDocument(content: string): CodexTomlDocument {
  try {
    const ast = parseTOML(content);
    return {
      content,
      ast,
      topLevel: ast.body[0],
      newline: detectNewline(content),
    };
  } catch (error) {
    if (error instanceof ParseError) {
      throw new Error(`Unable to parse Codex config TOML: ${error.message}`);
    }
    throw error;
  }
}

function keySegments(key: AST.TOMLKey): string[] {
  return key.keys.map((segment) =>
    segment.type === 'TOMLBare' ? segment.name : segment.value,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteTomlNumber(value: number): boolean {
  return Number.isFinite(value);
}

function renderTomlKeySegment(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment);
}

function renderTomlPath(segments: string[]): string {
  return segments.map((segment) => renderTomlKeySegment(segment)).join('.');
}

function isTopLevelKeyValue(
  entry: TomlEntry,
  keyName: string,
): entry is AST.TOMLKeyValue {
  return entry.type === 'TOMLKeyValue' && keySegments(entry.key).join('.') === keyName;
}

function findTopLevelKeyValue(
  document: CodexTomlDocument,
  keyName: string,
): AST.TOMLKeyValue | undefined {
  return document.topLevel.body.find((entry): entry is AST.TOMLKeyValue =>
    isTopLevelKeyValue(entry, keyName),
  );
}

function findTopLevelTable(
  document: CodexTomlDocument,
  sectionType: string,
  sectionName: string,
): AST.TOMLTable | undefined {
  return document.topLevel.body.find(
    (entry): entry is AST.TOMLTable =>
      entry.type === 'TOMLTable' &&
      keySegments(entry.key).length === 2 &&
      keySegments(entry.key)[0] === sectionType &&
      keySegments(entry.key)[1] === sectionName,
  );
}

function findTableEntry(
  table: AST.TOMLTable,
  keyName: string,
): AST.TOMLKeyValue | undefined {
  return table.body.find((entry) => keySegments(entry.key).join('.') === keyName);
}

function readScalarValue(node: AST.TOMLKeyValue['value']): ScalarTomlValue | undefined {
  if (node.type === 'TOMLValue' && node.kind === 'string') {
    return node.value;
  }
  if (node.type === 'TOMLValue' && node.kind === 'boolean') {
    return node.value;
  }
  return undefined;
}

function renderTomlLiteral(value: ScalarTomlValue, newline: string): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return renderTomlString(value, newline);
}

function renderTomlString(value: string, newline: string): string {
  if (value.includes('\n')) {
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/"""/g, '\\"\\"\\"')
      .replace(/\n/g, newline);
    return `"""${newline}${escaped}"""`;
  }

  return JSON.stringify(value);
}

function renderTableHeader(sectionType: string, sectionName: string): string {
  const renderedName = /^[A-Za-z0-9_-]+$/.test(sectionName)
    ? sectionName
    : JSON.stringify(sectionName);
  return `[${sectionType}.${renderedName}]`;
}

function renderCodexMcpTomlValue(value: CodexMcpTomlValue): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!isFiniteTomlNumber(value)) {
      throw new Error('MCP value numbers must be finite.');
    }
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => renderCodexMcpTomlValue(entry)).join(', ')}]`;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return '{}';
  }
  return `{ ${entries
    .map(([key, entryValue]) => `${renderTomlKeySegment(key)} = ${renderCodexMcpTomlValue(entryValue)}`)
    .join(', ')} }`;
}

function normalizeCodexMcpTomlValue(
  value: unknown,
  fieldPath: string,
): CodexMcpTomlValue {
  if (value === null) {
    throw new Error(`Invalid ${fieldPath}: null cannot be represented in TOML.`);
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!isFiniteTomlNumber(value)) {
      throw new Error(`Invalid ${fieldPath}: number must be finite.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      normalizeCodexMcpTomlValue(entry, `${fieldPath}[${index}]`),
    );
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid ${fieldPath}: expected a TOML-compatible JSON value.`);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      normalizeCodexMcpTomlValue(entryValue, `${fieldPath}.${key}`),
    ]),
  );
}

function renderCodexMcpServerContent(
  serverName: string,
  config: CodexMcpServerConfig,
  newline: string,
): string {
  const tables: string[] = [];

  const visitTable = (tablePath: string[], tableValue: CodexMcpServerConfig): void => {
    const scalarLines: string[] = [];
    const childObjects: Array<[string, CodexMcpServerConfig]> = [];

    for (const [key, value] of Object.entries(tableValue)) {
      if (isRecord(value)) {
        childObjects.push([key, value as CodexMcpServerConfig]);
        continue;
      }

      scalarLines.push(`${renderTomlKeySegment(key)} = ${renderCodexMcpTomlValue(value)}`);
    }

    tables.push(
      [
        `[${renderTomlPath(tablePath)}]`,
        ...scalarLines,
      ].join(newline),
    );

    for (const [childKey, childValue] of childObjects) {
      visitTable([...tablePath, childKey], childValue);
    }
  };

  visitTable(['mcp_servers', serverName], config);
  return `${tables.join(`${newline}${newline}`)}${newline}`;
}

function findTopLevelTablesWithPrefix(
  document: CodexTomlDocument,
  keyPrefix: string[],
): AST.TOMLTable[] {
  return document.topLevel.body.filter(
    (entry): entry is AST.TOMLTable =>
      entry.type === 'TOMLTable' &&
      keyPrefix.every((segment, index) => keySegments(entry.key)[index] === segment),
  );
}

function readCodexMcpTomlValue(
  node: AST.TOMLKeyValue['value'],
  fieldPath: string,
): CodexMcpTomlValue {
  if (node.type === 'TOMLValue') {
    if (
      node.kind === 'string' ||
      node.kind === 'boolean' ||
      node.kind === 'integer' ||
      node.kind === 'float'
    ) {
      return normalizeCodexMcpTomlValue(node.value, fieldPath);
    }
    throw new Error(`Unsupported TOML value kind at ${fieldPath}: ${node.kind}.`);
  }

  if (node.type === 'TOMLArray') {
    return node.elements.map((entry, index) =>
      readCodexMcpTomlValue(entry, `${fieldPath}[${index}]`),
    );
  }

  if (node.type === 'TOMLInlineTable') {
    const value: CodexMcpServerConfig = {};
    for (const entry of node.body) {
      assignCodexMcpObjectValue(
        value,
        keySegments(entry.key),
        readCodexMcpTomlValue(entry.value, `${fieldPath}.${keySegments(entry.key).join('.')}`),
        fieldPath,
      );
    }
    return value;
  }

  const unsupportedNodeType = (node as { type?: string }).type ?? 'unknown';
  throw new Error(`Unsupported TOML MCP value node at ${fieldPath}: ${unsupportedNodeType}.`);
}

function ensureCodexMcpObjectPath(
  root: CodexMcpServerConfig,
  segments: string[],
  fieldPath: string,
): CodexMcpServerConfig {
  let current = root;
  for (const segment of segments) {
    const existing = current[segment];
    if (existing === undefined) {
      current[segment] = {};
      current = current[segment] as CodexMcpServerConfig;
      continue;
    }
    if (!isRecord(existing)) {
      throw new Error(`Cannot treat ${fieldPath} as a table because it is already a scalar value.`);
    }
    current = existing as CodexMcpServerConfig;
  }
  return current;
}

function assignCodexMcpObjectValue(
  root: CodexMcpServerConfig,
  keyPath: string[],
  value: CodexMcpTomlValue,
  fieldPath: string,
): void {
  const parent = ensureCodexMcpObjectPath(root, keyPath.slice(0, -1), fieldPath);
  const leafKey = keyPath.at(-1);
  if (!leafKey) {
    throw new Error(`Invalid empty MCP key path at ${fieldPath}.`);
  }

  const existing = parent[leafKey];
  if (existing !== undefined && isRecord(existing)) {
    throw new Error(`Cannot overwrite nested MCP table at ${fieldPath} with a scalar value.`);
  }
  parent[leafKey] = value;
}

function buildCodexMcpServerSnapshot(
  serverName: string,
  tables: AST.TOMLTable[],
): CodexMcpServerSnapshot {
  try {
    const value: CodexMcpServerConfig = {};

    for (const table of tables) {
      const tablePath = keySegments(table.key).slice(2);
      const tableTarget = ensureCodexMcpObjectPath(
        value,
        tablePath,
        `mcpServers.${serverName}${tablePath.length > 0 ? `.${tablePath.join('.')}` : ''}`,
      );

      for (const entry of table.body) {
        assignCodexMcpObjectValue(
          tableTarget,
          keySegments(entry.key),
          readCodexMcpTomlValue(
            entry.value,
            `mcpServers.${serverName}.${[...tablePath, ...keySegments(entry.key)].join('.')}`,
          ),
          `mcpServers.${serverName}.${[...tablePath, ...keySegments(entry.key)].join('.')}`,
        );
      }
    }

    return {
      key: serverName,
      value,
    };
  } catch (error) {
    return {
      key: serverName,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function collectCodexMcpServerSnapshots(
  document: CodexTomlDocument,
): Record<string, CodexMcpServerSnapshot> {
  const groupedTables = new Map<string, AST.TOMLTable[]>();

  for (const table of findTopLevelTablesWithPrefix(document, ['mcp_servers'])) {
    const segments = keySegments(table.key);
    if (segments.length < 2) {
      continue;
    }

    const serverName = segments[1];
    const tables = groupedTables.get(serverName) ?? [];
    tables.push(table);
    groupedTables.set(serverName, tables);
  }

  return Object.fromEntries(
    [...groupedTables.entries()].map(([serverName, tables]) => [
      serverName,
      buildCodexMcpServerSnapshot(serverName, tables),
    ]),
  );
}

function lineStart(content: string, index: number): number {
  let current = index;
  while (current > 0 && content[current - 1] !== '\n') {
    current -= 1;
  }
  return current;
}

function lineEndExclusive(content: string, index: number): number {
  let current = index;
  while (current < content.length && content[current] !== '\n') {
    current += 1;
  }
  if (current < content.length) {
    current += 1;
  }
  return current;
}

function expandNodeRemovalRange(content: string, start: number, end: number): [number, number] {
  let removeStart = lineStart(content, start);
  let removeEnd = lineEndExclusive(content, end);

  if (removeEnd < content.length && content[removeEnd] === '\n') {
    removeEnd += 1;
  }

  if (removeStart === 0) {
    while (removeEnd < content.length && content[removeEnd] === '\n') {
      removeEnd += 1;
    }
  }

  return [removeStart, removeEnd];
}

function ensureTerminalNewline(content: string): string {
  if (content.length === 0) {
    return '';
  }
  return content.endsWith('\n') ? content : `${content}\n`;
}

function applyPatches(
  content: string,
  patches: Array<{ start: number; end: number; text: string }>,
): string {
  const sorted = [...patches].sort((left, right) => right.start - left.start);
  let next = content;

  for (const patch of sorted) {
    next = `${next.slice(0, patch.start)}${patch.text}${next.slice(patch.end)}`;
  }

  return ensureTerminalNewline(next);
}

function buildSectionInsertText(
  document: CodexTomlDocument,
  sectionType: string,
  sectionName: string,
  orderedEntries: Array<[string, ScalarTomlValue]>,
): string {
  const lines = [
    renderTableHeader(sectionType, sectionName),
    ...orderedEntries.map(
      ([key, value]) => `${key} = ${renderTomlLiteral(value, document.newline)}`,
    ),
  ];
  const sectionText = lines.join(document.newline);

  if (document.content.length === 0) {
    return `${sectionText}${document.newline}`;
  }

  const prefix = document.content.endsWith(`${document.newline}${document.newline}`)
    ? ''
    : document.content.endsWith(document.newline)
      ? document.newline
      : `${document.newline}${document.newline}`;

  return `${prefix}${sectionText}${document.newline}`;
}

function buildMcpServerInsertText(
  document: CodexTomlDocument,
  tableText: string,
): string {
  if (document.content.length === 0) {
    return tableText;
  }

  const prefix = document.content.endsWith(`${document.newline}${document.newline}`)
    ? ''
    : document.content.endsWith(document.newline)
      ? document.newline
      : `${document.newline}${document.newline}`;

  return `${prefix}${tableText}`;
}

function upsertSectionEntries(
  content: string,
  sectionType: string,
  sectionName: string,
  orderedEntries: Array<[string, ScalarTomlValue]>,
): string {
  const document = parseTomlDocument(content);
  const table = findTopLevelTable(document, sectionType, sectionName);
  if (!table) {
    return applyPatches(document.content, [
      {
        start: document.content.length,
        end: document.content.length,
        text: buildSectionInsertText(document, sectionType, sectionName, orderedEntries),
      },
    ]);
  }

  const patches: Array<{ start: number; end: number; text: string }> = [];
  const missingEntries = new Map(orderedEntries);

  for (const [key, value] of orderedEntries) {
    const entry = findTableEntry(table, key);
    if (!entry) {
      continue;
    }

    missingEntries.delete(key);
    patches.push({
      start: entry.value.range[0],
      end: entry.value.range[1],
      text: renderTomlLiteral(value, document.newline),
    });
  }

  if (missingEntries.size > 0) {
    const text = [
      '',
      ...[...missingEntries.entries()].map(
        ([key, value]) => `${key} = ${renderTomlLiteral(value, document.newline)}`,
      ),
    ].join(document.newline);

    patches.push({
      start: table.range[1],
      end: table.range[1],
      text,
    });
  }

  return patches.length > 0 ? applyPatches(document.content, patches) : ensureTerminalNewline(content);
}

function removeSection(
  content: string,
  sectionType: string,
  sectionName: string,
): string {
  const document = parseTomlDocument(content);
  const table = findTopLevelTable(document, sectionType, sectionName);
  if (!table) {
    return ensureTerminalNewline(content);
  }

  const [start, end] = expandNodeRemovalRange(document.content, table.range[0], table.range[1]);
  return applyPatches(document.content, [{ start, end, text: '' }]);
}

function resolveTopLevelKeyInsertIndex(document: CodexTomlDocument): number {
  const topLevelKeyValues = document.topLevel.body.filter(
    (entry): entry is AST.TOMLKeyValue => entry.type === 'TOMLKeyValue',
  );
  const lastTopLevelKeyValue = topLevelKeyValues.at(-1);
  if (lastTopLevelKeyValue) {
    return lineEndExclusive(document.content, lastTopLevelKeyValue.range[1]);
  }

  const firstTable = document.topLevel.body.find(
    (entry): entry is AST.TOMLTable => entry.type === 'TOMLTable',
  );
  if (firstTable) {
    return lineStart(document.content, firstTable.range[0]);
  }

  return document.content.length;
}

function buildTopLevelAssignmentInsertText(
  document: CodexTomlDocument,
  assignment: string,
  index: number,
): string {
  if (document.content.length === 0) {
    return `${assignment}${document.newline}`;
  }

  const before = document.content.slice(0, index);
  const after = document.content.slice(index);
  const needsLeadingBlank =
    before.length > 0 &&
    !before.endsWith(`${document.newline}${document.newline}`) &&
    !before.endsWith(document.newline);
  const needsTrailingBlank =
    after.length > 0 &&
    !after.startsWith(document.newline) &&
    !after.startsWith(`${document.newline}${document.newline}`);

  return `${needsLeadingBlank ? `${document.newline}${document.newline}` : ''}${assignment}${
    needsTrailingBlank ? `${document.newline}${document.newline}` : document.newline
  }`;
}

interface ValueLine {
  text: string;
  start: number;
  endExclusive: number;
}

function splitValueLines(value: string): ValueLine[] {
  if (value.length === 0) {
    return [];
  }

  const lines: ValueLine[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\n') {
      continue;
    }

    lines.push({
      text: value.slice(start, index),
      start,
      endExclusive: index + 1,
    });
    start = index + 1;
  }

  lines.push({
    text: value.slice(start),
    start,
    endExclusive: value.length,
  });

  return lines;
}

function parseManagedInstructionSegments(
  value: string,
): ManagedInstructionSegment[] {
  if (value.length === 0) {
    return [{ type: 'text', value: '' }];
  }

  const lines = splitValueLines(value);
  const segments: ManagedInstructionSegment[] = [];
  const seenPlugins = new Set<string>();
  let textStart = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const startMatch = MANAGED_BLOCK_START_RE.exec(lines[lineIndex].text);
    if (!startMatch) {
      continue;
    }

    const pluginName = startMatch[1];
    if (seenPlugins.has(pluginName)) {
      throw new Error(
        `Codex developer_instructions contains duplicate aw-managed block for ${pluginName}.`,
      );
    }

    let endIndex = lineIndex + 1;
    for (; endIndex < lines.length; endIndex += 1) {
      const endMatch = MANAGED_BLOCK_END_RE.exec(lines[endIndex].text);
      if (endMatch && endMatch[1] === pluginName) {
        break;
      }
    }

    if (endIndex >= lines.length) {
      throw new Error(
        `Codex developer_instructions contains an unterminated aw-managed block for ${pluginName}.`,
      );
    }

    segments.push({
      type: 'text',
      value: value.slice(textStart, lines[lineIndex].start),
    });
    segments.push({
      type: 'block',
      pluginName,
      value: value.slice(lines[lineIndex].endExclusive, lines[endIndex].start),
    });

    seenPlugins.add(pluginName);
    textStart = lines[endIndex].endExclusive;
    lineIndex = endIndex;
  }

  segments.push({
    type: 'text',
    value: value.slice(textStart),
  });

  return segments;
}

function renderManagedInstructionBlock(
  pluginName: string,
  value: string,
): string {
  const normalizedValue = value.replace(/\n+$/, '');
  return [
    `[[aw-managed:start plugin="${pluginName}" kind="${MANAGED_INSTRUCTIONS_KIND}"]]`,
    normalizedValue,
    `[[aw-managed:end plugin="${pluginName}"]]`,
  ].join('\n') + '\n';
}

export function composeManagedDeveloperInstructionsBlock(
  pluginName: string,
  fragments: readonly CodexManagedInstructionFragment[],
): CodexManagedInstructionBlock {
  const seenArtifactIds = new Set<string>();
  const normalizedValues = [...fragments]
    .map((fragment) => {
      const artifactId = fragment.artifactId.trim();
      if (!artifactId) {
        throw new Error('Managed instruction fragments must declare a non-empty artifactId.');
      }
      if (seenArtifactIds.has(artifactId)) {
        throw new Error(`Duplicate managed instruction fragment id: ${artifactId}.`);
      }
      seenArtifactIds.add(artifactId);
      return {
        artifactId,
        value: fragment.value.trim(),
      };
    })
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId))
    .map((fragment) => fragment.value)
    .filter((value) => value.length > 0);

  return {
    pluginName,
    value: normalizedValues.join('\n\n'),
  };
}

function renderManagedInstructionSegments(
  segments: ManagedInstructionSegment[],
): string {
  return segments
    .map((segment) =>
      segment.type === 'text'
        ? segment.value
        : renderManagedInstructionBlock(segment.pluginName, segment.value),
    )
    .join('');
}

function rejectSentinelPrefixedLines(value: string): void {
  if (/^\[\[aw-managed:/m.test(value)) {
    throw new Error(
      'Instruction content must not contain lines starting with [[aw-managed:.',
    );
  }
}

function appendManagedBlockToTail(
  existingText: string,
  blockText: string,
): string {
  if (existingText.length === 0) {
    return blockText;
  }
  if (existingText.endsWith('\n\n')) {
    return `${existingText}${blockText}`;
  }
  if (existingText.endsWith('\n')) {
    return `${existingText}\n${blockText}`;
  }
  return `${existingText}\n\n${blockText}`;
}

function mergeTextAroundRemovedBlock(left: string, right: string): string {
  if (left.length === 0 && right.length === 0) {
    return '';
  }
  if (left.length === 0) {
    return right.replace(/^\n+/, '');
  }
  if (right.length === 0) {
    return left.replace(/\n+$/, '');
  }
  return `${left.replace(/\n+$/, '')}\n\n${right.replace(/^\n+/, '')}`;
}

function upsertManagedInstructionsValue(
  currentValue: string | undefined,
  block: CodexManagedInstructionBlock,
): string {
  rejectSentinelPrefixedLines(block.value);
  const segments = parseManagedInstructionSegments(currentValue ?? '');
  const renderedBlock = renderManagedInstructionBlock(block.pluginName, block.value.trim());
  const existingIndex = segments.findIndex(
    (segment) => segment.type === 'block' && segment.pluginName === block.pluginName,
  );

  if (existingIndex >= 0) {
    (segments[existingIndex] as ManagedInstructionBlockSegment).value = block.value.trim();
    return renderManagedInstructionSegments(segments);
  }

  const lastSegment = segments.at(-1);
  if (!lastSegment || lastSegment.type !== 'text') {
    return renderedBlock;
  }

  const previousSegment = segments.length >= 2 ? segments[segments.length - 2] : undefined;
  lastSegment.value =
    previousSegment?.type === 'block' && lastSegment.value.length === 0
      ? `\n${renderedBlock}`
      : appendManagedBlockToTail(lastSegment.value, renderedBlock);
  return renderManagedInstructionSegments(segments);
}

function removeManagedInstructionsValue(
  currentValue: string | undefined,
  pluginName: string,
): string | undefined {
  if (currentValue === undefined) {
    return undefined;
  }

  const segments = parseManagedInstructionSegments(currentValue);
  const blockIndex = segments.findIndex(
    (segment) => segment.type === 'block' && segment.pluginName === pluginName,
  );
  if (blockIndex < 0) {
    return currentValue;
  }

  const leftText =
    blockIndex > 0 && segments[blockIndex - 1]?.type === 'text'
      ? (segments[blockIndex - 1] as ManagedInstructionTextSegment).value
      : '';
  const rightText =
    blockIndex < segments.length - 1 && segments[blockIndex + 1]?.type === 'text'
      ? (segments[blockIndex + 1] as ManagedInstructionTextSegment).value
      : '';

  const nextSegments = [...segments];
  nextSegments.splice(
    Math.max(blockIndex - 1, 0),
    Math.min(3, nextSegments.length - Math.max(blockIndex - 1, 0)),
    {
      type: 'text',
      value: mergeTextAroundRemovedBlock(leftText, rightText),
    } satisfies ManagedInstructionTextSegment,
  );

  const rendered = renderManagedInstructionSegments(nextSegments).trim();

  return rendered === '' ? undefined : rendered;
}

function renderDeveloperInstructionsAssignment(
  value: string,
  newline: string,
): string {
  return `developer_instructions = ${renderTomlString(value, newline)}`;
}

export function parseCodexConfig(content: string): CodexConfigSnapshot {
  const document = parseTomlDocument(content);
  const marketplaces: Record<string, CodexMarketplaceSnapshot> = {};
  const plugins: Record<string, CodexPluginSnapshot> = {};
  const projects: Record<string, CodexProjectSnapshot> = {};
  const agents: Record<string, CodexAgentRegistrationSnapshot> = {};
  const mcpServers = collectCodexMcpServerSnapshots(document);

  for (const entry of document.topLevel.body) {
    if (entry.type !== 'TOMLTable') {
      continue;
    }

    const segments = keySegments(entry.key);
    if (segments.length !== 2) {
      continue;
    }

    const values = Object.fromEntries(
      entry.body
        .map((item) => {
          const scalarValue = readScalarValue(item.value);
          return scalarValue === undefined
            ? undefined
            : [keySegments(item.key).join('.'), scalarValue];
        })
        .filter((item): item is [string, ScalarTomlValue] => item !== undefined),
    );

    if (segments[0] === 'marketplaces') {
      const source = typeof values.source === 'string' ? values.source : undefined;
      marketplaces[segments[1]] = {
        name: segments[1],
        source,
        sourceType: typeof values.source_type === 'string' ? values.source_type : undefined,
        lastUpdated:
          typeof values.last_updated === 'string' ? values.last_updated : undefined,
        sourcePointsToManifest:
          source !== undefined && /(?:^|[\\/])marketplace\.json$/i.test(source),
      };
      continue;
    }

    if (segments[0] === 'plugins') {
      plugins[segments[1]] = {
        name: segments[1],
        enabled: typeof values.enabled === 'boolean' ? values.enabled : undefined,
      };
      continue;
    }

    if (segments[0] === 'projects') {
      projects[segments[1]] = {
        path: segments[1],
        trustLevel:
          typeof values.trust_level === 'string' ? values.trust_level : undefined,
      };
      continue;
    }

    if (segments[0] === 'agents') {
      agents[segments[1]] = {
        key: segments[1],
        description:
          typeof values.description === 'string' ? values.description : undefined,
        configFile:
          typeof values.config_file === 'string' ? values.config_file : undefined,
      };
    }
  }

  const developerInstructionsEntry = findTopLevelKeyValue(
    document,
    'developer_instructions',
  );
  const developerInstructionsValue =
    developerInstructionsEntry?.value.type === 'TOMLValue' &&
    developerInstructionsEntry.value.kind === 'string'
      ? developerInstructionsEntry.value.value
      : undefined;
  const managedBlocks: Record<string, CodexManagedInstructionBlock> = {};
  if (developerInstructionsValue !== undefined) {
    for (const segment of parseManagedInstructionSegments(developerInstructionsValue)) {
      if (segment.type !== 'block') {
        continue;
      }
      managedBlocks[segment.pluginName] = {
        pluginName: segment.pluginName,
        value: segment.value,
      };
    }
  }

  return {
    marketplaces,
    plugins,
    projects,
    agents,
    mcpServers,
    developerInstructions: {
      defined: developerInstructionsValue !== undefined,
      value: developerInstructionsValue,
      managedBlocks,
    },
  };
}

export function upsertCodexMarketplace(
  content: string,
  name: string,
  config: CodexMarketplaceConfig,
): string {
  return upsertSectionEntries(content, 'marketplaces', name, [
    ['last_updated', config.lastUpdated ?? new Date().toISOString()],
    ['source_type', config.sourceType],
    ['source', config.source],
  ]);
}

export function removeCodexMarketplace(
  content: string,
  name: string,
): string {
  return removeSection(content, 'marketplaces', name);
}

export function upsertCodexPluginEnabled(
  content: string,
  name: string,
  config: CodexPluginEnabledConfig,
): string {
  return upsertSectionEntries(content, 'plugins', name, [['enabled', config.enabled]]);
}

export function removeCodexPluginEnabled(
  content: string,
  name: string,
): string {
  return removeSection(content, 'plugins', name);
}

export function upsertCodexAgentRegistration(
  content: string,
  roleKey: string,
  config: CodexAgentRegistrationConfig,
): string {
  const entries: Array<[string, ScalarTomlValue]> = [];
  if (config.configFile !== undefined) {
    entries.push(['config_file', config.configFile]);
  }
  if (config.description !== undefined) {
    entries.push(['description', config.description]);
  }
  return upsertSectionEntries(content, 'agents', roleKey, entries);
}

export function removeCodexAgentRegistration(
  content: string,
  roleKey: string,
): string {
  return removeSection(content, 'agents', roleKey);
}

export function normalizeRenderedCodexMcpServers(
  value: unknown,
  fieldName = 'mcpServers',
): Record<string, CodexMcpServerConfig> {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${fieldName}: expected top-level "mcpServers" object.`);
  }

  return Object.fromEntries(
    Object.entries(value).map(([serverName, serverConfig]) => {
      if (!isRecord(serverConfig)) {
        throw new Error(`Invalid ${fieldName}.${serverName}: expected a server config object.`);
      }

      return [
        serverName,
        normalizeCodexMcpTomlValue(
          serverConfig,
          `${fieldName}.${serverName}`,
        ) as CodexMcpServerConfig,
      ];
    }),
  );
}

export function parseRenderedCodexMcpFileContent(
  content: unknown,
  fieldName = 'mcp file',
): Record<string, CodexMcpServerConfig> {
  if (!isRecord(content)) {
    throw new Error(`Invalid ${fieldName}: expected a JSON object.`);
  }

  return normalizeRenderedCodexMcpServers(content.mcpServers, `${fieldName}.mcpServers`);
}

export function upsertCodexMcpServer(
  content: string,
  serverName: string,
  config: CodexMcpServerConfig,
): string {
  const normalizedConfig = normalizeCodexMcpTomlValue(
    config,
    `mcpServers.${serverName}`,
  ) as CodexMcpServerConfig;
  const document = parseTomlDocument(content);
  const matchingTables = findTopLevelTablesWithPrefix(document, ['mcp_servers', serverName]);
  const renderedContent = renderCodexMcpServerContent(
    serverName,
    normalizedConfig,
    document.newline,
  );

  if (matchingTables.length === 0) {
    return applyPatches(document.content, [
      {
        start: document.content.length,
        end: document.content.length,
        text: buildMcpServerInsertText(document, renderedContent),
      },
    ]);
  }

  const patches: Array<{ start: number; end: number; text: string }> = [];
  const [firstStart, firstEnd] = expandNodeRemovalRange(
    document.content,
    matchingTables[0].range[0],
    matchingTables[0].range[1],
  );
  patches.push({
    start: firstStart,
    end: firstEnd,
    text: renderedContent,
  });

  for (const table of matchingTables.slice(1)) {
    const [start, end] = expandNodeRemovalRange(
      document.content,
      table.range[0],
      table.range[1],
    );
    patches.push({ start, end, text: '' });
  }

  return applyPatches(document.content, patches);
}

export function removeCodexMcpServer(
  content: string,
  serverName: string,
): string {
  const document = parseTomlDocument(content);
  const matchingTables = findTopLevelTablesWithPrefix(document, ['mcp_servers', serverName]);
  if (matchingTables.length === 0) {
    return ensureTerminalNewline(content);
  }

  return applyPatches(
    document.content,
    matchingTables.map((table) => {
      const [start, end] = expandNodeRemovalRange(
        document.content,
        table.range[0],
        table.range[1],
      );
      return { start, end, text: '' };
    }),
  );
}

function stableCodexMcpValue(value: CodexMcpTomlValue): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((entry) => JSON.parse(stableCodexMcpValue(entry))));
  }
  if (isRecord(value)) {
    return JSON.stringify(
      Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [
            key,
            JSON.parse(stableCodexMcpValue(value[key] as CodexMcpTomlValue)),
          ]),
      ),
    );
  }

  return JSON.stringify(value);
}

export function resolveCodexMcpServerStatusSignal(options: {
  key: string;
  tracked: boolean;
  actual: CodexMcpServerSnapshot | undefined;
  expected?: CodexMcpServerConfig;
}): CodexMcpServerStatusSignal {
  if (!options.tracked && options.actual) {
    return {
      key: options.key,
      tracked: false,
      state: 'orphan',
      reason: 'server exists in .codex/config.toml but current plugin has no AW ownership marker for it.',
    };
  }

  if (!options.actual) {
    return {
      key: options.key,
      tracked: options.tracked,
      state: 'missing',
      reason: 'server is missing from .codex/config.toml.',
    };
  }

  if (options.actual.parseError) {
    return {
      key: options.key,
      tracked: options.tracked,
      state: 'drifted',
      reason: options.actual.parseError,
    };
  }

  if (options.expected === undefined) {
    return {
      key: options.key,
      tracked: options.tracked,
      state: 'visible',
    };
  }

  if (!options.actual.value) {
    return {
      key: options.key,
      tracked: options.tracked,
      state: 'drifted',
      reason: 'server exists but cannot be normalized to a comparable JSON subtree.',
    };
  }

  return stableCodexMcpValue(options.actual.value) === stableCodexMcpValue(options.expected)
    ? {
        key: options.key,
        tracked: options.tracked,
        state: 'visible',
      }
    : {
        key: options.key,
        tracked: options.tracked,
        state: 'drifted',
        reason: 'current TOML subtree differs from rendered .mcp.json.',
      };
}

export function upsertManagedDeveloperInstructions(
  content: string,
  block: CodexManagedInstructionBlock,
): string {
  const document = parseTomlDocument(content);
  const currentEntry = findTopLevelKeyValue(document, 'developer_instructions');
  const nextValue = upsertManagedInstructionsValue(
    currentEntry?.value.type === 'TOMLValue' && currentEntry.value.kind === 'string'
      ? currentEntry.value.value
      : undefined,
    block,
  );
  const renderedAssignment = renderDeveloperInstructionsAssignment(
    nextValue,
    document.newline,
  );

  if (currentEntry) {
    return applyPatches(document.content, [
      {
        start: currentEntry.range[0],
        end: currentEntry.range[1],
        text: renderedAssignment,
      },
    ]);
  }

  const insertIndex = resolveTopLevelKeyInsertIndex(document);
  return applyPatches(document.content, [
    {
      start: insertIndex,
      end: insertIndex,
      text: buildTopLevelAssignmentInsertText(document, renderedAssignment, insertIndex),
    },
  ]);
}

export function removeManagedDeveloperInstructions(
  content: string,
  pluginName: string,
): string {
  const document = parseTomlDocument(content);
  const currentEntry = findTopLevelKeyValue(document, 'developer_instructions');
  if (
    !currentEntry ||
    currentEntry.value.type !== 'TOMLValue' ||
    currentEntry.value.kind !== 'string'
  ) {
    return ensureTerminalNewline(content);
  }

  const nextValue = removeManagedInstructionsValue(
    currentEntry.value.value,
    pluginName,
  );
  if (nextValue !== undefined) {
    return applyPatches(document.content, [
      {
        start: currentEntry.range[0],
        end: currentEntry.range[1],
        text: renderDeveloperInstructionsAssignment(nextValue, document.newline),
      },
    ]);
  }

  const [start, end] = expandNodeRemovalRange(
    document.content,
    currentEntry.range[0],
    currentEntry.range[1],
  );
  return applyPatches(document.content, [{ start, end, text: '' }]);
}

export async function readCodexConfigFile(
  configPath: string,
): Promise<{ content: string; snapshot: CodexConfigSnapshot }> {
  const content = (await fs.pathExists(configPath))
    ? await fs.readFile(configPath, 'utf8')
    : '';
  return {
    content,
    snapshot: parseCodexConfig(content),
  };
}

export async function readRenderedCodexMcpServersFile(
  mcpPath: string,
): Promise<Record<string, CodexMcpServerConfig>> {
  const content = await fs.readJson(mcpPath) as unknown;
  return parseRenderedCodexMcpFileContent(content, mcpPath);
}

export function applyCodexConfigTransaction(
  content: string,
  transaction: CodexConfigTransaction,
): string {
  let next = content;

  for (const serverName of [...new Set(transaction.removeMcpServers ?? [])]) {
    next = removeCodexMcpServer(next, serverName);
  }

  for (const roleKey of [...new Set(transaction.removeAgentRegistrations ?? [])]) {
    next = removeCodexAgentRegistration(next, roleKey);
  }

  for (const [serverName, serverConfig] of Object.entries(transaction.upsertMcpServers ?? {})) {
    next = upsertCodexMcpServer(next, serverName, serverConfig);
  }

  for (const [roleKey, registration] of Object.entries(transaction.upsertAgentRegistrations ?? {})) {
    next = upsertCodexAgentRegistration(next, roleKey, registration);
  }

  if (transaction.removeManagedInstructionPluginName) {
    next = removeManagedDeveloperInstructions(
      next,
      transaction.removeManagedInstructionPluginName,
    );
  }

  if (transaction.upsertManagedInstructionBlock) {
    next = upsertManagedDeveloperInstructions(
      next,
      transaction.upsertManagedInstructionBlock,
    );
  }

  return next;
}

async function replaceCodexConfigFile(
  configPath: string,
  content: string,
): Promise<void> {
  await atomicReplaceConfigFile({
    filePath: configPath,
    allowedRoot: path.dirname(configPath),
    content,
  });
}

async function updateCodexConfigFile(
  configPath: string,
  update: (content: string) => string,
): Promise<CodexConfigSnapshot> {
  return withConfigFileLock({
    filePath: configPath,
    allowedRoot: path.dirname(configPath),
    action: async () => {
      const current = (await fs.pathExists(configPath))
        ? await fs.readFile(configPath, 'utf8')
        : '';
      const next = update(current);
      await replaceCodexConfigFile(configPath, next);
      return parseCodexConfig(next);
    },
  });
}

export async function applyCodexConfigTransactionFile(
  configPath: string,
  transaction: CodexConfigTransaction,
): Promise<CodexConfigTransactionResult> {
  return withConfigFileLock({
    filePath: configPath,
    allowedRoot: path.dirname(configPath),
    action: async () => {
      const baselineExists = await fs.pathExists(configPath);
      const baselineContent = baselineExists
        ? await fs.readFile(configPath, 'utf8')
        : null;
      const baselineText = baselineContent ?? '';
      const nextContent = applyCodexConfigTransaction(baselineText, transaction);
      const baselineWithTerminalNewline = ensureTerminalNewline(baselineText);
      const wrote = nextContent !== baselineWithTerminalNewline;

      if (wrote) {
        await replaceCodexConfigFile(configPath, nextContent);
      }

      return {
        baselineContent,
        content: nextContent,
        snapshot: parseCodexConfig(nextContent),
        wrote,
      };
    },
  });
}

export async function applyConditionalCodexConfigTransactionFile(
  configPath: string,
  resolveTransaction: (
    snapshot: CodexConfigSnapshot,
    content: string,
  ) => CodexConfigTransaction | null | Promise<CodexConfigTransaction | null>,
): Promise<ConditionalCodexConfigTransactionResult> {
  return withConfigFileLock({
    filePath: configPath,
    allowedRoot: path.dirname(configPath),
    action: async () => {
      const baselineExists = await fs.pathExists(configPath);
      const baselineContent = baselineExists
        ? await fs.readFile(configPath, 'utf8')
        : null;
      const baselineText = baselineContent ?? '';
      const baselineSnapshot = parseCodexConfig(baselineText);
      const transaction = await resolveTransaction(baselineSnapshot, baselineText);
      if (!transaction) {
        return {
          baselineContent,
          content: baselineText,
          snapshot: baselineSnapshot,
          wrote: false,
          applied: false,
        };
      }

      const nextContent = applyCodexConfigTransaction(baselineText, transaction);
      const wrote = nextContent !== ensureTerminalNewline(baselineText);
      if (wrote) await replaceCodexConfigFile(configPath, nextContent);
      return {
        baselineContent,
        content: nextContent,
        snapshot: parseCodexConfig(nextContent),
        wrote,
        applied: true,
      };
    },
  });
}

export async function upsertCodexMarketplaceFile(
  configPath: string,
  name: string,
  config: CodexMarketplaceConfig,
): Promise<CodexConfigSnapshot> {
  return updateCodexConfigFile(configPath, (current) =>
    upsertCodexMarketplace(current, name, config));
}

export async function removeCodexMarketplaceFile(
  configPath: string,
  name: string,
): Promise<CodexConfigSnapshot> {
  return updateCodexConfigFile(configPath, (current) =>
    removeCodexMarketplace(current, name));
}

export async function upsertCodexPluginEnabledFile(
  configPath: string,
  name: string,
  config: CodexPluginEnabledConfig,
): Promise<CodexConfigSnapshot> {
  return updateCodexConfigFile(configPath, (current) =>
    upsertCodexPluginEnabled(current, name, config));
}

export async function removeCodexPluginEnabledFile(
  configPath: string,
  name: string,
): Promise<CodexConfigSnapshot> {
  return updateCodexConfigFile(configPath, (current) =>
    removeCodexPluginEnabled(current, name));
}

export async function upsertManagedDeveloperInstructionsFile(
  configPath: string,
  block: CodexManagedInstructionBlock,
): Promise<CodexConfigSnapshot> {
  return updateCodexConfigFile(configPath, (current) =>
    upsertManagedDeveloperInstructions(current, block));
}

export async function removeManagedDeveloperInstructionsFile(
  configPath: string,
  pluginName: string,
): Promise<CodexConfigSnapshot> {
  return updateCodexConfigFile(configPath, (current) =>
    removeManagedDeveloperInstructions(current, pluginName));
}

export function validateInstructionBodyForCodexConfig(value: string): void {
  rejectSentinelPrefixedLines(value);
}

export function getAwManagedSentinelPrefix(): string {
  return AW_MANAGED_PREFIX;
}
