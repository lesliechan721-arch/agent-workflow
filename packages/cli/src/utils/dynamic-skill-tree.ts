import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import YAML from 'yaml';
import {
  validatePortableSkillDirectoriesRoot as validateCorePortableSkillDirectoriesRoot,
  validatePortableSkillDirectory as validateCorePortableSkillDirectory,
  validatePortableSkillName as validateCorePortableSkillName,
} from '@lesliechan721/aw-plugin-core/manifest';

import type {
  ClaudeSkillArtifact,
  CodexSkillArtifact,
} from '../types.js';
import {
  assertOwnedSkillPath,
  createSkillOwnerMarkerContent,
  readSkillOwnerMarker,
  type OwnerIdentity,
  SKILL_OWNER_MARKER,
} from './ownership.js';
import { isSkillAuthorOnlyPath } from './skill-authoring.js';
import { validateSkillFrontmatterCapabilities } from './skill-frontmatter-capabilities.js';

export const SKILL_FILE_PATH = 'SKILL.md';
export const CODEX_OPENAI_YAML_PATH = 'agents/openai.yaml';

export interface DynamicSkillTree {
  skillKey: string;
  files: Record<string, Buffer>;
}

export function validatePortableSkillName(value: string, fieldName = 'portable Skill name'): void {
  validateCorePortableSkillName(value, fieldName);
}

function compareSkillPaths(left: string, right: string): number {
  const byteOrder = Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
  if (byteOrder !== 0 || left === right) return byteOrder;
  return left < right ? -1 : 1;
}

function assertWellFormedSkillPath(relativePath: string): void {
  if (Buffer.from(relativePath, 'utf8').toString('utf8') !== relativePath) {
    throw new Error(`Skill 文件路径必须是有效 Unicode：${JSON.stringify(relativePath)}`);
  }
}

