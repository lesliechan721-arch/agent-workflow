import fs from 'node:fs';
import path from 'node:path';
import { resolveCliPackageRoot } from '../utils/paths.js';
import { resolveCanonicalRepoProjectKey } from '../utils/state-paths.js';
import { assertStrictSemVer } from '../utils/manifest.js';
import type { PlatformName } from '../types.js';
import type { CatalogOperationContext } from '../utils/catalog-operation-context.js';
import type { NativeCliRunner } from '../utils/native-cli.js';
import { statusCommandV8 } from '../commands/status-v6.js';
import { inspectPortableProjectRecovery } from '../portable/project-recovery.js';
import { readProjectDemand, resolveProjectDelivery, type ProjectDemand } from './project-demand.js';
import { selectProjectAgents } from './project-preferences.js';
import type { ProjectDiagnostic, ProjectStatusV1, ProjectTargetResult } from './project-types.js';

export interface ProjectNativeObservation {
  pluginId: string;
  platform: PlatformName;
  content: NonNullable<ProjectTargetResult['content']>;
  blockers: ProjectDiagnostic[];
  assumedActivation?: boolean;
}

export interface ReadProjectStatusOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cliVersion?: string;
  target?: string;
  targets?: readonly string[];
  platform?: string;
  nativeCliRunner?: NativeCliRunner;
  catalogOperationContext?: CatalogOperationContext;
}

export interface ProjectStatusReminderTarget {
  pluginId: string;
  agent?: ProjectTargetResult['agent'];
  reasonCodes: string[];
}

export interface ProjectStatusReminder {
  actionableTargets: Array<ProjectStatusReminderTarget & { agent: ProjectTargetResult['agent'] }>;
  blockedTargets: ProjectStatusReminderTarget[];
  unconfirmedTargets: ProjectStatusReminderTarget[];
  diagnosticCodes: string[];
}

export function projectStatusReminder(status: ProjectStatusV1): ProjectStatusReminder {
  const actionableTargets: ProjectStatusReminder['actionableTargets'] = [];
  const blockedTargets: ProjectStatusReminderTarget[] = [];
  const unconfirmedTargets: ProjectStatusReminderTarget[] = [];
  const intentCode = status.intent.state !== 'valid' && status.intent.state !== 'absent'
      ? 'pluginIntentStateInvalid' : undefined;
  for (const root of status.inventory ?? []) {
    const rootCodes = [...root.blockers.map((blocker) => blocker.code),
      ...(intentCode ? [intentCode] : [])];
    if (root.targetResults.length === 0) {
      const entry = { pluginId: root.pluginId,
        reasonCodes: [...new Set([...rootCodes,
          ...(status.selection.agents.length === 0 ? ['localTargetsRequired'] : [])])] };
      (entry.reasonCodes.length ? blockedTargets : unconfirmedTargets).push(entry);
      continue;
    }
    for (const target of root.targetResults) {
      const reasonCodes = [...new Set([...rootCodes, ...target.blockers.map((blocker) => blocker.code)])];
      const entry = { pluginId: root.pluginId, agent: target.agent, reasonCodes };
      if (reasonCodes.length > 0 || target.content === 'conflict'
        || status.intent.state !== 'valid' || target.delivery === null) {
        blockedTargets.push(entry);
      } else if (target.observation === 'verified') {
        continue;
      } else if (target.observation === 'missing' || target.content === 'absent'
        || target.content === 'drifted') {
        actionableTargets.push(entry);
      } else {
        unconfirmedTargets.push(entry);
      }
    }
  }
  return { actionableTargets, blockedTargets, unconfirmedTargets,
    diagnosticCodes: [...new Set([...status.errors.map((error) => error.code),
      ...(intentCode ? [intentCode] : []),
      ...(status.inventory === null && !intentCode ? ['projectInventoryUnavailable'] : [])])] };
}

const NATIVE_OBSERVATION_ERROR_CODES = new Set([
  'nativeStateUnreadable', 'stateInventoryFailed', 'configReadFailed', 'configInvalid',
  'componentInspectionFailed', 'targetInspectionFailed', 'codexNativeObservationFailed',
  'nativeObservationFailed', 'nativeObservationUnavailable',
]);

function diagnostic(code: string): ProjectDiagnostic {
  return { code, message: `${code}: 项目目标尚未满足。` };
}

