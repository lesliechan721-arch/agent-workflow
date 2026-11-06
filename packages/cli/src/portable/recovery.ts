import path from 'node:path';

import { isPortablePlatformTarget, PORTABLE_PLATFORM_TARGETS } from '@lesliechan721/aw-plugin-core';

import { withAwHomeMutationLock, type AwHomeMutationToken } from '../utils/aw-home-mutation-lock.js';
import type { CatalogOperationContext } from '../utils/catalog-operation-context.js';
import type { ScopeContext } from '../intent/scope-context.js';
import { validatePortableSkillDirectory, validatePortableSkillName } from '../utils/dynamic-skill-tree.js';
import { validateRuntimeSkillClosure } from '../utils/runtime-skill-closure.js';
import { materializePortableSkillsToDirectory } from './commands.js';
import { resolvePortableCatalogBindingInput } from './materializer.js';
import { assertPortablePath, portableJsonDigest, readHistoricalPortableMaterialization } from './historical-materialization.js';
import { portableRecoveryLayout, type PortableAgent } from './recovery-layout.js';
import {
  observePortableSkill, publishPortableSkill, removePortableSkill, scanPortableSkills,
  type PortableOwnerIdentity, type PortableSkillObservation,
} from './writer.js';

export type { PortableAgent } from './recovery-layout.js';
export interface PortableRecoveryOptions {
  scope: 'user' | 'project';
  context: ScopeContext;
  selector: string;
  cliVersion: string;
  agents: PortableAgent[];
  excludedPluginIds?: string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  catalogOperationContext?: CatalogOperationContext;
  cleanup?: PortableCleanupOptions;
}
export interface PortableTarget {
  skill: string;
  agent: PortableAgent;
  physicalPath: string;
  providerPluginId: string;
  expectedDigest: string;
  configDigest?: string;
  installedDigest?: string;
  oldGenerationDigest?: string;
  sourcePath?: string;
  ownership: 'aw' | 'external' | 'unknown';
  observation: 'absent' | 'satisfied' | 'drifted' | 'conflict' | 'unknown';
  contentState?: 'current' | 'stale' | 'damaged' | 'unknown';
  associatedAgents: string[];
  disposition?: 'write' | 'remove';
  blocker?: string;
  ownerIdentity?: PortableOwnerIdentity;
  observationEvidence?: PortableSkillObservation;
}
export function normalizePortableSkillName(name: string): string {
  validatePortableSkillName(name);
  return name;
}
export interface PortablePreparation {
  options: PortableRecoveryOptions;
  root: string;
  generation: string;
  generations?: Partial<Record<PortableAgent, string>>;
  logicalIdentity: string;
  targets: PortableTarget[];
  blockers: string[];
  globalBlockers: string[];
  evidenceDigest: string;
  bindingDigest?: string;
  mode?: 'deploy' | 'cleanup';
  cleanupOptions?: PortableCleanupOptions;
  diagnostics?: PortablePreparationDiagnostic[];
}
interface PortablePreparationDiagnostic {
  code: string;
  agent: PortableAgent;
  stage: 'catalog-binding' | 'generation-path' | 'materialize' | 'materialization-read' | 'skill-validation' | 'output-observation';
  systemCode?: string;
}

const SAFE_FILESYSTEM_CODES = new Set([
  'EACCES', 'EBUSY', 'EEXIST', 'EIO', 'EISDIR', 'ELOOP', 'EMFILE', 'ENAMETOOLONG',
  'ENFILE', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'ENOTEMPTY', 'EPERM', 'EROFS', 'EXDEV', 'EINVAL',
]);

/** Supplement the existing blocker with fixed stages and known errno names only. */
export function portablePreparationDiagnostic(prepared: PortablePreparation,
  diagnostic: { code: string; message: string }, agent: PortableAgent): { code: string; message: string } {
  const detail = prepared.diagnostics?.find((entry) => entry.code === diagnostic.code && entry.agent === agent);
  if (!detail) return diagnostic;
  return { ...diagnostic, message: `${diagnostic.message}准备阶段：${detail.stage}${detail.systemCode ? `；文件系统错误：${detail.systemCode}` : ''}。` };
}
export interface PortableExecutionTarget extends PortableTarget {
  execution: 'not-run' | 'no-op' | 'applied' | 'failed';
  blockers: string[];
}
export interface PortableExecution {
  targets: PortableExecutionTarget[];
  blockers: string[];
  globalBlockers: string[];
  execution: 'not-run' | 'no-op' | 'applied' | 'partial' | 'failed';
  outputsMayHaveChanged: boolean;
}
interface CompletedPortableFootprint {
  physicalPath: string;
  expectedDigest: string;
  providerPluginId: string;
  logicalIdentity: string;
}

