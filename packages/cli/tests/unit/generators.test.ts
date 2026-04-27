import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { parseTOML } from 'toml-eslint-parser';
import { afterEach, describe, expect, it } from 'vitest';

import { generateAgentArtifacts } from '../../src/generators/agents.js';
import { renderHooksArtifact, renderResolvedHooksArtifact } from '../../src/generators/hooks.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import {
  generateCodexPermissionArtifacts,
  mergeClaudePermissions,
} from '../../src/generators/permissions.js';
import { readPluginManifest } from '../../src/utils/manifest.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeTempRepo(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-local-plugin-'));
  tempDirs.push(tempDir);
  await fs.copy(fixturePath('repo-template'), tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('local-plugin generator', () => {
  it('generates Claude and Codex runtime manifests with explicit bundle-local paths', async () => {
    const repoRoot = await makeTempRepo();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    plugin.manifest.extensions ??= {};
    plugin.manifest.extensions.hooks ??= [];
    plugin.manifest.extensions.hooks.push({
      event: 'session_start',
      command: 'echo shared session start',
    });
    plugin.manifest.extensions.nativeHooks = {
      claude: [
        {
          event: 'Notification',
          matcher: '*',
          command: 'echo claude notification',
        },
      ],
      codex: [
        {
          event: 'UserPromptSubmit',
          command: 'echo codex prompt',
        },
      ],
    };
    const outputRoot = path.join(repoRoot, 'out', plugin.manifest.name);

    const result = await bundleLocalPlugin(plugin, outputRoot);

    expect(result.claudeManifest).toMatchObject({
      skills: './claude/skills',
      hooks: './claude/hooks/hooks.json',
      agents: ['./claude/agents/aw-git-commit-commit-reviewer.md'],
    });
    expect(result.codexManifest).toMatchObject({
      skills: './codex/skills',
    });

    await expect(
      fs.readFile(path.join(outputRoot, 'claude', 'agents', 'aw-git-commit-commit-reviewer.md'), 'utf8'),
    ).resolves.toContain('name: "commit-reviewer"');
    await expect(
      fs.pathExists(path.join(outputRoot, 'codex', 'skills', 'commit', 'SKILL.md')),
    ).resolves.toBe(true);
    await expect(
      fs.readJson(path.join(outputRoot, 'claude', 'hooks', 'hooks.json')),
    ).resolves.toEqual({
      hooks: {
        Notification: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'echo claude notification' }],
          },
        ],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo git hook' }],
          },
        ],
        SessionStart: [
          {
            matcher: 'startup|resume|clear',
            hooks: [{ type: 'command', command: 'echo shared session start' }],
          },
        ],
      },
    });
  });

  it('renders Claude agents with frontmatter and Codex agents as valid role-file TOML', () => {
    const [claudeArtifact] = generateAgentArtifacts(
      'git-commit',
      [
        {
          name: 'commit-reviewer',
          description: '检查提交范围和信息是否匹配。',
          prompt: '请检查这次提交是否符合提交规范，并指出 scope 是否准确。',
          tools: ['shell'],
        },
      ],
      'claude',
    );
    expect(claudeArtifact).toMatchObject({
      relativePath: 'agents/aw-git-commit-commit-reviewer.md',
    });
    expect(claudeArtifact.content).toContain('name: "commit-reviewer"');
    expect(claudeArtifact.content).toContain('description:');
    expect(claudeArtifact.content).toContain('tools:');
    expect(claudeArtifact.content).toContain('请检查这次提交是否符合提交规范');

    const [codexArtifact] = generateAgentArtifacts(
      'git-commit',
      [
        {
          name: 'commit-reviewer',
          description: '检查提交范围和信息是否匹配。',
          prompt: '请检查这次提交是否符合提交规范，并指出 scope 是否准确。',
          tools: ['shell'],
        },
      ],
      'codex',
    );
    expect(codexArtifact).toMatchObject({
      relativePath: 'agents/aw-git-commit-commit-reviewer.toml',
    });
    const parsed = parseTOML(codexArtifact.content);
    const rendered = parsed.body[0];
    expect(rendered.type).toBe('TOMLTopLevelTable');
    expect(codexArtifact.content).toContain('name = "commit-reviewer"');
    expect(codexArtifact.content).toContain('description = "检查提交范围和信息是否匹配。');
    expect(codexArtifact.content).toContain('developer_instructions =');
    expect(codexArtifact.content).not.toContain('tools =');
  });

  it('renders public hook event mappings for Claude and Codex runtime contracts', () => {
    const claudeArtifact = renderHooksArtifact([
      {
        event: 'after_tool',
        matcher: 'Edit',
        command: 'echo after',
      },
      {
        event: 'session_start',
        command: 'echo start',
      },
    ], 'claude');
    const codexArtifact = renderHooksArtifact([
      {
        event: 'before_tool',
        matcher: 'Write',
        command: 'echo before',
      },
    ], 'codex');

    expect(claudeArtifact?.content).toEqual({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'echo after' }],
          },
        ],
        SessionStart: [
          {
            matcher: 'startup|resume|clear',
            hooks: [{ type: 'command', command: 'echo start' }],
          },
        ],
      },
    });
    expect(codexArtifact?.content).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo before' }],
          },
        ],
      },
    });
  });

  it('renders hook groups in stable canonical order', () => {
    const artifact = renderResolvedHooksArtifact([
      {
        kind: 'public',
        event: 'before_tool',
        matcher: 'Write',
        command: 'echo write',
      },
      {
        kind: 'public',
        event: 'before_tool',
        matcher: 'Edit',
        command: 'echo edit',
      },
    ], 'codex');

    expect(artifact?.content).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'echo edit' }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo write' }],
          },
        ],
      },
    });
  });

  it('renders native hooks alongside public hooks and omits matcher for matcherless events', () => {
    const claudeArtifact = renderResolvedHooksArtifact([
      {
        kind: 'public',
        event: 'after_tool',
        matcher: 'Edit',
        command: 'echo after',
      },
      {
        kind: 'native',
        event: 'Stop',
        command: 'echo stop',
      },
    ], 'claude');
    const codexArtifact = renderResolvedHooksArtifact([
      {
        kind: 'public',
        event: 'before_tool',
        matcher: 'Write',
        command: 'echo before',
      },
      {
        kind: 'native',
        event: 'UserPromptSubmit',
        command: 'echo prompt',
      },
    ], 'codex');

    expect(claudeArtifact?.content).toEqual({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'echo after' }],
          },
        ],
        Stop: [
          {
            hooks: [{ type: 'command', command: 'echo stop' }],
          },
        ],
      },
    });
    expect(codexArtifact?.content).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo before' }],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: 'echo prompt' }],
          },
        ],
      },
    });
  });

  it('renders permissions into platform-native allow, prompt, and forbidden rules', () => {
    const permissions = [
      {
        name: 'git-ops',
        allow: ['git status'],
        ask: ['git commit'],
        deny: ['git push'],
      },
    ];

    expect(mergeClaudePermissions(permissions)).toEqual({
      allow: ['Bash(git status)'],
      ask: ['Bash(git commit)'],
      deny: ['Bash(git push)'],
    });
    expect(generateCodexPermissionArtifacts('git-commit', permissions)[0].content).toContain(
      'prefix_rule(pattern = ["git","push"], decision = "forbidden")',
    );
    expect(generateCodexPermissionArtifacts('git-commit', permissions)[0].content).toContain(
      'prefix_rule(pattern = ["git","commit"], decision = "prompt")',
    );
  });

  it('rejects permission prefixes with shell control characters', () => {
    expect(() =>
      mergeClaudePermissions([
        {
          name: 'unsafe',
          allow: ['git;rm -rf'],
        },
      ]),
    ).toThrow('shell control characters');

    expect(() =>
      generateCodexPermissionArtifacts('git-commit', [
        {
          name: 'unsafe',
          allow: ['git && rm'],
        },
      ]),
    ).toThrow('shell control characters');
  });
});
