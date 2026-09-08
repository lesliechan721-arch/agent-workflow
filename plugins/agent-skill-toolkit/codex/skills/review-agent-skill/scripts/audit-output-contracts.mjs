#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, opendir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCAN_LIMITS = Object.freeze({
  maxFiles: 2_000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
});

const CODE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const TEXT_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS,
  '.json',
  '.md',
  '.mdx',
  '.toml',
  '.yaml',
  '.yml',
]);

function slash(value) {
  return value.split(path.sep).join('/');
}

function evidence(file, lineIndex, relation, text) {
  return {
    path: file.displayPath,
    lines: `${lineIndex + 1}-${lineIndex + 1}`,
    relation,
    snippet: text.trim().slice(0, 240),
  };
}

function warning(code, targetPath, message) {
  return { code, path: targetPath, message };
}

function candidateKind(file) {
  const name = path.basename(file.absolutePath).toLowerCase();
  if (name.endsWith('.schema.json') || name === 'schema.json') return 'schema';
  if (name.includes('template')) return name.endsWith('.md') ? 'human-template' : 'template';
  if (name.startsWith('validate-') && CODE_EXTENSIONS.has(path.extname(name))) return 'validator';
  return null;
}

async function resolveRoot(input, label) {
  const absolutePath = path.resolve(input);
  let stat;
  try {
    stat = await lstat(absolutePath);
  } catch (error) {
    throw new Error(`${label} 无法读取：${error.message}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} 不能是符号链接：${absolutePath}`);
  if (!stat.isDirectory()) throw new Error(`${label} 必须是目录：${absolutePath}`);
  return absolutePath;
}

async function scanTree(root, origin, state) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      const handle = await opendir(directory);
      entries = [];
      for await (const entry of handle) entries.push(entry);
    } catch (error) {
      state.incompleteReasons.add('read-error');
      state.warnings.push(warning('directory-read-failed', slash(path.relative(root, directory)) || '.', error.message));
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      const absolutePath = path.join(directory, entry.name);
      const relativePath = slash(path.relative(root, absolutePath));
      let stat;
      try {
        stat = await lstat(absolutePath);
      } catch (error) {
        state.incompleteReasons.add('read-error');
        state.warnings.push(warning('entry-stat-failed', relativePath, error.message));
        continue;
      }
      if (stat.isSymbolicLink()) {
        state.incompleteReasons.add('unsupported-node');
        state.warnings.push(warning('symlink-skipped', relativePath, '未跟随符号链接。'));
        continue;
      }
      if (stat.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!stat.isFile()) {
        state.incompleteReasons.add('unsupported-node');
        state.warnings.push(warning('special-node-skipped', relativePath, '未读取特殊节点。'));
        continue;
      }
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      if (state.files.length >= SCAN_LIMITS.maxFiles) {
        state.incompleteReasons.add('file-count-limit');
        state.warnings.push(warning('file-count-limit', relativePath, `最多读取 ${SCAN_LIMITS.maxFiles} 个文本文件。`));
        return;
      }
      if (stat.size > SCAN_LIMITS.maxFileBytes) {
        state.incompleteReasons.add('file-size-limit');
        state.warnings.push(warning('file-size-limit', relativePath, `文件超过 ${SCAN_LIMITS.maxFileBytes} 字节。`));
        continue;
      }
      if (state.bytesRead + stat.size > SCAN_LIMITS.maxTotalBytes) {
        state.incompleteReasons.add('total-byte-limit');
        state.warnings.push(warning('total-byte-limit', relativePath, `总读取量最多为 ${SCAN_LIMITS.maxTotalBytes} 字节。`));
        return;
      }
      try {
        const content = await readFile(absolutePath, 'utf8');
        state.bytesRead += Buffer.byteLength(content);
        state.files.push({
          absolutePath,
          content,
          displayPath: `${origin}:${relativePath}`,
          hash: createHash('sha256').update(content).digest('hex'),
          origin,
          relativePath,
        });
      } catch (error) {
        state.incompleteReasons.add('read-error');
        state.warnings.push(warning('file-read-failed', relativePath, error.message));
      }
    }
  }
}

