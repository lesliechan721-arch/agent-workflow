import { createHash } from 'node:crypto';
import path from 'node:path';
import { diagnostic, enumerateTree, inside, isMain, parseArgs, printReport, readText, requestedFormat, resolveRoot, SCAN_LIMITS, scanState, slash } from './common.mjs';
import { markdownReferences, resolveReference } from './references.mjs';

export { SCAN_LIMITS };
export const TEXT_EXTENSIONS = Object.freeze(['.md', '.mdx', '.json', '.yaml', '.yml', '.toml', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.py', '.sh', '.bash', '.zsh']);
const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const HELP = '用法：node audit-output-contracts.mjs <source-root> [--materialized-root <directory>] [--format text|json]\n仅报告名称候选和引用线索；不评估业务用途或删除资格。\n';

function candidateKind(relative) {
  const name = path.basename(relative).toLowerCase();
  if (/(?:^|[.-])schema(?:[.-]|$)/.test(name)) return 'schema';
  if (name.includes('template')) return name.endsWith('.md') ? 'human-template' : 'template';
  if (/(?:^|[.-])(?:validate|validator)(?:[.-]|$)/.test(name)) return 'validator';
  return null;
}

// A bounded lexical reader, not a language or business-use analyzer. Comments
// remain reference candidates; only syntactic import tokens gain a known base.
function codeLiterals(content) {
  const tokens = [];
  const literals = [];
  let offset = 0;
  let comment = false;
  while (offset < content.length) {
    const start = offset;
    const character = content[offset];
    if (/\s/.test(character)) { offset += 1; continue; }
    if (content.startsWith('//', offset) || content.startsWith('/*', offset)) {
      const block = content.startsWith('/*', offset);
      const end = content.indexOf(block ? '*/' : '\n', offset + 2);
      const finish = end < 0 ? content.length : end + (block ? 2 : 0);
      for (const match of content.slice(offset, finish).matchAll(/["'`]([^"'`\n]+)["'`]/g))
        literals.push({ value: match[1], offset: offset + match.index, comment: true });
      offset = finish;
      continue;
    }
    if ('"\'`'.includes(character)) {
      offset += 1;
      let raw = '';
      while (offset < content.length && content[offset] !== character) {
        if (content[offset] === '\\' && offset + 1 < content.length) { raw += content.slice(offset, offset + 2); offset += 2; }
        else raw += content[offset++];
      }
      if (offset < content.length) offset += 1;
      const item = { type: 'string', value: raw, offset: start, dynamic: character === '`' && raw.includes('${'), escaped: raw.includes('\\'), comment };
      tokens.push(item); literals.push(item);
      continue;
    }
    const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(content.slice(offset));
    if (identifier) { tokens.push({ type: 'identifier', value: identifier[0], offset: start }); offset += identifier[0].length; }
    else { tokens.push({ type: 'punctuation', value: character, offset: start }); offset += 1; }
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'string' || token.dynamic || token.escaped) continue;
    const previous = tokens[index - 1];
    if (previous?.value === 'import' && tokens[index - 2]?.value !== '.') token.import = true;
    else if (previous?.value === '(' && ['import', 'require'].includes(tokens[index - 2]?.value) && tokens[index - 3]?.value !== '.' && tokens[index + 1]?.value === ')') token.import = true;
    else if (previous?.value === 'from') {
      // Inspect only this statement, never a preceding statement or a string.
      let cursor = index - 2;
      while (cursor >= 0 && ![';', 'import', 'export'].includes(tokens[cursor].value) && token.offset - tokens[cursor].offset < 4096) cursor -= 1;
      if (cursor >= 0 && ['import', 'export'].includes(tokens[cursor].value) && tokens[cursor - 1]?.value !== '.') token.import = true;
    }
    token.read = ['readFile', 'readFileSync', 'open'].includes(tokens[index - 2]?.value) && previous?.value === '(';
  }
  return literals;
}

function referencesIn(file) {
  const refs = [];
  if (/\.mdx?$/i.test(file.relative)) {
    for (const ref of markdownReferences(file.content)) refs.push({ value: ref.value, line: ref.line, markdown: true });
  }
  if (CODE_EXTENSIONS.has(path.extname(file.relative))) {
    for (const ref of codeLiterals(file.content)) refs.push({ ...ref, line: file.content.slice(0, ref.offset).split('\n').length });
  } else {
    for (const match of file.content.matchAll(/["'`]([^"'`\n]+)["'`]/g)) refs.push({ value: match[1], line: file.content.slice(0, match.index).split('\n').length });
  }
  return refs;
}

function resolutionFor(file, ref) {
  if (ref.dynamic || /\$|[{}*?<>]/.test(ref.value)) return { status: 'unresolved' };
  if (path.isAbsolute(ref.value) || /^[A-Za-z]:[\\/]|^[a-z][a-z0-9+.-]*:/i.test(ref.value)) return { status: 'external' };
  if (ref.markdown) {
    const resolved = resolveReference(file.root, file.relative, ref.value);
    if (resolved.status === 'local') return { status: 'resolved-path', absolute: path.join(file.root, resolved.path), path: resolved.path };
    return { status: resolved.status === 'outside' ? 'outside-scope' : resolved.status };
  }
  if (ref.import && /^\.\.?\//.test(ref.value)) {
    const absolute = path.resolve(path.dirname(file.absolute), ref.value);
    if (!inside(file.root, absolute)) return { status: 'outside-scope' };
    return { status: 'resolved-path', absolute, path: slash(path.relative(file.root, absolute)) };
  }
  if (ref.read || /^\.\.?\//.test(ref.value)) return { status: 'base-unknown' };
  return { status: 'unresolved' };
}

function rootCoverage(state, origin) {
  return { root: state.root, origin, complete: state.complete, limits: state.limits,
    nodesEnumerated: state.nodesEnumerated, filesRead: state.filesRead, bytesRead: state.bytesRead,
    readExtensions: [...state.readExtensions].sort(), skippedExtensions: [...state.skippedExtensions].sort(),
    incompleteReasons: [...state.incompleteReasons].sort() };
}

export async function auditOutputContracts(input, { materializedRoot = null, limits } = {}) {
  const source = await resolveRoot(input);
  const materialized = materializedRoot ? await resolveRoot(materializedRoot) : null;
  const diagnostics = [];
  const scopes = [];
  const files = [];
  const allCandidates = [];
  for (const [origin, root] of [['source', source], ...(materialized ? [['materialized', materialized]] : [])]) {
    const state = scanState(root, [], limits);
    await enumerateTree(state);
    for (const node of [...state.nodes.values()].sort((a, b) => a.relative.localeCompare(b.relative))) {
      if (node.kind !== 'file') continue;
      const kind = candidateKind(node.relative);
      const file = { ...node, root, origin, kind, content: null, hash: null };
      if (TEXT_EXTENSIONS.includes(path.extname(node.relative).toLowerCase())) {
        file.content = await readText(state, node.relative);
        if (file.content !== null) file.hash = createHash('sha256').update(file.content).digest('hex');
      } else state.skippedExtensions.add(path.extname(node.relative).toLowerCase() || '(none)');
      if (kind) allCandidates.push(file);
      if (file.content !== null) files.push(file);
    }
    diagnostics.push(...state.diagnostics.map(item => ({ ...item, origin })));
    scopes.push(rootCoverage(state, origin));
  }
  const complete = scopes.every(scope => scope.complete);
  const grouped = new Map();
  for (const file of allCandidates) {
    // A content match counts copies only. It does not establish maintenance ownership.
    const key = file.hash ? `${file.kind}:${path.basename(file.relative)}:${file.hash}` : `${file.origin}:${file.relative}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(file);
  }
  const references = files.map(file => ({ file, refs: referencesIn(file) }));
  const candidates = [];
  for (const copies of grouped.values()) {
    const canonical = copies.find(file => file.origin === 'source') ?? copies[0];
    const matches = [];
    for (const { file, refs } of references) {
      if (copies.some(copy => copy.absolute === file.absolute && copy.origin === file.origin)) continue;
      const lines = file.content.split('\n');
      for (const ref of refs) {
        if (path.posix.basename(ref.value.split('#')[0].replaceAll('\\', '/')) !== path.basename(canonical.relative)) continue;
        const resolved = resolutionFor(file, ref);
        if (resolved.status === 'ignored') continue;
        if (resolved.status === 'resolved-path' && !copies.some(copy => copy.origin === file.origin && copy.absolute === resolved.absolute)) continue;
        const item = { relation: 'reference-candidate', origin: file.origin, path: file.relative, line: ref.line,
          snippet: (lines[ref.line - 1] ?? '').trim().slice(0, 240), value: ref.value.slice(0, 512),
          resolution: resolved.status, ...(resolved.path ? { resolvedPath: resolved.path } : {}) };
        if (!matches.some(existing => existing.origin === item.origin && existing.path === item.path && existing.line === item.line && existing.value === item.value)) matches.push(item);
      }
    }
    const candidateComplete = complete && copies.every(copy => copy.content !== null);
    candidates.push({ path: canonical.relative, origin: canonical.origin, kind: canonical.kind,
      copies: { source: copies.filter(file => file.origin === 'source').length, materialized: copies.filter(file => file.origin === 'materialized').length,
        uniqueContentHashes: new Set(copies.map(file => file.hash).filter(Boolean)).size },
      locations: copies.map(file => ({ origin: file.origin, path: file.relative, contentRead: file.content !== null })),
      references: matches, businessUse: 'not-assessed',
      assessment: !candidateComplete ? 'incomplete' : canonical.kind === 'human-template' ? 'human-format' : matches.length ? 'references-found' : 'no-reference-in-scope',
      scan: { complete: candidateComplete }, unknowns: ['业务用途未评估。', '候选仅按 schema、template、validate/validator 名称发现；普通结果文件可能不在候选集合。',
        '范围外用途未扫描；内容相同不证明维护归属。', ...(candidateComplete ? [] : ['存在未读候选内容或受限扫描。'])] });
  }
  candidates.sort((a, b) => `${a.origin}:${a.path}`.localeCompare(`${b.origin}:${b.path}`));
  return { version: 2, command: 'audit-output-contracts', scope: { roots: scopes, supportedExtensions: TEXT_EXTENSIONS,
    candidateDiscovery: 'names containing schema, template, validate/validator; ordinary result files may be excluded' }, complete, candidates, diagnostics };
}

export async function main(argv = process.argv.slice(2)) {
  let format = requestedFormat(argv);
  let report;
  try {
    const args = parseArgs(argv, { values: ['materialized-root'] });
    if (args.help) { process.stdout.write(HELP); process.exitCode = 0; return; }
    format = args.format;
    report = await auditOutputContracts(args.target, { materializedRoot: args['materialized-root'] });
    process.exitCode = report.complete ? 0 : 1;
  } catch (error) {
    report = { version: 2, command: 'audit-output-contracts', scope: { roots: [], supportedExtensions: TEXT_EXTENSIONS }, complete: false, candidates: [],
      diagnostics: [diagnostic('error', error.code ?? 'io-error', '.', error.code ? error.message : '工具无法完成扫描。', '核对参数和根路径。')] };
    process.exitCode = 2;
  }
  printReport(report, format);
}

if (isMain(import.meta.url)) await main();
