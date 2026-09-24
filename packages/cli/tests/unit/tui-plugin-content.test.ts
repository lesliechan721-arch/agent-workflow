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
      fs.outputFile(path.join(root, 'codex', 'skills', 'helper.txt'), 'not a skill'),
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
      coverage: 'complete',
    });
    expect(overview.items).toMatchObject([
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
    expect(overview.notices).toEqual([]);
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
    expect(overview.coverage).toBe('unavailable');
    expect(overview.coverageIssue?.code).toBe('unsafePath');
    expect(JSON.stringify(overview)).not.toContain('LOCAL-SENSITIVE-TEXT');
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

    expect(overview.items).toMatchObject([
      { id: 'agent:reviewer', name: 'reviewer', type: 'agent', description: 'Reviews changes.', tools: ['Codex'] },
      { id: 'artifact:review-role', name: 'review', type: 'role', description: null, tools: ['Codex'] },
      { id: 'artifact:dynamic-skill', name: 'dynamic', type: 'skill', description: 'Dynamic summary.', tools: ['Codex'] },
    ]);
    expect(overview.coverage).toBe('complete');
    expect(overview.notices).toEqual([]);
    expect(JSON.stringify(overview)).not.toMatch(/PRIVATE-(?:PROMPT|INSTRUCTION)/u);
  });

  it('keeps an absent description normal and prefers trusted short metadata', async () => {
    // Risk: ordinary Role and Skill entries can be counted as failures only because they lack a summary.
    const root = await fixtureRoot();
    await fs.ensureDir(path.join(root, 'claude', 'skills'));
    await fs.outputFile(path.join(root, 'codex', 'skills', 'inspect', 'SKILL.md'),
      '---\nname: inspect\ndescription: A long fallback sentence. Another sentence.\nmetadata:\n  short-description: Trusted short purpose.\n---\nPRIVATE-BODY\n');
    const overview = await projectPluginContentOverview({
      pluginId: 'official/demo', catalogVersion: '9.1.0',
      plugin: plugin(root, { skills: './skills', artifacts: { targets: [
        {
          id: 'review-role', platform: 'codex', scopes: ['user'], target: 'codex.agentRole',
          kind: 'codexRole', states: ['present'], refreshKeys: [], roleKey: 'review',
        },
        {
          id: 'dynamic-skill', platform: 'codex', scopes: ['user'], target: 'codex.skill',
          kind: 'skill', states: ['present'], refreshKeys: [], skillKey: 'dynamic',
          delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        },
      ] } }),
    });

    expect(overview.items).toMatchObject([
      { id: 'artifact:review-role', name: 'review', description: null, descriptionState: 'absent' },
      { id: 'artifact:dynamic-skill', name: 'dynamic', description: null, descriptionState: 'absent' },
      { id: 'skill:inspect', name: 'inspect', description: 'Trusted short purpose.', descriptionState: 'available' },
    ]);
    expect(overview.items.every((item) => item.issue === undefined)).toBe(true);
    expect(overview.notices).toEqual([]);
  });

  it('keeps a confirmed Skill with invalid metadata and a local issue', async () => {
    // Risk: a real metadata failure can be hidden as an ordinary missing description.
    const root = await fixtureRoot();
    await fs.ensureDir(path.join(root, 'claude', 'skills'));
    await fs.outputFile(path.join(root, 'codex', 'skills', 'broken', 'SKILL.md'),
      '---\nname: broken\ndescription: [invalid\n---\nPRIVATE-BODY\n');
    const overview = await projectPluginContentOverview({
      pluginId: 'official/demo', catalogVersion: '9.1.0',
      plugin: plugin(root, { skills: './skills' }),
    });

    expect(overview.items).toMatchObject([{
      id: 'skill:broken', name: 'broken', description: null,
      descriptionState: 'issue', issue: { code: 'invalidMetadata' },
    }]);
    expect(overview.items[0]?.issue?.message).toContain('检查');
    expect(overview.coverage).toBe('complete');
    expect(overview.notices).toEqual([]);
  });

  it('accepts frontmatter closed at end of file with or without a description', async () => {
    // Risk: a valid EOF delimiter can turn trusted metadata or a normal empty summary into an issue.
    const root = await fixtureRoot();
    await fs.ensureDir(path.join(root, 'claude', 'skills'));
    await Promise.all([
      fs.outputFile(path.join(root, 'codex', 'skills', 'described', 'SKILL.md'),
        '---\nname: described\ndescription: Inspect safely.\n---'),
      fs.outputFile(path.join(root, 'codex', 'skills', 'unnamed-purpose', 'SKILL.md'),
        '---\nname: unnamed-purpose\n---'),
    ]);

    const overview = await projectPluginContentOverview({
      pluginId: 'official/demo', catalogVersion: '9.1.0',
      plugin: plugin(root, { skills: './skills' }),
    });

    expect(overview.items).toMatchObject([
      { name: 'described', description: 'Inspect safely.', descriptionState: 'available' },
      { name: 'unnamed-purpose', description: null, descriptionState: 'absent' },
    ]);
    expect(overview.items.every((item) => item.issue === undefined)).toBe(true);
    expect(overview.coverage).toBe('complete');
    expect(overview.notices).toEqual([]);
  });

  it('keeps named Skills when their metadata file is unsafe', async () => {
    // Risk: a known item can disappear when its SKILL.md is a symlink or non-regular node.
    const root = await fixtureRoot();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-tui-content-outside-'));
    roots.push(outside);
    await fs.outputFile(path.join(outside, 'private.md'), 'LOCAL-SENSITIVE-TEXT');
    await fs.ensureDir(path.join(root, 'claude', 'skills'));
    await Promise.all([
      fs.ensureDir(path.join(root, 'codex', 'skills', 'linked')),
      fs.ensureDir(path.join(root, 'codex', 'skills', 'not-a-file', 'SKILL.md')),
    ]);
    await fs.symlink(path.join(outside, 'private.md'),
      path.join(root, 'codex', 'skills', 'linked', 'SKILL.md'));

    const overview = await projectPluginContentOverview({
      pluginId: 'official/demo', catalogVersion: '9.1.0',
      plugin: plugin(root, { skills: './skills' }),
    });

    expect(overview.items).toMatchObject([
      { name: 'linked', type: 'skill', tools: ['Codex'], description: null,
        descriptionState: 'issue', issue: { code: 'unsafePath' } },
      { name: 'not-a-file', type: 'skill', tools: ['Codex'], description: null,
        descriptionState: 'issue', issue: { code: 'unsafePath' } },
    ]);
    expect(overview.coverage).toBe('complete');
    expect(overview.notices).toEqual([]);
    expect(JSON.stringify(overview)).not.toContain('LOCAL-SENSITIVE-TEXT');
    expect(JSON.stringify(overview)).not.toContain(outside);
  });

  it('does not treat a read-block delimiter as EOF and does not name an empty directory', async () => {
    // Risk: an apparent delimiter at a 512-byte boundary can hide trailing invalid metadata.
    const root = await fixtureRoot();
    await fs.ensureDir(path.join(root, 'claude', 'skills'));
    const prefix = '---\nname: boundary\ndescription: Visible\n';
    const firstBlock = `${prefix}${'#'.repeat(512 - prefix.length - 4)}\n---`;
    await fs.outputFile(path.join(root, 'codex', 'skills', 'boundary', 'SKILL.md'),
      `${firstBlock}X\n---\n`);
    await fs.ensureDir(path.join(root, 'codex', 'skills', 'empty'));

    const overview = await projectPluginContentOverview({
      pluginId: 'official/demo', catalogVersion: '9.1.0',
      plugin: plugin(root, { skills: './skills' }),
    });

    expect(Buffer.byteLength(firstBlock)).toBe(512);
    expect(overview.items).toMatchObject([{
      name: 'boundary', description: null, descriptionState: 'issue',
      issue: { code: 'invalidMetadata' },
    }]);
    expect(overview.items.some((item) => item.name === 'empty')).toBe(false);
    expect(overview.coverage).toBe('partial');
    expect(overview.coverageIssue?.code).toBe('incompleteList');
  });

  it('separates partial coverage from a confirmed empty list', async () => {
    // Risk: an unreadable declared list can be mistaken for a verified zero count.
    const root = await fixtureRoot();
    await fs.outputFile(path.join(root, 'codex', 'skills', 'known', 'SKILL.md'),
      '---\nname: known\n---\nBODY\n');
    const partial = await projectPluginContentOverview({
      pluginId: 'official/demo', catalogVersion: '9.1.0',
      plugin: plugin(root, { skills: './skills' }),
    });
    expect(partial.items).toMatchObject([{ name: 'known', descriptionState: 'absent' }]);
    expect(partial.coverage).toBe('partial');
    expect(partial.coverageIssue).toMatchObject({ code: 'incompleteList' });

    await fs.ensureDir(path.join(root, 'claude', 'skills'));
    const complete = await projectPluginContentOverview({
      pluginId: 'official/demo', catalogVersion: '9.1.0',
      plugin: plugin(root, { skills: './skills' }),
    });
    expect(complete.coverage).toBe('complete');
    expect(complete.notices).toEqual([]);

    await fs.remove(path.join(root, 'codex', 'skills', 'known'));
    const empty = await projectPluginContentOverview({
      pluginId: 'official/demo', catalogVersion: '9.1.0',
      plugin: plugin(root, { skills: './skills' }),
    });
    expect(empty.items).toEqual([]);
    expect(empty.coverage).toBe('complete');
    expect(empty.coverageIssue).toBeUndefined();
  });

  it('keeps confirmed JSON components when another platform list is unreadable', async () => {
    // Risk: a failed list parse can erase a confirmed item or create a false total count.
    const root = await fixtureRoot();
    await fs.outputJson(path.join(root, 'codex', '.mcp.json'), {
      mcpServers: { repository: { command: 'PRIVATE-COMMAND' } },
    });
    await fs.outputFile(path.join(root, 'claude', '.mcp.json'), '{invalid');
    const overview = await projectPluginContentOverview({
      pluginId: 'official/demo', catalogVersion: '9.1.0',
      plugin: plugin(root, { mcpServers: './.mcp.json' }),
    });

    expect(overview.items).toMatchObject([{
      id: 'mcpServer:repository', name: 'repository', tools: ['Codex'],
      description: null, descriptionState: 'absent',
    }]);
    expect(overview.coverage).toBe('partial');
    expect(overview.coverageIssue?.code).toBe('unreadable');
    expect(JSON.stringify(overview)).not.toContain('PRIVATE-COMMAND');
  });

  it('reports an unavailable bundle when its root cannot be read', async () => {
    // Risk: a missing bundle root can reject the page load and lose its safe recovery state.
    const root = await fixtureRoot();
    await fs.remove(root);
    const overview = await projectPluginContentOverview({
      pluginId: 'official/demo', catalogVersion: '9.1.0',
      plugin: plugin(root, { skills: './skills' }),
    });

    expect(overview).toMatchObject({
      evidence: 'unavailable', coverage: 'unavailable', items: [],
      coverageIssue: { code: 'unreadable' },
    });
  });
});
