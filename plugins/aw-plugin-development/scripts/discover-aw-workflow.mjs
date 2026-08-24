#!/usr/bin/env node

import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function usage() {
  return [
    'Usage: discover-aw-workflow.mjs --entry <plugin-or-skill> --plugin <root> [--plugin <root>]... [options]',
    '  --materialized <plugin=profile=skills-root>   Add a materialized Skill collection.',
    '  --format <json|text>',
  ].join('\n');
}

function parseMaterialized(value) {
  const first = value.indexOf('=');
  const second = value.indexOf('=', first + 1);
  if (first < 1 || second <= first + 1 || second === value.length - 1) {
    throw new Error('--materialized requires plugin=profile=skills-root.');
  }
  return {
    plugin: value.slice(0, first),
    profile: value.slice(first + 1, second),
    root: path.resolve(value.slice(second + 1)),
  };
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const options = { entry: null, pluginRoots: [], materialized: [], format: 'json' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--entry') options.entry = argv[++index] ?? null;
    else if (arg === '--plugin') options.pluginRoots.push(path.resolve(argv[++index] ?? ''));
    else if (arg === '--materialized') options.materialized.push(parseMaterialized(argv[++index] ?? ''));
    else if (arg === '--format') options.format = argv[++index] ?? '';
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.entry || options.pluginRoots.length < 2) throw new Error(usage());
  if (!['json', 'text'].includes(options.format)) throw new Error('--format must be json or text.');
  return options;
}

async function listSkills(root) {
  const skills = [];
  const rootInfo = await lstat(root).catch(() => null);
  if (!rootInfo) return skills;
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Skill root must be a regular directory: ${root}`);
  }

  async function walk(directory, relative = '') {
    const skillFile = path.join(directory, 'SKILL.md');
    const skillInfo = await lstat(skillFile).catch(() => null);
    if (skillInfo?.isSymbolicLink()) throw new Error(`Skill file cannot be a symlink: ${skillFile}`);
    if (skillInfo?.isFile()) {
      const content = await readFile(skillFile, 'utf8');
      const name = content.match(/^name:\s*([^\n]+)$/mu)?.[1]?.trim() ?? path.basename(directory);
      skills.push({ name, path: path.posix.join(relative, 'SKILL.md') });
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (['.git', 'node_modules', '.DS_Store'].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Skill discovery cannot traverse symlink: ${absolute}`);
      if (info.isDirectory()) await walk(absolute, path.posix.join(relative, entry.name));
    }
  }

  await walk(root);
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeProductToken(value) {
  return value.trim().toUpperCase().replace(/[\s-]+/gu, '_');
}

function supportedPlatforms(manifest) {
  const products = manifest.marketplace?.policy?.products;
  if (!Array.isArray(products) || products.length === 0) return ['claude', 'codex'];
  const platforms = new Set();
  for (const product of products) {
    if (typeof product !== 'string') continue;
    const token = normalizeProductToken(product);
    if (token === 'CLAUDE') platforms.add('claude');
    if (token === 'CODEX') platforms.add('codex');
  }
  return [...platforms].sort();
}

function importEdge(from, reference, source, extra = {}) {
  if (typeof reference?.plugin !== 'string' || typeof reference?.export !== 'string') return null;
  return { from, to: reference.plugin, export: reference.export, source, ...extra };
}

function edgesFrom(manifest) {
  const dependencyEdges = (manifest.dependencies ?? [])
    .flatMap((dependency) => typeof dependency === 'string'
      ? [{ from: manifest.name, to: dependency, source: 'manifest.dependencies' }]
      : []);
  const buildImportEdges = (manifest.buildConfig?.buildImports ?? [])
    .flatMap((entry, index) => importEdge(
      manifest.name,
      entry,
      `buildConfig.buildImports[${index}]`,
      { env: entry?.env ?? null },
    ) ?? []);
  const skillRuntimeFileImportEdges = (manifest.buildConfig?.skillRuntimeFiles ?? [])
    .flatMap((entry, index) => importEdge(
      manifest.name,
      entry?.import,
      `buildConfig.skillRuntimeFiles[${index}].import`,
      { skill: entry?.skill ?? null, target: entry?.target ?? null },
    ) ?? []);
  const artifactRuntimeImportEdges = (manifest.artifacts?.targets ?? [])
    .flatMap((target, targetIndex) => (target?.runtimeImports ?? [])
      .flatMap((entry, importIndex) => importEdge(
        manifest.name,
        entry,
        `artifacts.targets[${targetIndex}].runtimeImports[${importIndex}]`,
        { targetId: target?.id ?? null, importName: entry?.name ?? null },
      ) ?? []));
  return {
    dependencyEdges,
    buildImportEdges,
    skillRuntimeFileImportEdges,
    artifactRuntimeImportEdges,
  };
}

