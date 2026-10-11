import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleTools, GENERATED_FILES, writeGeneratedFiles } from '../tooling/build.mjs';
import { assertPathChain, isMain } from '../tooling/src/common.mjs';

// AW invokes this file from a copied <aw-plugin-staging-*>/plugin tree.
// The script location, rather than cwd or an optional env var, owns the root.
export async function main() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  if (path.basename(root) !== 'plugin' || !path.basename(path.dirname(root)).startsWith('aw-plugin-staging-'))
    throw new Error('build-tools 只允许写 AW staging 副本；独立导出请使用 tooling/build.mjs --out。');
  await assertPathChain(root);
  const manifestPath = path.join(root, '.agents-plugin', 'plugin.json');
  await assertPathChain(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.name !== 'agent-skill-toolkit' || manifest.scripts?.node?.packageRoot !== './tooling') throw new Error('staging 布局与工具声明不一致。');
  const expected = GENERATED_FILES.map(([skill, target]) => `${skill}:${target}`).sort();
  const declared = (manifest.buildConfig?.generatedSkillRuntimeFiles ?? []).map(({ skill, target }) => `${skill}:${target}`).sort();
  if (JSON.stringify(expected) !== JSON.stringify(declared)) throw new Error('生成文件声明与独立工具输出不一致。');
  for (const skill of new Set(GENERATED_FILES.map(([skill]) => skill))) {
    const skillRoot = path.join(root, 'skills', skill);
    const stat = await assertPathChain(skillRoot);
    if (!stat.isDirectory() || !(await lstat(path.join(skillRoot, 'SKILL.md'))).isFile()) throw new Error('缺少预期 Skill 源码。');
  }
  await writeGeneratedFiles(root, await bundleTools());
}

if (isMain(import.meta.url)) await main();
