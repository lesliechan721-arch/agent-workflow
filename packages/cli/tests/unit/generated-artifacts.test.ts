import { describe, expect, it } from 'vitest';

import {
  createGeneratedArtifactContentDigest,
  getGeneratedArtifactsFromError,
  mergeGeneratedArtifacts,
} from '../../src/utils/generated-artifacts.js';

describe('generated artifacts', () => {
  it('deduplicates hook artifacts by canonical hook identity regardless of order', () => {
    const merged = mergeGeneratedArtifacts(
      [
        {
          path: '/tmp/hooks.json',
          kind: 'hook',
          platform: 'codex',
          hookGroups: [
            { event: 'Stop', command: 'echo stop' },
            { event: 'PreToolUse', command: 'echo pre' },
          ],
        },
      ],
      [
        {
          path: '/tmp/hooks.json',
          kind: 'hook',
          platform: 'codex',
          hookGroups: [
            { event: 'PreToolUse', command: 'echo pre' },
            { event: 'Stop', command: 'echo stop' },
          ],
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      path: '/tmp/hooks.json',
      kind: 'hook',
      platform: 'codex',
    });
  });

  it('does not merge MCP server artifacts that share a file but use different keys', () => {
    const merged = mergeGeneratedArtifacts(
      [
        {
          path: '/repo/.codex/config.toml',
          kind: 'mcpServer',
          platform: 'codex',
          artifactKey: 'acme.tools v1',
        },
      ],
      [
        {
          path: '/repo/.codex/config.toml',
          kind: 'mcpServer',
          platform: 'codex',
          artifactKey: 'search',
        },
      ],
      [
        {
          path: '/repo/.codex/config.toml',
          kind: 'mcpServer',
          platform: 'codex',
          artifactKey: 'search',
        },
      ],
    );

    expect(merged).toHaveLength(2);
    expect(merged.map((artifact) => artifact.artifactKey)).toEqual([
      'acme.tools v1',
      'search',
    ]);
  });

  it('does not merge dynamic instruction artifacts that share a file but use different ids', () => {
    const merged = mergeGeneratedArtifacts(
      [
        {
          path: '/repo/.codex/config.toml',
          paths: ['/repo/.codex/config.toml'],
          kind: 'instruction',
          platform: 'codex',
          id: 'instruction-a',
          target: 'codex.developerInstructionsBlock',
          state: 'present',
          refreshKeys: ['mode'],
          configDigest: 'sha256:config-a',
          contentDigest: 'sha256:content-a',
        },
      ],
      [
        {
          path: '/repo/.codex/config.toml',
          paths: ['/repo/.codex/config.toml'],
          kind: 'instruction',
          platform: 'codex',
          id: 'instruction-b',
          target: 'codex.developerInstructionsBlock',
          state: 'disabled',
          disabledReason: 'config',
          refreshKeys: ['mode'],
          configDigest: 'sha256:config-b',
          contentDigest: 'sha256:content-b',
        },
      ],
    );

    expect(merged).toHaveLength(2);
    expect(merged.map((artifact) => artifact.id)).toEqual([
      'instruction-a',
      'instruction-b',
    ]);
  });

  it('creates stable content digests for structured tracking metadata', () => {
    expect(createGeneratedArtifactContentDigest({
      state: 'disabled',
      target: 'codex.developerInstructionsBlock',
      disabledReason: 'config',
    })).toBe(createGeneratedArtifactContentDigest({
      disabledReason: 'config',
      target: 'codex.developerInstructionsBlock',
      state: 'disabled',
    }));
  });

  it('accepts repo-managed artifact kinds and preserves artifactKey on error carriers', () => {
    const error = Object.assign(new Error('boom'), {
      generatedArtifacts: [
        {
          path: '/repo/.agents/skills/commit',
          kind: 'skill',
          platform: 'codex',
          artifactKey: 'commit',
          id: 'commit-skill',
          target: 'codex.skill',
          state: 'present',
          refreshKeys: ['mode'],
          configDigest: 'sha256:config',
          contentDigest: 'sha256:content',
        },
        {
          path: '/repo/.codex/config.toml',
          kind: 'mcpServer',
          platform: 'codex',
          artifactKey: 'acme.tools v1',
        },
      ],
    });

    expect(getGeneratedArtifactsFromError(error)).toEqual([
      {
        path: '/repo/.agents/skills/commit',
        kind: 'skill',
        platform: 'codex',
        artifactKey: 'commit',
        id: 'commit-skill',
        target: 'codex.skill',
        state: 'present',
        refreshKeys: ['mode'],
        configDigest: 'sha256:config',
        contentDigest: 'sha256:content',
      },
      {
        path: '/repo/.codex/config.toml',
        kind: 'mcpServer',
        platform: 'codex',
        artifactKey: 'acme.tools v1',
      },
    ]);
  });
});