function exactReference(line, file, contract) {
  const literals = [...line.matchAll(/["'`]([^"'`]+)["'`]/g)].map((match) => slash(match[1]));
  let unresolvedLiteral = null;
  for (const literal of literals) {
    const basenameMatches = contract.files.some(
      (copy) => path.posix.basename(literal) === path.posix.basename(copy.relativePath),
    );
    if (!basenameMatches) continue;
    let resolvedPath = null;
    if (path.isAbsolute(literal)) {
      resolvedPath = path.normalize(literal);
    } else if (file.relativePath.endsWith('.agents-plugin/plugin.json') && /"source"\s*:/.test(line)) {
      resolvedPath = path.resolve(path.dirname(path.dirname(file.absolutePath)), literal);
    } else if (CODE_EXTENSIONS.has(path.extname(file.relativePath)) && /^\.\.?\//.test(literal)) {
      resolvedPath = path.resolve(path.dirname(file.absolutePath), literal);
    }
    for (const copy of contract.files) {
      if (resolvedPath === copy.absolutePath) return { literal, status: 'resolved' };
    }
    unresolvedLiteral ??= literal;
  }
  return unresolvedLiteral ? { literal: unresolvedLiteral, status: 'unresolved' } : null;
}

function classifyReference(file, lines, lineIndex, contract) {
  const line = lines[lineIndex];
  const reference = exactReference(line, file, contract);
  if (!reference) return null;
  const neighborhood = lines.slice(Math.max(0, lineIndex - 3), lineIndex + 4).join('\n');
  const structuredImport = /\b(?:import|export)\b[^\n]*(?:from\s*)?["'`]|\b(?:require(?:\.resolve)?|import)\s*\(/.test(line);
  const structuredRead = /\b(?:readFile(?:Sync)?|open|load|parse)\b/.test(neighborhood)
    && /\b(?:JSON\.parse|parse|readFile(?:Sync)?|open|load)\b/.test(neighborhood);
  const structuredWrite = /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream)\b/.test(neighborhood);
  const runtimeEdge = /"(?:runtimeExports|runtimeImports|buildImports|skillRuntimeFiles|source|import|export)"\s*:/.test(neighborhood);
  if (!structuredImport && !structuredRead && !structuredWrite && !runtimeEdge) return null;
  if (reference.status === 'unresolved') return { reference: reference.literal, unresolved: true };

  const validator = file.relativePath.split('/').some((part) => part.startsWith('validate-'))
    || /\b(?:Ajv|validate|validator)\b/i.test(neighborhood);
  const business = /\b(?:spawn|execFile|exec|runGate|publish|install|recover|resume|authorize|permission|allow|deny|dispatch|execute|importRecord|loadForRun)\b/i.test(neighborhood)
    || /\b(?:runEval|runEngine|runWorkflow|runProcess|decision|authorization|permission|recovery)\s*[.([]/i.test(neighborhood);
  const userRequestedOutput = structuredWrite
    && /(?:--output|--format|requestedOutput|userRequested|stdout)/i.test(neighborhood);

  let relation = 'structured-reference';
  if (runtimeEdge) relation = /runtimeExports/.test(neighborhood) ? 'runtime-export' : 'runtime-import';
  else if (structuredWrite) relation = userRequestedOutput ? 'user-requested-output' : 'producer-write';
  else if (validator) relation = 'format-validation';
  else if (business) relation = 'business-consumer';
  else if (structuredImport) relation = 'static-import';
  else if (structuredRead) relation = 'parser-read';
  return { business, relation, structuredWrite, userRequestedOutput, validator, reference: reference.literal };
}

function inspectContract(contract, files, scanComplete) {
  const producerEvidence = [];
  const consumerEvidence = [];
  const validationOnlyEvidence = [];
  const unknowns = [];
  let qualifiedConsumerCount = 0;
  for (const ownFile of contract.files) {
    producerEvidence.push(evidence(ownFile, 0, `declares-${contract.kind}`, path.basename(ownFile.relativePath)));
  }

  for (const file of files) {
    if (contract.files.some((copy) => copy.absolutePath === file.absolutePath)) continue;
    const lines = file.content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const found = classifyReference(file, lines, lineIndex, contract);
      if (!found) continue;
      if (found.unresolved) {
        unknowns.push(`无法解析 ${file.displayPath}:${lineIndex + 1} 中的路径 ${found.reference}。`);
        continue;
      }
      const item = evidence(file, lineIndex, found.relation, lines[lineIndex]);
      if (found.relation === 'runtime-export') producerEvidence.push(item);
      else if (found.relation === 'runtime-import') {
        consumerEvidence.push({ ...item, relation: 'unproven-runtime-import' });
        unknowns.push(`无法静态证明 ${file.displayPath} 中 runtime projection 的业务用途。`);
      }
      else if (found.structuredWrite && !found.userRequestedOutput) producerEvidence.push(item);
      else if (found.validator) validationOnlyEvidence.push(item);
      else if (found.business || found.userRequestedOutput) {
        consumerEvidence.push(item);
        qualifiedConsumerCount += 1;
      }
      else {
        consumerEvidence.push({ ...item, relation: `unproven-${item.relation}` });
        unknowns.push(`无法静态证明 ${file.displayPath} 中结构化引用的业务用途。`);
      }
    }
  }

  if (qualifiedConsumerCount === 0) unknowns.push('给定扫描范围之外可能存在消费者。');
  if (!scanComplete) unknowns.push('扫描不完整，不能据此判断消费者不存在。');
  const assessment = !scanComplete
    ? 'incomplete-scan'
    : qualifiedConsumerCount > 0
      ? 'consumer-found'
      : contract.kind === 'human-template'
        ? 'human-format'
        : validationOnlyEvidence.length > 0
          ? 'validation-only'
          : 'not-found-in-scope';

  return {
    path: contract.files.find((file) => file.origin === 'source')?.relativePath ?? contract.files[0].relativePath,
    copies: {
      source: contract.files.filter((file) => file.origin === 'source').length,
      materialized: contract.files.filter((file) => file.origin === 'materialized').length,
      uniqueContentHashes: new Set(contract.files.map((file) => file.hash)).size,
    },
    producerEvidence,
    consumerEvidence,
    validationOnlyEvidence,
    assessment,
    unknowns: [...new Set(unknowns)],
  };
}

export async function auditOutputContracts(rootInput, options = {}) {
  const sourceRoot = await resolveRoot(rootInput, 'root');
  const materializedRoot = options.materializedRoot
    ? await resolveRoot(options.materializedRoot, 'materialized-root')
    : null;
  const state = { bytesRead: 0, files: [], incompleteReasons: new Set(), warnings: [] };
  await scanTree(sourceRoot, 'source', state);
  if (materializedRoot) await scanTree(materializedRoot, 'materialized', state);

  const candidates = state.files.filter((file) => candidateKind(file));
  const grouped = new Map();
  for (const file of candidates) {
    const kind = candidateKind(file);
    const key = `${kind}:${path.basename(file.relativePath)}:${file.hash}`;
    const current = grouped.get(key) ?? { files: [], kind };
    current.files.push(file);
    grouped.set(key, current);
  }
  const scanComplete = state.incompleteReasons.size === 0;
  const contracts = [...grouped.values()]
    .map((contract) => inspectContract(contract, state.files, scanComplete))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    version: 1,
    producer: 'audit-output-contracts',
    scope: {
      root: sourceRoot,
      materializedRoot,
      limits: SCAN_LIMITS,
      filesRead: state.files.length,
      bytesRead: state.bytesRead,
      incompleteReasons: [...state.incompleteReasons].sort(),
    },
    scanComplete,
    contracts,
    warnings: state.warnings,
  };
}

function parseArgs(argv) {
  let root = null;
  let materializedRoot = null;
  let format = 'json';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--materialized-root') materializedRoot = argv[++index];
    else if (arg === '--format') format = argv[++index];
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
    else if (root === null) root = arg;
    else throw new Error(`多余参数：${arg}`);
  }
  if (!root) throw new Error('用法：audit-output-contracts.mjs <root> [--materialized-root <path>] [--format json|text]');
  if (!materializedRoot && argv.includes('--materialized-root')) throw new Error('--materialized-root 需要路径。');
  if (!['json', 'text'].includes(format)) throw new Error('--format 必须是 json 或 text。');
  return { format, materializedRoot, root };
}

function textReport(report) {
  const output = [
    `Output contract audit v${report.version}`,
    `Scan complete: ${report.scanComplete}`,
    `Files read: ${report.scope.filesRead}`,
  ];
  for (const contract of report.contracts) {
    output.push(`${contract.assessment}\t${contract.path}\tsource=${contract.copies.source}\tmaterialized=${contract.copies.materialized}`);
  }
  for (const item of report.warnings) output.push(`warning\t${item.code}\t${item.path}\t${item.message}`);
  return `${output.join('\n')}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const report = await auditOutputContracts(args.root, { materializedRoot: args.materializedRoot });
    process.stdout.write(args.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : textReport(report));
    process.exitCode = report.contracts.some((contract) =>
      ['validation-only', 'not-found-in-scope', 'incomplete-scan'].includes(contract.assessment),
    ) || !report.scanComplete ? 1 : 0;
  } catch (error) {
    process.stderr.write(`audit-output-contracts: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
