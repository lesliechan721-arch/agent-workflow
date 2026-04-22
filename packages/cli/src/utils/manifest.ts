import path from 'node:path';

import fs from 'fs-extra';

import { DEFAULT_CLAUDE_HOOKS_PATH } from '../constants.js';
import type {
  PlatformName,
  PlatformPluginManifest,
  PluginManifestSource,
  PluginMeta,
} from '../types.js';
import { readJsonFile, writeJsonFile } from './json.js';

const SOURCE_MANIFEST_PATH = path.join('.agents-plugin', 'plugin.json');

function ensureString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${fieldName}: expected a non-empty string.`);
  }

  return value;
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

  const resolved = path.resolve(pluginRoot, value);
  const relativeToRoot = path.relative(pluginRoot, resolved);
  if (relativeToRoot === '' || relativeToRoot === '.' || relativeToRoot.startsWith('..')) {
    throw new Error(`Invalid ${fieldName}: path must point to a child path inside the plugin root.`);
  }

  return normalized.startsWith('./') ? normalized : `./${normalized}`;
}

function normalizeStringArray(
  pluginRoot: string,
  value: unknown,
  fieldName: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an array.`);
  }

  return value.map((entry, index) =>
    normalizePluginRelativePath(
      pluginRoot,
      ensureString(entry, `${fieldName}[${index}]`),
      `${fieldName}[${index}]`,
    ),
  );
}

