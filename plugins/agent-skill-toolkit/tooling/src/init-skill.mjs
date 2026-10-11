import { lstat, mkdir, open, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { assertPathChain, diagnostic, isMain, parseArgs, printReport, requestedFormat, sameNode } from './common.mjs';
import { validateIdentity } from './fields.mjs';

const HELP = '用法：node init-skill.mjs <new-directory> --description <text> [--name <name>] [--dry-run] [--format text|json]\n仅创建标准 SKILL.md 起稿；父目录必须存在。\n';

export async function initSkill(input, { name, description, dryRun = false, fs = { lstat, mkdir, open, rmdir, unlink } } = {}) {
  const target = path.resolve(input);
  const directoryName = path.basename(target);
  const report = { version: 1, command: 'init-skill', ok: false, state: 'not-created', target, dryRun, files: [], created: [], diagnostics: [] };
  const diagnostics = validateIdentity(name ?? directoryName, description, directoryName, '.');
  for (const item of diagnostics) if (item.code === 'field-type' || item.code === 'required-field') item.code = item.message.startsWith('name') ? 'invalid-name' : 'invalid-description';
  if (target === path.parse(target).root || !input.trim()) diagnostics.push(diagnostic('error', 'invalid-name', '.', '不能使用根目录或空名称。', '选择新的合法目录名。'));
  report.diagnostics.push(...diagnostics);
  if (diagnostics.length) return report;
  try {
    const existing = await assertPathChain(target, { missingLeaf: true });
    if (existing) {
      report.diagnostics.push(diagnostic('error', 'target-exists', '.', '目标节点已存在。', '选择新目录。'));
      return report;
    }
  } catch (error) {
    report.diagnostics.push(diagnostic('error', error.code ?? 'io-error', '.', error.message, '核对父路径并选择安全的新目录。'));
    return report;
  }
  // JSON quoted scalars are also valid YAML and preserve user supplied text.
  const content = `---\nname: ${JSON.stringify(name ?? directoryName)}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name ?? directoryName}\n\nTODO: scaffold — replace this prompt with the task method and completion conditions.\n`;
  report.files = ['SKILL.md'];
  if (dryRun) { report.ok = true; report.state = 'scaffold'; return report; }
  let directoryStat;
  let fileStat;
  let handle;
  try {
    // Repeat the path checks directly before exclusive creation.
    if (await assertPathChain(target, { missingLeaf: true })) {
      report.diagnostics.push(diagnostic('error', 'target-exists', '.', '目标在创建前已出现。', '选择新目录。'));
      return report;
    }
    await fs.mkdir(target);
    directoryStat = await fs.lstat(target);
    report.created.push('.');
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('unsafe new directory');
    await assertPathChain(target);
    handle = await fs.open(path.join(target, 'SKILL.md'), 'wx', 0o644);
    fileStat = await handle.stat();
    report.created.push('SKILL.md');
    await handle.writeFile(content, 'utf8');
    await handle.close();
    handle = null;
    report.created = ['SKILL.md'];
    report.ok = true;
    report.state = 'scaffold';
  } catch (error) {
    await handle?.close().catch(() => {});
    // Delete only the inode that this operation created. Never recurse.
    if (fileStat) {
      try {
        const current = await fs.lstat(path.join(target, 'SKILL.md'));
        if (sameNode(fileStat, current) && current.isFile() && !current.isSymbolicLink()) {
          await fs.unlink(path.join(target, 'SKILL.md'));
          report.created = report.created.filter(value => value !== 'SKILL.md');
        }
      } catch {}
    }
    if (directoryStat) {
      try {
        const current = await fs.lstat(target);
        if (sameNode(directoryStat, current) && current.isDirectory() && !current.isSymbolicLink()) {
          await fs.rmdir(target);
          report.created = [];
        }
      } catch {}
    }
    report.state = report.created.length ? 'partial' : 'not-created';
    report.diagnostics.push(diagnostic('error', error.code === 'EEXIST' && !directoryStat ? 'target-exists' : 'io-error', '.',
      `创建失败（${error.code ?? 'I/O'}）。`, report.created.length ? '检查实际遗留路径，再删除自有内容或选择新目录。' : '修复路径后重试。'));
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  let format = requestedFormat(argv);
  let report;
  try {
    const args = parseArgs(argv, { values: ['name', 'description'], flags: ['dry-run'] });
    if (args.help) { process.stdout.write(HELP); process.exitCode = 0; return; }
    format = args.format;
    report = await initSkill(args.target, { name: args.name, description: args.description, dryRun: !!args['dry-run'] });
    process.exitCode = report.ok ? 0 : report.diagnostics.some(item => ['invalid-name', 'invalid-description', 'name-directory-mismatch'].includes(item.code)) ? 2 : 1;
  } catch (error) {
    report = { version: 1, command: 'init-skill', ok: false, state: 'not-created', target: null, dryRun: false, files: [], created: [],
      diagnostics: [diagnostic('error', error.code ?? 'io-error', '.', error.code ? error.message : '工具无法完成创建。', '核对参数和路径。')] };
    process.exitCode = 2;
  }
  printReport(report, format);
}

if (isMain(import.meta.url)) await main();
