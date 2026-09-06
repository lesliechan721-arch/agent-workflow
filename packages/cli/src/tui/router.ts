import type { PlatformName, Scope } from '../types.js';

export type PortableBlockerCode =
  | 'requiredConfigMissing'
  | 'portableSkillsCliMissing'
  | 'portableSkillsCliIncompatible'
  | 'portableScopeUnavailable'
  | 'portableValidationFailed';

export type PluginInstallFilter = 'all' | 'uninstalled';
export type CatalogActivationBlockReason =
  | 'configDraft'
  | 'sourceDraft'
  | 'batchDraft'
  | 'portableDraft'
  | 'activeReview'
  | 'reviewPreparation'
  | 'writeProgress'
  | 'sourceMutationProgress'
  | 'refreshProgress';

export interface ConfigInvalidStoreEvidence {
  scope: Scope;
  code: 'invalidJson' | 'schemaVersionUnsupported' | 'identityMismatch' | 'invalidValues';
  pathSummary: string;
}

export type ConfigResumeRoute =
  | { name: 'configFields'; pluginId: string; layer: { scope: Scope | 'effective' } }
  | {
      name: 'configFieldEditor';
      pluginId: string;
      layer: { scope: Scope };
      fieldKey: string;
      editor: 'boolean' | 'number' | 'string' | 'object';
      mode?: 'choices' | 'custom';
    }
  | {
      name: 'configObjectPropertyEditor';
      pluginId: string;
      layer: { scope: Scope };
      fieldKey: string;
      propertyKey?: string;
      dynamic: boolean;
      stage: 'key' | 'action' | 'choices' | 'custom';
    }
  | {
      name: 'configFieldAction';
      pluginId: string;
      layer: { scope: Scope };
      fieldKey: string;
    };

export type TuiRoute =
  | { name: 'home' }
  | { name: 'pluginList'; mode: 'browse' | 'installed'; sourceId?: string }
  | { name: 'batchSelection' }
  | { name: 'batchPlacement' }
  | { name: 'pluginPreview'; pluginId: string }
  | { name: 'portableSkillSelect'; pluginId: string }
  | { name: 'portableDependencies'; pluginId: string }
  | { name: 'portableAgentMode'; pluginId: string }
  | { name: 'portableAgentInput'; pluginId: string }
  | { name: 'portableScope'; pluginId: string }
  | { name: 'portableBlocker'; pluginId: string; code: PortableBlockerCode; diagnosticCode: string }
  | {
      name: 'pluginDependencies';
      pluginId: string;
      view?: 'relations' | 'removeBlocked';
      platform?: PlatformName;
      scope?: Scope;
    }
  | { name: 'installPlacement'; pluginId: string }
  | {
      name: 'installTargets';
      pluginId: string;
      view?: 'selection' | 'blocked';
    }
  | { name: 'dependencyPlacement'; pluginId: string }
  | {
      name: 'dependencyPlacementEditor';
      pluginId: string;
      dependencyPluginId: string;
      platform: PlatformName;
    }
  | { name: 'pluginDetail'; pluginId: string }
  | { name: 'platform'; pluginId: string; platform: PlatformName }
  | { name: 'pluginAbout'; pluginId: string }
  | { name: 'pluginTechnical'; pluginId: string }
  | {
      name: 'configLayer';
      pluginId: string;
      fieldKey?: string;
      groupId?: string;
      presetId?: string;
    }
  | {
      name: 'configFields';
      pluginId: string;
      layer: { scope: Scope | 'effective' };
    }
  | {
      name: 'configFieldEditor';
      pluginId: string;
      layer: { scope: Scope };
      fieldKey: string;
      editor: 'boolean' | 'number' | 'string' | 'object';
      mode?: 'choices' | 'custom';
    }
  | {
      name: 'configObjectPropertyEditor';
      pluginId: string;
      layer: { scope: Scope };
      fieldKey: string;
      propertyKey?: string;
      dynamic: boolean;
      stage: 'key' | 'action' | 'choices' | 'custom';
    }
  | {
      name: 'configFieldAction';
      pluginId: string;
      layer: { scope: Scope };
      fieldKey: string;
    }
  | {
      name: 'configUnavailable';
      pluginId: string;
      layer?: { scope: Scope };
      invalidStores?: ConfigInvalidStoreEvidence[];
      diagnosticCode?: string;
      diagnosticStage?: string;
      resumeRoute?: ConfigResumeRoute;
      resumeContext?: Pick<TuiPageContext, 'configGroupId' | 'focusIndex' | 'scrollOffset'>;
      storedScopes?: Scope[];
    }
  | { name: 'sourceList' }
  | { name: 'sourceDetail'; sourceId: string }
  | { name: 'sourceTechnical'; sourceId: string }
  | { name: 'sourceAdd'; step: 'type' | 'id' | 'location' | 'refPolicy' | 'ref' | 'subdir'; owner: string; returnToDraft?: true }
  | { name: 'sourceEdit'; sourceId: string; owner?: string }
  | { name: 'sourceSave'; owner: string }
  | { name: 'configSave'; pluginId: string; layer: { scope: Scope } }
  | { name: 'scriptTimeout'; owner: string }
  | { name: 'sourceRemoveBlocked'; sourceId: string }
  | { name: 'catalogCandidate'; sourceId: string }
  | { name: 'catalogRefreshPolicy'; sourceId: string }
  | { name: 'catalogRefresh'; sourceId: string }
  | { name: 'catalogImmutableViolation'; sourceId: string }
  | {
      name: 'catalogActivationBlocked';
      sourceId: string;
      reason: CatalogActivationBlockReason;
      operation?: 'reload';
      preservedLabel?: string;
    }
  | { name: 'issueList' }
  | { name: 'issueDetail'; issueId: string }
  | { name: 'operationHistory' }
  | { name: 'operationDiagnostic'; recordId: string }
  | { name: 'operationReportPreview'; recordId: string }
  | { name: 'reviewPreparing'; preparationId: string }
  | { name: 'review'; operationId: string }
  | { name: 'progress'; operationId: string }
  | { name: 'result'; operationId: string };