export function validatePluginManifest(
  pluginRoot: string,
  rawManifest: unknown,
): PluginManifestSource {
  if (typeof rawManifest !== 'object' || rawManifest === null) {
    throw new Error('Invalid plugin manifest: expected an object.');
  }

  const input = rawManifest as Record<string, unknown>;
  const manifest: PluginManifestSource = {
    name: ensureString(input.name, 'name'),
    version: ensureString(input.version, 'version'),
    description: ensureString(input.description, 'description'),
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
    if (typeof input.interface !== 'object' || input.interface === null) {
      throw new Error('Invalid interface: expected an object.');
    }

    const interfaceBlock = input.interface as Record<string, unknown>;
    manifest.interface = {
      displayName:
        typeof interfaceBlock.displayName === 'string'
          ? interfaceBlock.displayName
          : undefined,
      shortDescription:
        typeof interfaceBlock.shortDescription === 'string'
          ? interfaceBlock.shortDescription
          : undefined,
      capabilities: Array.isArray(interfaceBlock.capabilities)
        ? interfaceBlock.capabilities.filter((entry): entry is string => typeof entry === 'string')
        : undefined,
    };
  }

  if (input.extensions !== undefined) {
    if (typeof input.extensions !== 'object' || input.extensions === null) {
      throw new Error('Invalid extensions: expected an object.');
    }

    const extensions = input.extensions as Record<string, unknown>;
    manifest.extensions = {
      instructions: Array.isArray(extensions.instructions)
        ? extensions.instructions.map((entry, index) => {
            if (typeof entry !== 'object' || entry === null) {
              throw new Error(`Invalid instructions[${index}]: expected an object.`);
            }
            const instruction = entry as Record<string, unknown>;
            return {
              name: ensureString(instruction.name, `instructions[${index}].name`),
              title: ensureString(instruction.title, `instructions[${index}].title`),
              content: ensureString(instruction.content, `instructions[${index}].content`),
              paths: Array.isArray(instruction.paths)
                ? instruction.paths.map((value, pathIndex) =>
                    ensureString(
                      value,
                      `instructions[${index}].paths[${pathIndex}]`,
                    ),
                  )
                : undefined,
            };
          })
        : [],
      permissions: Array.isArray(extensions.permissions)
        ? extensions.permissions.map((entry, index) => {
            if (typeof entry !== 'object' || entry === null) {
              throw new Error(`Invalid permissions[${index}]: expected an object.`);
            }
            const permission = entry as Record<string, unknown>;
            return {
              name: ensureString(permission.name, `permissions[${index}].name`),
              allow: Array.isArray(permission.allow)
                ? permission.allow.map((value, allowIndex) =>
                    ensureString(value, `permissions[${index}].allow[${allowIndex}]`),
                  )
                : undefined,
              ask: Array.isArray(permission.ask)
                ? permission.ask.map((value, askIndex) =>
                    ensureString(value, `permissions[${index}].ask[${askIndex}]`),
                  )
                : undefined,
              deny: Array.isArray(permission.deny)
                ? permission.deny.map((value, denyIndex) =>
                    ensureString(value, `permissions[${index}].deny[${denyIndex}]`),
                  )
                : undefined,
            };
          })
        : [],
      hooks: Array.isArray(extensions.hooks)
        ? extensions.hooks.map((entry, index) => {
            if (typeof entry !== 'object' || entry === null) {
              throw new Error(`Invalid hooks[${index}]: expected an object.`);
            }
            const hook = entry as Record<string, unknown>;
            return {
              event: ensureString(hook.event, `hooks[${index}].event`) as
                | 'before_tool'
                | 'after_tool'
                | 'session_start'
                | 'session_stop'
                | 'command',
              matcher:
                typeof hook.matcher === 'string' ? hook.matcher : undefined,
              command: ensureString(hook.command, `hooks[${index}].command`),
              description:
                typeof hook.description === 'string' ? hook.description : undefined,
            };
          })
        : [],
      agents: Array.isArray(extensions.agents)
        ? extensions.agents.map((entry, index) => {
            if (typeof entry !== 'object' || entry === null) {
              throw new Error(`Invalid agents[${index}]: expected an object.`);
            }
            const agent = entry as Record<string, unknown>;
            return {
              name: ensureString(agent.name, `agents[${index}].name`),
              description: ensureString(agent.description, `agents[${index}].description`),
              prompt: ensureString(agent.prompt, `agents[${index}].prompt`),
              tools: Array.isArray(agent.tools)
                ? agent.tools.map((value, toolIndex) =>
                    ensureString(value, `agents[${index}].tools[${toolIndex}]`),
                  )
                : undefined,
            };
          })
        : [],
    };
  }

  if (input.claude !== undefined) {
    if (typeof input.claude !== 'object' || input.claude === null) {
      throw new Error('Invalid claude block: expected an object.');
    }

    const claude = input.claude as Record<string, unknown>;
    manifest.claude = {
      agents: normalizeStringArray(pluginRoot, claude.agents, 'claude.agents'),
      hooks:
        typeof claude.hooks === 'string'
          ? normalizePluginRelativePath(
              pluginRoot,
              ensureString(claude.hooks, 'claude.hooks'),
              'claude.hooks',
            )
          : typeof claude.hooks === 'object' && claude.hooks !== null
            ? (claude.hooks as Record<string, unknown>)
            : undefined,
    };
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

export async function discoverPlugins(repoRoot: string): Promise<PluginMeta[]> {
  const pluginsDir = path.join(repoRoot, 'plugins');
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

  return plugins.filter((plugin): plugin is PluginMeta => plugin !== null);
}

export async function resolvePlugins(
  repoRoot: string,
  pluginNames?: string[],
): Promise<PluginMeta[]> {
  const plugins = await discoverPlugins(repoRoot);
  if (!pluginNames || pluginNames.length === 0) {
    return plugins;
  }

  const pluginMap = new Map(plugins.map((plugin) => [plugin.manifest.name, plugin]));
  const selected = pluginNames.map((pluginName) => {
    const plugin = pluginMap.get(pluginName);
    if (!plugin) {
      throw new Error(`Unknown plugin "${pluginName}".`);
    }
    return plugin;
  });

  return selected;
}

export function generatePlatformManifest(
  manifest: PluginManifestSource,
  platform: PlatformName,
): PlatformPluginManifest {
  const output: PlatformPluginManifest = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
  };

  if (manifest.skills) {
    output.skills = manifest.skills;
  }
  if (manifest.mcpServers) {
    output.mcpServers = manifest.mcpServers;
  }
  if (manifest.apps) {
    output.apps = manifest.apps;
  }
  if (manifest.interface) {
    output.interface = manifest.interface;
  }

  if (platform === 'claude' && manifest.claude) {
    if (manifest.claude.agents?.length) {
      output.agents = manifest.claude.agents;
    }

    if (
      manifest.claude.hooks &&
      !(typeof manifest.claude.hooks === 'string' && manifest.claude.hooks === DEFAULT_CLAUDE_HOOKS_PATH)
    ) {
      output.hooks = manifest.claude.hooks;
    }
  }

  return output;
}

function getPlatformManifestPath(pluginRoot: string, platform: PlatformName): string {
  return path.join(
    pluginRoot,
    platform === 'claude' ? '.claude-plugin' : '.codex-plugin',
    'plugin.json',
  );
}

export async function writePlatformManifest(
  plugin: PluginMeta,
  platform: PlatformName,
): Promise<string> {
  const manifestPath = getPlatformManifestPath(plugin.rootDir, platform);
  const generatedManifest = generatePlatformManifest(plugin.manifest, platform);
  await writeJsonFile(manifestPath, generatedManifest);
  return manifestPath;
}

export async function syncGeneratedPluginManifests(
  plugins: PluginMeta[],
): Promise<Record<string, string[]>> {
  const results: Record<string, string[]> = {};
  for (const plugin of plugins) {
    const written = await Promise.all([
      writePlatformManifest(plugin, 'claude'),
      writePlatformManifest(plugin, 'codex'),
    ]);
    results[plugin.manifest.name] = written;
  }

  return results;
}

