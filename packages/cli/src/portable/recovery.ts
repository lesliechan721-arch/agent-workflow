import path from 'node:path';

import fs from 'fs-extra';

import { withAwHomeMutationLock, type AwHomeMutationToken } from '../utils/aw-home-mutation-lock.js';
import type { CatalogOperationContext } from '../utils/catalog-operation-context.js';
import type { ScopeContext } from '../intent/scope-context.js';
import { canonicalizePathThroughExistingAncestor } from '../utils/state-paths.js';
import { materializePortableSkillsToDirectory } from './commands.js';
import { resolvePortableCatalogBindingInput } from './materializer.js';
import {
  assertPortablePath,
  portableJsonDigest,
  portableSkillTreeDigest,
  readHistoricalPortableMaterialization,
  type HistoricalPortableMaterialization,
} from './historical-materialization.js';
import {
  addSkills,
  listInstalledSkills,
  probePortableRecoverySkillsCli,
  type InstalledSkillRecord,
} from './skills-cli.js';
import { portableRecoveryLayout, type PortableAgent } from './recovery-layout.js';
import { observeProviderLock } from './provider-lock-observation.js';

export type { PortableAgent } from './recovery-layout.js';
export interface PortableRecoveryOptions {
  scope: 'user' | 'project';
  context: ScopeContext;
  selector: string;
  cliVersion: string;
  agents: PortableAgent[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  catalogOperationContext?: CatalogOperationContext;
}
export interface PortableTarget {
  skill: string;
  agent: PortableAgent;
  physicalPath: string;
  providerPluginId: string;
  expectedDigest: string;
  installedDigest?: string;
  oldGenerationDigest?: string;
  sourcePath?: string;
  ownership: 'aw' | 'external' | 'unknown';
  observation: 'absent' | 'satisfied' | 'drifted' | 'conflict' | 'unknown';
  associatedAgents: string[];
  blocker?: string;
}
/** skills@1.5.23 installer sanitizeName, verified by the provider qualification. */
export function normalizePortableSkillName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._]+/gu, '-')
    .replace(/^[.\-]+|[.\-]+$/gu, '').substring(0, 255) || 'unnamed-skill';
}
export interface PortablePreparation {
  options: PortableRecoveryOptions;
  root: string;
  generation: string;
  logicalIdentity: string;
  targets: PortableTarget[];
  blockers: string[];
  globalBlockers: string[];
  evidenceDigest: string;
  bindingDigest?: string;
  lockEntries?: Record<string, unknown>;
  lockDigest?: string;
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

function targetPath(options: PortableRecoveryOptions, agent: PortableAgent, skill: string): string {
  return portableRecoveryLayout(options.context).targetPath(agent, normalizePortableSkillName(skill));
}

async function providerPreservesTree(root: string): Promise<boolean> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === 'metadata.json') return false;
    if (entry.isDirectory() && (['.git', '__pycache__', '__pypackages__'].includes(entry.name)
      || !await providerPreservesTree(path.join(root, entry.name)))) return false;
  }
  return true;
}
function agentName(agent: string): string {
  return agent.trim().toLowerCase().replace(/\s+/gu, '-');
}

async function providerLock(options: PortableRecoveryOptions): ReturnType<typeof observeProviderLock> {
  return observeProviderLock(portableRecoveryLayout(options.context));
}

async function outputPathExists(target: string): Promise<boolean> {
  return assertPortablePath(path.parse(target).root, target);
}

async function qualifiedRecordPath(options: PortableRecoveryOptions,
  skill: string, recordPath: string | undefined): Promise<string | undefined> {
  if (!recordPath || !path.isAbsolute(recordPath)) return undefined;
  const layout = portableRecoveryLayout(options.context);
  const name = normalizePortableSkillName(skill);
  const canonical = [layout.targetPath('codex', name), layout.targetPath('claude-code', name)];
  const raw = options.scope === 'user' ? [
    path.join(options.context.env.HOME!, '.agents', 'skills', name),
    path.join(options.context.env.CLAUDE_CONFIG_DIR || path.join(options.context.env.HOME!, '.claude'), 'skills', name),
  ] : canonical;
  if (![...raw, ...canonical].some((candidate) => path.resolve(candidate) === path.resolve(recordPath))) return undefined;
  const resolved = await canonicalizePathThroughExistingAncestor(recordPath);
  return canonical.includes(resolved) && await outputPathExists(resolved) ? resolved : undefined;
}

