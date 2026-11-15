import path from 'node:path';
import { open } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';

import fs from 'fs-extra';

import type { PluginMeta, PlatformTarget } from '../types.js';
import { isPlatformTarget } from '@lesliechan721/aw-plugin-core';
import { TARGET_DISPLAY_NAMES } from '../platforms/discovery.js';
import { parseSkillFrontmatter } from '../utils/skill-validation.js';
import { resolveSupportedPlatforms } from '../utils/platform-support.js';

export type PluginContentType = 'skill' | 'agent' | 'instruction' | 'permission' | 'hook' | 'mcpServer' | 'renderer';
export type PluginContentTool = (typeof TARGET_DISPLAY_NAMES)[PlatformTarget];

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
const TOOL_ORDER = Object.values(TARGET_DISPLAY_NAMES);

function safeSummary(description: string, short: boolean): string | null {
  const safeDescription = stripVTControlCharacters(description)
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  const sentence = short ? safeDescription
    : safeDescription.match(/^.*?(?:[。！？]|[.!?](?=\s|$)|$)/u)?.[0] ?? safeDescription;
  const points = [...sentence];
  return points.length > 120 ? `${points.slice(0, 119).join('')}…` : sentence || null;
}

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
    return {
      exists: true,
      description: typeof description === 'string' ? safeSummary(description, Boolean(short)) : null,
    };
  } catch {
    return { exists: true, description: null, issue: {
      code: 'unreadable', message: '简介文件无法读取。请检查目录内容后重试。',
    } };
  } finally {
    await handle.close();
  }
}

function addItem(items: Map<string, PluginContentItem>, item: PluginContentItem): void {
  items.set(item.id, { ...item, tools: sortTools(item.tools) });
}

async function addSkills(root: string, relativePath: string, tools: PluginContentTool[], items: Map<string, PluginContentItem>, issues: PluginContentIssue[]): Promise<void> {
  const requested = path.join(root, relativePath);
  const directory = await regularPathWithin(root, requested, 'directory');
  if (!directory) {
    issues.push({ code: await unconfirmedPathCode(root, requested), message: '静态 Skill 清单无法安全确认。请检查来源目录。' });
    return;
  }
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => undefined);
  if (!entries) { issues.push({ code: 'unreadable', message: '静态 Skill 清单无法读取。' }); return; }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) {
      issues.push({ code: 'unsafePath', message: '静态 Skill 目录含不安全的符号链接。' }); continue;
    }
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(directory, entry.name, 'SKILL.md');
    const skill = await readFrontmatterDescription(root, skillFile);
    let issue = skill.issue;
    if (!skill.exists) {
      const code = await unconfirmedPathCode(root, skillFile);
      if (code === 'incompleteList') { issues.push({ code, message: '静态 Skill 目录存在未完成的条目。' }); continue; }
      issue = { code, message: 'Skill 元信息文件不可安全读取。请检查来源目录。' };
    }
    addItem(items, { id: `skill:${entry.name}`, name: entry.name, type: 'skill', description: skill.description, tools,
      descriptionState: issue ? 'issue' : skill.description ? 'available' : 'absent', ...(issue ? { issue } : {}) });
  }
}

async function addMcp(root: string, relativePath: string, tools: PluginContentTool[], items: Map<string, PluginContentItem>, issues: PluginContentIssue[]): Promise<void> {
  const requested = path.join(root, relativePath);
  const file = await regularPathWithin(root, requested, 'file');
  if (!file) { issues.push({ code: await unconfirmedPathCode(root, requested), message: '静态 MCP 清单无法安全确认。' }); return; }
  const value: unknown = await fs.readJson(file).catch(() => undefined);
  if (!isRecord(value) || !isRecord(value.mcpServers)) {
    issues.push({ code: 'invalidMetadata', message: '静态 MCP 清单无法读取或格式无效。' }); return;
  }
  for (const name of Object.keys(value.mcpServers).sort()) addItem(items, { id: `mcpServer:${name}`, name,
    type: 'mcpServer', description: null, tools, descriptionState: 'absent' });
}