function selectedAgents(agents: readonly PortableAgent[]): PortableAgent[] {
  if (agents.some((agent) => !isPortablePlatformTarget(agent)) || new Set(agents).size !== agents.length) {
    throw new Error('portableInvalidAgentSelection');
  }
  return [...agents];
}

function fromObservation(observed: PortableSkillObservation, agent: PortableAgent,
  providerPluginId: string, expectedDigest: string): PortableTarget {
  return { skill: observed.skill, agent, physicalPath: observed.physicalPath, providerPluginId, expectedDigest,
    ownership: observed.ownership, observation: observed.observation, contentState: observed.contentState,
    associatedAgents: [agent], ...(observed.installedDigest ? { installedDigest: observed.installedDigest } : {}),
    ...(observed.blocker ? { blocker: observed.blocker } : {}),
    ...(observed.recoverableIdentity ? { ownerIdentity: observed.recoverableIdentity } : {}),
    observationEvidence: observed };
}

function finalizePreparation(base: PortablePreparation): PortablePreparation {
  const blockers = [...new Set([...base.globalBlockers, ...base.targets.flatMap((target) => target.blocker ? [target.blocker] : [])])];
  return { ...base, blockers, evidenceDigest: portableJsonDigest({ mode: base.mode, binding: base.bindingDigest,
    agents: base.options.agents, excludedPluginIds: [...(base.options.excludedPluginIds ?? [])].sort(),
    targets: base.targets, globalBlockers: base.globalBlockers,
    ...(base.cleanupOptions ? { force: Boolean(base.cleanupOptions.force), retainedTargets: base.cleanupOptions.retainedTargets } : {}) }) };
}

/** Current config can prove owned output stale without producing a new candidate. */
async function observeUnpreparedOwnedTargets(options: {
  destinationRoot: string;
  agent: PortableAgent;
  scope: 'user' | 'project';
  logicalIdentity: string;
  providerConfigs: ReadonlyArray<readonly [string, string]>;
  excludedPluginIds?: readonly string[];
  signal?: AbortSignal;
}): Promise<PortableTarget[]> {
  const providers = new Map(options.providerConfigs);
  const installed = await scanPortableSkills({ destinationRoot: options.destinationRoot, platform: options.agent,
    scope: options.scope, signal: options.signal });
  return installed.targets.flatMap((observed): PortableTarget[] => {
    const owner = observed.owner ?? observed.recoverableIdentity;
    const configDigest = owner && providers.get(owner.pluginId);
    if (!owner || !configDigest || owner.logicalIdentity !== options.logicalIdentity
      || options.excludedPluginIds?.includes(owner.pluginId)) return [];
    const stale = observed.owner && observed.owner.configDigest !== configDigest;
    const knownDrift = observed.observation === 'drifted' || observed.observation === 'satisfied' && stale;
    const current: PortableSkillObservation = knownDrift ? { ...observed, observation: 'drifted',
      contentState: observed.contentState === 'damaged' ? 'damaged' : 'stale' }
      : { ...observed, observation: 'unknown', contentState: 'unknown' };
    return [{ ...fromObservation(current, options.agent, owner.pluginId, ''), configDigest,
      disposition: 'write', ownerIdentity: owner }];
  });
}

