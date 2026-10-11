import path from 'node:path';
import { diagnostic, enumerateTree, incomplete, isMain, parseArgs, printReport, readText, requestedFormat, resolveRoot, scanState } from './common.mjs';
import { parseYaml, RULESET, validateCommonMetadata, validateFrontmatter } from './fields.mjs';
import { markdownReferences, resolveReference } from './references.mjs';

const HELP = '用法：node check-skill.mjs <skill-directory> [--format text|json]\n检查标准字段、已出现的常用 metadata 和明确本地引用；不执行包内脚本。\n';

function baseReport(target) {
  return { version: 1, command: 'check-skill', ruleset: RULESET, target, ok: false, complete: false,
    coverage: { frontmatter: false, commonMetadata: false, references: false }, diagnostics: [] };
}

export async function checkSkill(input, { limits } = {}) {
  const report = baseReport(path.resolve(input));
  const root = await resolveRoot(input);
  const state = scanState(root, report.diagnostics, limits);
  await enumerateTree(state);
  const main = state.nodes.get('SKILL.md');
  if (!main || main.kind !== 'file') {
    report.diagnostics.push(diagnostic('error', main ? 'unsafe-node' : 'required-field', 'SKILL.md', '需要普通文件 SKILL.md。', '提供合法主文件。'));
    if (main) state.complete = false;
  }
  const content = main?.kind === 'file' ? await readText(state, 'SKILL.md') : null;
  let body = null;
  let bodyLine = 1;
  if (content !== null) {
    let text = content.replace(/\r\n?/g, '\n');
    if (text.startsWith('\uFEFF')) {
      text = text.slice(1);
      report.diagnostics.push(diagnostic('info', 'utf8-bom', 'SKILL.md', '已剥离一个起始 BOM。', '建议保存为无 BOM 的 UTF-8。', 1));
    }
    const lines = text.split('\n');
    const end = lines[0] === '---' ? lines.findIndex((line, index) => index > 0 && line === '---') : -1;
    report.coverage.frontmatter = true;
    if (end < 0) report.diagnostics.push(diagnostic('error', 'invalid-frontmatter', 'SKILL.md', '第一行必须是 frontmatter 分隔符并有结束分隔符。', '使用 --- 包围 YAML 字段。', 1));
    else {
      const fields = parseYaml(lines.slice(1, end).join('\n'), 'SKILL.md', report.diagnostics, 1);
      if (fields) validateFrontmatter(fields, path.basename(root), report.diagnostics);
      body = lines.slice(end + 1).join('\n');
      bodyLine = end + 2;
      if (!body.trim()) report.diagnostics.push(diagnostic('error', 'empty-body', 'SKILL.md', '正文为空。', '填写任务方法和完成条件。', bodyLine));
      if (/TODO:\s*scaffold|replace this prompt|待作者补齐/i.test(body)) report.diagnostics.push(diagnostic('info', 'scaffold-content', 'SKILL.md', '正文仍有起稿标记。', '按实际任务补齐方法和完成条件。'));
      if (body.split('\n').length > 500) report.diagnostics.push(diagnostic('info', 'long-body', 'SKILL.md', '正文超过 500 行。', '检查哪些分支资料适合条件读取。'));
    }
  }
  const iconReferences = [];
  const metadata = state.nodes.get('agents/openai.yaml');
  if (!metadata) report.coverage.commonMetadata = true;
  else if (metadata.kind !== 'file') report.diagnostics.push(diagnostic('error', 'unsafe-node', 'agents/openai.yaml', 'metadata 必须是普通文件。', '移除不安全节点。'));
  else {
    const yaml = await readText(state, metadata.relative);
    if (yaml !== null) {
      report.coverage.commonMetadata = true;
      const fields = parseYaml(yaml, metadata.relative, report.diagnostics);
      if (fields) iconReferences.push(...validateCommonMetadata(fields, report.diagnostics));
    }
  }
  let referencesComplete = body !== null;
  const seen = new Set();
  const pending = body === null ? [] : [{ path: 'SKILL.md', content: body, offset: bodyLine - 1 }];
  async function inspectReference(documentPath, ref, icon = false) {
    const resolved = resolveReference(root, documentPath, ref.value, { icon });
    if (resolved.status === 'ignored') return;
    if (resolved.status === 'external' || resolved.status === 'unresolved') {
      report.diagnostics.push(diagnostic('info', resolved.status === 'external' ? 'external-reference' : 'unresolved-reference', documentPath,
        resolved.status === 'external' ? '引用在外部，未评估。' : '引用含动态内容，未解析。', '人工核对真实资源。', ref.line));
      return;
    }
    if (resolved.status === 'outside') {
      report.diagnostics.push(diagnostic('error', 'unsafe-node', documentPath, '本地引用越出 Skill 包。', '把必要资源放在包内。', ref.line));
      return;
    }
    const node = resolved.path === '.' ? { kind: 'directory' } : state.nodes.get(resolved.path);
    if (!node) report.diagnostics.push(diagnostic('error', 'missing-reference', documentPath, `缺少本地引用 ${resolved.path}。`, '提供资源或修正引用。', ref.line));
    else if (node.kind !== 'file' && node.kind !== 'directory') {
      referencesComplete = false;
      report.diagnostics.push(diagnostic('error', 'unsafe-node', documentPath, '引用目标不是安全普通节点。', '移除符号链接或特殊节点。', ref.line));
    } else if (node.kind === 'file' && /\.md$/i.test(node.relative) && !seen.has(node.relative)) {
      seen.add(node.relative);
      const markdown = await readText(state, node.relative);
      if (markdown === null) referencesComplete = false;
      else pending.push({ path: node.relative, content: markdown, offset: 0 });
    }
  }
  for (const value of iconReferences) await inspectReference('agents/openai.yaml', { value, kind: 'icon' }, true);
  seen.add('SKILL.md');
  while (pending.length) {
    const item = pending.pop();
    try {
      for (const ref of markdownReferences(item.content)) await inspectReference(item.path, { ...ref, line: ref.line + item.offset });
    } catch {
      referencesComplete = false;
      incomplete(state, 'io-error', item.path, 'Markdown 引用提取未完成。', 'markdown-parse-error');
    }
  }
  report.coverage.references = referencesComplete && state.complete;
  report.complete = state.complete && (content === null ? !main : true) && (!metadata || report.coverage.commonMetadata);
  report.ok = report.complete && !report.diagnostics.some(item => item.severity === 'error');
  report.scan = { limits: state.limits, nodesEnumerated: state.nodesEnumerated, filesRead: state.filesRead, bytesRead: state.bytesRead,
    readExtensions: [...state.readExtensions].sort(), incompleteReasons: [...state.incompleteReasons].sort(),
    contentScope: 'SKILL.md, agents/openai.yaml, explicitly referenced Markdown; other resources: metadata and existence only' };
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  let format = requestedFormat(argv);
  let report;
  try {
    const args = parseArgs(argv);
    if (args.help) { process.stdout.write(HELP); process.exitCode = 0; return; }
    format = args.format;
    report = await checkSkill(args.target);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    report = baseReport(null);
    report.diagnostics.push(diagnostic('error', error.code ?? 'io-error', '.', error.code ? error.message : '工具无法完成检查。', '核对参数和根路径。'));
    process.exitCode = 2;
  }
  printReport(report, format);
}

if (isMain(import.meta.url)) await main();
