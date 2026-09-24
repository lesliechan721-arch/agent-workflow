import type { TuiController, TuiControllerSnapshot } from './controller.js';
import { hasInstalledPlacement } from './model.js';
import type { TuiRoute } from './router.js';

export const TUI_SCREEN_IDS = [
  'G01', 'G02', 'G03', 'G04', 'G05', 'G06',
  'P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10',
  'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P21', 'P22',
  'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10',
  'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17', 'C18', 'C19', 'C20',
  'C21', 'C22', 'C23',
  'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09',
  'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'S17', 'S18',
  'I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08', 'I09',
  'I10', 'I11', 'I12', 'I13',
  'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09',
  'D10', 'D11', 'D12', 'D13', 'D14', 'D15', 'D16', 'D17',
  'D18', 'D19', 'D20',
  'U01', 'U02', 'U03', 'U04', 'U05', 'U06', 'U07', 'U08', 'U09', 'U10', 'U11', 'U22',
  'K02',
  'B01', 'B02', 'B06', 'B07',
  'T01', 'T02', 'T03', 'T04', 'T05',
  'L01', 'L02', 'L03', 'L04', 'L05', 'L06',
] as const;

export type TuiScreenId = typeof TUI_SCREEN_IDS[number];
export type TuiRouteName = TuiRoute['name'];
export type TuiRouteEntity = 'none' | 'plugin' | 'source' | 'issue' | 'historyRecord' | 'activeOperation';
export type TuiRendererFamily =
  | 'home' | 'pluginList' | 'batch' | 'plugin' | 'portable' | 'dependency'
  | 'config' | 'source' | 'issue' | 'operation' | 'history' | 'task';
export type TuiRouteKeymap = 'menu' | 'menuOrTextInput';

export interface RouteEntityState {
  hasPlugin(pluginId: string): boolean;
  hasSource(sourceId: string): boolean;
  hasIssue(issueId: string): boolean;
  hasHistoryRecord(recordId: string): boolean;
  hasActiveOperation(route: Extract<TuiRoute, {
    name: 'reviewPreparing' | 'review' | 'progress' | 'result';
  }>): boolean;
}

export interface RouteScreenContext {
  snapshot: TuiControllerSnapshot;
  controller: TuiController;
  searchMode?: boolean;
}

type NamedRoute<Name extends TuiRouteName> = Extract<TuiRoute, { name: Name }>;

export interface ScreenDefinition<Name extends TuiRouteName = TuiRouteName> {
  entity: TuiRouteEntity;
  rendererFamily: TuiRendererFamily;
  keymap: TuiRouteKeymap;
  normalize(route: NamedRoute<Name>, state: RouteEntityState): TuiRoute;
  screenId(route: NamedRoute<Name>, context: RouteScreenContext): TuiScreenId;
}

type ScreenDefinitionRegistry = {
  [Name in TuiRouteName]: ScreenDefinition<Name>;
};

const keep = <Name extends TuiRouteName>(route: NamedRoute<Name>): TuiRoute => route;
const plugin = <Name extends TuiRouteName>(route: NamedRoute<Name>, state: RouteEntityState): TuiRoute =>
  'pluginId' in route && state.hasPlugin(route.pluginId)
    ? route
    : { name: 'pluginList', mode: route.name === 'pluginPreview'
      || route.name === 'pluginDependencies' || route.name === 'installPlacement'
      || route.name === 'installTargets' || route.name === 'dependencyPlacement'
      || route.name === 'uninstallTargets'
      || route.name === 'dependencyPlacementEditor' ? 'browse' : 'installed' };
const pluginDetail = (route: NamedRoute<'pluginPreview'>, state: RouteEntityState): TuiRoute =>
  state.hasPlugin(route.pluginId)
    ? { name: 'pluginDetail', pluginId: route.pluginId }
    : { name: 'pluginList', mode: 'browse' };
type SourceRoute = Extract<TuiRoute, { sourceId: string }>;
const source = (route: SourceRoute, state: RouteEntityState): TuiRoute =>
  state.hasSource(route.sourceId) ? route : { name: 'sourceList' };
const issue = (route: NamedRoute<'issueDetail'>, state: RouteEntityState): TuiRoute =>
  state.hasIssue(route.issueId) ? route : { name: 'issueList' };
const activeOperation = <Name extends 'reviewPreparing' | 'review' | 'progress' | 'result'>(
  route: NamedRoute<Name>,
  state: RouteEntityState,
): TuiRoute => state.hasActiveOperation(route) ? route : { name: 'operationHistory' };