async function collectPreparation(rawOptions: PortableRecoveryOptions, allowMaterialize: boolean): Promise<PortablePreparation> {
  rawOptions.signal?.throwIfAborted();
  const options = { ...rawOptions, agents: selectedAgents(rawOptions.agents), env: rawOptions.context.env };
  const layout = portableRecoveryLayout(options.context);
  if (options.scope !== layout.scope) throw new Error('portableEnvironmentUnsupported');
  const base: PortablePreparation = { options, root: options.selector, generation: '', generations: {}, logicalIdentity: '',
    targets: [], blockers: [], globalBlockers: [], evidenceDigest: '', mode: 'deploy' };
  if (new Set(options.agents.map((agent) => layout.targetRoot(agent))).size !== options.agents.length) {
    return finalizePreparation({ ...base, globalBlockers: ['portableOutputConflict'] });
  }
  const bindings: Array<[PortableAgent, string]> = [];
  for (const agent of options.agents) {
    options.signal?.throwIfAborted();
    let stage: PortablePreparationDiagnostic['stage'] = 'catalog-binding';
    try {
      const { providerConfigs = [], ...bindingInput } = await resolvePortableCatalogBindingInput({
        ...options, platform: agent, cwd: layout.cwd });
      const generation = path.join(layout.generationRoot, portableJsonDigest(options.selector).slice(7),
        portableJsonDigest({ platform: agent, bindingInput }).slice(7));
      base.generations![agent] = generation;
      if (!base.generation) base.generation = generation;
      stage = 'generation-path';
      if (!await assertPortablePath(path.parse(generation).root, generation)) {
        if (!allowMaterialize) {
          base.logicalIdentity = bindingInput.source.logicalIdentity;
          bindings.push([agent, portableJsonDigest(bindingInput)]);
          stage = 'output-observation';
          base.targets.push(...await observeUnpreparedOwnedTargets({ destinationRoot: layout.targetRoot(agent),
            agent, scope: options.scope, logicalIdentity: base.logicalIdentity, providerConfigs,
            excludedPluginIds: options.excludedPluginIds, signal: options.signal }));
          base.globalBlockers.push('needs-preparation');
          continue;
        }
        stage = 'materialize';
        await materializePortableSkillsToDirectory({ ...options, platform: agent, cwd: layout.cwd,
          out: generation, allowEmpty: true });
      }
      stage = 'materialization-read';
      const materialized = await readHistoricalPortableMaterialization({ generationRoot: layout.generationRoot,
        scope: options.scope, rootDir: generation, pluginId: options.selector,
        logicalIdentity: bindingInput.source.logicalIdentity, platform: agent });
      if (JSON.stringify(materialized.binding.source) !== JSON.stringify(bindingInput.source)
        || materialized.binding.profile.inputDigest !== bindingInput.profile.inputDigest) {
        base.globalBlockers.push('operationReviewStale'); continue;
      }
      base.logicalIdentity = bindingInput.source.logicalIdentity;
      bindings.push([agent, materialized.binding.finalDigest]);
      const candidates = materialized.marker.selectedSkills.filter((candidate) =>
        !options.excludedPluginIds?.includes(candidate.providerPluginId));
      stage = 'skill-validation';
      if (new Set(candidates.map((candidate) => normalizePortableSkillName(candidate.name))).size !== candidates.length) {
        base.globalBlockers.push('portableOutputConflict'); continue;
      }
      for (const candidate of candidates) {
        const source = path.join(generation, 'skills', candidate.name);
        await validatePortableSkillDirectory(source);
        await validateRuntimeSkillClosure(source);
      }
      stage = 'output-observation';
      for (const candidate of candidates) {
        options.signal?.throwIfAborted();
        const identity: PortableOwnerIdentity = { pluginId: candidate.providerPluginId,
          logicalIdentity: base.logicalIdentity, platform: agent, scope: options.scope, skill: candidate.name };
        const configDigest = candidate.configDigest ?? materialized.binding.profile.inputDigest;
        const observed = await observePortableSkill({ destinationRoot: layout.targetRoot(agent),
          skill: candidate.name, identity, expectedDigest: candidate.filesDigest, configDigest });
        base.targets.push({ ...fromObservation(observed, agent, candidate.providerPluginId, candidate.filesDigest),
          configDigest, sourcePath: path.join(generation, 'skills', candidate.name), ownerIdentity: identity, disposition: 'write',
          // A complete matching identity is sufficient to repair damaged weak metadata.
          ...(observed.blocker === 'portableOwnerDamaged' ? { blocker: undefined } : {}) });
      }
      const providers = new Set([materialized.marker.plugin.id, ...materialized.marker.dependencies]
        .filter((pluginId) => !options.excludedPluginIds?.includes(pluginId)));
      const installed = await scanPortableSkills({ destinationRoot: layout.targetRoot(agent), platform: agent,
        scope: options.scope, signal: options.signal });
      for (const observed of installed.targets) {
        const owner = observed.owner ?? observed.recoverableIdentity;
        if (!owner || !providers.has(owner.pluginId) || owner.logicalIdentity !== base.logicalIdentity
          || candidates.some((candidate) => candidate.name === owner.skill && candidate.providerPluginId === owner.pluginId)) continue;
        base.targets.push({ ...fromObservation(observed, agent, owner.pluginId, observed.owner?.filesDigest ?? ''),
          disposition: 'remove', observation: observed.observation === 'satisfied' ? 'drifted' : observed.observation,
          contentState: observed.contentState === 'current' ? 'stale' : observed.contentState });
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      const code = error instanceof Error && /^(?:portable|operationReview)/u.test(error.message)
        ? error.message.split(':')[0]! : 'portablePreparationFailed';
      base.globalBlockers.push(code);
      const systemCode = error && typeof error === 'object' && 'code' in error
        && typeof error.code === 'string' && SAFE_FILESYSTEM_CODES.has(error.code) ? error.code : undefined;
      (base.diagnostics ??= []).push({ code, agent, stage, ...(systemCode ? { systemCode } : {}) });
    }
  }
  base.globalBlockers = [...new Set(base.globalBlockers)];
  base.bindingDigest = portableJsonDigest(bindings);
  return finalizePreparation(base);
}

export async function preparePortableRecovery(options: PortableRecoveryOptions): Promise<PortablePreparation> {
  return collectPreparation(options, true);
}
export async function inspectPortableRecovery(options: PortableRecoveryOptions): Promise<PortablePreparation> {
  return options.cleanup ? preparePortableCleanup(options.cleanup) : collectPreparation(options, false);
}

export interface PortableCleanupOptions {
  scope: 'user' | 'project';
  context: ScopeContext;
  selector: string;
  agents?: PortableAgent[];
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  retainedTargets?: readonly Pick<PortableTarget, 'skill' | 'agent' | 'physicalPath'>[];
  signal?: AbortSignal;
}

/** Cleanup only reads bounded output markers. Current Catalog, schema and renderer are irrelevant. */
export async function preparePortableCleanup(options: PortableCleanupOptions): Promise<PortablePreparation> {
  options.signal?.throwIfAborted();
  const agents = selectedAgents(options.agents ?? [...PORTABLE_PLATFORM_TARGETS]);
  const base: PortablePreparation = { options: { ...options, cliVersion: '', agents, env: options.context.env, cleanup: options },
    root: options.selector, generation: '', logicalIdentity: '', targets: [], blockers: [], globalBlockers: [],
    evidenceDigest: '', mode: 'cleanup', cleanupOptions: { ...options, agents } };
  try {
    const layout = portableRecoveryLayout(options.context);
    if (layout.scope !== options.scope) throw new Error('portableEnvironmentUnsupported');
    for (const agent of agents) {
      const scanned = await scanPortableSkills({ destinationRoot: layout.targetRoot(agent), platform: agent,
        scope: options.scope, signal: options.signal });
      if (!scanned.complete) base.globalBlockers.push('portableObservationFailed');
      for (const observed of scanned.targets) {
        const owner = observed.owner ?? observed.recoverableIdentity;
        if (!owner || owner.pluginId !== options.selector || options.retainedTargets?.some((retained) =>
          retained.skill === observed.skill && retained.agent === agent && retained.physicalPath === observed.physicalPath)) continue;
        const target = fromObservation(observed, agent, owner.pluginId, observed.owner?.filesDigest ?? '');
        base.targets.push({ ...target, disposition: 'remove',
          ...(options.force && target.blocker === 'portableOwnerDamaged' ? { blocker: undefined } : {}) });
      }
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    base.globalBlockers.push('portableObservationFailed');
  }
  base.globalBlockers = [...new Set(base.globalBlockers)];
  return finalizePreparation(base);
}

export async function executePortableRecovery(options: {
  prepared: PortablePreparation;
  token: AwHomeMutationToken;
  authorizeUpdate?: boolean;
  targets?: Array<{ skill: string; agent: PortableAgent }>;
  action?: 'sync' | 'reinstall' | 'uninstall' | 'cleanup';
  force?: boolean;
  completedFootprints?: CompletedPortableFootprint[];
}): Promise<PortableExecution> {
  const { prepared } = options;
  const selected = (target: PortableTarget): boolean => !options.targets || options.targets.some((pair) =>
    pair.skill === target.skill && pair.agent === target.agent);
  const failure = (code: string): PortableExecution => ({ targets: prepared.targets.filter(selected).map((target) => ({
    ...target, execution: 'not-run', blockers: [code] })), blockers: [code], globalBlockers: [code],
  execution: 'not-run', outputsMayHaveChanged: false });
  const cleanup = options.action === 'cleanup' || options.action === 'uninstall';
  if (cleanup !== (prepared.mode === 'cleanup')) return failure('operationReviewStale');
  return withAwHomeMutationLock({ env: prepared.options.context.env, token: options.token,
    signal: prepared.options.signal, action: async () => {
      const current = cleanup ? await preparePortableCleanup(prepared.cleanupOptions!)
        : await collectPreparation({ ...prepared.options, catalogOperationContext: undefined }, false);
      if (!prepared.evidenceDigest) return failure('operationReviewStale');
      const completedPaths = new Set((options.completedFootprints ?? []).filter((footprint) =>
        footprint.logicalIdentity === current.logicalIdentity && current.targets.some((target) => target.disposition !== 'remove'
          && target.physicalPath === footprint.physicalPath && target.providerPluginId === footprint.providerPluginId
          && target.expectedDigest === footprint.expectedDigest && target.observation === 'satisfied'
          && target.ownership === 'aw')).map((footprint) => footprint.physicalPath));
      const unchanged = (value: PortablePreparation): string => portableJsonDigest({
        binding: value.bindingDigest, targets: value.targets.filter((target) => !completedPaths.has(target.physicalPath)),
        blockers: value.globalBlockers, excludedPluginIds: value.options.excludedPluginIds,
      });
      if (prepared.evidenceDigest !== current.evidenceDigest
        && (completedPaths.size === 0 || unchanged(prepared) !== unchanged(current))) return failure('operationReviewStale');
      if (options.force && !prepared.cleanupOptions?.force) return failure('operationReviewStale');
      if (options.targets?.some((pair) => !current.targets.some((target) => target.skill === pair.skill && target.agent === pair.agent))) {
        return failure('operationReviewStale');
      }
      const results: PortableExecutionTarget[] = [];
      let outputsMayHaveChanged = false;
      const layout = portableRecoveryLayout(prepared.options.context);
      for (const target of current.targets.filter(selected)) {
        const blockers = target.blocker ? [target.blocker] : [];
        if (!cleanup && (target.observation === 'drifted' || target.disposition === 'remove') && !options.authorizeUpdate) {
          blockers.push('portableUpdateAuthorizationRequired');
        }
        if (blockers.length || !target.observationEvidence || !target.ownerIdentity) {
          results.push({ ...target, execution: 'not-run', blockers: blockers.length ? [...new Set(blockers)] : ['portableObservationFailed'] });
          continue;
        }
        if (!cleanup && target.disposition !== 'remove' && target.observation === 'satisfied'
          && (options.action !== 'reinstall' || completedPaths.has(target.physicalPath))) {
          results.push({ ...target, execution: 'no-op', blockers: [] }); continue;
        }
        try {
          outputsMayHaveChanged = true;
          if (cleanup || target.disposition === 'remove') {
            await removePortableSkill({ destinationRoot: layout.targetRoot(target.agent), identity: target.ownerIdentity,
              observed: target.observationEvidence, force: prepared.cleanupOptions?.force });
          } else {
            await publishPortableSkill({ sourceDir: target.sourcePath!, destinationRoot: layout.targetRoot(target.agent),
              identity: target.ownerIdentity, expectedDigest: target.expectedDigest,
              configDigest: target.configDigest!, observed: target.observationEvidence });
          }
          const after = await observePortableSkill({ destinationRoot: layout.targetRoot(target.agent), skill: target.skill,
            identity: target.ownerIdentity, ...(cleanup || target.disposition === 'remove' ? {}
              : { expectedDigest: target.expectedDigest, configDigest: target.configDigest }) });
          const satisfied = cleanup || target.disposition === 'remove' ? after.observation === 'absent'
            : after.observation === 'satisfied' && after.ownership === 'aw';
          results.push({ ...target, ...fromObservation(after, target.agent, target.providerPluginId, target.expectedDigest),
            execution: satisfied ? 'applied' : 'failed', blockers: satisfied ? [] : [after.blocker ?? 'portableVerificationFailed'] });
        } catch (error) {
          prepared.options.signal?.throwIfAborted();
          const code = error instanceof Error && /^(?:portable|operationReview)/u.test(error.message)
            ? error.message : 'portableWriteFailed';
          const observed = await observePortableSkill({ destinationRoot: layout.targetRoot(target.agent), skill: target.skill,
            identity: target.ownerIdentity, expectedDigest: target.expectedDigest, configDigest: target.configDigest });
          results.push({ ...target, ...fromObservation(observed, target.agent, target.providerPluginId, target.expectedDigest),
            execution: 'failed', blockers: [code] });
        }
      }
      const blockers = [...new Set([...current.globalBlockers, ...results.flatMap((target) => target.blockers)])];
      const succeeded = results.filter((target) => target.execution === 'applied' || target.execution === 'no-op').length;
      const ok = blockers.length === 0 && succeeded === results.length;
      return { targets: results, blockers, globalBlockers: current.globalBlockers, outputsMayHaveChanged,
        execution: ok ? results.some((target) => target.execution === 'applied') ? 'applied' : 'no-op'
          : succeeded > 0 ? 'partial' : outputsMayHaveChanged ? 'failed' : 'not-run' };
    } });
}

export interface PortableResidue {
  state: 'present' | 'absent' | 'unknown';
  targets: Array<{ skill: string; agent: PortableAgent; physicalPath: string }>;
  blockers: string[];
  unknownAgents?: PortableAgent[];
}
export interface PortableExtraObservation {
  pluginId: string;
  skill: string;
  agent: PortableAgent;
  physicalPath: string;
  observation: 'verified' | 'unknown';
  content: 'satisfied' | 'drifted';
  contentState?: 'current' | 'stale' | 'damaged' | 'unknown';
  logicalIdentity?: string;
}
export interface PortableExtraInspection {
  targets: PortableExtraObservation[];
  complete: boolean;
}
export async function inspectPortableExtraInstalled(options: {
  scope: 'user' | 'project';
  context: ScopeContext;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<PortableExtraInspection> {
  options.signal?.throwIfAborted();
  const targets: PortableExtraObservation[] = [];
  let complete = true;
  try {
    const layout = portableRecoveryLayout(options.context);
    if (layout.scope !== options.scope) return { targets, complete: false };
    for (const agent of PORTABLE_PLATFORM_TARGETS) {
      const scanned = await scanPortableSkills({ destinationRoot: layout.targetRoot(agent), platform: agent,
        scope: options.scope, signal: options.signal });
      complete &&= scanned.complete;
      for (const target of scanned.targets) {
        const owner = target.owner ?? target.recoverableIdentity;
        if (!owner) continue;
        targets.push({ pluginId: owner.pluginId, skill: target.skill, agent, physicalPath: target.physicalPath,
          logicalIdentity: owner.logicalIdentity, contentState: target.contentState,
          observation: target.observation === 'satisfied' ? 'verified' : 'unknown',
          content: target.observation === 'satisfied' ? 'satisfied' : 'drifted' });
      }
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    complete = false;
  }
  return { targets, complete };
}
export async function inspectPortableResidue(options: PortableCleanupOptions & {
  retainedTargets?: readonly Pick<PortableTarget, 'skill' | 'agent' | 'physicalPath' | 'installedDigest'>[];
}): Promise<PortableResidue> {
  const prepared = await preparePortableCleanup(options);
  const targets = prepared.targets.map(({ skill, agent, physicalPath }) => ({ skill, agent, physicalPath }));
  const unknownAgents = [...new Set(prepared.targets.filter((target) => target.blocker).map((target) => target.agent))];
  if (prepared.globalBlockers.length) unknownAgents.push(...(options.agents ?? PORTABLE_PLATFORM_TARGETS));
  const blockers = prepared.blockers.length ? ['portableObservationFailed'] : [];
  return { state: targets.length ? 'present' : blockers.length ? 'unknown' : 'absent', targets, blockers,
    ...(unknownAgents.length ? { unknownAgents: [...new Set(unknownAgents)] } : {}) };
}