function sortedSkillFileEntries(
  files: Record<string, Buffer>,
): Array<[string, Buffer]> {
  const entries = Object.entries(files);
  for (const [relativePath] of entries) assertWellFormedSkillPath(relativePath);
  return entries.sort(([left], [right]) => compareSkillPaths(left, right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeYamlError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateCodexOpenAiYaml(rawContent: string): void {
  let parsed: unknown;
  try {
    parsed = YAML.parse(rawContent);
  } catch (error) {
    throw new Error(`openai.yaml YAML 解析失败：${normalizeYamlError(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('openai.yaml 根节点必须是 object。');
  }
  if (!isRecord(parsed.policy)) {
    throw new Error('openai.yaml 的 policy 必须是 object。');
  }
  const policy = parsed.policy;
  if (typeof policy.allow_implicit_invocation !== 'boolean') {
    throw new Error('openai.yaml 的 policy.allow_implicit_invocation 必须是 boolean。');
  }
}

export function validateClaudeSkillFrontmatter(
  rawContent: string,
  expectedSkillName?: string,
): void {
  const normalized = rawContent.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error('SKILL.md 缺少 YAML frontmatter。');
  }
  const closingIndex = normalized.indexOf('\n---\n', 4);
  const closingAtEof = closingIndex === -1 && normalized.endsWith('\n---');
  if (closingIndex === -1 && !closingAtEof) {
    throw new Error('SKILL.md frontmatter 缺少结束分隔符。');
  }

  const yamlEndIndex = closingAtEof ? normalized.length - '\n---'.length : closingIndex;
  const yamlContent = normalized.slice(4, yamlEndIndex);
  let frontmatter: unknown;
  try {
    frontmatter = YAML.parse(yamlContent);
  } catch (error) {
    throw new Error(`SKILL.md frontmatter YAML 解析失败：${normalizeYamlError(error)}`);
  }
  if (!isRecord(frontmatter)) {
    throw new Error('SKILL.md frontmatter 根节点必须是 object。');
  }

  const diagnostics = validateSkillFrontmatterCapabilities(frontmatter, 'claude-2.1.88');
  if (diagnostics.length > 0) {
    throw new Error(
      `SKILL.md frontmatter 不符合 Claude Code 2.1.88 profile：${diagnostics
        .map((entry) => `[${entry.code}] ${entry.message}`)
        .join('; ')}`,
    );
  }
  if (expectedSkillName !== undefined && frontmatter.name !== expectedSkillName) {
    throw new Error(
      `SKILL.md frontmatter 的 name 必须与 Skill 目录一致：期望 ${JSON.stringify(expectedSkillName)}。`,
    );
  }
}

export function validatePortableSkillFrontmatter(
  rawContent: string,
  expectedSkillName?: string,
): void {
  const frontmatter = parsePortableSkillFrontmatter(rawContent);
  if (typeof frontmatter.name === 'string') {
    validatePortableSkillName(frontmatter.name, 'SKILL.md frontmatter.name');
  }
  if (typeof frontmatter.description === 'string' && frontmatter.description.length > 1024) {
    throw new Error('Invalid SKILL.md frontmatter.description: expected at most 1024 characters.');
  }
  const diagnostics = validateSkillFrontmatterCapabilities(frontmatter, 'portable-agent-skills');
  if (diagnostics.length > 0) {
    throw new Error(
      `SKILL.md frontmatter 不符合 portable-agent-skills profile：${diagnostics
        .map((entry) => `[${entry.code}] ${entry.message}`)
        .join('; ')}`,
    );
  }
  if (expectedSkillName !== undefined && frontmatter.name !== expectedSkillName) {
    throw new Error(
      `SKILL.md frontmatter 的 name 必须与 Skill 目录一致：期望 ${JSON.stringify(expectedSkillName)}。`,
    );
  }
}

export function parsePortableSkillFrontmatter(rawContent: string): Record<string, unknown> {
  const normalized = rawContent.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error('SKILL.md 缺少 YAML frontmatter。');
  }
  const closingIndex = normalized.indexOf('\n---\n', 4);
  const closingAtEof = closingIndex === -1 && normalized.endsWith('\n---');
  if (closingIndex === -1 && !closingAtEof) {
    throw new Error('SKILL.md frontmatter 缺少结束分隔符。');
  }
  const yamlEndIndex = closingAtEof ? normalized.length - '\n---'.length : closingIndex;
  let frontmatter: unknown;
  try {
    frontmatter = YAML.parse(normalized.slice(4, yamlEndIndex));
  } catch (error) {
    throw new Error(`SKILL.md frontmatter YAML 解析失败：${normalizeYamlError(error)}`);
  }
  if (!isRecord(frontmatter)) {
    throw new Error('SKILL.md frontmatter 根节点必须是 object。');
  }
  return frontmatter;
}

export async function validatePortableSkillDirectory(rootDir: string): Promise<DynamicSkillTree> {
  return validateCorePortableSkillDirectory(rootDir);
}

export async function validatePortableSkillDirectoriesRoot(rootDir: string): Promise<DynamicSkillTree[]> {
  return validateCorePortableSkillDirectoriesRoot(rootDir);
}

function assertNoFileDirectoryConflicts(files: Record<string, Buffer>): void {
  const paths = sortedSkillFileEntries(files).map(([relativePath]) => relativePath);
  for (const [index, relativePath] of paths.entries()) {
    const prefix = paths.slice(0, index).find((candidate) =>
      relativePath.startsWith(`${candidate}/`));
    if (prefix) {
      throw new Error(`Skill 文件路径冲突："${prefix}" 与 "${relativePath}" 不能同时存在。`);
    }
  }
}

async function collectDirectoryFiles(
  rootDir: string,
  ownerMarkerPolicy: 'reject' | 'ignore',
): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = {};

  const visit = async (currentDir: string, parentPath: string): Promise<void> => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareSkillPaths(left.name, right.name))) {
      const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      if (isSkillAuthorOnlyPath(relativePath)) continue;
      if (relativePath === SKILL_OWNER_MARKER) {
        if (ownerMarkerPolicy === 'ignore') continue;
        throw new Error(`Skill source tree 不能声明保留文件 ${SKILL_OWNER_MARKER}。`);
      }
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Skill 静态源不支持符号链接：${relativePath}`);
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Skill 静态源只支持普通文件和目录：${relativePath}`);
      }
      files[relativePath] = await fs.readFile(absolutePath);
    }
  };

  await visit(rootDir, '');
  return files;
}

function validatePresentSkillTree(options: {
  target: CodexSkillArtifact['target'] | ClaudeSkillArtifact['target'];
  skillKey: string;
  files: Record<string, Buffer>;
}): void {
  assertNoFileDirectoryConflicts(options.files);
  const skillFile = options.files[SKILL_FILE_PATH];
  if (!skillFile || skillFile.toString('utf8').trim() === '') {
    throw new Error(`${options.target} "${options.skillKey}" 缺少 SKILL.md 内容。`);
  }
  if (options.target === 'codex.skill') {
    const openaiYaml = options.files[CODEX_OPENAI_YAML_PATH];
    if (!openaiYaml || openaiYaml.toString('utf8').trim() === '') {
      throw new Error(`codex.skill "${options.skillKey}" 缺少 agents/openai.yaml 内容。`);
    }
    validateCodexOpenAiYaml(openaiYaml.toString('utf8'));
    return;
  }
  validateClaudeSkillFrontmatter(skillFile.toString('utf8'), options.skillKey);
}

export async function validateSkillDirectory(
  rootDir: string,
  target: CodexSkillArtifact['target'] | ClaudeSkillArtifact['target'],
  options?: { ownerMarkerPolicy?: 'reject' | 'ignore' },
): Promise<DynamicSkillTree> {
  const rootStats = await fs.lstat(rootDir).catch(() => null);
  if (!rootStats || rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Skill 根路径必须是真实目录：${rootDir}`);
  }
  const tree = {
    skillKey: path.basename(rootDir),
    files: await collectDirectoryFiles(rootDir, options?.ownerMarkerPolicy ?? 'reject'),
  };
  validatePresentSkillTree({
    target,
    skillKey: tree.skillKey,
    files: tree.files,
  });
  return tree;
}

export async function validateSkillDirectoriesRoot(
  rootDir: string,
  target: CodexSkillArtifact['target'] | ClaudeSkillArtifact['target'],
): Promise<DynamicSkillTree[]> {
  const rootStats = await fs.lstat(rootDir).catch(() => null);
  if (!rootStats || rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Skills 根路径必须是真实目录：${rootDir}`);
  }
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const trees: DynamicSkillTree[] = [];
  for (const entry of entries.sort((left, right) => compareSkillPaths(left.name, right.name))) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Skills 根目录不支持符号链接：${entry.name}`);
    }
    if (!entry.isDirectory()) {
      continue;
    }
    trees.push(await validateSkillDirectory(path.join(rootDir, entry.name), target, {
      ownerMarkerPolicy: 'ignore',
    }));
  }
  return trees;
}

