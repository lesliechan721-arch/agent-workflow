import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const manifest = JSON.parse(await readFile(path.join(root, '.agents-plugin/plugin.json'), 'utf8'));
const defaults = Object.fromEntries(Object.entries(manifest.config.fields)
  .filter(([, field]) => Object.hasOwn(field, 'default')).map(([key, field]) => [key, field.default]));

// A deterministic author profile for script tests, not client qualification.
export function context(values = {}, platform = 'codex', kinds = ['skill', 'agent']) {
  const scope = 'user';
  return { schemaVersion: 1, surface: 'agent-plugin', platform, scope,
    allowedOutputKinds: kinds, changedConfigKeys: [], previousComponents: [],
    config: { values: { ...structuredClone(defaults), ...values } },
    platformCapabilities: { schemaVersion: 1, platform, scope, basis: 'profile', profileId: 'script-test', consumers: [],
      kinds: Object.fromEntries(['skill', 'mcp', 'agent', 'hook', 'instruction'].map((kind) => [kind,
        { status: 'supported', reasonCodes: [], delivery: ['native-package'] }])),
      features: { 'agent.execution': { status: 'supported', reasonCodes: [], values: ['isolated-context'] },
        'agent.prompt-mode': { status: 'supported', reasonCodes: [], values: ['host-default'] },
        'agent.declaration-protocol': { status: 'supported', reasonCodes: [], values: ['aw.pi.agents.v1'] } } },
    resources: manifest.artifacts.sourceDirs.map((name) => ({ kind: 'bundle', name, root: path.resolve(root, name), digest: 'test-resource' })),
  };
}
export function component(plan, id) { return plan.components.find((item) => item.id === id); }
export async function resourceText(file) {
  return 'text' in file ? file.text : readFile(path.join(root, file.source.path), 'utf8');
}
