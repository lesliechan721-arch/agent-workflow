import fs from 'fs-extra';

import type {
  CommandOptions,
  InstallCommandOptions,
  PlatformName,
  PlatformSelection,
  Scope,
  SkillTriggerPreference,
  UpgradeCommandOptions,
} from '../types.js';
import { detectEnvironment, listDetectedPlatforms } from '../utils/detect.js';
import { readInstalledLedger } from '../utils/local-marketplace.js';
import {
  resolveClaudeProjectKey,
  resolveCodexProjectKey,
  resolveRepoRoot,
} from '../utils/paths.js';
import {
  buildCommandCandidates,
  type CommandCandidate,
} from './discovery.js';
import {
  loadPluginTargetsForCommand,
  pluginSupportsPlatform,
  type ResolvedPluginTarget,
} from './common.js';
import {
  assertCodexProjectInstallableTargets,
  getCodexProjectInstallability,
  shouldOmitCodexProjectInstallCandidate,
} from './codex-project-installability.js';
import { parseSkillTriggerPreference } from './options.js';
import type { CommandExecutionContext } from './runtime.js';

export interface InteractiveDispatchGroup<TOptions extends CommandOptions | UpgradeCommandOptions> {
  pluginNames: string[];
  options: TOptions;
  candidates: CommandCandidate[];
}

export interface InteractiveInstallPlan {
  groups: Array<InteractiveDispatchGroup<InstallCommandOptions>>;
}

export interface InteractiveUninstallPlan {
  groups: Array<InteractiveDispatchGroup<CommandOptions>>;
}

export interface InteractiveUpgradePlan {
  groups: Array<InteractiveDispatchGroup<UpgradeCommandOptions>>;
}

type InteractiveCommand = 'install' | 'uninstall' | 'upgrade';

const PLATFORM_DISPLAY: Record<PlatformName, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
};

function platformSelectionToPlatforms(selection: Exclude<PlatformSelection, 'auto'>): PlatformName[] {
  return selection === 'both' ? ['codex', 'claude'] : [selection];
}

async function realpathOrResolved(inputPath: string): Promise<string> {
  try {
    return await fs.realpath(inputPath);
  } catch {
    return inputPath;
  }
}

async function resolveExecutionCwd(
  cwd: string,
  platform: PlatformName,
  scope: Scope,
): Promise<{ executionCwd: string; projectKey?: string; projectRoot?: string }> {
  if (scope === 'user') {
    return {
      executionCwd: await realpathOrResolved(cwd),
    };
  }

  if (platform === 'codex') {
    const repoRoot = await resolveRepoRoot(cwd);
    return {
      executionCwd: await realpathOrResolved(repoRoot),
      projectRoot: await realpathOrResolved(repoRoot),
      projectKey: await resolveCodexProjectKey(cwd),
    };
  }

  return {
    executionCwd: await realpathOrResolved(cwd),
    projectRoot: await realpathOrResolved(cwd),
    projectKey: await resolveClaudeProjectKey(cwd),
  };
}

function candidateId(
  command: InteractiveCommand,
  pluginName: string,
  platform: PlatformName,
  scope: Scope,
  projectKey?: string,
): string {
  return [command, pluginName, platform, scope, projectKey ?? 'user']
    .map((value) => encodeURIComponent(value))
    .join(':');
}

function compatiblePlatformsForTarget(target: ResolvedPluginTarget): PlatformName[] {
  return (['codex', 'claude'] as const)
    .filter((platform) => pluginSupportsPlatform(target.plugin, platform));
}

function intersectPlatforms(left: PlatformName[], right: PlatformName[]): PlatformName[] {
  const rightSet = new Set(right);
  return left.filter((platform) => rightSet.has(platform));
}

