import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { createRuntimeSkillSnapshot } from '@lesliechan721/agent-skill-eval';
import fs from 'fs-extra';
import { PLATFORM_TARGETS, type PlatformTarget } from '@lesliechan721/aw-plugin-core';
import { materializePortableSkills } from '../src/portable/materializer.js';

import {
  createRebuildIntegration,
  materializeReviewNativeSkills,
} from '../src/commands/rebuild-integration.js';
import { createNoopDebugLogger } from '../src/output/debug-log.js';
import { createNoopReporter } from '../src/output/reporter.js';
import {
  createIsolatedSkillEnv,
  prepareSkillPluginBundle,
  type PreparedSkillPluginBundle,
} from '../src/review/skill-materialization.js';
import type { PluginMeta } from '../src/types.js';
import { writePluginConfigStore } from '../src/utils/plugin-config.js';
import { validateSkillDirectoriesRoot, validatePortableSkillDirectoriesRoot } from '../src/utils/dynamic-skill-tree.js';
export interface AwSkillEvalMaterializationProfile {
  id: string;
  platform: PlatformTarget;
  scope: 'project' | 'user';
  plugins: Array<{
    name: string;
    configByScope: Partial<Record<'project' | 'user', Record<string, unknown>>>;
  }>;
}

const execFileAsync = promisify(execFile);

export interface MaterializeAwSkillEvalOptions {
  plugin: PluginMeta;
  plugins: PluginMeta[];
  profile: AwSkillEvalMaterializationProfile;
  requiredSkills: ReadonlySet<string>;
  initializeGitRepository: boolean;
  outputRoot: string;
  workRoot: string;
  sourceIdentity: string;
  workspaceIdentity: string;
  env?: NodeJS.ProcessEnv;
}

export interface AwSkillEvalMaterializedSubject {
  root: string;
}

async function snapshotRuntimeSkills(sourceRoot: string, targetRoot: string, platform: PlatformTarget): Promise<void> {
  if (platform === 'codex' || platform === 'claude') {
    await validateSkillDirectoriesRoot(sourceRoot, `${platform}.skill`);
  } else {
    await validatePortableSkillDirectoriesRoot(sourceRoot);
  }
  await fs.ensureDir(targetRoot);
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(targetRoot, entry.name);
    await createRuntimeSkillSnapshot(source, destination);
  }
}

async function initializeSubjectGitRepository(
  subjectRoot: string,
  baseEnv: NodeJS.ProcessEnv,
  excludedRoots: string[],
): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    GIT_CONFIG_GLOBAL: path.join(subjectRoot, '.gitconfig-disabled'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'AW Eval Fixture',
    GIT_AUTHOR_EMAIL: 'aw-eval@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'AW Eval Fixture',
    GIT_COMMITTER_EMAIL: 'aw-eval@example.invalid',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
  for (const key of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_CONFIG',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_PARAMETERS',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_NAMESPACE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_WORK_TREE',
  ]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) {
      delete env[key];
    }
  }

  await execFileAsync('git', ['init', '-q', '--initial-branch=main', '--template='], {
    cwd: subjectRoot,
    env,
  });
  await fs.ensureDir(path.join(subjectRoot, '.git', 'info'));
  await fs.writeFile(
    path.join(subjectRoot, '.git', 'info', 'exclude'),
    `${excludedRoots
      .sort((left, right) => left.localeCompare(right))
      .map((root) => `/${root.split(path.sep).join('/')}/`)
      .join('\n')}\n`,
    'utf8',
  );
  await execFileAsync('git', ['add', '--all'], { cwd: subjectRoot, env });
  await execFileAsync('git', [
    '-c',
    'user.name=AW Eval Fixture',
    '-c',
    'user.email=aw-eval@example.invalid',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-q',
    '--no-verify',
    '--allow-empty',
    '-m',
    'Materialize eval subject',
  ], { cwd: subjectRoot, env });
  await fs.remove(path.join(subjectRoot, '.git', 'index'));
  await execFileAsync('git', ['read-tree', '--reset', 'HEAD'], { cwd: subjectRoot, env });
}

