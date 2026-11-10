import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPluginDependencyPlatformCoverage, assertPluginManifestStructure, compilePluginConfigDefinition,
  createRuntimeConfigSnapshot, NATIVE_PLATFORM_TARGETS, normalizePlatformTargets, PLATFORM_TARGETS,
  PORTABLE_PLATFORM_TARGETS, renderTemplate, resolveSupportedNativePlatforms, resolveSupportedPlatforms,
  validatePluginManifest, validateSourcePluginManifest,
} from '../../src/manifest.js';
import type { PlatformTarget } from '../../src/types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.remove(root))); });
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 4, name: 'consumer', version: '1.0.0', description: 'Platform fixture.', marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }, ...overrides };
}
describe('canonical platform registry', () => {
  it('defaults to ten targets and distinguishes Native installation from the generic Portable writer', () => {
    const expected = ['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'gemini', 'copilot', 'grok', 'generic'];
    expect(PLATFORM_TARGETS).toEqual(expected);
    for (const platforms of [undefined, []]) {
      const parsed = validatePluginManifest('/tmp/consumer', manifest({ platforms }));
      expect([...resolveSupportedPlatforms(parsed)]).toEqual(expected);
      expect([...resolveSupportedNativePlatforms(parsed)]).toEqual(expected.slice(0, -1));
    }
    expect(NATIVE_PLATFORM_TARGETS).not.toContain('generic');
    expect(PORTABLE_PLATFORM_TARGETS).toEqual(['generic']);
    expect([...resolveSupportedPlatforms(validatePluginManifest('/tmp/consumer', manifest({ platforms: ['grok', 'gemini'] })))]).toEqual(['grok', 'gemini']);
  });
  it.each([null, '', 'codex', [''], ['unknown'], ['claude-code'], ['agent-skills'], ['codex', 'codex']])('rejects invalid platform input %#', (platforms) => {
    expect(() => assertPluginManifestStructure(manifest({ platforms }))).toThrow();
    expect(() => normalizePlatformTargets(platforms)).toThrow();
  });
  it('keeps transitive dependency platform requirements complete', () => {
    expect(() => assertPluginDependencyPlatformCoverage({ source: 'example', consumer: { name: 'consumer', platforms: ['codex', 'gemini'] }, dependency: { name: 'dependency', platforms: ['codex'] }, path: ['root', 'consumer', 'dependency'] })).toThrow(/gemini.*root -> consumer -> dependency/u);
  });
  it('uses new platform keys in config, templates, resource selectors and entry overrides', () => {
    for (const platform of ['gemini', 'copilot', 'grok'] as const) {
      const parsed = validatePluginManifest('/tmp/consumer', manifest({ platforms: [platform],
        config: { schemaVersion: 5, fields: { selection: { type: 'string', default: 'common' } }, platforms: { [platform]: { fields: { selection: { type: 'string', default: platform } } } } },
        buildConfig: { templates: { vars: { HOST: { [platform]: platform } }, include: ['resources/*.md'] }, fileRules: { [platform]: { include: ['**'], exclude: [] } }, generatedSkillRuntimeFiles: [{ skill: 'check', target: 'scripts/check.mjs', platforms: [platform] }] },
        extensions: { agents: [{ name: 'role', description: 'Role', prompt: 'Read.', agentOverrides: { [platform]: { name: 'renamed' } } }], instructions: [{ name: 'rules', title: 'Rules', content: 'Check.', coverage: ['main'], agentOverrides: { [platform]: null } }] },
      }));
      expect(compilePluginConfigDefinition(parsed.config, platform).fields.selection?.default).toBe(platform);
      expect(renderTemplate('{{HOST}}', parsed.buildConfig!.templates!.vars, platform)).toBe(platform);
      expect(parsed.extensions?.agents?.[0]?.agentOverrides?.[platform]).toEqual({ name: 'renamed' });
    }
  });
  it('requires renderer config keys to exist in each selected platform profile', () => {
    const raw = manifest({ platforms: ['gemini'], config: { schemaVersion: 5, fields: {}, platforms: { gemini: { fields: { onlyHere: { type: 'boolean' } } } } }, artifacts: { configKeys: ['onlyHere'] }, scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } } });
    expect(() => validatePluginManifest('/tmp/consumer', raw)).not.toThrow();
    expect(() => validatePluginManifest('/tmp/consumer', { ...raw, platforms: ['gemini', 'copilot'] })).toThrow(/unknown config key/u);
  });
  it('rejects fixed target declarations and checks static runtime resource inventory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-core-platforms-')); roots.push(root);
    await fs.ensureDir(path.join(root, 'skills/check')); await fs.writeFile(path.join(root, 'skills/check/SKILL.md'), '---\nname: check\ndescription: Check.\n---\nCheck.\n');
    const raw = manifest({ platforms: ['gemini'], skills: './skills', buildConfig: { generatedSkillRuntimeFiles: [{ skill: 'check', target: 'scripts/check.mjs', platforms: ['gemini'] }] } });
    await expect(validateSourcePluginManifest(root, raw)).resolves.toMatchObject({ platforms: ['gemini'] });
    await expect(validateSourcePluginManifest(root, { ...raw, buildConfig: { generatedSkillRuntimeFiles: [{ skill: 'missing', target: 'scripts/check.mjs' }] } })).rejects.toThrow(/static Skill key/u);
    expect(() => assertPluginManifestStructure(manifest({ artifacts: { targets: [] } }))).toThrow();
  });
  it('binds installed runtime snapshots to each concrete Native platform', () => {
    for (const platform of NATIVE_PLATFORM_TARGETS) {
      expect(createRuntimeConfigSnapshot({ installedIdentity: { sourceId: 'official', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginId: 'official/consumer', pluginName: 'consumer', pluginVersion: '1.0.0', platform, scope: 'user', configScope: 'user', artifactId: 'dynamic-skill', skillKey: 'check' }, declaration: { keys: ['style'] }, definition: { fields: { style: { type: 'string' } } }, values: { style: platform } }).effectiveValues).toEqual({ style: platform as PlatformTarget });
    }
  });
});
