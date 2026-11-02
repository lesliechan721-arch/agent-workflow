import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isIP } from 'node:net';
import { parse, stringify } from 'smol-toml';
import { fail } from '../runtime/contracts.mjs';
import { convertHooks, table } from './codex-hooks.mjs';

// Routing describes when Codex consumes a field; it does not limit accepted keys.
const threadFields = new Set([
  'model', 'service_tier', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity',
  'model_context_window', 'model_auto_compact_token_limit', 'model_auto_compact_token_limit_scope',
  'model_post_turn_compact_threshold_percent', 'compact_prompt', 'experimental_compact_prompt_file',
  'instructions', 'developer_instructions', 'model_instructions_file', 'include_environment_context',
  'include_environment_context_time', 'project_doc_max_bytes', 'project_doc_fallback_filenames',
  'allow_login_shell', 'shell_environment_policy', 'background_terminal_max_timeout', 'tool_output_token_limit',
  'approval_policy', 'approvals_reviewer', 'sandbox_mode', 'sandbox_workspace_write', 'permissions',
  'default_permissions', 'auto_review', 'web_search', 'tools', 'mcp_servers', 'mcp_optional_startup_grace_ms',
  'skills', 'agents', 'hooks', 'thread_unload_delay_secs',
]);
const structuredFeatures = new Set(['code_mode', 'multi_agent_v2', 'network_proxy', 'sleep_tool', 'runtime_agent_instances']);
const aliases = [['agents', 'max_threads', 'max_concurrent_threads_per_session'], ['memories', 'no_memories_if_mcp_or_web_search', 'disable_on_external_context']];
const absolutePaths = ['model_instructions_file', 'experimental_compact_prompt_file', 'model_catalog_json', 'sqlite_home', 'log_dir'];
const unsupportedFields = {
  allow_symlinked_codex_home: 'Runtime overrides cannot preserve the required host user-layer identity.',
  profile: 'Use the profile-v2 selection entry instead of a configuration profile selector.',
  profiles: 'Legacy profile definitions cannot be used as profile-v2 runtime overrides.',
};

function normalizeAliases(value) {
  if (!table(value)) return value;
  const result = Object.assign(Object.create(null), value);
  for (const [parent, alias, canonical] of aliases) {
    if (!table(result[parent]) || !Object.hasOwn(result[parent], alias)) continue;
    result[parent] = Object.assign(Object.create(null), result[parent]);
    if (!Object.hasOwn(result[parent], canonical)) result[parent][canonical] = result[parent][alias];
    delete result[parent][alias];
  }
  return result;
}

const asciiLower = (value) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
function normalizeHost(value) {
  let host = value.trim();
  if (host.startsWith('[') && host.includes(']')) host = host.slice(1, host.indexOf(']'));
  else if ([...host].filter((letter) => letter === ':').length === 1) host = host.split(':', 1)[0];
  host = asciiLower(host).replace(/\.+$/, '');
  for (const separator of ['%25', '%']) {
    const index = host.indexOf(separator);
    if (index >= 0 && isIP(host.slice(0, index))) return `${host.slice(0, index)}%${host.slice(index + separator.length)}`;
  }
  return host;
}

function normalizeKeys(value, normalize) {
  const result = Object.create(null);
  // TOML maps in Codex are ordered by key before normalization.
  for (const [key, item] of Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) result[normalize(key)] = item;
  return result;
}

