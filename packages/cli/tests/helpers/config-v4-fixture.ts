import { normalizePluginConfigDefinition } from '@lesliechan721/aw-plugin-core/manifest';

/** A generic executor registry exercises the public config contract without running a backend. */
export function createConfigV4Definition() {
  const string = { type: 'string', validation: { maxLength: 4096, pattern: '^[^\\x00]*$' } };
  const mode = { type: 'string', choices: { allowCustom: false, presets: [
    { id: 'workspace', title: 'Workspace', value: 'workspace' },
    { id: 'bundle', title: 'Bundle', value: 'bundle' },
  ] } };
  const model = { type: 'string', validation: { minLength: 1 } };
  const reasoningEffort = { type: 'string', choices: { allowCustom: false, presets: [
    { id: 'medium', title: 'Medium', value: 'medium' },
    { id: 'high', title: 'High', value: 'high' },
  ] } };
  const variableName = { maxLength: 128, pattern: '^[A-Za-z_][A-Za-z0-9_]*$' };
  const fixedMode = (value: string) => ({ type: 'string', const: value,
    choices: { allowCustom: false, presets: [{ id: value, title: value, value }] } });
  return normalizePluginConfigDefinition({
    schemaVersion: 4,
    fields: {
      subagentCommands: { type: 'array', default: [], validation: { uniqueBy: 'key' }, items: {
        type: 'object', properties: {
          key: { type: 'string', required: true, validation: { minLength: 1 } },
          title: { type: 'string', required: true, validation: { minLength: 1 } },
          adapter: { type: 'string', required: true, choices: { allowCustom: false, presets: [
            ...['codex', 'claude-code', 'oracle', 'custom'].map((value) => ({ id: value, title: value, value })),
          ] } },
          args: { type: 'array', items: string },
          env: { type: 'object', additionalProperties: string, validation: { key: variableName } },
          envFrom: { type: 'object', additionalProperties: { type: 'string', validation: variableName }, validation: { key: variableName } },
        }, variants: {
          discriminator: 'adapter', cases: {
            codex: { properties: { mode: fixedMode('workspace') } },
            'claude-code': { properties: { mode: fixedMode('workspace') } },
            oracle: { properties: { mode: fixedMode('bundle') } },
            custom: { properties: { mode: { ...mode, required: true }, command: { type: 'string', required: true }, entrypoint: { type: 'string' } } },
          },
        },
      } },
      advisorProfile: { type: 'object', properties: {
        executor: { type: 'string', valueRef: { field: 'subagentCommands', key: 'key', include: ['native'] } },
      }, variants: {
        discriminator: 'executor', missing: 'native', cases: {
          native: { properties: { model: { ...model, required: true }, reasoningEffort: { ...reasoningEffort, required: true } } },
        }, otherwise: { properties: { model, reasoningEffort } },
      } },
    },
  });
}
