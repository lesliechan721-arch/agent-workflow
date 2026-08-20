import { createHash } from 'node:crypto';
import path from 'node:path';

import { createRuntimeSkillSnapshot } from '@lesliechan721/agent-skill-eval';
import fs from 'fs-extra';

import { createRebuildIntegration } from '../src/commands/rebuild-integration.js';
import { bundleLocalPlugin, prepareLocalPluginBundleSource } from '../src/generators/local-plugin.js';
import { createNoopDebugLogger } from '../src/output/debug-log.js';
import { createNoopReporter } from '../src/output/reporter.js';
import type { PluginMeta } from '../src/types.js';
import { createCatalogRuntimeImportResolver } from '../src/utils/catalog-runtime-projection.js';
import { writePluginConfigStore } from '../src/utils/plugin-config.js';
import { validateSkillDirectoriesRoot } from '../src/utils/dynamic-skill-tree.js';
import {
  PLUGIN_EVAL_SCHEMA_VERSION,
  type MaterializedPluginEvalArtifact,
  type MaterializedPluginEvalSubject,
  type PluginEvalManifest,
  type PluginEvalProfile,
} from './plugin-eval-contract.js';

export interface MaterializePluginEvalOptions {
  plugin: PluginMeta;
  plugins: PluginMeta[];
  manifest: PluginEvalManifest;
  outputRoot: string;
  workRoot: string;
  env?: NodeJS.ProcessEnv;
  selectedProfiles?: ReadonlySet<string>;
}

interface PreparedEvalBundle {
  sourceRoot: string;
  stagingRoot: string;
  bundleRoot: string;
  plugin: PluginMeta;
  bundleDigest: string;
  cleanup(): Promise<void>;
}