async function copyUserMaterializedArtifacts(options: {
  scopeRoot: string;
  env: NodeJS.ProcessEnv;
  pluginNames: string[];
  platform: PlatformTarget;
}): Promise<string> {
  const materializedRoot = path.join(options.scopeRoot, 'materialized');
  const skillsRoot = path.join(materializedRoot, '.agents', 'skills');
  for (const pluginName of options.pluginNames) {
    const runtimeSkillsRoot = path.join(
      options.env.AW_HOME!,
      'plugins',
      pluginName,
      options.platform,
      'skills',
    );
    if (await fs.pathExists(runtimeSkillsRoot)) {
      await snapshotRuntimeSkills(runtimeSkillsRoot, skillsRoot, options.platform);
    }
  }

  const codexHome = options.platform === 'claude' ? options.env.CLAUDE_CONFIG_DIR! : options.env.CODEX_HOME!;
  if (await fs.pathExists(codexHome)) {
    const codexSkillsRoot = path.join(codexHome, 'skills');
    if (await fs.pathExists(codexSkillsRoot)) {
      await snapshotRuntimeSkills(codexSkillsRoot, skillsRoot, options.platform);
    }
    await fs.copy(codexHome, path.join(materializedRoot, options.platform === 'claude' ? '.claude' : '.codex'), {
      overwrite: true,
      dereference: false,
      filter: (source) => {
        const relative = path.relative(codexHome, source);
        return (relative !== 'skills' && !relative.startsWith(`skills${path.sep}`))
          && path.basename(source) !== 'auth.json'
          && path.basename(source) !== '.credentials.json';
      },
    });
  }
  return materializedRoot;
}

