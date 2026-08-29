import type { StatusV5Target } from '../commands/status-v5.js';
import type {
  CommandWizardCommand,
  CommandWizardPluginCandidate,
  CommandWizardSelection,
} from '../commands/wizard.js';

export function targetCanBeUninstalled(state: StatusV5Target['state']): boolean {
  return state === 'present' || state === 'partial';
}

export function targetHasArtifactCollision(target: {
  errors: ReadonlyArray<{ code: string }>;
}): boolean {
  return target.errors.some((error) => error.code === 'artifactCollision');
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
    reinstall: target.state === 'present' || target.state === 'partial',
    upgrade: target.state === 'present',
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
