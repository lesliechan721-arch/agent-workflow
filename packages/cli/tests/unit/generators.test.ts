import { describe, expect, it } from 'vitest';

import { generateAgentArtifacts } from '../../src/generators/agents.js';
import { renderHooksArtifact } from '../../src/generators/hooks.js';
import { generateInstructionArtifacts } from '../../src/generators/instructions.js';
import {
  generateCodexPermissionArtifacts,
  mergeClaudePermissions,
} from '../../src/generators/permissions.js';

describe('generators', () => {
  it('renders instruction outputs for both platforms', () => {
    const instructions = [
      {
        name: 'commit-policy',
        title: '提交规范',
        content: '按 Conventional Commits 提交。',
        paths: ['src/**'],
      },
    ];

    expect(generateInstructionArtifacts('git-commit', instructions, 'codex')[0]).toMatchObject({
      relativePath: 'AGENTS.md',
    });
    expect(generateInstructionArtifacts('git-commit', instructions, 'claude')[0]).toMatchObject({
      relativePath: 'rules/aw-git-commit-commit-policy.md',
    });
  });

  it('merges Claude permissions and renders Codex execpolicy files', () => {
    const permissions = [
      {
        name: 'git-ops',
        allow: ['git status', 'git diff'],
        ask: ['git commit'],
      },
    ];

    expect(mergeClaudePermissions(permissions)).toEqual({
      allow: ['git status', 'git diff'],
      ask: ['git commit'],
      deny: [],
    });
    expect(generateCodexPermissionArtifacts('git-commit', permissions)[0].content).toContain(
      'ask git commit',
    );
  });

  it('keeps only command hooks for Codex and emits full Claude hooks', () => {
    const hooks = [
      {
        event: 'before_tool' as const,
        command: 'echo before',
      },
      {
        event: 'command' as const,
        matcher: 'git *',
        command: 'echo git hook',
      },
    ];

    expect(renderHooksArtifact(hooks, 'codex')?.content).toEqual({
      commands: [{ matcher: 'git *', command: 'echo git hook', description: undefined }],
    });
    expect(
      (renderHooksArtifact(hooks, 'claude')?.content.hooks as Array<Record<string, unknown>>)[0]
        .event,
    ).toBe('beforeToolUse');
  });

  it('renders agent definitions for both platforms', () => {
    const agents = [
      {
        name: 'commit-reviewer',
        description: '检查提交',
        prompt: '检查提交信息',
        tools: ['shell'],
      },
    ];

    expect(generateAgentArtifacts('git-commit', agents, 'codex')[0].relativePath).toBe(
      'agents/aw-git-commit-commit-reviewer.json',
    );
    expect(generateAgentArtifacts('git-commit', agents, 'claude')[0].content).toContain(
      '## Prompt',
    );
  });
});