export interface TuiPageContext {
  focusIndex?: number;
  scrollOffset?: number;
  query?: string;
  sourceTabId?: string;
  focusedEntityId?: string;
  installFilter?: PluginInstallFilter;
  configGroupId?: string;
}

export interface TuiRouteFrame {
  route: TuiRoute;
  context: TuiPageContext;
}

export interface TuiRouterSnapshot {
  current: TuiRouteFrame;
  currentFrameId: string;
  currentFlowId?: string;
  depth: number;
}

export type TuiFlowKind = 'pluginInstall' | 'pluginMaintenance' | 'configEdit'
  | 'sourceEdit' | 'sourceRecovery' | 'portableInstall' | 'batchWrite';

export interface TuiFlowScope {
  id: string;
  kind: TuiFlowKind;
  parentFlowId?: string;
  originFrameId: string;
  returnTarget: TuiRoute;
  returnContext?: TuiPageContext;
}

interface NavigationFrame extends TuiRouteFrame {
  id: string;
  flowId?: string;
}

function copyFrame(frame: TuiRouteFrame): TuiRouteFrame {
  return structuredClone({ route: frame.route, context: frame.context });
}

export class TuiRouter {
  readonly #stack: NavigationFrame[] = [{ id: 'frame-1', route: { name: 'home' }, context: {} }];
  readonly #flows = new Map<string, TuiFlowScope>();
  #nextFrameId = 2;
  #nextFlowId = 1;
  #activeFlowId?: string;

  get snapshot(): TuiRouterSnapshot {
    const current = this.#stack.at(-1)!;
    return {
      current: copyFrame(current),
      currentFrameId: current.id,
      ...(current.flowId ? { currentFlowId: current.flowId } : {}),
      depth: this.#stack.length,
    };
  }