async function readPluginManifest(pluginRoot) {
  const rootInfo = await lstat(pluginRoot).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Plugin root must be a regular directory: ${pluginRoot}`);
  }
  const manifestDirectory = path.join(pluginRoot, '.agents-plugin');
  const manifestDirectoryInfo = await lstat(manifestDirectory).catch(() => null);
  if (!manifestDirectoryInfo?.isDirectory() || manifestDirectoryInfo.isSymbolicLink()) {
    throw new Error(`Plugin manifest directory must be a regular directory: ${manifestDirectory}`);
  }
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifestInfo = await lstat(manifestPath).catch(() => null);
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) {
    throw new Error(`Plugin manifest must be a regular file: ${manifestPath}`);
  }
  return { manifestPath, manifest: JSON.parse(await readFile(manifestPath, 'utf8')) };
}

function isResolvedVirtualImport(edge, edgeType) {
  return edge.to === '@aw/cli'
    && edgeType === 'buildImportEdges'
    && edge.export === 'skill-frontmatter-capabilities';
}

function findCycles(names, edges) {
  const graph = new Map(names.map((name) => [name, []]));
  for (const edge of edges) {
    if (graph.has(edge.from) && graph.has(edge.to)) graph.get(edge.from).push(edge.to);
  }
  const cycles = [];
  const visited = new Set();
  const stack = [];
  const active = new Set();

  function visit(node) {
    if (active.has(node)) {
      const start = stack.indexOf(node);
      cycles.push([...stack.slice(start), node]);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    active.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) visit(next);
    stack.pop();
    active.delete(node);
  }

  for (const name of names) visit(name);
  const keys = new Set();
  return cycles.filter((cycle) => {
    const key = cycle.join('>');
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const plugins = [];
  const seenNames = new Set();
  for (const pluginRoot of options.pluginRoots) {
    const { manifestPath, manifest } = await readPluginManifest(pluginRoot);
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
      throw new Error(`Invalid plugin name: ${manifestPath}`);
    }
    if (seenNames.has(manifest.name)) throw new Error(`Duplicate plugin name: ${manifest.name}`);
    seenNames.add(manifest.name);
    if (manifest.skills !== undefined && manifest.skills !== './skills') {
      throw new Error(`Invalid plugin skills path: ${manifestPath}`);
    }
    const skillsRoot = path.join(pluginRoot, 'skills');
    plugins.push({
      name: manifest.name,
      root: pluginRoot,
      skills: await listSkills(skillsRoot),
      products: [...new Set(manifest.marketplace?.policy?.products ?? [])].sort(),
      supportedPlatforms: supportedPlatforms(manifest),
      dependencies: [...new Set(manifest.dependencies ?? [])].sort(),
      runtimeExports: (manifest.buildConfig?.runtimeExports ?? [])
        .flatMap((entry) => typeof entry?.name === 'string' ? [entry.name] : [])
        .sort(),
      workflowEdges: edgesFrom(manifest),
      materializedTargets: [],
    });
  }

  for (const target of options.materialized) {
    const plugin = plugins.find((entry) => entry.name === target.plugin);
    if (!plugin) throw new Error(`Unknown materialized plugin: ${target.plugin}`);
    plugin.materializedTargets.push({
      profile: target.profile,
      root: target.root,
      skills: await listSkills(target.root),
    });
  }

  const providedNames = new Set(plugins.map((plugin) => plugin.name));
  const exportsByPlugin = new Map(plugins.map((plugin) => [plugin.name, new Set(plugin.runtimeExports)]));
  const platformsByPlugin = new Map(plugins.map((plugin) => [plugin.name, new Set(plugin.supportedPlatforms)]));
  const dependencyEdges = plugins.flatMap((plugin) => plugin.workflowEdges.dependencyEdges);
  const buildImportEdges = plugins.flatMap((plugin) => plugin.workflowEdges.buildImportEdges);
  const skillRuntimeFileImportEdges = plugins.flatMap((plugin) => plugin.workflowEdges.skillRuntimeFileImportEdges);
  const artifactRuntimeImportEdges = plugins.flatMap((plugin) => plugin.workflowEdges.artifactRuntimeImportEdges);
  const edgeGroups = {
    dependencyEdges,
    buildImportEdges,
    skillRuntimeFileImportEdges,
    artifactRuntimeImportEdges,
  };
  const unresolved = Object.fromEntries(Object.keys(edgeGroups).map((key) => [key, []]));
  const dependencyNamesByPlugin = new Map(plugins.map((plugin) => [plugin.name, new Set(plugin.dependencies)]));

  for (const edge of dependencyEdges) {
    if (!providedNames.has(edge.to)) {
      unresolved.dependencyEdges.push({ ...edge, reason: 'missing-provider' });
      continue;
    }
    const requiredPlatforms = platformsByPlugin.get(edge.from) ?? new Set();
    const providerPlatforms = platformsByPlugin.get(edge.to) ?? new Set();
    const missingPlatforms = [...requiredPlatforms]
      .filter((platform) => !providerPlatforms.has(platform))
      .sort();
    if (missingPlatforms.length > 0) {
      unresolved.dependencyEdges.push({
        ...edge,
        reason: 'incomplete-product-coverage',
        missingPlatforms,
      });
    }
  }

  for (const [edgeType, edges] of Object.entries({
    buildImportEdges,
    skillRuntimeFileImportEdges,
    artifactRuntimeImportEdges,
  })) {
    for (const edge of edges) {
      if (isResolvedVirtualImport(edge, edgeType)) continue;
      if (edge.to === '@aw/cli') {
        unresolved[edgeType].push({
          ...edge,
          reason: edgeType === 'buildImportEdges'
            ? 'missing-export'
            : 'unsupported-virtual-import-kind',
        });
      } else if (!providedNames.has(edge.to)) {
        unresolved[edgeType].push({ ...edge, reason: 'missing-provider' });
      } else if (!exportsByPlugin.get(edge.to)?.has(edge.export)) {
        unresolved[edgeType].push({ ...edge, reason: 'missing-export' });
      } else if (!dependencyNamesByPlugin.get(edge.from)?.has(edge.to)) {
        unresolved[edgeType].push({ ...edge, reason: 'missing-manifest-dependency' });
      }
    }
  }

  for (const plugin of plugins) {
    delete plugin.workflowEdges;
  }

  const skillOwners = new Map();
  for (const plugin of plugins) {
    for (const skill of plugin.skills) {
      const owners = skillOwners.get(skill.name) ?? [];
      owners.push(plugin.name);
      skillOwners.set(skill.name, owners);
    }
  }
  const entryPlugins = plugins.filter((plugin) => plugin.name === options.entry).map((plugin) => plugin.name);
  const entrySkills = [...skillOwners.entries()]
    .filter(([name]) => name === options.entry)
    .map(([name, owners]) => ({ name, owners }));

  const result = {
    schemaVersion: 2,
    entry: options.entry,
    entryResolution: {
      plugins: entryPlugins,
      skills: entrySkills,
      resolved: entryPlugins.length + entrySkills.length > 0,
    },
    plugins,
    ...edgeGroups,
    unresolved,
    cycles: Object.fromEntries(Object.entries(edgeGroups).map(([key, edges]) => [
      key,
      findCycles(plugins.map((plugin) => plugin.name), edges),
    ])),
  };

  if (options.format === 'json') {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Entry: ${result.entry} (${result.entryResolution.resolved ? 'resolved' : 'unresolved'})\n`);
    for (const plugin of plugins) {
      const importCount = buildImportEdges.filter((edge) => edge.from === plugin.name).length
        + skillRuntimeFileImportEdges.filter((edge) => edge.from === plugin.name).length
        + artifactRuntimeImportEdges.filter((edge) => edge.from === plugin.name).length;
      process.stdout.write(`- ${plugin.name}: ${plugin.skills.length} skills, ${importCount} imports\n`);
    }
    process.stdout.write(`Cycles: ${Object.values(result.cycles).reduce((total, entries) => total + entries.length, 0)}\n`);
    process.stdout.write(`Unresolved edges: ${Object.values(result.unresolved).reduce((total, entries) => total + entries.length, 0)}\n`);
  }
  if (!result.entryResolution.resolved
    || Object.values(result.cycles).some((entries) => entries.length > 0)) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`[ERROR] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
