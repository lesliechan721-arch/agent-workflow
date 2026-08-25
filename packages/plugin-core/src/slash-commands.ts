import path from 'node:path';

import fs from 'fs-extra';
import YAML from 'yaml';

import type {
  PlatformName,
  NormalizedPluginManifest,
  SupportedPlatformSet,
  TemplateVarByPlatform,
} from './types.js';
import { applyFileRules } from './file-rules.js';
import { resolveSupportedPlatforms } from './platform-support.js';
import { renderTemplate } from './template-engine.js';

const SLASH_COMMAND_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLASH_COMMAND_NAME_LENGTH = 64;
const CLAUDE_SHELLS = new Set(['bash', 'powershell']);
const CLAUDE_ONLY_TOP_LEVEL_FIELDS = new Set([
  'allowed-tools',
  'model',
  'argument-hint',
  'disable-model-invocation',
  'shell',
]);
const CODEX_INTERFACE_FIELDS = new Set([
  'display_name',
  'short_description',
  'icon_small',
  'icon_large',
  'brand_color',
  'default_prompt',
]);
const CODEX_ALLOWED_FIELDS = new Set(['description', 'interface']);

export const DEFAULT_SLASH_COMMANDS_DIR = 'slash-commands';
export const DEFAULT_SLASH_COMMANDS_PATH = `./${DEFAULT_SLASH_COMMANDS_DIR}`;

export interface ResolvedSlashCommandAsset {
  generatedRelativePath: string;
  sourceRelativePath: string;
}

export interface ResolvedSlashCommand {
  name: string;
  sourceRelativePath: string;
  claude?: {
    allowedTools?: string | string[];
    argumentHint?: string;
    body: string;
    description: string;
    model?: string;
    shell?: string;
  };
  codex?: {
    assets: ResolvedSlashCommandAsset[];
    body: string;
    description: string;
    interface: {
      brandColor?: string;
      defaultPrompt: string;
      displayName: string;
      iconLarge?: string;
      iconSmall?: string;
      shortDescription: string;
    };
  };
}

export interface ResolvedSlashCommands {
  commands: ResolvedSlashCommand[];
  rootRelativePath: string;
}

export interface ResolveSlashCommandsOptions {
  targetPlatforms: SupportedPlatformSet;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join('/');
}

function commandBaseField(commandPath: string): string {
  return `slashCommands command "${commandPath}"`;
}

function ensureObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }

  return value as Record<string, unknown>;
}

function ensureString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${fieldName}: expected a non-empty string.`);
  }

  return value.trim();
}

function ensureOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return ensureString(value, fieldName);
}

function ensureAllowedKeys(
  value: Record<string, unknown>,
  fieldName: string,
  allowedKeys: Iterable<string>,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Invalid ${fieldName}: unknown field "${key}".`);
    }
  }
}

function ensureAllowedTools(value: unknown, fieldName: string): string | string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return ensureString(value, fieldName);
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected a string or an array of strings.`);
  }

  return value.map((entry, index) => ensureString(entry, `${fieldName}[${index}]`));
}

function parseMarkdownFrontmatter(
  content: string,
  fieldName: string,
): { body: string; frontmatter: Record<string, unknown> } {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error(`Invalid ${fieldName}: missing YAML frontmatter.`);
  }

  const closingIndex = normalized.indexOf('\n---\n', 4);
  const closingAtEof = closingIndex === -1 && normalized.endsWith('\n---');
  if (closingIndex === -1 && !closingAtEof) {
    throw new Error(`Invalid ${fieldName}: YAML frontmatter is missing the closing delimiter.`);
  }

  const yamlEndIndex = closingAtEof ? normalized.length - '\n---'.length : closingIndex;
  const yamlContent = normalized.slice(4, yamlEndIndex);
  const body = closingAtEof ? '' : normalized.slice(yamlEndIndex + '\n---\n'.length);

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlContent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${fieldName}: YAML frontmatter parse failed (${message}).`);
  }

  return {
    body,
    frontmatter: ensureObject(parsed, `${fieldName} frontmatter`),
  };
}

