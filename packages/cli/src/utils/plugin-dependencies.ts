import type { PlatformName, PluginManifestSource, PluginMeta } from '../types.js';
import { resolveSupportedPlatforms } from './platform-support.js';

export const MAX_DIRECT_PLUGIN_DEPENDENCIES = 64;
export const MAX_PLUGIN_DEPENDENCY_CLOSURE = 256;
export const MAX_PLUGIN_DEPENDENCY_DEPTH = 32;

type PluginDependencyNode = PluginManifestSource;

function comparePluginNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createPluginMap<T extends PluginDependencyNode>(
  plugins: readonly T[],
): Map<string, T> {
  const pluginsByName = new Map<string, T>();
  for (const plugin of plugins) {
    if (pluginsByName.has(plugin.name)) {
      throw new Error(`Invalid plugin dependency graph: duplicate plugin "${plugin.name}".`);
    }
    pluginsByName.set(plugin.name, plugin);
  }
  return pluginsByName;
}

function sortedDependencies(plugin: PluginDependencyNode): string[] {
  return [...(plugin.dependencies ?? [])].sort(comparePluginNames);
}

function assertCompleteDependencies<T extends PluginDependencyNode>(
  pluginsByName: ReadonlyMap<string, T>,
): void {
  for (const plugin of [...pluginsByName.values()].sort((left, right) =>
    comparePluginNames(left.name, right.name))) {
    for (const dependencyName of sortedDependencies(plugin)) {
      if (!pluginsByName.has(dependencyName)) {
        throw new Error(
          `Invalid plugin dependency graph: plugin "${plugin.name}" requires missing plugin "${dependencyName}" from the same source.`,
        );
      }
    }
  }
}

function assertAcyclic<T extends PluginDependencyNode>(
  pluginsByName: ReadonlyMap<string, T>,
): void {
  const visited = new Set<string>();
  const active = new Map<string, number>();
  const path: string[] = [];

  const visit = (pluginName: string): void => {
    if (visited.has(pluginName)) return;
    const cycleStart = active.get(pluginName);
    if (cycleStart !== undefined) {
      const cycle = [...path.slice(cycleStart), pluginName];
      throw new Error(`Invalid plugin dependency graph: cycle ${cycle.join(' -> ')}.`);
    }

    active.set(pluginName, path.length);
    path.push(pluginName);
    for (const dependencyName of sortedDependencies(pluginsByName.get(pluginName)!)) {
      visit(dependencyName);
    }
    path.pop();
    active.delete(pluginName);
    visited.add(pluginName);
  };

  for (const pluginName of [...pluginsByName.keys()].sort(comparePluginNames)) {
    visit(pluginName);
  }
}

function assertMarketplaceProductCoverage<T extends PluginDependencyNode>(
  pluginsByName: ReadonlyMap<string, T>,
): void {
  for (const plugin of [...pluginsByName.values()].sort((left, right) =>
    comparePluginNames(left.name, right.name))) {
    const requiredPlatforms = resolveSupportedPlatforms(plugin);
    for (const dependencyName of sortedDependencies(plugin)) {
      const dependency = pluginsByName.get(dependencyName)!;
      const dependencyPlatforms = resolveSupportedPlatforms(dependency);
      const missingPlatforms = [...requiredPlatforms]
        .filter((platform) => !dependencyPlatforms.has(platform))
        .sort(comparePluginNames) as PlatformName[];
      if (missingPlatforms.length > 0) {
        throw new Error(
          `Invalid plugin dependency graph: dependency "${dependencyName}" does not cover plugin "${plugin.name}" marketplace products (${missingPlatforms.join(', ')} missing).`,
        );
      }
    }
  }
}

function collectClosureNames<T extends PluginDependencyNode>(
  pluginsByName: ReadonlyMap<string, T>,
  rootNames: readonly string[],
): Set<string> {
  const closure = new Set<string>();
  const depths = new Map<string, number>();
  const visit = (pluginName: string, depth: number): void => {
    if (depth > MAX_PLUGIN_DEPENDENCY_DEPTH) {
      throw new Error(
        `Invalid plugin dependency graph: dependency depth from roots [${rootNames.join(', ')}] exceeds ${MAX_PLUGIN_DEPENDENCY_DEPTH} at "${pluginName}".`,
      );
    }
    if ((depths.get(pluginName) ?? -1) >= depth) return;
    depths.set(pluginName, depth);
    closure.add(pluginName);
    if (closure.size > MAX_PLUGIN_DEPENDENCY_CLOSURE) {
      throw new Error(
        `Invalid plugin dependency graph: dependency closure for roots [${rootNames.join(', ')}] exceeds ${MAX_PLUGIN_DEPENDENCY_CLOSURE} plugins.`,
      );
    }
    for (const dependencyName of sortedDependencies(pluginsByName.get(pluginName)!)) {
      visit(dependencyName, depth + 1);
    }
  };
  for (const rootName of rootNames) visit(rootName, 0);
  return closure;
}

