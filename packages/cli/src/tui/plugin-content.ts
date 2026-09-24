import path from 'node:path';
import { open } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';

import fs from 'fs-extra';

import type { PluginMeta } from '../types.js';
import { parseSkillFrontmatter } from '../utils/skill-validation.js';

export type PluginContentType =
  | 'skill'
  | 'agent'
  | 'role'
  | 'instruction'
  | 'permission'
  | 'hook'
  | 'command'
  | 'mcpServer'
  | 'app';

export type PluginContentTool = 'Codex' | 'Claude Code' | 'Agent Skills';

export interface PluginContentIssue {
  code: 'unsafePath' | 'unreadable' | 'invalidMetadata' | 'incompleteList';
  message: string;
}

export interface PluginContentItem {
  id: string;
  name: string;
  type: PluginContentType;
  description: string | null;
  tools: PluginContentTool[];
  // Optional while existing TUI consumers move to the structured reading state.
  descriptionState?: 'available' | 'absent' | 'issue';
  issue?: PluginContentIssue;
}

export interface PluginContentOverview {
  pluginId: string;
  pluginVersion: string;
  catalogVersion: string;
  evidence: 'catalogBundle' | 'unavailable';
  items: PluginContentItem[];
  notices: string[];
  coverage?: 'complete' | 'partial' | 'unavailable';
  coverageIssue?: PluginContentIssue;
}

const MAX_FRONTMATTER_BYTES = 16 * 1024;
const TOOL_ORDER: PluginContentTool[] = ['Codex', 'Claude Code', 'Agent Skills'];

function sortTools(tools: PluginContentTool[]): PluginContentTool[] {
  return [...new Set(tools)].sort((left, right) => TOOL_ORDER.indexOf(left) - TOOL_ORDER.indexOf(right));
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function regularPathWithin(root: string, candidate: string, kind: 'file' | 'directory') {
  const lexical = path.resolve(candidate);
  if (!within(root, lexical)) return null;
  const relative = path.relative(root, lexical);
  let current = root;
  let stats: Stats | undefined;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    stats = await fs.lstat(current).catch(() => undefined);
    if (!stats || stats.isSymbolicLink()) return null;
  }
  stats ??= await fs.lstat(lexical).catch(() => undefined);
  if (!stats || stats.isSymbolicLink()) return null;
  if (kind === 'file' ? !stats.isFile() : !stats.isDirectory()) return null;
  const real = await fs.realpath(lexical).catch(() => undefined);
  return real && within(root, real) ? real : null;
}

async function unconfirmedPathCode(
  root: string,
  candidate: string,
): Promise<'unsafePath' | 'unreadable' | 'incompleteList'> {
  const lexical = path.resolve(candidate);
  if (!within(root, lexical)) return 'unsafePath';
  let current = root;
  for (const segment of path.relative(root, lexical).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stats: Stats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'incompleteList' : 'unreadable';
    }
    if (stats.isSymbolicLink() || (!stats.isDirectory() && current !== lexical)) return 'unsafePath';
  }
  return 'unsafePath';
}

