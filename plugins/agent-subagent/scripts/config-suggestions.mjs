import { fileURLToPath } from 'node:url';
import { hasModelOverride, introspectExecutor, MAXIMUM_INTROSPECTION_TIMEOUT_MS } from '../commands/scripts/introspection/models.mjs';
import { effectiveModelEfforts } from '../commands/scripts/introspection/presentation.mjs';
import { INTROSPECTION_TIMEOUT_MS } from '../commands/scripts/introspection/process.mjs';
import { RuntimeError } from '../commands/scripts/runtime/contracts.mjs';

const response = (status, items = [], message, diagnostics) => ({ schemaVersion: 2, status, items,
  ...(message && { message }), ...(diagnostics && { diagnostics }) });
const nativeAdapters = new Map([['codex', 'codex'], ['claude', 'claude-code'], ['antigravity', 'antigravity']]);
const shorten = (text, limit) => [...text].slice(0, limit).join('');
const responseReserveMs = 300;
// Leave room for the eight bounded diagnostics, status, and JSON framing.
const modelProfileByteBudget = 1024 * 1024 - 16 * 1024;
const hints = ['fast', 'balanced', 'strong', 'deep', 'max'];
const effortOrder = ['low', 'medium', 'high', 'xhigh', 'max'];
const builtinClaudeModels = ['haiku', 'sonnet', 'opus', 'fable'].map((id) => ({
  id, displayName: id[0].toUpperCase() + id.slice(1), source: 'builtin',
  ...(id === 'haiku' ? { effortSupport: 'unknown' } : { effortSupport: 'separate', efforts: effortOrder }),
}));

const modelTitle = (model) => shorten(model.displayName || model.id, 128);
function modelDescription(model) {
  const effortNote = model.effortSupport === 'none' ? 'No separate reasoning effort.' : model.effortSupport === 'unknown'
    ? 'Reasoning effort support unknown.' : `Reasoning efforts: ${model.efforts.join(', ')}.`;
  const note = shorten(effortNote, 256);
  return model.description && note.length < 253
    ? `${shorten(model.description, 255 - [...note].length)} ${note}` : note;
}

function modelDirectory(executor, result) {
  const models = result.models.map((model) => ({ ...model,
    efforts: effectiveModelEfforts(model, result.supportedEfforts), source: model.origin ?? result.source }));
  const online = result.environment === 'available' && ['dynamic', 'merged'].includes(result.source);
  let message;
  if (!online && executor.adapter === 'claude-code' && !hasModelOverride(executor)) {
    const configuredIds = new Set(models.map((model) => model.id.toLowerCase()));
    const fallback = builtinClaudeModels.filter((model) => !configuredIds.has(model.id));
    if (fallback.length) {
      models.push(...fallback);
      message = 'The dynamic probe is unavailable; built-in Claude model aliases are shown.';
    }
  }
  return { models, message, missingStatus: result.environment === 'unavailable' ? 'unavailable' : 'no-probe' };
}

// Keep the first occurrence of each family in the real directory's order.
// Both the ID suffix and the display label must indicate a family variant.
function antigravityFamilies(models) {
  const groups = new Map();
  return models.flatMap((model) => {
    const id = /^(?<base>.+)-(?<effort>low|medium|high|xhigh|max)$/.exec(model.id)?.groups;
    const label = /^(?<family>.+?)\s*\((Low|Medium|High|XHigh|Max)\)$/.exec(model.displayName ?? '')?.groups;
    const family = id && label && !/orchestrator/i.test(`${id.base} ${label.family}`);
    if (!family) return [{ id: model.id, title: model.displayName || model.id, variants: [{ model }] }];
    const variant = { model, effort: id.effort };
    if (groups.has(id.base)) {
      groups.get(id.base).variants.push(variant);
      return [];
    }
    const group = { id: id.base, title: label.family, variants: [variant] };
    groups.set(id.base, group);
    return [group];
  }).map((group) => ({ ...group, variants: group.variants.sort((a, b) => effortOrder.indexOf(a.effort) - effortOrder.indexOf(b.effort)) }));
}

const defaultModel = (models) => models.find((model) => model.isDefault) ?? models[0];
const firstSupported = (options, efforts) => options.find((item) => item !== undefined && efforts.includes(item));
const nonEmptyFilter = (items, test) => {
  const matching = items.filter(test);
  return matching.length ? matching : items;
};
const codexActivePool = (models) => nonEmptyFilter(models, (model) => !/\b(?:legacy|previous generation)\b/i.test(model.description ?? ''));
const codexSpecialist = (model) => /\b(?:visual understanding|computer use)\b/i.test(model.description ?? '');
const isUltra = (effort) => /^ultra$/i.test(effort);