const fixed = <Name extends TuiRouteName>(id: TuiScreenId) =>
  (_route: NamedRoute<Name>, _context: RouteScreenContext): TuiScreenId => id;

function reviewScreen(context: RouteScreenContext): TuiScreenId {
  const review = context.snapshot.activeReview;
  if (review?.operationKind === 'catalogStorePrune') return 'L03';
  if (review?.operationKind === 'pluginWriteTask') return 'T02';
  if (review?.originIssue) return 'I10';
  const dependencyOperation = review?.operationKind === 'pluginWrite'
    && review.changes.some((change) => change.relation === 'direct'
      || change.relation === 'transitive' || change.group === 'dependencies');
  if (dependencyOperation) {
    return review.pluginAction === 'uninstall' || review.pluginAction === 'cleanup' ? 'D11' : 'D05';
  }
  if ((review?.operationKind === 'sourceMutation' || review?.operationKind === 'catalogGeneration')
    && review.sourceAction) {
    return ({ add: 'S10', update: 'S15', setPrimary: 'S16', remove: 'S18' } as const)[review.sourceAction];
  }
  return review?.operationKind === 'portableInstall' ? 'U06'
    : review?.operationKind === 'configSave' || review?.operationKind === 'configSaveBatch' ? 'C10'
    : review?.operationKind === 'configReset' ? 'C22'
    : review?.operationKind === 'pluginWrite'
      && (review.pluginAction === 'refreshAndSync' || review.pluginAction === 'reinstall') ? 'P18'
    : review?.operationKind === 'pluginWrite'
      && (review.pluginAction === 'uninstall' || review.pluginAction === 'cleanup') ? 'P19' : 'P07';
}

function progressScreen(context: RouteScreenContext): TuiScreenId {
  const review = context.snapshot.activeReview;
  if (review?.operationKind === 'catalogStorePrune') return 'L05';
  if (review?.operationKind === 'pluginWriteTask') return 'T03';
  if (context.snapshot.progressTargets.length > 0) return 'D06';
  if (review?.originIssue) return 'I11';
  if (review?.operationKind === 'sourceMutation' || review?.operationKind === 'catalogGeneration'
    || review?.operationKind === 'catalogSourcesRecovery') return 'S11';
  return review?.operationKind === 'portableInstall' ? 'U07'
    : review?.operationKind === 'configSave' || review?.operationKind === 'configSaveBatch'
      || review?.operationKind === 'configReset' ? 'C11' : 'P08';
}

function resultScreen(context: RouteScreenContext): TuiScreenId {
  const result = context.snapshot.result;
  if (result?.operationKind === 'catalogStorePrune') {
    return result.state === 'succeeded' ? 'L05' : 'L06';
  }
  if (result?.operationKind === 'pluginWriteTask') {
    return result.state === 'succeeded' ? 'T04' : 'T05';
  }
  if (result) {
    const dependencyTargets = result.state === 'succeeded' || result.state === 'partial'
      ? result.summary.targets
      : result.state === 'blocked' && result.code === 'operationFailed' ? result.summary?.targets : undefined;
    if (dependencyTargets?.some((target) => target.relation !== undefined && target.relation !== 'requested')) {
      return result.state === 'succeeded' ? 'D07' : 'D08';
    }
    if (result.originIssue) return result.state === 'succeeded' ? 'I12' : 'I13';
    if ('operationKind' in result && (result.operationKind === 'sourceMutation'
      || result.operationKind === 'catalogGeneration' || result.operationKind === 'catalogSourcesRecovery')) {
      return result.state === 'succeeded' ? 'S12' : 'S13';
    }
  }
  return result?.operationKind === 'portableInstall' ? 'U08'
    : result?.operationKind === 'configSaveBatch'
      ? result.state === 'succeeded' ? 'C12' : 'C13'
    : result?.operationKind === 'configSave'
      ? result.state === 'succeeded' ? 'C12' : 'C13'
    : result?.operationKind === 'configReset'
      ? 'C23'
      : result?.state === 'partial' ? 'P10' : 'P09';
}

