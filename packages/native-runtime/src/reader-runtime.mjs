export const NATIVE_TOOL_CONTEXT_ENV = 'AW_NATIVE_TOOL_CONTEXT';

// This standalone module is also the canonical text emitted into plugin bundles.
export function readNativeTool(key, protocol, environment = process.env) {
  function reject() {
    const error = new Error('nativeContextInvalid');
    error.code = 'nativeContextInvalid';
    throw error;
  }
  function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  if (typeof key !== 'string' || !key || typeof protocol !== 'string' || !protocol) reject();
  const names = Object.keys(environment).filter((name) => name.toUpperCase() === 'AW_NATIVE_TOOL_CONTEXT');
  if (names.length !== 1 || typeof environment[names[0]] !== 'string' || environment[names[0]].length > 128 * 1024) reject();
  let context;
  try { context = JSON.parse(environment[names[0]]); } catch { reject(); }
  if (!record(context) || context.schemaVersion !== 1 || Object.keys(context).sort().join(',') !== 'schemaVersion,tools'
    || !record(context.tools) || Object.keys(context.tools).length > 64) reject();
  for (const [name, value] of Object.entries(context.tools)) {
    if (!name || !record(value) || typeof value.protocol !== 'string' || !value.protocol) reject();
    if (value.state === 'ready') {
      if (Object.keys(value).sort().join(',') !== 'executable,protocol,sha256,state'
        || typeof value.executable !== 'string' || value.executable.length > 32_768
        || !/^(?:\/[^\x00]*|[A-Za-z]:[\\/][^\x00]*|\\\\[^\x00]+)$/.test(value.executable)
        || /[\x00-\x1f\x7f]/.test(value.executable) || !/^sha256:[a-f0-9]{64}$/.test(value.sha256)) reject();
    } else if (value.state === 'unavailable') {
      if (Object.keys(value).sort().join(',') !== 'code,protocol,state'
        || typeof value.code !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{0,95}$/.test(value.code)) reject();
    } else reject();
  }
  if (!Object.hasOwn(context.tools, key) || context.tools[key].protocol !== protocol) reject();
  return Object.freeze({ ...context.tools[key] });
}
