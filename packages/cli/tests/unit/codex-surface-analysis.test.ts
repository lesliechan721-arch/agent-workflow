import { describe, expect, it } from 'vitest';
import { normalizePluginConfigDefinition } from '@lesliechan721/aw-plugin-core/manifest';

import type { NormalizedPluginManifest } from '../../src/types.js';
import {
  analyzeCodexSurface,
  assertCodexSurfaceSupported,
} from '../../src/utils/codex-surface-analysis.js';

function manifest(
  overrides: Partial<NormalizedPluginManifest> = {},
): NormalizedPluginManifest {
  return {
    schemaVersion: 3,
    name: 'surface-fixture',
    version: '1.0.0',
    description: 'Surface fixture.',
    marketplace: {
      category: 'development',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
    },
    ...overrides,
  };
}

describe('codex-surface-analysis', () => {
  // Surface reports must include this platform's configuration inputs without fields from another profile.
  it('reports the compiled Codex configuration inputs', () => {
    const config = normalizePluginConfigDefinition({
      schemaVersion: 5,
      fields: { shared: { type: 'boolean' } },
      platforms: {
        codex: { fields: { codexOnly: { type: 'string' } } },
        claude: { fields: { claudeOnly: { type: 'string' } } },
      },
    });
    expect(analyzeCodexSurface(manifest({ config })).configInputs).toEqual(['codexOnly', 'shared']);
  });

  it('allows only the qualified static native kinds and permits shared scope activation', () => {
    const analysis = analyzeCodexSurface(manifest({
      skills: './skills',
      mcpServers: './mcp.json',
      apps: './apps.json',
      extensions: {
        nativeHooks: {
          codex: [{ event: 'SessionStart', command: 'node hook.mjs' }],
        },
      },
    }));

    expect(analysis).toMatchObject({
      ok: true,
      nativeKinds: ['skill', 'mcp', 'hook', 'app'],
      extensionKinds: [],
      unsupportedKinds: [],
      classification: 'native',
      deliveryOwner: 'codex-native',
      scopeOverlap: 'native-compatible',
    });
  });

  it('keeps dynamic Skills Native and instruction, permission, and agent extensions AW-owned', () => {
    const analysis = analyzeCodexSurface(manifest({
      skills: './skills',
      config: { fields: { mode: { type: 'string' } } },
      scripts: {
        artifacts: { render: { runner: 'node', path: './render.mjs' } },
      },
      extensions: {
        instructions: [{ name: 'policy', title: 'Policy', content: 'Use policy.' }],
        permissions: [{ name: 'safe', allow: ['Read'] }],
        agents: [{ name: 'reviewer', description: 'Review.', prompt: 'Review.' }],
      },
      artifacts: {
        targets: [{
          id: 'dynamic-skill',
          platform: 'codex',
          target: 'codex.skill',
          kind: 'skill',
          projectManagedKind: 'skill',
          scopes: ['project', 'user'],
          states: ['present'],
          refreshKeys: ['mode'],
          skillKey: 'generated-review',
          sourceDirs: ['./skills/generated-review'],
        }],
      },
    }), {
      nativeArtifactNames: { skill: ['static-review'] },
    });

    expect(analysis).toMatchObject({
      ok: true,
      nativeKinds: ['skill'],
      configInputs: ['mode'],
      extensionKinds: ['instruction', 'permission', 'agent'],
      classification: 'mixed',
      deliveryOwner: 'split',
      scopeOverlap: 'aw-owned-conflict',
    });
    expect(analysis.components.find((component) => component.key === 'artifacts.targets:dynamic-skill'))
      .toMatchObject({ owner: 'codex-native', dynamic: true, name: 'generated-review' });
  });

  it('treats config as input and preApply as target-local behavior', () => {
    const configOnly = analyzeCodexSurface(manifest({
      config: { fields: { mode: { type: 'string' } } },
    }));
    expect(configOnly).toMatchObject({
      ok: true,
      nativeKinds: [],
      configInputs: ['mode'],
      extensionKinds: [],
      classification: 'empty',
      deliveryOwner: 'none',
      scopeOverlap: 'none',
    });

    const nativeAndConfig = analyzeCodexSurface(manifest({
      skills: './skills',
      config: { fields: { mode: { type: 'string' } } },
    }));
    expect(nativeAndConfig).toMatchObject({
      ok: true,
      nativeKinds: ['skill'],
      configInputs: ['mode'],
      extensionKinds: [],
      classification: 'native',
      deliveryOwner: 'codex-native',
      scopeOverlap: 'native-compatible',
    });

    const nativeAndPreApply = analyzeCodexSurface(manifest({
      skills: './skills',
      scripts: {
        preApply: { path: './pre-apply.mjs' },
      },
    }));
    expect(nativeAndPreApply).toMatchObject({
      ok: true,
      nativeKinds: ['skill'],
      extensionKinds: [],
      classification: 'native',
      deliveryOwner: 'codex-native',
      scopeOverlap: 'native-compatible',
    });

    expect(analyzeCodexSurface(manifest())).toMatchObject({
      classification: 'empty',
      extensionKinds: [],
    });
  });

  it('fails closed for slash commands because qualification has no runtime evidence', () => {
    const analysis = analyzeCodexSurface(manifest({ slashCommands: './commands' }));

    expect(analysis).toMatchObject({
      ok: false,
      nativeKinds: [],
      unsupportedKinds: ['slashCommand'],
      classification: 'unsupported',
      errorCode: 'codexNativeKindUnsupported',
    });
    expect(() => assertCodexSurfaceSupported(analysis)).toThrow(
      expect.objectContaining({ code: 'codexNativeKindUnsupported' }),
    );
  });

  it('classifies native dynamic skills as Codex-owned native output', () => {
    const analysis = analyzeCodexSurface(manifest({
      artifacts: {
        targets: [{
          id: 'native-dynamic',
          platform: 'codex',
          target: 'codex.skill',
          kind: 'skill',
          projectManagedKind: 'skill',
          scopes: ['user'],
          states: ['present'],
          refreshKeys: [],
          skillKey: 'native-dynamic',
        }],
      },
    }));

    expect(analysis).toMatchObject({
      ok: true,
      nativeKinds: ['skill'],
      extensionKinds: [],
      classification: 'native',
      deliveryOwner: 'codex-native',
    });
    expect(analysis.components).toContainEqual(expect.objectContaining({
      owner: 'codex-native',
      dynamic: true,
      scopes: ['project', 'user'],
      name: 'native-dynamic',
    }));
  });

});
