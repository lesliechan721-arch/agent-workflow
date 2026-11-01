import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse, stringify } from 'smol-toml';
import { fail } from '../runtime/contracts.mjs';
import { convertHooks, table } from './codex-hooks.mjs';

const startup = new Set(['model_catalog_json', 'model_provider', 'model_providers', 'openai_base_url', 'chatgpt_base_url', 'forced_login_method', 'forced_chatgpt_workspace_id', 'cli_auth_credentials_store', 'features']);
const scalarTypes = {
  model_catalog_json: 'path', model_provider: 'string', openai_base_url: 'string', chatgpt_base_url: 'string', forced_login_method: 'string', forced_chatgpt_workspace_id: 'string', cli_auth_credentials_store: 'string',
  model: 'string', model_reasoning_effort: 'string', model_reasoning_summary: 'string', model_verbosity: 'string', service_tier: 'string', model_context_window: 'integer', model_auto_compact_token_limit: 'integer', model_auto_compact_token_limit_scope: 'string', model_post_turn_compact_threshold_percent: 'byte', tool_output_token_limit: 'uint', compact_prompt: 'string', experimental_compact_prompt_file: 'path', instructions: 'string', developer_instructions: 'string', model_instructions_file: 'path', project_doc_max_bytes: 'uint', project_doc_fallback_filenames: 'filenames', web_search: 'string', allow_login_shell: 'boolean', background_terminal_max_timeout: 'uint', approvals_reviewer: 'string', sandbox_mode: 'string', mcp_optional_startup_grace_ms: 'uint', include_environment_context: 'boolean', include_environment_context_time: 'boolean',
};
const providerTypes = { name: 'string', base_url: 'string', model_catalog_url: 'string', env_key: 'string', env_key_instructions: 'string', wire_api: 'string', query_params: 'strings', http_headers: 'strings', env_http_headers: 'strings', request_max_retries: 'uint', stream_max_retries: 'uint', stream_idle_timeout_ms: 'uint', websocket_connect_timeout_ms: 'uint', requires_openai_auth: 'boolean', supports_websockets: 'boolean' };
const mcpTypes = { command: 'command', args: 'stringArray', env: 'strings', env_vars: 'stringArray', cwd: 'path', enabled: 'boolean', required: 'boolean', startup_timeout_sec: 'number', tool_timeout_sec: 'number', enabled_tools: 'stringArray', disabled_tools: 'stringArray', url: 'string', bearer_token_env_var: 'string', http_headers: 'strings', env_http_headers: 'strings' };
const nestedTypes = {
  shell_environment_policy: { inherit: 'string', ignore_default_excludes: 'boolean', exclude: 'stringArray', include_only: 'stringArray', set: 'strings' },
  sandbox_workspace_write: { writable_roots: 'paths', network_access: 'boolean', exclude_tmpdir_env_var: 'boolean', exclude_slash_tmp: 'boolean' },
};
const featureNames = new Set(['api_key_model_discovery', 'code_mode_host', 'code_mode', 'model_catalog_in_context', 'plugins', 'standalone_web_search', 'hooks']);
const irrelevant = new Set(['review_model', 'plan_mode_reasoning_effort', 'tui', 'desktop', 'file_opener']);

export function mergeConfiguration(left, right) {
  const output = Object.assign(Object.create(null), left);
  for (const [key, value] of Object.entries(right)) output[key] = table(value) && table(output[key]) ? mergeConfiguration(output[key], value) : value;
  return output;
}

function jsonValue(value, field, invalid) {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) invalid(field, 'Integer cannot be represented without loss.');
    return Number(value);
  }
  if (value === null || value === undefined || typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) invalid(field, 'Value cannot be represented without loss.');
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, field, invalid));
  if (typeof value === 'object') {
    if (!table(value)) invalid(field, 'TOML date and time values are not supported.');
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item, field, invalid)]));
  }
  return value;
}

export function parseProfile(text, diagnostics = []) {
  try { return parse(text, { integersAsBigInt: true }); }
  catch {
    diagnostics.push({ code: 'profileValueInvalid', field: 'profile', message: 'The profile is not valid TOML.' });
    fail('profileValueInvalid', 'The profile is not valid TOML.');
  }
}

/** The nested-array wrapper asks the TOML serializer for an inline value. */
export function tomlValue(value) {
  const wrapper = stringify({ value: [[value]] });
  return wrapper.slice(wrapper.indexOf('=') + 1).trim().replace(/^\[\s*\[\s*/, '').replace(/\s*\]\s*\]$/, '');
}

