import path from 'node:path';

import fs from 'fs-extra';

import { renderHooksArtifact } from './hooks.js';
import { buildGeneratedName } from './shared.js';
import { applyFileRules } from '../utils/file-rules.js';
import {
  createBundleSourceManifest,
  createPlatformManifestBase,
  normalizePluginRelativePath,
} from '../utils/manifest.js';
import { writeJsonFile } from '../utils/json.js';
import { renderTemplate } from '../utils/template-engine.js';
import type {
  AgentDefinition,
  HookDefinition,
  PlatformName,
  PlatformPluginManifest,
  PluginMeta,
} from '../types.js';

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

function toPlatformRelativePath(value: string, platform: PlatformName): string {
  return `./${platform}/${stripDotSlash(value)}`;
}

function toPlatformOutputPath(value: string, platform: PlatformName): string {
  return path.join(platform, stripDotSlash(value));
}

function isTextFile(filePath: string): boolean {
  return /\.(md|markdown|txt|json|yaml|yml|toml|rules)$/i.test(filePath);
}

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === '.agents-plugin' || entry.name === '.claude-plugin' || entry.name === '.codex-plugin') {
      continue;
    }

    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nestedFiles = await listFilesRecursively(entryPath);
      files.push(
        ...nestedFiles.map((nestedFile) => path.join(entry.name, nestedFile).split(path.sep).join('/')),
      );
      continue;
    }

    files.push(entry.name);
  }

  return files.sort();
}

async function collectFilesForPath(pluginRoot: string, relativePath: string): Promise<string[]> {
  const absolutePath = path.join(pluginRoot, stripDotSlash(relativePath));
  const stats = await fs.stat(absolutePath).catch(() => null);
  if (!stats) {
    throw new Error(`Missing source path "${relativePath}".`);
  }

  if (stats.isDirectory()) {
    const nestedFiles = await listFilesRecursively(absolutePath);
    return nestedFiles.map((filePath) =>
      path.join(stripDotSlash(relativePath), filePath).split(path.sep).join('/'),
    );
  }

  return [stripDotSlash(relativePath).split(path.sep).join('/')];
}

function applyPlatformOverride<T extends { agentOverrides?: { claude?: Partial<T> | null; codex?: Partial<T> | null } }>(
  entry: T,
  platform: PlatformName,
): T | null {
  const override = entry.agentOverrides?.[platform];
  if (override === null) {
    return null;
  }

  if (!override) {
    return { ...entry };
  }

  return {
    ...entry,
    ...override,
    agentOverrides: undefined,
  };
}

function resolvePlatformEntries<T extends { agentOverrides?: { claude?: Partial<T> | null; codex?: Partial<T> | null } }>(
  entries: T[] | undefined,
  platform: PlatformName,
): T[] {
  return (entries ?? [])
    .map((entry) => applyPlatformOverride(entry, platform))
    .filter((entry): entry is T => entry !== null);
}

function renderClaudeAgentContent(agent: AgentDefinition): string {
  const frontmatterLines = ['---', `name: ${JSON.stringify(agent.name)}`, `description: ${JSON.stringify(agent.description)}`];
  if (agent.tools && agent.tools.length > 0) {
    frontmatterLines.push('tools:');
    for (const tool of agent.tools) {
      frontmatterLines.push(`  - ${tool}`);
    }
  }
  frontmatterLines.push('---', '');

  return `${frontmatterLines.join('\n')}${agent.prompt.trim()}\n`;
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf8');
}

async function copyFileWithTemplateSupport(
  pluginRoot: string,
  outputRoot: string,
  sourceRelativePath: string,
  platform: PlatformName,
  templatePatterns: string[],
  templateVars: Record<string, { claude: string | boolean; codex: string | boolean }>,
): Promise<void> {
  const normalizedSource = sourceRelativePath.split(path.sep).join('/');
  const sourcePath = path.join(pluginRoot, normalizedSource);
  const targetPath = path.join(outputRoot, platform, normalizedSource);
  await fs.ensureDir(path.dirname(targetPath));

  const shouldRenderTemplate =
    isTextFile(normalizedSource) &&
    templatePatterns.length > 0 &&
    applyFileRules([normalizedSource], templatePatterns, []).length > 0;

  if (!shouldRenderTemplate) {
    await fs.copyFile(sourcePath, targetPath);
    return;
  }

  const content = await fs.readFile(sourcePath, 'utf8');
  await fs.writeFile(targetPath, renderTemplate(content, templateVars, platform), 'utf8');
}

async function addDeclaredPathFiles(
  plugin: PluginMeta,
  platform: PlatformName,
  relativePath: string | undefined,
  targetFiles: Set<string>,
): Promise<string | undefined> {
  if (!relativePath) {
    return undefined;
  }

  const files = await collectFilesForPath(plugin.rootDir, relativePath);
  for (const filePath of files) {
    targetFiles.add(filePath);
  }

  return toPlatformRelativePath(relativePath, platform);
}