function codexChoice(models, hint) {
  const pool = codexActivePool(models);
  const balanced = defaultModel(pool);
  const fast = pool.find((model) => /(?:^|[-_.])(?:mini|nano|spark|flash|luna|lite|fast)(?:$|[-_.])/i.test(model.id)
    || /\b(?:affordable|easier tasks|simpler tasks|lightweight)\b/i.test(model.description ?? '')) ?? balanced;
  const strong = pool.find((model) => !codexSpecialist(model)
    && (/\b(?:most capable|complex coding|flagship)\b/i.test(model.description ?? '')
      || /(?:^|[-_.])(?:astra|pro|opus|max)(?:$|[-_.])/i.test(model.id))) ?? balanced;
  const model = hint === 'fast' ? fast : hint === 'balanced' ? balanced : strong;
  const options = {
    fast: ['low', 'medium'], balanced: ['medium'], strong: ['high', 'xhigh', 'medium'],
    deep: ['xhigh', 'max', 'high'], max: ['max', 'xhigh', 'high'],
  }[hint];
  // ultra remains a manual option, even when it is the model's default.
  const efforts = model.efforts?.filter((effort) => !isUltra(effort)) ?? [];
  const fallback = hint === 'deep' || hint === 'max' ? efforts.at(-1) : efforts[0];
  return { model, effort: firstSupported([...options, model.defaultEffort, fallback], efforts) };
}

function claudeChoice(models, hint) {
  const aliases = {
    fast: ['haiku', 'sonnet'], balanced: ['sonnet', 'opus'], strong: ['opus', 'sonnet'],
    deep: ['fable', 'opus', 'sonnet'], max: ['fable', 'opus', 'sonnet'],
  }[hint];
  const model = aliases.map((alias) => models.find((model) => model.id.toLowerCase() === alias)).find(Boolean) ?? models[0];
  const options = { fast: [], balanced: ['medium', model.defaultEffort], strong: ['high', 'xhigh', 'medium'],
    deep: ['xhigh', 'max', 'high'], max: ['xhigh', 'max', 'high'] }[hint];
  return { model, effort: firstSupported(options, model.efforts ?? []) };
}

function antigravityChoice(families, hint) {
  const pool = nonEmptyFilter(families, (group) => !/orchestrator/i.test(`${group.id} ${group.title}`));
  const isLight = (group) => /(?:^|[-_.\s])(?:flash|mini|nano|haiku|lite)(?:$|[-_.\s])/i.test(`${group.id} ${group.title}`);
  const main = pool.find((group) => !isLight(group) && group.variants.length >= 2) ?? pool[0];
  const fast = pool.find(isLight) ?? main;
  const group = hint === 'fast' ? fast : main;
  const options = {
    fast: ['low', 'medium', 'high'], balanced: ['medium', 'low', 'high'], strong: ['high', 'xhigh', 'medium'],
    deep: ['xhigh', 'max', 'high'], max: ['xhigh', 'max', 'high'],
  }[hint];
  const fallback = hint === 'fast' || hint === 'balanced' ? group.variants[0] : group.variants.at(-1);
  return { model: (options.map((effort) => group.variants.find((variant) => variant.effort === effort)).find(Boolean) ?? fallback).model };
}

function recommendedChoices(executor, models, families) {
  const staticOnly = models.every((model) => model.source === 'configured');
  return new Map(hints.map((hint) => {
    if (!staticOnly) {
      if (executor.adapter === 'codex') return [hint, codexChoice(models, hint)];
      if (executor.adapter === 'claude-code') return [hint, claudeChoice(models, hint)];
      if (families) return [hint, antigravityChoice(families, hint)];
    }
    // Static directories prefer their explicit defaults, but known vendor
    // exclusions still apply when there is another usable model.
    let pool = models;
    if (executor.adapter === 'codex') {
      pool = codexActivePool(models);
      if (['strong', 'deep', 'max'].includes(hint)) pool = nonEmptyFilter(pool, (model) => !codexSpecialist(model));
    } else if (families) {
      pool = nonEmptyFilter(models, (model) => !/orchestrator/i.test(`${model.id} ${model.displayName ?? ''}`));
    }
    const model = defaultModel(pool);
    const efforts = (model.efforts ?? []).filter((effort) => executor.adapter !== 'codex' || !isUltra(effort));
    return [hint, { model, effort: families ? undefined : firstSupported([model.defaultEffort], efforts) }];
  }));
}

// A large directory must not crowd out a valid recommendation at the end.
function boundedItems(items, limit, needed, byteBudget = Infinity) {
  const required = items.filter(needed);
  const kept = new Set();
  for (const item of [...required, ...items]) {
    if (kept.size === limit) break;
    if (kept.has(item)) continue;
    const size = byteBudget === Infinity ? 0 : Buffer.byteLength(JSON.stringify(item)) + 1;
    if (size > byteBudget) continue;
    kept.add(item);
    byteBudget -= size;
  }
  return items.filter((item) => kept.has(item));
}

