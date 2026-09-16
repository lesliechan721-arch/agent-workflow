import path from 'node:path';
import { open } from 'node:fs/promises';
import type { Stats } from 'node:fs';

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

export interface PluginContentItem {
  id: string;
  name: string;
  type: PluginContentType;
  description: string | null;
  tools: PluginContentTool[];
}

export interface PluginContentOverview {
  pluginId: string;
  pluginVersion: string;
  catalogVersion: string;
  evidence: 'catalogBundle' | 'unavailable';
  items: PluginContentItem[];
  notices: string[];
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

async function readFrontmatterDescription(
  root: string,
  skillFile: string,
): Promise<{ exists: boolean; description: string | null }> {
  const safeFile = await regularPathWithin(root, skillFile, 'file');
  if (!safeFile) return { exists: false, description: null };
  const handle = await open(safeFile, 'r');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    let frontmatterEnd = -1;
    while (total < MAX_FRONTMATTER_BYTES && frontmatterEnd === -1) {
      const buffer = Buffer.alloc(Math.min(512, MAX_FRONTMATTER_BYTES - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      frontmatterEnd = Buffer.concat(chunks).toString('utf8').replace(/\r\n/gu, '\n').indexOf('\n---\n', 4);
    }
    if (frontmatterEnd === -1) return { exists: true, description: null };
    const normalized = Buffer.concat(chunks).toString('utf8').replace(/\r\n/gu, '\n');
    const header = normalized.slice(0, frontmatterEnd + '\n---\n'.length);
    const parsed = parseSkillFrontmatter(header, 'SKILL.md');
    const description = parsed.frontmatter?.description;
    return {
      exists: true,
      description: typeof description === 'string' && description.trim() ? description.trim() : null,
    };
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
}

async function addSkillDirectory(options: {
  root: string;
  relativePath: string;
  tool: PluginContentTool;
  items: Map<string, PluginContentItem>;
  notices: string[];
}): Promise<void> {
  const directory = await regularPathWithin(options.root, path.join(options.root, options.relativePath), 'directory');
  if (!directory) {
    options.notices.push(`${options.tool} Skill 清单不可安全读取。`);
    return;
  }
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const skillRoot = await regularPathWithin(options.root, path.join(directory, entry.name), 'directory');
    if (!skillRoot) continue;
    const skill = await readFrontmatterDescription(
      options.root,
      path.join(skillRoot, 'SKILL.md'),
    );
    if (!skill.exists) continue;
    addItem(options.items, {
      id: `skill:${entry.name}`,
      name: entry.name,
      type: 'skill',
      description: skill.description,
      tools: [options.tool],
    });
    if (skill.description === null) options.notices.push(`Skill ${entry.name} 没有安全可读的简短用途。`);
  }
}

async function addJsonComponents(options: {
  root: string;
  relativePath: string;
  property: 'mcpServers' | 'apps';
  type: 'mcpServer' | 'app';
  tool: PluginContentTool;
  items: Map<string, PluginContentItem>;
  notices: string[];
}): Promise<void> {
  const file = await regularPathWithin(options.root, path.join(options.root, options.relativePath), 'file');
  if (!file) {
    options.notices.push(`${options.tool} ${options.type} 清单不可安全读取。`);
    return;
  }
  let value: unknown;
  try {
    value = await fs.readJson(file);
  } catch {
    options.notices.push(`${options.tool} ${options.type} 清单不可安全读取。`);
    return;
  }
  const collection = isRecord(value) ? value[options.property] : undefined;
  const entries = isRecord(collection) ? Object.keys(collection).sort() : [];
  if (entries.length === 0) {
    options.notices.push(`${options.tool} ${options.type} 清单没有可确认的组件名称。`);
  }
  for (const name of entries) {
    addItem(options.items, {
      id: `${options.type}:${name}`,
      name,
      type: options.type,
      description: null,
      tools: [options.tool],
    });
  }
}

async function addSlashCommands(options: {
  root: string;
  hasCodex: boolean;
  items: Map<string, PluginContentItem>;
  notices: string[];
}): Promise<void> {
  const directory = await regularPathWithin(
    options.root,
    path.join(options.root, 'claude', 'commands'),
    'directory',
  );
  if (!directory) {
    options.notices.push('Slash command 清单没有可安全确认的组件名称。');
    return;
  }
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || path.extname(entry.name) !== '.md') continue;
    const name = path.basename(entry.name, '.md');
    const tools: PluginContentTool[] = ['Claude Code'];
    const codexSkillFile = path.join(options.root, 'codex', 'skills', name, 'SKILL.md');
    const codexCommand = options.hasCodex
      && await regularPathWithin(options.root, codexSkillFile, 'file');
    if (codexCommand) tools.unshift('Codex');
    options.items.delete(`skill:${name}`);
    addItem(options.items, {
      id: `command:${name}`,
      name,
      type: 'command',
      description: codexCommand
        ? (await readFrontmatterDescription(options.root, codexSkillFile)).description
        : null,
      tools,
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
  const root = await fs.realpath(options.plugin.rootDir);
  const items = new Map<string, PluginContentItem>();
  const notices: string[] = [];
  const platforms = await projectedPlatforms(root);

  if (options.plugin.manifest.skills) {
    await Promise.all([
      ...(platforms.includes('Codex') ? [addSkillDirectory({
        root, relativePath: 'codex/skills', tool: 'Codex', items, notices,
      })] : []),
      ...(platforms.includes('Claude Code') ? [addSkillDirectory({
        root, relativePath: 'claude/skills', tool: 'Claude Code', items, notices,
      })] : []),
    ]);
  }
  if (options.plugin.manifest.distributions?.agentSkills?.skills) {
    await addSkillDirectory({
      root, relativePath: 'agent-skills/skills', tool: 'Agent Skills', items, notices,
    });
  }
  if (options.plugin.manifest.mcpServers) {
    await Promise.all(platforms.map((tool) => addJsonComponents({
      root,
      relativePath: `${tool === 'Codex' ? 'codex' : 'claude'}/${options.plugin.manifest.mcpServers!.replace(/^\.\//u, '')}`,
      property: 'mcpServers',
      type: 'mcpServer',
      tool,
      items,
      notices,
    })));
  }
  if (options.plugin.manifest.apps && platforms.includes('Codex')) {
    await addJsonComponents({
      root,
      relativePath: `codex/${options.plugin.manifest.apps.replace(/^\.\//u, '')}`,
      property: 'apps',
      type: 'app',
      tool: 'Codex',
      items,
      notices,
    });
  }
  if (options.plugin.manifest.slashCommands) {
    await addSlashCommands({
      root,
      hasCodex: platforms.includes('Codex'),
      items,
      notices,
    });
  }

  for (const agent of options.plugin.manifest.extensions?.agents ?? []) {
    addItem(items, {
      id: `agent:${agent.name}`,
      name: agent.name,
      type: 'agent',
      description: agent.description.trim() || null,
      tools: toolsForOverrides(platforms, agent.agentOverrides),
    });
  }
  for (const instruction of options.plugin.manifest.extensions?.instructions ?? []) {
    addItem(items, {
      id: `instruction:${instruction.name}`,
      name: instruction.title,
      type: 'instruction',
      description: null,
      tools: toolsForOverrides(platforms, instruction.agentOverrides),
    });
  }
  for (const permission of options.plugin.manifest.extensions?.permissions ?? []) {
    addItem(items, {
      id: `permission:${permission.name}`,
      name: permission.name,
      type: 'permission',
      description: null,
      tools: toolsForOverrides(platforms, permission.agentOverrides),
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
      });
    }
  }

  for (const target of options.plugin.manifest.artifacts?.targets ?? []) {
    const tool = targetTool(target.target);
    const type = targetType(target.target);
    if (!tool || !type) continue;
    const name = target.skillKey ?? target.roleKey ?? target.id;
    let description: string | null = null;
    if (type === 'skill' && target.platform) {
      description = (await readFrontmatterDescription(root, path.join(
        root,
        '.agents-plugin',
        'artifact-sources',
        target.platform,
        target.id,
        '0',
        'SKILL.md',
      ))).description;
    }
    addItem(items, {
      id: `artifact:${target.id}`,
      name,
      type,
      description,
      tools: [tool],
    });
    if (description === null) notices.push(`${type} ${name} 没有安全可读的简短用途。`);
  }

  const result = [...items.values()].sort((left, right) =>
    left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
  if (result.length === 0) notices.push('此目录版本没有可安全确认的内容清单。');
  return {
    pluginId: options.pluginId,
    pluginVersion: options.plugin.manifest.version,
    catalogVersion: options.catalogVersion,
    evidence: 'catalogBundle',
    items: result,
    notices: [...new Set(notices)],
  };
}
