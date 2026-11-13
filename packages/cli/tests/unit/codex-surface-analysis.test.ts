import { describe, expect, it } from 'vitest';
import { normalizePluginConfigDefinition, type ExpectedComponentSet } from '@lesliechan721/aw-plugin-core/manifest';
import type { NormalizedPluginManifest } from '../../src/types.js';
import { analyzeCodexSurface } from '../../src/utils/codex-surface-analysis.js';

function manifest(overrides: Partial<NormalizedPluginManifest> = {}): NormalizedPluginManifest {
  return { schemaVersion: 4, name: 'surface-fixture', version: '1.0.0', description: 'Surface fixture.',
    marketplace: { category: 'development', strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_USE' } }, ...overrides };
}

describe('Codex static and prepared component surfaces', () => {
  it('reports only the selected platform configuration inputs', () => {
    const config = normalizePluginConfigDefinition({ schemaVersion: 5,
      fields: { shared: { type: 'boolean' } }, platforms: {
        codex: { fields: { codexOnly: { type: 'string' } } }, claude: { fields: { claudeOnly: { type: 'string' } } },
      } });
    expect(analyzeCodexSurface(manifest({ config })).configInputs).toEqual(['codexOnly', 'shared']);
  });

  it('classifies readable static declarations without removed author categories', () => {
    const result = analyzeCodexSurface(manifest({ skills: './skills', mcpServers: './mcp.json',
      extensions: { nativeHooks: { codex: [{ id: 'start', event: 'SessionStart', feedback: 'context', command: 'node hook.mjs' }] },
        instructions: [{ name: 'policy', title: 'Policy', content: 'Use policy.', coverage: ['main'] }],
        agents: [{ name: 'reviewer', description: 'Review.', prompt: 'Review.' }] } }));
    expect(result).toMatchObject({ ok: true, nativeKinds: ['skill', 'mcp', 'hook', 'instruction'],
      extensionKinds: ['agent'], classification: 'mixed', dynamicComponents: 'not-declared' });
  });

  it('leaves the dynamic collection unprepared and never executes its renderer', () => {
    const result = analyzeCodexSurface(manifest({ artifacts: { configKeys: [] },
      scripts: { artifacts: { render: { runner: 'node', path: './renderer-that-must-not-run.mjs' } } } }));
    expect(result).toMatchObject({ ok: true, components: [], nativeKinds: [], extensionKinds: [],
      dynamicComponents: 'unprepared', classification: 'empty' });
  });

  it('consumes the actual full prepared set and excludes omitted or unmet entries', () => {
    const prepared: ExpectedComponentSet = { components: [
      { id: 'computed', kind: 'skill', name: 'renamed-skill', content: { files: { 'SKILL.md': { text: 'body' } } } },
      { id: 'role', kind: 'agent', name: 'reviewer', content: { description: 'Review.', prompt: 'Review.' } },
    ], omitted: [{ id: 'closed', kind: 'instruction', reason: 'config-disabled' }],
    unmet: [{ id: 'blocked', kind: 'hook', requiredFeatures: [{ feature: 'hook.common.before_tool', values: ['block'] }], reasonCode: 'interface-unsupported' }],
    sources: { computed: 'dynamic', role: 'static', closed: 'dynamic', blocked: 'dynamic' } };
    const result = analyzeCodexSurface(manifest({ artifacts: { configKeys: [] } }), { preparedComponents: prepared });
    expect(result).toMatchObject({ dynamicComponents: 'prepared', nativeKinds: ['skill'], extensionKinds: ['agent'] });
    expect(result.components.map(({ key, name, dynamic }) => ({ key, name, dynamic }))).toEqual([
      { key: 'computed', name: 'renamed-skill', dynamic: true }, { key: 'role', name: 'reviewer', dynamic: false },
    ]);
  });
});
