import path from 'node:path';

import fs from 'fs-extra';
import {
  getCommandPackageId,
  getManagedCommandArtifactTargets,
  parseManagedCommandPlaceholders,
  validateCommandEntryFiles,
} from '@lesliechan721/aw-plugin-core/manifest';

import { bundleLocalPlugin, prepareLocalPluginBundleSource } from '../generators/local-plugin.js';
import type { PlatformName, PluginMeta, Scope } from '../types.js';
import { validateArtifactPlan } from '../utils/artifact-plan.js';
import { runArtifactRenderer } from '../utils/artifact-renderer.js';
import { createCatalogRuntimeImportResolver } from '../utils/catalog-runtime-projection.js';
import { createCodexSkillExpectedTree } from '../utils/codex-skill-staging.js';
import {
  createDynamicSkillExpectedTree,
  validateSkillDirectory,
  writeDynamicSkillTree,
  type DynamicSkillTree,
} from '../utils/dynamic-skill-tree.js';
import {
  commandSetsForProducer,
  createManagedCommandReferenceResolver,
  managedCommandProducerIdentity,
  prepareManagedCommandPackage,
  resolveSkillManagedCommandReferences,
  type ManagedCommandCandidate,
} from '../utils/managed-command-materialization.js';
import { validateManagedCommandResource } from '../utils/managed-command-store.js';
import { createAwPluginRequirementsReceipt } from '../utils/manifest.js';
import { injectInstalledRuntimeConfig } from '../utils/runtime-config.js';
import { validateRuntimeSkillClosure } from '../utils/runtime-skill-closure.js';

export interface PreparedSkillPluginBundle {
  bundleRoot: string;
  bundlePlugin: PluginMeta;
  cleanup(): Promise<void>;
}