async function oldMaterialization(options: PortableRecoveryOptions,
  source: string | null | undefined): Promise<HistoricalPortableMaterialization | undefined> {
  const generationRoot = options.context.generationRoot;
  if (source && path.isAbsolute(source)) {
    try { return await readHistoricalPortableMaterialization({ generationRoot, scope: options.scope, rootDir: source }); }
    catch { return undefined; }
  }
  return undefined;
}

async function observeTarget(options: PortableRecoveryOptions, materialization: HistoricalPortableMaterialization,
  target: PortableTarget, records: InstalledSkillRecord[] | undefined): Promise<PortableTarget> {
  if (!records) return { ...target, blocker: 'portableSkillsCliVerificationFailed' };
  try {
    const exists = await outputPathExists(target.physicalPath);
    const matches = records.filter((record) => record.name === target.skill);
    if (!exists && matches.length === 0) return { ...target, observation: 'absent' };
    if (matches.length !== 1) return { ...target, blocker: 'portableTargetAssociationUnknown' };
    const record = matches[0]!;
    const recordPath = await qualifiedRecordPath(options, target.skill, record.path);
    const paths = new Set(options.agents.map((agent) => targetPath(options, agent, target.skill)));
    paths.add(targetPath(options, 'codex', target.skill));
    paths.add(targetPath(options, 'claude-code', target.skill));
    if (record.scope !== (options.scope === 'user' ? 'global' : 'project') || !recordPath || !paths.has(recordPath)) {
      return { ...target, blocker: 'portableTargetAssociationUnknown' };
    }
    const associated = record.agents.some((agent) => agentName(agent) === target.agent);
    if (!exists && !associated && record.agents.length > 0
      && record.agents.every((agent) => ['codex', 'cursor', 'claude-code'].includes(agentName(agent)))) {
      // A different Agent's independent copy does not occupy this proven missing project path.
      return { ...target, observation: 'absent', associatedAgents: record.agents };
    }
    if (!exists || !associated) return { ...target, blocker: 'portableTargetAssociationUnknown' };
    const installedDigest = await portableSkillTreeDigest(target.physicalPath);
    const observed = { ...target, installedDigest, associatedAgents: record.agents,
      ...(typeof record.source === 'string' ? { sourcePath: record.source } : {}) };
    const old = await oldMaterialization(options, record.source);
    const oldSkill = old?.marker.selectedSkills.find((candidate) => candidate.name === target.skill);
    if (old && (old.binding.source.kind !== 'catalog-snapshot'
      || materialization.binding.source.kind !== 'catalog-snapshot'
      || old.binding.source.logicalIdentity !== materialization.binding.source.logicalIdentity
      || oldSkill?.providerPluginId !== target.providerPluginId)) {
      return { ...observed, observation: 'conflict', blocker: 'portableOutputConflict' };
    }
    const owned = oldSkill?.filesDigest === installedDigest && oldSkill.providerPluginId === target.providerPluginId;
    if (installedDigest === target.expectedDigest) {
      return { ...observed, ownership: owned ? 'aw' : 'external', observation: 'satisfied',
        ...(owned ? { oldGenerationDigest: old!.binding.finalDigest } : {}) };
    }
    if (owned) return { ...observed, ownership: 'aw', observation: 'drifted',
      oldGenerationDigest: old!.binding.finalDigest };
    return { ...observed, observation: oldSkill ? 'conflict' : 'unknown', blocker: 'portableOutputConflict' };
  } catch {
    return { ...target, observation: 'conflict', blocker: 'portableOutputConflict' };
  }
}

