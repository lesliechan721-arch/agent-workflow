import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fail } from '../runtime/contracts.mjs';

export const hookEvents = Object.fromEntries(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'].map((name) => [name, name.replace(/[A-Z]/g, (letter, index) => `${index ? '_' : ''}${letter.toLowerCase()}`)]));
export const table = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function mergeStateRecord(base, overlay) {
  const result = { ...base, ...overlay };
  for (const [key, value] of Object.entries(overlay)) {
    if (table(base?.[key]) && table(value)) result[key] = mergeStateRecord(base[key], value);
  }
  return result;
}

/** Preserve definitions verbatim: trust hashes cover the complete handler. */
export function convertHooks(value, { invalid, unsupported }) {
  if (!table(value)) invalid('hooks', 'Hooks must be a table for source-state mapping.');
  const result = Object.assign(Object.create(null), value);
  for (const [event, groups] of Object.entries(value)) {
    if (event === 'state') {
      if (!table(groups)) invalid('hooks.state', 'Hook state must be a table.');
      result.state = Object.create(null);
      for (const [index, [key, state]] of Object.entries(groups).entries()) {
        const field = `hooks.state[${index}]`;
        if (!table(state)) invalid(field, 'A hook state record must be a table.');
        if (Object.hasOwn(state, 'enabled') && typeof state.enabled !== 'boolean') invalid(`${field}.enabled`, 'Hook enabled state must be a boolean.');
        if (Object.hasOwn(state, 'trusted_hash') && typeof state.trusted_hash !== 'string') invalid(`${field}.trusted_hash`, 'Hook trust state must be a string.');
        if (key.trim()) result.state[key.trim()] = mergeStateRecord(result.state[key.trim()], state);
      }
      continue;
    }
    const known = Object.hasOwn(hookEvents, event);
    const field = known ? `hooks.${event}` : 'hooks.<event>';
    if (!Array.isArray(groups)) {
      if (known) invalid(field, 'Hook event groups must be an array for source-state mapping.');
      continue;
    }
    for (const [groupIndex, group] of groups.entries()) {
      const groupField = `${field}[${groupIndex}]`;
      if (!table(group)) {
        if (known) invalid(groupField, 'A hook group must be a table for source-state mapping.');
        continue;
      }
      if (Object.hasOwn(group, 'hooks') && !Array.isArray(group.hooks)) {
        if (known) invalid(`${groupField}.hooks`, 'Hook handlers must be an array for source-state mapping.');
        continue;
      }
      for (const [handlerIndex, handler] of (group.hooks ?? []).entries()) {
        const handlerField = `${groupField}.hooks[${handlerIndex}]`;
        if (!table(handler)) {
          if (known) invalid(handlerField, 'A hook handler must be a table for source-state mapping.');
          continue;
        }
        if (handler.type === 'prompt' || handler.type === 'agent') unsupported(`${handlerField}.type`, 'This hook handler cannot execute in the supported Codex backend.');
        if (event === 'SessionEnd' && handler.type === 'mcp_tool') unsupported(`${handlerField}.type`, 'The Codex backend does not execute MCP tool handlers for SessionEnd.');
      }
    }
  }
  return result;
}

function mergeStates(target, incoming) {
  if (incoming === undefined) return;
  if (!table(incoming)) fail('profileHookStateUnavailable', 'Hook state is not a table.');
  for (const [rawKey, state] of Object.entries(incoming)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (!table(state) || state.enabled !== undefined && typeof state.enabled !== 'boolean' || state.trusted_hash !== undefined && typeof state.trusted_hash !== 'string') fail('profileHookStateUnavailable', 'A hook state record cannot be read without loss.');
    target[key] = mergeStateRecord(target[key], state);
  }
}

export function sessionHookSource(platform = process.platform) {
  return platform === 'win32' ? path.win32.resolve('C:\\', '<session-flags>/config.toml') : '/<session-flags>/config.toml';
}

/** config/read returns layers from high to low. Never use its flattened config for trust. */
export function mapHookState(configuration, response, platform = process.platform) {
  if (!Array.isArray(response?.layers)) fail('profileHookStateUnavailable', 'config/read did not return raw configuration layers.');
  const states = Object.create(null);
  let runtimeDefinitions;
  for (const layer of [...response.layers].reverse()) {
    if (!table(layer?.name) || typeof layer.name.type !== 'string' || !table(layer.config)) fail('profileHookStateUnavailable', 'A configuration layer has no usable source or contents.');
    if (!['user', 'sessionFlags'].includes(layer.name.type)) continue;
    if (layer.name.type === 'user' && typeof layer.name.file !== 'string') fail('profileHookStateUnavailable', 'A user configuration layer has no source path.');
    mergeStates(states, layer.config.hooks?.state);
    if (layer.name.type === 'sessionFlags') runtimeDefinitions = layer.config.hooks;
  }
  mergeStates(states, configuration.profileHooks?.state);
  const source = sessionHookSource(platform);
  // Original-source overrides must participate in provenance mapping. Explicit
  // runtime keys apply afterward, without bypassing the existing-slot checks.
  const originalOverrides = Object.create(null), runtimeOverrides = Object.create(null);
  for (const [key, state] of Object.entries(configuration.rawHooks?.state ?? {})) {
    (key.trim().startsWith(`${source}:`) ? runtimeOverrides : originalOverrides)[key] = state;
  }
  mergeStates(states, originalOverrides);
  const hooks = configuration.thread.config.hooks ?? Object.create(null);
  for (const [event, groups] of Object.entries(hooks)) {
    if (event === 'state') continue;
    const profileOwned = configuration.profilePath && !Object.hasOwn(configuration.rawHooks ?? {}, event);
    if (!Object.hasOwn(hookEvents, event)) {
      // Unknown configuration is native-owned. Only reject when migrating its
      // source states would require inventing an event identifier.
      const knownStates = new Set(Object.values(hookEvents));
      const owners = [source, ...(profileOwned ? [configuration.profilePath] : [])];
      const unmapped = Object.keys(states).some((key) => owners.some((owner) => key.startsWith(`${owner}:`) && !knownStates.has(key.slice(owner.length + 1).split(':', 1)[0])));
      const hasHandlers = Array.isArray(groups) && groups.some((group) => Array.isArray(group?.hooks) && group.hooks.length > 0);
      if (profileOwned && hasHandlers && unmapped) fail('profileHookMappingUnsupported', 'An unknown hook event has source state that cannot be mapped without changing trust.');
      continue;
    }
    for (const [groupIndex, group] of groups.entries()) {
      for (const [handlerIndex] of (group.hooks ?? []).entries()) {
        const suffix = `${hookEvents[event]}:${groupIndex}:${handlerIndex}`;
        const target = `${source}:${suffix}`;
        const original = profileOwned ? states[`${configuration.profilePath}:${suffix}`] : undefined;
        // A pre-existing runtime slot may belong to a different definition. Its
        // digest or enabled preference must not silently migrate by array index.
        if (states[target] && !isDeepStrictEqual(runtimeDefinitions?.[event]?.[groupIndex], group)) {
          fail('profileHookMappingUnsupported', 'A runtime hook state key belongs to an unknown or different definition.');
        }
        if (profileOwned) {
          if (states[target] && !isDeepStrictEqual(states[target], original ?? {})) fail('profileHookMappingUnsupported', 'Profile and runtime hook states conflict.');
          if (original) states[target] = { ...original };
          else delete states[target];
        }
      }
    }
  }
  // Explicit state is the final, intentional runtime override, after provenance
  // has been checked against the state already loaded by the backend.
  mergeStates(states, runtimeOverrides);
  configuration.thread.config.hooks = { ...hooks, state: states };
}
