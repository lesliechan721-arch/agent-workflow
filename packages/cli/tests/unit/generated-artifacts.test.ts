import { describe, expect, it } from 'vitest';

import {
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

  it('accepts repo-managed artifact kinds and preserves artifactKey on error carriers', () => {
    const error = Object.assign(new Error('boom'), {
      generatedArtifacts: [
        {
          path: '/repo/.agents/skills/commit',
          kind: 'skill',
          platform: 'codex',
          artifactKey: 'commit',
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