async function collectPreparation(options: PortableRecoveryOptions, allowMaterialize: boolean): Promise<PortablePreparation> {
  options = { ...options, env: options.context.env };
  const layout = portableRecoveryLayout(options.context);
  if (options.scope !== layout.scope) throw new Error('portableEnvironmentUnsupported');
  const cwd = layout.cwd;
  const bindingInput = await resolvePortableCatalogBindingInput({ ...options, cwd, scope: options.scope });
  const rootKey = portableJsonDigest(options.selector).slice(7);
  const generation = path.join(layout.generationRoot, rootKey, portableJsonDigest(bindingInput).slice(7));
  const base: PortablePreparation = { options, root: options.selector, generation,
    logicalIdentity: bindingInput.source.logicalIdentity, targets: [], blockers: [], globalBlockers: [], evidenceDigest: '' };
  const blocked = (code: string): PortablePreparation => ({ ...base, blockers: [code], globalBlockers: [code] });
  try {
    if (!await assertPortablePath(path.parse(generation).root, generation)) {
      if (!allowMaterialize) return blocked('needs-preparation');
      await materializePortableSkillsToDirectory({ ...options, cwd, out: generation });
    }
    const materialization = await readHistoricalPortableMaterialization({ generationRoot: layout.generationRoot,
      scope: options.scope, rootDir: generation,
      pluginId: options.selector, logicalIdentity: bindingInput.source.logicalIdentity });
    if (JSON.stringify(materialization.binding.source) !== JSON.stringify(bindingInput.source)
      || materialization.binding.profile.inputDigest !== bindingInput.profile.inputDigest) {
      return blocked('operationReviewStale');
    }
    await providerLock(options);
    await probePortableRecoverySkillsCli({ ...options, cwd });
    const records = await listInstalledSkills({ ...options, cwd, global: options.scope === 'user', timeoutMs: 15_000 }).catch(() => undefined);
    const targets: PortableTarget[] = [];
    const normalized = materialization.marker.selectedSkills.map((candidate) => normalizePortableSkillName(candidate.name));
    if (new Set(normalized).size !== normalized.length) return blocked('portableOutputConflict');
    for (const candidate of materialization.marker.selectedSkills) {
      if (!await providerPreservesTree(path.join(generation, 'skills', candidate.name))) {
        return blocked('portableProviderContentUnsupported');
      }
      for (const agent of options.agents) {
        targets.push(await observeTarget(options, materialization, { skill: candidate.name, agent,
          providerPluginId: candidate.providerPluginId, expectedDigest: candidate.filesDigest,
          physicalPath: targetPath(options, agent, candidate.name), ownership: 'unknown',
          observation: 'unknown', associatedAgents: [] }, records));
      }
    }
    const lock = await providerLock(options);
    return { ...base, targets, lockEntries: lock.entries, lockDigest: lock.digest,
      bindingDigest: materialization.binding.finalDigest,
      blockers: [...new Set(targets.flatMap((target) => target.blocker ? [target.blocker] : []))],
      evidenceDigest: portableJsonDigest({ binding: materialization.binding.finalDigest, targets, lock: lock.digest }) };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      && error.code.startsWith('portable') ? error.code
      : error instanceof Error && error.message === 'portableProviderLockInvalid' ? error.message : 'portableOutputConflict';
    return blocked(code);
  }
}

export async function preparePortableRecovery(options: PortableRecoveryOptions): Promise<PortablePreparation> {
  return collectPreparation(options, true);
}
export async function inspectPortableRecovery(options: PortableRecoveryOptions): Promise<PortablePreparation> {
  return collectPreparation(options, false);
}

