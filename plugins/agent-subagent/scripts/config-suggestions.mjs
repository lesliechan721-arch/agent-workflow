import { fileURLToPath } from 'node:url';
import { introspectExecutor, MAXIMUM_INTROSPECTION_TIMEOUT_MS } from '../commands/scripts/introspection/models.mjs';
import { INTROSPECTION_TIMEOUT_MS } from '../commands/scripts/introspection/process.mjs';
import { RuntimeError } from '../commands/scripts/runtime/contracts.mjs';

const response = (status, items = [], message) => ({ schemaVersion: 1, status, items, ...(message ? { message } : {}) });
const nativeAdapters = new Map([['codex', 'codex'], ['claude', 'claude-code'], ['antigravity', 'antigravity']]);
const shorten = (text, limit) => [...text].slice(0, limit).join('');
const responseReserveMs = 300;

export async function suggest(request, options = {}) {
  if (request.schemaVersion !== 1 || !['executor-models', 'executor-efforts'].includes(request.provider)) {
    return response('unsupported', [], 'Unknown suggestion provider.');
  }
  const key = request.dependencyValues?.executor ?? 'native';
  let executor;
  if (key === 'native') {
    const adapter = nativeAdapters.get(request.platform);
    if (request.profile === 'common' || !adapter) return response('unsupported', [], 'This profile has no native model probe.');
    executor = { adapter, key };
  } else {
    executor = request.providerConfigValues?.subagentCommands?.find((entry) => entry.key === key);
    if (!executor) return response('unavailable', [], 'The selected executor is not configured.');
  }
  const budget = Number.isSafeInteger(request.deadlineAt) ? request.deadlineAt - Date.now() : INTROSPECTION_TIMEOUT_MS;
  const timeoutMs = Math.min(budget, MAXIMUM_INTROSPECTION_TIMEOUT_MS) - responseReserveMs;
  let result;
  try {
    result = await introspectExecutor(executor, {
      workspace: request.cwd, commandHost: request.commandHost, timeoutMs, ...options,
    });
  } catch (error) {
    if (!(error instanceof RuntimeError) || error.code !== 'executorInvalid') throw error;
    return { ...response('unavailable'), diagnostics: [{ code: error.code, message: error.message }] };
  }
  const diagnostics = result.diagnostics.slice(0, 8).map(({ code, message }) => ({ code, message: shorten(message, 256) }));
  if (request.provider === 'executor-models') {
    if (result.source === 'unavailable') return { ...response(result.environment === 'unavailable' ? 'unavailable' : 'unsupported'), diagnostics };
    const items = result.models.slice(0, 128).map((model) => ({
      value: model.id, title: shorten(model.displayName || model.id, 128), source: model.origin ?? result.source,
      ...(model.description ? { description: shorten(model.description, 256) } : {}), ...(model.isDefault ? { recommended: true } : {}),
    }));
    return { ...response('ok', items), diagnostics };
  }
  const modelId = request.dependencyValues?.model;
  const model = result.models.find((entry) => entry.id === modelId);
  const modelEfforts = model?.efforts?.length ? model.efforts : undefined;
  const efforts = modelEfforts ?? result.supportedEfforts;
  if (!efforts?.length) return { ...response(result.environment === 'unavailable' ? 'unavailable' : 'unsupported', [],
    'The executor lists no reasoning efforts for this model.'), diagnostics };
  const defaultEffort = model?.defaultEffort ?? (!modelEfforts && (modelId === undefined || result.defaultModel === undefined)
    ? result.defaultEffort : undefined);
  const source = modelEfforts && model.origin ? model.origin : result.source === 'unavailable' ? 'dynamic' : result.source;
  const items = efforts.map((effort) => ({ value: effort, title: shorten(effort, 128), source,
    ...(effort === defaultEffort ? { recommended: true } : {}) }));
  return { ...response('ok', items), diagnostics };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    console.log(JSON.stringify(await suggest(JSON.parse(Buffer.concat(chunks).toString('utf8')))));
  } catch {
    console.log(JSON.stringify(response('unavailable', [], 'Could not read the executor configuration or model directory.')));
  }
}