export async function prepareSkillPluginBundle(options: {
  plugin: PluginMeta;
  plugins: readonly PluginMeta[];
  workRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<PreparedSkillPluginBundle> {
  await fs.ensureDir(options.workRoot);
  const tempRoot = await fs.mkdtemp(path.join(options.workRoot, 'bundle-'));
  let prepared: Awaited<ReturnType<typeof prepareLocalPluginBundleSource>> | undefined;
  try {
    prepared = await prepareLocalPluginBundleSource(options.plugin, {
      buildMode: 'staging',
      commandEnv: options.env,
      runtimeResolver: createCatalogRuntimeImportResolver(options.plugins),
    });
    const activePrepared = prepared;
    const bundleRoot = path.join(tempRoot, 'bundle');
    await bundleLocalPlugin(activePrepared.plugin, bundleRoot, {
      buildMode: 'prepared',
      preparedRuntimeContext: activePrepared.runtimeContext,
    });
    const manifestPath = path.join(bundleRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath) as PluginMeta['manifest'];
    return {
      bundleRoot,
      bundlePlugin: {
        ...activePrepared.plugin,
        rootDir: bundleRoot,
        manifestPath,
        manifest,
      },
      cleanup: async () => {
        await activePrepared.cleanup();
        await fs.remove(tempRoot);
      },
    };
  } catch (error) {
    await prepared?.cleanup();
    await fs.remove(tempRoot);
    throw error;
  }
}

/** Prepare only producers referenced by these isolated Skill trees, without publishing bindings. */
export async function prepareIsolatedSkillCommandReferences(options: {
  plugin: PluginMeta;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  trees: readonly DynamicSkillTree[];
  candidates?: readonly ManagedCommandCandidate[];
  scriptTimeoutMs?: number;
}): Promise<ManagedCommandCandidate[]> {
  const candidates = [...(options.candidates ?? [])];
  const pending = options.trees.map((tree) => ({ tree, scope: options.scope }));
  const prepared = new Set(candidates.map((candidate) => getCommandPackageId(candidate.producer)));
  const temporaryRoots: string[] = [];
  const referencedTrees = new Set<DynamicSkillTree>();
  try {
    for (let index = 0; index < pending.length; index += 1) {
      const consumer = pending[index]!;
      const references = Object.entries(consumer.tree.files)
        .filter(([relativePath]) => relativePath.endsWith('.md'))
        .flatMap(([, content]) => parseManagedCommandPlaceholders(content.toString('utf8')));
      if (references.length > 0) referencedTrees.add(consumer.tree);
      if (references.length > 0
        && !options.plugin.manifest.requires?.aw.capabilities?.includes('aw.managed-commands.v1')) {
        throw new Error('commandReferenceInvalid: managed command references require aw.managed-commands.v1.');
      }
      for (const { reference } of references) {
        const set = options.plugin.manifest.managedCommands?.sets.find((entry) => entry.set === reference.set);
        if (!set) throw new Error('commandReferenceInvalid: the command set is not declared by this plugin.');
        const producerRef = set.producer;
        const declaration = producerRef.kind === 'artifact'
          ? options.plugin.manifest.artifacts?.targets?.find((target) => target.id === producerRef.artifactId)
          : undefined;
        if (producerRef.kind === 'static-skill' && producerRef.platform !== options.platform
          || producerRef.kind === 'artifact' && (declaration?.platform !== options.platform
            || declaration.delivery?.mode !== 'codex-native' && !declaration.scopes.includes(consumer.scope))) {
          throw new Error('commandReferenceInvalid: the producer is unavailable on this platform and scope.');
        }
        if (producerRef.kind === 'package') {
          const commandPackage = options.plugin.manifest.managedCommands?.packages.find((entry) =>
            entry.key === producerRef.packageKey);
          if (!commandPackage?.platforms.includes(options.platform)
            || consumer.scope === 'user' && commandPackage.scope === 'project') {
            throw new Error('commandReferenceInvalid: the command package is unavailable to this consumer.');
          }
        }
        const producer = await managedCommandProducerIdentity({
          ...options, producer: producerRef, scope: consumer.scope,
        });
        const identity = getCommandPackageId(producer);
        if (prepared.has(identity)) continue;
        prepared.add(identity);
        if (producerRef.kind === 'package') {
          const commandPackage = await prepareManagedCommandPackage({
            ...options, packageKey: producerRef.packageKey, scope: producer.scope, event: 'materialize',
          });
          candidates.push({ producer: commandPackage.producer, sets: commandPackage.sets });
          await commandPackage.cleanup();
          continue;
        }

        const commandTargets = getManagedCommandArtifactTargets(options.plugin.manifest).filter((target) =>
          JSON.stringify(target.producer) === JSON.stringify(producerRef));
        const requestedArtifactIds = [
          ...(producerRef.kind === 'artifact' ? [producerRef.artifactId] : []),
          ...commandTargets.map((target) => target.id),
        ];
        let artifacts: ReturnType<typeof validateArtifactPlan>['artifacts'] = [];
        let tree: DynamicSkillTree;
        let resourceRoot: string;
        let render: Awaited<ReturnType<typeof runArtifactRenderer>> | undefined;
        if (requestedArtifactIds.length > 0) {
          render = await runArtifactRenderer({
            plugin: options.plugin,
            platform: options.platform,
            scope: producer.scope,
            ...(declaration?.delivery?.mode === 'codex-native' ? { configScope: 'user' as const } : {}),
            event: 'materialize', cwd: options.cwd, commandEnv: options.env,
            requestedArtifactIds, previousArtifacts: [], scriptTimeoutMs: options.scriptTimeoutMs,
          });
          artifacts = validateArtifactPlan({
            manifest: options.plugin.manifest, plan: render.plan,
            platform: options.platform, scope: producer.scope,
            requestedArtifactIds: render.context.requestedArtifactIds,
            renderConfig: render.context.config,
            rendererDigest: render.target.rendererDigest, manifestDigest: render.target.manifestDigest,
          }).artifacts;
        }
        if (producerRef.kind === 'static-skill') {
          resourceRoot = path.join(options.plugin.rootDir, options.platform, 'skills', producerRef.skillKey);
          tree = await validateSkillDirectory(resourceRoot, `${options.platform}.skill`, {
            requirementsReceiptPolicy: 'allow',
          });
        } else {
          const artifact = artifacts.find((entry) => entry.id === producerRef.artifactId);
          if (!artifact || artifact.state !== 'present'
            || artifact.target !== 'codex.skill' && artifact.target !== 'claude.skill') {
            throw new Error('commandReferenceInvalid: the producer did not produce a present Skill.');
          }
          const sourceDirs = render!.context.artifactSources.find((source) =>
            source.id === artifact.id && source.target === artifact.target)?.sourceDirs ?? [];
          const receipt = createAwPluginRequirementsReceipt(
            options.plugin.manifest,
            options.plugin.manifest.requires?.aw.capabilities ?? [],
          );
          const treeOptions = {
            sourceDirs, requireReadme: true,
            requirementsReceipt: Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`),
            sourceRequirementsReceiptPolicy: 'allow' as const,
          };
          tree = artifact.target === 'codex.skill'
            ? await createCodexSkillExpectedTree({ ...treeOptions, artifact })
            : await createDynamicSkillExpectedTree({ ...treeOptions, artifact });
          await injectInstalledRuntimeConfig(tree, render!.runtimeConfigSnapshots[artifact.id]);
          const temporaryRoot = await fs.mkdtemp(path.join(options.env.TMPDIR!, 'aw-review-command-'));
          temporaryRoots.push(temporaryRoot);
          resourceRoot = path.join(temporaryRoot, tree.skillKey);
          await writeDynamicSkillTree(resourceRoot, tree);
        }
        const sets = commandSetsForProducer({ plugin: options.plugin, producer: producerRef, artifacts });
        await validateManagedCommandResource(resourceRoot);
        await validateCommandEntryFiles(resourceRoot, sets.flatMap((entry) => entry.entries));
        await validateRuntimeSkillClosure(resourceRoot);
        candidates.push({ producer, sets });
        pending.push({ tree, scope: producer.scope });
      }
    }
    for (const { tree, scope } of pending) {
      if (!referencedTrees.has(tree)) continue;
      const resolve = await createManagedCommandReferenceResolver({ ...options, scope, candidates });
      resolveSkillManagedCommandReferences(tree, resolve);
    }
    return candidates;
  } finally {
    await Promise.all(temporaryRoots.map((root) => fs.remove(root)));
  }
}

export async function createIsolatedSkillEnv(
  baseEnv: NodeJS.ProcessEnv,
  scopeRoot: string,
): Promise<NodeJS.ProcessEnv> {
  const home = path.join(scopeRoot, 'home');
  const temp = path.join(scopeRoot, 'tmp');
  const codexHome = path.join(scopeRoot, 'codex-home');
  const env: NodeJS.ProcessEnv = {
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
    AW_CODEX_HOME: codexHome,
    AW_CLAUDE_HOME: path.join(scopeRoot, 'claude-home'),
    CODEX_HOME: codexHome,
    NODE_PATH: '',
  };
  await Promise.all([
    fs.ensureDir(env.HOME!),
    fs.ensureDir(env.XDG_CACHE_HOME!),
    fs.ensureDir(env.XDG_CONFIG_HOME!),
    fs.ensureDir(env.XDG_STATE_HOME!),
    fs.ensureDir(env.TMPDIR!),
    fs.ensureDir(env.AW_HOME!),
    fs.ensureDir(env.AW_CODEX_HOME!),
    fs.ensureDir(env.AW_CLAUDE_HOME!),
  ]);
  return env;
}