export async function projectStatusFromObservations(options: ReadProjectStatusOptions & {
  demand: ProjectDemand;
  nativeObservations: ProjectNativeObservation[];
  cliVersion: string;
}): Promise<ProjectStatusV1> {
  const { demand } = options;
  const errors = [...demand.errors];
  let portableProjectRoot: Promise<string> | undefined;
  let selection: ProjectStatusV1['selection'];
  try {
    selection = selectProjectAgents({
      preferences: demand.preferences, target: options.target,
      targets: options.targets, platform: options.platform,
    });
  } catch {
    selection = { agents: [], origin: 'none', preferences: demand.preferences.state };
    if (!errors.some((error) => error.code.startsWith('projectPreferences'))) {
      errors.push(diagnostic('projectTargetSelectionInvalid'));
    }
  }
  const inventory: ProjectStatusV1['inventory'] = demand.roots === null ? null : [];
  for (const root of demand.roots ?? []) {
    const blockers = root.blockers.map(diagnostic);
    if (selection.agents.length === 0) blockers.push(diagnostic('localTargetsRequired'));
    const targetResults: ProjectTargetResult[] = [];
    for (const agent of selection.agents) {
      const delivery = root.plugin ? resolveProjectDelivery(root.plugin.manifest, agent) ?? null : null;
      const target: ProjectTargetResult = {
        pluginId: root.pluginId, agent, delivery, execution: 'not-run', observation: 'unknown',
        content: 'unknown', blockers: [...blockers], requiredBy: [root.pluginId],
      };
      if (blockers.length > 0) {
        targetResults.push(target);
        continue;
      }
      if (!delivery) {
        target.blockers.push(diagnostic('deliveryUnsupported'));
      } else if (delivery.kind === 'native') {
        const native = options.nativeObservations.find((entry) =>
          entry.pluginId === root.pluginId && entry.platform === delivery.platform);
        if (native) {
          target.content = native.content;
          target.blockers.push(...native.blockers);
          errors.push(...native.blockers.filter((blocker) => NATIVE_OBSERVATION_ERROR_CODES.has(blocker.code)));
          if (native.assumedActivation) target.backend = { assumedActivation: true };
        } else {
          const error = diagnostic('nativeObservationUnavailable');
          target.blockers.push(error);
          errors.push(error);
        }
      } else {
        try {
          portableProjectRoot ??= resolveCanonicalRepoProjectKey(options.cwd);
          const portable = await inspectPortableProjectRecovery({
            selector: root.pluginId, cwd: await portableProjectRoot, env: options.env,
            cliVersion: options.cliVersion, agents: [agent],
            catalogOperationContext: demand.catalogOperationContext,
          });
          target.blockers.push(...portable.blockers.map(diagnostic));
          const targets = portable.targets.filter((entry) => entry.agent === agent);
          target.blockers.push(...targets.flatMap((entry) => entry.blocker ? [diagnostic(entry.blocker)] : []));
          target.content = (['conflict', 'drifted', 'absent', 'unknown'] as const)
            .find((state) => targets.some((entry) => entry.observation === state))
            ?? (targets.length > 0 && portable.blockers.length === 0 ? 'satisfied' : 'unknown');
          // Expose only the safe observer projection, never generation paths or config inputs.
          target.backend = targets.map((entry) => ({
            skill: entry.skill, agent: entry.agent, ownership: entry.ownership,
            observation: entry.observation, associatedAgents: entry.associatedAgents,
          }));
          if (target.blockers.some((entry) => /(?:VerificationFailed|ReadFailed|LockInvalid)/u.test(entry.code))) {
            errors.push(diagnostic('portableObservationFailed'));
          }
        } catch {
          target.blockers.push(diagnostic('portableObservationFailed'));
          errors.push(diagnostic('portableObservationFailed'));
        }
      }
      target.observation = target.content === 'satisfied' && target.blockers.length === 0 ? 'verified'
        : target.content === 'absent' ? 'missing' : 'unknown';
      targetResults.push(target);
    }
    inventory!.push({
      pluginId: root.pluginId, source: root.sourceId, sourceState: root.sourceState,
      blockers, targetResults,
    });
  }
  const targets = inventory?.flatMap((root) => root.targetResults) ?? [];
  const explicitFailure = targets.some((target) =>
    ['absent', 'drifted', 'conflict'].includes(target.content ?? '')
    || target.blockers.some((blocker) => /Unsupported$/u.test(blocker.code)));
  const unknown = inventory === null
    || errors.length > 0 || inventory.some((root) => root.blockers.length > 0)
    || targets.some((target) => target.observation !== 'verified');
  return {
    schemaVersion: 1, kind: 'aw-project-status', ok: errors.length === 0,
    intent: {
      state: demand.intent.state,
      ...('digest' in demand.intent ? { digest: demand.intent.digest } : {}),
    },
    selection, inventory, allSatisfied: explicitFailure ? false : unknown ? null : true, errors,
  };
}

export async function readProjectStatus(options: ReadProjectStatusOptions): Promise<ProjectStatusV1> {
  const demand = await readProjectDemand(options);
  let agents: ReturnType<typeof selectProjectAgents>['agents'] = [];
  try {
    agents = selectProjectAgents({ preferences: demand.preferences, target: options.target,
      targets: options.targets, platform: options.platform }).agents;
  } catch { /* The status projection reports invalid selection without hiding demand. */ }
  const needsNative = demand.roots?.some((root) => root.plugin && agents.some((agent) =>
    resolveProjectDelivery(root.plugin!.manifest, agent)?.kind === 'native'));
  if (!needsNative) {
    return projectStatusFromObservations({
      ...options, cliVersion: options.cliVersion ?? assertStrictSemVer(
        (JSON.parse(fs.readFileSync(path.join(resolveCliPackageRoot(), 'package.json'), 'utf8')) as { version: string }).version,
        'CLI version',
      ), demand, nativeObservations: [],
    });
  }
  const status = await statusCommandV8({
    cwd: options.cwd, env: options.env, cliVersion: options.cliVersion,
    nativeCliRunner: options.nativeCliRunner, catalogOperationContext: options.catalogOperationContext,
    projectDemand: demand, projectSelection: {
      target: options.target, targets: options.targets, platform: options.platform,
    },
    includeProjectRecovery: true,
  });
  return status.payload.projectRecovery!;
}