async function verifiedCompletedFootprints(options: PortableRecoveryOptions,
  completed: CompletedPortableFootprint[], current: PortablePreparation): Promise<Array<CompletedPortableFootprint & { skill: string }>> {
  const verified: Array<CompletedPortableFootprint & { skill: string }> = [];
  const records = await listInstalledSkills({ ...options, cwd: options.context.executionCwd,
    global: options.scope === 'user', timeoutMs: 15_000 }).catch(() => []);
  for (const footprint of completed) {
    try {
      if (!await outputPathExists(footprint.physicalPath)
        || await portableSkillTreeDigest(footprint.physicalPath) !== footprint.expectedDigest) continue;
      const matches = records.filter((record) => record.scope === (options.scope === 'user' ? 'global' : 'project')
        && (targetPath(options, 'codex', record.name) === footprint.physicalPath
          || targetPath(options, 'claude-code', record.name) === footprint.physicalPath));
      if (matches.length !== 1) continue;
      const record = matches[0]!;
      const recordPath = await qualifiedRecordPath(options, record.name, record.path);
      if (!recordPath || ![targetPath(options, 'codex', record.name), targetPath(options, 'claude-code', record.name)].includes(recordPath)) continue;
      const agent = footprint.physicalPath === targetPath(options, 'claude-code', record.name) ? 'claude-code' : 'codex';
      if (!record.agents.some((value) => agentName(value) === agent || (agent === 'codex' && agentName(value) === 'cursor'))) continue;
      await outputPathExists(recordPath);
      if (options.scope === 'user') {
        if (current.logicalIdentity === footprint.logicalIdentity && current.targets.some((target) =>
          target.skill === record.name && target.physicalPath === footprint.physicalPath
          && target.providerPluginId === footprint.providerPluginId
          && target.expectedDigest === footprint.expectedDigest && target.observation === 'satisfied')) {
          verified.push({ ...footprint, skill: record.name });
        }
        continue;
      }
      const old = await oldMaterialization(options, record.source);
      if (!old) continue;
      const candidate = old.marker.selectedSkills.find((entry) => entry.name === record.name);
      const lock = current.lockEntries?.[record.name] as { source?: string; sourceType?: string } | undefined;
      if (candidate?.providerPluginId !== footprint.providerPluginId || candidate.filesDigest !== footprint.expectedDigest
        || old.binding.source.kind !== 'catalog-snapshot'
        || old.binding.source.logicalIdentity !== footprint.logicalIdentity
        || (options.scope === 'project' && (lock?.sourceType !== 'local' || typeof lock.source !== 'string'
          || path.resolve(options.context.executionCwd, lock.source) !== record.source))) continue;
      verified.push({ ...footprint, skill: record.name });
    } catch { /* A previous result is not evidence when its actual output can no longer be verified. */ }
  }
  return verified;
}