export function parseConfigArgument(argument) {
  try {
    try { return parse(argument, { integersAsBigInt: true }); }
    catch {
      const equals = argument.indexOf('=');
      const raw = argument.slice(equals + 1);
      if (equals < 1 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
      return parse(`${argument.slice(0, equals)}=${tomlValue(raw)}`, { integersAsBigInt: true });
    }
  } catch { fail('adapterArgumentsInvalid', 'A config override is not a valid TOML assignment.'); }
}

export function convertProfile(document, { diagnostics = [], explicit = false } = {}) {
  const invalid = (field, message = 'The supported field has an invalid type or value.') => {
    const code = explicit ? 'adapterArgumentsInvalid' : 'profileValueInvalid';
    diagnostics.push({ code, field, message });
    fail(code, message);
  };
  const ignored = (field, message = 'This override is unsupported and was ignored. Lower configuration layers remain active.') => {
    if (explicit) fail('parameterUnavailable', `The explicit ${field.split('.')[0]} override is unsupported.`);
    diagnostics.push({ code: 'profileFieldIgnored', field, message });
  };
  const validate = (original, type, field) => {
    if (type === 'object' || type === 'array') {
      if (!(type === 'object' ? table(original) : Array.isArray(original))) invalid(field);
      return original;
    }
    const value = jsonValue(original, field, invalid);
    const expected = ['object', 'jsonObject'].includes(type) ? table(value) : type === 'array' ? Array.isArray(value)
      : ['path', 'command'].includes(type) ? typeof value === 'string'
      : ['stringArray', 'filenames', 'paths'].includes(type) ? Array.isArray(value) && value.every((item) => typeof item === 'string')
      : type === 'strings' ? table(value) && Object.values(value).every((item) => typeof item === 'string')
      : ['integer', 'uint', 'byte'].includes(type) ? typeof original === 'bigint' && Number.isSafeInteger(value) && (type === 'integer' || value >= 0) && (type !== 'byte' || value <= 255)
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value) && value >= 0
      : typeof value === type;
    if (!expected) invalid(field);
    if (type === 'filenames' && value.some((item) => !item || /[\\/]/.test(item) || ['.', '..'].includes(item))) invalid(field, 'Project document candidates must be file names.');
    return value;
  };
  const checked = (value, type, field) => {
    value = validate(value, type, field);
    const relative = type === 'path' ? !path.isAbsolute(value) : type === 'paths' ? value.some((item) => !path.isAbsolute(item)) : type === 'command' ? /[\\/]/.test(value) && !path.isAbsolute(value) : false;
    if (relative) { ignored(field, 'Relative paths are unsupported. This override is ignored; lower configuration layers remain active.'); return undefined; }
    return value;
  };
  const fields = (value, types, prefix) => {
    validate(value, 'object', prefix);
    const result = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(types, key)) { ignored(`${prefix}.${key}`); continue; }
      const output = checked(item, types[key], `${prefix}.${key}`);
      if (output !== undefined) result[key] = output;
    }
    return result;
  };
  validate(document, 'object', 'profile');
  const result = Object.create(null);
  const ignoredProviders = new Set();
  for (const [key, value] of Object.entries(document)) {
    if (Object.hasOwn(scalarTypes, key)) {
      const output = checked(value, scalarTypes[key], key);
      if (output !== undefined) result[key] = output;
    } else if (Object.hasOwn(nestedTypes, key)) result[key] = fields(value, nestedTypes[key], key);
    else if (key === 'hooks') result.hooks = convertHooks(value, { validate, ignored });
    else if (key === 'features') {
      validate(value, 'object', key);
      result.features = Object.create(null);
      for (const [name, item] of Object.entries(value)) {
        if (!featureNames.has(name)) { ignored(`${key}.${name}`); continue; }
        result.features[name] = ['code_mode', 'code_mode_host'].includes(name) && table(item) ? fields(item, { enabled: 'boolean' }, `${key}.${name}`) : validate(item, 'boolean', `${key}.${name}`);
      }
    } else if (key === 'model_providers' || key === 'mcp_servers' || key === 'plugins') {
      validate(value, 'object', key);
      result[key] = Object.create(null);
      for (const [name, item] of Object.entries(value)) {
        const prefix = `${key}.${name}`;
        validate(item, 'object', prefix);
        const types = key === 'model_providers' ? providerTypes : key === 'mcp_servers' ? mcpTypes : { enabled: 'boolean' };
        // Validate known fields even when another field makes the item unsupported.
        const converted = fields(item, types, prefix);
        if (key !== 'plugins' && Object.keys(item).some((field) => !Object.hasOwn(types, field))) {
          ignored(prefix, 'The complete entry is ignored because unsupported fields can change authentication or transport semantics. Lower configuration layers remain active.');
          if (key === 'model_providers') ignoredProviders.add(name);
          continue;
        }
        if (key === 'mcp_servers') {
          if (Object.hasOwn(item, 'command') && Object.hasOwn(item, 'url') || Object.hasOwn(item, 'command') && ['bearer_token_env_var', 'http_headers', 'env_http_headers'].some((field) => Object.hasOwn(item, field)) || Object.hasOwn(item, 'url') && ['args', 'env', 'env_vars', 'cwd'].some((field) => Object.hasOwn(item, field))) invalid(prefix, 'MCP transports and their authentication fields cannot be mixed.');
          if (['cwd', 'command'].some((field) => Object.hasOwn(item, field) && !Object.hasOwn(converted, field))) { ignored(prefix, 'The complete MCP entry is ignored because its path representation is unsupported.'); continue; }
        }
        result[key][name] = converted;
      }
    } else if (key === 'approval_policy') {
      if (typeof value === 'string') result[key] = value;
      else {
        validate(value, 'object', key);
        if (Object.keys(value).some((field) => field !== 'granular')) { ignored(key); continue; }
        const granular = fields(value.granular, { sandbox_approval: 'boolean', rules: 'boolean', skill_approval: 'boolean', request_permissions: 'boolean', mcp_elicitations: 'boolean' }, 'approval_policy.granular');
        if (Object.keys(value.granular).some((field) => !Object.hasOwn(granular, field))) { ignored(key); continue; }
        result[key] = { granular };
      }
    } else if (irrelevant.has(key) && !explicit) diagnostics.push({ code: 'profileFieldIrrelevant', field: key, message: 'This field does not apply to this external task and was ignored.' });
    else ignored(key, key === 'bypass_hook_trust' ? 'Use the executor codexBypassHookTrust field. Profile bypass does not enable hook trust bypass.' : undefined);
  }
  if (ignoredProviders.has(result.model_provider)) {
    ignored('model_provider', 'The profile provider selector is ignored because its provider definition was ignored.');
    delete result.model_provider;
  }
  return result;
}

