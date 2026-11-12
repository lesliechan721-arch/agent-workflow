import path from 'node:path';

/** Minimal Codex CLI 0.167.0 config/read shape, including flattened projects. */
export function configReadResponse(cwd: string, codexHome: string, trust: 'trusted' | 'untrusted', key = cwd) {
  const source = { type: 'user', file: path.join(codexHome, 'config.toml'), profile: null };
  const version = `sha256:${'a'.repeat(64)}`;
  const projects = { [key]: { trust_level: trust } };
  return { config: { projects }, origins: { [`projects.${key}.trust_level`]: { name: source, version } },
    layers: [{ name: { type: 'project', dotCodexFolder: path.join(cwd, '.codex') }, version, config: { model: 'project-layer' },
      ...(trust === 'untrusted' ? { disabledReason: 'The project is untrusted in the effective configuration.' } : {}) },
    { name: source, version, config: { projects } }] };
}