async function materializeProfileSkills(options: {
  prepared: PreparedSkillPluginBundle;
  plugins: readonly PluginMeta[];
  profile: AwSkillEvalMaterializationProfile;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const platform = options.profile.platform;
  const plugin = options.prepared.bundlePlugin;
  const declarations = plugin.manifest.artifacts?.targets ?? [];
  const staticRoot = path.join(options.prepared.bundleRoot, platform, 'skills');
  const staticSkills = await fs.readdir(staticRoot, { withFileTypes: true }).catch(() => []);
  const dynamicKeys = new Set(declarations.filter((target) => target.platform === platform && target.skillKey !== undefined)
    .map((target) => target.skillKey!));
  const skills = [
    ...staticSkills.filter((entry) => entry.isDirectory() && !dynamicKeys.has(entry.name)).map((entry) => ({ skill: entry.name, targetId: null })),
    ...declarations.filter((target) => target.platform === platform && target.skillKey !== undefined
      && (target.target === 'codex.skill' || target.target === 'claude.skill'
        || target.target === 'agent-skills.skill' && target.scopes.includes(options.profile.scope)))
      .map((target) => ({ skill: target.skillKey!, targetId: target.id })),
  ];
  if (skills.length === 0) return;
  const targetRoot = options.profile.scope === 'project'
    ? path.join(options.projectRoot, '.agents', 'skills')
    : path.join(options.env.AW_HOME!, 'plugins', plugin.manifest.name, platform, 'skills');
  const outputRoot = path.join(options.env.TMPDIR!, `materialized-${plugin.manifest.name}`);
  if (platform === 'codex' || platform === 'claude') {
    await materializeReviewNativeSkills({
      plugin, plugins: options.plugins, platform, scope: options.profile.scope,
      cwd: options.projectRoot, env: options.env, outputRoot, skills,
      allowDisabledNativeSkills: true,
    });
    try {
      await snapshotRuntimeSkills(path.join(outputRoot, 'skills'), targetRoot, platform);
    } finally {
      await fs.remove(outputRoot);
    }
  } else {
    const materialized = await materializePortableSkills({
      plugins: options.plugins, pluginId: plugin.pluginId ?? plugin.manifest.name,
      platform, scope: options.profile.scope, cwd: options.projectRoot, env: options.env,
      inputMode: 'bundle', outputRoot, selectedSkills: skills.map((skill) => skill.skill),
    });
    try {
      await snapshotRuntimeSkills(path.join(materialized.rootDir, 'skills'), targetRoot, platform);
    } finally {
      await fs.remove(outputRoot);
    }
  }
}

async function materializeProfile(options: {
  preparedByName: ReadonlyMap<string, PreparedSkillPluginBundle>;
  requiredSkills: ReadonlySet<string>;
  profile: AwSkillEvalMaterializationProfile;
  outputRoot: string;
  baseEnv: NodeJS.ProcessEnv;
  initializeGitRepository: boolean;
}): Promise<AwSkillEvalMaterializedSubject> {
  const scopeRoot = path.join(options.outputRoot, 'subjects', options.profile.id);
  await fs.remove(scopeRoot);
  await fs.ensureDir(scopeRoot);
  const env = await createIsolatedSkillEnv(options.baseEnv, scopeRoot);
  const projectRoot = path.join(scopeRoot, 'project');
  await fs.ensureDir(path.join(projectRoot, '.git'));

  const installations = options.profile.plugins.map((installation) => {
    const prepared = options.preparedByName.get(installation.name);
    if (!prepared) {
      throw new Error(`Eval profile "${options.profile.id}" references unresolved plugin "${installation.name}".`);
    }
    return { installation, prepared };
  });
  for (const { installation, prepared } of installations) {
    for (const scope of ['project', 'user'] as const) {
      const config = installation.configByScope[scope];
      if (config === undefined) continue;
      await writePluginConfigStore({
        sourceId: prepared.bundlePlugin.sourceId,
        sourceIdentity: prepared.bundlePlugin.sourceIdentity,
        logicalIdentity: prepared.bundlePlugin.catalogLogicalIdentity,
        pluginName: installation.name,
        scope: 'user',
        platform: options.profile.platform,
        cwd: projectRoot,
        values: config,
        env,
      });
    }
  }

  for (const { prepared } of installations) {
    await materializeProfileSkills({
      prepared,
      plugins: installations.map(({ prepared }) => prepared.bundlePlugin),
      profile: options.profile,
      projectRoot,
      env,
    });
  }

  const integration = createRebuildIntegration({
    context: {
      env,
      referencePlugins: installations.map(({ prepared }) => prepared.bundlePlugin),
      nativeCliRunner: async () => {
        throw new Error('Plugin eval materialization cannot run a native CLI.');
      },
      reporter: createNoopReporter(),
      debugLogger: createNoopDebugLogger(),
    },
  });
  for (const { prepared } of installations) {
    if (options.profile.platform !== 'codex' && options.profile.platform !== 'claude') continue;
    const target = await integration.buildTarget({
      plugin: prepared.bundlePlugin,
      platform: options.profile.platform,
      scope: options.profile.scope,
      cwd: projectRoot,
      command: 'install',
      catalog: {
        rootDir: prepared.bundleRoot,
        source: 'local',
      },
    });
    await integration.driver.writeArtifacts(target);
  }

  const subjectRoot = options.profile.scope === 'project'
    ? projectRoot
    : await copyUserMaterializedArtifacts({
        scopeRoot,
        env,
        platform: options.profile.platform,
        pluginNames: installations.map(({ installation }) => installation.name),
      });
  const skillsRoot = path.join(subjectRoot, '.agents', 'skills');
  const materializedSkills = new Set(
    (await fs.readdir(skillsRoot, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name),
  );
  for (const skill of options.requiredSkills) {
    if (!materializedSkills.has(skill)) {
      throw new Error(
        `Profile "${options.profile.id}" did not materialize required Skill "${skill}".`,
      );
    }
  }
  if (options.initializeGitRepository) {
    await initializeSubjectGitRepository(subjectRoot, env, [
      '.codex',
      ...[...materializedSkills].map((skill) => path.join('.agents', 'skills', skill)),
    ]);
  }

  const subject: AwSkillEvalMaterializedSubject = {
    root: path.relative(options.outputRoot, subjectRoot).split(path.sep).join('/'),
  };
  return subject;
}

export async function materializeAwSkillEvalSubject(
  options: MaterializeAwSkillEvalOptions,
): Promise<AwSkillEvalMaterializedSubject> {
  if (!PLATFORM_TARGETS.includes(options.profile.platform)) {
    throw new Error('Eval materialization requires an explicit canonical platform.');
  }
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

  const requiredPluginNames = [...new Set(options.profile.plugins.map((plugin) => plugin.name))];
  const preparedByName = new Map<string, PreparedSkillPluginBundle>();
  try {
    const bundleEnv = await createIsolatedSkillEnv(
      options.env ?? process.env,
      path.join(options.workRoot, 'environment'),
    );
    for (const pluginName of requiredPluginNames) {
      const plugin = sourcePlugins.get(pluginName);
      if (!plugin) {
        throw new Error(
          `Eval manifest references repo-local plugin "${pluginName}" but no source was resolved.`,
        );
      }
      const prepared = await prepareSkillPluginBundle({
        plugin,
        plugins: options.plugins,
        workRoot: path.join(options.workRoot, pluginName),
        env: bundleEnv,
      });
      const sourceId = prepared.bundlePlugin.sourceId ?? 'eval-source';
      prepared.bundlePlugin = {
        ...prepared.bundlePlugin,
        sourceId,
        sourceIdentity: prepared.bundlePlugin.sourceIdentity ?? options.sourceIdentity,
        catalogLogicalIdentity: prepared.bundlePlugin.catalogLogicalIdentity ?? options.workspaceIdentity,
        pluginId: prepared.bundlePlugin.pluginId ?? `${sourceId}/${pluginName}`,
      };
      preparedByName.set(pluginName, prepared);
    }

    const owners = new Map<string, string>();
    for (const installation of options.profile.plugins) {
      const prepared = preparedByName.get(installation.name)!;
      const staticSkillsRoot = path.join(prepared.bundleRoot, options.profile.platform, 'skills');
      const staticSkills = await fs.pathExists(staticSkillsRoot)
        ? await fs.readdir(staticSkillsRoot, { withFileTypes: true })
        : [];
      const declaredSkills = [
        ...staticSkills.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
        ...(prepared.bundlePlugin.manifest.artifacts?.targets ?? []).flatMap((target) =>
          target.platform === options.profile.platform && (target.target === 'codex.skill'
            || target.target === 'claude.skill' || target.target === 'agent-skills.skill') && target.skillKey ? [target.skillKey] : []),
      ];
      for (const skill of new Set(declaredSkills)) {
        const existing = owners.get(skill);
        if (existing && existing !== installation.name) {
          throw new Error(
            `Eval profile "${options.profile.id}" installs duplicate Skill key "${skill}" ` +
            `from plugins "${existing}" and "${installation.name}".`,
          );
        }
        owners.set(skill, installation.name);
      }
    }
    return await materializeProfile({
      preparedByName,
      requiredSkills: options.requiredSkills,
      profile: options.profile,
      outputRoot: options.outputRoot,
      baseEnv: options.env ?? process.env,
      initializeGitRepository: options.initializeGitRepository,
    });
  } finally {
    await Promise.all([...preparedByName.values()].map((prepared) => prepared.cleanup()));
  }
}

export function resolveMaterializedSubjectRoot(
  outputRoot: string,
  subject: AwSkillEvalMaterializedSubject,
): string {
  return path.resolve(outputRoot, subject.root);
}
