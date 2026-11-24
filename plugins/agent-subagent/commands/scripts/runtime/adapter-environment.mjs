import { fail } from './contracts.mjs';

const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const protectedVariable = (key) => /^AW_NATIVE_/i.test(key) || key.startsWith('AW_PLUGIN_') || key.startsWith('AW_SUBAGENT_') || key === 'AW_AGENT_SKILL_EVAL_PROCESS_MARKER';
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function validateEnvironmentConfig(executor) {
  const managed = executor.adapter === 'custom-managed';
  const protectedName = (key) => managed ? /^(?:AW_PLUGIN_|AW_SUBAGENT_|AW_COMMAND_|AW_NATIVE_)/i.test(key) || /^(?:AW_AGENT_SKILL_EVAL_PROCESS_MARKER|AW_HOME|AW_CODEX_HOME|AW_CLAUDE_HOME)$/i.test(key) : protectedVariable(key);
  for (const field of ['env', 'envFrom']) {
    const values = Object.hasOwn(executor, field) ? executor[field] : {};
    if (!plainObject(values) || Object.entries(values).some(([key, value]) => !variableName.test(key) || protectedName(key) || typeof value !== 'string' || value.includes('\0') || !value.isWellFormed() || (field === 'envFrom' && (!variableName.test(value) || protectedName(value))))) fail('environmentInvalid', 'Use valid ordinary environment names and host references; AW control variables cannot be customized.');
  }
  const targetKey = (key) => managed && process.platform === 'win32' ? key.toUpperCase() : key;
  const keys = [...Object.keys(executor.env ?? {}), ...Object.keys(executor.envFrom ?? {})].map(targetKey);
  if (new Set(keys).size !== keys.length) fail('environmentConflict', 'A target variable cannot occur in both env and envFrom.');
}

export function resolveAdapterEnvironment(source = process.env, executor = {}) {
  validateEnvironmentConfig(executor);
  const host = { ...source };
  const managed = executor.adapter === 'custom-managed';
  const environment = Object.fromEntries(Object.entries(host).filter(([key, value]) => typeof value === 'string' &&
    !(managed ? /^AW_(?:PLUGIN|SUBAGENT|COMMAND)_/i.test(key) : key.startsWith('AW_PLUGIN_') || key.startsWith('AW_SUBAGENT_') || /^AW_COMMAND_/i.test(key))));
  const referenced = {};
  const secretValues = [];
  for (const [target, origin] of Object.entries(executor.envFrom ?? {})) {
    const sourceKey = managed && process.platform === 'win32' ? Object.keys(host).find((key) => key.toUpperCase() === origin.toUpperCase()) : origin;
    if (sourceKey === undefined || !Object.hasOwn(host, sourceKey) || typeof host[sourceKey] !== 'string') fail('environmentSourceMissing', 'A configured envFrom host variable is missing. Set the source variable before running.');
    if (host[sourceKey].includes('\0')) fail('environmentInvalid', 'An envFrom host value contains NUL.');
    referenced[target] = host[sourceKey];
    secretValues.push(host[sourceKey]);
  }
  for (const [target, value] of Object.entries({ ...(executor.env ?? {}), ...referenced })) {
    if (managed && process.platform === 'win32') for (const key of Object.keys(environment)) {
      if (key.toUpperCase() === target.toUpperCase()) delete environment[key];
    }
    environment[target] = value;
  }
  return { environment, secretValues };
}
export function adapterEnvironment(source = process.env, executor = {}) {
  return resolveAdapterEnvironment(source, executor).environment;
}
