import { constants, realpathSync } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCAN_LIMITS = Object.freeze({
  maxNodes: 10_000,
  maxFiles: 2_000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
});

export const slash = value => value.split(path.sep).join('/');
export const inside = (root, target) => target === root || (!path.relative(root, target).startsWith(`..${path.sep}`)
  && path.relative(root, target) !== '..' && !path.isAbsolute(path.relative(root, target)));
export const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;

export function diagnostic(severity, code, targetPath, message, action, line) {
  return { severity, code, path: targetPath, ...(line ? { line } : {}), message, action };
}

export class ToolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export async function assertPathChain(target, { missingLeaf = false } = {}) {
  const absolute = path.resolve(target);
  const parts = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if (error.code === 'ENOENT' && missingLeaf && index === parts.length - 1) return null;
      throw new ToolError('io-error', `路径无法读取（${error.code ?? 'I/O'}）。`);
    }
    if (stat.isSymbolicLink()) throw new ToolError('unsafe-path', '路径链包含符号链接。');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new ToolError('unsafe-path', '父路径必须是普通目录。');
    if (index === parts.length - 1) return stat;
  }
  return lstat(absolute);
}

export async function resolveRoot(input) {
  const target = path.resolve(input);
  const stat = await assertPathChain(target);
  if (!stat.isDirectory()) throw new ToolError('unsafe-path', '根路径必须是普通目录。');
  return target;
}

export function scanState(root, diagnostics, limits = SCAN_LIMITS) {
  return { root, diagnostics, limits, nodes: new Map(), nodesEnumerated: 0, filesRead: 0, bytesRead: 0,
    complete: true, incompleteReasons: new Set(), cache: new Map(), readExtensions: new Set(), skippedExtensions: new Set() };
}

export function incomplete(state, code, targetPath, message, reason = code) {
  state.complete = false;
  state.incompleteReasons.add(reason);
  state.diagnostics.push(diagnostic('warning', code, targetPath, message, '修复问题后重新检查。'));
}

export async function enumerateTree(state) {
  const pending = [state.root];
  while (pending.length) {
    const directory = pending.pop();
    try {
      // Recheck the directory chain before opening; this is not an OS sandbox.
      const dirStat = await assertPathChain(directory);
      if (!dirStat.isDirectory()) throw new ToolError('unsafe-node', '目录在检查期间发生变化。');
      const handle = await opendir(directory);
      const entries = [];
      for await (const entry of handle) {
        if (state.nodesEnumerated >= state.limits.maxNodes) {
          incomplete(state, 'scan-limit', slash(path.relative(state.root, directory)) || '.', '枚举节点达到上限。', 'node-count-limit');
          return;
        }
        state.nodesEnumerated += 1;
        entries.push(entry.name);
      }
      entries.sort();
      const subdirs = [];
      for (const name of entries) {
        const absolute = path.join(directory, name);
        const relative = slash(path.relative(state.root, absolute));
        try {
          const stat = await lstat(absolute);
          const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special';
          state.nodes.set(relative, { absolute, relative, stat, kind });
          if (kind === 'symlink' || kind === 'special') incomplete(state, 'unsafe-node', relative, '未跟随符号链接或读取特殊节点。');
          else if (kind === 'directory') subdirs.push(absolute);
        } catch (error) { incomplete(state, 'io-error', relative, `节点无法读取（${error.code ?? 'I/O'}）。`); }
      }
      pending.push(...subdirs.reverse());
    } catch (error) {
      incomplete(state, error.code === 'unsafe-path' ? 'unsafe-node' : 'io-error', slash(path.relative(state.root, directory)) || '.', `目录无法安全读取（${error.code ?? 'I/O'}）。`);
    }
  }
}

