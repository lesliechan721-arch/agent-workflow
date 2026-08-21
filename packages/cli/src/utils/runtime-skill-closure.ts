import path from 'node:path';

import fs from 'fs-extra';

import type { PlatformName } from '../types.js';
import { calculateFileDigest } from './bundle-integrity.js';

const CORE_RESOURCE_ROOT_PATTERN = /^(?:\.\/)?(?:references|assets|scripts|agents|evals|providers)(?:[\\/]|$)/u;
const ABSOLUTE_CORE_RESOURCE_PATTERN = /^\/(?:references|assets|scripts|agents|evals|providers)(?:\/|$)/u;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:/u;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const ASCII_PUNCTUATION_PATTERN = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/u;
const LINE_MARKER_PATTERN = /:\d+(?::\d+)?$/u;

type RuntimeSkillReferenceSource = 'markdown-link' | 'inline-command';

interface RuntimeSkillReference {
  lexicalTarget: string;
  source: RuntimeSkillReferenceSource;
  commandPathTarget?: string;
  explicitLocalExecution?: boolean;
}

export interface SkillRuntimeProjectionEvidence {
  platform: PlatformName;
  skill: string;
  target: string;
  sourceDigest: string;
  targetDigest: string;
}

function formatReference(
  skillKey: string,
  source: RuntimeSkillReferenceSource | 'projection',
  lexicalTarget: string,
): string {
  const sourceLabel = source === 'projection' ? 'projection' : source;
  return `skill ${JSON.stringify(skillKey)} ${sourceLabel} target ${JSON.stringify(lexicalTarget)}`;
}

interface MarkdownDestination {
  lexicalTarget: string;
  end: number;
}

interface MarkdownScanResult {
  proseForLinks: string;
  commandSnippets: string[];
}

interface MarkdownLine {
  body: string;
  ending: string;
}

function isEscaped(content: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

const COMMAND_FENCE_LANGUAGES = new Set([
  '',
  'sh',
  'bash',
  'zsh',
  'shell',
  'powershell',
  'pwsh',
  'ps1',
  'cmd',
]);

function parseFence(line: string): {
  marker: '`' | '~';
  length: number;
  capturesCommands: boolean;
} | undefined {
  let cursor = 0;
  while (cursor < line.length && cursor < 4 && line[cursor] === ' ') cursor += 1;
  if (cursor > 3) return undefined;
  const marker = line[cursor];
  if (marker !== '`' && marker !== '~') return undefined;
  let end = cursor;
  while (line[end] === marker) end += 1;
  if (end - cursor < 3) return undefined;
  if (marker === '`' && line.slice(end).includes('`')) return undefined;
  const info = line.slice(end).trim();
  const language = info.split(/\s+/u, 1)[0]?.toLowerCase() ?? '';
  return {
    marker,
    length: end - cursor,
    capturesCommands: COMMAND_FENCE_LANGUAGES.has(language),
  };
}

function isClosingFence(
  line: string,
  fence: { marker: '`' | '~'; length: number },
): boolean {
  let cursor = 0;
  while (cursor < line.length && cursor < 4 && line[cursor] === ' ') cursor += 1;
  if (cursor > 3 || line[cursor] !== fence.marker) return false;
  let end = cursor;
  while (line[end] === fence.marker) end += 1;
  return end - cursor >= fence.length && line.slice(end).trim() === '';
}

function splitMarkdownLines(content: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const lineEnd = content.indexOf('\n', cursor);
    const end = lineEnd < 0 ? content.length : lineEnd;
    lines.push({
      body: content.slice(cursor, end),
      ending: lineEnd < 0 ? '' : '\n',
    });
    cursor = lineEnd < 0 ? content.length : lineEnd + 1;
  }
  return lines;
}

function maskMarkdownCode(content: string): string {
  return content.replace(/[^\n]/gu, ' ');
}

function isBlankMarkdownLine(line: string): boolean {
  return line.trim() === '';
}

function isIndentedCodeLine(line: string): boolean {
  return line.startsWith('\t') || line.startsWith('    ');
}

function stripIndentedCodePrefix(line: string): string {
  return line.startsWith('\t') ? line.slice(1) : line.slice(4);
}

function hasIndentedCodeContinuation(lines: readonly MarkdownLine[], start: number): boolean {
  let cursor = start;
  while (cursor < lines.length && isBlankMarkdownLine(lines[cursor]!.body)) cursor += 1;
  return cursor < lines.length && isIndentedCodeLine(lines[cursor]!.body);
}

