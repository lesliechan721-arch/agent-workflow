import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import { CodexAdapter } from '../src/adapters/codex.js';
import { bundleLocalPlugin, prepareLocalPluginBundleSource } from '../src/generators/local-plugin.js';
import type { PluginMeta } from '../src/types.js';
import { writePluginConfigStore } from '../src/utils/plugin-config.js';
import {
  commitMaterializedSkillTriggerPreference,
  materializeSkillTriggerPreference,
} from '../src/utils/skill-trigger-preferences.js';
import {
  PLUGIN_EVAL_SCHEMA_VERSION,
  type MaterializedPluginEvalArtifact,
  type MaterializedPluginEvalSubject,
  type PluginEvalManifest,
  type PluginEvalProfile,
} from './plugin-eval-contract.js';

export interface MaterializePluginEvalOptions {
  plugin: PluginMeta;
  manifest: PluginEvalManifest;
  outputRoot: string;
  env?: NodeJS.ProcessEnv;
  selectedProfiles?: ReadonlySet<string>;
}

interface PreparedEvalBundle {
  sourceRoot: string;
  stagingRoot: string;
  bundleRoot: string;
  plugin: PluginMeta;
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

async function prepareEvalBundle(plugin: PluginMeta): Promise<PreparedEvalBundle> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-bundle-'));
  const prepared = await prepareLocalPluginBundleSource(plugin, { buildMode: 'staging' });
  const bundleRoot = path.join(tempRoot, 'bundle');
  try {
    await bundleLocalPlugin(prepared.plugin, bundleRoot, { buildMode: 'prepared' });
    return {
      sourceRoot: plugin.rootDir,
      stagingRoot: prepared.plugin.rootDir,
      bundleRoot,
      plugin: {
        ...prepared.plugin,
        rootDir: bundleRoot,
        manifestPath: path.join(bundleRoot, '.agents-plugin', 'plugin.json'),
      },
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

async function copyUserMaterializedArtifacts(options: {
  scopeRoot: string;
  env: NodeJS.ProcessEnv;
  pluginName: string;
}): Promise<string> {
  const materializedRoot = path.join(options.scopeRoot, 'materialized');
  const skillsRoot = path.join(materializedRoot, '.agents', 'skills');
  const runtimeSkillsRoot = path.join(
    options.env.AW_HOME!,
    'plugins',
    options.pluginName,
    'codex',
    'skills',
  );
  if (await fs.pathExists(runtimeSkillsRoot)) {
    await fs.ensureDir(skillsRoot);
    await fs.copy(runtimeSkillsRoot, skillsRoot, { overwrite: true, dereference: false });
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
  const materialization = await materializeSkillTriggerPreference({
    pluginName: options.prepared.plugin.manifest.name,
    platform: 'codex',
    resolvedOptions: {
      skillTriggerPreference: options.profile.triggerPreference,
    },
    embeddedRoot: options.prepared.bundleRoot,
    policyPlugin: options.prepared.plugin,
    sourcePluginRoot: options.prepared.bundleRoot,
    target: options.profile.scope === 'project'
      ? {
          platform: 'codex',
          scope: 'project',
          kind: 'repoSkill',
          root: path.join(options.projectRoot, '.agents', 'skills'),
        }
      : {
          platform: 'codex',
          scope: 'user',
          kind: 'localMarketplaceRuntime',
          root: options.env.AW_HOME!,
        },
    mode: 'strictExplicit',
  });
  await commitMaterializedSkillTriggerPreference(materialization.rollbackHandle);
}

async function materializeProfile(options: {
  prepared: PreparedEvalBundle;
  profile: PluginEvalProfile;
  outputRoot: string;
  baseEnv: NodeJS.ProcessEnv;
  bundleDigest: string;
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

  await writePluginConfigStore({
    pluginName: options.prepared.plugin.manifest.name,
    scope: options.profile.scope,
    cwd: projectRoot,
    values: options.profile.config,
    env,
  });

  await materializeStaticCodexSkills({
    prepared: options.prepared,
    profile: options.profile,
    projectRoot,
    env,
  });

  const adapter = new CodexAdapter(projectRoot, env);
  await adapter.installExtensions(options.prepared.plugin, options.profile.scope, {
    event: 'install',
    skillTriggerPreference: options.profile.triggerPreference,
  });

  const subjectRoot = options.profile.scope === 'project'
    ? projectRoot
    : await copyUserMaterializedArtifacts({
        scopeRoot,
        env,
        pluginName: options.prepared.plugin.manifest.name,
      });
  const artifacts = await collectArtifacts(subjectRoot, subjectRoot);
  if (!artifacts.some((artifact) => artifact.kind === 'skill')) {
    throw new Error(
      `Profile "${options.profile.id}" did not materialize a Codex skill for plugin "${options.prepared.plugin.manifest.name}".`,
    );
  }

  const subject: MaterializedPluginEvalSubject = {
    schemaVersion: PLUGIN_EVAL_SCHEMA_VERSION,
    plugin: options.prepared.plugin.manifest.name,
    pluginVersion: options.prepared.plugin.manifest.version,
    platform: 'codex',
    profile: options.profile.id,
    scope: options.profile.scope,
    modelExecution: options.profile.runModel,
    evidenceLevel: options.profile.scope === 'project' ? 'runtime-project' : 'materialized-user',
    root: path.relative(options.outputRoot, subjectRoot).split(path.sep).join('/'),
    configDigest: sha256(stableJson(options.profile.config)),
    bundleDigest: options.bundleDigest,
    artifacts,
  };
  await fs.writeJson(path.join(scopeRoot, 'subject.json'), subject, { spaces: 2 });
  return subject;
}

export async function materializePluginEvalSubjects(
  options: MaterializePluginEvalOptions,
): Promise<MaterializedPluginEvalSubject[]> {
  const prepared = await prepareEvalBundle(options.plugin);
  try {
    const bundleDigest = await digestTree(prepared.bundleRoot);
    const subjects: MaterializedPluginEvalSubject[] = [];
    for (const profile of options.manifest.profiles) {
      if (options.selectedProfiles && !options.selectedProfiles.has(profile.id)) {
        continue;
      }
      subjects.push(await materializeProfile({
        prepared,
        profile,
        outputRoot: options.outputRoot,
        baseEnv: options.env ?? process.env,
        bundleDigest,
      }));
    }
    return subjects;
  } finally {
    await prepared.cleanup();
  }
}

export function resolveMaterializedSubjectRoot(
  outputRoot: string,
  subject: MaterializedPluginEvalSubject,
): string {
  return path.resolve(outputRoot, subject.root);
}