async function readFrontmatterDescription(
  root: string,
  skillFile: string,
): Promise<{ exists: boolean; description: string | null; issue?: PluginContentIssue }> {
  const safeFile = await regularPathWithin(root, skillFile, 'file');
  if (!safeFile) return { exists: false, description: null };
  let handle;
  try {
    handle = await open(safeFile, 'r');
  } catch {
    return { exists: true, description: null, issue: {
      code: 'unreadable', message: '简介文件无法读取。请检查目录内容后重试。',
    } };
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    let frontmatterEnd = -1;
    let reachedEof = false;
    while (total < MAX_FRONTMATTER_BYTES && frontmatterEnd === -1) {
      const buffer = Buffer.alloc(Math.min(512, MAX_FRONTMATTER_BYTES - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) {
        reachedEof = true;
        break;
      }
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      frontmatterEnd = Buffer.concat(chunks).toString('utf8').replace(/\r\n/gu, '\n').indexOf('\n---\n', 4);
    }
    const normalized = Buffer.concat(chunks).toString('utf8').replace(/\r\n/gu, '\n');
    const closingAtEnd = frontmatterEnd === -1 && normalized.endsWith('\n---')
      && (reachedEof || (await handle.stat()).size === total);
    if (frontmatterEnd === -1 && !closingAtEnd) return { exists: true, description: null, issue: {
      code: 'invalidMetadata', message: '简介元信息无效或超过读取预算。请检查内容文件。',
    } };
    const header = closingAtEnd ? normalized : normalized.slice(0, frontmatterEnd + '\n---\n'.length);
    const parsed = parseSkillFrontmatter(header, 'SKILL.md');
    if (parsed.errors.length > 0) return { exists: true, description: null, issue: {
      code: 'invalidMetadata', message: '简介元信息无法解析。请检查内容文件。',
    } };
    const metadata = parsed.frontmatter?.metadata;
    const short = isRecord(metadata) ? metadata['short-description'] : undefined;
    if (short !== undefined && (typeof short !== 'string' || !short.trim())) {
      return { exists: true, description: null, issue: {
        code: 'invalidMetadata', message: '简短用途元信息无效。请检查内容文件。',
      } };
    }
    const description = typeof short === 'string' && short.trim()
      ? short : parsed.frontmatter?.description;
    if (description !== undefined && typeof description !== 'string') {
      return { exists: true, description: null, issue: {
        code: 'invalidMetadata', message: '简介元信息类型无效。请检查内容文件。',
      } };
    }
    const safeDescription = typeof description === 'string'
      ? stripVTControlCharacters(description)
        .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ')
        .replace(/\s+/gu, ' ').trim()
      : '';
    const sentence = short ? safeDescription
      : safeDescription.match(/^.*?(?:[。！？]|[.!?](?=\s|$)|$)/u)?.[0] ?? safeDescription;
    const points = [...sentence];
    return {
      exists: true,
      description: points.length > 120 ? `${points.slice(0, 119).join('')}…` : sentence || null,
    };
  } catch {
    return { exists: true, description: null, issue: {
      code: 'unreadable', message: '简介文件无法读取。请检查目录内容后重试。',
    } };
  } finally {
    await handle.close();
  }
}

function addItem(
  items: Map<string, PluginContentItem>,
  item: PluginContentItem,
): void {
  const key = `${item.type}:${item.name}`;
  const current = items.get(key);
  if (!current) {
    items.set(key, item);
    return;
  }
  current.tools = sortTools([...current.tools, ...item.tools]);
  if (current.description === null && item.description !== null) current.description = item.description;
  if (item.issue) {
    current.descriptionState = 'issue';
    current.issue = item.issue;
  } else if (current.descriptionState !== 'issue' && current.description !== null) {
    current.descriptionState = 'available';
  }
}

function addCoverageIssue(issues: PluginContentIssue[], issue: PluginContentIssue): void {
  issues.push(issue);
}

async function addSkillDirectory(options: {
  root: string;
  relativePath: string;
  tool: PluginContentTool;
  items: Map<string, PluginContentItem>;
  coverageIssues: PluginContentIssue[];
}): Promise<void> {
  const directory = await regularPathWithin(options.root, path.join(options.root, options.relativePath), 'directory');
  if (!directory) {
    const code = await unconfirmedPathCode(options.root, path.join(options.root, options.relativePath));
    addCoverageIssue(options.coverageIssues, {
      code, message: `${options.tool} Skill 清单无法确认。请检查目录。`,
    });
    return;
  }
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    addCoverageIssue(options.coverageIssues, {
      code: 'unreadable', message: `${options.tool} Skill 清单无法读取。请检查目录后重试。`,
    });
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) {
      addCoverageIssue(options.coverageIssues, {
        code: 'unsafePath', message: `${options.tool} Skill 清单含不安全路径。请检查目录。`,
      });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const skillRoot = await regularPathWithin(options.root, path.join(directory, entry.name), 'directory');
    if (!skillRoot) {
      const code = await unconfirmedPathCode(options.root, path.join(directory, entry.name));
      addCoverageIssue(options.coverageIssues, {
        code, message: `${options.tool} Skill 清单含无法确认的条目。请检查目录。`,
      });
      continue;
    }
    const skillFile = path.join(skillRoot, 'SKILL.md');
    const skill = await readFrontmatterDescription(options.root, skillFile);
    let issue = skill.issue;
    if (!skill.exists) {
      const code = await unconfirmedPathCode(options.root, skillFile);
      if (code === 'incompleteList') {
        addCoverageIssue(options.coverageIssues, {
          code, message: `${options.tool} Skill 清单有无法确认的条目。请检查目录。`,
        });
        continue;
      }
      issue = { code, message: 'Skill 元信息文件不可安全读取。请检查内容目录后重试。' };
    }
    if (options.tool === 'Codex'
      && options.items.get(`command:${entry.name}`)?.tools.includes('Codex')) continue;
    addItem(options.items, {
      id: `skill:${entry.name}`,
      name: entry.name,
      type: 'skill',
      description: skill.description,
      tools: [options.tool],
      descriptionState: issue ? 'issue' : skill.description ? 'available' : 'absent',
      ...(issue ? { issue } : {}),
    });
  }
}