function findClosingCodeSpan(content: string, start: number, markerLength: number): number {
  let cursor = start;
  while (cursor < content.length) {
    const opening = content.indexOf('`', cursor);
    if (opening < 0) return -1;
    if (isEscaped(content, opening)) {
      cursor = opening + 1;
      continue;
    }
    let length = 1;
    while (content[opening + length] === '`') length += 1;
    if (length === markerLength) return opening;
    cursor = opening + length;
  }
  return -1;
}

function partitionInlineCode(
  content: string,
  commandSnippets: string[],
): string {
  let proseForLinks = '';
  let cursor = 0;
  while (cursor < content.length) {
    let opening = content.indexOf('`', cursor);
    while (opening >= 0 && isEscaped(content, opening)) {
      opening = content.indexOf('`', opening + 1);
    }
    if (opening < 0) {
      proseForLinks += content.slice(cursor);
      break;
    }
    let markerLength = 1;
    while (content[opening + markerLength] === '`') markerLength += 1;
    const closing = findClosingCodeSpan(
      content,
      opening + markerLength,
      markerLength,
    );
    if (closing < 0) {
      proseForLinks += content.slice(cursor);
      break;
    }
    proseForLinks += content.slice(cursor, opening);
    const end = closing + markerLength;
    commandSnippets.push(content.slice(opening + markerLength, closing));
    proseForLinks += maskMarkdownCode(content.slice(opening, end));
    cursor = end;
  }
  return proseForLinks;
}

function scanMarkdown(content: string): MarkdownScanResult {
  const lines = splitMarkdownLines(content);
  const commandSnippets: string[] = [];
  let proseWithoutInlineCode = '';
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex]!;
    const fence = parseFence(line.body);
    if (fence) {
      proseWithoutInlineCode += maskMarkdownCode(line.body) + line.ending;
      lineIndex += 1;
      let commandSnippet = '';
      while (lineIndex < lines.length) {
        const fencedLine = lines[lineIndex]!;
        proseWithoutInlineCode += maskMarkdownCode(fencedLine.body) + fencedLine.ending;
        lineIndex += 1;
        if (isClosingFence(fencedLine.body, fence)) break;
        if (fence.capturesCommands) {
          commandSnippet += fencedLine.body + fencedLine.ending;
        }
      }
      if (fence.capturesCommands && commandSnippet !== '') {
        commandSnippets.push(commandSnippet);
      }
      continue;
    }

    if (!isBlankMarkdownLine(line.body) && isIndentedCodeLine(line.body)) {
      let commandSnippet = '';
      while (lineIndex < lines.length) {
        const indentedLine = lines[lineIndex]!;
        if (isBlankMarkdownLine(indentedLine.body)) {
          if (!hasIndentedCodeContinuation(lines, lineIndex + 1)) break;
          proseWithoutInlineCode += maskMarkdownCode(indentedLine.body) + indentedLine.ending;
          commandSnippet += indentedLine.ending;
          lineIndex += 1;
          continue;
        }
        if (!isIndentedCodeLine(indentedLine.body)) break;
        proseWithoutInlineCode += maskMarkdownCode(indentedLine.body) + indentedLine.ending;
        commandSnippet += stripIndentedCodePrefix(indentedLine.body) + indentedLine.ending;
        lineIndex += 1;
      }
      if (commandSnippet !== '') commandSnippets.push(commandSnippet);
      continue;
    }

    proseWithoutInlineCode += line.body + line.ending;
    lineIndex += 1;
  }

  return {
    proseForLinks: partitionInlineCode(proseWithoutInlineCode, commandSnippets),
    commandSnippets,
  };
}

function findClosingBracket(content: string, opening: number): number {
  let depth = 0;
  for (let cursor = opening + 1; cursor < content.length; cursor += 1) {
    const character = content[cursor];
    if (character === '\n') return -1;
    if (character === '\\') {
      cursor += 1;
      continue;
    }
    if (character === '[') depth += 1;
    if (character === ']' && depth === 0) return cursor;
    if (character === ']') depth -= 1;
  }
  return -1;
}

function skipMarkdownWhitespace(content: string, start: number): number {
  let cursor = start;
  while (content[cursor] === ' ' || content[cursor] === '\t') cursor += 1;
  return cursor;
}

