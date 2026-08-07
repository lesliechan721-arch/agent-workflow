import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import YAML from 'yaml';

import type {
  ClaudeSkillArtifact,
  CodexSkillArtifact,
  SkillTriggerPolicy,
  SkillTriggerPreference,
} from '../types.js';

export const SKILL_FILE_PATH = 'SKILL.md';
export const CODEX_OPENAI_YAML_PATH = 'agents/openai.yaml';

export interface DynamicSkillTree {
  skillKey: string;
  files: Record<string, Buffer>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeYamlError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveEffectiveTriggerPreference(
  policy: SkillTriggerPolicy | undefined,
  preference: SkillTriggerPreference,
): Exclude<SkillTriggerPreference, 'default'> {
  const defaultTrigger = policy?.defaultTrigger ?? 'auto';
  if (preference === 'default' || policy?.allowDynamicTrigger === false) {
    return defaultTrigger;
  }
  return preference;
}

export function renderCodexOpenAiYamlWithAllowImplicitInvocation(options: {
  rawContent: string;
  allowImplicitInvocation: boolean;
}): string {
  let parsed: unknown;
  try {
    parsed = YAML.parse(options.rawContent);
  } catch (error) {
    throw new Error(`openai.yaml YAML 解析失败：${normalizeYamlError(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('openai.yaml 根节点必须是 object。');
  }
  if (parsed.policy === undefined) {
    parsed.policy = {};
  } else if (!isRecord(parsed.policy)) {
    throw new Error('openai.yaml 的 policy 必须是 object。');
  }
  const policy = parsed.policy;
  if (!isRecord(policy)) {
    throw new Error('openai.yaml 的 policy 必须是 object。');
  }
  policy.allow_implicit_invocation = options.allowImplicitInvocation;
  return YAML.stringify(parsed);
}

function renderClaudeSkillWithPreference(options: {
  rawContent: string;
  preference: Exclude<SkillTriggerPreference, 'default'>;
}): string {
  const normalized = options.rawContent.replace(/\r\n/g, '\n');
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
  const body = closingAtEof ? '' : normalized.slice(yamlEndIndex + '\n---\n'.length);
  let frontmatter: unknown;
  try {
    frontmatter = YAML.parse(yamlContent);
  } catch (error) {
    throw new Error(`SKILL.md frontmatter YAML 解析失败：${normalizeYamlError(error)}`);
  }
  if (!isRecord(frontmatter)) {
    throw new Error('SKILL.md frontmatter 根节点必须是 object。');
  }

  if (options.preference === 'manual') {
    frontmatter['disable-model-invocation'] = true;
    frontmatter['user-invocable'] = true;
  } else {
    frontmatter['disable-model-invocation'] = false;
  }
  return `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n${body}`;
}

function assertNoFileDirectoryConflicts(files: Record<string, Buffer>): void {
  const paths = Object.keys(files).sort();
  for (const [index, relativePath] of paths.entries()) {
    const prefix = paths.slice(0, index).find((candidate) =>
      relativePath.startsWith(`${candidate}/`));
    if (prefix) {
      throw new Error(`Skill 文件路径冲突："${prefix}" 与 "${relativePath}" 不能同时存在。`);
    }
  }
}

async function collectDirectoryFiles(rootDir: string): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = {};

  const visit = async (currentDir: string, parentPath: string): Promise<void> => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
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

export async function createDynamicSkillExpectedTree(options: {
  artifact: Pick<CodexSkillArtifact | ClaudeSkillArtifact, 'target' | 'skillKey' | 'state' | 'content'>;
  sourceDirs?: string[];
  preference: SkillTriggerPreference;
  policy?: SkillTriggerPolicy;
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
    Object.assign(files, await collectDirectoryFiles(sourceDir));
  }
  for (const [relativePath, content] of Object.entries(options.artifact.content?.files ?? {})) {
    files[relativePath] = Buffer.from(content, 'utf8');
  }
  assertNoFileDirectoryConflicts(files);

  const skillFile = files[SKILL_FILE_PATH];
  if (!skillFile || skillFile.toString('utf8').trim() === '') {
    throw new Error(`${options.artifact.target} "${skillKey}" 缺少 SKILL.md 内容。`);
  }
  const preference = resolveEffectiveTriggerPreference(options.policy, options.preference);
  if (options.artifact.target === 'codex.skill') {
    const openaiYaml = files[CODEX_OPENAI_YAML_PATH];
    if (!openaiYaml || openaiYaml.toString('utf8').trim() === '') {
      throw new Error(`codex.skill "${skillKey}" 缺少 agents/openai.yaml 内容。`);
    }
    files[CODEX_OPENAI_YAML_PATH] = Buffer.from(
      renderCodexOpenAiYamlWithAllowImplicitInvocation({
        rawContent: openaiYaml.toString('utf8'),
        allowImplicitInvocation: preference === 'auto',
      }),
      'utf8',
    );
  } else {
    files[SKILL_FILE_PATH] = Buffer.from(
      renderClaudeSkillWithPreference({
        rawContent: skillFile.toString('utf8'),
        preference,
      }),
      'utf8',
    );
  }

  return { skillKey, files };
}

export function createDynamicSkillTreeContentDigest(tree: DynamicSkillTree): string {
  const hash = crypto.createHash('sha256');
  for (const [relativePath, content] of Object.entries(tree.files).sort(([left], [right]) =>
    left.localeCompare(right))) {
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

export async function writeDynamicSkillTree(
  rootDir: string,
  tree: DynamicSkillTree,
): Promise<string[]> {
  await fs.ensureDir(path.dirname(rootDir));
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(rootDir), `.${path.basename(rootDir)}-staging-`));
  const backupRoot = `${stagingRoot}-backup`;
  const targetExists = await fs.pathExists(rootDir);
  let preserveBackup = false;

  try {
    const writtenPaths: string[] = [];
    for (const [relativePath, content] of Object.entries(tree.files).sort(([left], [right]) =>
      left.localeCompare(right))) {
      const targetPath = path.join(stagingRoot, relativePath.split('/').join(path.sep));
      await fs.ensureDir(path.dirname(targetPath));
      await fs.writeFile(targetPath, content);
      writtenPaths.push(path.join(rootDir, relativePath.split('/').join(path.sep)));
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
  const files = await collectDirectoryFiles(rootDir);
  if (!files[SKILL_FILE_PATH] || (target === 'codex.skill' && !files[CODEX_OPENAI_YAML_PATH])) {
    return null;
  }
  return { skillKey: path.basename(rootDir), files };
}
