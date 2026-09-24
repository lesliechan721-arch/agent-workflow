import { describe, expect, it } from 'vitest';

import { TuiRouter, type TuiRoute } from '../../src/tui/router.js';
import {
  TUI_ROUTE_DEFINITIONS,
  TUI_SCREEN_IDS,
  normalizeTuiRoute,
  routeDefinition,
  routeSupportsCharacterInput,
  type RouteEntityState,
  type RouteScreenContext,
} from '../../src/tui/screen-registry.js';

function entities(overrides: Partial<RouteEntityState> = {}): RouteEntityState {
  return {
    hasPlugin: () => true,
    hasSource: () => true,
    hasIssue: () => true,
    hasHistoryRecord: () => true,
    hasActiveOperation: () => true,
    ...overrides,
  };
}

describe('TUI route registry', () => {
  it.each([
    [{ name: 'batchInstallPlatforms' } as const, 'B06'],
    [{ name: 'batchInstallScope' } as const, 'B07'],
  ])('registers batch install route %j as screen %s', (route, screenId) => {
    const definition = routeDefinition(route);

    expect(definition).toMatchObject({
      entity: 'none', rendererFamily: 'batch', keymap: 'menu',
    });
    expect(definition.screenId(route, {} as RouteScreenContext)).toBe(screenId);
  });

  it('registers Portable preparation as the U22 waiting state', () => {
    const route = { name: 'portablePreparing', pluginId: 'official/demo' } as const;
    const definition = routeDefinition(route);

    expect(definition).toMatchObject({
      entity: 'plugin', rendererFamily: 'portable', keymap: 'menu',
    });
    expect(definition.screenId(route, {} as RouteScreenContext)).toBe('U22');
  });

  it('defines production routing facts for every route family', () => {
    expect(routeDefinition({ name: 'home' })).toMatchObject({
      entity: 'none', rendererFamily: 'home', keymap: 'menu',
    });
    expect(routeDefinition({
      name: 'configObjectPropertyEditor', pluginId: 'official/demo', layer: { scope: 'user' },
      fieldKey: 'accounts', dynamic: true, stage: 'key',
    })).toMatchObject({ entity: 'plugin', rendererFamily: 'config', keymap: 'menuOrTextInput' });
    expect(routeDefinition({ name: 'operationDiagnostic', recordId: 'record-1' }))
      .toMatchObject({ entity: 'historyRecord', rendererFamily: 'history' });
    expect(TUI_ROUTE_DEFINITIONS.result.rendererFamily).toBe('operation');
    expect(routeDefinition({
      name: 'pluginWriteTask', pluginId: 'official/demo', goal: 'restore',
    })).toMatchObject({ entity: 'plugin', rendererFamily: 'task', keymap: 'menu' });
    expect(new Set(TUI_SCREEN_IDS).size).toBe(TUI_SCREEN_IDS.length);
    expect(TUI_SCREEN_IDS).toContain('C11');
    expect(routeSupportsCharacterInput({ name: 'pluginList', mode: 'browse' })).toBe(true);
    expect(routeSupportsCharacterInput({ name: 'home' })).toBe(false);
    const screenContext = {} as RouteScreenContext;
    expect(routeDefinition({ name: 'home' }).screenId({ name: 'home' }, screenContext)).toBe('G02');
    expect(routeDefinition({ name: 'sourceAdd', owner: 'draft', step: 'ref' }).screenId(
      { name: 'sourceAdd', owner: 'draft', step: 'ref' }, screenContext,
    )).toBe('S08');
  });

  it('normalizes every entity kind to its applicable list', () => {
    const missing = entities({
      hasPlugin: () => false,
      hasSource: () => false,
      hasIssue: () => false,
      hasHistoryRecord: () => false,
      hasActiveOperation: () => false,
    });
    const routes: Array<[TuiRoute, TuiRoute]> = [
      [{ name: 'pluginList', mode: 'browse', sourceId: 'gone' }, { name: 'pluginList', mode: 'browse' }],
      [{ name: 'configFieldAction', pluginId: 'gone', layer: { scope: 'user' }, fieldKey: 'mode' },
        { name: 'pluginList', mode: 'installed' }],
      [{ name: 'pluginWriteTask', pluginId: 'gone', goal: 'update' },
        { name: 'pluginList', mode: 'installed' }],
      [{ name: 'configSave', pluginId: 'gone', layer: { scope: 'project' } },
        { name: 'pluginList', mode: 'installed' }],
      [{ name: 'dependencyPlacementEditor', pluginId: 'gone', dependencyPluginId: 'dep',
        platform: 'codex' }, { name: 'pluginList', mode: 'browse' }],
      [{ name: 'sourceTechnical', sourceId: 'gone' }, { name: 'sourceList' }],
      [{ name: 'issueDetail', issueId: 'gone' }, { name: 'issueList' }],
      [{ name: 'operationDiagnostic', recordId: 'gone' }, { name: 'operationDiagnostic', recordId: 'gone' }],
      [{ name: 'operationReportPreview', recordId: 'gone' }, { name: 'operationReportPreview', recordId: 'gone' }],
      [{ name: 'review', operationId: 'gone' }, { name: 'operationHistory' }],
      [{ name: 'result', operationId: 'gone' }, { name: 'operationHistory' }],
    ];

    for (const [route, expected] of routes) {
      expect(normalizeTuiRoute(route, missing)).toEqual(expected);
    }
  });

  it('normalizes historical frames and flow return anchors while preserving input context', () => {
    const router = new TuiRouter();
    router.push({ name: 'pluginList', mode: 'browse', sourceId: 'gone' }, {
      query: 'draft', focusIndex: 3, scrollOffset: 1, sourceTabId: 'gone',
    });
    router.push({ name: 'pluginDetail', pluginId: 'gone' }, { focusedEntityId: 'gone' });
    router.beginFlow('configEdit', { name: 'configFieldAction', pluginId: 'gone',
      layer: { scope: 'user' }, fieldKey: 'mode' });
    router.push({ name: 'configSave', pluginId: 'gone', layer: { scope: 'user' } });

    router.normalizeRoutes((route) => normalizeTuiRoute(route, entities({
      hasPlugin: () => false,
      hasSource: () => false,
    })));

    expect(router.snapshot.current).toEqual({
      route: { name: 'pluginList', mode: 'installed' },
      context: { focusedEntityId: 'gone' },
    });
    expect(router.finishFlow()?.current).toEqual({
      route: { name: 'pluginList', mode: 'installed' },
      context: { focusedEntityId: 'gone' },
    });
    expect(router.back().current).toEqual({
      route: { name: 'pluginList', mode: 'browse' },
      context: { query: 'draft', focusIndex: 3, scrollOffset: 1, sourceTabId: 'gone' },
    });
  });

  it('keeps the origin input context behind a terminal result and removes the finished flow', () => {
    const router = new TuiRouter();
    router.push({ name: 'pluginList', mode: 'browse' }, { query: 'agent', focusIndex: 2 });
    router.push({ name: 'pluginDetail', pluginId: 'official/demo' }, { focusIndex: 1 });
    router.beginFlow('pluginMaintenance', { name: 'pluginDetail', pluginId: 'official/demo' });
    router.push({ name: 'review', operationId: 'operation-1' });

    expect(router.finishFlow(undefined, { name: 'result', operationId: 'operation-1' })).toMatchObject({
      current: { route: { name: 'result', operationId: 'operation-1' }, context: {} },
      depth: 4,
    });
    expect(router.activeFlow()).toBeUndefined();
    expect(router.back().current).toEqual({
      route: { name: 'pluginDetail', pluginId: 'official/demo' },
      context: { focusIndex: 1 },
    });
  });

  it('requires an exact unique frame when returning to a config overview', () => {
    const router = new TuiRouter();
    router.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    router.beginConfigFlow('official/demo');
    router.push({ name: 'configFields', pluginId: 'official/demo', layer: { scope: 'effective' } });
    const flowId = router.snapshot.currentFlowId!;
    const overviewFrameId = router.snapshot.currentFrameId;

    expect(router.configOverviewFrameId(flowId, 'official/demo')).toBe(overviewFrameId);
    router.push({ name: 'configFields', pluginId: 'official/demo', layer: { scope: 'user' } });
    const duplicateDepth = router.snapshot.depth;

    expect(router.configOverviewFrameId(flowId, 'official/demo')).toBeUndefined();
    expect(router.returnToConfigOverview(flowId, undefined, 'official/demo')).toBeUndefined();
    expect(router.snapshot.depth).toBe(duplicateDepth);
    expect(router.returnToConfigOverview(flowId, overviewFrameId, 'official/demo')?.current.route).toEqual({
      name: 'configFields', pluginId: 'official/demo', layer: { scope: 'effective' },
    });
  });

  it.each([
    [{ name: 'pluginList', mode: 'installed' } as const,
      { name: 'pluginDetail', pluginId: 'removed' } as const,
      entities({ hasPlugin: () => false })],
    [{ name: 'issueList' } as const,
      { name: 'issueDetail', issueId: 'removed' } as const,
      entities({ hasIssue: () => false })],
  ])('removes a normalized duplicate %j ancestor without an empty Back step', (list, detail, state) => {
    const router = new TuiRouter();
    router.push(list, { focusIndex: 4, scrollOffset: 2 });
    router.push(detail);

    router.normalizeRoutes((route) => normalizeTuiRoute(route, state));

    expect(router.snapshot).toMatchObject({
      depth: 2,
      current: { route: list, context: { focusIndex: 4, scrollOffset: 2 } },
    });
    expect(router.back().current.route).toEqual({ name: 'home' });
  });

  it('keeps intentional duplicate routes that were not changed by normalization', () => {
    const router = new TuiRouter();
    router.push({ name: 'sourceList' }, { focusIndex: 1 });
    router.push({ name: 'sourceList' }, { focusIndex: 2 });

    router.normalizeRoutes((route) => normalizeTuiRoute(route, entities()));

    expect(router.snapshot).toMatchObject({ depth: 3, current: { context: { focusIndex: 2 } } });
    expect(router.back().current).toEqual({
      route: { name: 'sourceList' }, context: { focusIndex: 1 },
    });
  });

  it('remaps a removed flow origin to the preserved earlier list frame', () => {
    const router = new TuiRouter();
    router.push({ name: 'pluginList', mode: 'installed' }, { query: 'saved', focusIndex: 3 });
    router.push({ name: 'pluginDetail', pluginId: 'removed' });
    router.beginFlow('configEdit', {
      name: 'configFieldAction', pluginId: 'removed', layer: { scope: 'user' }, fieldKey: 'mode',
    });
    router.push({ name: 'configSave', pluginId: 'removed', layer: { scope: 'user' } });

    router.normalizeRoutes((route) => normalizeTuiRoute(route, entities({ hasPlugin: () => false })));

    expect(router.snapshot).toMatchObject({
      depth: 2,
      current: {
        route: { name: 'pluginList', mode: 'installed' },
        context: { query: 'saved', focusIndex: 3 },
      },
    });
    expect(router.finishFlow()?.current).toEqual({
      route: { name: 'pluginList', mode: 'installed' },
      context: { query: 'saved', focusIndex: 3 },
    });
  });
});