function findDefinitionDestinationStart(content: string, start: number): number | undefined {
  let cursor = skipMarkdownWhitespace(content, start);
  if (content[cursor] === '\r' && content[cursor + 1] === '\n') cursor += 1;
  if (content[cursor] !== '\n') return cursor;
  cursor += 1;
  let indentation = 0;
  while (content[cursor] === ' ' && indentation < 4) {
    cursor += 1;
    indentation += 1;
  }
  if (indentation > 3 || content[cursor] === '\t') return undefined;
  return cursor;
}

function findInlineDestinationEnd(content: string, start: number): number {
  let cursor = skipMarkdownWhitespace(content, start);
  if (content[cursor] === ')') return cursor + 1;
  const opening = content[cursor];
  const closing = opening === '(' ? ')' : opening;
  if (opening !== '"' && opening !== "'" && opening !== '(') return -1;
  cursor += 1;
  let depth = 0;
  for (; cursor < content.length && content[cursor] !== '\n'; cursor += 1) {
    if (content[cursor] === '\\') {
      cursor += 1;
      continue;
    }
    if (opening === '(' && content[cursor] === '(') depth += 1;
    if (content[cursor] === closing) {
      if (opening === '(' && depth > 0) {
        depth -= 1;
        continue;
      }
      cursor = skipMarkdownWhitespace(content, cursor + 1);
      return content[cursor] === ')' ? cursor + 1 : -1;
    }
  }
  return -1;
}

