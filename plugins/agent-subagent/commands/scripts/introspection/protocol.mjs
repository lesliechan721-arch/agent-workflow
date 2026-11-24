import { ADAPTER_PROTOCOL_VERSION, absolutePath, code, fail, fields, identifier, object, text } from '../runtime/contracts.mjs';

export const INTROSPECTION_MAX_BYTES = 1024 * 1024;
export const validEfforts = (value) => Array.isArray(value) && value.length <= 128 && value.every(identifier)
  && new Set(value).size === value.length;
export const boundedText = (value, maximum) => typeof value === 'string' && value.isWellFormed() && [...value].length <= maximum;

export function validateIntrospectionRequest(frame) {
  if (!fields(frame, ['protocolVersion', 'type', 'executor', 'workspace', 'args', 'codex']) ||
      frame.protocolVersion !== ADAPTER_PROTOCOL_VERSION || frame.type !== 'introspect' ||
      !identifier(frame.executor) || !absolutePath(frame.workspace) ||
      !Array.isArray(frame.args) || frame.args.some((arg) => !text(arg))) {
    fail('protocolInvalid', 'Use an Adapter v6 introspect frame with an executor, workspace, and args.');
  }
  if (Object.hasOwn(frame, 'codex')) {
    const codex = frame.codex;
    if (!fields(codex, ['cliSource', 'bypassHookTrust', 'profile']) ||
        !['auto', 'cli', 'app'].includes(codex.cliSource) || typeof codex.bypassHookTrust !== 'boolean' ||
        Object.hasOwn(codex, 'profile') && !identifier(codex.profile)) {
      fail('protocolInvalid', 'The Codex introspection configuration is invalid.');
    }
  }
  if (Buffer.byteLength(JSON.stringify(frame)) > INTROSPECTION_MAX_BYTES) fail('protocolTooLarge', 'The introspect frame exceeds its byte limit.');
  return frame;
}

export function isIntrospectionResponse(frame) {
  if (!object(frame) || frame.protocolVersion !== ADAPTER_PROTOCOL_VERSION || frame.type !== 'introspection' ||
      !['supported', 'unsupported'].includes(frame.status) || !object(frame.environment)) return false;
  if (frame.environment.status === 'unavailable' ? !code(frame.environment.code) : frame.environment.status !== 'available') return false;
  const { models = [] } = frame;
  return Array.isArray(models) && models.length <= 128 &&
    models.every((model) => object(model) && identifier(model.id)
      && (model.efforts === undefined || validEfforts(model.efforts))
      && (model.defaultEffort === undefined || identifier(model.defaultEffort))
      && (model.isDefault === undefined || typeof model.isDefault === 'boolean')
      && (model.displayName === undefined || boundedText(model.displayName, 256))
      && (model.description === undefined || boundedText(model.description, 512))) &&
    new Set(models.map((model) => model.id)).size === models.length && models.filter((model) => model.isDefault).length <= 1 &&
    (frame.supportedEfforts === undefined || validEfforts(frame.supportedEfforts)) &&
    (frame.defaultModel === undefined || identifier(frame.defaultModel)) &&
    (frame.defaultEffort === undefined || identifier(frame.defaultEffort)) &&
    (frame.diagnostics === undefined || Array.isArray(frame.diagnostics) && frame.diagnostics.length <= 64 &&
      frame.diagnostics.every((entry) => object(entry) && code(entry.code) && boundedText(entry.message, 2048)
        && (entry.field === undefined || boundedText(entry.field, 256)))) &&
    Buffer.byteLength(JSON.stringify(frame)) <= INTROSPECTION_MAX_BYTES;
}