/** Match the native merge rules before flattening profile and raw input layers. */
export function mergeConfiguration(left, right, { platform = process.platform } = {}) {
  const merge = (base, overlay, keys) => {
    const feature = keys.length === 2 && keys[0] === 'features' && structuredFeatures.has(keys[1]);
    if (feature && typeof base === 'boolean' && table(overlay)) base = { enabled: base };
    else if (feature && table(base) && typeof overlay === 'boolean') overlay = { enabled: overlay };
    if (!table(overlay)) return Array.isArray(overlay) ? overlay.map((item) => merge(undefined, item, [...keys, '[]'])) : overlay;
    let output = table(base) ? Object.assign(Object.create(null), base) : Object.create(null);
    if (keys.length === 1 && keys[0] === 'shell_environment_policy') {
      if (Object.hasOwn(overlay, 'filters')) { delete output.exclude; delete output.include_only; }
      else if (Object.hasOwn(overlay, 'exclude') || Object.hasOwn(overlay, 'include_only')) delete output.filters;
    }
    const filters = keys.length === 2 && keys[0] === 'shell_environment_policy' && keys[1] === 'filters';
    const domains = keys.length === 4 && keys[0] === 'permissions' && keys[2] === 'network' && keys[3] === 'domains'
      || keys.length === 3 && keys[0] === 'application' && keys[1] === 'network' && keys[2] === 'domains';
    if (filters || domains) {
      const normalize = filters ? (key) => key.toLowerCase() : normalizeHost;
      output = normalizeKeys(output, normalize);
      overlay = normalizeKeys(overlay, normalize);
    }
    if (keys.length === 3 && keys[0] === 'features' && structuredFeatures.has(keys[1]) && keys[2] === 'credentials') {
      for (const [provider, value] of Object.entries(overlay)) {
        if (!Array.isArray(value?.env)) continue;
        for (const [existing, previous] of Object.entries(output)) {
          const sources = Array.isArray(overlay[existing]?.env) ? overlay[existing].env : previous?.env;
          if (existing !== provider && Array.isArray(sources) && sources.some((source) => typeof source === 'string' && value.env.some((next) => typeof next === 'string' && (source === next || platform === 'win32' && asciiLower(source) === asciiLower(next))))) delete output[existing];
        }
      }
    }
    for (const [key, value] of Object.entries(overlay)) output[key] = merge(output[key], value, [...keys, key]);
    return output;
  };
  return merge(normalizeAliases(left), normalizeAliases(right), []);
}