export async function createDynamicSkillExpectedTree(options: {
  artifact: Pick<CodexSkillArtifact | ClaudeSkillArtifact, 'target' | 'skillKey' | 'state' | 'content'>;
  sourceDirs?: string[];
  requireReadme?: boolean;
}): Promise<DynamicSkillTree> {
  const skillKey = options.artifact.skillKey?.trim();
  if (!skillKey) {
    throw new Error(`${options.artifact.target} expected tree 缺少 skillKey。`);
  }
  if (options.artifact.state !== 'present') {
    return { skillKey, files: {} };
  }

  const files: Record<string, Buffer> = {};
  for (const sourceDir of options.sourceDirs ?? []) {
    Object.assign(files, await collectDirectoryFiles(sourceDir, 'reject'));
  }
  for (const [relativePath, content] of Object.entries(options.artifact.content?.files ?? {})) {
    if (isSkillAuthorOnlyPath(relativePath)) {
      throw new Error(
        `Skill renderer 不能声明作者专用目录中的文件：${relativePath}`,
      );
    }
    if (relativePath === SKILL_OWNER_MARKER) {
      throw new Error(`Skill renderer 不能声明保留文件 ${SKILL_OWNER_MARKER}。`);
    }
    files[relativePath] = Buffer.from(content, 'utf8');
  }
  validatePresentSkillTree({
    target: options.artifact.target,
    skillKey,
    files,
  });
  if (options.requireReadme) {
    const readme = files['README.md'];
    if (!readme || readme.toString('utf8').trim() === '') {
      throw new Error(`${options.artifact.target} "${skillKey}" 缺少 README.md 内容。`);
    }
  }

  return { skillKey, files };
}