function sha256(content: string | Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function listFiles(root: string): Promise<string[]> {
  if (!(await fs.pathExists(root))) {
    return [];
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFiles(entryPath);
      files.push(...nested.map((file) => path.join(entry.name, file)));
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function digestTree(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const relativePath of await listFiles(root)) {
    hash.update(relativePath.split(path.sep).join('/'));
    hash.update('\0');
    hash.update(await fs.readFile(path.join(root, relativePath)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

async function prepareEvalBundle(
  plugin: PluginMeta,
  plugins: PluginMeta[],
  workRoot: string,
): Promise<PreparedEvalBundle> {
  await fs.ensureDir(workRoot);
  const tempRoot = await fs.mkdtemp(path.join(workRoot, 'bundle-'));
  const prepared = await prepareLocalPluginBundleSource(plugin, {
    buildMode: 'staging',
    runtimeResolver: createCatalogRuntimeImportResolver(plugins),
  });
  const bundleRoot = path.join(tempRoot, 'bundle');
  try {
    await bundleLocalPlugin(prepared.plugin, bundleRoot, {
      buildMode: 'prepared',
      preparedRuntimeContext: prepared.runtimeContext,
    });
    return {
      sourceRoot: plugin.rootDir,
      stagingRoot: prepared.plugin.rootDir,
      bundleRoot,
      plugin: {
        ...prepared.plugin,
        rootDir: bundleRoot,
        manifestPath: path.join(bundleRoot, '.agents-plugin', 'plugin.json'),
      },
      bundleDigest: await digestTree(bundleRoot),
      cleanup: async () => {
        await prepared.cleanup();
        await fs.remove(tempRoot);
      },
    };
  } catch (error) {
    await prepared.cleanup();
    await fs.remove(tempRoot);
    throw error;
  }
}

function createIsolatedEnv(
  baseEnv: NodeJS.ProcessEnv,
  scopeRoot: string,
): NodeJS.ProcessEnv {
  const home = path.join(scopeRoot, 'home');
  const temp = path.join(scopeRoot, 'tmp');
  return {
    ...baseEnv,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(scopeRoot, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(scopeRoot, 'xdg-config'),
    XDG_STATE_HOME: path.join(scopeRoot, 'xdg-state'),
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    AW_HOME: path.join(scopeRoot, 'aw-home'),
    AW_CODEX_HOME: path.join(scopeRoot, 'codex-home'),
    NODE_PATH: '',
  };
}

async function collectArtifacts(
  root: string,
  subjectRoot: string,
): Promise<MaterializedPluginEvalArtifact[]> {
  const artifacts: MaterializedPluginEvalArtifact[] = [];
  for (const relativePath of await listFiles(root)) {
    const absolutePath = path.join(root, relativePath);
    const normalized = relativePath.split(path.sep).join('/');
    const segments = normalized.split('/');
    let kind: MaterializedPluginEvalArtifact['kind'] = 'config';
    let key: string | undefined;
    const skillsIndex = segments.indexOf('skills');
    const agentsIndex = segments.indexOf('agents');
    if (skillsIndex >= 0 && segments[skillsIndex + 1]) {
      kind = 'skill';
      key = segments[skillsIndex + 1];
    } else if (normalized.endsWith('.toml') && agentsIndex >= 0) {
      kind = 'agent';
      key = path.basename(normalized, '.toml');
    } else if (normalized.endsWith('config.toml')) {
      kind = 'instruction';
    }
    artifacts.push({
      kind,
      ...(key ? { key } : {}),
      path: path.relative(subjectRoot, absolutePath).split(path.sep).join('/'),
      contentDigest: sha256(await fs.readFile(absolutePath)),
    });
  }
  return artifacts;
}

async function snapshotRuntimeSkills(sourceRoot: string, targetRoot: string): Promise<void> {
  await validateSkillDirectoriesRoot(sourceRoot, 'codex.skill');
  await fs.ensureDir(targetRoot);
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(targetRoot, entry.name);
    await createRuntimeSkillSnapshot(source, destination);
  }
}

async function copyUserMaterializedArtifacts(options: {
  scopeRoot: string;
  env: NodeJS.ProcessEnv;
  pluginNames: string[];
}): Promise<string> {
  const materializedRoot = path.join(options.scopeRoot, 'materialized');
  const skillsRoot = path.join(materializedRoot, '.agents', 'skills');
  for (const pluginName of options.pluginNames) {
    const runtimeSkillsRoot = path.join(
      options.env.AW_HOME!,
      'plugins',
      pluginName,
      'codex',
      'skills',
    );
    if (await fs.pathExists(runtimeSkillsRoot)) {
      await snapshotRuntimeSkills(runtimeSkillsRoot, skillsRoot);
    }
  }

  const codexHome = options.env.AW_CODEX_HOME!;
  if (await fs.pathExists(codexHome)) {
    await fs.copy(codexHome, path.join(materializedRoot, '.codex'), {
      overwrite: true,
      dereference: false,
      filter: (source) => path.basename(source) !== 'auth.json' && path.basename(source) !== '.credentials.json',
    });
  }
  return materializedRoot;
}

async function materializeStaticCodexSkills(options: {
  prepared: PreparedEvalBundle;
  profile: PluginEvalProfile;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const sourceRoot = path.join(options.prepared.bundleRoot, 'codex', 'skills');
  if (!(await fs.pathExists(sourceRoot))) {
    return;
  }
  const targetRoot = options.profile.scope === 'project'
    ? path.join(options.projectRoot, '.agents', 'skills')
    : path.join(
        options.env.AW_HOME!,
        'plugins',
        options.prepared.plugin.manifest.name,
        'codex',
        'skills',
      );
  await snapshotRuntimeSkills(sourceRoot, targetRoot);
}

async function materializeProfile(options: {
  preparedByName: ReadonlyMap<string, PreparedEvalBundle>;
  ownerPlugin: PluginMeta;
  ownerSkill: string;
  requiredSkills: ReadonlySet<string>;
  profile: PluginEvalProfile;
  outputRoot: string;
  baseEnv: NodeJS.ProcessEnv;
}): Promise<MaterializedPluginEvalSubject> {
  const scopeRoot = path.join(options.outputRoot, 'subjects', options.profile.id);
  await fs.remove(scopeRoot);
  await fs.ensureDir(scopeRoot);
  const env = createIsolatedEnv(options.baseEnv, scopeRoot);
  await Promise.all([
    fs.ensureDir(env.HOME!),
    fs.ensureDir(env.TMPDIR!),
    fs.ensureDir(env.AW_HOME!),
    fs.ensureDir(env.AW_CODEX_HOME!),
  ]);
  const projectRoot = path.join(scopeRoot, 'project');
  await fs.ensureDir(path.join(projectRoot, '.git'));

  const installations = options.profile.plugins.map((installation) => {
    const prepared = options.preparedByName.get(installation.name);
    if (!prepared) {
      throw new Error(`Eval profile "${options.profile.id}" references unresolved plugin "${installation.name}".`);
    }
    return { installation, prepared };
  });
  for (const { installation } of installations) {
    await writePluginConfigStore({
      pluginName: installation.name,
      scope: options.profile.scope,
      cwd: projectRoot,
      values: installation.config,
      env,
    });
  }

  for (const { prepared } of installations) {
    await materializeStaticCodexSkills({
      prepared,
      profile: options.profile,
      projectRoot,
      env,
    });
  }

  const integration = createRebuildIntegration({
    context: {
      env,
      nativeCliRunner: async () => {
        throw new Error('Plugin eval materialization cannot run a native CLI.');
      },
      reporter: createNoopReporter(),
      debugLogger: createNoopDebugLogger(),
    },
  });
  for (const { prepared } of installations) {
    const target = await integration.buildTarget({
      plugin: prepared.plugin,
      platform: 'codex',
      scope: options.profile.scope,
      cwd: projectRoot,
      command: 'install',
      catalog: {
        rootDir: prepared.bundleRoot,
        source: 'local',
      },
      includeHistoricalLifecycleArtifacts: false,
    });
    await integration.driver.writeArtifacts(target);
  }

  const subjectRoot = options.profile.scope === 'project'
    ? projectRoot
    : await copyUserMaterializedArtifacts({
        scopeRoot,
        env,
        pluginNames: installations.map(({ installation }) => installation.name),
      });
  const artifacts = await collectArtifacts(subjectRoot, subjectRoot);
  const materializedSkills = new Set(artifacts.flatMap((artifact) =>
    artifact.kind === 'skill' && artifact.key ? [artifact.key] : []));
  for (const skill of options.requiredSkills) {
    if (!materializedSkills.has(skill)) {
      throw new Error(
        `Profile "${options.profile.id}" did not materialize required Codex Skill "${skill}".`,
      );
    }
  }

  const installedPlugins = installations.map(({ installation, prepared }) => ({
    name: installation.name,
    version: prepared.plugin.manifest.version,
    configDigest: sha256(stableJson(installation.config)),
    bundleDigest: prepared.bundleDigest,
  }));
  const compositeBundleDigest = sha256(stableJson(
    installedPlugins.map(({ name, version, bundleDigest }) => ({ name, version, bundleDigest })),
  ));

  const subject: MaterializedPluginEvalSubject = {
    schemaVersion: PLUGIN_EVAL_SCHEMA_VERSION,
    plugin: options.ownerPlugin.manifest.name,
    skill: options.ownerSkill,
    pluginVersion: options.ownerPlugin.manifest.version,
    platform: 'codex',
    profile: options.profile.id,
    scope: options.profile.scope,
    modelExecution: options.profile.runModel,
    evidenceLevel: options.profile.scope === 'project' ? 'runtime-project' : 'materialized-user',
    root: path.relative(options.outputRoot, subjectRoot).split(path.sep).join('/'),
    configDigest: sha256(stableJson(
      options.profile.plugins.map(({ name, config }) => ({ name, config })),
    )),
    bundleDigest: compositeBundleDigest,
    installedPlugins,
    artifacts,
  };
  await fs.writeJson(path.join(scopeRoot, 'subject.json'), subject, { spaces: 2 });
  return subject;
}

export async function materializePluginEvalSubjects(
  options: MaterializePluginEvalOptions,
): Promise<MaterializedPluginEvalSubject[]> {
  const sourcePlugins = new Map<string, PluginMeta>();
  for (const plugin of options.plugins) {
    const name = plugin.manifest.name;
    if (sourcePlugins.has(name)) {
      throw new Error(`Duplicate plugin source for eval materialization: ${name}`);
    }
    sourcePlugins.set(name, plugin);
  }
  if (!sourcePlugins.has(options.plugin.manifest.name)) {
    throw new Error(`Owner plugin source is missing: ${options.plugin.manifest.name}`);
  }

  const requiredPluginNames = [...new Set(options.manifest.profiles.flatMap((profile) =>
    profile.plugins.map((plugin) => plugin.name)))];
  const preparedByName = new Map<string, PreparedEvalBundle>();
  try {
    for (const pluginName of requiredPluginNames) {
      const plugin = sourcePlugins.get(pluginName);
      if (!plugin) {
        throw new Error(
          `Eval manifest references repo-local plugin "${pluginName}" but no source was resolved.`,
        );
      }
      preparedByName.set(
        pluginName,
        await prepareEvalBundle(plugin, options.plugins, path.join(options.workRoot, pluginName)),
      );
    }

    const subjects: MaterializedPluginEvalSubject[] = [];
    for (const profile of options.manifest.profiles) {
      if (options.selectedProfiles && !options.selectedProfiles.has(profile.id)) {
        continue;
      }
      const owners = new Map<string, string>();
      for (const installation of profile.plugins) {
        const prepared = preparedByName.get(installation.name)!;
        const staticSkillsRoot = path.join(prepared.bundleRoot, 'codex', 'skills');
        const staticSkills = await fs.pathExists(staticSkillsRoot)
          ? await fs.readdir(staticSkillsRoot, { withFileTypes: true })
          : [];
        const declaredSkills = [
          ...staticSkills.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
          ...(prepared.plugin.manifest.artifacts?.targets ?? []).flatMap((target) =>
            target.target === 'codex.skill' && target.skillKey ? [target.skillKey] : []),
        ];
        for (const skill of new Set(declaredSkills)) {
          const existing = owners.get(skill);
          if (existing && existing !== installation.name) {
            throw new Error(
              `Eval profile "${profile.id}" installs duplicate Codex Skill key "${skill}" ` +
              `from plugins "${existing}" and "${installation.name}".`,
            );
          }
          owners.set(skill, installation.name);
        }
      }
      const requiredSkills = new Set<string>([options.manifest.skill]);
      for (const suite of options.manifest.suites) {
        if (suite.profiles.includes(profile.id)) {
          for (const skill of suite.skills) requiredSkills.add(skill);
        }
      }
      subjects.push(await materializeProfile({
        preparedByName,
        ownerPlugin: options.plugin,
        ownerSkill: options.manifest.skill,
        requiredSkills,
        profile,
        outputRoot: options.outputRoot,
        baseEnv: options.env ?? process.env,
      }));
    }
    return subjects;
  } finally {
    await Promise.all([...preparedByName.values()].map((prepared) => prepared.cleanup()));
  }
}

export function resolveMaterializedSubjectRoot(
  outputRoot: string,
  subject: MaterializedPluginEvalSubject,
): string {
  return path.resolve(outputRoot, subject.root);
}
