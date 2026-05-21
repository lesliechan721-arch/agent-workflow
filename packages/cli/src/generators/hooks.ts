import type {
  HookDefinition,
  PlatformName,
  RenderedHooksManifest,
  RenderedHookGroup,
  TrackedHookGroupIdentity,
} from '../types.js';
import {
  normalizePublicHookDefinition,
  normalizeRenderedHookGroupIdentity,
  renderHookDefinitionGroup,
  renderTrackedHookGroupIdentity,
  serializeTrackedHookGroupIdentity,
  type ResolvedPlatformHookDefinition,
} from '../utils/hooks-contract.js';

export interface RenderedHooksArtifact {
  relativePath: string;
  content: RenderedHooksManifest;
}

export interface CodexHookBundle {
  pluginName: string;
  hooks: ResolvedPlatformHookDefinition[];
}

function sortRenderedHookGroups(
  groups: RenderedHookGroup[],
  platform: PlatformName,
): RenderedHookGroup[] {
  return [...groups].sort((left, right) => {
    const leftIdentity = normalizeRenderedHookGroupIdentity({
      platform,
      event: left.event,
      matcher: left.matcher,
      command: left.hooks[0].command,
    });
    const rightIdentity = normalizeRenderedHookGroupIdentity({
      platform,
      event: right.event,
      matcher: right.matcher,
      command: right.hooks[0].command,
    });

    return serializeTrackedHookGroupIdentity(leftIdentity).localeCompare(
      serializeTrackedHookGroupIdentity(rightIdentity),
    );
  });
}

function renderGroupedHooks(
  groups: RenderedHookGroup[],
  platform: PlatformName,
): RenderedHooksManifest['hooks'] {
  const hooks: RenderedHooksManifest['hooks'] = {};

  for (const group of sortRenderedHookGroups(groups, platform)) {
    hooks[group.event] ??= [];
    hooks[group.event].push({
      ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
      hooks: group.hooks,
    });
  }

  return hooks;
}

export function renderResolvedHooksArtifact(
  hooks: ResolvedPlatformHookDefinition[],
  platform: PlatformName,
): RenderedHooksArtifact | null {
  if (hooks.length === 0) {
    return null;
  }

  if (platform === 'codex') {
    return renderCodexHooks([{ pluginName: 'aw', hooks }]);
  }

  const renderedGroups = hooks.map((hook) => renderHookDefinitionGroup(hook, 'claude'));
  return {
    relativePath: 'hooks/hooks.json',
    content: {
      hooks: renderGroupedHooks(renderedGroups, 'claude'),
    },
  };
}

export function renderHooksArtifact(
  hooks: HookDefinition[],
  platform: PlatformName,
): RenderedHooksArtifact | null {
  return renderResolvedHooksArtifact(
    hooks.map((hook) => normalizePublicHookDefinition(hook)),
    platform,
  );
}

export function extractCodexHookGroups(
  hooks: ResolvedPlatformHookDefinition[],
): TrackedHookGroupIdentity[] {
  return hooks.map((hook) => {
    const renderedGroup = renderHookDefinitionGroup(hook, 'codex');
    return normalizeRenderedHookGroupIdentity({
      platform: 'codex',
      event: renderedGroup.event,
      matcher: renderedGroup.matcher,
      command: renderedGroup.hooks[0].command,
    });
  });
}

export function renderCodexHookGroups(
  groups: TrackedHookGroupIdentity[],
): RenderedHooksArtifact | null {
  if (groups.length === 0) {
    return null;
  }

  const renderedGroups = groups.map((group) => renderTrackedHookGroupIdentity(group));
  return {
    relativePath: 'hooks.json',
    content: {
      hooks: renderGroupedHooks(renderedGroups, 'codex'),
    },
  };
}

export function renderCodexHooks(
  bundles: CodexHookBundle[],
): RenderedHooksArtifact | null {
  return renderCodexHookGroups(
    bundles
      .sort((left, right) => left.pluginName.localeCompare(right.pluginName))
      .flatMap((bundle) => extractCodexHookGroups(bundle.hooks)),
  );
}
