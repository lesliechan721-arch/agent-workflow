import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fail } from '../runtime/contracts.mjs';

export const hookEvents = Object.fromEntries(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'].map((name) => [name, name.replace(/[A-Z]/g, (letter, index) => `${index ? '_' : ''}${letter.toLowerCase()}`)]));
export const table = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export function convertHooks(value, { validate, ignored }) {
  validate(value, 'object', 'hooks');
  const result = Object.create(null);
  for (const [event, groups] of Object.entries(value)) {
    if (event === 'state') {
      validate(groups, 'object', 'hooks.state');
      result.state = Object.create(null);
      for (const [key, state] of Object.entries(groups)) {
        validate(state, 'object', 'hooks.state');
        const converted = Object.create(null);
        for (const [field, item] of Object.entries(state)) {
          if (field === 'enabled' || field === 'trusted_hash') converted[field] = validate(item, field === 'enabled' ? 'boolean' : 'string', `hooks.state.${field}`);
          else ignored(`hooks.state.${field}`);
        }
        if (key.trim()) result.state[key.trim()] = { ...result.state[key.trim()], ...converted };
      }
      continue;
    }
    if (!Object.hasOwn(hookEvents, event)) { ignored(`hooks.${event}`); continue; }
    validate(groups, 'array', `hooks.${event}`);
    let unsupported = false;
    const converted = groups.map((group) => {
      validate(group, 'object', `hooks.${event}`);
      if (Object.keys(group).some((key) => !['matcher', 'hooks'].includes(key))) unsupported = true;
      if (Object.hasOwn(group, 'matcher')) validate(group.matcher, 'string', `hooks.${event}.matcher`);
      if (Object.hasOwn(group, 'hooks')) validate(group.hooks, 'array', `hooks.${event}.hooks`);
      const handlers = (group.hooks ?? []).map((handler) => {
        validate(handler, 'object', `hooks.${event}.hooks`);
        validate(handler.type, 'string', `hooks.${event}.type`);
        if (!['command', 'mcp_tool'].includes(handler.type)) { unsupported = true; return handler; }
        if (handler.type === 'mcp_tool' && event === 'SessionEnd') unsupported = true;
        const fields = handler.type === 'command'
          ? { type: 'string', command: 'string', commandWindows: 'string', command_windows: 'string', statusMessage: 'string', timeout: 'uint', additionalContextLimit: 'uint', async: 'boolean' }
          : { type: 'string', server: 'string', tool: 'string', input: 'jsonObject', timeout: 'uint', statusMessage: 'string' };
        for (const required of handler.type === 'command' ? ['command'] : ['server', 'tool']) validate(handler[required], 'string', `hooks.${event}.${required}`);
        if (Object.hasOwn(handler, 'commandWindows') && Object.hasOwn(handler, 'command_windows')) fail('profileValueInvalid', 'A hook command alias is specified twice.');
        const output = Object.create(null);
        for (const [field, item] of Object.entries(handler)) {
          if (!Object.hasOwn(fields, field)) { unsupported = true; continue; }
          output[field] = validate(item, fields[field], `hooks.${event}.${field}`);
        }
        return output;
      });
      return { ...(Object.hasOwn(group, 'matcher') ? { matcher: group.matcher } : {}), ...(Object.hasOwn(group, 'hooks') ? { hooks: handlers } : {}) };
    });
    if (unsupported) ignored(`hooks.${event}`, 'The complete event override is ignored because its definition contains unsupported fields or handlers. Other native hook sources remain active.');
    else result[event] = converted;
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
    target[key] = { ...target[key], ...(state.enabled !== undefined ? { enabled: state.enabled } : {}), ...(state.trusted_hash !== undefined ? { trusted_hash: state.trusted_hash } : {}) };
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
