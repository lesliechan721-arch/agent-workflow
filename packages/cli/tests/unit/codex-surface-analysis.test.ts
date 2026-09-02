import { describe, expect, it } from 'vitest';

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

  it('keeps renderer output and instruction, permission, and agent extensions AW-owned', () => {
    const analysis = analyzeCodexSurface(manifest({
      skills: './skills',
      config: { schema: { mode: { type: 'string' } } },
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
      extensionKinds: ['skill', 'instruction', 'permission', 'agent', 'config'],
      classification: 'mixed',
      deliveryOwner: 'split',
      scopeOverlap: 'aw-owned-conflict',
    });
    expect(analysis.components.find((component) => component.key === 'artifacts.targets:dynamic-skill'))
      .toMatchObject({ owner: 'aw', dynamic: true, name: 'generated-review' });
  });

  it('treats config as AW-owned evidence and postApply as target-local behavior', () => {
    const configOnly = analyzeCodexSurface(manifest({
      config: { schema: { mode: { type: 'string' } } },
    }));
    expect(configOnly).toMatchObject({
      ok: true,
      nativeKinds: [],
      extensionKinds: ['config'],
      classification: 'aw-extension',
      deliveryOwner: 'aw',
      scopeOverlap: 'aw-owned-conflict',
    });

    const nativeAndConfig = analyzeCodexSurface(manifest({
      skills: './skills',
      config: { schema: { mode: { type: 'string' } } },
    }));
    expect(nativeAndConfig).toMatchObject({
      ok: true,
      nativeKinds: ['skill'],
      extensionKinds: ['config'],
      classification: 'mixed',
      deliveryOwner: 'split',
      scopeOverlap: 'aw-owned-conflict',
    });

    const nativeAndPostApply = analyzeCodexSurface(manifest({
      skills: './skills',
      scripts: {
        postApply: { path: './post-apply.mjs' },
      },
    }));
    expect(nativeAndPostApply).toMatchObject({
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

  it('fails closed when native and AW owners claim the same final skill name', () => {
    const analysis = analyzeCodexSurface(manifest({
      skills: './skills',
      scripts: {
        artifacts: { render: { runner: 'node', path: './render.mjs' } },
      },
      artifacts: {
        targets: [{
          id: 'dynamic-skill',
          platform: 'codex',
          target: 'codex.skill',
          kind: 'skill',
          projectManagedKind: 'skill',
          scopes: ['project'],
          states: ['present'],
          refreshKeys: [],
          skillKey: 'review',
          sourceDirs: ['./skills/review'],
        }],
      },
    }), {
      nativeArtifactNames: { skill: ['review'] },
    });

    expect(analysis).toMatchObject({
      ok: false,
      classification: 'unsupported',
      errorCode: 'codexSurfaceOwnerCollision',
      collisions: [{ kind: 'skill', name: 'review', owners: ['codex-native', 'aw'] }],
    });
  });

  it('fails closed when a same-kind dynamic artifact has no complete native identity evidence', () => {
    const analysis = analyzeCodexSurface(manifest({
      skills: './skills',
      artifacts: {
        targets: [{
          id: 'dynamic-skill',
          platform: 'codex',
          target: 'codex.skill',
          kind: 'skill',
          projectManagedKind: 'skill',
          scopes: ['project'],
          states: ['present'],
          refreshKeys: [],
          skillKey: 'review',
          sourceDirs: ['./skills/review'],
        }],
      },
    }));

    expect(analysis).toMatchObject({
      ok: false,
      classification: 'unsupported',
      errorCode: 'codexSurfaceNativeIdentityMissing',
      missingNativeIdentityKinds: ['skill'],
      collisions: [],
    });
    expect(() => assertCodexSurfaceSupported(analysis)).toThrow(
      expect.objectContaining({ code: 'codexSurfaceNativeIdentityMissing' }),
    );
  });
});
