import { claudeValueOptions, claudeVariadicOptions } from '../adapters/claude-options.mjs';
import { resolveCodexExecutable } from '../adapters/codex-executable.mjs';
import { ADAPTER_PROTOCOL_VERSION, code, fail, identifier, object, text } from '../runtime/contracts.mjs';
import { INTROSPECTION_TIMEOUT_MS, resolveProbeExecutable, runProbeProcess } from './process.mjs';
import { validateIntrospectionRequest } from './protocol.mjs';

const MODEL_LIMIT = 128;
const CODEX_PAGE_LIMIT = 128;
const antigravityEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const probeFrame = { protocolVersion: ADAPTER_PROTOCOL_VERSION, type: 'introspection', status: 'supported' };
const unavailable = (code, message) => ({
  ...probeFrame, environment: { status: 'unavailable', code }, diagnostics: [{ code, message }],
});

function boundedText(value, limit) {
  if (text(value) && value.trim()) return [...value].slice(0, limit).join('');
}

function normalizedModels(items, mapModel, previous = []) {
  const models = new Map(previous.map((model) => [model.id, model]));
  let defaultSeen = previous.some((model) => model.isDefault);
  for (const item of items) {
    if (models.size === MODEL_LIMIT) break;
    const model = mapModel(item);
    if (!identifier(model?.id) || models.has(model.id)) continue;
    const { id } = model;
    const displayName = boundedText(model.displayName, 256);
    const description = boundedText(model.description, 512);
    const efforts = Array.isArray(model.efforts)
      ? [...new Set(model.efforts.filter(identifier))].slice(0, MODEL_LIMIT) : undefined;
    const defaultEffort = identifier(model.defaultEffort) ? model.defaultEffort : undefined;
    const isDefault = model.isDefault === true && !defaultSeen;
    models.set(id, { id, ...(displayName && { displayName }), ...(description && { description }),
      ...(efforts && { efforts }), ...(defaultEffort && { defaultEffort }),
      ...(typeof model.isDefault === 'boolean' && { isDefault }) });
    defaultSeen ||= isDefault;
  }
  return [...models.values()];
}

function readCatalog(result) {
  if (Array.isArray(result.result)) return result.result;
  fail('introspectionFailed', 'The backend exited before returning a model directory.');
}

function codexModel(item) {
  if (!object(item) || item.hidden === true) return undefined;
  return {
    id: item.model || item.id, displayName: item.displayName, description: item.description,
    isDefault: item.isDefault, defaultEffort: item.defaultReasoningEffort,
    efforts: Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts.map((effort) => effort?.reasoningEffort) : undefined,
  };
}

async function codexModels(request, options) {
  const { readCodexConfiguration, splitConfiguration, buildCodexLaunchArgs } = await import('../adapters/codex-profile.mjs');
  const { merged, extras } = await readCodexConfiguration(request.args, {
    profile: request.codex.profile, workspace: options.cwd, environment: options.env,
  });
  const invocation = await resolveCodexExecutable({
    source: request.codex.cliSource, environment: options.env, cwd: options.cwd,
    signal: options.signal, containment: options.containment, reportVersion: false,
  });
  const { launch } = splitConfiguration(merged, { launchOnly: true });
  const args = [...invocation.args, ...buildCodexLaunchArgs({ launch, extras })];
  let requestId = 1;
  let models = [];
  const cursors = new Set();
  const available = readCatalog(await runProbeProcess({ ...invocation, args }, {
    ...options,
    input: JSON.stringify({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'aw-subagent', version: String(ADAPTER_PROTOCOL_VERSION) }, capabilities: {},
    } }) + '\n',
    onLine(line, send) {
      const reply = JSON.parse(line);
      if (!object(reply) || Object.hasOwn(reply, 'method') || reply.id !== requestId) return;
      if (requestId === 1) {
        if (!object(reply.result) || reply.error) fail('introspectionFailed', 'Codex rejected initialization.');
        send({ method: 'initialized', params: {} });
        send({ id: ++requestId, method: 'model/list', params: { limit: MODEL_LIMIT } });
        return;
      }
      if (!Array.isArray(reply.result?.data) || reply.error) fail('introspectionFailed', 'Codex did not return a model directory.');
      const { data, nextCursor } = reply.result;
      models = normalizedModels(data, codexModel, models);
      if (models.length === MODEL_LIMIT || nextCursor == null) return models;
      if (typeof nextCursor !== 'string' || cursors.has(nextCursor) || cursors.size === CODEX_PAGE_LIMIT - 1) {
        fail('introspectionFailed', 'Codex did not finish paginating the model directory.');
      }
      cursors.add(nextCursor);
      send({ id: ++requestId, method: 'model/list', params: { cursor: nextCursor, limit: MODEL_LIMIT } });
    },
  }));
  const recommended = available.find((item) => item.isDefault);
  return { models: available, ...(recommended && { defaultModel: recommended.id }),
    ...(recommended?.defaultEffort && { defaultEffort: recommended.defaultEffort }) };
}