function parseMarkdownDestination(
  content: string,
  start: number,
  mode: 'inline' | 'definition',
): MarkdownDestination | undefined {
  let cursor = skipMarkdownWhitespace(content, start);
  if (content[cursor] === '<') {
    const destinationStart = cursor + 1;
    cursor += 1;
    while (cursor < content.length && content[cursor] !== '\n') {
      if (content[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (content[cursor] === '>') {
        const lexicalTarget = content.slice(destinationStart, cursor);
        if (mode === 'definition') return { lexicalTarget, end: cursor + 1 };
        const end = findInlineDestinationEnd(content, cursor + 1);
        return end < 0 ? undefined : { lexicalTarget, end };
      }
      cursor += 1;
    }
    return undefined;
  }

  const destinationStart = cursor;
  let depth = 0;
  while (cursor < content.length && content[cursor] !== '\n') {
    const character = content[cursor];
    if (character === '\\') {
      cursor += 2;
      continue;
    }
    if (character === '(') {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (character === ')') {
      if (depth > 0) {
        depth -= 1;
        cursor += 1;
        continue;
      }
      if (mode === 'inline') {
        return {
          lexicalTarget: content.slice(destinationStart, cursor),
          end: cursor + 1,
        };
      }
      break;
    }
    if (character === ' ' || character === '\t') break;
    cursor += 1;
  }
  if (cursor === destinationStart || depth !== 0) return undefined;
  const lexicalTarget = content.slice(destinationStart, cursor);
  if (mode === 'definition') return { lexicalTarget, end: cursor };
  const end = findInlineDestinationEnd(content, cursor);
  return end < 0 ? undefined : { lexicalTarget, end };
}

function extractDefinitionReferences(content: string): RuntimeSkillReference[] {
  const references: RuntimeSkillReference[] = [];
  let lineStart = 0;
  while (lineStart < content.length) {
    const lineEnd = content.indexOf('\n', lineStart);
    const end = lineEnd < 0 ? content.length : lineEnd;
    let cursor = lineStart;
    while (cursor < end && cursor - lineStart < 4 && content[cursor] === ' ') cursor += 1;
    if (cursor - lineStart <= 3 && content[cursor] === '[' && !isEscaped(content, cursor)) {
      const closingBracket = findClosingBracket(content, cursor);
      if (closingBracket >= 0 && content[closingBracket + 1] === ':') {
        const destinationStart = findDefinitionDestinationStart(content, closingBracket + 2);
        const destination = destinationStart === undefined
          ? undefined
          : parseMarkdownDestination(content, destinationStart, 'definition');
        if (destination) {
          references.push({
            lexicalTarget: destination.lexicalTarget,
            source: 'markdown-link',
          });
        }
      }
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
  return references;
}

function extractMarkdownReferences(content: string): RuntimeSkillReference[] {
  const references = extractDefinitionReferences(content);
  let cursor = 0;
  while (cursor < content.length) {
    if (content[cursor] !== '[' || isEscaped(content, cursor)) {
      cursor += 1;
      continue;
    }
    const closingBracket = findClosingBracket(content, cursor);
    if (closingBracket < 0 || content[closingBracket + 1] !== '(') {
      cursor += 1;
      continue;
    }
    const destination = parseMarkdownDestination(content, closingBracket + 2, 'inline');
    if (!destination) {
      cursor = closingBracket + 1;
      continue;
    }
    references.push({
      lexicalTarget: destination.lexicalTarget,
      source: 'markdown-link',
    });
    cursor = destination.end;
  }
  return references;
}

function stripCommandTokenPunctuation(token: string): string {
  return token
    .replace(/^[('"[{,;]+/u, '')
    .replace(/[)'"\]},;]+$/u, '');
}

function stripShellRedirectionPrefix(token: string): string {
  return token.replace(/^\d*(?:<<<|<<|<>|>>|>&|<&|>|<)/u, '');
}

interface CommandTokenCandidate {
  lexicalTarget: string;
  pathTarget: string;
}

function extractCommandTokenCandidates(content: string): CommandTokenCandidate[] {
  const candidates: CommandTokenCandidate[] = [];
  for (const rawToken of content.split(/\s+/u)) {
    if (!rawToken) continue;
    const token = stripCommandTokenPunctuation(rawToken);
    if (token) candidates.push({
      lexicalTarget: token,
      pathTarget: stripShellRedirectionPrefix(token),
    });
    const assignmentIndex = token.indexOf('=');
    if (assignmentIndex >= 0 && assignmentIndex < token.length - 1) {
      const assignmentTarget = stripCommandTokenPunctuation(token.slice(assignmentIndex + 1));
      candidates.push({
        lexicalTarget: assignmentTarget,
        pathTarget: stripShellRedirectionPrefix(assignmentTarget),
      });
    }
  }
  return candidates;
}

const LOCAL_EXECUTION_INTERPRETERS = new Set([
  'node',
  'python',
  'python3',
  'sh',
  'bash',
  'deno',
  'bun',
  'powershell',
  'pwsh',
  'cmd',
]);

const WINDOWS_DRIVE_RELATIVE_PATH_PATTERN = /^[A-Za-z]:[^\\/]/u;

function normalizedWindowsLocalExecutionTarget(target: string): string | undefined {
  if (!target.startsWith('.\\')) return undefined;
  return `./${target.slice(2).replaceAll('\\', '/')}`;
}

function explicitLocalExecutionTargets(commandSnippet: string): Map<string, string> {
  const targets = new Map<string, string>();
  for (const segment of commandSnippet.split(/(?:\r?\n|&&|\|\||[;|])/u)) {
    const normalizedSegment = segment.replace(/^\s*\$\s+/u, '');
    const candidates = extractCommandTokenCandidates(normalizedSegment);
    const executionTokens = normalizedSegment
      .split(/\s+/u)
      .map(stripCommandTokenPunctuation)
      .filter(Boolean);
    let executableIndex = 0;
    while (
      executableIndex < executionTokens.length
      && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(executionTokens[executableIndex]!)
    ) {
      executableIndex += 1;
    }
    const executableToken = executionTokens[executableIndex];
    const executable = executableToken === undefined
      ? undefined
      : stripShellRedirectionPrefix(executableToken);
    if (!executable) continue;
    if (LOCAL_EXECUTION_INTERPRETERS.has(executable)) {
      for (const candidate of candidates) {
        if (candidate.pathTarget.startsWith('./')) {
          targets.set(candidate.lexicalTarget, candidate.pathTarget);
        }
      }
      for (const argument of executionTokens.slice(executableIndex + 1)) {
        if (WINDOWS_DRIVE_RELATIVE_PATH_PATTERN.test(argument)) {
          targets.set(argument, argument);
        }
      }
      if (executable === 'powershell' || executable === 'pwsh') {
        for (const argument of executionTokens.slice(executableIndex + 1)) {
          const normalized = normalizedWindowsLocalExecutionTarget(argument);
          if (normalized) targets.set(argument, normalized);
        }
      }
      if (executable === 'cmd') {
        const commandSwitchIndex = executionTokens.findIndex(
          (token, index) => index > executableIndex && token.toLowerCase() === '/c',
        );
        const commandTarget = commandSwitchIndex < 0
          ? undefined
          : executionTokens[commandSwitchIndex + 1];
        if (commandTarget) {
          const normalized = normalizedWindowsLocalExecutionTarget(commandTarget);
          if (normalized) targets.set(commandTarget, normalized);
        }
      }
      continue;
    }
    if (
      executable.startsWith('./')
      && (
        executionTokens.length > executableIndex + 1
        || commandSnippet.includes('\n')
        || !executable.endsWith('.json')
      )
    ) {
      targets.set(executableToken, executable);
    }
  }
  return targets;
}

function extractCommandReferences(commandSnippets: readonly string[]): RuntimeSkillReference[] {
  const references: RuntimeSkillReference[] = [];
  for (const commandSnippet of commandSnippets) {
    const executionTargets = explicitLocalExecutionTargets(commandSnippet);
    for (const candidate of extractCommandTokenCandidates(commandSnippet)) {
      const explicitExecutionTarget = executionTargets.get(candidate.lexicalTarget);
      references.push({
        lexicalTarget: candidate.lexicalTarget,
        source: 'inline-command',
        commandPathTarget: explicitExecutionTarget ?? candidate.pathTarget,
        explicitLocalExecution: explicitExecutionTarget !== undefined,
      });
    }
  }
  return references;
}

function isExcludedReference(reference: RuntimeSkillReference): boolean {
  const target = reference.commandPathTarget ?? reference.lexicalTarget;
  return (
    target === ''
    || target.startsWith('#')
    || target.includes('$')
    || (
      reference.source === 'inline-command'
      && /^%[^%\s]+%(?:[\\/][^\s]*)?$/u.test(target)
    )
    || target.includes('{')
    || target.includes('}')
    || target.includes('<')
    || target.includes('>')
    || target.includes('*')
    || target.includes('[')
    || target.includes(']')
  );
}

function stripReferenceSuffix(target: string): { pathTarget: string; hasQuestionGlob: boolean } {
  const fragmentIndex = target.indexOf('#');
  let pathTarget = fragmentIndex >= 0 ? target.slice(0, fragmentIndex) : target;
  const queryIndex = pathTarget.indexOf('?');
  if (queryIndex >= 0) {
    const query = pathTarget.slice(queryIndex + 1);
    const targetBeforeQuery = pathTarget.slice(0, queryIndex);
    const basenameBeforeQuery = path.posix.basename(targetBeforeQuery);
    if (
      !query.includes('=')
      && !query.includes('&')
      && !basenameBeforeQuery.includes('.')
    ) {
      return { pathTarget, hasQuestionGlob: true };
    }
    pathTarget = targetBeforeQuery;
  }
  return {
    pathTarget,
    hasQuestionGlob: false,
  };
}

function normalizeMarkdownDestination(
  skillKey: string,
  reference: RuntimeSkillReference,
): string {
  const referenceLabel = formatReference(skillKey, reference.source, reference.lexicalTarget);
  let normalized = '';
  for (let cursor = 0; cursor < reference.lexicalTarget.length; cursor += 1) {
    const character = reference.lexicalTarget[cursor];
    if (character !== '\\') {
      normalized += character;
      continue;
    }
    const escaped = reference.lexicalTarget[cursor + 1];
    if (!escaped || !ASCII_PUNCTUATION_PATTERN.test(escaped)) {
      throw new Error(`Invalid runtime Skill closure: ${referenceLabel} contains an invalid Markdown escape.`);
    }
    if (escaped === '?' || escaped === '#' || escaped === '%') {
      normalized += `%${escaped.charCodeAt(0).toString(16).toUpperCase()}`;
    } else {
      normalized += escaped;
    }
    cursor += 1;
  }
  return normalized;
}

function decodeMarkdownPath(
  skillKey: string,
  reference: RuntimeSkillReference,
  pathTarget: string,
): string {
  const referenceLabel = formatReference(skillKey, reference.source, reference.lexicalTarget);
  for (let cursor = 0; cursor < pathTarget.length; cursor += 1) {
    if (pathTarget[cursor] !== '%') continue;
    if (!/^[0-9A-Fa-f]{2}$/u.test(pathTarget.slice(cursor + 1, cursor + 3))) {
      throw new Error(`Invalid runtime Skill closure: ${referenceLabel} contains an invalid percent escape.`);
    }
    cursor += 2;
  }
  try {
    return decodeURIComponent(pathTarget);
  } catch {
    throw new Error(`Invalid runtime Skill closure: ${referenceLabel} contains an invalid percent escape.`);
  }
}

function hasParentTraversal(target: string): boolean {
  return target.replaceAll('\\', '/').split('/').includes('..');
}

function isExternalMarkdownTarget(target: string): boolean {
  return target.startsWith('//') || (
    !WINDOWS_DRIVE_PATH_PATTERN.test(target)
    && URI_SCHEME_PATTERN.test(target)
  );
}

function isLexicallyLocalReference(
  reference: RuntimeSkillReference,
  pathTarget: string,
): boolean {
  if (reference.source === 'markdown-link') {
    return true;
  }
  return (
    pathTarget.startsWith('../')
    || pathTarget.startsWith('..\\')
    || hasParentTraversal(pathTarget)
    || ABSOLUTE_CORE_RESOURCE_PATTERN.test(pathTarget)
    || CORE_RESOURCE_ROOT_PATTERN.test(pathTarget)
  );
}

function normalizeLocalTarget(
  skillKey: string,
  source: RuntimeSkillReferenceSource | 'projection',
  lexicalTarget: string,
  pathTarget: string,
): string {
  const referenceLabel = formatReference(skillKey, source, lexicalTarget);
  if (pathTarget.includes('\\')) {
    throw new Error(`Invalid runtime Skill closure: ${referenceLabel} must use POSIX separators.`);
  }
  if (path.posix.isAbsolute(pathTarget) || WINDOWS_DRIVE_PATH_PATTERN.test(pathTarget)) {
    throw new Error(`Invalid runtime Skill closure: ${referenceLabel} must be relative.`);
  }
  const relativeTarget = pathTarget.startsWith('./') ? pathTarget.slice(2) : pathTarget;
  if (
    relativeTarget === ''
    || relativeTarget === '..'
    || relativeTarget.startsWith('../')
    || relativeTarget.split('/').includes('..')
    || path.posix.normalize(relativeTarget) !== relativeTarget
  ) {
    throw new Error(`Invalid runtime Skill closure: ${referenceLabel} is not a normalized Skill-local path.`);
  }
  return relativeTarget;
}

async function pathExistsWithoutFollowingSymlinks(
  skillRoot: string,
  relativeTarget: string,
): Promise<boolean> {
  let current = skillRoot;
  for (const segment of relativeTarget.split('/')) {
    current = path.join(current, segment);
    let stats: fs.Stats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (stats.isSymbolicLink()) return true;
  }
  return true;
}

async function shouldValidateReference(
  skillRoot: string,
  reference: RuntimeSkillReference,
  pathTarget: string,
): Promise<boolean> {
  if (isLexicallyLocalReference(reference, pathTarget)) return true;
  if (reference.source !== 'inline-command') return false;
  if (pathTarget === './eval-runtime-capabilities.json') return false;
  if (reference.explicitLocalExecution) return true;
  if (!pathTarget.startsWith('./')) return false;
  if (pathTarget.includes('\\')) return true;
  const relativeTarget = pathTarget.slice(2);
  if (relativeTarget === '' || relativeTarget.split('/').includes('..')) return true;
  return pathExistsWithoutFollowingSymlinks(skillRoot, relativeTarget);
}

async function assertRegularSkillLocalFile(options: {
  skillRoot: string;
  skillKey: string;
  source: RuntimeSkillReferenceSource | 'projection';
  lexicalTarget: string;
  relativeTarget: string;
}): Promise<void> {
  const referenceLabel = formatReference(
    options.skillKey,
    options.source,
    options.lexicalTarget,
  );
  let current = options.skillRoot;
  const segments = options.relativeTarget.split('/');
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stats: fs.Stats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new Error(`Invalid runtime Skill closure: ${referenceLabel} is missing.`);
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Invalid runtime Skill closure: ${referenceLabel} contains a symbolic link.`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error(`Invalid runtime Skill closure: ${referenceLabel} has a non-directory parent.`);
    }
    if (index === segments.length - 1 && !stats.isFile()) {
      throw new Error(`Invalid runtime Skill closure: ${referenceLabel} is not a regular file.`);
    }
  }

  const [realSkillRoot, realTarget] = await Promise.all([
    fs.realpath(options.skillRoot),
    fs.realpath(current),
  ]);
  const relativeToRoot = path.relative(realSkillRoot, realTarget);
  if (
    relativeToRoot === '..'
    || relativeToRoot.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToRoot)
  ) {
    throw new Error(`Invalid runtime Skill closure: ${referenceLabel} resolves outside the Skill root.`);
  }
}

export async function validateRuntimeSkillClosure(skillRoot: string): Promise<void> {
  const skillRootStats = await fs.lstat(skillRoot).catch(() => undefined);
  if (!skillRootStats?.isDirectory() || skillRootStats.isSymbolicLink()) {
    throw new Error(`Invalid runtime Skill closure: skill ${JSON.stringify(path.basename(skillRoot))} root must be a regular directory.`);
  }
  const skillKey = path.basename(skillRoot);
  const skillMarkdownPath = path.join(skillRoot, 'SKILL.md');
  const skillMarkdownStats = await fs.lstat(skillMarkdownPath).catch(() => undefined);
  if (!skillMarkdownStats?.isFile() || skillMarkdownStats.isSymbolicLink()) {
    throw new Error(`Invalid runtime Skill closure: skill ${JSON.stringify(skillKey)} is missing a regular SKILL.md.`);
  }
  const content = await fs.readFile(skillMarkdownPath, 'utf8');
  const scan = scanMarkdown(content);
  const references = [
    ...extractMarkdownReferences(scan.proseForLinks),
    ...extractCommandReferences(scan.commandSnippets),
  ];
  const seen = new Set<string>();
  for (const reference of references) {
    const dedupeKey = `${reference.source}\0${reference.lexicalTarget}\0${reference.explicitLocalExecution === true}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (isExcludedReference(reference)) continue;
    const normalizedTarget = reference.source === 'markdown-link'
      ? normalizeMarkdownDestination(skillKey, reference)
      : reference.commandPathTarget ?? reference.lexicalTarget;
    let { pathTarget, hasQuestionGlob } = stripReferenceSuffix(normalizedTarget);
    if (hasQuestionGlob) continue;
    if (reference.source === 'markdown-link') {
      pathTarget = decodeMarkdownPath(skillKey, reference, pathTarget);
      if (isExternalMarkdownTarget(pathTarget)) continue;
    }
    if (!WINDOWS_DRIVE_PATH_PATTERN.test(pathTarget)) {
      pathTarget = pathTarget.replace(LINE_MARKER_PATTERN, '');
    }
    if (!(await shouldValidateReference(skillRoot, reference, pathTarget))) continue;
    const relativeTarget = normalizeLocalTarget(
      skillKey,
      reference.source,
      reference.lexicalTarget,
      pathTarget,
    );
    await assertRegularSkillLocalFile({
      skillRoot,
      skillKey,
      source: reference.source,
      lexicalTarget: reference.lexicalTarget,
      relativeTarget,
    });
  }
}

export async function validateRuntimeSkillClosuresRoot(skillsRoot: string): Promise<void> {
  const rootStats = await fs.lstat(skillsRoot).catch(() => undefined);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Invalid runtime Skill closure: skills root must be a regular directory.');
  }
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Invalid runtime Skill closure: skill ${JSON.stringify(entry.name)} root contains a symbolic link.`);
    }
    if (!entry.isDirectory()) continue;
    await validateRuntimeSkillClosure(path.join(skillsRoot, entry.name));
  }
}

export async function validateSkillRuntimeProjectionFreshness(
  outputRoot: string,
  provenance: readonly SkillRuntimeProjectionEvidence[],
): Promise<void> {
  for (const entry of provenance) {
    const skillRoot = path.join(outputRoot, entry.platform, 'skills', entry.skill);
    const relativeTarget = normalizeLocalTarget(
      entry.skill,
      'projection',
      entry.target,
      entry.target,
    );
    await assertRegularSkillLocalFile({
      skillRoot,
      skillKey: entry.skill,
      source: 'projection',
      lexicalTarget: entry.target,
      relativeTarget,
    });
    if (entry.sourceDigest !== entry.targetDigest) {
      throw new Error(
        `Invalid runtime Skill closure: ${formatReference(entry.skill, 'projection', entry.target)} has inconsistent recorded digests.`,
      );
    }
    const finalDigest = await calculateFileDigest(path.join(skillRoot, ...relativeTarget.split('/')));
    if (finalDigest !== entry.targetDigest) {
      throw new Error(
        `Invalid runtime Skill closure: ${formatReference(entry.skill, 'projection', entry.target)} changed after projection.`,
      );
    }
  }
}
