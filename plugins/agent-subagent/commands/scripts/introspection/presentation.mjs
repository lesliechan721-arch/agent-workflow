import { stripVTControlCharacters } from 'node:util';
import { code, identifier, redact } from '../runtime/contracts.mjs';

const osc = /(?:\u001b\]|\u009d)(?:(?!\u001b\\)[^\u0007\u009c])*(?:\u0007|\u009c|\u001b\\|$)/gu;
const sanitize = (value) => stripVTControlCharacters(value.replace(osc, '')).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
const bounded = (value, maximum) => [...value].slice(0, maximum).join('');

const sensitiveKey = /KEY|TOKEN|SECRET|PASSWORD|AUTH/i;
const minimumInferredSecretLength = 8;

export function probePresentation(environment, secrets = []) {
  const tokens = [...secrets, ...Object.entries(environment)
    .filter(([key]) => sensitiveKey.test(key)).map(([, value]) => value)];
  // Controls can split a token. Only longer values are distinctive enough
  // for an unqualified substring match, since environment settings can be switches.
  const cleanTokens = tokens.filter((value) => typeof value === 'string')
    .flatMap((value) => [value, sanitize(value)])
    .filter((value) => [...value].length >= minimumInferredSecretLength);
  const display = (value) => redact(sanitize(String(value)), {}, cleanTokens);
  const action = (value) => identifier(value) && display(value) === value ? value : undefined;
  const diagnosticCode = (value) => code(value) && display(value) === value ? value : 'introspectionDiagnostic';
  return { display, action, diagnosticCode };
}

export function executorPresentation(executor, host) {
  const normalize = (key) => process.platform === 'win32' ? key.toUpperCase() : key;
  const references = new Set(Object.values(executor.envFrom ?? {}).map(normalize));
  const hostSecrets = Object.entries(host)
    .filter(([key]) => sensitiveKey.test(key) || references.has(normalize(key))).map(([, value]) => value);
  return probePresentation(executor.env ?? {}, hostSecrets);
}

export function supportedDefaultEffort(value, efforts) {
  return value && (efforts === undefined || efforts.includes(value)) ? value : undefined;
}

// An explicit empty model array overrides a general executor menu. An absent
// array inherits that menu only when there is a non-empty one to inherit.
export function effectiveModelEfforts(model, supportedEfforts) {
  return Array.isArray(model?.efforts) ? model.efforts : supportedEfforts?.length ? supportedEfforts : undefined;
}

export function effortSupport(efforts) {
  return !Array.isArray(efforts) ? 'unknown' : efforts.length ? 'separate' : 'none';
}

export function presentModel(model, { display, action }) {
  if (!action(model.id)) return undefined;
  const displayName = model.displayName && bounded(display(model.displayName), 256);
  const description = model.description && bounded(display(model.description), 512);
  const efforts = model.efforts?.filter(action);
  const defaultEffort = action(model.defaultEffort);
  return { id: model.id, ...(displayName && { displayName }), ...(description && { description }),
    ...(efforts && { efforts }), ...(defaultEffort && { defaultEffort }), ...(model.isDefault && { isDefault: true }) };
}

export function presentIntrospectionFrame(frame, presentation) {
  const { display, action, diagnosticCode } = presentation;
  const { models: rawModels, defaultModel: rawDefault, defaultEffort: rawEffort, supportedEfforts: rawEfforts,
    environment: rawEnvironment, diagnostics: rawDiagnostics, ...rest } = frame;
  const models = rawModels?.map((model) => presentModel(model, presentation)).filter(Boolean);
  const supportedEfforts = rawEfforts?.filter(action);
  const requestedDefault = rawDefault ?? rawModels?.find((model) => model.isDefault)?.id;
  const defaultModel = models?.find((model) => model.id === requestedDefault);
  const effort = action(rawEffort);
  for (const model of models ?? []) {
    const effectiveEfforts = effectiveModelEfforts(model, supportedEfforts);
    const validated = supportedDefaultEffort(model.defaultEffort, effectiveEfforts);
    if (model === defaultModel) {
      model.isDefault = true;
      const recommended = validated ?? supportedDefaultEffort(effort, effectiveEfforts);
      if (recommended) model.defaultEffort = recommended;
      else delete model.defaultEffort;
    } else {
      delete model.isDefault;
      if (!validated) delete model.defaultEffort;
    }
  }
  const defaultEffort = defaultModel?.defaultEffort ?? (requestedDefault === undefined
    ? supportedDefaultEffort(effort, effectiveModelEfforts(undefined, supportedEfforts)) : undefined);
  const environment = rawEnvironment.status === 'unavailable' ? { status: 'unavailable', code: diagnosticCode(rawEnvironment.code) }
    : { status: 'available' };
  const diagnostics = rawDiagnostics?.map((entry) => ({ code: diagnosticCode(entry.code), message: bounded(display(entry.message), 2048),
    ...(entry.field && { field: bounded(display(entry.field), 256) }) }));
  return { ...rest, environment, ...(models && { models }), ...(defaultModel && { defaultModel: defaultModel.id }),
    ...(supportedEfforts && { supportedEfforts }), ...(defaultEffort && { defaultEffort }), ...(diagnostics && { diagnostics }) };
}