function modelProfiles(executor, models, request) {
  const targets = new Set(request.targets);
  const canSetEffort = targets.has('reasoningEffort');
  const unsetEffort = canSetEffort ? { unset: ['reasoningEffort'] } : {};
  const families = executor.adapter === 'antigravity' ? antigravityFamilies(models) : undefined;
  const recommendations = recommendedChoices(executor, models, families);
  const hint = hints.includes(request.hint) ? request.hint : 'balanced';
  const mark = (model, effort) => {
    const recommendedHints = hints.filter((name) => {
      const choice = recommendations.get(name);
      return choice.model === model && (!canSetEffort || choice.effort === effort);
    });
    return recommendedHints.length ? { recommendedHints, ...(recommendedHints.includes(hint) && { recommended: true }) } : {};
  };
  const items = [{ title: executor.key === 'native' ? '沿用宿主默认' : '沿用后端默认',
    unset: canSetEffort ? ['model', 'reasoningEffort'] : ['model'] }];
  const modelPatch = (model) => ({ set: { model: model.id } });
  const base = (model) => ({ title: modelTitle(model), description: modelDescription(model), source: model.source });
  if (families) {
    for (const group of families) {
      const itemsInGroup = group.variants.map(({ model, effort }) => ({ ...base(model),
        ...(group.variants.length > 1 && { title: effort }), ...modelPatch(model), ...unsetEffort, ...mark(model) }));
      items.push(itemsInGroup.length === 1 ? itemsInGroup[0] : { title: shorten(group.title, 128),
        source: itemsInGroup.every((item) => item.source === itemsInGroup[0].source) ? itemsInGroup[0].source : 'merged',
        children: { title: '选择推理强度', items: itemsInGroup } });
    }
  } else {
    for (const model of models) {
      const item = { ...base(model), ...modelPatch(model) };
      if (canSetEffort && model.effortSupport === 'separate') {
        const efforts = boundedItems(model.efforts, 31, (effort) => [...recommendations.values()]
          .some((choice) => choice.model === model && choice.effort === effort));
        items.push({ ...item, children: { title: '选择推理强度', items: [
          { title: '沿用模型默认', source: model.source, ...unsetEffort, ...mark(model) },
          ...efforts.map((effort) => ({ title: shorten(effort, 128), source: model.source,
            set: { reasoningEffort: effort }, ...mark(model, effort) })),
        ] } });
      } else {
        items.push({ ...item, ...(model.effortSupport === 'none' && unsetEffort), ...mark(model) });
      }
    }
  }
  return boundedItems(items, 128, (item) => item === items[0] || item.recommendedHints
    || item.children?.items.some((child) => child.recommendedHints), modelProfileByteBudget);
}

export async function suggest(request, options = {}) {
  const objectProvider = request.provider === 'executor-model-profile';
  if (request.schemaVersion !== 2 || !(objectProvider ? request.kind === 'object' : request.kind === 'scalar'
    && ['executor-models', 'executor-efforts'].includes(request.provider))) {
    return response('no-probe', [], 'Unknown suggestion provider.');
  }
  if (objectProvider && !request.targets?.includes('model')) return response('no-probe', [], 'The current profile has no model target.');
  const key = request.dependencyValues?.executor ?? 'native';
  const modelId = request.dependencyValues?.model;
  let executor;
  if (key === 'native') {
    const adapter = nativeAdapters.get(request.platform);
    if (request.profile === 'common' || !adapter) return response('no-probe', [], 'This profile has no native model probe.');
    if (adapter === 'antigravity' && request.provider === 'executor-efforts' && modelId === undefined) {
      return response('not-applicable', [], 'Antigravity selects reasoning effort as part of the model ID. Leave this field empty.');
    }
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
    return response('unavailable', [], undefined, [{ code: error.code, message: error.message }]);
  }
  const diagnostics = result.diagnostics.slice(0, 8).map(({ code, message }) => ({ code, message: shorten(message, 256) }));
  const { models, message, missingStatus } = modelDirectory(executor, result);
  if (request.provider !== 'executor-efforts') {
    if (!models.length) return response(missingStatus, [], 'The executor lists no models.', diagnostics);
    const items = objectProvider ? modelProfiles(executor, models, request) : models.slice(0, 128).map((model) => ({
      value: model.id, title: modelTitle(model), source: model.source, description: modelDescription(model),
      ...(model.isDefault && { recommended: true }),
    }));
    return response('ok', items, message, diagnostics);
  }
  const model = models.find((entry) => entry.id === (modelId ?? result.defaultModel));
  if (model?.effortSupport === 'none') {
    return response('not-applicable', [], 'The selected model does not support a separate reasoning effort. Leave this field empty.', diagnostics);
  }
  const efforts = model ? model.efforts : effectiveModelEfforts(undefined, result.supportedEfforts);
  if (!efforts?.length) return response(missingStatus, [], 'The executor lists no reasoning efforts for this model.', diagnostics);
  const defaultEffort = model?.defaultEffort ?? (!model && (modelId === undefined || result.defaultModel === undefined) ? result.defaultEffort : undefined);
  const source = model?.source ?? 'dynamic';
  const items = efforts.map((effort) => ({ value: effort, title: shorten(effort, 128), source,
    ...(effort === defaultEffort && !(executor.adapter === 'codex' && isUltra(effort)) ? { recommended: true } : {}) }));
  return response('ok', items, model?.source === 'builtin' ? message : undefined, diagnostics);
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
