import type { StatusV7Target } from '../commands/status-v6.js';
import type {
  CommandWizardCommand,
  CommandWizardPluginCandidate,
  CommandWizardSelection,
} from '../commands/wizard.js';

export function targetCanBeUninstalled(
  targetOrState: StatusV7Target | StatusV7Target['state'],
): boolean {
  const state = typeof targetOrState === 'string' ? targetOrState : targetOrState.state;
  if (state === 'ready' || state === 'needsSync' || state === 'orphaned') return true;
  return typeof targetOrState !== 'string'
    && state === 'blocked'
    && targetOrState.components.some((component) =>
      component.kind === 'ownership'
      && (component.state === 'present' || component.state === 'partial'));
}

export function targetHasArtifactCollision(target: {
  reasons: ReadonlyArray<{ code: string; severity: 'warning' | 'blocking' }>;
}): boolean {
  return target.reasons.some((reason) =>
    reason.code === 'artifactCollision' && reason.severity === 'blocking');
}

export function writeCandidateEligibility(
  command: CommandWizardCommand,
  candidate: CommandWizardPluginCandidate,
  selection: CommandWizardSelection,
): { selectable: boolean; reason?: string } {
  const targets = candidate.targets.filter((target) =>
    target.scope === (selection.scope ?? 'user')
    && (selection.platform === 'both' || target.platform === selection.platform));
  if (targets.length === 0) {
    return { selectable: false, reason: 'current bundle 不支持所选平台和范围' };
  }
  const selectable = targets.every((target) => ({
    install: target.state === 'absent' && !targetHasArtifactCollision(target),
    reinstall: target.state === 'needsSync'
      && !targetHasArtifactCollision(target),
    uninstall: targetCanBeUninstalled(target),
    cleanup: target.state !== 'absent',
    'config:list': false,
    'config:get': false,
    'config:set': false,
    'config:unset': false,
    'config:reset': false,
  })[command]);
  return selectable
    ? { selectable: true }
    : { selectable: false, reason: `live status 不允许 ${command}` };
}
