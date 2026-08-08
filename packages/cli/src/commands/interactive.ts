import fs from 'fs-extra';

import type {
  CommandOptions,
  InstallCommandOptions,
  PlatformName,
  PlatformSelection,
  Scope,
  UpgradeCommandOptions,
} from '../types.js';
import { detectEnvironment, listDetectedPlatforms } from '../utils/detect.js';
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
import {
  listExecutablePlatformsForNativeAndCodexProject,
} from './platform-resolution.js';
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
type InteractivePlatformChoice = PlatformSelection;

interface InteractiveInstallScopeEvaluation {
  scope: Scope;
  targets: ResolvedPluginTarget[];
  availablePlatforms: PlatformName[];
  singlePlatformChoices: PlatformName[];
  allPlatformChoice: boolean;
}

const PLATFORM_DISPLAY: Record<PlatformName, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
};

function assertInteractivePlatformSelection(
  selection: unknown,
): asserts selection is PlatformSelection {
  if (selection === 'codex' || selection === 'claude' || selection === 'both') {
    return;
  }

  throw new Error(
    `Unsupported platform "${String(selection)}". Expected one of: codex, claude, both.`,
  );
}

function platformSelectionToPlatforms(selection: PlatformSelection): PlatformName[] {
  assertInteractivePlatformSelection(selection);
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
  const nativeAvailablePlatforms = await detectAvailablePlatforms(options.cwd, options.env);
  const availablePlatforms = new Set(
    listExecutablePlatformsForNativeAndCodexProject({
      nativeAvailablePlatforms,
      codexProjectExecutableWithoutNative: false,
    }),
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

async function evaluateInteractiveInstallScope(options: {
  cwd: string;
  scope: Scope;
  pluginNames: string[];
  env: NodeJS.ProcessEnv;
}): Promise<InteractiveInstallScopeEvaluation> {
  const targets = await loadPluginTargetsForCommand(options.cwd, options.scope, options.pluginNames, {
    allowHistoricalFallback: false,
    env: options.env,
  });
  const availablePlatforms = await resolveInstallPromptPlatforms({
    cwd: options.cwd,
    scope: options.scope,
    targets,
    env: options.env,
  });
  const installablePlatformsByTarget = targets.map((target) =>
    availablePlatforms.filter((platform) => {
      if (!pluginSupportsPlatform(target.plugin, platform)) {
        return false;
      }
      if (platform === 'codex' && options.scope === 'project') {
        return getCodexProjectInstallability(target.plugin).installable;
      }
      return true;
    }),
  );

  return {
    scope: options.scope,
    targets,
    availablePlatforms,
    singlePlatformChoices: availablePlatforms.filter((platform) =>
      installablePlatformsByTarget.every((supportedPlatforms) => supportedPlatforms.includes(platform)),
    ),
    allPlatformChoice: installablePlatformsByTarget.every((supportedPlatforms) => supportedPlatforms.length > 0),
  };
}

async function loadInteractiveInstallScopeEvaluations(options: {
  cwd: string;
  pluginNames: string[];
  env: NodeJS.ProcessEnv;
}): Promise<InteractiveInstallScopeEvaluation[]> {
  return Promise.all((['user', 'project'] as const).map((scope) =>
    evaluateInteractiveInstallScope({
      cwd: options.cwd,
      scope,
      pluginNames: options.pluginNames,
      env: options.env,
    }),
  ));
}

function buildInteractiveInstallPlatformChoices(
  evaluations: InteractiveInstallScopeEvaluation[],
): InteractivePlatformChoice[] {
  const singleChoices = new Set<PlatformName>();
  for (const evaluation of evaluations) {
    for (const platform of evaluation.singlePlatformChoices) {
      singleChoices.add(platform);
    }
  }

  const choices: InteractivePlatformChoice[] = INTERACTIVE_PLATFORMS.filter((platform) => singleChoices.has(platform));
  if (evaluations.some((evaluation) => evaluation.allPlatformChoice)) {
    choices.push('both');
  }
  return choices;
}

function interactiveInstallPlatformAvailableInScope(
  evaluation: InteractiveInstallScopeEvaluation,
  selection: InteractivePlatformChoice,
): boolean {
  return selection === 'both'
    ? evaluation.allPlatformChoice
    : evaluation.singlePlatformChoices.includes(selection);
}

function interactiveInstallPlatformFailureReason(
  selection: InteractivePlatformChoice,
  scope: Scope,
): string {
  const platformLabel = selection === 'both' ? '全部支持平台' : PLATFORM_DISPLAY[selection];
  return `${platformLabel} 在 ${scope} 不可用，请重新选择平台。`;
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
  message?: string,
): Promise<PlatformSelection> {
  if (available.length === 0) {
    throw new Error('当前没有可选择的平台。');
  }
  const selected = await context.prompt.selectPlatform?.({
    available,
    defaultValue,
    message,
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
  allowPartialPlatformCoverage?: boolean;
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
    const allowedPlatforms = (options.allowPartialPlatformCoverage
      ? perPlatformInstallable.filter((entry) => entry.installable)
      : perPlatformInstallable
    ).map((entry) => entry.platform);
    const wholeSelectionInstallable = options.allowPartialPlatformCoverage
      ? allowedPlatforms.length > 0
      : blocked === undefined;
    const wholeSelectionReason = options.targetPlatforms.length > 1 && blocked
      ? `选择 ${formatPlatformList(options.targetPlatforms)} 时，${blocked.reason}`
      : undefined;

    for (const platform of allowedPlatforms) {
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
  requestedPlatform: PlatformSelection,
  scope: Scope,
): void {
  if (requestedPlatform === 'both') {
    const unavailable = targets
      .filter((target) => {
        const supportedPlatforms = compatiblePlatformsForTarget(target)
          .filter((platform) =>
            !(platform === 'codex' && scope === 'project' && !getCodexProjectInstallability(target.plugin).installable),
          );
        return supportedPlatforms.length === 0;
      })
      .map((target) => target.pluginName);
    if (unavailable.length > 0) {
      throw new Error(`当前 scope 下没有可安装的平台：${unavailable.join('、')}。`);
    }
    return;
  }

  const requestedPlatforms = platformSelectionToPlatforms(requestedPlatform);
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
  assertInteractivePlatformSelection(options.requestedPlatform);
  const availablePlatforms = await resolveInstallPromptPlatforms({
    cwd: options.cwd,
    scope: options.scope,
    targets: options.targets,
    env: options.env,
  });
  if (availablePlatforms.length === 0) {
    throw new Error('当前环境没有检测到可用平台。');
  }

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
      platforms: platformSelectionToPlatforms(selected),
      prompted: true,
    };
  }

  return {
    platforms: platformSelectionToPlatforms(options.requestedPlatform),
    prompted: false,
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
    !context.interactive &&
    !needsCodexProjectValidation
  ) {
    return null;
  }

  let scope = options.scope;
  let selectedPlatform = options.platform;
  let targets = missingPlugins
    ? []
    : await loadPluginTargetsForCommand(options.cwd, scope, pluginNames, {
        allowHistoricalFallback: false,
        env: context.env,
      });
  let targetSelectionPrompted = false;

  if (!missingPlugins && !forcePrompt) {
    assertExplicitInstallCompatibility(targets, options.platform, scope);
    return null;
  }

  if (!missingPlugins && forcePrompt && context.interactive) {
    const evaluations = (await loadInteractiveInstallScopeEvaluations({
      cwd: options.cwd,
      pluginNames,
      env: context.env,
    })).filter((evaluation) => evaluation.allPlatformChoice);
    if (evaluations.length === 0) {
      throw new Error('这些插件没有共同可用的位置，请调整插件选择后重试。');
    }

    const platformChoices = buildInteractiveInstallPlatformChoices(evaluations);
    if (platformChoices.length === 0) {
      throw new Error('这些插件没有共同可用的平台，请调整插件选择后重试。');
    }

    const defaultPlatform =
      selectedPlatform === 'both' && platformChoices.includes('both')
        ? 'both'
        : platformChoices.find((platform) => platform === selectedPlatform) ?? platformChoices[0]!;
    let platformPromptMessage: string | undefined;
    let platformDefaultValue = defaultPlatform;

    while (true) {
      selectedPlatform = await promptPlatform(
        context,
        platformChoices,
        platformDefaultValue,
        platformPromptMessage,
      );
      targetSelectionPrompted = true;
      scope = await promptScope(context, scope);
      targetSelectionPrompted = true;

      const scopeEvaluation = evaluations.find((evaluation) => evaluation.scope === scope);
      if (!scopeEvaluation) {
        throw new Error(`当前选择的 scope ${scope} 不在可用范围内。`);
      }
      if (!interactiveInstallPlatformAvailableInScope(scopeEvaluation, selectedPlatform)) {
        platformPromptMessage = interactiveInstallPlatformFailureReason(selectedPlatform, scope);
        platformDefaultValue = selectedPlatform;
        continue;
      }

      targets = scopeEvaluation.targets;
      break;
    }
  } else {
    scope = (missingPlugins || forcePrompt) && context.interactive
      ? await promptScope(context, options.scope)
      : options.scope;

    targets = missingPlugins
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
    selectedPlatform = platformResolution.platforms.length === 2
      ? 'both'
      : platformResolution.platforms[0]!;
    targetSelectionPrompted = platformResolution.prompted || targetSelectionPrompted;
  }

  assertExplicitInstallCompatibility(targets, selectedPlatform, scope);

  const candidates = await buildInstallCandidates({
    cwd: options.cwd,
    scope,
    targetPlatforms: platformSelectionToPlatforms(selectedPlatform),
    pluginNames: missingPlugins || forcePrompt ? (missingPlugins ? undefined : pluginNames) : pluginNames,
    env: context.env,
    allowPartialPlatformCoverage: selectedPlatform === 'both',
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
  }));

  const usedPrompt =
    missingPlugins ||
    forcePrompt ||
    targetSelectionPrompted;

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
  assertInteractivePlatformSelection(options.requestedPlatform);
  const nativeAvailablePlatforms = await detectAvailablePlatforms(options.cwd, options.context.env);
  const promptablePlatforms = resolveExistingPromptablePlatforms({
    candidates: options.candidates,
    scope: options.scope,
    nativeAvailablePlatforms,
  });

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
    platformFilter: options.requestedPlatform,
    prompted: options.prompted,
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
  if (!missingPlugins && !forcePrompt) {
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
  if (!missingPlugins && !forcePrompt && !context.interactive) {
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
            platform: platformResolution.platformFilter ?? options.platform,
            scope: scopeResolution.scope,
            all: true,
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
  }));

  const usedPrompt =
    missingPlugins ||
    forcePrompt ||
    platformResolution.prompted;

  return usedPrompt ? { groups } : null;
}