export async function executePortableRecovery(options: {
  prepared: PortablePreparation;
  token: AwHomeMutationToken;
  authorizeUpdate?: boolean;
  targets?: Array<{ skill: string; agent: PortableAgent }>;
  action?: 'sync' | 'reinstall' | 'uninstall' | 'cleanup';
  completedFootprints?: CompletedPortableFootprint[];
}): Promise<PortableExecution> {
  const { prepared } = options;
  const isSelected = (target: PortableTarget): boolean => !options.targets || options.targets.some((pair) =>
    pair.skill === target.skill && pair.agent === target.agent);
  const failure = (blocker: string): PortableExecution => ({ targets: prepared.targets.filter(isSelected).map((target) => ({
    ...target, execution: 'not-run', blockers: [...new Set([blocker, ...(target.blocker ? [target.blocker] : [])])],
  })), globalBlockers: [blocker], blockers: [blocker], execution: 'not-run', outputsMayHaveChanged: false });
  if (options.action === 'uninstall' || options.action === 'cleanup') return failure('backend-action-unsupported');
  return withAwHomeMutationLock({ env: prepared.options.env, token: options.token, signal: prepared.options.signal,
    action: async () => {
      const executionOptions = { ...prepared.options, catalogOperationContext: undefined };
      const current = await collectPreparation(executionOptions, false);
      if (!prepared.evidenceDigest) return failure('operationReviewStale');
      const completed = options.completedFootprints?.length
        ? await verifiedCompletedFootprints(executionOptions, options.completedFootprints, current)
        : [];
      if (prepared.evidenceDigest !== current.evidenceDigest) {
        const excludedPaths = new Set(completed.filter((footprint) => current.targets.every((target) =>
          target.physicalPath !== footprint.physicalPath || (target.observation === 'satisfied'
            && target.expectedDigest === footprint.expectedDigest && target.providerPluginId === footprint.providerPluginId
            && current.logicalIdentity === footprint.logicalIdentity))).map((target) => target.physicalPath));
        const excludedNames = new Set(completed.map((target) => target.skill));
        const unchanged = (plan: PortablePreparation): string => portableJsonDigest({
          binding: plan.bindingDigest, targets: plan.targets.filter((target) => !excludedPaths.has(target.physicalPath)),
          lock: plan.options.scope === 'user' ? plan.lockDigest
            : Object.entries(plan.lockEntries ?? {}).filter(([name]) => !excludedNames.has(name)),
        });
        if (completed.length === 0 || unchanged(prepared) !== unchanged(current)) return failure('operationReviewStale');
      }
      const selected = current.targets.filter(isSelected).map((target): PortableTarget => {
        if (options.action === 'reinstall' && target.observation === 'satisfied' && target.ownership !== 'aw'
          && !completed.some((footprint) => footprint.physicalPath === target.physicalPath
            && footprint.expectedDigest === target.expectedDigest && footprint.providerPluginId === target.providerPluginId
            && footprint.logicalIdentity === current.logicalIdentity)) {
          return { ...target, blocker: 'portableOutputConflict' };
        }
        if (target.observation === 'drifted' && !options.authorizeUpdate) {
          return { ...target, blocker: 'portableUpdateAuthorizationRequired' };
        }
        return target;
      });
      if (options.targets?.some((pair) => !current.targets.some((target) =>
        pair.skill === target.skill && pair.agent === target.agent))) return failure('operationReviewStale');
      const actionable = selected.filter((target) => !target.blocker && (['absent', 'drifted'].includes(target.observation)
        || (options.action === 'reinstall' && target.observation === 'satisfied' && target.ownership === 'aw'
          && !completed.some((footprint) => footprint.physicalPath === target.physicalPath
            && footprint.expectedDigest === target.expectedDigest && footprint.providerPluginId === target.providerPluginId
            && footprint.logicalIdentity === current.logicalIdentity))));
      if (actionable.length === 0) return {
        targets: selected.map((target) => ({ ...target,
          execution: target.observation === 'satisfied' && !target.blocker ? 'no-op' : 'not-run',
          blockers: target.blocker ? [target.blocker] : [],
        })), globalBlockers: current.globalBlockers,
        blockers: [...new Set([...current.globalBlockers, ...selected.flatMap((target) => target.blocker ? [target.blocker] : [])])],
        execution: selected.every((target) => target.observation === 'satisfied' && !target.blocker) ? 'no-op' : 'not-run', outputsMayHaveChanged: false };
      const beforeLock = await providerLock(prepared.options);
      const written = new Set<string>();
      const globalBlockers: string[] = [];
      const targetErrors = new Map<string, string>();
      const groups = new Map<string, PortableTarget[]>();
      for (const target of actionable) {
        const group = groups.get(target.skill) ?? [];
        group.push(target);
        groups.set(target.skill, group);
      }
      for (const [skill, group] of groups) {
        try {
          const before = await collectPreparation(executionOptions, false);
          if (before.bindingDigest !== current.bindingDigest || group.some((target) => {
            const actual = before.targets.find((entry) => entry.skill === target.skill && entry.agent === target.agent);
            return !actual || portableJsonDigest(actual) !== portableJsonDigest(target);
          })) {
            for (const target of group) targetErrors.set(target.physicalPath, 'operationReviewStale');
            continue;
          }
          for (const target of group) written.add(target.physicalPath);
          // One Skill per call preserves exact retry pairs and copies each shared path once.
          await addSkills({ ...prepared.options, cwd: prepared.options.context.executionCwd,
            rootDir: prepared.generation, skills: [skill],
            agents: group.map((target) => target.agent), global: prepared.options.scope === 'user', copy: true, timeoutMs: 60_000 });
        } catch { for (const target of group) targetErrors.set(target.physicalPath, 'portableSkillsCliInstallFailed'); }
      }
      try {
        const afterLock = await providerLock(prepared.options);
        const changedSkills = new Set(actionable.map((target) => target.skill));
        if (Object.entries(beforeLock.entries).some(([name, value]) => !changedSkills.has(name)
          && JSON.stringify(afterLock.entries[name]) !== JSON.stringify(value))
          || (prepared.options.scope === 'user' && beforeLock.digest !== afterLock.digest)) {
          globalBlockers.push('portableProviderLockChanged');
        }
      } catch { globalBlockers.push('portableProviderLockInvalid'); }
      const after = await collectPreparation(executionOptions, false);
      globalBlockers.push(...after.globalBlockers);
      const results = selected.map((original): PortableExecutionTarget => {
        const actual = after.targets.find((target) => target.skill === original.skill && target.agent === original.agent);
        const target = actual ?? { ...original, observation: 'unknown' as const, blocker: 'portableSkillsCliVerificationFailed' };
        const error = targetErrors.get(target.physicalPath);
        const blockers = [...new Set([...globalBlockers, ...(target.blocker ? [target.blocker] : []),
          ...(original.blocker ? [original.blocker] : []), ...(error ? [error] : [])])];
        return { ...target, blockers,
          execution: target.observation === 'satisfied' && blockers.length === 0
            ? written.has(target.physicalPath) ? 'applied' : 'no-op'
            : written.has(target.physicalPath) ? 'failed' : 'not-run' };
      });
      const ok = results.every((target) => target.execution === 'applied' || target.execution === 'no-op');
      return { targets: results, globalBlockers: [...new Set(globalBlockers)],
        blockers: [...new Set(results.flatMap((target) => target.blockers))],
        execution: ok ? 'applied' : results.some((target) => target.execution === 'applied' || target.execution === 'no-op') ? 'partial' : 'failed',
        outputsMayHaveChanged: written.size > 0 };
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
}

export interface PortableExtraInspection {
  targets: PortableExtraObservation[];
  complete: boolean;
}

/** Project provider records have source paths that can be verified against AW materialization evidence. */
export async function inspectPortableExtraInstalled(options: {
  scope: 'user' | 'project';
  context: ScopeContext;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<PortableExtraInspection> {
  options = { ...options, env: options.context.env };
  if (options.scope === 'user') return { targets: [], complete: false };
  let layout: ReturnType<typeof portableRecoveryLayout>;
  try { layout = portableRecoveryLayout(options.context); } catch { return { targets: [], complete: false }; }
  if (layout.scope !== options.scope) return { targets: [], complete: false };
  let records: InstalledSkillRecord[];
  try {
    await observeProviderLock(layout);
    await probePortableRecoverySkillsCli({ ...options, cwd: layout.cwd });
    records = await listInstalledSkills({ ...options, cwd: layout.cwd, global: false, timeoutMs: 15_000 });
  } catch {
    return { targets: [], complete: false };
  }
  const agents: PortableAgent[] = ['codex', 'claude-code', 'cursor'];
  const recoveryOptions: PortableRecoveryOptions = {
    ...options, selector: '', cliVersion: '', agents,
  };
  const targets: PortableExtraObservation[] = [];
  let complete = true;
  for (const record of records) {
    if (record.scope !== 'project') continue;
    let recordPath: string | undefined;
    try { recordPath = await qualifiedRecordPath(recoveryOptions, record.name, record.path); }
    catch { complete = false; continue; }
    if (!recordPath) { complete = false; continue; }
    let old: HistoricalPortableMaterialization | undefined;
    try { old = await oldMaterialization(recoveryOptions, record.source); } catch { old = undefined; }
    if (!old) {
      const source = typeof record.source === 'string' && path.isAbsolute(record.source) ? record.source : undefined;
      if (!source) complete = false;
      else {
        const relative = path.relative(options.context.generationRoot, source);
        if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
          complete = false;
        }
      }
      continue;
    }
    const candidate = old.marker.selectedSkills.find((entry) => entry.name === record.name);
    if (!candidate) { complete = false; continue; }
    const associated = agents.filter((agent) => record.agents.some((entry) => agentName(entry) === agent));
    if (associated.length === 0) { complete = false; continue; }
    for (const agent of associated) {
      const physicalPath = targetPath(recoveryOptions, agent, record.name);
      try {
        if (!await outputPathExists(physicalPath)) { complete = false; continue; }
        const installedDigest = await portableSkillTreeDigest(physicalPath);
        const content = installedDigest === candidate.filesDigest ? 'satisfied' : 'drifted';
        const key = `${candidate.providerPluginId}\0${agent}\0${physicalPath}`;
        if (!targets.some((target) => `${target.pluginId}\0${target.agent}\0${target.physicalPath}` === key)) {
          targets.push({ pluginId: candidate.providerPluginId, skill: record.name, agent, physicalPath,
            observation: content === 'satisfied' ? 'verified' : 'unknown', content });
        }
      } catch { complete = false; }
    }
  }
  return { targets, complete };
}

/** Inspect only current provider records and their bounded scope sources, without current Catalog inputs. */
export async function inspectPortableResidue(options: {
  scope: 'user' | 'project';
  context: ScopeContext;
  selector: string;
  env?: NodeJS.ProcessEnv;
  agents?: PortableAgent[];
  signal?: AbortSignal;
}): Promise<PortableResidue> {
  options = { ...options, env: options.context.env };
  const agents: PortableAgent[] = options.agents ?? ['codex', 'claude-code', 'cursor'];
  const unknown = (): PortableResidue => ({ state: 'unknown', targets: [],
    blockers: ['portableObservationFailed'], unknownAgents: agents });
  const rootKey = path.join(options.context.generationRoot, portableJsonDigest(options.selector).slice(7));
  let hasRootEvidence: boolean;
  try { hasRootEvidence = await assertPortablePath(path.parse(rootKey).root, rootKey); } catch { return unknown(); }
  const candidateNames = new Set<string>();
  let historyUnknown = false;
  if (hasRootEvidence) {
    try {
      for (const entry of await fs.readdir(rootKey, { withFileTypes: true })) {
        try {
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('portableObservationFailed');
          const old = await readHistoricalPortableMaterialization({
            generationRoot: options.context.generationRoot, scope: options.scope,
            rootDir: path.join(rootKey, entry.name), pluginId: options.selector,
          });
          for (const candidate of old.marker.selectedSkills) candidateNames.add(candidate.name);
        } catch { historyUnknown = true; }
      }
      if (!candidateNames.size) historyUnknown = true;
    } catch { historyUnknown = true; }
  }
  try {
    for (const root of await fs.readdir(options.context.generationRoot, { withFileTypes: true })) {
      if (!root.isDirectory() || root.name === path.basename(rootKey)) continue;
      const directory = path.join(options.context.generationRoot, root.name);
      for (const generation of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (!generation.isDirectory()) continue;
        try {
          const old = await readHistoricalPortableMaterialization({
            generationRoot: options.context.generationRoot, scope: options.scope,
            rootDir: path.join(directory, generation.name),
          });
          for (const candidate of old.marker.selectedSkills) {
            if (candidate.providerPluginId === options.selector) candidateNames.add(candidate.name);
          }
        } catch { /* Other roots cannot establish this plugin's candidate names. */ }
      }
    }
  } catch { /* Missing other generations do not change this plugin's evidence. */ }
  const hasEvidence = hasRootEvidence || candidateNames.size > 0;
  let layout: ReturnType<typeof portableRecoveryLayout>;
  try { layout = portableRecoveryLayout(options.context); }
  catch { return hasEvidence ? unknown() : { state: 'absent', targets: [], blockers: [] }; }
  if (layout.scope !== options.scope) return hasEvidence ? unknown() : { state: 'absent', targets: [], blockers: [] };
  let records: InstalledSkillRecord[];
  try {
    await observeProviderLock(layout);
    await probePortableRecoverySkillsCli({ ...options, cwd: layout.cwd });
    records = await listInstalledSkills({ ...options, cwd: layout.cwd,
      global: options.scope === 'user', timeoutMs: 15_000 });
  } catch {
    return hasEvidence ? unknown() : { state: 'absent', targets: [], blockers: [] };
  }
  const targets: PortableResidue['targets'] = [];
  const blockers: string[] = historyUnknown ? ['portableObservationFailed'] : [];
  const unknownAgents = new Set<PortableAgent>(historyUnknown ? agents : []);
  const recoveryOptions: PortableRecoveryOptions = { ...options, cliVersion: '', agents };
  for (const record of records) {
    const relative = record.source && path.isAbsolute(record.source) ? path.relative(rootKey, record.source) : '..';
    const pointsToRoot = relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    if (!record.source && !candidateNames.has(record.name)) continue;
    const associated = agents.filter((agent) => record.agents.some((entry) => agentName(entry) === agent));
    const markUnknown = () => {
      blockers.push('portableObservationFailed');
      for (const agent of associated.length ? associated : agents) unknownAgents.add(agent);
    };
    let recordPath: string | undefined;
    try { recordPath = await qualifiedRecordPath(recoveryOptions, record.name, record.path); }
    catch { markUnknown(); continue; }
    if (record.scope !== (options.scope === 'user' ? 'global' : 'project') || !recordPath
      || ![targetPath(recoveryOptions, 'codex', record.name), targetPath(recoveryOptions, 'claude-code', record.name)].includes(recordPath)) {
      if (pointsToRoot || candidateNames.has(record.name)) markUnknown();
      continue;
    }
    let old: HistoricalPortableMaterialization | undefined;
    try {
      await portableSkillTreeDigest(recordPath);
      old = await oldMaterialization(recoveryOptions, record.source);
    } catch { /* Unverifiable record cannot authorize cleanup. */ }
    if (!old) {
      if (pointsToRoot || candidateNames.has(record.name)) markUnknown();
      continue;
    }
    const candidate = old.marker.selectedSkills.find((entry) => entry.name === record.name);
    if (old.marker.plugin.id !== options.selector && candidate?.providerPluginId !== options.selector) continue;
    if (!candidate) {
      markUnknown();
      continue;
    }
    if (associated.length === 0) {
      const onlyUnselectedAgents = record.agents.length > 0
        && record.agents.every((entry) => ['codex', 'claude-code', 'cursor'].includes(agentName(entry)));
      if (!onlyUnselectedAgents) markUnknown();
      continue;
    }
    for (const agent of associated) {
      const physicalPath = targetPath(recoveryOptions, agent, record.name);
      try {
        if (!await outputPathExists(recordPath) || !await outputPathExists(physicalPath)
          || await portableSkillTreeDigest(physicalPath) !== candidate.filesDigest) {
          unknownAgents.add(agent);
          blockers.push('portableObservationFailed');
          continue;
        }
        if (!targets.some((target) => target.agent === agent && target.skill === record.name)) {
          targets.push({ skill: record.name, agent, physicalPath });
        }
      } catch { unknownAgents.add(agent); blockers.push('portableObservationFailed'); }
    }
  }
  return { state: targets.length > 0 ? 'present' : blockers.length > 0 ? 'unknown' : 'absent',
    targets, blockers: [...new Set(blockers)],
    ...(unknownAgents.size ? { unknownAgents: [...unknownAgents] } : {}) };
}
