import { marked } from 'marked';
import path from 'node:path';
import { inside, slash } from './common.mjs';

function isResourceCodePath(value, documentPath, resourcePaths) {
  if (/\s/.test(value)) return false;
  const local = value.split('#')[0];
  if (!local || local.endsWith('/') || local === '.' || local === '..') return false;
  const unprefixed = local.replace(/^(?:\.\.?\/)+/, '');
  const first = unprefixed.split('/')[0];
  if (unprefixed === 'SKILL.md') return true;
  if (unprefixed.includes('/') && (/^(?:references|assets|scripts|docs)$/.test(first) || resourcePaths.has(first))) return true;
  if (path.posix.extname(local) && resourcePaths.has(local.replace(/^\.\//, ''))) return true;
  // An existing document-relative target is still a resource pointer. Resolve it
  // from the Skill root below so a legacy short path cannot pass unnoticed.
  return path.posix.dirname(documentPath) !== '.'
    && resourcePaths.has(path.posix.normalize(path.posix.join(path.posix.dirname(documentPath), local)));
}

export function markdownReferences(content, { documentPath = 'SKILL.md', resourcePaths = new Set() } = {}) {
  const normalized = content.replace(/\r\n?/g, '\n');
  const tokens = marked.lexer(normalized, { gfm: true });
  const references = [];
  const pending = [{ tokens, start: 0 }];
  while (pending.length) {
    const item = pending.pop();
    let cursor = item.start;
    for (const token of item.tokens) {
      const found = normalized.indexOf(token.raw ?? '', cursor);
      const start = found >= 0 ? found : cursor;
      cursor = start + (token.raw?.length ?? 0);
      if (token.type === 'code' || token.type === 'html') continue;
      const line = normalized.slice(0, start).split('\n').length;
      if (token.type === 'link' || token.type === 'image') references.push({ value: token.href, line, kind: 'markdown-link' });
      if (token.type === 'codespan' && isResourceCodePath(token.text, documentPath, resourcePaths))
        references.push({ value: token.text, line, kind: 'inline-code' });
      if (token.tokens) pending.push({ tokens: token.tokens, start });
      if (token.items) pending.push({ tokens: token.items, start });
      if (token.header) for (const cell of token.header) pending.push({ tokens: cell.tokens ?? [], start });
      if (token.rows) for (const row of token.rows) for (const cell of row) pending.push({ tokens: cell.tokens ?? [], start });
    }
  }
  return references.sort((a, b) => a.line - b.line);
}

export function resolveReference(root, documentPath, value, { icon = false, kind = 'markdown-link' } = {}) {
  if (!value || value.startsWith('#') || /^(?:https?:|mailto:|data:|ftp:|tel:|\/\/)/i.test(value)) return { status: 'ignored' };
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('~')) return { status: 'external' };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return { status: 'external' };
  let local;
  const pathValue = value.split('#')[0];
  try { local = kind === 'markdown-link' ? decodeURIComponent(pathValue.split('?')[0]) : pathValue; } catch { return { status: 'unresolved' }; }
  if (/\$|[{}*?<>]|\[[^\]]*\]/.test(local)) return { status: 'unresolved' };
  if (!local) return { status: 'ignored' };
  const rootRelative = kind === 'inline-code' || icon;
  const absolute = path.resolve(rootRelative ? root : path.dirname(path.join(root, documentPath)), local);
  if (!inside(root, absolute)) return { status: 'outside' };
  return { status: 'local', path: slash(path.relative(root, absolute)) || '.' };
}