function dependencyFirstOrder<T extends PluginDependencyNode>(
  pluginsByName: ReadonlyMap<string, T>,
  selectedNames: ReadonlySet<string>,
): T[] {
  const remainingDependencies = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const pluginName of selectedNames) {
    const dependencies = sortedDependencies(pluginsByName.get(pluginName)!)
      .filter((dependencyName) => selectedNames.has(dependencyName));
    remainingDependencies.set(pluginName, dependencies.length);
    for (const dependencyName of dependencies) {
      const current = dependents.get(dependencyName) ?? [];
      current.push(pluginName);
      dependents.set(dependencyName, current);
    }
  }

  let layer = [...selectedNames]
    .filter((pluginName) => remainingDependencies.get(pluginName) === 0)
    .sort(comparePluginNames);
  const ordered: T[] = [];
  while (layer.length > 0) {
    const nextLayer = new Set<string>();
    for (const pluginName of layer) {
      ordered.push(pluginsByName.get(pluginName)!);
      for (const dependentName of dependents.get(pluginName) ?? []) {
        const remaining = remainingDependencies.get(dependentName)! - 1;
        remainingDependencies.set(dependentName, remaining);
        if (remaining === 0) nextLayer.add(dependentName);
      }
    }
    layer = [...nextLayer].sort(comparePluginNames);
  }
  return ordered;
}

export function validatePluginDependencyGraph<T extends PluginDependencyNode>(
  plugins: readonly T[],
): void {
  const pluginsByName = createPluginMap(plugins);
  assertCompleteDependencies(pluginsByName);
  assertAcyclic(pluginsByName);
  assertMarketplaceProductCoverage(pluginsByName);
  for (const pluginName of pluginsByName.keys()) {
    collectClosureNames(pluginsByName, [pluginName]);
  }
}

export function orderPluginsByDependencies<T extends PluginDependencyNode>(
  plugins: readonly T[],
): T[] {
  validatePluginDependencyGraph(plugins);
  const pluginsByName = createPluginMap(plugins);
  return dependencyFirstOrder(pluginsByName, new Set(pluginsByName.keys()));
}

export function resolvePluginDependencyClosure<T extends PluginDependencyNode>(
  plugins: readonly T[],
  rootNames: readonly string[],
): T[] {
  validatePluginDependencyGraph(plugins);
  const pluginsByName = createPluginMap(plugins);
  const uniqueRoots = [...new Set(rootNames)].sort(comparePluginNames);
  for (const rootName of uniqueRoots) {
    if (!pluginsByName.has(rootName)) {
      throw new Error(`Unknown plugin dependency root "${rootName}".`);
    }
  }
  const closure = collectClosureNames(pluginsByName, uniqueRoots);
  return dependencyFirstOrder(pluginsByName, closure);
}

export function validatePluginMetaDependencyGraph(plugins: readonly PluginMeta[]): void {
  validatePluginDependencyGraph(plugins.map((plugin) => plugin.manifest));
}

export function orderPluginMetasByDependencies(plugins: readonly PluginMeta[]): PluginMeta[] {
  const pluginsByName = new Map(plugins.map((plugin) => [plugin.manifest.name, plugin]));
  return orderPluginsByDependencies(plugins.map((plugin) => plugin.manifest))
    .map((manifest) => pluginsByName.get(manifest.name)!);
}

export function resolvePluginMetaDependencyClosure(
  plugins: readonly PluginMeta[],
  rootNames: readonly string[],
): PluginMeta[] {
  const pluginsByName = new Map(plugins.map((plugin) => [plugin.manifest.name, plugin]));
  return resolvePluginDependencyClosure(
    plugins.map((plugin) => plugin.manifest),
    rootNames,
  ).map((manifest) => pluginsByName.get(manifest.name)!);
}
