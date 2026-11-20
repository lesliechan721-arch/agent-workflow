import path from 'node:path';

import { isPortablePlatformTarget, PORTABLE_PLATFORM_TARGETS, type ComponentUnmet } from '@lesliechan721/aw-plugin-core';
import { getPlatformFeatureRegistry, isSkillInvocationFeature, type FeatureRequirement } from '@lesliechan721/aw-plugin-core/manifest';

import { withAwHomeMutationLock, type AwHomeMutationToken } from '../utils/aw-home-mutation-lock.js';
import type { CatalogOperationContext, CatalogPreparationReadScope } from '../utils/catalog-operation-context.js';
import { recoveryInterruptionCode } from '../recovery/interruption.js';
import type { RecoveryDiagnostic } from '../recovery/receipt.js';
import { mapInstallReads, type InstallAdmission } from '../recovery/install-concurrency.js';
import type { ScopeContext } from '../intent/scope-context.js';
import { parsePortableSkillFrontmatter, validatePortableSkillDirectory, validatePortableSkillName } from '../utils/dynamic-skill-tree.js';
import { skillInvocationWarning } from '../utils/skill-invocation-warning.js';
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
  disposition?: 'write' | 'remove' | 'retain';
  blocker?: string;
  ownerIdentity?: PortableOwnerIdentity;
  observationEvidence?: PortableSkillObservation;
  invocationWarning?: RecoveryDiagnostic;
}
export function normalizePortableSkillName(name: string): string {
  validatePortableSkillName(name);
  return name;
}
export interface PortableComponentGap extends ComponentUnmet {
  providerPluginId: string;
  agent: PortableAgent;
  renderScope: 'user' | 'project';
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
  unmet: PortableComponentGap[];
  intentionalEmpty: boolean;
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
/** A rejected Review still identifies the requested Skill, but no longer proves its installed state. */
export function unobservedPortableTarget(target: PortableTarget, code: string): PortableExecutionTarget {
  return {
    skill: target.skill, agent: target.agent, physicalPath: target.physicalPath,
    providerPluginId: target.providerPluginId, expectedDigest: target.expectedDigest,
    disposition: target.disposition, associatedAgents: target.associatedAgents,
    execution: 'not-run', observation: 'unknown', ownership: 'unknown', contentState: 'unknown', blockers: [code],
  };
}
export interface PortableExecution {
  reviewProblem?: RecoveryDiagnostic;
  targets: PortableExecutionTarget[];
  blockers: string[];
  globalBlockers: string[];
  unmet: PortableComponentGap[];
  execution: 'not-run' | 'no-op' | 'applied' | 'partial' | 'failed';
  outputsMayHaveChanged: boolean;
}
export class PortableInterruptedError extends Error {
  constructor(readonly result: PortableExecution, cause: unknown) {
    super('Portable recovery was interrupted.', { cause });
  }
}

export interface CompletedPortableFootprint {
  disposition: 'write' | 'remove';
  configDigest?: string;
  evidenceDigest: string;
  physicalPath: string;
  expectedDigest: string;
  providerPluginId: string;
  logicalIdentity: string;
}

export interface CheckedPortableProgress {
  completed: CompletedPortableFootprint[];
  failed: Array<{ logicalIdentity: string; outcome: PortableExecutionTarget }>;
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
    targets: base.targets, globalBlockers: base.globalBlockers, unmet: base.unmet, intentionalEmpty: base.intentionalEmpty,
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

async function collectPreparation(rawOptions: PortableRecoveryOptions, allowMaterialize: boolean,
  catalogReadScope?: CatalogPreparationReadScope, generations?: Map<string, Promise<void>>): Promise<PortablePreparation> {
  rawOptions.signal?.throwIfAborted();
  const options = { ...rawOptions, agents: selectedAgents(rawOptions.agents), env: rawOptions.context.env };
  const layout = portableRecoveryLayout(options.context);
  if (options.scope !== layout.scope) throw new Error('portableEnvironmentUnsupported');
  const base: PortablePreparation = { options, root: options.selector, generation: '', generations: {}, logicalIdentity: '',
    targets: [], blockers: [], globalBlockers: [], unmet: [], intentionalEmpty: false, evidenceDigest: '', mode: 'deploy' };
  if (new Set(options.agents.map((agent) => layout.targetRoot(agent))).size !== options.agents.length) {
    return finalizePreparation({ ...base, globalBlockers: ['portableOutputConflict'] });
  }
  const bindings: Array<[PortableAgent, string]> = [];
  let confirmedInputs = 0;
  let expectedSkills = 0;
  for (const agent of options.agents) {
    options.signal?.throwIfAborted();
    let stage: PortablePreparationDiagnostic['stage'] = 'catalog-binding';
    try {
      const { providerConfigs = [], ...bindingInput } = await resolvePortableCatalogBindingInput({
        ...options, platform: agent, cwd: layout.cwd, catalogReadScope });
      const generation = path.join(layout.generationRoot, portableJsonDigest(options.selector).slice(7),
        // Earlier generations could omit Skills whose invocation preferences had no executor.
        portableJsonDigest({ platform: agent, bindingInput, skillInvocation: 'advisory' }).slice(7));
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
        let publication = generations?.get(generation);
        if (!publication) {
          publication = materializePortableSkillsToDirectory({ ...options, platform: agent, cwd: layout.cwd,
            out: generation, allowEmpty: true, allowUnmet: true }, catalogReadScope).then(() => {});
          generations?.set(generation, publication);
        }
        await publication;
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
      const gaps = materialized.binding.preparation.flatMap((unit): PortableComponentGap[] => {
        const providerPluginId = `${materialized.binding.source.kind === 'catalog-snapshot' ? materialized.binding.source.sourceId : ''}/${unit.plugin}`;
        if (options.excludedPluginIds?.includes(providerPluginId)) return [];
        return unit.unmet.map((gap) => ({ ...gap, providerPluginId, agent, renderScope: unit.renderScope }));
      });
      base.unmet.push(...gaps);
      expectedSkills += candidates.length;
      confirmedInputs += 1;
      if (gaps.length && !candidates.length) base.globalBlockers.push('portableComponentsUnmet');
      stage = 'skill-validation';
      if (new Set(candidates.map((candidate) => normalizePortableSkillName(candidate.name))).size !== candidates.length) {
        base.globalBlockers.push('portableOutputConflict'); continue;
      }
      const invocationWarnings = new Map<string, RecoveryDiagnostic>();
      for (const candidate of candidates) {
        const source = path.join(generation, 'skills', candidate.name);
        const tree = await validatePortableSkillDirectory(source);
        const { metadata } = parsePortableSkillFrontmatter(tree.files['SKILL.md']!.toString('utf8'));
        if (metadata && typeof metadata === 'object') {
          const requested = Object.entries(metadata).flatMap(([feature, value]): FeatureRequirement[] => {
            if (!isSkillInvocationFeature(feature) || typeof value !== 'string') return [];
            const values = value ? value.split(',') : [];
            if (values.some((entry) => !getPlatformFeatureRegistry()[feature]?.values?.includes(entry))) return [];
            return [{ feature, ...(values.length ? { values } : {}) }];
          });
          const warning = skillInvocationWarning(candidate.name, requested,
            { pluginId: candidate.providerPluginId, target: agent, scope: options.scope });
          if (warning) invocationWarnings.set(candidate.name, warning);
        }
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
          ...(invocationWarnings.has(candidate.name) ? { invocationWarning: invocationWarnings.get(candidate.name) } : {}),
          configDigest, sourcePath: path.join(generation, 'skills', candidate.name), ownerIdentity: identity, disposition: 'write',
          // A complete matching identity is sufficient to repair damaged weak metadata.
          ...(observed.blocker === 'portableOwnerDamaged' ? { blocker: undefined } : {}) });
      }
      const providers = new Set([materialized.marker.plugin.id, ...materialized.marker.dependencies]
        .filter((pluginId) => !options.excludedPluginIds?.includes(pluginId)));
      const installed = await scanPortableSkills({ destinationRoot: layout.targetRoot(agent), platform: agent,
        scope: options.scope, signal: options.signal, checkContent: (owner) => owner.logicalIdentity === base.logicalIdentity
          && providers.has(owner.pluginId) && !candidates.some((candidate) => candidate.name === owner.skill
            && candidate.providerPluginId === owner.pluginId) });
      for (const observed of installed.targets) {
        const owner = observed.owner ?? observed.recoverableIdentity;
        if (!owner || !providers.has(owner.pluginId) || owner.logicalIdentity !== base.logicalIdentity
          || candidates.some((candidate) => candidate.name === owner.skill && candidate.providerPluginId === owner.pluginId)) continue;
        if (gaps.some((gap) => gap.providerPluginId === owner.pluginId)) {
          base.targets.push({ ...fromObservation(observed, agent, owner.pluginId, observed.owner?.filesDigest ?? ''),
            ownerIdentity: owner, disposition: 'retain', blocker: 'portableComponentsUnmet' });
          continue;
        }
        base.targets.push({ ...fromObservation(observed, agent, owner.pluginId, observed.owner?.filesDigest ?? ''),
          disposition: 'remove', observation: observed.observation === 'satisfied' ? 'drifted' : observed.observation,
          contentState: observed.contentState === 'current' ? 'stale' : observed.contentState });
      }
    } catch (error) {
      if (recoveryInterruptionCode(error, options.signal)) throw error;
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
  base.intentionalEmpty = confirmedInputs === options.agents.length && confirmedInputs > 0
    && expectedSkills === 0 && base.unmet.length === 0 && base.globalBlockers.length === 0;
  return finalizePreparation(base);
}

export async function preparePortableRecovery(options: PortableRecoveryOptions,
  catalogReadScope?: CatalogPreparationReadScope, generations?: Map<string, Promise<void>>): Promise<PortablePreparation> {
  return collectPreparation(options, true, catalogReadScope, generations);
}
export async function inspectPortableRecovery(options: PortableRecoveryOptions,
  catalogReadScope?: CatalogPreparationReadScope): Promise<PortablePreparation> {
  return options.cleanup ? preparePortableCleanup(options.cleanup) : collectPreparation(options, false, catalogReadScope);
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
    unmet: [], intentionalEmpty: false, evidenceDigest: '', mode: 'cleanup', cleanupOptions: { ...options, agents } };
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

function matchesCompleted(footprint: CompletedPortableFootprint, logicalIdentity: string, target: PortableTarget): boolean {
  return footprint.disposition === target.disposition && footprint.logicalIdentity === logicalIdentity && footprint.physicalPath === target.physicalPath
    && footprint.providerPluginId === target.providerPluginId && footprint.expectedDigest === target.expectedDigest
    && footprint.configDigest === target.configDigest;
}

export async function portableReviewMatches(prepared: PortablePreparation, current: PortablePreparation,
  completed: readonly CompletedPortableFootprint[] = []): Promise<boolean> {
  if (prepared.evidenceDigest === current.evidenceDigest) return true;
  const acceptedPaths = new Set(current.targets.filter((target) => target.disposition === 'write'
    && target.observation === 'satisfied' && target.ownership === 'aw' && completed.some((footprint) =>
      matchesCompleted(footprint, current.logicalIdentity, target) && footprint.evidenceDigest === target.observationEvidence?.evidenceDigest
      && prepared.targets.some((expected) => matchesCompleted(footprint, prepared.logicalIdentity, expected))))
    .map((target) => target.physicalPath));
  const retired = prepared.targets.filter((target) => target.disposition === 'remove'
    && !current.targets.some((live) => live.physicalPath === target.physicalPath));
  for (const target of retired) {
    const footprint = completed.find((entry) => matchesCompleted(entry, prepared.logicalIdentity, target));
    if (!footprint) continue;
    // A scan omits foreign entries. The exact retired path must still be absent.
    const observed = await observePortableSkill({ destinationRoot: path.dirname(target.physicalPath),
      skill: target.skill, identity: target.ownerIdentity });
    if (observed.observation === 'absent' && observed.evidenceDigest === footprint.evidenceDigest) {
      acceptedPaths.add(target.physicalPath);
    }
  }
  if (!acceptedPaths.size) return false;
  const unchanged = (value: PortablePreparation) => portableJsonDigest({
    binding: value.bindingDigest, targets: value.targets.filter((target) => !acceptedPaths.has(target.physicalPath)),
    blockers: value.globalBlockers, unmet: value.unmet, intentionalEmpty: value.intentionalEmpty,
    excludedPluginIds: value.options.excludedPluginIds,
  });
  return unchanged(prepared) === unchanged(current);
}

export async function executePortableRecovery(options: {
  prepared: PortablePreparation;
  token: AwHomeMutationToken;
  authorizeUpdate?: boolean;
  targets?: Array<{ skill: string; agent: PortableAgent }>;
  action?: 'sync' | 'reinstall' | 'uninstall' | 'cleanup';
  force?: boolean;
  progress?: CheckedPortableProgress;
  admission?: InstallAdmission;
  checkPrewrite?: () => Promise<RecoveryDiagnostic | undefined>;
  readProviders?: readonly PortablePreparation[];
  onStart?: () => void;
  signal?: AbortSignal;
}): Promise<PortableExecution> {
  const { prepared, admission } = options;
  const selected = prepared.targets.filter((target) => !options.targets || options.targets.some((pair) =>
    pair.skill === target.skill && pair.agent === target.agent));
  const progress = options.progress ?? { completed: [], failed: [] };
  const cleanup = options.action === 'cleanup' || options.action === 'uninstall';
  const signal = options.signal ?? prepared.options.signal;
  let outputsMayHaveChanged = false;
  const finish = (targets: PortableExecutionTarget[], globalBlockers: string[]): PortableExecution => {
    const blockers = [...new Set([...globalBlockers, ...targets.flatMap((target) => target.blockers),
      ...(prepared.unmet.length ? ['portableComponentsUnmet'] : [])])];
    const succeeded = targets.filter((target) => target.execution === 'applied' || target.execution === 'no-op').length;
    const ok = blockers.length === 0 && succeeded === targets.length;
    return { targets, blockers, globalBlockers, unmet: prepared.unmet, outputsMayHaveChanged,
      execution: ok ? targets.some((target) => target.execution === 'applied') ? 'applied' : 'no-op'
        : succeeded > 0 ? 'partial' : outputsMayHaveChanged ? 'failed' : 'not-run' };
  };
  const stale = (target: PortableTarget): PortableExecutionTarget =>
    unobservedPortableTarget(target, 'operationReviewStale');
  if (cleanup !== (prepared.mode === 'cleanup') || !prepared.evidenceDigest
    || options.force && !prepared.cleanupOptions?.force || options.targets?.some((pair) =>
      !selected.some((target) => target.agent === pair.agent && target.skill === pair.skill))) {
    return finish(selected.map(stale), ['operationReviewStale']);
  }
  return withAwHomeMutationLock({ env: prepared.options.context.env, token: options.token, signal, action: async () => {
    const layout = portableRecoveryLayout(prepared.options.context);
    const read = async (): Promise<RecoveryDiagnostic | undefined> => {
      if (options.checkPrewrite) return options.checkPrewrite();
      const current = cleanup ? await preparePortableCleanup(prepared.cleanupOptions!)
        : await collectPreparation({ ...prepared.options, signal, catalogOperationContext: undefined }, false);
      if (!await portableReviewMatches(prepared, current, progress.completed)) {
        return { code: 'operationReviewStale', message: 'Portable review inputs changed.' };
      }
    };
    // Bind Catalog, configuration and the complete set of owned outputs for this prewrite window.
    // The check only grants permission to attempt the reviewed work. It supplies no live writer observations.
    let reviewProblem: RecoveryDiagnostic | undefined;
    let preflight: Promise<{ epoch: number; problem: RecoveryDiagnostic | undefined }> | undefined;
    let checkedEpoch: number | undefined;
    const check = () => {
      const epoch = admission?.exclusiveGeneration ?? 0;
      if (!preflight || checkedEpoch !== epoch) {
        checkedEpoch = epoch;
        const capture = async () => ({ epoch: admission?.exclusiveGeneration ?? 0, problem: await read() });
        const readRoots = [...prepared.options.agents.map((agent) => layout.targetRoot(agent)),
          ...(options.readProviders ?? []).flatMap((group) => {
            const provider = portableRecoveryLayout(group.options.context);
            return group.options.agents.map((agent) => provider.targetRoot(agent));
          })];
        preflight = admission ? admission.run([...new Set(readRoots)].map((value) =>
          ({ kind: 'path', value, access: 'read' })), capture, signal) : capture();
      }
      return preflight;
    };
    const initial = await check();
    if (initial.problem) return { ...finish(selected.map(stale), [initial.problem.code]), reviewProblem: initial.problem };
    const startedWrites = new Set<PortableTarget>();
    const verified = new Map<PortableTarget, PortableExecutionTarget>();
    const execute = async (target: PortableTarget): Promise<PortableExecutionTarget> => {
      options.onStart?.();
      const failed = progress.failed.find(({ logicalIdentity, outcome }) => logicalIdentity === prepared.logicalIdentity
        && outcome.physicalPath === target.physicalPath && outcome.expectedDigest === target.expectedDigest
        && outcome.configDigest === target.configDigest && outcome.providerPluginId === target.providerPluginId);
      if (failed) return { ...failed.outcome, agent: target.agent };
      const blockers = target.blocker ? [target.blocker] : [];
      if (!cleanup && target.disposition === 'retain') blockers.push('portableComponentsUnmet');
      if (!cleanup && (target.observation === 'drifted' || target.disposition === 'remove') && !options.authorizeUpdate) {
        blockers.push('portableUpdateAuthorizationRequired');
      }
      if (blockers.length || !target.observationEvidence || !target.ownerIdentity) {
        return { ...target, execution: 'not-run', blockers: blockers.length ? [...new Set(blockers)] : ['portableObservationFailed'] };
      }
      const removal = cleanup || target.disposition === 'remove';
      const observe = () => observePortableSkill({ destinationRoot: layout.targetRoot(target.agent), skill: target.skill,
        identity: target.ownerIdentity, ...(!removal ? { expectedDigest: target.expectedDigest, configDigest: target.configDigest } : {}) });
      const record = (after: PortableSkillObservation, execution: PortableExecutionTarget['execution'], blockers: string[]) => {
        const outcome = { ...target, ...fromObservation(after, target.agent, target.providerPluginId, target.expectedDigest),
          execution, blockers };
        if (execution === 'failed') progress.failed.push({ logicalIdentity: prepared.logicalIdentity, outcome });
        else if (removal ? after.observation === 'absent' : after.observation === 'satisfied' && after.ownership === 'aw') {
          progress.completed.push({ physicalPath: target.physicalPath, expectedDigest: target.expectedDigest,
            configDigest: target.configDigest, providerPluginId: target.providerPluginId, logicalIdentity: prepared.logicalIdentity,
            evidenceDigest: after.evidenceDigest, disposition: removal ? 'remove' : 'write' });
        }
        return outcome;
      };
      try {
        const completed = progress.completed.find((footprint) => matchesCompleted(footprint, prepared.logicalIdentity, target));
        if (completed || !removal && target.observation === 'satisfied' && options.action !== 'reinstall') {
          const after = await observe();
          if (after.evidenceDigest !== (completed?.evidenceDigest ?? target.observationEvidence.evidenceDigest)
            || after.observation !== (removal ? 'absent' : 'satisfied')) return stale(target);
          return record(after, 'no-op', []);
        }
        outputsMayHaveChanged = true;
        startedWrites.add(target);
        if (removal) {
          await removePortableSkill({ destinationRoot: layout.targetRoot(target.agent), identity: target.ownerIdentity,
            observed: target.observationEvidence, force: prepared.cleanupOptions?.force });
        } else {
          await publishPortableSkill({ sourceDir: target.sourcePath!, destinationRoot: layout.targetRoot(target.agent),
            identity: target.ownerIdentity, expectedDigest: target.expectedDigest, configDigest: target.configDigest!,
            observed: target.observationEvidence });
        }
        const after = await observe();
        const satisfied = removal ? after.observation === 'absent' : after.observation === 'satisfied' && after.ownership === 'aw';
        return record(after, satisfied ? 'applied' : 'failed', satisfied ? [] : [after.blocker ?? 'portableVerificationFailed']);
      } catch (error) {
        signal?.throwIfAborted();
        const code = error instanceof Error && /^(?:portable|operationReview)/u.test(error.message)
          ? error.message : 'portableWriteFailed';
        return record(await observe(), 'failed', [code]);
      }
    };
    const apply = async (target: PortableTarget) => {
      const outcome = await execute(target);
      verified.set(target, outcome);
      return outcome;
    };
    let results: PortableExecutionTarget[];
    try {
      results = await mapInstallReads(selected, async (target) => {
        if (!admission || cleanup) return apply(target);
        for (;;) {
          const prewrite = await check();
          if (prewrite.problem) { reviewProblem = prewrite.problem; return stale(target); }
          const result = await admission.run([{ kind: 'path', value: target.physicalPath }], () =>
            prewrite.epoch === admission.exclusiveGeneration ? apply(target) : Promise.resolve(undefined), signal);
          if (result) return result;
        }
      }, { signal, limit: admission && !cleanup ? Math.max(1, selected.length) : 1 });
    } catch (error) {
      const code = recoveryInterruptionCode(error, signal);
      if (!code) throw error;
      const partial = selected.map((target): PortableExecutionTarget => verified.get(target) ?? ({
        ...target, execution: startedWrites.has(target) ? 'failed' : 'not-run', observation: 'unknown', blockers: [code],
      }));
      throw new PortableInterruptedError(finish(partial, [code]), error);
    }
    const globalBlockers = [...prepared.globalBlockers];
    if (results.some((target) => target.execution === 'not-run' && target.blockers.includes('operationReviewStale'))) {
      globalBlockers.push('operationReviewStale');
    }
    return { ...finish(results, globalBlockers), ...(reviewProblem ? { reviewProblem } : {}) };
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
  content: 'satisfied' | 'drifted' | 'unknown';
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
  plugins?: ReadonlySet<string>;
}): Promise<PortableExtraInspection> {
  options.signal?.throwIfAborted();
  const targets: PortableExtraObservation[] = [];
  let complete = true;
  try {
    const layout = portableRecoveryLayout(options.context);
    if (layout.scope !== options.scope) return { targets, complete: false };
    for (const agent of PORTABLE_PLATFORM_TARGETS) {
      const scanned = await scanPortableSkills({ destinationRoot: layout.targetRoot(agent), platform: agent,
        scope: options.scope, signal: options.signal, ...(options.plugins ? { checkContent: (identity: PortableOwnerIdentity) =>
          options.plugins!.has(identity.pluginId) || options.plugins!.has(identity.pluginId.split('/')[1]!) } : {}) });
      complete &&= scanned.complete;
      for (const target of scanned.targets) {
        const owner = target.owner ?? target.recoverableIdentity;
        if (!owner) continue;
        const shallow = target.ownership === 'aw' && target.observation === 'unknown'
          && target.installedDigest === undefined && target.blocker === undefined;
        targets.push({ pluginId: owner.pluginId, skill: target.skill, agent, physicalPath: target.physicalPath,
          logicalIdentity: owner.logicalIdentity, contentState: target.contentState,
          observation: target.observation === 'satisfied' ? 'verified' : 'unknown',
          content: shallow ? 'unknown' : target.observation === 'satisfied' ? 'satisfied' : 'drifted' });
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