export const TUI_ROUTE_DEFINITIONS = {
  home: { entity: 'none', rendererFamily: 'home', keymap: 'menu', normalize: keep, screenId: fixed('G02') },
  projectStatus: { entity: 'none', rendererFamily: 'home', keymap: 'menu', normalize: keep,
    screenId: (_route, { snapshot }) => snapshot.projectIntentIssue
      || (snapshot.projectIntentReminder?.actionableTargets.length ?? 0) === 0
        && (snapshot.projectIntentReminder?.blockedTargets.length ?? 0) === 0
      ? 'G06'
      : (snapshot.projectIntentReminder?.blockedTargets.length ?? 0) > 0 ? 'T02' : 'T01' },
  pluginList: { entity: 'source', rendererFamily: 'pluginList', keymap: 'menuOrTextInput', normalize: (route, state) =>
    route.sourceId && !state.hasSource(route.sourceId) ? { name: 'pluginList', mode: route.mode } : route,
  screenId: (route, { controller, searchMode }) => {
    const items = controller.listPlugins({
      mode: route.mode,
      sourceId: route.sourceId,
      installFilter: route.mode === 'installed' ? 'installed' : 'all',
    });
    if (route.mode === 'installed' && items.length === 0) return 'P12';
    if (route.sourceId && controller.getSourceOverview(route.sourceId).health?.state === 'unavailable') return 'P03';
    return route.mode === 'installed' ? 'P11' : searchMode ? 'P02' : 'P01';
  } },
  pluginWriteTask: { entity: 'plugin', rendererFamily: 'task', keymap: 'menu', normalize: plugin, screenId: fixed('T01') },
  batchSelection: { entity: 'none', rendererFamily: 'batch', keymap: 'menuOrTextInput', normalize: keep, screenId: fixed('B01') },
  batchInstallPlatforms: { entity: 'none', rendererFamily: 'batch', keymap: 'menu', normalize: keep, screenId: fixed('B06') },
  batchInstallScope: { entity: 'none', rendererFamily: 'batch', keymap: 'menu', normalize: keep, screenId: fixed('B07') },
  batchPlacement: { entity: 'none', rendererFamily: 'batch', keymap: 'menu', normalize: keep, screenId: fixed('B02') },
  pluginPreview: { entity: 'plugin', rendererFamily: 'plugin', keymap: 'menu', normalize: pluginDetail, screenId: (route, { controller }) =>
    controller.getPluginOverview(route.pluginId)?.dependencySummary?.totalCount ? 'D01' : 'P04' },
  portablePreparing: { entity: 'plugin', rendererFamily: 'portable', keymap: 'menu', normalize: plugin, screenId: fixed('U22') },
  portableSkillSelect: { entity: 'plugin', rendererFamily: 'portable', keymap: 'menu', normalize: plugin, screenId: fixed('U01') },
  portableDependencies: { entity: 'plugin', rendererFamily: 'portable', keymap: 'menu', normalize: plugin, screenId: fixed('U02') },
  portableAgentMode: { entity: 'plugin', rendererFamily: 'portable', keymap: 'menu', normalize: plugin, screenId: fixed('U03') },
  portableAgentInput: { entity: 'plugin', rendererFamily: 'portable', keymap: 'menuOrTextInput', normalize: plugin, screenId: fixed('U04') },
  portableScope: { entity: 'plugin', rendererFamily: 'portable', keymap: 'menu', normalize: plugin, screenId: fixed('U05') },
  portableBlocker: { entity: 'plugin', rendererFamily: 'portable', keymap: 'menu', normalize: plugin, screenId: (route) =>
    route.code === 'requiredConfigMissing' ? 'U09'
      : route.code === 'portableSkillsCliMissing' || route.code === 'portableSkillsCliIncompatible' ? 'U10' : 'U11' },
  pluginDependencies: { entity: 'plugin', rendererFamily: 'dependency', keymap: 'menu', normalize: plugin, screenId: (route, { controller }) => {
    if (route.view === 'removeBlocked') return 'D12';
    const item = controller.getPluginOverview(route.pluginId);
    return item && hasInstalledPlacement(item) ? 'D10' : 'D02';
  } },
  pluginDependencyNode: { entity: 'plugin', rendererFamily: 'dependency', keymap: 'menu', normalize: (route, state) =>
    state.hasPlugin(route.pluginId) && state.hasPlugin(route.nodePluginId)
      ? route
      : state.hasPlugin(route.pluginId)
        ? { name: 'pluginDependencies', pluginId: route.pluginId, direction: route.direction }
        : { name: 'pluginList', mode: 'installed' }, screenId: fixed('D10') },
  installPlacement: { entity: 'plugin', rendererFamily: 'plugin', keymap: 'menu', normalize: plugin, screenId: (route, { controller }) =>
    controller.getPluginOverview(route.pluginId)?.dependencySummary?.totalCount ? 'D03' : 'P05' },
  installTargets: { entity: 'plugin', rendererFamily: 'plugin', keymap: 'menu', normalize: plugin, screenId: (route, { controller }) =>
    route.view === 'blocked' ? 'D16'
      : controller.getPluginOverview(route.pluginId)?.dependencySummary?.totalCount ? 'D04' : 'P06' },
  uninstallTargets: { entity: 'plugin', rendererFamily: 'plugin', keymap: 'menu', normalize: plugin, screenId: fixed('P19') },
  dependencyPlacement: { entity: 'plugin', rendererFamily: 'dependency', keymap: 'menu', normalize: plugin, screenId: fixed('D03') },
  dependencyPlacementEditor: { entity: 'plugin', rendererFamily: 'dependency', keymap: 'menu', normalize: (route, state) =>
    state.hasPlugin(route.pluginId) && state.hasPlugin(route.dependencyPluginId)
      ? route : { name: 'pluginList', mode: 'browse' }, screenId: fixed('D04') },
  pluginDetail: { entity: 'plugin', rendererFamily: 'plugin', keymap: 'menu', normalize: plugin, screenId: (route, { controller }) =>
    controller.getPluginOverview(route.pluginId)?.dependencySummary?.totalCount ? 'D09' : 'P13' },
  pluginContent: { entity: 'plugin', rendererFamily: 'plugin', keymap: 'menu', normalize: plugin, screenId: fixed('P04') },
  pluginMore: { entity: 'plugin', rendererFamily: 'plugin', keymap: 'menu', normalize: plugin, screenId: fixed('P22') },
  platform: { entity: 'plugin', rendererFamily: 'plugin', keymap: 'menu', normalize: plugin, screenId: (route, { controller }) => {
    const item = controller.getPluginOverview(route.pluginId);
    if (item?.aggregateStatus === 'unavailable') return 'P17';
    const placement = controller.getPlatformPlacement(route.pluginId, route.platform);
    return !placement || placement.state === 'notInstalled' ? 'P15'
      : placement.state === 'installed' && placement.health === 'ready' ? 'P14' : 'P16';
  } },
  pluginTechnical: { entity: 'plugin', rendererFamily: 'plugin', keymap: 'menu', normalize: plugin, screenId: fixed('P21') },
  configLayer: { entity: 'plugin', rendererFamily: 'config', keymap: 'menu', normalize: plugin, screenId: fixed('C07') },
  configFields: { entity: 'plugin', rendererFamily: 'config', keymap: 'menu', normalize: plugin, screenId: fixed('C01') },
  configFieldEditor: { entity: 'plugin', rendererFamily: 'config', keymap: 'menuOrTextInput', normalize: plugin, screenId: (route) =>
    route.mode === 'choices' ? 'C03' : ({ boolean: 'C15', number: 'C04', string: 'C06', object: 'C20', array: 'C20' } as const)[route.editor] },
  configObjectPropertyEditor: { entity: 'plugin', rendererFamily: 'config', keymap: 'menuOrTextInput', normalize: plugin, screenId: fixed('C20') },
  configFieldAction: { entity: 'plugin', rendererFamily: 'config', keymap: 'menu', normalize: plugin, screenId: fixed('C03') },
  configUnavailable: { entity: 'plugin', rendererFamily: 'config', keymap: 'menu', normalize: plugin, screenId: fixed('C21') },
  sourceList: { entity: 'none', rendererFamily: 'source', keymap: 'menu', normalize: keep, screenId: fixed('S01') },
  sourceDetail: { entity: 'source', rendererFamily: 'source', keymap: 'menu', normalize: source, screenId: fixed('K02') },
  sourceMore: { entity: 'source', rendererFamily: 'source', keymap: 'menu', normalize: source, screenId: fixed('S02') },
  sourceTechnical: { entity: 'source', rendererFamily: 'source', keymap: 'menu', normalize: source, screenId: fixed('S03') },
  sourceAdd: { entity: 'none', rendererFamily: 'source', keymap: 'menuOrTextInput', normalize: keep, screenId: (route) =>
    ({ type: 'S04', id: 'S05', location: 'S06', refPolicy: 'S07', ref: 'S08', subdir: 'S09' } as const)[route.step] },
  sourceEdit: { entity: 'source', rendererFamily: 'source', keymap: 'menuOrTextInput', normalize: source, screenId: fixed('S14') },
  sourceSave: { entity: 'none', rendererFamily: 'source', keymap: 'menu', normalize: keep, screenId: fixed('S15') },
  configSave: { entity: 'plugin', rendererFamily: 'config', keymap: 'menu', normalize: plugin, screenId: (route) =>
    route.view === 'changes' ? 'C10' : 'C09' },
  scriptTimeout: { entity: 'none', rendererFamily: 'operation', keymap: 'menuOrTextInput', normalize: keep, screenId: fixed('P07') },
  sourceRemoveBlocked: { entity: 'source', rendererFamily: 'source', keymap: 'menu', normalize: source, screenId: fixed('S17') },
  catalogStoreOverview: { entity: 'none', rendererFamily: 'source', keymap: 'menu', normalize: keep, screenId: fixed('L01') },
  catalogStoreRules: { entity: 'none', rendererFamily: 'source', keymap: 'menu', normalize: keep, screenId: fixed('L02') },
  issueList: { entity: 'none', rendererFamily: 'issue', keymap: 'menu', normalize: keep, screenId: (_route, { controller }) => {
    const issues = controller.listUserIssues();
    return issues.length === 0 ? 'I02' : issues.some((entry) => entry.category.startsWith('dependency')) ? 'D13' : 'I01';
  } },
  issueDetail: { entity: 'issue', rendererFamily: 'issue', keymap: 'menu', normalize: issue, screenId: (route, { controller }) => {
    const category = controller.listUserIssues().find((entry) => entry.issueId === route.issueId)?.category ?? 'diagnostic';
    return ({ incompleteInstallation: 'I03', artifactCollision: 'I09', sourceUnavailable: 'I04', sourceMissing: 'I05',
      sourceIdentityChanged: 'I06', requiredConfigMissing: 'I07', configLayerUnsupported: 'I07', scopeConflict: 'I08',
      dependencyMissing: 'D14', dependencyNotReady: 'D15', dependencyTargetUnsupported: 'D16',
      dependencyStillRequired: 'D12', dependencyGraphInvalid: 'D17', legacyState: 'I09', diagnostic: 'I09' } as const)[category] ?? 'I09';
  } },
  operationHistory: { entity: 'none', rendererFamily: 'history', keymap: 'menu', normalize: keep, screenId: fixed('D18') },
  operationDiagnostic: { entity: 'historyRecord', rendererFamily: 'history', keymap: 'menu', normalize: keep, screenId: fixed('D19') },
  operationReportPreview: { entity: 'historyRecord', rendererFamily: 'history', keymap: 'menu', normalize: keep, screenId: fixed('D20') },
  reviewPreparing: { entity: 'activeOperation', rendererFamily: 'operation', keymap: 'menu', normalize: activeOperation, screenId: fixed('P07') },
  review: { entity: 'activeOperation', rendererFamily: 'operation', keymap: 'menu', normalize: activeOperation, screenId: (_route, context) => reviewScreen(context) },
  progress: { entity: 'activeOperation', rendererFamily: 'operation', keymap: 'menu', normalize: activeOperation, screenId: (_route, context) => progressScreen(context) },
  result: { entity: 'activeOperation', rendererFamily: 'operation', keymap: 'menu', normalize: activeOperation, screenId: (_route, context) => resultScreen(context) },
} satisfies ScreenDefinitionRegistry;

export function routeDefinition<Name extends TuiRouteName>(
  route: NamedRoute<Name>,
): ScreenDefinition<Name> {
  return TUI_ROUTE_DEFINITIONS[route.name] as ScreenDefinition<Name>;
}

export function normalizeTuiRoute(route: TuiRoute, state: RouteEntityState): TuiRoute {
  const definition = routeDefinition(route);
  return definition.normalize(route, state);
}

export function routeSupportsCharacterInput(route: TuiRoute): boolean {
  return routeDefinition(route).keymap === 'menuOrTextInput';
}

export function unreachableTuiRoute(route: never): never {
  throw new Error(`Unhandled TUI route: ${JSON.stringify(route)}`);
}

export function resolveRouteScreenId(route: TuiRoute, context: RouteScreenContext): TuiScreenId {
  const definition = routeDefinition(route);
  return definition.screenId(route, context);
}