export async function readCodexProfile(name, environment, diagnostics = [], cwd = process.cwd()) {
  if (name === undefined) return {};
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name)) fail('profileValueInvalid', 'The Codex profile must be a plain profile-v2 name.');
  let profilePath, text;
  try {
    // Native Codex canonicalizes an explicit CODEX_HOME, but does not resolve
    // the profile file itself. Preserve that file's lexical source identity.
    let home;
    if (environment.CODEX_HOME) {
      home = await fs.realpath(path.resolve(cwd, environment.CODEX_HOME));
      if (!(await fs.stat(home)).isDirectory()) throw new Error();
    } else {
      const userHome = process.platform === 'win32' ? environment.USERPROFILE || os.homedir() : environment.HOME || os.homedir();
      home = path.join(userHome, '.codex');
    }
    profilePath = path.join(home, `${name}.config.toml`);
    text = await fs.readFile(profilePath, 'utf8');
  } catch {
    diagnostics.push({ code: 'profileUnreadable', field: 'profile', message: 'The selected profile file could not be read.' });
    fail('profileUnreadable', 'The selected profile file could not be read.');
  }
  return { profilePath, document: parseProfile(text, diagnostics) };
}

export function splitConfiguration(value) {
  const launch = Object.create(null), thread = Object.create(null);
  for (const [key, item] of Object.entries(value)) (startup.has(key) ? launch : thread)[key] = item;
  return { launch, thread };
}

export function launchArguments(launch, extra = [], platform = process.platform) {
  const argv = ['app-server', ...extra];
  for (const [key, value] of Object.entries(launch)) argv.push('-c', `${key}=${tomlValue(value)}`);
  const size = argv.reduce((total, value) => total + (platform === 'win32' ? value.length * 2 : Buffer.byteLength(value)) + 3, 0);
  if (size > (platform === 'win32' ? 28000 : 120000)) fail('profileConversionUnsupported', 'Startup configuration exceeds the supported command-line size. Reduce startup overrides.');
  return argv;
}
