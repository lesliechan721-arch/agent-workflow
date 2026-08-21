import type { PlatformName, Scope } from '../types.js';
import type { ProjectConfigStoreLayer } from '../utils/plugin-config.js';

export type TuiRoute =
  | { name: 'home' }
  | { name: 'pluginList'; mode: 'browse' | 'installed'; sourceId?: string }
  | { name: 'pluginDetail'; pluginId: string }
  | { name: 'platform'; pluginId: string; platform: PlatformName }
  | { name: 'configLayer'; pluginId: string }
  | {
      name: 'configFields';
      pluginId: string;
      layer: { scope: Scope; projectLayer: ProjectConfigStoreLayer };
      groupId?: string;
    }
  | { name: 'sourceList' }
  | { name: 'sourceDetail'; sourceId: string }
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
}
