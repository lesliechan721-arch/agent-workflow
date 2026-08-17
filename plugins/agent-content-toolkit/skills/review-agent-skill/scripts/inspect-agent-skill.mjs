#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const target = process.argv[2];
if (!target || ['--help','-h'].includes(target)) {
  process.stdout.write('Usage: inspect-agent-skill.mjs <skill-dir>\n');
  process.exit(target ? 0 : 2);
}
const root = path.resolve(target);
const files = [];
async function walk(dir, rel='') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['.git','node_modules'].includes(entry.name)) continue;
    const nextRel = path.join(rel, entry.name);
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(abs, nextRel);
    else if (entry.isFile()) {
      const s = await stat(abs);
      files.push({ path: nextRel.split(path.sep).join('/'), bytes: s.size });
    }
  }
}
await walk(root);
const skillPath = path.join(root, 'SKILL.md');
const skill = await readFile(skillPath, 'utf8');
const refs = files.filter(x => x.path.startsWith('references/'));
const refMetrics = [];
for (const ref of refs) {
  const text = await readFile(path.join(root, ref.path), 'utf8');
  refMetrics.push({
    ...ref,
    lines: text.split('\n').length,
    estimatedTokens: Math.ceil(Buffer.byteLength(text, 'utf8') / 4),
    headings: [...text.matchAll(/^#{1,6}\s+/gmu)].length,
    requiresSemanticAudit: text.split('\n').length > 300 || Buffer.byteLength(text, 'utf8') / 4 > 4000,
  });
}
const result = {
  root,
  skill: {
    bytes: Buffer.byteLength(skill, 'utf8'),
    lines: skill.split('\n').length,
    estimatedTokens: Math.ceil(Buffer.byteLength(skill, 'utf8') / 4),
  },
  totalFiles: files.length,
  totalBytes: files.reduce((n, x) => n + x.bytes, 0),
  references: refMetrics,
  note: 'Size thresholds only trigger semantic audit; they are not automatic findings.'
};
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
