import path from 'node:path';

import fs from 'fs-extra';

import type {
  AgentDefinition,
  BuildConfig,
  BuildConfigFileRuleSet,
  BuildConfigTemplates,
  ClaudeManifestOverrides,
  HookDefinition,
  HookEvent,
  InstructionDefinition,
  MarketplaceManifest,
  MarketplaceSourceMeta,
  PermissionDefinition,
  PlatformAgentOverrides,
  PlatformName,
  PlatformPluginManifest,
  PluginInterfaceMeta,
  PluginManifestSource,
  PluginMarketplaceMeta,
  PluginMeta,
  TemplateVarByPlatform,
} from '../types.js';
import { readJsonFile } from './json.js';

export const SOURCE_MANIFEST_PATH = path.join('.agents-plugin', 'plugin.json');
export const MARKETPLACE_SOURCE_PATH = path.join('plugins', 'marketplace-source.json');

function assertObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }

  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  fieldName: string,
  allowedKeys: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`Invalid ${fieldName}: unknown field "${key}".`);
    }
  }
}

function ensureString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${fieldName}: expected a non-empty string.`);
  }

  return value;
}

function ensureStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an array.`);
  }

  return value.map((entry, index) => ensureString(entry, `${fieldName}[${index}]`));
}

function normalizeComparableStringArray(value: string[] | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

export function normalizePluginRelativePath(
  pluginRoot: string,
  value: string,
  fieldName: string,
): string {
  if (path.isAbsolute(value)) {
    throw new Error(`Invalid ${fieldName}: absolute paths are not allowed.`);
  }

  if (!value.startsWith('./')) {
    throw new Error(`Invalid ${fieldName}: path must start with "./".`);
  }

  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Invalid ${fieldName}: path must stay inside the plugin root.`);
  }

  const resolved = path.resolve(pluginRoot, normalized);
  const relativeToRoot = path.relative(pluginRoot, resolved);
  if (relativeToRoot === '' || relativeToRoot === '.' || relativeToRoot.startsWith('..')) {
    throw new Error(`Invalid ${fieldName}: path must point to a child path inside the plugin root.`);
  }

  return normalized.startsWith('./') ? normalized : `./${normalized}`;
}

function normalizePathArray(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return ensureStringArray(value, fieldName).map((entry, index) =>
    normalizePluginRelativePath(pluginRoot, entry, `${fieldName}[${index}]`),
  );
}

function normalizePluginInterface(
  value: unknown,
  fieldName: string,
): PluginInterfaceMeta {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['displayName', 'shortDescription', 'capabilities']);

  return {
    displayName:
      typeof input.displayName === 'string' ? input.displayName : undefined,
    shortDescription:
      typeof input.shortDescription === 'string' ? input.shortDescription : undefined,
    capabilities:
      input.capabilities === undefined
        ? undefined
        : ensureStringArray(input.capabilities, `${fieldName}.capabilities`),
  };
}

function normalizeMarketplacePolicy(
  value: unknown,
  fieldName: string,
): PluginMarketplaceMeta['policy'] {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['installation', 'authentication', 'products']);

  return {
    installation: ensureString(input.installation, `${fieldName}.installation`),
    authentication: ensureString(input.authentication, `${fieldName}.authentication`),
    products:
      input.products === undefined
        ? undefined
        : normalizeComparableStringArray(
            ensureStringArray(input.products, `${fieldName}.products`),
          ),
  };
}

function normalizeMarketplaceMeta(
  value: unknown,
  fieldName: string,
): PluginMarketplaceMeta {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['category', 'tags', 'strict', 'policy']);

  if (typeof input.strict !== 'boolean') {
    throw new Error(`Invalid ${fieldName}.strict: expected a boolean.`);
  }

  return {
    category: ensureString(input.category, `${fieldName}.category`),
    tags:
      input.tags === undefined
        ? undefined
        : normalizeComparableStringArray(ensureStringArray(input.tags, `${fieldName}.tags`)),
    strict: input.strict,
    policy: normalizeMarketplacePolicy(input.policy, `${fieldName}.policy`),
  };
}

function normalizeTemplateVarByPlatform(
  value: unknown,
  fieldName: string,
): TemplateVarByPlatform {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['claude', 'codex']);

  const claude = input.claude;
  const codex = input.codex;
  if (
    (typeof claude !== 'string' && typeof claude !== 'boolean') ||
    (typeof codex !== 'string' && typeof codex !== 'boolean')
  ) {
    throw new Error(`Invalid ${fieldName}: template vars must be string or boolean per platform.`);
  }

  return {
    claude,
    codex,
  };
}

function normalizeBuildConfigTemplates(
  value: unknown,
  fieldName: string,
): BuildConfigTemplates {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['vars', 'include']);

  const varsInput = assertObject(input.vars ?? {}, `${fieldName}.vars`);
  const vars: BuildConfigTemplates['vars'] = {};

  for (const [key, entry] of Object.entries(varsInput)) {
    vars[key] = normalizeTemplateVarByPlatform(entry, `${fieldName}.vars.${key}`);
  }

  return {
    vars,
    include: ensureStringArray(input.include ?? [], `${fieldName}.include`),
  };
}

function normalizeFileRuleSet(
  value: unknown,
  fieldName: string,
): BuildConfigFileRuleSet {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['include', 'exclude']);

  return {
    include: ensureStringArray(input.include ?? [], `${fieldName}.include`),
    exclude: ensureStringArray(input.exclude ?? [], `${fieldName}.exclude`),
  };
}

function normalizeClaudeManifestOverrides(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): ClaudeManifestOverrides {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['commands', 'outputStyles', 'lspServers', 'userConfig', 'channels']);

  const output: ClaudeManifestOverrides = {};

  if (input.commands !== undefined) {
    output.commands = normalizePluginRelativePath(
      pluginRoot,
      ensureString(input.commands, `${fieldName}.commands`),
      `${fieldName}.commands`,
    );
  }

  if (input.outputStyles !== undefined) {
    output.outputStyles = normalizePluginRelativePath(
      pluginRoot,
      ensureString(input.outputStyles, `${fieldName}.outputStyles`),
      `${fieldName}.outputStyles`,
    );
  }

  if (input.lspServers !== undefined) {
    if (typeof input.lspServers === 'string') {
      output.lspServers = normalizePluginRelativePath(
        pluginRoot,
        ensureString(input.lspServers, `${fieldName}.lspServers`),
        `${fieldName}.lspServers`,
      );
    } else if (Array.isArray(input.lspServers)) {
      output.lspServers = input.lspServers.map((entry, index) =>
        typeof entry === 'string'
          ? normalizePluginRelativePath(
              pluginRoot,
              ensureString(entry, `${fieldName}.lspServers[${index}]`),
              `${fieldName}.lspServers[${index}]`,
            )
          : assertObject(entry, `${fieldName}.lspServers[${index}]`),
      );
    } else {
      output.lspServers = assertObject(input.lspServers, `${fieldName}.lspServers`);
    }
  }

  if (input.userConfig !== undefined) {
    output.userConfig = assertObject(input.userConfig, `${fieldName}.userConfig`);
  }

  if (input.channels !== undefined) {
    if (Array.isArray(input.channels)) {
      output.channels = input.channels.map((entry, index) =>
        assertObject(entry, `${fieldName}.channels[${index}]`),
      );
    } else {
      output.channels = assertObject(input.channels, `${fieldName}.channels`);
    }
  }

  return output;
}

function normalizeBuildConfig(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): BuildConfig {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['templates', 'fileRules', 'manifestOverrides']);

  const buildConfig: BuildConfig = {};

  if (input.templates !== undefined) {
    buildConfig.templates = normalizeBuildConfigTemplates(
      input.templates,
      `${fieldName}.templates`,
    );
  }

  if (input.fileRules !== undefined) {
    const fileRulesInput = assertObject(input.fileRules, `${fieldName}.fileRules`);
    assertAllowedKeys(fileRulesInput, `${fieldName}.fileRules`, ['claude', 'codex']);
    buildConfig.fileRules = {};

    if (fileRulesInput.claude !== undefined) {
      buildConfig.fileRules.claude = normalizeFileRuleSet(
        fileRulesInput.claude,
        `${fieldName}.fileRules.claude`,
      );
    }

    if (fileRulesInput.codex !== undefined) {
      buildConfig.fileRules.codex = normalizeFileRuleSet(
        fileRulesInput.codex,
        `${fieldName}.fileRules.codex`,
      );
    }
  }

  if (input.manifestOverrides !== undefined) {
    const overridesInput = assertObject(
      input.manifestOverrides,
      `${fieldName}.manifestOverrides`,
    );
    assertAllowedKeys(overridesInput, `${fieldName}.manifestOverrides`, ['claude', 'codex']);
    buildConfig.manifestOverrides = {};

    if (overridesInput.claude !== undefined) {
      buildConfig.manifestOverrides.claude = normalizeClaudeManifestOverrides(
        pluginRoot,
        overridesInput.claude,
        `${fieldName}.manifestOverrides.claude`,
      );
    }

    if (overridesInput.codex !== undefined) {
      const codexOverrides = assertObject(
        overridesInput.codex,
        `${fieldName}.manifestOverrides.codex`,
      );
      assertAllowedKeys(codexOverrides, `${fieldName}.manifestOverrides.codex`, []);
      buildConfig.manifestOverrides.codex = {};
    }
  }

  return buildConfig;
}

function normalizePlatformAgentOverrides<T>(
  value: unknown,
  fieldName: string,
  normalizer: (value: Record<string, unknown>, fieldName: string) => Partial<T>,
): PlatformAgentOverrides<T> {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['claude', 'codex']);

  const output: PlatformAgentOverrides<T> = {};
  for (const platform of ['claude', 'codex'] as const) {
    const entry = input[platform];
    if (entry === undefined) {
      continue;
    }

    if (entry === null) {
      output[platform] = null;
      continue;
    }

    output[platform] = normalizer(
      assertObject(entry, `${fieldName}.${platform}`),
      `${fieldName}.${platform}`,
    );
  }

  return output;
}

function normalizeInstructionEntry(
  entry: unknown,
  fieldName: string,
): InstructionDefinition {
  const input = assertObject(entry, fieldName);
  assertAllowedKeys(input, fieldName, ['name', 'title', 'content', 'paths', 'agentOverrides']);

  return {
    name: ensureString(input.name, `${fieldName}.name`),
    title: ensureString(input.title, `${fieldName}.title`),
    content: ensureString(input.content, `${fieldName}.content`),
    paths:
      input.paths === undefined
        ? undefined
        : ensureStringArray(input.paths, `${fieldName}.paths`),
    agentOverrides:
      input.agentOverrides === undefined
        ? undefined
        : normalizePlatformAgentOverrides<InstructionDefinition>(
            input.agentOverrides,
            `${fieldName}.agentOverrides`,
            (overrideInput, overrideFieldName) => {
              assertAllowedKeys(overrideInput, overrideFieldName, ['name', 'title', 'content', 'paths']);
              return {
                name:
                  overrideInput.name === undefined
                    ? undefined
                    : ensureString(overrideInput.name, `${overrideFieldName}.name`),
                title:
                  overrideInput.title === undefined
                    ? undefined
                    : ensureString(overrideInput.title, `${overrideFieldName}.title`),
                content:
                  overrideInput.content === undefined
                    ? undefined
                    : ensureString(overrideInput.content, `${overrideFieldName}.content`),
                paths:
                  overrideInput.paths === undefined
                    ? undefined
                    : ensureStringArray(overrideInput.paths, `${overrideFieldName}.paths`),
              };
            },
          ),
  };
}

function normalizePermissionEntry(
  entry: unknown,
  fieldName: string,
): PermissionDefinition {
  const input = assertObject(entry, fieldName);
  assertAllowedKeys(input, fieldName, ['name', 'allow', 'ask', 'deny', 'agentOverrides']);

  return {
    name: ensureString(input.name, `${fieldName}.name`),
    allow:
      input.allow === undefined
        ? undefined
        : ensureStringArray(input.allow, `${fieldName}.allow`),
    ask:
      input.ask === undefined
        ? undefined
        : ensureStringArray(input.ask, `${fieldName}.ask`),
    deny:
      input.deny === undefined
        ? undefined
        : ensureStringArray(input.deny, `${fieldName}.deny`),
    agentOverrides:
      input.agentOverrides === undefined
        ? undefined
        : normalizePlatformAgentOverrides<PermissionDefinition>(
            input.agentOverrides,
            `${fieldName}.agentOverrides`,
            (overrideInput, overrideFieldName) => {
              assertAllowedKeys(overrideInput, overrideFieldName, ['name', 'allow', 'ask', 'deny']);
              return {
                name:
                  overrideInput.name === undefined
                    ? undefined
                    : ensureString(overrideInput.name, `${overrideFieldName}.name`),
                allow:
                  overrideInput.allow === undefined
                    ? undefined
                    : ensureStringArray(overrideInput.allow, `${overrideFieldName}.allow`),
                ask:
                  overrideInput.ask === undefined
                    ? undefined
                    : ensureStringArray(overrideInput.ask, `${overrideFieldName}.ask`),
                deny:
                  overrideInput.deny === undefined
                    ? undefined
                    : ensureStringArray(overrideInput.deny, `${overrideFieldName}.deny`),
              };
            },
          ),
  };
}

function normalizeHookEntry(entry: unknown, fieldName: string): HookDefinition {
  const input = assertObject(entry, fieldName);
  assertAllowedKeys(input, fieldName, ['event', 'matcher', 'command', 'description', 'agentOverrides']);

  return {
    event: ensureString(input.event, `${fieldName}.event`) as HookEvent,
    matcher:
      input.matcher === undefined
        ? undefined
        : ensureString(input.matcher, `${fieldName}.matcher`),
    command: ensureString(input.command, `${fieldName}.command`),
    description:
      input.description === undefined
        ? undefined
        : ensureString(input.description, `${fieldName}.description`),
    agentOverrides:
      input.agentOverrides === undefined
        ? undefined
        : normalizePlatformAgentOverrides<HookDefinition>(
            input.agentOverrides,
            `${fieldName}.agentOverrides`,
            (overrideInput, overrideFieldName) => {
              assertAllowedKeys(overrideInput, overrideFieldName, [
                'event',
                'matcher',
                'command',
                'description',
              ]);
              return {
                event:
                  overrideInput.event === undefined
                    ? undefined
                    : (ensureString(
                        overrideInput.event,
                        `${overrideFieldName}.event`,
                      ) as HookEvent),
                matcher:
                  overrideInput.matcher === undefined
                    ? undefined
                    : ensureString(overrideInput.matcher, `${overrideFieldName}.matcher`),
                command:
                  overrideInput.command === undefined
                    ? undefined
                    : ensureString(overrideInput.command, `${overrideFieldName}.command`),
                description:
                  overrideInput.description === undefined
                    ? undefined
                    : ensureString(
                        overrideInput.description,
                        `${overrideFieldName}.description`,
                      ),
              };
            },
          ),
  };
}

function normalizeAgentEntry(entry: unknown, fieldName: string): AgentDefinition {
  const input = assertObject(entry, fieldName);
  assertAllowedKeys(input, fieldName, ['name', 'description', 'prompt', 'tools', 'agentOverrides']);

  return {
    name: ensureString(input.name, `${fieldName}.name`),
    description: ensureString(input.description, `${fieldName}.description`),
    prompt: ensureString(input.prompt, `${fieldName}.prompt`),
    tools:
      input.tools === undefined
        ? undefined
        : ensureStringArray(input.tools, `${fieldName}.tools`),
    agentOverrides:
      input.agentOverrides === undefined
        ? undefined
        : normalizePlatformAgentOverrides<AgentDefinition>(
            input.agentOverrides,
            `${fieldName}.agentOverrides`,
            (overrideInput, overrideFieldName) => {
              assertAllowedKeys(overrideInput, overrideFieldName, [
                'name',
                'description',
                'prompt',
                'tools',
              ]);
              return {
                name:
                  overrideInput.name === undefined
                    ? undefined
                    : ensureString(overrideInput.name, `${overrideFieldName}.name`),
                description:
                  overrideInput.description === undefined
                    ? undefined
                    : ensureString(
                        overrideInput.description,
                        `${overrideFieldName}.description`,
                      ),
                prompt:
                  overrideInput.prompt === undefined
                    ? undefined
                    : ensureString(overrideInput.prompt, `${overrideFieldName}.prompt`),
                tools:
                  overrideInput.tools === undefined
                    ? undefined
                    : ensureStringArray(overrideInput.tools, `${overrideFieldName}.tools`),
              };
            },
          ),
  };
}

function normalizeExtensions(
  value: unknown,
  fieldName: string,
): PluginManifestSource['extensions'] {
  const input = assertObject(value, fieldName);
  assertAllowedKeys(input, fieldName, ['instructions', 'permissions', 'hooks', 'agents']);

  return {
    instructions: Array.isArray(input.instructions)
      ? input.instructions.map((entry, index) =>
          normalizeInstructionEntry(entry, `${fieldName}.instructions[${index}]`),
        )
      : [],
    permissions: Array.isArray(input.permissions)
      ? input.permissions.map((entry, index) =>
          normalizePermissionEntry(entry, `${fieldName}.permissions[${index}]`),
        )
      : [],
    hooks: Array.isArray(input.hooks)
      ? input.hooks.map((entry, index) =>
          normalizeHookEntry(entry, `${fieldName}.hooks[${index}]`),
        )
      : [],
    agents: Array.isArray(input.agents)
      ? input.agents.map((entry, index) =>
          normalizeAgentEntry(entry, `${fieldName}.agents[${index}]`),
        )
      : [],
  };
}

export function validateMarketplaceSourceMeta(rawValue: unknown): MarketplaceSourceMeta {
  const input = assertObject(rawValue, 'marketplace source metadata');
  assertAllowedKeys(input, 'marketplace source metadata', ['owner', 'interface']);

  const ownerInput = assertObject(input.owner, 'marketplace source metadata.owner');
  assertAllowedKeys(ownerInput, 'marketplace source metadata.owner', ['name', 'url']);
  const interfaceInput = assertObject(input.interface, 'marketplace source metadata.interface');
  assertAllowedKeys(interfaceInput, 'marketplace source metadata.interface', ['displayName']);

  return {
    owner: {
      name: ensureString(ownerInput.name, 'marketplace source metadata.owner.name'),
      url: ensureString(ownerInput.url, 'marketplace source metadata.owner.url'),
    },
    interface: {
      displayName: ensureString(
        interfaceInput.displayName,
        'marketplace source metadata.interface.displayName',
      ),
    },
  };
}

export async function readMarketplaceSourceMeta(repoRoot: string): Promise<MarketplaceSourceMeta> {
  const sourcePath = path.join(repoRoot, MARKETPLACE_SOURCE_PATH);
  const rawValue = await readJsonFile<unknown>(sourcePath);
  return validateMarketplaceSourceMeta(rawValue);
}

export function validatePluginManifest(
  pluginRoot: string,
  rawManifest: unknown,
): PluginManifestSource {
  const input = assertObject(rawManifest, 'plugin manifest');
  assertAllowedKeys(input, 'plugin manifest', [
    'name',
    'version',
    'description',
    'skills',
    'mcpServers',
    'apps',
    'marketplace',
    'interface',
    'extensions',
    'buildConfig',
  ]);

  const manifest: PluginManifestSource = {
    name: ensureString(input.name, 'name'),
    version: ensureString(input.version, 'version'),
    description: ensureString(input.description, 'description'),
    marketplace: normalizeMarketplaceMeta(input.marketplace, 'marketplace'),
  };

  if (input.skills !== undefined) {
    manifest.skills = normalizePluginRelativePath(
      pluginRoot,
      ensureString(input.skills, 'skills'),
      'skills',
    );
  }

  if (input.mcpServers !== undefined) {
    manifest.mcpServers = normalizePluginRelativePath(
      pluginRoot,
      ensureString(input.mcpServers, 'mcpServers'),
      'mcpServers',
    );
  }

  if (input.apps !== undefined) {
    manifest.apps = normalizePluginRelativePath(
      pluginRoot,
      ensureString(input.apps, 'apps'),
      'apps',
    );
  }

  if (input.interface !== undefined) {
    manifest.interface = normalizePluginInterface(input.interface, 'interface');
  }

  if (input.extensions !== undefined) {
    manifest.extensions = normalizeExtensions(input.extensions, 'extensions');
  }

  if (input.buildConfig !== undefined) {
    manifest.buildConfig = normalizeBuildConfig(pluginRoot, input.buildConfig, 'buildConfig');
  }

  return manifest;
}

export async function readPluginManifest(pluginRoot: string): Promise<PluginMeta> {
  const manifestPath = path.join(pluginRoot, SOURCE_MANIFEST_PATH);
  const rawManifest = await readJsonFile<unknown>(manifestPath);
  const manifest = validatePluginManifest(pluginRoot, rawManifest);
  return {
    rootDir: pluginRoot,
    manifestPath,
    manifest,
  };
}

export async function discoverPluginsInDirectory(pluginsDir: string): Promise<PluginMeta[]> {
  if (!(await fs.pathExists(pluginsDir))) {
    return [];
  }

  const entries = await fs.readdir(pluginsDir);
  const plugins = await Promise.all(
    entries.map(async (entry) => {
      const pluginRoot = path.join(pluginsDir, entry);
      const manifestPath = path.join(pluginRoot, SOURCE_MANIFEST_PATH);
      if (!(await fs.pathExists(manifestPath))) {
        return null;
      }

      return readPluginManifest(pluginRoot);
    }),
  );

  return plugins
    .filter((plugin): plugin is PluginMeta => plugin !== null)
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

export async function discoverPlugins(repoRoot: string): Promise<PluginMeta[]> {
  return discoverPluginsInDirectory(path.join(repoRoot, 'plugins'));
}

function selectPlugins(plugins: PluginMeta[], pluginNames?: string[]): PluginMeta[] {
  if (!pluginNames || pluginNames.length === 0) {
    return plugins;
  }

  const pluginMap = new Map(plugins.map((plugin) => [plugin.manifest.name, plugin]));
  return pluginNames.map((pluginName) => {
    const plugin = pluginMap.get(pluginName);
    if (!plugin) {
      throw new Error(`Unknown plugin "${pluginName}".`);
    }
    return plugin;
  });
}

export async function resolvePlugins(
  repoRoot: string,
  pluginNames?: string[],
): Promise<PluginMeta[]> {
  const plugins = await discoverPlugins(repoRoot);
  return selectPlugins(plugins, pluginNames);
}

export async function resolvePluginsFromCatalog(
  catalogRoot: string,
  pluginNames?: string[],
): Promise<PluginMeta[]> {
  const plugins = await discoverPluginsInDirectory(path.join(catalogRoot, 'plugins'));
  return selectPlugins(plugins, pluginNames);
}

export function createMarketplaceManifestEntry(plugin: PluginMeta): MarketplaceManifest['plugins'][number] {
  return {
    name: plugin.manifest.name,
    source: `./plugins/${plugin.manifest.name}`,
    description: plugin.manifest.description,
    interface: plugin.manifest.interface,
    category: plugin.manifest.marketplace.category,
    tags: plugin.manifest.marketplace.tags,
    strict: plugin.manifest.marketplace.strict,
    policy: plugin.manifest.marketplace.policy,
  };
}

export function createMarketplaceManifest(
  sourceMeta: MarketplaceSourceMeta,
  plugins: PluginMeta[],
): MarketplaceManifest {
  return {
    name: 'aw',
    owner: sourceMeta.owner,
    interface: sourceMeta.interface,
    plugins: plugins.map((plugin) => createMarketplaceManifestEntry(plugin)),
  };
}

export function createBundleSourceManifest(plugin: PluginMeta): PluginManifestSource {
  return {
    ...plugin.manifest,
    extensions: plugin.manifest.extensions
      ? {
          instructions: [...(plugin.manifest.extensions.instructions ?? [])],
          permissions: [...(plugin.manifest.extensions.permissions ?? [])],
          hooks: [...(plugin.manifest.extensions.hooks ?? [])],
          agents: [...(plugin.manifest.extensions.agents ?? [])],
        }
      : undefined,
  };
}

export function createPlatformManifestBase(plugin: PluginMeta): PlatformPluginManifest {
  return {
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    description: plugin.manifest.description,
    interface: plugin.manifest.interface,
  };
}