export function createDynamicSkillTreeContentDigest(tree: DynamicSkillTree): string {
  const hash = crypto.createHash('sha256');
  for (const [relativePath, content] of sortedSkillFileEntries(tree.files)) {
    const relativePathBytes = Buffer.from(relativePath, 'utf8');
    const pathLength = Buffer.alloc(8);
    const contentLength = Buffer.alloc(8);
    pathLength.writeBigUInt64BE(BigInt(relativePathBytes.length));
    contentLength.writeBigUInt64BE(BigInt(content.length));
    hash.update(pathLength);
    hash.update(relativePathBytes);
    hash.update(contentLength);
    hash.update(content);
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function skillDirectoryMatchesExpectedTree(
  rootDir: string,
  tree: DynamicSkillTree,
): Promise<boolean> {
  if (path.basename(rootDir) !== tree.skillKey) return false;
  const rootStats = await fs.lstat(rootDir).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) return false;

  const expectedFiles = new Map(sortedSkillFileEntries(tree.files));
  const expectedDirectories = new Set<string>(['']);
  for (const relativePath of expectedFiles.keys()) {
    const segments = relativePath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      expectedDirectories.add(segments.slice(0, index).join('/'));
    }
  }

  const seenFiles = new Set<string>();
  const pending = [{ absolutePath: rootDir, relativePath: '' }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await fs.readdir(current.absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = current.relativePath
        ? `${current.relativePath}/${entry.name}`
        : entry.name;
      if (relativePath === SKILL_OWNER_MARKER || entry.isSymbolicLink()) return false;
      const absolutePath = path.join(current.absolutePath, entry.name);
      if (entry.isDirectory()) {
        if (!expectedDirectories.has(relativePath)) return false;
        pending.push({ absolutePath, relativePath });
        continue;
      }
      if (!entry.isFile()) return false;
      const expected = expectedFiles.get(relativePath);
      if (!expected || !expected.equals(await fs.readFile(absolutePath))) return false;
      seenFiles.add(relativePath);
    }
  }
  return seenFiles.size === expectedFiles.size;
}

async function createEmptyStagingTree(
  stagingRoot: string,
  relativePaths: string[],
): Promise<void> {
  interface StagingPathNode {
    absolutePath: string;
    children: Map<string, StagingPathNode> | null;
  }
  const root: StagingPathNode = {
    absolutePath: stagingRoot,
    children: new Map(),
  };

  for (const relativePath of relativePaths) {
    const segments = relativePath.split('/');
    let current = root;
    for (const [index, segment] of segments.entries()) {
      const isFile = index === segments.length - 1;
      const exactNode = current.children?.get(segment);
      if (exactNode) {
        if (isFile || !exactNode.children) {
          throw new Error(
            `Skill 目标文件系统路径冲突："${relativePath}" 与已暂存路径不能同时存在。`,
          );
        }
        current = exactNode;
        continue;
      }

      const candidatePath = path.join(current.absolutePath, segment);
      if (await fs.pathExists(candidatePath)) {
        throw new Error(
          `Skill 目标文件系统路径冲突："${relativePath}" 与已暂存路径不能同时存在。`,
        );
      }
      let created: StagingPathNode;
      if (isFile) {
        await fs.writeFile(candidatePath, Buffer.alloc(0), { flag: 'wx' });
        created = { absolutePath: candidatePath, children: null };
      } else {
        await fs.mkdir(candidatePath);
        created = { absolutePath: candidatePath, children: new Map() };
      }
      current.children?.set(segment, created);
      current = created;
    }
  }
}