async function detectAvailablePlatforms(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<PlatformName[]> {
  return listDetectedPlatforms(await detectEnvironment(cwd, env));
}

function formatPlatformList(platforms: PlatformName[]): string {
  return platforms.map((platform) => PLATFORM_DISPLAY[platform]).join(' / ');
}

const INTERACTIVE_PLATFORMS: PlatformName[] = ['codex', 'claude'];

function platformChoices(platforms: PlatformName[]): string[] {
  const choices: string[] = [...platforms];
  if (platforms.includes('codex') && platforms.includes('claude')) {
    choices.push('both');
  }
  return choices;
}

function hasInteractiveInstallCodexProjectCandidate(target: ResolvedPluginTarget): boolean {
  return pluginSupportsPlatform(target.plugin, 'codex') &&
    getCodexProjectInstallability(target.plugin).managedKinds.length > 0;
}

function candidateHasActionableEvidence(candidate: CommandCandidate): boolean {
  return candidate.evidence.sources.some((source) =>
    source === 'ledger' ||
      source === 'tracking' ||
      source === 'codexNativeConfig' ||
      source === 'codexSharedNativeRef' ||
      source === 'claudeSettings' ||
      source === 'claudeInstalledPlugins',
  );
}

function filterCandidatesByPlatform(
  candidates: CommandCandidate[],
  platformFilter: PlatformName | 'both' | undefined,
): CommandCandidate[] {
  if (!platformFilter || platformFilter === 'both') {
    return candidates;
  }

  return candidates.filter((candidate) => candidate.platform === platformFilter);
}

async function resolveInstallPromptPlatforms(options: {
  cwd: string;
  scope: Scope;
  targets: ResolvedPluginTarget[];
  env: NodeJS.ProcessEnv;
}): Promise<PlatformName[]> {
  const availablePlatforms = new Set(
    await detectAvailablePlatforms(options.cwd, options.env),
  );

  if (options.scope !== 'project' || availablePlatforms.has('codex')) {
    return INTERACTIVE_PLATFORMS.filter((platform) => availablePlatforms.has(platform));
  }

  if (options.targets.length > 0) {
    if (options.targets.every(hasInteractiveInstallCodexProjectCandidate)) {
      availablePlatforms.add('codex');
    }
    return INTERACTIVE_PLATFORMS.filter((platform) => availablePlatforms.has(platform));
  }

  const catalogTargets = await loadPluginTargetsForCommand(options.cwd, options.scope, undefined, {
    allowHistoricalFallback: false,
    env: options.env,
  });
  for (const platform of INTERACTIVE_PLATFORMS) {
    if (
      availablePlatforms.has(platform) &&
      !catalogTargets.some((target) => pluginSupportsPlatform(target.plugin, platform))
    ) {
      availablePlatforms.delete(platform);
    }
  }
  if (catalogTargets.some(hasInteractiveInstallCodexProjectCandidate)) {
    availablePlatforms.add('codex');
  }

  return INTERACTIVE_PLATFORMS.filter((platform) => availablePlatforms.has(platform));
}

function assertInteractiveAvailable(forcePrompt: boolean, context: CommandExecutionContext): void {
  if (forcePrompt && !context.interactive) {
    throw new Error('当前运行环境不可交互；请在 TTY 中运行，或移除 --interactive 并显式传入参数。');
  }
}

async function promptScope(
  context: CommandExecutionContext,
  defaultValue: Scope,
): Promise<Scope> {
  const selected = await context.prompt.selectScope?.({ defaultValue });
  if (selected !== 'user' && selected !== 'project') {
    throw new Error(`无效 scope 选择：${String(selected)}`);
  }
  return selected;
}

async function promptPlatform(
  context: CommandExecutionContext,
  available: string[],
  defaultValue: string,
): Promise<Exclude<PlatformSelection, 'auto'>> {
  if (available.length === 0) {
    throw new Error('当前没有可选择的平台。');
  }
  const selected = await context.prompt.selectPlatform?.({
    available,
    defaultValue,
  });
  if (selected !== 'codex' && selected !== 'claude' && selected !== 'both') {
    throw new Error(`无效平台选择：${String(selected)}`);
  }
  if (!available.includes(selected)) {
    throw new Error(`平台选择 ${selected} 不在本轮候选列表中。`);
  }
  return selected;
}

function validateSelectedCandidateIds(
  candidates: CommandCandidate[],
  selectedIds: string[],
): CommandCandidate[] {
  if (selectedIds.length === 0) {
    throw new Error('没有选择任何插件。');
  }

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selected: CommandCandidate[] = [];
  for (const id of selectedIds) {
    const candidate = byId.get(id);
    if (!candidate) {
      throw new Error(`无效候选选择：${id}`);
    }
    if (!candidate.selectable) {
      throw new Error(candidate.disabledReason ?? `${candidate.pluginName} 当前不可选择。`);
    }
    selected.push(candidate);
  }

  return selected;
}

async function promptPlugins(
  context: CommandExecutionContext,
  command: InteractiveCommand,
  candidates: CommandCandidate[],
  options: {
    defaultValues?: string[];
    allowMultiple: boolean;
  },
): Promise<CommandCandidate[]> {
  const selectableIds = candidates
    .filter((candidate) => candidate.selectable)
    .map((candidate) => candidate.id);
  if (selectableIds.length === 0) {
    const disabledReasons = candidates
      .filter((candidate) => candidate.disabledReason)
      .map((candidate) => `${candidate.pluginName}: ${candidate.disabledReason}`);
    throw new Error(
      disabledReasons.length > 0
        ? `没有可选择的插件：\n${disabledReasons.map((reason) => `- ${reason}`).join('\n')}`
        : '没有可选择的插件。',
    );
  }

  const selectedIds = await context.prompt.selectPlugins?.({
    command,
    candidates,
    defaultValues: options.defaultValues ?? [selectableIds[0]],
    allowMultiple: options.allowMultiple,
  });
  return validateSelectedCandidateIds(candidates, selectedIds ?? []);
}

function groupCandidates<TOptions extends CommandOptions | UpgradeCommandOptions>(
  candidates: CommandCandidate[],
  createOptions: (candidate: CommandCandidate) => TOptions,
): Array<InteractiveDispatchGroup<TOptions>> {
  const groups = new Map<string, InteractiveDispatchGroup<TOptions>>();

  for (const candidate of candidates) {
    const key = [
      candidate.platform,
      candidate.scope,
      candidate.executionCwd,
    ].join('\0');
    let group = groups.get(key);
    if (!group) {
      group = {
        pluginNames: [],
        options: createOptions(candidate),
        candidates: [],
      };
      groups.set(key, group);
    }
    if (!group.pluginNames.includes(candidate.pluginName)) {
      group.pluginNames.push(candidate.pluginName);
    }
    group.candidates.push(candidate);
  }

  return [...groups.values()];
}

function getScopeRecord(
  ledger: Awaited<ReturnType<typeof readInstalledLedger>>,
  candidate: CommandCandidate,
) {
  const platformRecord = ledger.plugins[candidate.pluginName]?.platforms[candidate.platform];
  if (!platformRecord) {
    return undefined;
  }
  return candidate.scope === 'user'
    ? platformRecord.userScope
    : candidate.projectKey
      ? platformRecord.projectScopes?.[candidate.projectKey]
      : undefined;
}

function candidateHasSkillTriggerRuntime(candidate: CommandCandidate): boolean {
  return Boolean(
    candidate.target.embeddedPlugin?.manifest.skills ||
      candidate.target.currentPlugin?.manifest.skills ||
      candidate.target.plugin.manifest.skills,
  );
}

async function maybePromptSkillTrigger<TOptions extends InstallCommandOptions | UpgradeCommandOptions>(
  command: 'install' | 'upgrade',
  groups: Array<InteractiveDispatchGroup<TOptions>>,
  context: CommandExecutionContext,
): Promise<void> {
  if (!context.interactive || groups.every((group) => group.options.requestedSkillTrigger)) {
    return;
  }

  const ledger = await readInstalledLedger(context.env);
  if (ledger.ledgerState.status !== 'degraded') {
    return;
  }

  const needsPrompt = groups.some((group) =>
    group.candidates.some((candidate) => {
      if (!candidateHasSkillTriggerRuntime(candidate)) {
        return false;
      }
      if (command === 'upgrade') {
        return true;
      }
      return getScopeRecord(ledger, candidate)?.managed === true;
    }),
  );

  if (!needsPrompt) {
    return;
  }

  const selected = await context.prompt.selectSkillTrigger?.({
    defaultValue: 'default',
    allowSkip: false,
  });
  if (selected === undefined || selected === 'skip') {
    throw new Error('degraded installed.json 下必须显式选择 skill-trigger 偏好。');
  }
  const preference = parseSkillTriggerPreference(selected);
  for (const group of groups) {
    group.options.requestedSkillTrigger ??= preference as SkillTriggerPreference;
  }
}

function createInstallCandidate(options: {
  target: ResolvedPluginTarget;
  platform: PlatformName;
  scope: Scope;
  executionCwd: string;
  projectKey?: string;
  projectRoot?: string;
  targetPlatforms: PlatformName[];
  wholeSelectionInstallable: boolean;
  wholeSelectionReason?: string;
}): CommandCandidate {
  const compatiblePlatforms = compatiblePlatformsForTarget(options.target);
  let disabledReason = options.wholeSelectionInstallable ? undefined : options.wholeSelectionReason;
  if (!compatiblePlatforms.includes(options.platform)) {
    disabledReason = `插件不支持 ${PLATFORM_DISPLAY[options.platform]}。`;
  } else if (options.platform === 'codex' && options.scope === 'project') {
    disabledReason = getCodexProjectInstallability(options.target.plugin).reason;
  }

  return {
    id: candidateId(
      'install',
      options.target.pluginName,
      options.platform,
      options.scope,
      options.projectKey,
    ),
    command: 'install',
    pluginName: options.target.pluginName,
    platform: options.platform,
    scope: options.scope,
    projectKey: options.projectKey,
    projectRoot: options.projectRoot,
    executionCwd: options.executionCwd,
    target: options.target,
    selectable: disabledReason === undefined,
    disabledReason,
    compatiblePlatforms,
    evidence: {
      platform: options.platform,
      scope: options.scope,
      projectKey: options.projectKey,
      projectRoot: options.projectRoot,
      executionCwd: options.executionCwd,
      sources: [],
      trackingKinds: [],
      trackingIntegrityErrors: [],
      trackingHasHookIdentities: false,
      ledgerManaged: false,
      ledgerStateStatus: 'available',
      ledgerStateReason: null,
      readErrors: [],
    },
    evidenceByPlatformScope: {},
  };
}

async function buildInstallCandidates(options: {
  cwd: string;
  scope: Scope;
  targetPlatforms: PlatformName[];
  pluginNames?: string[];
  env: NodeJS.ProcessEnv;
}): Promise<CommandCandidate[]> {
  const targets = await loadPluginTargetsForCommand(
    options.cwd,
    options.scope,
    options.pluginNames,
    {
      allowHistoricalFallback: false,
      env: options.env,
    },
  );
  const candidates: CommandCandidate[] = [];
  const hasExplicitPluginSelection = Boolean(options.pluginNames && options.pluginNames.length > 0);

  for (const target of targets) {
    const perPlatformInstallable = options.targetPlatforms.map((platform) => {
      if (!pluginSupportsPlatform(target.plugin, platform)) {
        return {
          platform,
          installable: false,
          reason: `插件不支持 ${PLATFORM_DISPLAY[platform]}。`,
        };
      }
      const codexProjectInstallability = platform === 'codex' && options.scope === 'project'
        ? getCodexProjectInstallability(target.plugin)
        : undefined;
      if (codexProjectInstallability && !codexProjectInstallability.installable) {
        return {
          platform,
          installable: false,
          reason: codexProjectInstallability.reason ?? `${target.pluginName} 当前不可选。`,
        };
      }
      return { platform, installable: true };
    });
    const blocked = perPlatformInstallable.find((entry) => !entry.installable);
    const wholeSelectionInstallable = blocked === undefined;
    const wholeSelectionReason = options.targetPlatforms.length > 1 && blocked
      ? `选择 ${formatPlatformList(options.targetPlatforms)} 时，${blocked.reason}`
      : undefined;

    for (const platform of options.targetPlatforms) {
      if (shouldOmitCodexProjectInstallCandidate({
        plugin: target.plugin,
        platform,
        scope: options.scope,
        hasExplicitPluginSelection,
      })) {
        continue;
      }
      const identity = await resolveExecutionCwd(options.cwd, platform, options.scope);
      candidates.push(createInstallCandidate({
        target,
        platform,
        scope: options.scope,
        targetPlatforms: options.targetPlatforms,
        wholeSelectionInstallable,
        wholeSelectionReason,
        ...identity,
      }));
    }
  }

  return candidates;
}

function assertExplicitInstallCompatibility(
  targets: ResolvedPluginTarget[],
  requestedPlatforms: PlatformName[],
  scope: Scope,
): void {
  const unsupported = targets.flatMap((target) =>
    requestedPlatforms
      .filter((platform) => !pluginSupportsPlatform(target.plugin, platform))
      .map((platform) => `${target.pluginName} -> ${PLATFORM_DISPLAY[platform]}`),
  );
  if (unsupported.length > 0) {
    throw new Error(`插件不支持目标平台：${unsupported.join('；')}。`);
  }

  assertCodexProjectInstallableTargets(targets, requestedPlatforms, scope);
}

async function resolveInstallPlatforms(options: {
  cwd: string;
  scope: Scope;
  requestedPlatform: PlatformSelection;
  targets: ResolvedPluginTarget[];
  env: NodeJS.ProcessEnv;
  context: CommandExecutionContext;
  forcePrompt: boolean;
}): Promise<{
  platforms: PlatformName[];
  prompted: boolean;
}> {
  const availablePlatforms = await resolveInstallPromptPlatforms({
    cwd: options.cwd,
    scope: options.scope,
    targets: options.targets,
    env: options.env,
  });
  if (availablePlatforms.length === 0) {
    throw new Error('当前环境没有检测到可用平台。');
  }

  if (options.requestedPlatform !== 'auto') {
    if (options.forcePrompt && options.context.interactive) {
      const compatible = options.targets.length === 0
        ? availablePlatforms
        : options.targets.reduce<PlatformName[]>(
            (current, target) => intersectPlatforms(current, compatiblePlatformsForTarget(target)),
            availablePlatforms,
          );
      if (compatible.length === 0) {
        throw new Error('显式插件之间没有共同兼容的平台，请分开安装或重新选择插件。');
      }

      const choices = platformChoices(compatible);
      const requestedPlatforms = platformSelectionToPlatforms(options.requestedPlatform);
      const defaultSelection =
        options.requestedPlatform === 'both' && choices.includes('both')
          ? 'both'
          : requestedPlatforms.find((platform) => choices.includes(platform)) ?? compatible[0];
      const selected = await promptPlatform(options.context, choices, defaultSelection);
      return {
        platforms: platformSelectionToPlatforms(selected === 'both' ? 'both' : selected),
        prompted: true,
      };
    }

    return {
      platforms: platformSelectionToPlatforms(options.requestedPlatform),
      prompted: false,
    };
  }

  const compatible = options.targets.length === 0
    ? availablePlatforms
    : options.targets.reduce<PlatformName[]>(
        (current, target) => intersectPlatforms(current, compatiblePlatformsForTarget(target)),
        availablePlatforms,
      );

  if (compatible.length === 0) {
    throw new Error('显式插件之间没有共同兼容的平台，请分开安装或重新选择插件。');
  }

  if (!options.forcePrompt && compatible.length === 1) {
    return {
      platforms: compatible,
      prompted: false,
    };
  }

  if (!options.context.interactive) {
    return {
      platforms: compatible,
      prompted: false,
    };
  }

  const choices = platformChoices(compatible);
  const selected = await promptPlatform(
    options.context,
    choices,
    choices.includes('both') ? 'both' : compatible[0],
  );
  return {
    platforms: platformSelectionToPlatforms(selected === 'both' ? 'both' : selected),
    prompted: true,
  };
}

export async function createInteractiveInstallPlan(
  pluginNames: string[],
  options: InstallCommandOptions,
  context: CommandExecutionContext,
  forcePrompt: boolean,
): Promise<InteractiveInstallPlan | null> {
  assertInteractiveAvailable(forcePrompt, context);

  const missingPlugins = pluginNames.length === 0;
  if (missingPlugins && !context.interactive) {
    return null;
  }

  const needsCodexProjectValidation =
    options.scope === 'project' &&
    (options.platform === 'codex' || options.platform === 'both');
  if (
    !missingPlugins &&
    !forcePrompt &&
    options.platform !== 'auto' &&
    !context.interactive &&
    !needsCodexProjectValidation
  ) {
    return null;
  }

  const scope = (missingPlugins || forcePrompt) && context.interactive
    ? await promptScope(context, options.scope)
    : options.scope;

  if (!missingPlugins && !forcePrompt && options.platform !== 'auto') {
    const targetPlatforms = platformSelectionToPlatforms(options.platform);
    const targets = await loadPluginTargetsForCommand(options.cwd, scope, pluginNames, {
      allowHistoricalFallback: false,
      env: context.env,
    });
    assertExplicitInstallCompatibility(targets, targetPlatforms, scope);
    if (!context.interactive || options.requestedSkillTrigger) {
      return null;
    }

    const candidates = await buildInstallCandidates({
      cwd: options.cwd,
      scope,
      targetPlatforms,
      pluginNames,
      env: context.env,
    });
    const selectedCandidates = candidates.filter((candidate) =>
      pluginNames.includes(candidate.pluginName),
    );
    const groups = groupCandidates(selectedCandidates, (candidate): InstallCommandOptions => ({
      cwd: candidate.executionCwd,
      platform: candidate.platform,
      scope: candidate.scope,
      requestedSkillTrigger: options.requestedSkillTrigger,
    }));
    await maybePromptSkillTrigger('install', groups, context);
    return groups.some((group) => group.options.requestedSkillTrigger !== options.requestedSkillTrigger)
      ? { groups }
      : null;
  }

  const targets = missingPlugins
    ? []
    : await loadPluginTargetsForCommand(options.cwd, scope, pluginNames, {
        allowHistoricalFallback: false,
        env: context.env,
      });

  const platformResolution = await resolveInstallPlatforms({
    cwd: options.cwd,
    scope,
    requestedPlatform: options.platform,
    targets,
    env: context.env,
    context,
    forcePrompt: forcePrompt || missingPlugins,
  });
  assertExplicitInstallCompatibility(targets, platformResolution.platforms, scope);

  const candidates = await buildInstallCandidates({
    cwd: options.cwd,
    scope,
    targetPlatforms: platformResolution.platforms,
    pluginNames: missingPlugins || forcePrompt ? (missingPlugins ? undefined : pluginNames) : pluginNames,
    env: context.env,
  });

  const shouldPromptPlugins = missingPlugins || forcePrompt;
  const selectedCandidates = shouldPromptPlugins
    ? await promptPlugins(context, 'install', candidates, {
        defaultValues: pluginNames.length > 0
          ? candidates
              .filter((candidate) => pluginNames.includes(candidate.pluginName))
              .map((candidate) => candidate.id)
          : undefined,
        allowMultiple: true,
      })
    : candidates.filter((candidate) => pluginNames.includes(candidate.pluginName));

  const groups = groupCandidates(selectedCandidates, (candidate): InstallCommandOptions => ({
    cwd: candidate.executionCwd,
    platform: candidate.platform,
    scope: candidate.scope,
    requestedSkillTrigger: options.requestedSkillTrigger,
  }));

  await maybePromptSkillTrigger('install', groups, context);

  const usedPrompt =
    missingPlugins ||
    forcePrompt ||
    platformResolution.prompted ||
    groups.some((group) => group.options.requestedSkillTrigger !== options.requestedSkillTrigger);

  return usedPrompt ? { groups } : null;
}

async function resolveInteractiveScope(options: {
  requestedScope: Scope;
  context: CommandExecutionContext;
  forcePrompt: boolean;
  missingPlugins: boolean;
}): Promise<{
  scope: Scope;
  prompted: boolean;
}> {
  let prompted = false;
  const scope = (options.forcePrompt || options.missingPlugins) && options.context.interactive
    ? await promptScope(options.context, options.requestedScope)
    : options.requestedScope;
  prompted ||= scope !== options.requestedScope;

  return {
    scope,
    prompted,
  };
}

function resolveExistingPromptablePlatforms(options: {
  candidates: CommandCandidate[];
  scope: Scope;
  nativeAvailablePlatforms: PlatformName[];
}): PlatformName[] {
  const nativeAvailable = new Set(options.nativeAvailablePlatforms);
  const byPlatform = new Map<PlatformName, CommandCandidate[]>();
  for (const candidate of options.candidates) {
    const list = byPlatform.get(candidate.platform) ?? [];
    list.push(candidate);
    byPlatform.set(candidate.platform, list);
  }

  return (['codex', 'claude'] as const).filter((platform) => {
    const platformCandidates = byPlatform.get(platform) ?? [];
    if (platformCandidates.length === 0) {
      return false;
    }
    if (nativeAvailable.has(platform)) {
      return true;
    }

    return platform === 'codex' &&
      options.scope === 'project' &&
      platformCandidates.some((candidate) =>
        candidateHasActionableEvidence(candidate) || candidate.evidence.readErrors.length > 0,
      );
  });
}

async function resolveInteractiveExistingPlatform(options: {
  scope: Scope;
  requestedPlatform: PlatformSelection;
  context: CommandExecutionContext;
  cwd: string;
  forcePrompt: boolean;
  missingPlugins: boolean;
  candidates: CommandCandidate[];
  prompted: boolean;
}): Promise<{
  platformFilter?: PlatformName | 'both';
  prompted: boolean;
}> {
  const nativeAvailablePlatforms = await detectAvailablePlatforms(options.cwd, options.context.env);
  const promptablePlatforms = resolveExistingPromptablePlatforms({
    candidates: options.candidates,
    scope: options.scope,
    nativeAvailablePlatforms,
  });

  const currentScopeEvidenceCandidates = options.candidates.filter((candidate) =>
    candidateHasActionableEvidence(candidate) || candidate.evidence.readErrors.length > 0,
  );
  const evidencePlatforms = [...new Set(
    currentScopeEvidenceCandidates
      .map((candidate) => candidate.platform)
      .filter((platform) => promptablePlatforms.includes(platform)),
  )] as PlatformName[];
  const hasEvidenceUnknown = currentScopeEvidenceCandidates.some((candidate) =>
    candidate.evidence.readErrors.length > 0 && promptablePlatforms.includes(candidate.platform),
  );

  if (options.requestedPlatform !== 'auto') {
    if (options.forcePrompt && options.context.interactive) {
      const availableChoices = promptablePlatforms.length > 0
        ? promptablePlatforms
        : nativeAvailablePlatforms.length > 0
          ? nativeAvailablePlatforms
          : INTERACTIVE_PLATFORMS;
      const choices = platformChoices(availableChoices);
      const selected = await promptPlatform(
        options.context,
        choices,
        options.requestedPlatform === 'both' && choices.includes('both')
          ? 'both'
          : choices.includes(options.requestedPlatform)
            ? options.requestedPlatform
            : choices[0],
      );
      return {
        platformFilter: selected,
        prompted: true,
      };
    }

    return {
      platformFilter: options.requestedPlatform as PlatformName | 'both',
      prompted: options.prompted,
    };
  }

  if (options.scope === 'project' && evidencePlatforms.length > 0) {
    if (hasEvidenceUnknown) {
      throw new Error(
        '当前 scope 至少一个平台的受管安装证据读取结果为 unknown，`--platform auto` 无法安全推断，请显式传入 `--platform codex|claude|both`。',
      );
    }
    if (evidencePlatforms.length > 1) {
      throw new Error(
        '当前 scope 同时存在 Claude Code 和 Codex 的受管安装证据，`--platform auto` 无法安全推断，请显式传入 `--platform codex|claude|both`。',
      );
    }
  }

  const impliedPlatform = evidencePlatforms.length === 1 ? evidencePlatforms[0] : undefined;
  if (!options.context.interactive) {
    return {
      platformFilter: impliedPlatform,
      prompted: options.prompted,
    };
  }

  const availableChoices = impliedPlatform
    ? [impliedPlatform]
    : promptablePlatforms.length > 0
      ? promptablePlatforms
      : nativeAvailablePlatforms;
  if (!options.forcePrompt && !options.missingPlugins && availableChoices.length <= 1) {
    return {
      platformFilter: impliedPlatform,
      prompted: options.prompted,
    };
  }

  const choices = platformChoices(availableChoices.length > 0 ? availableChoices : ['codex', 'claude']);
  const selected = await promptPlatform(
    options.context,
    choices,
    choices.includes('both') ? 'both' : choices[0],
  );
  return {
    platformFilter: selected,
    prompted: true,
  };
}

async function buildInteractiveExistingCandidates(options: {
  command: 'uninstall' | 'upgrade';
  cwd: string;
  scope: Scope;
  platformFilter?: PlatformName | 'both';
  pluginNames?: string[];
  env: NodeJS.ProcessEnv;
}): Promise<CommandCandidate[]> {
  return buildCommandCandidates({
    command: options.command,
    cwd: options.cwd,
    scopeFilter: options.scope,
    platformFilter: options.platformFilter,
    pluginNames: options.pluginNames,
    env: options.env,
  });
}

export async function createInteractiveUninstallPlan(
  pluginNames: string[],
  options: CommandOptions,
  context: CommandExecutionContext,
  forcePrompt: boolean,
): Promise<InteractiveUninstallPlan | null> {
  assertInteractiveAvailable(forcePrompt, context);

  const missingPlugins = pluginNames.length === 0;
  if (missingPlugins && !context.interactive) {
    return null;
  }
  if (!missingPlugins && !forcePrompt && options.platform !== 'auto') {
    return null;
  }

  const scopeResolution = await resolveInteractiveScope({
    requestedScope: options.scope,
    context,
    forcePrompt,
    missingPlugins,
  });
  const candidatePool = await buildInteractiveExistingCandidates({
    command: 'uninstall',
    cwd: options.cwd,
    scope: scopeResolution.scope,
    pluginNames: missingPlugins || forcePrompt ? (missingPlugins ? undefined : pluginNames) : pluginNames,
    env: context.env,
  });
  const platformResolution = await resolveInteractiveExistingPlatform({
    scope: scopeResolution.scope,
    requestedPlatform: options.platform,
    context,
    cwd: options.cwd,
    forcePrompt,
    missingPlugins,
    candidates: candidatePool,
    prompted: scopeResolution.prompted,
  });
  const candidates = filterCandidatesByPlatform(
    candidatePool,
    platformResolution.platformFilter,
  );

  const selectedCandidates = (missingPlugins || forcePrompt)
    ? await promptPlugins(context, 'uninstall', candidates, {
        defaultValues: pluginNames.length > 0
          ? candidates
              .filter((candidate) => pluginNames.includes(candidate.pluginName))
              .map((candidate) => candidate.id)
          : undefined,
        allowMultiple: true,
      })
    : candidates.filter((candidate) => pluginNames.includes(candidate.pluginName));

  const groups = groupCandidates(selectedCandidates, (candidate): CommandOptions => ({
    cwd: candidate.executionCwd,
    platform: candidate.platform,
    scope: candidate.scope,
  }));

  return missingPlugins || forcePrompt || platformResolution.prompted ? { groups } : null;
}

export async function createInteractiveUpgradePlan(
  pluginNames: string[],
  options: UpgradeCommandOptions,
  context: CommandExecutionContext,
  forcePrompt: boolean,
): Promise<InteractiveUpgradePlan | null> {
  if (options.all) {
    return null;
  }
  assertInteractiveAvailable(forcePrompt, context);

  const missingPlugins = pluginNames.length === 0;
  if (missingPlugins && !context.interactive) {
    return null;
  }
  if (!missingPlugins && !forcePrompt && options.platform !== 'auto' && !context.interactive) {
    return null;
  }

  const scopeResolution = await resolveInteractiveScope({
    requestedScope: options.scope,
    context,
    forcePrompt,
    missingPlugins,
  });
  const candidatePool = await buildInteractiveExistingCandidates({
    command: 'upgrade',
    cwd: options.cwd,
    scope: scopeResolution.scope,
    pluginNames: missingPlugins || forcePrompt ? (missingPlugins ? undefined : pluginNames) : pluginNames,
    env: context.env,
  });
  const platformResolution = await resolveInteractiveExistingPlatform({
    scope: scopeResolution.scope,
    requestedPlatform: options.platform,
    context,
    cwd: options.cwd,
    forcePrompt,
    missingPlugins,
    candidates: candidatePool,
    prompted: scopeResolution.prompted,
  });
  const candidates = filterCandidatesByPlatform(
    candidatePool,
    platformResolution.platformFilter,
  );

  if (missingPlugins) {
    const selectable = candidates.filter((candidate) => candidate.selectable);
    const canUpgradeAll = selectable.length > 0 && selectable.length === candidates.length;
    const mode = await context.prompt.selectUpgradeMode?.({
      canUpgradeAll,
      candidates,
    });
    if (mode !== 'all' && mode !== 'select') {
      throw new Error(`无效升级方式选择：${String(mode)}`);
    }
    if (mode === 'all') {
      if (!canUpgradeAll) {
        throw new Error('当前存在需要显式处理的插件，不能使用全部升级。');
      }
      return {
        groups: [{
          pluginNames: [],
          options: {
            cwd: options.cwd,
            platform: platformResolution.platformFilter ?? 'auto',
            scope: scopeResolution.scope,
            all: true,
            requestedSkillTrigger: options.requestedSkillTrigger,
          },
          candidates,
        }],
      };
    }
  }

  const selectedCandidates = (missingPlugins || forcePrompt)
    ? await promptPlugins(context, 'upgrade', candidates, {
        defaultValues: pluginNames.length > 0
          ? candidates
              .filter((candidate) => pluginNames.includes(candidate.pluginName))
              .map((candidate) => candidate.id)
          : undefined,
        allowMultiple: true,
      })
    : candidates.filter((candidate) => pluginNames.includes(candidate.pluginName));

  const groups = groupCandidates(selectedCandidates, (candidate): UpgradeCommandOptions => ({
    cwd: candidate.executionCwd,
    platform: candidate.platform,
    scope: candidate.scope,
    all: false,
    requestedSkillTrigger: options.requestedSkillTrigger,
  }));

  await maybePromptSkillTrigger('upgrade', groups, context);

  const usedPrompt =
    missingPlugins ||
    forcePrompt ||
    platformResolution.prompted ||
    groups.some((group) => group.options.requestedSkillTrigger !== options.requestedSkillTrigger);

  return usedPrompt ? { groups } : null;
}