const claudeSettings = new Map([
  ['--settings', 1], ['--setting-sources', 1], ['--add-dir', Infinity], ['--mcp-config', Infinity],
  ['--strict-mcp-config', 0], ['--bare', 0], ['--safe-mode', 0], ['--restricted', 0],
  ['--agent', 1], ['--agents', 1], ['--betas', Infinity], ['--plugin-dir', 1],
]);

function claudeProbeArgs(args) {
  const result = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') break;
    const equals = argument.indexOf('=');
    const option = equals < 0 ? argument : argument.slice(0, equals);
    const maximum = claudeSettings.get(option);
    // Allow only settings. Positional prompts and command, session, output,
    // and model controls would change the probe's behavior.
    if (maximum === undefined) {
      // A discarded option can own an option-shaped value. -n can be grouped
      // after print, continue, help, or version short flags.
      if (equals < 0 && args[index + 1] !== '--' && (claudeValueOptions.includes(option)
        || claudeVariadicOptions.includes(option) || /^-[pchv]*n$/.test(option))) index++;
      continue;
    }
    const values = equals < 0 ? [] : [argument.slice(equals + 1)];
    // An inline value does not start variadic parsing in Claude's CLI.
    if (equals < 0) {
      while (values.length < maximum && index + 1 < args.length && !args[index + 1].startsWith('-')) values.push(args[++index]);
    }
    if (maximum > 0 && !values.length || maximum === 0 && values.length) fail('adapterArgumentsInvalid', 'A Claude configuration option has invalid values.');
    result.push(...(equals < 0 ? [option, ...values] : [argument]));
  }
  return result;
}

async function claudeModels(request, options) {
  const invocation = await resolveProbeExecutable('claude', claudeProbeArgs(request.args), {
    ...options, packageName: '@anthropic-ai/claude-code', binName: 'claude',
  });
  const requestId = 'introspect-1';
  const models = readCatalog(await runProbeProcess(invocation, {
    ...options,
    input: JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } }) + '\n',
    onLine(line) {
      const reply = JSON.parse(line);
      if (reply.type !== 'control_response' || reply.response?.request_id !== requestId) return;
      if (reply.response.subtype !== 'success' || !Array.isArray(reply.response.response?.models)) {
        fail('introspectionFailed', 'Claude Code did not return a model directory.');
      }
      return reply.response.response.models;
    },
  }));
  return { models: normalizedModels(models, (item) => {
    if (!object(item) || item.value === 'default') return undefined;
    return {
      id: item.value, displayName: item.resolvedModel && text(item.displayName) && text(item.resolvedModel)
        ? `${item.displayName} (${item.resolvedModel})` : item.displayName,
      description: item.description, efforts: item.supportsEffort ? item.supportedEffortLevels : [],
    };
  }) };
}

async function antigravityModels(_request, options) {
  const invocation = await resolveProbeExecutable('agy', [], options);
  const run = (arg, limits) => runProbeProcess({ ...invocation, args: [...invocation.args, arg] }, { ...options, ...limits });
  const version = await run('--version', { maximumBytes: 4096 });
  if (version.code !== 0 || !/^\d+\.\d+\.\d+$/.test(version.stdout.trim())) {
    fail('antigravityVersionCheckFailed', 'The agy version query failed.');
  }
  const listing = await run('models');
  const models = normalizedModels(listing.stdout.split(/\r?\n/), (line) => {
    const columns = line.split('\t');
    if (columns.length === 2 && columns[1].trim()) return { id: columns[0].trim(), displayName: columns[1].trim() };
  });
  if (listing.code !== 0 || !models.length) fail('introspectionFailed', 'Antigravity did not return a model directory.');
  return { models, supportedEfforts: [...antigravityEfforts] };
}

const probes = new Map([
  ['codex', codexModels], ['claude-code', claudeModels], ['antigravity', antigravityModels],
]);

export async function runBuiltinIntrospection(adapter, request, environment = process.env, {
  signal = AbortSignal.timeout(INTROSPECTION_TIMEOUT_MS), containment,
} = {}) {
  validateIntrospectionRequest(request);
  const probe = probes.get(adapter);
  if (!probe || Object.hasOwn(request, 'codex') !== (adapter === 'codex')) {
    fail('protocolInvalid', 'The introspection configuration must match the built-in adapter.');
  }
  try {
    const catalog = await probe(request, { cwd: request.workspace, env: environment, signal, containment });
    return { ...probeFrame, environment: { status: 'available' }, ...catalog };
  } catch (error) {
    if (signal.aborted || error.code === 'introspectionTimeout') {
      return unavailable('introspectionTimeout', 'The read-only backend probe timed out.');
    }
    return unavailable(code(error.code) ? error.code : 'introspectionFailed', 'The backend model directory could not be read. Check the CLI, authentication, and executor configuration.');
  }
}