  push(route: TuiRoute, context: TuiPageContext = {}): TuiRouterSnapshot {
    this.#stack.push(structuredClone({
      id: `frame-${this.#nextFrameId++}`,
      route,
      context,
      ...(this.#activeFlowId ? { flowId: this.#activeFlowId } : {}),
    }));
    return this.snapshot;
  }

  replace(route: TuiRoute, context: TuiPageContext = {}): TuiRouterSnapshot {
    const current = this.#stack.at(-1)!;
    this.#stack[this.#stack.length - 1] = structuredClone({
      id: current.id,
      route,
      context,
      ...(current.flowId ?? this.#activeFlowId
        ? { flowId: current.flowId ?? this.#activeFlowId }
        : {}),
    });
    return this.snapshot;
  }

  updateContext(update: Partial<TuiPageContext>): TuiRouterSnapshot {
    const current = this.#stack.at(-1)!;
    current.context = { ...current.context, ...update };
    return this.snapshot;
  }

  back(): TuiRouterSnapshot {
    if (this.#stack.length > 1) this.#stack.pop();
    this.#restoreActiveFlow();
    return this.snapshot;
  }

  beginFlow(
    kind: TuiFlowKind,
    returnTarget: TuiRoute = this.#stack.at(-1)!.route,
    originFrameId?: string,
    returnContext?: TuiPageContext,
  ): TuiFlowScope {
    const origin = originFrameId
      ? this.#stack.find((frame) => frame.id === originFrameId) ?? this.#stack.at(-1)!
      : this.#stack.at(-1)!;
    const parentFlowId = origin.flowId ?? this.#activeFlowId;
    const id = `flow-${this.#nextFlowId++}`;
    const flow: TuiFlowScope = {
      id,
      kind,
      ...(parentFlowId ? { parentFlowId } : {}),
      originFrameId: origin.id,
      returnTarget: structuredClone(returnTarget),
      ...(returnContext ? { returnContext: structuredClone(returnContext) } : {}),
    };
    this.#flows.set(id, flow);
    this.#activeFlowId = id;
    return structuredClone(flow);
  }

  beginPluginFlow(kind: Extract<TuiFlowKind, 'pluginInstall' | 'pluginMaintenance'>, pluginId: string): TuiFlowScope {
    let origin = this.#stack.at(-1)!;
    for (let index = this.#stack.length - 1; index >= 0; index -= 1) {
      const candidate = this.#stack[index]!;
      if ((candidate.route.name === 'pluginPreview' || candidate.route.name === 'pluginDetail')
        && candidate.route.pluginId === pluginId) {
        origin = candidate;
        break;
      }
    }
    return this.beginFlow(kind, { name: 'pluginDetail', pluginId }, origin.id);
  }

  beginBatchFlow(): TuiFlowScope {
    const origin = this.#stack.at(-1)!;
    if (origin.route.name !== 'pluginList') {
      throw new Error('Batch flow must start from a plugin list.');
    }
    return this.beginFlow('batchWrite', { name: 'pluginList', mode: 'installed' }, origin.id);
  }

  activeFlow(): TuiFlowScope | undefined {
    const flow = this.#activeFlowId ? this.#flows.get(this.#activeFlowId) : undefined;
    return flow ? structuredClone(flow) : undefined;
  }

  finishFlow(target?: TuiRoute, terminalRoute?: TuiRoute): TuiRouterSnapshot | undefined {
    const flow = this.#activeFlowId ? this.#flows.get(this.#activeFlowId) : undefined;
    if (!flow) return undefined;
    const origin = this.#stack.findIndex((frame) => frame.id === flow.originFrameId);
    if (origin < 0) {
      this.#flows.delete(flow.id);
      this.#restoreActiveFlow();
      return undefined;
    }
    const descendants = new Set<string>([flow.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of this.#flows.values()) {
        if (candidate.parentFlowId && descendants.has(candidate.parentFlowId)
          && !descendants.has(candidate.id)) {
          descendants.add(candidate.id);
          changed = true;
        }
      }
    }
    this.#stack.splice(origin + 1);
    const originFrame = this.#stack[origin]!;
    const nextRoute = structuredClone(target ?? flow.returnTarget);
    this.#stack[origin] = {
      id: originFrame.id,
      route: nextRoute,
      context: structuredClone(flow.returnContext ?? originFrame.context),
      ...(flow.parentFlowId ? { flowId: flow.parentFlowId } : {}),
    };
    for (const flowId of descendants) this.#flows.delete(flowId);
    this.#activeFlowId = flow.parentFlowId;
    if (terminalRoute) {
      this.#stack.push({
        id: `frame-${this.#nextFrameId++}`,
        route: structuredClone(terminalRoute),
        context: {},
      });
    }
    return this.snapshot;
  }

  abandonFlow(flowId: string): TuiRouterSnapshot | undefined {
    const flow = this.#flows.get(flowId);
    if (!flow) return undefined;
    const origin = this.#stack.find((frame) => frame.id === flow.originFrameId);
    if (!origin) return undefined;
    this.#activeFlowId = flowId;
    return this.finishFlow(origin.route);
  }

  resetToRoot(route: Extract<TuiRoute, { name: 'home' }> = { name: 'home' }): TuiRouterSnapshot {
    const root = this.#stack[0]!;
    this.#stack.splice(0, this.#stack.length, { id: root.id, route: structuredClone(route), context: {} });
    this.#flows.clear();
    this.#activeFlowId = undefined;
    return this.snapshot;
  }

  #restoreActiveFlow(): void {
    const flowId = this.#stack.at(-1)?.flowId;
    this.#activeFlowId = flowId && this.#flows.has(flowId) ? flowId : undefined;
  }

  beginConfigFlow(pluginId: string): TuiRoute {
    const route = this.#stack.at(-1)!.route;
    if ((route.name !== 'pluginPreview' && route.name !== 'pluginDetail')
      || route.pluginId !== pluginId) {
      throw new Error('Config flow must start from its plugin preview or detail.');
    }
    this.beginFlow('configEdit', route);
    return structuredClone(route);
  }

  configOrigin(pluginId: string): TuiRoute | undefined {
    const flow = this.#activeFlowId ? this.#flows.get(this.#activeFlowId) : undefined;
    if (flow?.kind !== 'configEdit') return undefined;
    const frame = this.#stack.find((candidate) => candidate.id === flow.originFrameId);
    if (!frame || (frame.route.name !== 'pluginPreview' && frame.route.name !== 'pluginDetail')
      || frame.route.pluginId !== pluginId) {
      return undefined;
    }
    return copyFrame(frame).route;
  }

  resetConfigFlow(pluginId: string, target?: TuiRoute): TuiRouterSnapshot | undefined {
    if (!this.configOrigin(pluginId)) return undefined;
    return this.finishFlow(target);
  }

  beginPortableFlow(pluginId: string): TuiRoute {
    const currentFrame = this.#stack.at(-1)!;
    if ((currentFrame.route.name === 'pluginPreview' || currentFrame.route.name === 'pluginDetail')
      && currentFrame.route.pluginId === pluginId) {
      const active = this.activeFlow();
      if (active?.kind !== 'portableInstall') this.beginFlow('portableInstall', currentFrame.route);
      return copyFrame(currentFrame).route;
    }
    const active = this.activeFlow();
    if (active?.kind === 'portableInstall') {
      const frame = this.#stack.find((candidate) => candidate.id === active.originFrameId);
      if (frame && (frame.route.name === 'pluginPreview' || frame.route.name === 'pluginDetail')
        && frame.route.pluginId === pluginId) {
        return copyFrame(frame).route;
      }
    }
    let existingOrigin = -1;
    for (let candidate = this.#stack.length - 1; candidate >= 0; candidate -= 1) {
      const frame = this.#stack[candidate]!;
      if ((frame.route.name === 'pluginPreview' || frame.route.name === 'pluginDetail')
        && frame.route.pluginId === pluginId) {
        existingOrigin = candidate;
        break;
      }
    }
    const index = existingOrigin >= 0 ? existingOrigin : this.#stack.length - 1;
    let route = this.#stack[index]!.route;
    if ((route.name !== 'pluginPreview' && route.name !== 'pluginDetail')
      || route.pluginId !== pluginId) {
      this.replace({ name: 'pluginPreview', pluginId });
      route = this.#stack[index]!.route;
    }
    this.beginFlow('portableInstall', route, this.#stack[index]!.id);
    return structuredClone(route);
  }

  portableOrigin(pluginId: string): TuiRoute {
    const flow = this.activeFlow();
    if (flow?.kind === 'portableInstall') {
      const frame = this.#stack.find((candidate) => candidate.id === flow.originFrameId);
      if (frame && 'pluginId' in frame.route && frame.route.pluginId === pluginId) {
        return copyFrame(frame).route;
      }
    }
    return { name: 'pluginPreview', pluginId };
  }

  discardSourceFlow(owner: string, returnRoute: Extract<TuiRoute, { name: 'sourceList' | 'sourceDetail' }>): TuiRouterSnapshot {
    const start = this.#stack.findIndex((frame) =>
      (frame.route.name === 'sourceAdd' || frame.route.name === 'sourceEdit')
      && frame.route.owner === owner);
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

  resetPortableFlow(pluginId: string): TuiRouterSnapshot {
    const flow = this.activeFlow();
    const origin = flow?.kind === 'portableInstall'
      ? this.#stack.find((frame) => frame.id === flow.originFrameId)
      : undefined;
    if (origin && (origin.route.name === 'pluginPreview' || origin.route.name === 'pluginDetail')
      && origin.route.pluginId === pluginId) {
      this.finishFlow();
    } else {
      this.replace({ name: 'pluginPreview', pluginId });
    }
    return this.snapshot;
  }
}