function isTemplatedSlashCommand(
  manifest: NormalizedPluginManifest,
  relativePath: string,
): boolean {
  const include = manifest.buildConfig?.templates?.include ?? [];
  return include.length > 0 && applyFileRules([relativePath], include, []).length > 0;
}

function renderSlashCommandSource(
  manifest: NormalizedPluginManifest,
  relativePath: string,
  content: string,
  platform: PlatformName,
): string {
  if (!isTemplatedSlashCommand(manifest, relativePath)) {
    return content;
  }

  const templateVars: Record<string, TemplateVarByPlatform> =
    manifest.buildConfig?.templates?.vars ?? {};
  return renderTemplate(
    content,
    templateVars,
    platform,
  );
}

function detectCodexForbiddenSyntax(content: string): string | undefined {
  const checks: Array<[RegExp, string]> = [
    [/\$ARGUMENTS\b/, '$ARGUMENTS'],
    [/\$\d+\b/, '$1'],
    [/```!/, '```!'],
    [/!`[^`\r\n]+`/, '!`command`'],
  ];

  for (const [pattern, label] of checks) {
    if (pattern.test(content)) {
      return label;
    }
  }

  return undefined;
}

function normalizeCodexAssetPath(
  pluginRoot: string,
  slashCommandsRoot: string,
  commandPath: string,
  value: unknown,
  fieldName: string,
): ResolvedSlashCommandAsset | undefined {
  if (value === undefined) {
    return undefined;
  }

  const rawValue = ensureString(value, fieldName);
  if (path.isAbsolute(rawValue) || path.win32.isAbsolute(rawValue) || rawValue.includes('\\')) {
    throw new Error(
      `Invalid ${commandBaseField(commandPath)}.${fieldName}: must use "./assets/...".`,
    );
  }
  if (!rawValue.startsWith('./assets/')) {
    throw new Error(
      `Invalid ${commandBaseField(commandPath)}.${fieldName}: must use "./assets/...".`,
    );
  }

  const normalized = path.posix.normalize(rawValue);
  if (
    normalized === './assets' ||
    normalized === 'assets' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error(
      `Invalid ${commandBaseField(commandPath)}.${fieldName}: must use "./assets/...".`,
    );
  }

  const normalizedChildPath = stripDotSlash(normalized);
  if (!normalizedChildPath.startsWith('assets/')) {
    throw new Error(
      `Invalid ${commandBaseField(commandPath)}.${fieldName}: must use "./assets/...".`,
    );
  }

  const sourceRelativePath = normalizeRelativePath(
    path.join(stripDotSlash(slashCommandsRoot), normalizedChildPath),
  );
  const absolutePath = path.join(pluginRoot, sourceRelativePath);
  const stats = fs.statSync(absolutePath, { throwIfNoEntry: false });
  if (!stats) {
    throw new Error(
      `Invalid ${commandBaseField(commandPath)}.${fieldName}: referenced asset "${rawValue}" does not exist.`,
    );
  }
  if (!stats.isFile()) {
    throw new Error(
      `Invalid ${commandBaseField(commandPath)}.${fieldName}: referenced asset "${rawValue}" must be a file.`,
    );
  }

  return {
    generatedRelativePath: `./${normalizedChildPath}`,
    sourceRelativePath,
  };
}

function titleCaseSlashCommandName(name: string): string {
  return name
    .split('-')
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function buildDefaultPrompt(name: string, description: string): string {
  const trimmedDescription = description.trim();
  const suffix = /[.!?。！？]$/.test(trimmedDescription) ? '' : '.';
  return `Use $${name} to ${trimmedDescription}${suffix}`;
}

function normalizeCodexInterfaceBlock(
  pluginRoot: string,
  slashCommandsRoot: string,
  commandName: string,
  commandPath: string,
  description: string,
  value: unknown,
): {
  assets: ResolvedSlashCommandAsset[];
  brandColor?: string;
  defaultPrompt: string;
  displayName: string;
  iconLarge?: string;
  iconSmall?: string;
  shortDescription: string;
} {
  const fieldName = `${commandBaseField(commandPath)}.codex.interface`;
  const input = value === undefined ? {} : ensureObject(value, fieldName);
  ensureAllowedKeys(input, fieldName, CODEX_INTERFACE_FIELDS);

  const iconSmall = normalizeCodexAssetPath(
    pluginRoot,
    slashCommandsRoot,
    commandPath,
    input.icon_small,
    'codex.interface.icon_small',
  );
  const iconLarge = normalizeCodexAssetPath(
    pluginRoot,
    slashCommandsRoot,
    commandPath,
    input.icon_large,
    'codex.interface.icon_large',
  );

  const brandColor = ensureOptionalString(input.brand_color, `${fieldName}.brand_color`);
  if (brandColor !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(brandColor)) {
    throw new Error(`Invalid ${fieldName}.brand_color: expected a "#RRGGBB" value.`);
  }

  const assets = [iconSmall, iconLarge].filter(
    (entry): entry is ResolvedSlashCommandAsset => entry !== undefined,
  );

  return {
    assets,
    brandColor,
    defaultPrompt:
      ensureOptionalString(input.default_prompt, `${fieldName}.default_prompt`) ??
      buildDefaultPrompt(commandName, description),
    displayName:
      ensureOptionalString(input.display_name, `${fieldName}.display_name`) ??
      titleCaseSlashCommandName(commandName),
    iconLarge: iconLarge?.generatedRelativePath,
    iconSmall: iconSmall?.generatedRelativePath,
    shortDescription:
      ensureOptionalString(input.short_description, `${fieldName}.short_description`) ??
      description,
  };
}

function parseRenderedSlashCommand(
  pluginRoot: string,
  slashCommandsRoot: string,
  commandName: string,
  commandPath: string,
  content: string,
  platform: PlatformName,
): ResolvedSlashCommand {
  const { body, frontmatter } = parseMarkdownFrontmatter(content, commandBaseField(commandPath));

  for (const key of Object.keys(frontmatter)) {
    if (CLAUDE_ONLY_TOP_LEVEL_FIELDS.has(key)) {
      throw new Error(
        `Invalid ${commandBaseField(commandPath)} frontmatter: "${key}" must be nested under "claude".`,
      );
    }
  }

  ensureAllowedKeys(
    frontmatter,
    `${commandBaseField(commandPath)} frontmatter`,
    ['description', 'claude', 'codex'],
  );

  const sharedDescription = ensureString(
    frontmatter.description,
    `${commandBaseField(commandPath)} frontmatter.description`,
  );

  const command: ResolvedSlashCommand = {
    name: commandName,
    sourceRelativePath: commandPath,
  };

  if (platform === 'claude') {
    const claudeBlock = frontmatter.claude === undefined
      ? {}
      : ensureObject(frontmatter.claude, `${commandBaseField(commandPath)} frontmatter.claude`);
    ensureAllowedKeys(
      claudeBlock,
      `${commandBaseField(commandPath)} frontmatter.claude`,
      ['description', 'allowed-tools', 'model', 'argument-hint', 'shell'],
    );

    const shell = ensureOptionalString(
      claudeBlock.shell,
      `${commandBaseField(commandPath)} frontmatter.claude.shell`,
    );
    if (shell !== undefined && !CLAUDE_SHELLS.has(shell.toLowerCase())) {
      throw new Error(
        `Invalid ${commandBaseField(commandPath)} frontmatter.claude.shell: expected "bash" or "powershell".`,
      );
    }

    command.claude = {
      allowedTools: ensureAllowedTools(
        claudeBlock['allowed-tools'],
        `${commandBaseField(commandPath)} frontmatter.claude.allowed-tools`,
      ),
      argumentHint: ensureOptionalString(
        claudeBlock['argument-hint'],
        `${commandBaseField(commandPath)} frontmatter.claude.argument-hint`,
      ),
      body,
      description:
        ensureOptionalString(
          claudeBlock.description,
          `${commandBaseField(commandPath)} frontmatter.claude.description`,
        ) ?? sharedDescription,
      model: ensureOptionalString(
        claudeBlock.model,
        `${commandBaseField(commandPath)} frontmatter.claude.model`,
      ),
      shell,
    };
  }

  if (platform === 'codex') {
    const codexBlock = frontmatter.codex === undefined
      ? {}
      : ensureObject(frontmatter.codex, `${commandBaseField(commandPath)} frontmatter.codex`);
    if ('policy' in codexBlock) {
      throw new Error(
        `Invalid ${commandBaseField(commandPath)} frontmatter.codex.policy: generated slashCommands skills are always manual-only.`,
      );
    }
    ensureAllowedKeys(
      codexBlock,
      `${commandBaseField(commandPath)} frontmatter.codex`,
      CODEX_ALLOWED_FIELDS,
    );

    const codexDescription =
      ensureOptionalString(
        codexBlock.description,
        `${commandBaseField(commandPath)} frontmatter.codex.description`,
      ) ?? sharedDescription;
    const codexInterface = normalizeCodexInterfaceBlock(
      pluginRoot,
      slashCommandsRoot,
      commandName,
      commandPath,
      codexDescription,
      codexBlock.interface,
    );

    command.codex = {
      assets: codexInterface.assets,
      body,
      description: codexDescription,
      interface: {
        brandColor: codexInterface.brandColor,
        defaultPrompt: codexInterface.defaultPrompt,
        displayName: codexInterface.displayName,
        iconLarge: codexInterface.iconLarge,
        iconSmall: codexInterface.iconSmall,
        shortDescription: codexInterface.shortDescription,
      },
    };
  }

  return command;
}

function listExplicitSkillNames(
  pluginRoot: string,
  manifest: NormalizedPluginManifest,
): string[] {
  if (!manifest.skills) {
    return [];
  }

  const skillsRoot = path.join(pluginRoot, stripDotSlash(manifest.skills));
  const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function resolveSlashCommands(
  pluginRoot: string,
  manifest: NormalizedPluginManifest,
  options?: ResolveSlashCommandsOptions,
): Promise<ResolvedSlashCommands | undefined> {
  const slashCommandsRoot = manifest.slashCommands;
  if (!slashCommandsRoot) {
    return undefined;
  }
  const targetPlatforms = options?.targetPlatforms ?? resolveSupportedPlatforms(manifest);

  const absoluteRoot = path.join(pluginRoot, stripDotSlash(slashCommandsRoot));
  const rootStats = await fs.stat(absoluteRoot).catch(() => null);
  if (!rootStats) {
    throw new Error(
      `Invalid slashCommands: "${slashCommandsRoot}" does not exist.`,
    );
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`Invalid slashCommands: "${slashCommandsRoot}" must point to a directory.`);
  }

  const explicitSkillNames = new Set(listExplicitSkillNames(pluginRoot, manifest));
  const commandEntries = await fs.readdir(absoluteRoot, { withFileTypes: true });
  const seenNames = new Set<string>();
  const commands: ResolvedSlashCommand[] = [];

  for (const entry of commandEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativeEntryPath = normalizeRelativePath(
      path.join(stripDotSlash(slashCommandsRoot), entry.name),
    );

    if (entry.isDirectory()) {
      if (entry.name !== 'assets') {
        throw new Error(
          `Invalid slashCommands: nested directory "${relativeEntryPath}" is not supported; only root "*.md" commands and "assets/" are allowed.`,
        );
      }
      continue;
    }

    if (!entry.isFile()) {
      throw new Error(
        `Invalid slashCommands: unexpected entry "${relativeEntryPath}".`,
      );
    }

    if (path.posix.extname(entry.name) !== '.md') {
      throw new Error(
        `Invalid slashCommands: unexpected file "${relativeEntryPath}"; only root "*.md" commands and "assets/" are allowed.`,
      );
    }

    const commandName = path.posix.basename(entry.name, '.md');
    if (
      commandName.length === 0 ||
      commandName.length > MAX_SLASH_COMMAND_NAME_LENGTH ||
      !SLASH_COMMAND_NAME_PATTERN.test(commandName)
    ) {
      throw new Error(
        `Invalid ${commandBaseField(relativeEntryPath)}: command names must use lowercase hyphen-case and be at most ${MAX_SLASH_COMMAND_NAME_LENGTH} characters.`,
      );
    }
    if (seenNames.has(commandName)) {
      throw new Error(`Invalid slashCommands: duplicate command name "${commandName}".`);
    }
    if (explicitSkillNames.has(commandName)) {
      throw new Error(
        `Invalid slashCommands: command "${commandName}" conflicts with source skill "${commandName}".`,
      );
    }
    seenNames.add(commandName);

    const rawContent = await fs.readFile(path.join(absoluteRoot, entry.name), 'utf8');
    const sourceRelativePath = normalizeRelativePath(
      path.join(stripDotSlash(slashCommandsRoot), entry.name),
    );
    const command: ResolvedSlashCommand = {
      name: commandName,
      sourceRelativePath,
    };

    if (targetPlatforms.has('claude')) {
      const claudeRendered = renderSlashCommandSource(
        manifest,
        sourceRelativePath,
        rawContent,
        'claude',
      );
      command.claude = parseRenderedSlashCommand(
        pluginRoot,
        slashCommandsRoot,
        commandName,
        sourceRelativePath,
        claudeRendered,
        'claude',
      ).claude;
    }

    if (targetPlatforms.has('codex')) {
      const codexRendered = renderSlashCommandSource(
        manifest,
        sourceRelativePath,
        rawContent,
        'codex',
      );
      const forbiddenSyntax = detectCodexForbiddenSyntax(codexRendered);
      if (forbiddenSyntax) {
        throw new Error(
          `Invalid ${commandBaseField(sourceRelativePath)}: Codex render still contains Claude-only syntax "${forbiddenSyntax}".`,
        );
      }
      command.codex = parseRenderedSlashCommand(
        pluginRoot,
        slashCommandsRoot,
        commandName,
        sourceRelativePath,
        codexRendered,
        'codex',
      ).codex;
    }

    commands.push(command);
  }

  if (commands.length === 0) {
    throw new Error(
      `Invalid slashCommands: "${slashCommandsRoot}" must contain at least one root "*.md" command file.`,
    );
  }

  return {
    commands,
    rootRelativePath: slashCommandsRoot,
  };
}

export function renderClaudeSlashCommand(command: ResolvedSlashCommand): string {
  if (!command.claude) {
    throw new Error(`Missing Claude slashCommand payload for "${command.name}".`);
  }

  const frontmatter: Record<string, string | string[] | boolean> = {
    description: command.claude.description,
    'disable-model-invocation': true,
  };
  if (command.claude.allowedTools !== undefined) {
    frontmatter['allowed-tools'] = command.claude.allowedTools;
  }
  if (command.claude.model !== undefined) {
    frontmatter.model = command.claude.model;
  }
  if (command.claude.argumentHint !== undefined) {
    frontmatter['argument-hint'] = command.claude.argumentHint;
  }
  if (command.claude.shell !== undefined) {
    frontmatter.shell = command.claude.shell;
  }

  return ensureTrailingNewline(
    `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n${command.claude.body}`,
  );
}

export function renderCodexSlashCommandSkillMarkdown(command: ResolvedSlashCommand): string {
  if (!command.codex) {
    throw new Error(`Missing Codex slashCommand payload for "${command.name}".`);
  }

  return ensureTrailingNewline(command.codex.body);
}

export function renderCodexSlashCommandOpenAiYaml(command: ResolvedSlashCommand): string {
  if (!command.codex) {
    throw new Error(`Missing Codex slashCommand payload for "${command.name}".`);
  }

  const interfaceBlock: Record<string, string> = {
    display_name: command.codex.interface.displayName,
    short_description: command.codex.interface.shortDescription,
    default_prompt: command.codex.interface.defaultPrompt,
  };
  if (command.codex.interface.iconSmall) {
    interfaceBlock.icon_small = command.codex.interface.iconSmall;
  }
  if (command.codex.interface.iconLarge) {
    interfaceBlock.icon_large = command.codex.interface.iconLarge;
  }
  if (command.codex.interface.brandColor) {
    interfaceBlock.brand_color = command.codex.interface.brandColor;
  }

  return ensureTrailingNewline(
    YAML.stringify({
      interface: interfaceBlock,
      policy: {
        allow_implicit_invocation: false,
      },
    }),
  );
}