export async function writeDynamicSkillTree(
  rootDir: string,
  tree: DynamicSkillTree,
  ownership?: {
    allowedRoot: string;
    identity: OwnerIdentity;
    allowPristineUnowned?: boolean;
  },
): Promise<string[]> {
  const entries = sortedSkillFileEntries(tree.files);
  if (ownership) {
    await assertOwnedSkillPath({
      skillRoot: rootDir,
      allowedRoot: ownership.allowedRoot,
      identity: ownership.identity,
    });
  }
  await fs.ensureDir(path.dirname(rootDir));
  if (ownership?.allowPristineUnowned && await fs.pathExists(rootDir)) {
    const marker = await readSkillOwnerMarker({
      skillRoot: rootDir,
      allowedRoot: ownership.allowedRoot,
      expectedIdentity: ownership.identity,
    });
    if (!marker && !await skillDirectoryMatchesExpectedTree(rootDir, tree)) {
      throw new Error(`Skill 目标存在 foreign collision：${rootDir}`);
    }
  }
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(rootDir), `.${path.basename(rootDir)}-staging-`));
  const backupRoot = `${stagingRoot}-backup`;
  const targetExists = await fs.pathExists(rootDir);
  let preserveBackup = false;

  try {
    await createEmptyStagingTree(stagingRoot, entries.map(([relativePath]) => relativePath));
    const writtenPaths: string[] = [];
    for (const [relativePath, content] of entries) {
      const targetPath = path.join(stagingRoot, relativePath.split('/').join(path.sep));
      await fs.writeFile(targetPath, content);
      writtenPaths.push(path.join(rootDir, relativePath.split('/').join(path.sep)));
    }
    if (ownership) {
      await fs.writeFile(
        path.join(stagingRoot, SKILL_OWNER_MARKER),
        createSkillOwnerMarkerContent(ownership.identity),
        'utf8',
      );
    }
    if (targetExists) {
      await fs.move(rootDir, backupRoot, { overwrite: false });
    }
    await fs.move(stagingRoot, rootDir, { overwrite: false });
    await fs.remove(backupRoot);
    return writtenPaths;
  } catch (error) {
    if (!(await fs.pathExists(rootDir)) && await fs.pathExists(backupRoot)) {
      try {
        await fs.move(backupRoot, rootDir, { overwrite: false });
      } catch (restoreError) {
        preserveBackup = true;
        const originalMessage = error instanceof Error ? error.message : String(error);
        const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
        throw new Error(
          `${originalMessage}；旧 Skill 树恢复失败，备份保留在 ${backupRoot}：${restoreMessage}`,
        );
      }
    }
    throw error;
  } finally {
    await fs.remove(stagingRoot).catch(() => undefined);
    if (!preserveBackup) {
      await fs.remove(backupRoot).catch(() => undefined);
    }
  }
}

export async function readDynamicSkillTree(
  rootDir: string,
  target: CodexSkillArtifact['target'] | ClaudeSkillArtifact['target'],
): Promise<DynamicSkillTree | null> {
  const rootStats = await fs.lstat(rootDir).catch(() => null);
  if (!rootStats) {
    return null;
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Skill runtime 根路径必须是真实目录：${rootDir}`);
  }
  const files = await collectDirectoryFiles(rootDir, 'ignore');
  if (!files[SKILL_FILE_PATH] || (target === 'codex.skill' && !files[CODEX_OPENAI_YAML_PATH])) {
    return null;
  }
  const tree = { skillKey: path.basename(rootDir), files };
  validatePresentSkillTree({
    target,
    skillKey: tree.skillKey,
    files,
  });
  return tree;
}
