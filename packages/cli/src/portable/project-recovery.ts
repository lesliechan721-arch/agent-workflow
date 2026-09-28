import path from 'node:path';

import fs from 'fs-extra';

import { withAwHomeMutationLock, type AwHomeMutationToken } from '../utils/aw-home-mutation-lock.js';
import type { CatalogOperationContext } from '../utils/catalog-operation-context.js';
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
  probeProjectRecoverySkillsCli,
  type InstalledSkillRecord,
} from './skills-cli.js';

export type PortableProjectAgent = 'codex' | 'cursor' | 'claude-code';
export interface PortableProjectRecoveryOptions {
  selector: string;
  cwd: string;
  cliVersion: string;
  agents: PortableProjectAgent[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  catalogOperationContext?: CatalogOperationContext;
}
export interface PortableProjectTarget {
  skill: string;
  agent: PortableProjectAgent;
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
export function normalizeProjectPortableSkillName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._]+/gu, '-')
    .replace(/^[.\-]+|[.\-]+$/gu, '').substring(0, 255) || 'unnamed-skill';
}
export interface PortableProjectPreparation {
  options: PortableProjectRecoveryOptions;
  root: string;
  generation: string;
  logicalIdentity: string;
  targets: PortableProjectTarget[];
  blockers: string[];
  globalBlockers: string[];
  evidenceDigest: string;
  bindingDigest?: string;
  lockEntries?: Record<string, unknown>;
}
export interface PortableProjectExecutionTarget extends PortableProjectTarget {
  execution: 'not-run' | 'no-op' | 'applied' | 'failed';
  blockers: string[];
}
export interface PortableProjectExecution {
  targets: PortableProjectExecutionTarget[];
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

function targetPath(cwd: string, agent: PortableProjectAgent, skill: string): string {
  return path.join(cwd, agent === 'claude-code' ? '.claude' : '.agents', 'skills', normalizeProjectPortableSkillName(skill));
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

async function providerLock(cwd: string): Promise<Record<string, unknown>> {
  const filename = path.join(cwd, 'skills-lock.json');
  if (!await assertPortablePath(cwd, filename)) return {};
  const info = await fs.lstat(filename);
  if (!info.isFile()) throw new Error('portableProviderLockInvalid');
  const value = await fs.readJson(filename).catch(() => { throw new Error('portableProviderLockInvalid'); }) as Record<string, unknown>;
  if (!value || value.version !== 1 || !value.skills || typeof value.skills !== 'object'
    || Array.isArray(value.skills) || Object.keys(value).some((key) => !['version', 'skills'].includes(key))) {
    throw new Error('portableProviderLockInvalid');
  }
  for (const row of Object.values(value.skills)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('portableProviderLockInvalid');
    const entry = row as Record<string, unknown>;
    if (['source', 'sourceType', 'computedHash'].some((key) => typeof entry[key] !== 'string')
      || ['sourceUrl', 'ref', 'skillPath', 'wellKnownDigest'].some((key) => entry[key] !== undefined && typeof entry[key] !== 'string')
      || (entry.subagents !== undefined && (!Array.isArray(entry.subagents) || entry.subagents.some((item) => typeof item !== 'string')))
      || Object.keys(entry).some((key) => !['source', 'sourceType', 'computedHash', 'sourceUrl', 'ref', 'skillPath', 'wellKnownDigest', 'subagents'].includes(key))) {
      throw new Error('portableProviderLockInvalid');
    }
  }
  return value.skills as Record<string, unknown>;
}

async function observeTarget(options: PortableProjectRecoveryOptions, materialization: HistoricalPortableMaterialization,
  target: PortableProjectTarget, records: InstalledSkillRecord[] | undefined): Promise<PortableProjectTarget> {
  if (!records) return { ...target, blocker: 'portableSkillsCliVerificationFailed' };
  try {
    const exists = await assertPortablePath(options.cwd, target.physicalPath);
    const matches = records.filter((record) => record.name === target.skill);
    if (!exists && matches.length === 0) return { ...target, observation: 'absent' };
    if (matches.length !== 1) return { ...target, blocker: 'portableTargetAssociationUnknown' };
    const record = matches[0]!;
    const paths = new Set(options.agents.map((agent) => targetPath(options.cwd, agent, target.skill)));
    paths.add(targetPath(options.cwd, 'codex', target.skill));
    paths.add(targetPath(options.cwd, 'claude-code', target.skill));
    if (record.scope !== 'project' || !record.path || !paths.has(record.path)) {
      return { ...target, blocker: 'portableTargetAssociationUnknown' };
    }
    if (!await assertPortablePath(options.cwd, record.path)) return { ...target, blocker: 'portableTargetAssociationUnknown' };
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
    let old: HistoricalPortableMaterialization | undefined;
    if (typeof record.source === 'string' && path.isAbsolute(record.source)) {
      try {
        old = await readHistoricalPortableMaterialization({ projectRoot: options.cwd,
          rootDir: record.source });
      } catch { /* Missing or invalid old evidence grants no overwrite permission. */ }
    }
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

async function collectPreparation(options: PortableProjectRecoveryOptions, allowMaterialize: boolean): Promise<PortableProjectPreparation> {
  const cwd = await fs.realpath(options.cwd);
  options = { ...options, cwd };
  const bindingInput = await resolvePortableCatalogBindingInput({ ...options, scope: 'project' });
  const rootKey = portableJsonDigest(options.selector).slice(7);
  const generation = path.join(cwd, '.agent-workflows', '.local', 'portable', rootKey,
    portableJsonDigest(bindingInput).slice(7));
  const base: PortableProjectPreparation = { options, root: options.selector, generation,
    logicalIdentity: bindingInput.source.logicalIdentity, targets: [], blockers: [], globalBlockers: [], evidenceDigest: '' };
  const blocked = (code: string): PortableProjectPreparation => ({ ...base, blockers: [code], globalBlockers: [code] });
  try {
    if (!await assertPortablePath(cwd, generation)) {
      if (!allowMaterialize) return blocked('needs-preparation');
      await materializePortableSkillsToDirectory({ ...options, scope: 'project', out: generation });
    }
    const materialization = await readHistoricalPortableMaterialization({ projectRoot: cwd, rootDir: generation,
      pluginId: options.selector, logicalIdentity: bindingInput.source.logicalIdentity });
    if (JSON.stringify(materialization.binding.source) !== JSON.stringify(bindingInput.source)
      || materialization.binding.profile.inputDigest !== bindingInput.profile.inputDigest) {
      return blocked('operationReviewStale');
    }
    await providerLock(cwd);
    await probeProjectRecoverySkillsCli(options);
    const records = await listInstalledSkills({ ...options, global: false, timeoutMs: 15_000 }).catch(() => undefined);
    const targets: PortableProjectTarget[] = [];
    const normalized = materialization.marker.selectedSkills.map((candidate) => normalizeProjectPortableSkillName(candidate.name));
    if (new Set(normalized).size !== normalized.length) return blocked('portableOutputConflict');
    for (const candidate of materialization.marker.selectedSkills) {
      if (!await providerPreservesTree(path.join(generation, 'skills', candidate.name))) {
        return blocked('portableProviderContentUnsupported');
      }
      for (const agent of options.agents) {
        targets.push(await observeTarget(options, materialization, { skill: candidate.name, agent,
          providerPluginId: candidate.providerPluginId, expectedDigest: candidate.filesDigest,
          physicalPath: targetPath(cwd, agent, candidate.name), ownership: 'unknown',
          observation: 'unknown', associatedAgents: [] }, records));
      }
    }
    const lockEntries = await providerLock(cwd);
    return { ...base, targets, lockEntries, bindingDigest: materialization.binding.finalDigest,
      blockers: [...new Set(targets.flatMap((target) => target.blocker ? [target.blocker] : []))],
      evidenceDigest: portableJsonDigest({ binding: materialization.binding.finalDigest, targets, lock: lockEntries }) };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      && error.code.startsWith('portable') ? error.code
      : error instanceof Error && error.message === 'portableProviderLockInvalid' ? error.message : 'portableOutputConflict';
    return blocked(code);
  }
}

export async function preparePortableProjectRecovery(options: PortableProjectRecoveryOptions): Promise<PortableProjectPreparation> {
  return collectPreparation(options, true);
}
export async function inspectPortableProjectRecovery(options: PortableProjectRecoveryOptions): Promise<PortableProjectPreparation> {
  return collectPreparation(options, false);
}

async function verifiedCompletedFootprints(options: PortableProjectRecoveryOptions,
  completed: CompletedPortableFootprint[], lockEntries: Record<string, unknown>): Promise<Array<CompletedPortableFootprint & { skill: string }>> {
  const verified: Array<CompletedPortableFootprint & { skill: string }> = [];
  const records = await listInstalledSkills({ ...options, global: false, timeoutMs: 15_000 }).catch(() => []);
  for (const footprint of completed) {
    try {
      if (!await assertPortablePath(options.cwd, footprint.physicalPath)
        || await portableSkillTreeDigest(footprint.physicalPath) !== footprint.expectedDigest) continue;
      const matches = records.filter((record) => record.scope === 'project'
        && (targetPath(options.cwd, 'codex', record.name) === footprint.physicalPath
          || targetPath(options.cwd, 'claude-code', record.name) === footprint.physicalPath));
      if (matches.length !== 1) continue;
      const record = matches[0]!;
      if (!record.path || ![targetPath(options.cwd, 'codex', record.name), targetPath(options.cwd, 'claude-code', record.name)].includes(record.path)
        || typeof record.source !== 'string' || !path.isAbsolute(record.source)) continue;
      const agent = footprint.physicalPath === targetPath(options.cwd, 'claude-code', record.name) ? 'claude-code' : 'codex';
      if (!record.agents.some((value) => agentName(value) === agent || (agent === 'codex' && agentName(value) === 'cursor'))) continue;
      await assertPortablePath(options.cwd, record.path);
      const old = await readHistoricalPortableMaterialization({ projectRoot: options.cwd, rootDir: record.source,
        logicalIdentity: footprint.logicalIdentity });
      const candidate = old.marker.selectedSkills.find((entry) => entry.name === record.name);
      const lock = lockEntries[record.name] as { source?: string; sourceType?: string } | undefined;
      if (candidate?.providerPluginId !== footprint.providerPluginId || candidate.filesDigest !== footprint.expectedDigest
        || lock?.sourceType !== 'local' || typeof lock.source !== 'string'
        || path.resolve(options.cwd, lock.source) !== record.source) continue;
      verified.push({ ...footprint, skill: record.name });
    } catch { /* A previous result is not evidence when its actual output can no longer be verified. */ }
  }
  return verified;
}

export async function executePortableProjectRecovery(options: {
  prepared: PortableProjectPreparation;
  token: AwHomeMutationToken;
  authorizeUpdate?: boolean;
  targets?: Array<{ skill: string; agent: PortableProjectAgent }>;
  action?: 'sync' | 'reinstall' | 'uninstall' | 'cleanup';
  completedFootprints?: CompletedPortableFootprint[];
}): Promise<PortableProjectExecution> {
  const { prepared } = options;
  const isSelected = (target: PortableProjectTarget): boolean => !options.targets || options.targets.some((pair) =>
    pair.skill === target.skill && pair.agent === target.agent);
  const failure = (blocker: string): PortableProjectExecution => ({ targets: prepared.targets.filter(isSelected).map((target) => ({
    ...target, execution: 'not-run', blockers: [...new Set([blocker, ...(target.blocker ? [target.blocker] : [])])],
  })), globalBlockers: [blocker], blockers: [blocker], execution: 'not-run', outputsMayHaveChanged: false });
  if (options.action === 'uninstall' || options.action === 'cleanup') return failure('backend-action-unsupported');
  return withAwHomeMutationLock({ env: prepared.options.env, token: options.token, signal: prepared.options.signal,
    action: async () => {
      const executionOptions = { ...prepared.options, catalogOperationContext: undefined };
      const current = await collectPreparation(executionOptions, false);
      if (!prepared.evidenceDigest) return failure('operationReviewStale');
      const completed = options.completedFootprints?.length
        ? await verifiedCompletedFootprints(executionOptions, options.completedFootprints, current.lockEntries ?? {})
        : [];
      if (prepared.evidenceDigest !== current.evidenceDigest) {
        const excludedPaths = new Set(completed.filter((footprint) => current.targets.every((target) =>
          target.physicalPath !== footprint.physicalPath || (target.observation === 'satisfied'
            && target.expectedDigest === footprint.expectedDigest && target.providerPluginId === footprint.providerPluginId
            && current.logicalIdentity === footprint.logicalIdentity))).map((target) => target.physicalPath));
        const excludedNames = new Set(completed.map((target) => target.skill));
        const unchanged = (plan: PortableProjectPreparation): string => portableJsonDigest({
          binding: plan.bindingDigest, targets: plan.targets.filter((target) => !excludedPaths.has(target.physicalPath)),
          lock: Object.entries(plan.lockEntries ?? {}).filter(([name]) => !excludedNames.has(name)),
        });
        if (completed.length === 0 || unchanged(prepared) !== unchanged(current)) return failure('operationReviewStale');
      }
      const selected = current.targets.filter(isSelected).map((target): PortableProjectTarget => {
        if (options.action === 'reinstall' && target.observation === 'satisfied' && target.ownership !== 'aw') {
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
      const beforeLock = await providerLock(prepared.options.cwd);
      const written = new Set<string>();
      const globalBlockers: string[] = [];
      const targetErrors = new Map<string, string>();
      const groups = new Map<string, PortableProjectTarget[]>();
      for (const target of actionable) {
        const group = groups.get(target.skill) ?? [];
        if (!group.some((entry) => entry.physicalPath === target.physicalPath)) group.push(target);
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
          await addSkills({ ...prepared.options, rootDir: prepared.generation, skills: [skill],
            agents: group.map((target) => target.agent), global: false, copy: true, timeoutMs: 60_000 });
        } catch { for (const target of group) targetErrors.set(target.physicalPath, 'portableSkillsCliInstallFailed'); }
      }
      try {
        const afterLock = await providerLock(prepared.options.cwd);
        const changedSkills = new Set(actionable.map((target) => target.skill));
        if (Object.entries(beforeLock).some(([name, value]) => !changedSkills.has(name)
          && JSON.stringify(afterLock[name]) !== JSON.stringify(value))) globalBlockers.push('portableProviderLockChanged');
      } catch { globalBlockers.push('portableProviderLockInvalid'); }
      const after = await collectPreparation(executionOptions, false);
      globalBlockers.push(...after.globalBlockers);
      const results = selected.map((original): PortableProjectExecutionTarget => {
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

export interface PortableProjectResidue {
  state: 'present' | 'absent' | 'unknown';
  targets: Array<{ skill: string; agent: PortableProjectAgent; physicalPath: string }>;
  blockers: string[];
}

/** Inspect only current provider records and their bounded project sources, without current Catalog inputs. */
export async function inspectPortableProjectResidue(options: {
  selector: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  agents?: PortableProjectAgent[];
  signal?: AbortSignal;
}): Promise<PortableProjectResidue> {
  const unknown = (): PortableProjectResidue => ({ state: 'unknown', targets: [], blockers: ['portableObservationFailed'] });
  let cwd: string;
  try { cwd = await fs.realpath(options.cwd); } catch { return unknown(); }
  const rootKey = path.join(cwd, '.agent-workflows', '.local', 'portable', portableJsonDigest(options.selector).slice(7));
  let hasRootEvidence: boolean;
  try { hasRootEvidence = await assertPortablePath(cwd, rootKey); } catch { return unknown(); }
  let records: InstalledSkillRecord[];
  try {
    await probeProjectRecoverySkillsCli({ ...options, cwd });
    records = await listInstalledSkills({ ...options, cwd, global: false, timeoutMs: 15_000 });
  } catch {
    return hasRootEvidence ? unknown() : { state: 'absent', targets: [], blockers: [] };
  }
  const targets: PortableProjectResidue['targets'] = [];
  const blockers: string[] = [];
  const agents: PortableProjectAgent[] = options.agents ?? ['codex', 'claude-code', 'cursor'];
  for (const record of records) {
    if (typeof record.source !== 'string' || !path.isAbsolute(record.source)) {
      if (hasRootEvidence) blockers.push('portableObservationFailed');
      continue;
    }
    const relative = path.relative(rootKey, record.source);
    const pointsToRoot = relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    let old: HistoricalPortableMaterialization;
    try { old = await readHistoricalPortableMaterialization({ projectRoot: cwd, rootDir: record.source }); } catch {
      if (pointsToRoot) blockers.push('portableObservationFailed');
      continue;
    }
    const candidate = old.marker.selectedSkills.find((entry) => entry.name === record.name);
    if (old.marker.plugin.id !== options.selector && candidate?.providerPluginId !== options.selector) continue;
    if (!candidate || record.scope !== 'project' || !record.path
      || ![targetPath(cwd, 'codex', record.name), targetPath(cwd, 'claude-code', record.name)].includes(record.path)) {
      blockers.push('portableObservationFailed');
      continue;
    }
    const associated = agents.filter((agent) => record.agents.some((entry) => agentName(entry) === agent));
    if (associated.length === 0) {
      const onlyUnselectedAgents = record.agents.length > 0
        && record.agents.every((entry) => ['codex', 'claude-code', 'cursor'].includes(agentName(entry)));
      if (!onlyUnselectedAgents) blockers.push('portableObservationFailed');
      continue;
    }
    for (const agent of associated) {
      const physicalPath = targetPath(cwd, agent, record.name);
      try {
        if (!await assertPortablePath(cwd, record.path) || !await assertPortablePath(cwd, physicalPath)
          || await portableSkillTreeDigest(physicalPath) !== candidate.filesDigest) {
          blockers.push('portableObservationFailed');
          continue;
        }
        if (!targets.some((target) => target.agent === agent && target.skill === record.name)) {
          targets.push({ skill: record.name, agent, physicalPath });
        }
      } catch { blockers.push('portableObservationFailed'); }
    }
  }
  return { state: targets.length > 0 ? 'present' : blockers.length > 0 ? 'unknown' : 'absent',
    targets, blockers: [...new Set(blockers)] };
}