async function addJsonComponents(options: {
  root: string;
  relativePath: string;
  property: 'mcpServers' | 'apps';
  type: 'mcpServer' | 'app';
  tool: PluginContentTool;
  items: Map<string, PluginContentItem>;
  coverageIssues: PluginContentIssue[];
}): Promise<void> {
  const file = await regularPathWithin(options.root, path.join(options.root, options.relativePath), 'file');
  if (!file) {
    const code = await unconfirmedPathCode(options.root, path.join(options.root, options.relativePath));
    addCoverageIssue(options.coverageIssues, {
      code, message: `${options.tool} ${options.type} 清单无法确认。请检查目录。`,
    });
    return;
  }
  let value: unknown;
  try {
    value = await fs.readJson(file);
  } catch {
    addCoverageIssue(options.coverageIssues, {
      code: 'unreadable', message: `${options.tool} ${options.type} 清单无法读取。请检查内容文件。`,
    });
    return;
  }
  const collection = isRecord(value) ? value[options.property] : undefined;
  if (!isRecord(collection)) {
    addCoverageIssue(options.coverageIssues, {
      code: 'incompleteList', message: `${options.tool} ${options.type} 清单格式无效。请检查内容文件。`,
    });
    return;
  }
  const entries = Object.keys(collection).sort();
  for (const name of entries) {
    addItem(options.items, {
      id: `${options.type}:${name}`,
      name,
      type: options.type,
      description: null,
      tools: [options.tool],
      descriptionState: 'absent',
    });
  }
}

async function addSlashCommands(options: {
  root: string;
  hasCodex: boolean;
  items: Map<string, PluginContentItem>;
  coverageIssues: PluginContentIssue[];
}): Promise<void> {
  const directory = await regularPathWithin(
    options.root,
    path.join(options.root, 'claude', 'commands'),
    'directory',
  );
  if (!directory) {
    const code = await unconfirmedPathCode(options.root, path.join(options.root, 'claude', 'commands'));
    addCoverageIssue(options.coverageIssues, {
      code, message: 'Slash command 清单无法确认。请检查目录。',
    });
    return;
  }
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    addCoverageIssue(options.coverageIssues, {
      code: 'unreadable', message: 'Slash command 清单无法读取。请检查目录后重试。',
    });
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (path.extname(entry.name) !== '.md') continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      addCoverageIssue(options.coverageIssues, {
        code: 'unsafePath', message: 'Slash command 清单含无法确认的条目。请检查目录。',
      });
      continue;
    }
    if (!await regularPathWithin(options.root, path.join(directory, entry.name), 'file')) {
      addCoverageIssue(options.coverageIssues, {
        code: 'unsafePath', message: 'Slash command 清单含不安全路径。请检查目录。',
      });
      continue;
    }
    const name = path.basename(entry.name, '.md');
    const tools: PluginContentTool[] = ['Claude Code'];
    const codexSkillFile = path.join(options.root, 'codex', 'skills', name, 'SKILL.md');
    const codexCommand = options.hasCodex
      && await regularPathWithin(options.root, codexSkillFile, 'file');
    if (options.hasCodex && !codexCommand && await fs.lstat(codexSkillFile).catch(() => undefined)) {
      if (await regularPathWithin(options.root, path.dirname(codexSkillFile), 'directory')) {
        addItem(options.items, {
          id: `skill:${name}`,
          name,
          type: 'skill',
          description: null,
          tools: ['Codex'],
          descriptionState: 'issue',
          issue: { code: 'unsafePath', message: 'Skill 元信息文件不可安全读取。请检查内容目录后重试。' },
        });
      } else {
        addCoverageIssue(options.coverageIssues, {
          code: 'unsafePath', message: 'Slash command 的 Codex 组件不可安全确认。请检查目录。',
        });
      }
    }
    const skill = codexCommand
      ? await readFrontmatterDescription(options.root, codexSkillFile)
      : undefined;
    if (codexCommand) tools.unshift('Codex');
    addItem(options.items, {
      id: `command:${name}`,
      name,
      type: 'command',
      description: skill?.description ?? null,
      tools,
      descriptionState: skill?.issue ? 'issue' : skill?.description ? 'available' : 'absent',
      ...(skill?.issue ? { issue: skill.issue } : {}),
    });
  }
}

