import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import type { PluginMeta } from '../../src/types.js';
import { projectPluginContentOverview } from '../../src/tui/plugin-content.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

async function fixtureRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-tui-content-'));
  roots.push(root);
  await Promise.all([
    fs.outputJson(path.join(root, '.codex-plugin', 'plugin.json'), { name: 'demo' }),
    fs.outputJson(path.join(root, '.claude-plugin', 'plugin.json'), { name: 'demo' }),
  ]);
  return root;
}

function plugin(rootDir: string, manifest: Partial<PluginMeta['manifest']>): PluginMeta {
  return {
    rootDir,
    manifestPath: path.join(rootDir, '.agents-plugin', 'plugin.json'),
    manifest: {
      schemaVersion: 3,
      name: 'demo',
      version: '2.4.0',
      description: 'Demo.',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
      ...manifest,
    },
  };
}

describe('TUI plugin content projection', () => {
  it('lists real bundle skills once with tools, safe descriptions, and catalog evidence', async () => {
    // Risk: the TUI can claim that catalog content belongs to an installed older version.
    const root = await fixtureRoot();
    const skill = (description: string, body: string) =>
      `---\nname: inspect\ndescription: ${description}\n---\n${body}\n`;
    await Promise.all([
      fs.outputFile(path.join(root, 'codex', 'skills', 'inspect', 'SKILL.md'), skill('Inspect safely.', 'CODEX-BODY-SECRET')),
      fs.outputFile(path.join(root, 'codex', 'skills', 'deploy', 'SKILL.md'), skill('Deploy summary.', 'COMMAND-BODY-SECRET')),
      fs.outputFile(path.join(root, 'codex', 'skills', 'windows-lines', 'SKILL.md'), skill('Windows summary.', 'WINDOWS-BODY-SECRET').replace(/\n/gu, '\r\n')),
      fs.outputFile(path.join(root, 'codex', 'skills', 'assets', 'helper.txt'), 'not a skill'),
      fs.ensureDir(path.join(root, 'codex', 'skills', 'helper')),
      fs.outputFile(path.join(root, 'claude', 'skills', 'inspect', 'SKILL.md'), skill('Inspect safely.', 'CLAUDE-BODY-SECRET')),
      fs.outputFile(path.join(root, 'claude', 'commands', 'deploy.md'), '---\ndescription: Deploy summary.\n---\nCOMMAND-BODY-SECRET\n'),
      fs.outputFile(path.join(root, 'agent-skills', 'skills', 'portable', 'SKILL.md'), skill('Portable check.', 'PORTABLE-BODY-SECRET')),
      fs.outputJson(path.join(root, 'codex', '.mcp.json'), { mcpServers: { repository: { command: 'private-command' } } }),
      fs.outputJson(path.join(root, 'claude', '.mcp.json'), { mcpServers: { repository: { command: 'private-command' } } }),
      fs.outputJson(path.join(root, 'codex', '.app.json'), { apps: { dashboard: { name: 'Private app detail' } } }),
    ]);

    const overview = await projectPluginContentOverview({
      pluginId: 'official/demo',
      catalogVersion: '9.1.0',
      plugin: plugin(root, {
        skills: './skills',
        slashCommands: './commands.json',
        mcpServers: './.mcp.json',
        apps: './.app.json',
        distributions: { agentSkills: { skills: './agent-skills/skills' } },
      }),
    });

    expect(overview).toMatchObject({
      pluginId: 'official/demo',
      pluginVersion: '2.4.0',
      catalogVersion: '9.1.0',
      evidence: 'catalogBundle',
    });
    expect(overview.items).toEqual([
      {
        id: 'app:dashboard', name: 'dashboard', type: 'app', description: null,
        tools: ['Codex'],
      },
      {
        id: 'command:deploy', name: 'deploy', type: 'command', description: 'Deploy summary.',
        tools: ['Codex', 'Claude Code'],
      },
      {
        id: 'mcpServer:repository', name: 'repository', type: 'mcpServer', description: null,
        tools: ['Codex', 'Claude Code'],
      },
      {
        id: 'skill:inspect', name: 'inspect', type: 'skill', description: 'Inspect safely.',
        tools: ['Codex', 'Claude Code'],
      },
      {
        id: 'skill:portable', name: 'portable', type: 'skill', description: 'Portable check.',
        tools: ['Agent Skills'],
      },
      {
        id: 'skill:windows-lines', name: 'windows-lines', type: 'skill', description: 'Windows summary.',
        tools: ['Codex'],
      },
    ]);
    expect(JSON.stringify(overview)).not.toContain('BODY-SECRET');
  });

  it('does not follow a Skill symlink outside the catalog bundle', async () => {
    // Risk: an untrusted path source can make a read-only details page disclose local text.
    const root = await fixtureRoot();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-tui-content-outside-'));
    roots.push(outside);
    await fs.outputFile(
      path.join(outside, 'SKILL.md'),
      '---\nname: escaped\ndescription: LOCAL-SENSITIVE-TEXT\n---\nBody.\n',
    );
    await fs.ensureDir(path.join(root, 'codex', 'skills'));
    await fs.symlink(outside, path.join(root, 'codex', 'skills', 'escaped'));

    const overview = await projectPluginContentOverview({
      pluginId: 'official/demo',
      catalogVersion: '9.1.0',
      plugin: plugin(root, { skills: './skills' }),
    });

    expect(overview.items).toEqual([]);
    expect(JSON.stringify(overview)).not.toContain('LOCAL-SENSITIVE-TEXT');
    expect(overview.notices).toContain('此目录版本没有可安全确认的内容清单。');
  });

  it('projects structured agents and dynamic targets without prompt or renderer content', async () => {
    const root = await fixtureRoot();
    await fs.outputFile(
      path.join(root, '.agents-plugin', 'artifact-sources', 'codex', 'dynamic-skill', '0', 'SKILL.md'),
      '---\nname: dynamic\ndescription: Dynamic summary.\n---\nPRIVATE-INSTRUCTION\n',
    );
    const overview = await projectPluginContentOverview({
      pluginId: 'official/demo',
      catalogVersion: '9.1.0',
      plugin: plugin(root, {
        extensions: {
          agents: [{
            name: 'reviewer', description: 'Reviews changes.', prompt: 'PRIVATE-PROMPT',
            agentOverrides: { claude: null },
          }],
        },
        artifacts: { targets: [
          {
            id: 'dynamic-skill', platform: 'codex', scopes: ['user'], target: 'codex.skill',
            kind: 'skill', states: ['present'], refreshKeys: [],
            delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
            skillKey: 'dynamic',
          },
          {
            id: 'review-role', platform: 'codex', scopes: ['user'], target: 'codex.agentRole',
            kind: 'codexRole', states: ['present'], refreshKeys: [], roleKey: 'review',
          },
        ] },
      }),
    });

    expect(overview.items).toEqual([
      { id: 'agent:reviewer', name: 'reviewer', type: 'agent', description: 'Reviews changes.', tools: ['Codex'] },
      { id: 'artifact:review-role', name: 'review', type: 'role', description: null, tools: ['Codex'] },
      { id: 'artifact:dynamic-skill', name: 'dynamic', type: 'skill', description: 'Dynamic summary.', tools: ['Codex'] },
    ]);
    expect(JSON.stringify(overview)).not.toMatch(/PRIVATE-(?:PROMPT|INSTRUCTION)/u);
  });
});