async function addDeclaredLspServerFiles(
  plugin: PluginMeta,
  value: PlatformPluginManifest['lspServers'],
  targetFiles: Set<string>,
): Promise<PlatformPluginManifest['lspServers']> {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    const normalized = normalizePluginRelativePath(plugin.rootDir, value, 'buildConfig.manifestOverrides.claude.lspServers');
    const files = await collectFilesForPath(plugin.rootDir, normalized);
    for (const filePath of files) {
      targetFiles.add(filePath);
    }
    return toPlatformRelativePath(normalized, 'claude');
  }

  if (Array.isArray(value)) {
    const rendered: Array<string | Record<string, unknown>> = [];
    for (const entry of value) {
      if (typeof entry === 'string') {
        const normalized = normalizePluginRelativePath(plugin.rootDir, entry, 'buildConfig.manifestOverrides.claude.lspServers');
        const files = await collectFilesForPath(plugin.rootDir, normalized);
        for (const filePath of files) {
          targetFiles.add(filePath);
        }
        rendered.push(toPlatformRelativePath(normalized, 'claude'));
      } else {
        rendered.push(entry);
      }
    }
    return rendered;
  }

  return value;
}

export interface LocalPluginBundleResult {
  outputRoot: string;
  claudeManifest: PlatformPluginManifest;
  codexManifest: PlatformPluginManifest;
}

export async function bundleLocalPlugin(
  plugin: PluginMeta,
  outputRoot: string,
): Promise<LocalPluginBundleResult> {
  await fs.remove(outputRoot);
  await fs.ensureDir(outputRoot);

  const claudeFiles = new Set<string>();
  const codexFiles = new Set<string>();
  const buildConfig = plugin.manifest.buildConfig;
  const templatePatterns = buildConfig?.templates?.include ?? [];
  const templateVars = buildConfig?.templates?.vars ?? {};

  const claudeManifest = createPlatformManifestBase(plugin);
  const codexManifest = createPlatformManifestBase(plugin);

  claudeManifest.skills = await addDeclaredPathFiles(
    plugin,
    'claude',
    plugin.manifest.skills,
    claudeFiles,
  );
  codexManifest.skills = await addDeclaredPathFiles(
    plugin,
    'codex',
    plugin.manifest.skills,
    codexFiles,
  );

  claudeManifest.mcpServers = await addDeclaredPathFiles(
    plugin,
    'claude',
    plugin.manifest.mcpServers,
    claudeFiles,
  );
  codexManifest.mcpServers = await addDeclaredPathFiles(
    plugin,
    'codex',
    plugin.manifest.mcpServers,
    codexFiles,
  );
  codexManifest.apps = await addDeclaredPathFiles(plugin, 'codex', plugin.manifest.apps, codexFiles);

  const claudeOverrides = buildConfig?.manifestOverrides?.claude;
  claudeManifest.commands = await addDeclaredPathFiles(
    plugin,
    'claude',
    claudeOverrides?.commands,
    claudeFiles,
  );
  claudeManifest.outputStyles = await addDeclaredPathFiles(
    plugin,
    'claude',
    claudeOverrides?.outputStyles,
    claudeFiles,
  );
  claudeManifest.lspServers = await addDeclaredLspServerFiles(plugin, claudeOverrides?.lspServers, claudeFiles);
  claudeManifest.userConfig = claudeOverrides?.userConfig;
  claudeManifest.channels = claudeOverrides?.channels;

  const claudeHooks = resolvePlatformEntries<HookDefinition>(
    plugin.manifest.extensions?.hooks,
    'claude',
  );
  const hooksArtifact = renderHooksArtifact(claudeHooks, 'claude');
  if (hooksArtifact) {
    const hooksPath = path.join(outputRoot, 'claude', 'hooks', 'hooks.json');
    await writeJsonFile(hooksPath, hooksArtifact.content);
    claudeManifest.hooks = './claude/hooks/hooks.json';
  }

  const claudeAgents = resolvePlatformEntries<AgentDefinition>(
    plugin.manifest.extensions?.agents,
    'claude',
  );
  if (claudeAgents.length > 0) {
    claudeManifest.agents = [];
    for (const agent of claudeAgents) {
      const generatedName = buildGeneratedName(plugin.manifest.name, agent.name);
      const relativePath = `./claude/agents/${generatedName}.md`;
      claudeManifest.agents.push(relativePath);
      await writeTextFile(
        path.join(outputRoot, stripDotSlash(relativePath)),
        renderClaudeAgentContent(agent),
      );
    }
  }

  const sourceFiles = await listFilesRecursively(plugin.rootDir);
  if (buildConfig?.fileRules?.claude) {
    for (const filePath of applyFileRules(
      sourceFiles,
      buildConfig.fileRules.claude.include,
      buildConfig.fileRules.claude.exclude,
    )) {
      claudeFiles.add(filePath);
    }
  }
  if (buildConfig?.fileRules?.codex) {
    for (const filePath of applyFileRules(
      sourceFiles,
      buildConfig.fileRules.codex.include,
      buildConfig.fileRules.codex.exclude,
    )) {
      codexFiles.add(filePath);
    }
  }

  for (const filePath of claudeFiles) {
    await copyFileWithTemplateSupport(
      plugin.rootDir,
      outputRoot,
      filePath,
      'claude',
      templatePatterns,
      templateVars,
    );
  }

  for (const filePath of codexFiles) {
    await copyFileWithTemplateSupport(
      plugin.rootDir,
      outputRoot,
      filePath,
      'codex',
      templatePatterns,
      templateVars,
    );
  }

  await writeJsonFile(
    path.join(outputRoot, '.agents-plugin', 'plugin.json'),
    createBundleSourceManifest(plugin),
  );
  await writeJsonFile(path.join(outputRoot, '.claude-plugin', 'plugin.json'), claudeManifest);
  await writeJsonFile(path.join(outputRoot, '.codex-plugin', 'plugin.json'), codexManifest);

  return {
    outputRoot,
    claudeManifest,
    codexManifest,
  };
}
