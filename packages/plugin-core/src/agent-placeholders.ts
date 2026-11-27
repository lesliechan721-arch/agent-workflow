import YAML from 'yaml';

import { nativeComponentName } from './platform-agent-naming.js';
import { isSkillAuthorOnlyPath } from './skill-authoring.js';

export const SKILL_AGENT_PLACEHOLDER_CAPABILITY = 'aw.skill-agent-placeholder.v1';

export interface AgentNamePlaceholder {
  start: number;
  end: number;
  name: string;
  normalizedName: string;
}

const AGENT_REFERENCE_START = /\{\{aw\.agent(?=\b|:)/u;

export function parseAgentNamePlaceholders(text: string): AgentNamePlaceholder[] {
  const references: AgentNamePlaceholder[] = [];
  for (const candidate of text.matchAll(/\{\{aw\.agent(?=\b|:)[^}\r\n]*(?:\}\})?/gu)) {
    const name = /^\{\{aw\.agent:([^\s{}\\/\p{Cc}]+)\}\}$/u.exec(candidate[0])?.[1];
    if (!name) throw new Error('agentReferenceInvalid: expected {{aw.agent:<name>}}.');
    let normalizedName: string;
    try {
      normalizedName = nativeComponentName(name);
    } catch {
      throw new Error('agentReferenceInvalid: invalid Agent name ' + JSON.stringify(name) + '.');
    }
    references.push({ name, normalizedName, start: candidate.index, end: candidate.index + candidate[0].length });
  }
  return references;
}

export function replaceAgentNamePlaceholders(text: string, resolveInvocationName: (normalizedName: string) => string): string {
  let cursor = 0;
  let result = '';
  for (const reference of parseAgentNamePlaceholders(text)) {
    result += text.slice(cursor, reference.start) + resolveInvocationName(reference.normalizedName);
    cursor = reference.end;
  }
  return result + text.slice(cursor);
}

type SourceSpan = readonly [start: number, end: number];

function containsReference(span: SourceSpan, reference: AgentNamePlaceholder): boolean {
  return reference.start >= span[0] && reference.end <= span[1];
}

function yamlCommentSpans(header: string): SourceSpan[] {
  const spans: SourceSpan[] = [];
  // CST offsets distinguish actual comments from '#' inside strings and collections.
  function visit(token: unknown): void {
    if (!token || typeof token !== 'object') return;
    if ('type' in token && token.type === 'comment' && 'offset' in token && typeof token.offset === 'number'
      && 'source' in token && typeof token.source === 'string') {
      spans.push([token.offset, token.offset + token.source.length]);
      return;
    }
    for (const child of Object.values(token)) visit(child);
  }
  for (const token of new YAML.Parser().parse(header)) visit(token);
  return spans;
}

export function assertSkillAgentReferencesInFrontmatter(text: string): void {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1];
  // YAML double-quoted escapes can spell a reference without literal braces.
  if (!header || (!AGENT_REFERENCE_START.test(header) && !header.includes('\\'))) return;
  // An unquoted placeholder is a YAML collection. Inspect its original spelling
  // before the general frontmatter validator reports an unrelated name error.
  const document = YAML.parseDocument(header);
  if (!YAML.isMap(document.contents)) return;
  const node = document.get('name', true);
  const range = YAML.isNode(node) ? node.range : undefined;
  const value = YAML.isAlias(node) ? node.resolve(document) : node;
  if ((range && AGENT_REFERENCE_START.test(header.slice(range[0], range[1])))
    || (YAML.isScalar(value) && typeof value.value === 'string' && AGENT_REFERENCE_START.test(value.value))) {
    throw new Error('agentReferenceInvalid: the SKILL.md frontmatter name cannot reference an Agent.');
  }
  // Projection can serialize YAML again. Every decoded reference must also be present
  // literally in the original scalar, where the normal requirement scan and binding can see it.
  const quotedSpans: SourceSpan[] = [];
  YAML.visit(document, { Scalar(_, scalar) {
    if (typeof scalar.value !== 'string') return;
    const quoted = scalar.type === YAML.Scalar.QUOTE_DOUBLE || scalar.type === YAML.Scalar.QUOTE_SINGLE;
    if (quoted && scalar.range) quotedSpans.push([scalar.range[0], scalar.range[1]]);
    if (!AGENT_REFERENCE_START.test(scalar.value)) return;
    if (!quoted) {
      throw new Error('agentReferenceInvalid: quote frontmatter strings containing an Agent reference.');
    }
    const decoded = parseAgentNamePlaceholders(scalar.value).map(({ name }) => name);
    const raw = scalar.range ? header.slice(scalar.range[0], scalar.range[1]) : '';
    const literal = parseAgentNamePlaceholders(raw).map(({ name }) => name);
    if (decoded.length !== literal.length || decoded.some((name, index) => name !== literal[index])) {
      throw new Error('agentReferenceInvalid: frontmatter Agent references must be written literally.');
    }
  } });
  // Unquoted braces may parse as a YAML collection rather than a string. Only
  // actual comments may carry a reference outside a quoted string's source span.
  const outsideStrings = parseAgentNamePlaceholders(header).filter((reference) =>
    !quotedSpans.some((span) => containsReference(span, reference)));
  if (outsideStrings.length) {
    const comments = yamlCommentSpans(header);
    if (outsideStrings.some((reference) => !comments.some((span) => containsReference(span, reference)))) {
      throw new Error('agentReferenceInvalid: quote frontmatter strings containing an Agent reference.');
    }
  }
}

export function isSkillAgentReferenceMarkdown(file: string): boolean {
  return file.endsWith('.md') && !isSkillAuthorOnlyPath(file);
}

export function scanSkillAgentReferences(file: string, text: string): AgentNamePlaceholder[] {
  if (!isSkillAgentReferenceMarkdown(file)) return [];
  if (file === 'SKILL.md') assertSkillAgentReferencesInFrontmatter(text);
  return parseAgentNamePlaceholders(text);
}
