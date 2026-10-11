import { marked } from 'marked';
import path from 'node:path';
import { inside, slash } from './common.mjs';

export function markdownReferences(content) {
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
      if (token.type === 'codespan' && /^(?:references|assets|scripts)\//.test(token.text))
        references.push({ value: token.text, line, kind: 'inline-code' });
      if (token.tokens) pending.push({ tokens: token.tokens, start });
      if (token.items) pending.push({ tokens: token.items, start });
      if (token.header) for (const cell of token.header) pending.push({ tokens: cell.tokens ?? [], start });
      if (token.rows) for (const row of token.rows) for (const cell of row) pending.push({ tokens: cell.tokens ?? [], start });
    }
  }
  return references.sort((a, b) => a.line - b.line);
}

export function resolveReference(root, documentPath, value, { icon = false } = {}) {
  if (!value || value.startsWith('#') || /^(?:https?:|mailto:|data:|ftp:|tel:|\/\/)/i.test(value)) return { status: 'ignored' };
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('~')) return { status: 'external' };
  if (/\$|[{}*?<>]|\[[^\]]*\]/.test(value)) return { status: 'unresolved' };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return { status: 'external' };
  let local;
  try { local = decodeURIComponent(value.split('#')[0]); } catch { return { status: 'unresolved' }; }
  if (!local) return { status: 'ignored' };
  const rootRelative = /^(?:references|assets|scripts)\//.test(local) || icon;
  const absolute = path.resolve(rootRelative ? root : path.dirname(path.join(root, documentPath)), local);
  if (!inside(root, absolute)) return { status: 'outside' };
  return { status: 'local', path: slash(path.relative(root, absolute)) || '.' };
}