function jsonValue(value) {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error();
    return Number(value);
  }
  if (typeof value === 'number') {
    // TOML integers are BigInts. Integral Numbers are TOML floats, but JSON
    // serialization removes their `.0` and changes the native value type.
    if (!Number.isFinite(value) || Number.isInteger(value)) throw new Error();
    return value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (table(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  throw new Error();
}

function checkTomlValue(value) {
  if (value instanceof Date) fail('profileConversionUnsupported', 'The TOML parser cannot preserve original date and time precision. Use a configuration representation supported without loss.');
  if (Object.is(value, -0)) fail('profileConversionUnsupported', 'The TOML serializer cannot preserve negative floating-point zero without loss.');
  if (Array.isArray(value)) { for (const item of value) checkTomlValue(item); }
  else if (table(value)) { for (const item of Object.values(value)) checkTomlValue(item); }
  else if (!['string', 'boolean', 'number', 'bigint'].includes(typeof value)) fail('profileConversionUnsupported', 'The value cannot be represented as TOML without loss.');
}

export function parseProfile(text, diagnostics = []) {
  try {
    const document = parse(text, { integersAsBigInt: true });
    checkTomlValue(document);
    return document;
  } catch (error) {
    if (error.code === 'profileConversionUnsupported') {
      diagnostics.push({ code: error.code, field: 'profile', message: error.message });
      throw error;
    }
    diagnostics.push({ code: 'profileValueInvalid', field: 'profile', message: 'The profile is not valid TOML.' });
    fail('profileValueInvalid', 'The profile is not valid TOML.');
  }
}

/** The nested-array wrapper asks the TOML serializer for an inline value. */
export function tomlValue(value) {
  checkTomlValue(value);
  const wrapper = stringify({ value: [[value]] }, { numbersAsFloat: true });
  return wrapper.slice(wrapper.indexOf('=') + 1).trim().replace(/^\[\s*\[\s*/, '').replace(/\s*\]\s*\]$/, '');
}

export function parseConfigArgument(argument, { diagnostics = [] } = {}) {
  let document;
  try {
    try { document = parse(argument, { integersAsBigInt: true }); }
    catch {
      const equals = argument.indexOf('=');
      const raw = argument.slice(equals + 1);
      if (equals < 1 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
      document = parse(`${argument.slice(0, equals)}=${tomlValue(raw)}`, { integersAsBigInt: true });
    }
  } catch {
    const message = 'A config override is not a valid TOML assignment.';
    diagnostics.push({ code: 'adapterArgumentsInvalid', field: 'args.config', message });
    fail('adapterArgumentsInvalid', message);
  }
  try { checkTomlValue(document); }
  catch (error) {
    if (error.code === 'profileConversionUnsupported') diagnostics.push({ code: error.code, field: 'args.config', message: error.message });
    throw error;
  }
  return document;
}

export function convertProfile(document, { diagnostics = [], explicit = false, baseDir = process.cwd(), environment = process.env, platform = process.platform, privateMcpServer } = {}) {
  const report = (code, field, message) => {
    diagnostics.push({ code, field, message });
    fail(code, message);
  };
  const invalid = (field, message) => report(explicit ? 'adapterArgumentsInvalid' : 'profileValueInvalid', field, message);
  const unsupported = (field, message) => report('profileFieldUnsupported', field, message);
  const conversionUnsupported = (field, message) => report('profileConversionUnsupported', field, message);
  const controlled = (field, message) => report('adapterArgumentsInvalid', field, message);
  if (!table(document)) invalid('profile', 'Configuration must be a TOML table.');
  for (const [key, message] of Object.entries(unsupportedFields)) if (Object.hasOwn(document, key)) unsupported(key, message);
  for (const key of ['cwd', 'bypass_hook_trust']) {
    if (Object.hasOwn(document, key)) controlled(key, key === 'cwd' ? 'AW controls the workspace for this task.' : 'AW controls hook trust bypass. Use the executor codexBypassHookTrust setting.');
  }
  if (Object.hasOwn(document, 'mcp_servers') && !table(document.mcp_servers)) invalid('mcp_servers', 'MCP servers must be a table for the AW private binding merge.');
  if (privateMcpServer && table(document.mcp_servers) && Object.hasOwn(document.mcp_servers, privateMcpServer)) controlled('mcp_servers.<private>', 'The configuration conflicts with the AW private MCP binding.');
  if (Object.hasOwn(document, 'model') && typeof document.model !== 'string') invalid('model', 'The model mapping must be a string.');
  const result = mergeConfiguration({}, document, { platform });
  // Shared interactive profiles can include client-only or deprecated settings.
  // Remove only these inert fields from the copy used for backend execution.
  for (const field of ['tui', 'desktop', 'file_opener', 'js_repl_node_path', 'js_repl_node_module_dirs']) delete result[field];
  if (table(result.agents)) delete result.agents.job_max_runtime_seconds;
  if (table(result.orchestrator)) delete result.orchestrator.skills;
  if (table(result.ghost_snapshot)) {
    for (const field of ['ignore_large_untracked_files', 'ignore_untracked_files_over_bytes', 'ignore_large_untracked_dirs', 'large_untracked_dir_warning_threshold', 'disable_warnings']) delete result.ghost_snapshot[field];
  }
  if (Object.hasOwn(result, 'hooks')) result.hooks = convertHooks(result.hooks, { invalid, unsupported });
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const resolvePath = (value, field) => {
    // Other native type errors stay with Codex. AW only interprets path strings.
    if (typeof value !== 'string') return value;
    let target = value;
    if (platform === 'win32') {
      target = target.replace(/^\\\\[?.]\\UNC\\/, '\\\\').replace(/^\\\\[?.]\\(?=[A-Za-z]:[\\/])/, '');
      if (/^[A-Za-z]:(?![\\/])/.test(target) || /^\\\\[?.]\\/.test(target)) conversionUnsupported(field, 'This Windows path representation cannot be converted reliably. Use an absolute drive or UNC path.');
    }
    const homeRelative = target === '~' || target.startsWith('~/') || platform === 'win32' && target.startsWith('~\\');
    if (homeRelative) {
      const home = platform === 'win32' ? environment.USERPROFILE || (platform === process.platform ? os.homedir() : undefined) : environment.HOME || (platform === process.platform ? os.homedir() : undefined);
      if (!home || !paths.isAbsolute(home)) conversionUnsupported(field, 'The effective home directory cannot be resolved. Use an absolute path.');
      target = paths.join(home, target.slice(1).replace(platform === 'win32' ? /^[\\/]+/ : /^\/+/, ''));
    }
    if (!paths.isAbsolute(baseDir)) conversionUnsupported(field, 'The configuration source directory cannot be resolved. Use an absolute path.');
    return paths.resolve(baseDir, target);
  };
  // ConfigToml's AbsolutePathBuf fields use the source layer directory. Do not
  // apply this rule to native cwd-based MCP commands or permission expressions.
  for (const field of absolutePaths) if (Object.hasOwn(result, field)) result[field] = resolvePath(result[field], field);
  if (Array.isArray(result.sandbox_workspace_write?.writable_roots)) result.sandbox_workspace_write.writable_roots = result.sandbox_workspace_write.writable_roots.map((value, index) => resolvePath(value, `sandbox_workspace_write.writable_roots[${index}]`));
  if (table(result.agents)) for (const agent of Object.values(result.agents)) if (table(agent) && Object.hasOwn(agent, 'config_file')) agent.config_file = resolvePath(agent.config_file, 'agents.<name>.config_file');
  if (Array.isArray(result.skills?.config)) for (const [index, skill] of result.skills.config.entries()) if (table(skill) && Object.hasOwn(skill, 'path')) skill.path = resolvePath(skill.path, `skills.config[${index}].path`);
  for (const exporter of ['exporter', 'trace_exporter', 'metrics_exporter']) {
    for (const transport of ['otlp-http', 'otlp-grpc']) {
      const tls = result.otel?.[exporter]?.[transport]?.tls;
      if (!table(tls)) continue;
      for (const field of ['ca-certificate', 'client-certificate', 'client-private-key']) if (Object.hasOwn(tls, field)) tls[field] = resolvePath(tls[field], `otel.${exporter}.${transport}.tls.${field}`);
    }
  }
  // Serializer failures must not expose arbitrary field names or values.
  try { tomlValue(result); }
  catch { conversionUnsupported('configuration', 'The configuration cannot be serialized as TOML without loss.'); }
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

export function splitConfiguration(value, { diagnostics = [] } = {}) {
  const launch = Object.create(null), thread = Object.create(null);
  const threadValue = (key, item, target = key) => {
    try { thread[target] = jsonValue(item); }
    catch {
      // Hooks must retain source-state mapping. Moving them to startup would
      // bypass that mapping, so no startup fallback is allowed for this table.
      if (key === 'hooks') {
        const message = 'Hooks cannot be represented as JSON without loss while preserving source-state mapping.';
        diagnostics.push({ code: 'profileConversionUnsupported', field: 'hooks', message });
        fail('profileConversionUnsupported', message);
      }
      if (key === 'features.hooks') launch.features = { ...launch.features, hooks: item };
      else launch[key] = item;
    }
  };
  for (const [key, item] of Object.entries(value)) {
    if (key === 'features' && table(item)) {
      const features = Object.fromEntries(Object.entries(item).filter(([name]) => name !== 'hooks'));
      if (Object.keys(features).length) launch.features = { ...launch.features, ...features };
      if (Object.hasOwn(item, 'hooks')) threadValue('features.hooks', item.hooks);
    } else if (threadFields.has(key)) threadValue(key, item);
    else launch[key] = item;
  }
  return { launch, thread };
}

export function launchArguments(launch, extra = [], platform = process.platform) {
  const argv = ['app-server', ...extra];
  try {
    for (const [key, value] of Object.entries(launch)) argv.push('-c', `${/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlValue(key)}=${tomlValue(value)}`);
  } catch { fail('profileConversionUnsupported', 'Startup configuration cannot be serialized as TOML without loss.'); }
  const size = argv.reduce((total, value) => total + (platform === 'win32' ? value.length * 2 : Buffer.byteLength(value)) + 3, 0);
  if (size > (platform === 'win32' ? 28000 : 120000)) fail('profileConversionUnsupported', 'Startup configuration exceeds the supported command-line size. Reduce startup overrides.');
  return argv;
}