function declaredTools(platforms: readonly PlatformTarget[], overrides?: Partial<Record<PlatformTarget, unknown>>): PluginContentTool[] {
  return platforms.filter((platform) => overrides?.[platform] !== null).map((platform) => TARGET_DISPLAY_NAMES[platform]);
}

/** Catalog content describes source declarations. Native package output is prepared per client and configuration. */
export async function projectPluginContentOverview(options: {
  pluginId: string; catalogVersion: string; plugin: PluginMeta;
}): Promise<PluginContentOverview> {
  const root = await fs.realpath(options.plugin.rootDir).catch(() => undefined);
  if (!root) {
    const message = '当前无法安全读取这个插件的来源内容。请检查来源状态后重试。';
    return { pluginId: options.pluginId, pluginVersion: options.plugin.manifest.version, catalogVersion: options.catalogVersion,
      evidence: 'unavailable', items: [], notices: [message], coverage: 'unavailable', coverageIssue: { code: 'unreadable', message } };
  }
  const manifest = options.plugin.manifest;
  const platforms = [...resolveSupportedPlatforms(manifest)];
  const tools = declaredTools(platforms);
  const items = new Map<string, PluginContentItem>();
  const issues: PluginContentIssue[] = [];
  if (manifest.skills) await addSkills(root, manifest.skills, tools, items, issues);
  if (manifest.mcpServers) await addMcp(root, manifest.mcpServers, tools, items, issues);
  for (const agent of manifest.extensions?.agents ?? []) addItem(items, { id: `agent:${agent.name}`, name: agent.name, type: 'agent',
    description: safeSummary(agent.description, true), tools: declaredTools(platforms, agent.agentOverrides), descriptionState: agent.description.trim() ? 'available' : 'absent' });
  for (const instruction of manifest.extensions?.instructions ?? []) addItem(items, { id: `instruction:${instruction.name}`,
    name: instruction.title, type: 'instruction', description: null, tools: declaredTools(platforms, instruction.agentOverrides), descriptionState: 'absent' });
  for (const permission of manifest.extensions?.permissions ?? []) addItem(items, { id: `permission:${permission.name}`, name: permission.name,
    type: 'permission', description: null, tools: declaredTools(platforms, permission.agentOverrides), descriptionState: 'absent' });
  for (const hook of manifest.extensions?.hooks ?? []) addItem(items, { id: `hook:${hook.id}`, name: hook.matcher ? `${hook.event} · ${hook.matcher}` : hook.event,
    type: 'hook', description: null, tools: declaredTools(platforms, hook.agentOverrides), descriptionState: 'absent' });
  for (const [platform, hooks] of Object.entries(manifest.extensions?.nativeHooks ?? {})) {
    if (!isPlatformTarget(platform) || !platforms.includes(platform)) continue;
    for (const hook of hooks ?? []) addItem(items, { id: `hook:${platform}:${hook.id}`, name: hook.matcher ? `${hook.event} · ${hook.matcher}` : hook.event,
      type: 'hook', description: null, tools: [TARGET_DISPLAY_NAMES[platform]], descriptionState: 'absent' });
  }
  if (manifest.scripts?.artifacts?.render) {
    addItem(items, { id: 'renderer:components', name: '动态组件', type: 'renderer', tools,
      description: '组件名称、类别和数量由配置及平台能力决定；准备安装后可查看本次实际集合。', descriptionState: 'available' });
    issues.push({ code: 'incompleteList', message: '此列表只显示静态声明。动态组件集合尚未准备，不能据此判断完整组件数量。' });
  }
  const result = [...items.values()].sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
  return { pluginId: options.pluginId, pluginVersion: manifest.version, catalogVersion: options.catalogVersion, evidence: 'catalogBundle',
    items: result, notices: ['内容来自作者静态声明；平台标签不证明客户端已安装或已加载。', ...new Set(issues.map((issue) => issue.message))],
    coverage: issues.length ? result.length ? 'partial' : 'unavailable' : 'complete', ...(issues[0] ? { coverageIssue: issues[0] } : {}) };
}
