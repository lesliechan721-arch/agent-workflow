import path from 'node:path';

import fs from 'fs-extra';
import YAML from 'yaml';

import { isSkillAuthorOnlyPath } from './skill-authoring.js';
import { validateSkillFrontmatterCapabilities } from './skill-frontmatter-capabilities.js';

const SKILL_FILE_PATH = 'SKILL.md';
const SKILL_OWNER_MARKER = '.agent-workflows-owner.json';

export interface PortableSkillTree {
  skillKey: string;
  files: Record<string, Buffer>;
}

export function validatePortableSkillName(value: string, fieldName = 'portable Skill name'): void {
  if (value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected at most 64 ASCII lowercase hyphen-case characters.`);
  }
}

function comparePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function parseFrontmatter(rawContent: string): Record<string, unknown> {
  const normalized = rawContent.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) throw new Error('SKILL.md 缺少 YAML frontmatter。');
  const closingIndex = normalized.indexOf('\n---\n', 4);
  const closingAtEof = closingIndex === -1 && normalized.endsWith('\n---');
  if (closingIndex === -1 && !closingAtEof) throw new Error('SKILL.md frontmatter 缺少结束分隔符。');
  const yamlEndIndex = closingAtEof ? normalized.length - '\n---'.length : closingIndex;
  let frontmatter: unknown;
  try {
    frontmatter = YAML.parse(normalized.slice(4, yamlEndIndex));
  } catch (error) {
    throw new Error(`SKILL.md frontmatter YAML 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) {
    throw new Error('SKILL.md frontmatter 根节点必须是 object。');
  }
  return frontmatter as Record<string, unknown>;
}

async function collectFiles(rootDir: string): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = {};
  const visit = async (currentDir: string, parentPath: string): Promise<void> => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => comparePaths(left.name, right.name))) {
      const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      if (isSkillAuthorOnlyPath(relativePath)) continue;
      if (relativePath === SKILL_OWNER_MARKER) {
        throw new Error(`Skill source tree 不能声明保留文件 ${SKILL_OWNER_MARKER}。`);
      }
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Skill 静态源不支持符号链接：${relativePath}`);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files[relativePath] = await fs.readFile(absolutePath);
      } else {
        throw new Error(`Skill 静态源只支持普通文件和目录：${relativePath}`);
      }
    }
  };
  await visit(rootDir, '');
  return files;
}

export async function validatePortableSkillDirectory(rootDir: string): Promise<PortableSkillTree> {
  const rootStats = await fs.lstat(rootDir).catch(() => null);
  if (!rootStats || rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Skill 根路径必须是真实目录：${rootDir}`);
  }
  const skillKey = path.basename(rootDir);
  validatePortableSkillName(skillKey, 'portable Skill directory name');
  const files = await collectFiles(rootDir);
  const skillFile = files[SKILL_FILE_PATH];
  if (!skillFile || skillFile.toString('utf8').trim() === '') {
    throw new Error(`agent-skills.skill "${skillKey}" 缺少 SKILL.md 内容。`);
  }
  const frontmatter = parseFrontmatter(skillFile.toString('utf8'));
  if (typeof frontmatter.name === 'string') validatePortableSkillName(frontmatter.name, 'SKILL.md frontmatter.name');
  if (typeof frontmatter.description === 'string' && frontmatter.description.length > 1024) {
    throw new Error('Invalid SKILL.md frontmatter.description: expected at most 1024 characters.');
  }
  const diagnostics = validateSkillFrontmatterCapabilities(frontmatter, 'portable-agent-skills');
  if (diagnostics.length > 0) {
    throw new Error(`SKILL.md frontmatter 不符合 portable-agent-skills profile：${diagnostics.map((entry) => `[${entry.code}] ${entry.message}`).join('; ')}`);
  }
  if (frontmatter.name !== skillKey) {
    throw new Error(`SKILL.md frontmatter 的 name 必须与 Skill 目录一致：期望 ${JSON.stringify(skillKey)}。`);
  }
  const readme = files['README.md'];
  if (!readme || readme.toString('utf8').trim() === '') {
    throw new Error(`agent-skills.skill "${skillKey}" 缺少非空 README.md。`);
  }
  return { skillKey, files };
}

export async function validatePortableSkillDirectoriesRoot(rootDir: string): Promise<PortableSkillTree[]> {
  const rootStats = await fs.lstat(rootDir).catch(() => null);
  if (!rootStats || rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Skills 根路径必须是真实目录：${rootDir}`);
  }
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const trees: PortableSkillTree[] = [];
  for (const entry of entries.sort((left, right) => comparePaths(left.name, right.name))) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Skills 根目录的直接子节点必须是普通目录：${entry.name}`);
    }
    trees.push(await validatePortableSkillDirectory(path.join(rootDir, entry.name)));
  }
  return trees;
}