export async function readText(state, relative) {
  if (state.cache.has(relative)) return state.cache.get(relative);
  const node = state.nodes.get(relative);
  if (!node || node.kind !== 'file') return null;
  const mark = (code, message, reason) => { incomplete(state, code, relative, message, reason); state.cache.set(relative, null); return null; };
  if (state.filesRead >= state.limits.maxFiles) return mark('scan-limit', '受读文本文件数达到上限。', 'file-count-limit');
  if (node.stat.size > state.limits.maxFileBytes) return mark('scan-limit', '文件大小超过上限。', 'file-size-limit');
  if (state.bytesRead + node.stat.size > state.limits.maxTotalBytes) return mark('scan-limit', '累计文本读取量达到上限。', 'total-byte-limit');
  let handle;
  try {
    await assertPathChain(node.absolute);
    handle = await open(node.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || !sameNode(before, node.stat) || before.size !== node.stat.size || before.mtimeMs !== node.stat.mtimeMs)
      return mark('io-error', '文件在检查期间发生变化。', 'file-changed');
    const remaining = Math.min(state.limits.maxFileBytes, state.limits.maxTotalBytes - state.bytesRead);
    const buffer = Buffer.alloc(Math.min(before.size + 1, remaining + 1));
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    state.filesRead += 1;
    state.bytesRead += bytes;
    state.readExtensions.add(path.extname(relative).toLowerCase() || '(none)');
    const after = await handle.stat();
    const current = await lstat(node.absolute);
    if (bytes !== before.size || !sameNode(before, current) || current.isSymbolicLink()
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      return mark('io-error', '文件在读取期间发生变化。', 'file-changed');
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes)); }
    catch { return mark('io-error', '文件不是有效 UTF-8 文本。', 'unsupported-text'); }
    if (content.includes('\u0000')) return mark('io-error', '文件包含二进制内容，未做文本检查。', 'unsupported-text');
    state.cache.set(relative, content);
    return content;
  } catch (error) { return mark(error.code === 'unsafe-path' ? 'unsafe-node' : 'io-error', `文件无法安全读取（${error.code ?? 'I/O'}）。`); }
  finally { await handle?.close(); }
}

export function parseArgs(argv, { values = [], flags = [] } = {}) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const parsed = { format: 'text' };
  const seen = new Set();
  const valued = new Set(['format', ...values]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('-')) {
      const key = arg.slice(2);
      if (!arg.startsWith('--') || (!valued.has(key) && !flags.includes(key)) || seen.has(key))
        throw new ToolError('invalid-arguments', '参数未知或重复。');
      seen.add(key);
      if (flags.includes(key)) parsed[key] = true;
      else {
        const value = argv[++index];
        if (value === undefined || value.startsWith('--')) throw new ToolError('invalid-arguments', '参数缺少值。');
        parsed[key] = value;
      }
    } else {
      if (parsed.target !== undefined) throw new ToolError('invalid-arguments', '只接受一个位置参数。');
      parsed.target = arg;
    }
  }
  if (!parsed.target || !['text', 'json'].includes(parsed.format)) throw new ToolError('invalid-arguments', '需要目标路径，format 必须是 text 或 json。');
  return parsed;
}

export function requestedFormat(argv) {
  return argv.some((value, index) => value === '--format' && argv[index + 1] === 'json') ? 'json' : 'text';
}

export function printReport(report, format) {
  if (format === 'json') process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    const lines = [`${report.command} v${report.version}: ${report.ok ?? report.complete ? '完成' : '未通过'}`];
    if (report.state) lines.push(`状态：${report.state}`);
    if (report.files) lines.push(`计划：${report.files.join(', ')}`);
    if (report.created?.length) lines.push(`实际创建：${report.created.join(', ')}`);
    for (const item of report.candidates ?? []) lines.push(`${item.assessment}\t${item.path}\t业务用途：${item.businessUse}`);
    for (const item of report.diagnostics) lines.push(`${item.severity}\t${item.code}\t${item.path}${item.line ? `:${item.line}` : ''}\t${item.message} ${item.action}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
}

export function isMain(url) {
  if (!process.argv[1]) return false;
  try { return url === pathToFileURL(realpathSync(path.resolve(process.argv[1]))).href; }
  catch { return false; }
}
