import type { StatusV6Target } from '../commands/status-v6.js';
import type {
  CommandWizardCommand,
  CommandWizardPluginCandidate,
  CommandWizardSelection,
} from '../commands/wizard.js';

export function targetCanBeUninstalled(state: StatusV6Target['state']): boolean {
  return state === 'present' || state === 'partial';
}

export function targetHasArtifactCollision(target: {
  errors: ReadonlyArray<{ code: string; severity: 'warning' | 'blocking' }>;
}): boolean {
  return target.errors.some((error) =>
    error.code === 'artifactCollision' && error.severity === 'blocking');
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
    reinstall: (target.state === 'present' || target.state === 'partial')
      && !targetHasArtifactCollision(target),
    upgrade: target.state === 'present' && !targetHasArtifactCollision(target),
    uninstall: targetCanBeUninstalled(target.state),
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
