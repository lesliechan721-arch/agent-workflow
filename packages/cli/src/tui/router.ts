import type { PlatformName, Scope } from '../types.js';
import type { ProjectConfigStoreLayer } from '../utils/plugin-config.js';

export type TuiRoute =
  | { name: 'home' }
  | { name: 'pluginList'; mode: 'browse' | 'installed'; sourceId?: string }
  | { name: 'pluginPreview'; pluginId: string }
  | {
      name: 'pluginDependencies';
      pluginId: string;
      view?: 'relations' | 'removeBlocked';
      platform?: PlatformName;
      scope?: Scope;
    }
  | { name: 'installPlacement'; pluginId: string }
  | {
      name: 'installTools';
      pluginId: string;
      view?: 'selection' | 'blocked';
    }
  | { name: 'pluginDetail'; pluginId: string }
  | { name: 'platform'; pluginId: string; platform: PlatformName }
  | { name: 'pluginAbout'; pluginId: string }
  | { name: 'pluginTechnical'; pluginId: string }
  | { name: 'configLayer'; pluginId: string }
  | {
      name: 'configFields';
      pluginId: string;
      layer: { scope: Scope | 'effective'; projectLayer: ProjectConfigStoreLayer };
      groupId?: string;
    }
  | {
      name: 'configFieldEditor';
      pluginId: string;
      layer: { scope: Scope; projectLayer: ProjectConfigStoreLayer };
      fieldKey: string;
      editor: 'enum' | 'boolean' | 'number' | 'string' | 'path' | 'sensitive';
    }
  | {
      name: 'configPresets';
      pluginId: string;
      layer: { scope: Scope; projectLayer: ProjectConfigStoreLayer };
    }
  | {
      name: 'configUnavailable';
      pluginId: string;
      layer?: { scope: Scope; projectLayer: ProjectConfigStoreLayer };
    }
  | { name: 'sourceList' }
  | { name: 'sourceDetail'; sourceId: string }
  | { name: 'sourceTechnical'; sourceId: string }
  | { name: 'sourceAdd'; step: 'type' | 'id' | 'location' | 'refPolicy' | 'ref' | 'subdir'; owner: string }
  | { name: 'sourceEdit'; sourceId: string }
  | { name: 'sourceRemoveBlocked'; sourceId: string }
  | { name: 'issueList' }
  | { name: 'issueDetail'; issueId: string }
  | { name: 'review'; operationId: string }
  | { name: 'progress'; operationId: string }
  | { name: 'result'; operationId: string };

export interface TuiPageContext {
  focusIndex?: number;
  scrollOffset?: number;
  query?: string;
  sourceTabId?: string;
}

export interface TuiRouteFrame {
  route: TuiRoute;
  context: TuiPageContext;
}

export interface TuiRouterSnapshot {
  current: TuiRouteFrame;
  depth: number;
}

function copyFrame(frame: TuiRouteFrame): TuiRouteFrame {
  return structuredClone(frame);
}

export class TuiRouter {
  readonly #stack: TuiRouteFrame[] = [{ route: { name: 'home' }, context: {} }];

  get snapshot(): TuiRouterSnapshot {
    return { current: copyFrame(this.#stack.at(-1)!), depth: this.#stack.length };
  }

  push(route: TuiRoute, context: TuiPageContext = {}): TuiRouterSnapshot {
    this.#stack.push(structuredClone({ route, context }));
    return this.snapshot;
  }

  replace(route: TuiRoute, context: TuiPageContext = {}): TuiRouterSnapshot {
    this.#stack[this.#stack.length - 1] = structuredClone({ route, context });
    return this.snapshot;
  }

  updateContext(update: Partial<TuiPageContext>): TuiRouterSnapshot {
    const current = this.#stack.at(-1)!;
    current.context = { ...current.context, ...update };
    return this.snapshot;
  }

  back(): TuiRouterSnapshot {
    if (this.#stack.length > 1) this.#stack.pop();
    return this.snapshot;
  }

  discardSourceFlow(owner: string, returnRoute: Extract<TuiRoute, { name: 'sourceList' | 'sourceDetail' }>): TuiRouterSnapshot {
    const start = this.#stack.findIndex((frame) =>
      frame.route.name === 'sourceAdd' && frame.route.owner === owner);
    if (start >= 0) this.#stack.splice(start);
    const current = this.#stack.at(-1)!.route;
    if (current.name === 'sourceEdit'
      && returnRoute.name === 'sourceDetail'
      && current.sourceId === returnRoute.sourceId) {
      this.back();
    }
    const settled = this.#stack.at(-1)!.route;
    const atReturnRoute = returnRoute.name === 'sourceList'
      ? settled.name === 'sourceList'
      : settled.name === 'sourceDetail' && settled.sourceId === returnRoute.sourceId;
    if (!atReturnRoute) {
      this.replace(returnRoute);
    }
    return this.snapshot;
  }
}