function targetTool(target: string): PluginContentTool | null {
  if (target.startsWith('codex.')) return 'Codex';
  if (target.startsWith('claude.')) return 'Claude Code';
  if (target.startsWith('agent-skills.')) return 'Agent Skills';
  return null;
}

function targetType(target: string): PluginContentType | null {
  if (target.endsWith('.skill')) return 'skill';
  if (target === 'codex.agentRole') return 'role';
  if (target === 'codex.developerInstructionsBlock') return 'instruction';
  return null;
}

function toolsForOverrides(
  tools: PluginContentTool[],
  overrides?: { codex?: unknown; claude?: unknown },
): PluginContentTool[] {
  return tools.filter((tool) => {
    if (tool === 'Codex') return overrides?.codex !== null;
    if (tool === 'Claude Code') return overrides?.claude !== null;
    return true;
  });
}

async function projectedPlatforms(root: string): Promise<PluginContentTool[]> {
  const tools: PluginContentTool[] = [];
  if (await regularPathWithin(root, path.join(root, '.codex-plugin', 'plugin.json'), 'file')) tools.push('Codex');
  if (await regularPathWithin(root, path.join(root, '.claude-plugin', 'plugin.json'), 'file')) tools.push('Claude Code');
  return tools;
}

export async function projectPluginContentOverview(options: {
  pluginId: string;
  catalogVersion: string;
  plugin: PluginMeta;
}): Promise<PluginContentOverview> {
  let root: string;
  try {
    root = await fs.realpath(options.plugin.rootDir);
  } catch {
    const message = '当前无法安全读取这个插件的目录内容。请检查来源状态后重试。';
    return {
      pluginId: options.pluginId,
      pluginVersion: options.plugin.manifest.version,
      catalogVersion: options.catalogVersion,
      evidence: 'unavailable',
      items: [],
      notices: [message],
      coverage: 'unavailable',
      coverageIssue: { code: 'unreadable', message },
    };
  }
  const items = new Map<string, PluginContentItem>();
  const coverageIssues: PluginContentIssue[] = [];
  const platforms = await projectedPlatforms(root);

  if (platforms.length === 0 && (options.plugin.manifest.skills
    || options.plugin.manifest.mcpServers || options.plugin.manifest.apps)) {
    addCoverageIssue(coverageIssues, {
      code: 'incompleteList', message: '插件声明了内容，但没有可安全确认的平台清单。请检查目录。',
    });
  } else if (options.plugin.manifest.apps && !platforms.includes('Codex')) {
    addCoverageIssue(coverageIssues, {
      code: 'incompleteList', message: '插件声明了 App，但没有可安全确认的 Codex 清单。请检查目录。',
    });
  }

  if (options.plugin.manifest.slashCommands) {
    await addSlashCommands({
      root,
      hasCodex: platforms.includes('Codex'),
      items,
      coverageIssues,
    });
  }

  if (options.plugin.manifest.skills) {
    if (platforms.includes('Codex')) {
      await addSkillDirectory({
        root, relativePath: 'codex/skills', tool: 'Codex', items, coverageIssues,
      });
    }
    if (platforms.includes('Claude Code')) {
      await addSkillDirectory({
        root, relativePath: 'claude/skills', tool: 'Claude Code', items, coverageIssues,
      });
    }
  }
  if (options.plugin.manifest.distributions?.agentSkills?.skills) {
    await addSkillDirectory({
      root, relativePath: 'agent-skills/skills', tool: 'Agent Skills', items, coverageIssues,
    });
  }
  if (options.plugin.manifest.mcpServers) {
    for (const tool of platforms) {
      await addJsonComponents({
        root,
        relativePath: `${tool === 'Codex' ? 'codex' : 'claude'}/${options.plugin.manifest.mcpServers.replace(/^\.\//u, '')}`,
        property: 'mcpServers',
        type: 'mcpServer',
        tool,
        items,
        coverageIssues,
      });
    }
  }
  if (options.plugin.manifest.apps && platforms.includes('Codex')) {
    await addJsonComponents({
      root,
      relativePath: `codex/${options.plugin.manifest.apps.replace(/^\.\//u, '')}`,
      property: 'apps',
      type: 'app',
      tool: 'Codex',
      items,
      coverageIssues,
    });
  }
  for (const agent of options.plugin.manifest.extensions?.agents ?? []) {
    addItem(items, {
      id: `agent:${agent.name}`,
      name: agent.name,
      type: 'agent',
      description: agent.description.trim() || null,
      tools: toolsForOverrides(platforms, agent.agentOverrides),
      descriptionState: agent.description.trim() ? 'available' : 'absent',
    });
  }
  for (const instruction of options.plugin.manifest.extensions?.instructions ?? []) {
    addItem(items, {
      id: `instruction:${instruction.name}`,
      name: instruction.title,
      type: 'instruction',
      description: null,
      tools: toolsForOverrides(platforms, instruction.agentOverrides),
      descriptionState: 'absent',
    });
  }
  for (const permission of options.plugin.manifest.extensions?.permissions ?? []) {
    addItem(items, {
      id: `permission:${permission.name}`,
      name: permission.name,
      type: 'permission',
      description: null,
      tools: toolsForOverrides(platforms, permission.agentOverrides),
      descriptionState: 'absent',
    });
  }
  for (const hook of options.plugin.manifest.extensions?.hooks ?? []) {
    const name = hook.matcher ? `${hook.event} · ${hook.matcher}` : hook.event;
    addItem(items, {
      id: `hook:${hook.event}:${hook.matcher ?? ''}`,
      name,
      type: 'hook',
      description: null,
      tools: toolsForOverrides(platforms, hook.agentOverrides),
      descriptionState: 'absent',
    });
  }
  for (const [platform, hooks] of Object.entries(options.plugin.manifest.extensions?.nativeHooks ?? {})) {
    const tool = platform === 'codex' ? 'Codex' : 'Claude Code';
    for (const hook of hooks ?? []) {
      const name = hook.matcher ? `${hook.event} · ${hook.matcher}` : hook.event;
      addItem(items, {
        id: `hook:${platform}:${hook.event}:${hook.matcher ?? ''}`,
        name,
        type: 'hook',
        description: null,
        tools: [tool],
        descriptionState: 'absent',
      });
    }
  }

  for (const target of options.plugin.manifest.artifacts?.targets ?? []) {
    const tool = targetTool(target.target);
    const type = targetType(target.target);
    if (!tool || !type) continue;
    const name = target.skillKey ?? target.roleKey ?? target.id;
    let description: string | null = null;
    let issue: PluginContentIssue | undefined;
    if (type === 'skill' && target.platform) {
      const skill = await readFrontmatterDescription(root, path.join(
        root,
        '.agents-plugin',
        'artifact-sources',
        target.platform,
        target.id,
        '0',
        'SKILL.md',
      ));
      description = skill.description;
      issue = skill.issue;
      if (!skill.exists) {
        const code = await unconfirmedPathCode(root, path.join(
          root, '.agents-plugin', 'artifact-sources', target.platform, target.id, '0', 'SKILL.md',
        ));
        if (code !== 'incompleteList') issue = {
          code, message: '简介文件不可安全读取。请检查内容目录。',
        };
      }
    }
    addItem(items, {
      id: `artifact:${target.id}`,
      name,
      type,
      description,
      tools: [tool],
      descriptionState: issue ? 'issue' : description ? 'available' : 'absent',
      ...(issue ? { issue } : {}),
    });
  }

  const result = [...items.values()].sort((left, right) =>
    left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
  const coverage = coverageIssues.length === 0
    ? 'complete' : result.length > 0 ? 'partial' : 'unavailable';
  const notices = [...new Set(coverageIssues.map((issue) => issue.message))];
  return {
    pluginId: options.pluginId,
    pluginVersion: options.plugin.manifest.version,
    catalogVersion: options.catalogVersion,
    evidence: 'catalogBundle',
    items: result,
    notices,
    coverage,
    ...(coverageIssues[0] ? { coverageIssue: coverageIssues[0] } : {}),
  };
}
