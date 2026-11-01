import { builtinModules } from 'node:module';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { assertPathChain, isMain, ToolError } from './src/common.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = ['author-agent-skill', 'review-agent-skill', 'simplify-agent-skill'];
export const GENERATED_FILES = Object.freeze([
  ['author-agent-skill', 'scripts/init-skill.mjs', 'init-skill'],
  ['author-agent-skill', 'scripts/check-skill.mjs', 'check-skill'],
  ['review-agent-skill', 'scripts/check-skill.mjs', 'check-skill'],
  ['simplify-agent-skill', 'scripts/check-skill.mjs', 'check-skill'],
  ...SKILLS.map(skill => [skill, 'assets/tooling-NOTICE.txt', 'notice']),
]);

async function licenseNotice() {
  const parts = ['Agent Skill Toolkit deterministic tools\nRuntime code includes the libraries below. All bundled runtime imports are Node built-ins.\n'];
  for (const [name, filename] of [['yaml', 'LICENSE'], ['marked', 'LICENSE'], ['esbuild', 'LICENSE.md']]) {
    const packageRoot = path.join(ROOT, 'node_modules', name);
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    const dependency = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
    if ((dependency.dependencies?.[name] ?? dependency.devDependencies?.[name]) !== manifest.version)
      throw new Error(`依赖 ${name} 与锁定版本不一致。`);
    parts.push(`${name} ${manifest.version}${name === 'esbuild' ? ' (build tool; not in runtime)' : ''}\n\n${await readFile(path.join(packageRoot, filename), 'utf8')}`);
  }
  return parts.join('\n\n');
}

export async function bundleTools() {
  const bundles = new Map();
  const builtins = new Set([...builtinModules, ...builtinModules.map(name => name.startsWith('node:') ? name : `node:${name}`)]);
  for (const entry of ['init-skill', 'check-skill']) {
    const result = await build({
      absWorkingDir: ROOT,
      entryPoints: [`src/${entry}.mjs`],
      outfile: `${entry}.mjs`,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      write: false,
      metafile: true,
      legalComments: 'none',
      banner: { js: '#!/usr/bin/env node\nimport { createRequire as __toolingCreateRequire } from "node:module";\nconst require = __toolingCreateRequire(import.meta.url);' },
    });
    for (const output of Object.values(result.metafile.outputs)) for (const imported of output.imports)
      if (!imported.external || !builtins.has(imported.path)) throw new Error('打包产物包含未交付的运行依赖。');
    if (result.outputFiles.length !== 1) throw new Error('每个入口必须是一个独立文件。');
    bundles.set(entry, result.outputFiles[0].contents);
  }
  bundles.set('notice', await licenseNotice());
  return bundles;
}

export async function writeGeneratedFiles(pluginRoot, bundles) {
  // Exact generated targets only. This does not overwrite source or projections.
  for (const [skill, relative] of GENERATED_FILES) {
    const target = path.join(pluginRoot, 'skills', skill, relative);
    const stat = await assertPathChain(target, { missingLeaf: true }).catch(error => {
      if (error.code === 'io-error') return undefined;
      throw error;
    });
    if (stat) throw new ToolError('target-exists', '生成目标已经存在。');
    // Existing ancestor nodes must be safe; creation below is limited to a
    // newly created output or to the wrapper's verified staging tree.
    const skillRoot = path.join(pluginRoot, 'skills', skill);
    let parent = path.dirname(target);
    while (parent !== skillRoot) {
      try { const node = await lstat(parent); if (!node.isDirectory() || node.isSymbolicLink()) throw new Error('生成目录不安全。'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      parent = path.dirname(parent);
    }
  }
  for (const [skill, relative, entry] of GENERATED_FILES) {
    const target = path.join(pluginRoot, 'skills', skill, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await assertPathChain(path.dirname(target));
    await writeFile(target, bundles.get(entry), { flag: 'wx', mode: relative.endsWith('.mjs') ? 0o755 : 0o644 });
  }
}

export async function buildTools(output) {
  const target = path.resolve(output);
  if (await assertPathChain(target, { missingLeaf: true })) throw new ToolError('target-exists', '输出目录已经存在。');
  const bundles = await bundleTools();
  await mkdir(target);
  await writeGeneratedFiles(target, bundles);
  return { target, files: GENERATED_FILES.map(([skill, relative]) => `skills/${skill}/${relative}`) };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length === 1 && argv[0] === '--help') { process.stdout.write('用法：node tooling/build.mjs --out <new-directory>\n'); return; }
    if (argv.length !== 2 || argv[0] !== '--out' || !argv[1] || argv[1].startsWith('--')) throw new ToolError('invalid-arguments', '需要 --out <new-directory>。');
    const result = await buildTools(argv[1]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`build-tools: ${error.code ?? 'build-error'}：${error.message}\n`); process.exitCode = 2; }
}

if (isMain(import.meta.url)) await main();
