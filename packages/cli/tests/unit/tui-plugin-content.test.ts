import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import type { PluginMeta } from '../../src/types.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { projectPluginContentOverview } from '../../src/tui/plugin-content.js';
import { readPluginManifest } from '../../src/utils/manifest.js';

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
      fs.outputFile(path.join(root, 'codex', 'skills', 'deploy', 'SKILL.md'), '# COMMAND-BODY-SECRET\n'),
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
      coverage: 'partial',
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
        id: 'skill:windows-lines', name: 'windows-lines', type: 'skill', description: null,
        tools: ['Codex'],
      },
    ]);
    expect(overview.coverageIssue?.message).toContain('不能区分普通 Skill 与 Slash command');
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
    await fs.ensureDir(path.join(root, 'claude', 'skills'));
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

  it('keeps independent same-name Skill tools when a command has a Codex projection', async () => {
    // Risk: a command can delete a confirmed Agent Skills or Claude Skill entry with the same name.
    const root = await fixtureRoot();
    await Promise.all([
      fs.outputFile(path.join(root, 'codex', 'skills', 'deploy', 'SKILL.md'),
        '# COMMAND-BODY-SECRET\n'),
      fs.ensureDir(path.join(root, 'claude', 'skills')),
      fs.outputFile(path.join(root, 'agent-skills', 'skills', 'deploy', 'SKILL.md'),
        '---\nname: deploy\ndescription: Independent portable Skill.\n---\nPORTABLE-BODY-SECRET\n'),
      fs.outputFile(path.join(root, 'claude', 'commands', 'deploy.md'),
        '---\ndescription: Claude command summary.\n---\nCOMMAND-BODY-SECRET\n'),
    ]);
    const overview = await projectPluginContentOverview({
      pluginId: 'official/demo', catalogVersion: '9.1.0',
      plugin: plugin(root, {
        skills: './skills', slashCommands: './commands',
        distributions: { agentSkills: { skills: './agent-skills/skills' } },
      }),
    });

    expect(overview.items).toMatchObject([
      { id: 'command:deploy', type: 'command', name: 'deploy',
        tools: ['Codex', 'Claude Code'], description: 'Claude command summary.' },
      { id: 'skill:deploy', type: 'skill', name: 'deploy',
        tools: ['Agent Skills'], description: 'Independent portable Skill.',
        descriptionState: 'available' },
    ]);
    expect(overview.items).toHaveLength(2);
    expect(overview.coverage).toBe('complete');
    expect(JSON.stringify(overview)).not.toContain('BODY-SECRET');

    // A read projection must keep an independently confirmed Claude Skill if one is present.
    await fs.outputFile(path.join(root, 'claude', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: Independent Claude Skill.\n---\nCLAUDE-BODY-SECRET\n');
    const withClaudeSkill = await projectPluginContentOverview({
      pluginId: 'official/demo', catalogVersion: '9.1.0',
      plugin: plugin(root, {
        skills: './skills', slashCommands: './commands',
        distributions: { agentSkills: { skills: './agent-skills/skills' } },
      }),
    });
    expect(withClaudeSkill.items).toMatchObject([
      { type: 'command', name: 'deploy', tools: ['Codex', 'Claude Code'] },
      { type: 'skill', name: 'deploy', tools: ['Claude Code', 'Agent Skills'],
        description: 'Independent Claude Skill.', descriptionState: 'available' },
    ]);
  });

  it('keeps an unsafe Codex Skill issue beside its same-name command', async () => {
    // Risk: command projection can erase a named unsafe Skill issue or read its symlink target.
    const root = await fixtureRoot();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-tui-content-outside-'));
    roots.push(outside);
    await fs.outputFile(path.join(outside, 'private.md'), 'LOCAL-SENSITIVE-TEXT');
    await Promise.all([
      fs.ensureDir(path.join(root, 'codex', 'skills', 'deploy')),
      fs.ensureDir(path.join(root, 'claude', 'skills')),
      fs.outputFile(path.join(root, 'claude', 'commands', 'deploy.md'),
        '---\ndescription: Claude command summary.\n---\nCOMMAND-BODY-SECRET\n'),
      fs.outputFile(path.join(root, 'agent-skills', 'skills', 'deploy', 'SKILL.md'),
        '---\nname: deploy\ndescription: Portable Skill.\n---\nPORTABLE-BODY-SECRET\n'),
    ]);
    await fs.symlink(path.join(outside, 'private.md'),
      path.join(root, 'codex', 'skills', 'deploy', 'SKILL.md'));
    const overview = await projectPluginContentOverview({
      pluginId: 'official/demo', catalogVersion: '9.1.0',
      plugin: plugin(root, {
        skills: './skills', slashCommands: './commands',
        distributions: { agentSkills: { skills: './agent-skills/skills' } },
      }),
    });

    expect(overview.items).toMatchObject([
      { id: 'command:deploy', type: 'command', name: 'deploy',
        tools: ['Claude Code'], descriptionState: 'available' },
      { id: 'skill:deploy', type: 'skill', name: 'deploy',
        tools: ['Codex', 'Agent Skills'], description: 'Portable Skill.',
        descriptionState: 'issue', issue: { code: 'unsafePath' } },
    ]);
    expect(overview.items).toHaveLength(2);
    expect(overview.coverage).toBe('partial');
    expect(overview.coverageIssue?.code).toBe('unsafePath');
    expect(JSON.stringify(overview)).not.toContain('LOCAL-SENSITIVE-TEXT');
    expect(JSON.stringify(overview)).not.toContain(outside);
  });

  it('keeps a confirmed command metadata issue on one command item', async () => {
    // Risk: malformed Claude command metadata can be hidden by its Codex body.
    const root = await fixtureRoot();
    await Promise.all([
      fs.outputFile(path.join(root, 'codex', 'skills', 'deploy', 'SKILL.md'),
        '# PRIVATE-BODY\n'),
      fs.outputFile(path.join(root, 'codex', 'skills', 'deploy', 'agents', 'openai.yaml'),
        'interface:\n  short_description: Deploy changes after review.\n'),
      fs.ensureDir(path.join(root, 'claude', 'skills')),
      fs.outputFile(path.join(root, 'claude', 'commands', 'deploy.md'),
        '---\ndescription: [invalid\n---\nCOMMAND-BODY-SECRET\n'),
    ]);
    const overview = await projectPluginContentOverview({
      pluginId: 'official/demo', catalogVersion: '9.1.0',
      plugin: plugin(root, { skills: './skills', slashCommands: './commands' }),
    });

    expect(overview.items).toMatchObject([{
      id: 'command:deploy', type: 'command', name: 'deploy',
      tools: ['Codex', 'Claude Code'], descriptionState: 'issue',
      issue: { code: 'invalidMetadata' },
    }]);
    expect(overview.items).toHaveLength(1);
    expect(overview.coverage).toBe('complete');
    expect(JSON.stringify(overview)).not.toContain('PRIVATE-BODY');
  });

  it('projects real Claude-only, Codex-only, dual, and mixed slash command bundles', async () => {
    // Risk: real Codex commands have no Claude directory and their SKILL.md is body-only.
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
      '..', 'fixtures', 'codex-project-repo-managed', 'plugins', 'slashCommands-only');
    for (const [scenario, products, expectedTools] of [
      ['claude', ['CLAUDE'], ['Claude Code']],
      ['codex', ['CODEX'], ['Codex']],
      ['dual', ['CLAUDE', 'CODEX'], ['Codex', 'Claude Code']],
    ] as const) {
      const output = await fs.mkdtemp(path.join(os.tmpdir(), `aw-tui-command-${scenario}-`));
      roots.push(output);
      const source = await readPluginManifest(sourceRoot);
      source.manifest.marketplace.policy.products = [...products];
      const bundleRoot = path.join(output, 'bundle');
      await bundleLocalPlugin(source, bundleRoot);
      const bundle = await readPluginManifest(bundleRoot, { mode: 'bundle' });
      const overview = await projectPluginContentOverview({
        pluginId: 'official/slash-commands-only', catalogVersion: '9.1.0', plugin: bundle,
      });

      expect(overview.items).toMatchObject([{
        id: 'command:review', name: 'review', type: 'command', tools: expectedTools,
        description: scenario === 'claude'
          ? 'Review the current change set with Claude Code tools.' : 'Review repository changes',
        descriptionState: 'available',
      }]);
      expect(overview.items).toHaveLength(1);
      expect(overview.items[0]?.issue).toBeUndefined();
      expect(overview.coverage).toBe('complete');
      expect(overview.notices).toEqual([]);
      expect(JSON.stringify(overview)).not.toContain('Run `git status`');
    }

    const markerOutput = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-tui-command-body-marker-'));
    roots.push(markerOutput);
    const markerSource = path.join(markerOutput, 'source');
    await fs.copy(sourceRoot, markerSource);
    const markerManifestPath = path.join(markerSource, '.agents-plugin', 'plugin.json');
    const markerManifest = await fs.readJson(markerManifestPath);
    markerManifest.marketplace.policy.products = ['CODEX'];
    await fs.writeJson(markerManifestPath, markerManifest);
    const commandSource = path.join(markerSource, 'slash-commands', 'review.md');
    const commandText = await fs.readFile(commandSource, 'utf8');
    await fs.writeFile(commandSource, commandText.replace('\n---\n\n# Review', '\n---\n---\n# Review'));
    const markerBundleRoot = path.join(markerOutput, 'bundle');
    await bundleLocalPlugin(await readPluginManifest(markerSource), markerBundleRoot);
    expect(await fs.readFile(path.join(markerBundleRoot, 'codex', 'skills', 'review', 'SKILL.md'), 'utf8'))
      .toMatch(/^---\n/u);
    const markerOverview = await projectPluginContentOverview({
      pluginId: 'official/slash-commands-only', catalogVersion: '9.1.0',
      plugin: await readPluginManifest(markerBundleRoot, { mode: 'bundle' }),
    });
    expect(markerOverview.items).toMatchObject([{
      name: 'review', type: 'command', tools: ['Codex'],
      description: 'Review repository changes', descriptionState: 'available',
    }]);
    expect(markerOverview.items[0]?.issue).toBeUndefined();
    expect(markerOverview.coverage).toBe('complete');

    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-tui-command-mixed-'));
    roots.push(output);
    const sourceDir = path.join(output, 'source');
    await fs.copy(sourceRoot, sourceDir);
    const manifestPath = path.join(sourceDir, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.skills = './skills';
    manifest.marketplace.policy.products = ['CODEX'];
    await fs.writeJson(manifestPath, manifest);
    await fs.outputFile(path.join(sourceDir, 'skills', 'ordinary', 'SKILL.md'),
      '---\nname: ordinary\ndescription: Ordinary Skill summary.\n---\nPRIVATE-SKILL-BODY\n');
    const source = await readPluginManifest(sourceDir);
    const bundleRoot = path.join(output, 'bundle');
    await bundleLocalPlugin(source, bundleRoot);
    const bundle = await readPluginManifest(bundleRoot, { mode: 'bundle' });
    const overview = await projectPluginContentOverview({
      pluginId: 'official/slash-commands-only', catalogVersion: '9.1.0', plugin: bundle,
    });

    expect(overview.items).toMatchObject([
      { name: 'ordinary', type: 'skill', tools: ['Codex'], descriptionState: 'absent' },
      { name: 'review', type: 'skill', tools: ['Codex'], descriptionState: 'absent' },
    ]);
    expect(overview.items).toHaveLength(2);
    expect(overview.items.every((item) => item.issue === undefined)).toBe(true);
    expect(overview.coverage).toBe('partial');
    expect(overview.coverageIssue?.code).toBe('incompleteList');
    expect(overview.coverageIssue?.message).toContain('不能安全区分普通 Skill 与 Slash command');
    expect(JSON.stringify(overview)).not.toContain('PRIVATE-SKILL-BODY');
    expect(JSON.stringify(overview)).not.toContain('Run `git status`');
  });

  it('marks a missing or unsafe platform marker partial in real dual-platform bundles', async () => {
    // Risk: one readable platform can hide that another declared platform was not confirmed.
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
      '..', 'fixtures', 'codex-project-repo-managed', 'plugins', 'slashCommands-only');
    for (const [missing, unsafe] of [
      ['codex', false], ['claude', false], ['codex', true], ['claude', true],
    ] as const) {
      const output = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-tui-command-marker-'));
      roots.push(output);
      const source = await readPluginManifest(sourceRoot);
      source.manifest.marketplace.policy.products = ['CODEX', 'CLAUDE'];
      const bundleRoot = path.join(output, 'bundle');
      await bundleLocalPlugin(source, bundleRoot);
      const bundle = await readPluginManifest(bundleRoot, { mode: 'bundle' });
      const marker = path.join(bundleRoot, `.${missing}-plugin`);
      await fs.remove(marker);
      if (unsafe) {
        const outside = path.join(output, 'outside-marker');
        await fs.outputJson(path.join(outside, 'plugin.json'), { name: 'PRIVATE-MARKER' });
        await fs.symlink(outside, marker);
      }
      const overview = await projectPluginContentOverview({
        pluginId: 'official/slash-commands-only', catalogVersion: '9.1.0',
        plugin: bundle,
      });

      expect(overview.items).toMatchObject([{
        id: 'command:review', type: 'command', name: 'review',
        tools: missing === 'codex' ? ['Claude Code'] : ['Codex'],
      }]);
      expect(overview.items).toHaveLength(1);
      expect(overview.coverage).toBe('partial');
      expect(overview.coverageIssue?.code).toBe(unsafe ? 'unsafePath' : 'incompleteList');
      expect(overview.coverageIssue?.message).toContain(missing === 'codex' ? 'Codex' : 'Claude Code');
      expect(JSON.stringify(overview)).not.toContain('PRIVATE-MARKER');
      expect(JSON.stringify(overview)).not.toContain('Run `git status`');
    }
  });

  it('keeps the surviving command platform when a real dual-platform output is missing or unsafe', async () => {
    // Risk: intact platform markers can hide a missing per-command output and claim a complete list.
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
      '..', 'fixtures', 'codex-project-repo-managed', 'plugins', 'slashCommands-only');
    for (const [platform, damage] of [
      ['codex', 'file'], ['codex', 'directory'], ['codex', 'unsafe'],
      ['claude', 'file'], ['claude', 'directory'], ['claude', 'unsafe'],
    ] as const) {
      const output = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-tui-command-output-'));
      roots.push(output);
      const source = await readPluginManifest(sourceRoot);
      source.manifest.marketplace.policy.products = ['CODEX', 'CLAUDE'];
      const bundleRoot = path.join(output, 'bundle');
      await bundleLocalPlugin(source, bundleRoot);
      const bundle = await readPluginManifest(bundleRoot, { mode: 'bundle' });
      const commandFile = platform === 'codex'
        ? path.join(bundleRoot, 'codex', 'skills', 'review', 'SKILL.md')
        : path.join(bundleRoot, 'claude', 'commands', 'review.md');
      const damagedPath = damage === 'directory' ? path.dirname(commandFile) : commandFile;
      await fs.remove(damagedPath);
      if (damage === 'unsafe') {
        const outside = path.join(output, 'PRIVATE-COMMAND-FILE');
        await fs.writeFile(outside, 'PRIVATE-COMMAND-TEXT');
        await fs.symlink(outside, damagedPath);
      }
      const overview = await projectPluginContentOverview({
        pluginId: 'official/slash-commands-only', catalogVersion: '9.1.0', plugin: bundle,
      });

      expect(overview.items).toContainEqual(expect.objectContaining({
        id: 'command:review', name: 'review', type: 'command',
        tools: platform === 'codex' ? ['Claude Code'] : ['Codex'],
      }));
      expect(overview.coverage).toBe('partial');
      expect(overview.coverageIssue?.code).toBe(damage === 'unsafe' ? 'unsafePath' : 'incompleteList');
      expect(JSON.stringify(overview)).not.toContain('PRIVATE-COMMAND-TEXT');
      expect(JSON.stringify(overview)).not.toContain('PRIVATE-COMMAND-FILE');
      expect(JSON.stringify(overview)).not.toContain('Run `git status`');
      expect(JSON.stringify(overview)).not.toContain('Use $review');
    }
  });

  it('keeps mixed native and Agent Skills evidence when a real command output is damaged', async () => {
    // Risk: an orphan Codex directory may be a Skill, while a same-name Agent Skill is independent.
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
      '..', 'fixtures', 'codex-project-repo-managed', 'plugins', 'slashCommands-only');
    for (const damage of ['claudeMissing', 'codexUnsafe', 'fileRulesClaudeMissing'] as const) {
      const output = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-tui-command-mixed-output-'));
      roots.push(output);
      const sourceDir = path.join(output, 'source');
      await fs.copy(sourceRoot, sourceDir);
      const manifestPath = path.join(sourceDir, '.agents-plugin', 'plugin.json');
      const manifest = await fs.readJson(manifestPath);
      if (damage === 'fileRulesClaudeMissing') {
        manifest.buildConfig.fileRules = { codex: { include: ['skills/**'], exclude: [] } };
      } else {
        manifest.skills = './skills';
      }
      manifest.distributions = { agentSkills: { skills: './agent-skills/skills' } };
      manifest.marketplace.policy.products = ['CODEX', 'CLAUDE'];
      await fs.writeJson(manifestPath, manifest);
      await Promise.all([
        fs.outputFile(path.join(sourceDir, 'agent-skills', 'skills', 'review', 'SKILL.md'),
          '---\nname: review\ndescription: Portable review summary.\n---\nPRIVATE-PORTABLE-BODY\n'),
        fs.outputFile(path.join(sourceDir, 'agent-skills', 'skills', 'review', 'README.md'),
          'Portable review Skill.\n'),
      ]);
      if (damage !== 'fileRulesClaudeMissing') {
        await fs.outputFile(path.join(sourceDir, 'skills', 'ordinary', 'SKILL.md'),
          '---\nname: ordinary\ndescription: Ordinary Skill summary.\n---\nPRIVATE-SKILL-BODY\n');
      }
      const bundleRoot = path.join(output, 'bundle');
      await bundleLocalPlugin(await readPluginManifest(sourceDir), bundleRoot);
      const bundle = await readPluginManifest(bundleRoot, { mode: 'bundle' });
      const healthy = await projectPluginContentOverview({
        pluginId: 'official/slash-commands-only', catalogVersion: '9.1.0', plugin: bundle,
      });
      expect(healthy.coverage).toBe('complete');
      if (damage !== 'fileRulesClaudeMissing') {
        expect(healthy.items).toContainEqual(expect.objectContaining({
          id: 'skill:ordinary', type: 'skill', tools: ['Codex', 'Claude Code'],
          description: 'Ordinary Skill summary.', descriptionState: 'available',
        }));
      }
      if (damage !== 'codexUnsafe') {
        await fs.remove(path.join(bundleRoot, 'claude', 'commands', 'review.md'));
      } else {
        const file = path.join(bundleRoot, 'codex', 'skills', 'review', 'SKILL.md');
        const outside = path.join(output, 'private-target');
        await fs.writeFile(outside, 'PRIVATE-LINK-TEXT');
        await fs.remove(file);
        await fs.symlink(outside, file);
      }
      const overview = await projectPluginContentOverview({
        pluginId: 'official/slash-commands-only', catalogVersion: '9.1.0', plugin: bundle,
      });

      if (damage !== 'fileRulesClaudeMissing') {
        expect(overview.items).toContainEqual(expect.objectContaining({
          id: 'skill:ordinary', name: 'ordinary', type: 'skill',
          tools: ['Codex', 'Claude Code'],
          description: 'Ordinary Skill summary.',
        }));
      }
      expect(overview.items).toContainEqual(expect.objectContaining({
        id: 'skill:review', name: 'review', type: 'skill',
        tools: ['Codex', 'Agent Skills'],
        description: 'Portable review summary.',
      }));
      if (damage === 'codexUnsafe') {
        expect(overview.items).toContainEqual(expect.objectContaining({
          id: 'command:review', type: 'command', tools: ['Claude Code'],
        }));
        expect(overview.items.find((item) => item.id === 'skill:review')?.issue?.code).toBe('unsafePath');
      } else {
        expect(overview.items.some((item) => item.id === 'command:review')).toBe(false);
      }
      expect(overview.coverage).toBe('partial');
      expect(overview.coverageIssue).toBeDefined();
      expect(JSON.stringify(overview)).not.toMatch(/PRIVATE-(?:SKILL-BODY|PORTABLE-BODY|LINK-TEXT)/u);
      expect(JSON.stringify(overview)).not.toContain('Run `git status`');
      expect(JSON.stringify(overview)).not.toContain('Use $review');
    }
  });

  it('does not use an unsafe Claude Skill file to confirm a mixed Codex Skill identity', async () => {
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
      '..', 'fixtures', 'codex-project-repo-managed', 'plugins', 'slashCommands-only');
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-tui-command-unsafe-skill-'));
    roots.push(output);
    const sourceDir = path.join(output, 'source');
    await fs.copy(sourceRoot, sourceDir);
    const manifestPath = path.join(sourceDir, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.skills = './skills';
    manifest.marketplace.policy.products = ['CODEX', 'CLAUDE'];
    await fs.writeJson(manifestPath, manifest);
    await fs.outputFile(path.join(sourceDir, 'skills', 'ordinary', 'SKILL.md'),
      '---\nname: ordinary\ndescription: Ordinary Skill summary.\n---\nPRIVATE-SKILL-BODY\n');
    const bundleRoot = path.join(output, 'bundle');
    await bundleLocalPlugin(await readPluginManifest(sourceDir), bundleRoot);
    const bundle = await readPluginManifest(bundleRoot, { mode: 'bundle' });
    const claudeSkill = path.join(bundleRoot, 'claude', 'skills', 'ordinary', 'SKILL.md');
    const outside = path.join(output, 'private-skill');
    await fs.writeFile(outside, 'PRIVATE-LINK-TEXT');
    await fs.remove(claudeSkill);
    await fs.symlink(outside, claudeSkill);

    const overview = await projectPluginContentOverview({
      pluginId: 'official/slash-commands-only', catalogVersion: '9.1.0', plugin: bundle,
    });
    expect(overview.items.find((item) => item.id === 'skill:ordinary')).toMatchObject({
      id: 'skill:ordinary', type: 'skill', tools: ['Codex', 'Claude Code'],
      description: null, descriptionState: 'issue', issue: { code: 'unsafePath' },
    });
    expect(overview.coverage).toBe('partial');
    expect(overview.coverageIssue?.message).toContain('不能区分普通 Skill 与 Slash command');
    expect(JSON.stringify(overview)).not.toContain('PRIVATE-LINK-TEXT');
    expect(JSON.stringify(overview)).not.toContain('PRIVATE-SKILL-BODY');
  });

  it('reads only safe bounded Codex command short descriptions from real bundle metadata', async () => {
    // Risk: reading generated YAML can expose its prompt, follow a link, or hide metadata damage.
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
      '..', 'fixtures', 'codex-project-repo-managed', 'plugins', 'slashCommands-only');
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-tui-command-metadata-'));
    roots.push(output);
    const source = await readPluginManifest(sourceRoot);
    source.manifest.marketplace.policy.products = ['CODEX'];
    const bundleRoot = path.join(output, 'bundle');
    await bundleLocalPlugin(source, bundleRoot);
    const bundle = await readPluginManifest(bundleRoot, { mode: 'bundle' });
    const metadataFile = path.join(bundleRoot, 'codex', 'skills', 'review', 'agents', 'openai.yaml');
    const original = await fs.readFile(metadataFile, 'utf8');
    const project = () => projectPluginContentOverview({
      pluginId: 'official/slash-commands-only', catalogVersion: '9.1.0', plugin: bundle,
    });

    await fs.writeFile(metadataFile, original.replace('Use $review to inspect the current change set.',
      'PRIVATE-DEFAULT-PROMPT'));
    const valid = await project();
    expect(valid.items).toMatchObject([{
      id: 'command:review', description: 'Review repository changes', descriptionState: 'available',
    }]);
    expect(JSON.stringify(valid)).not.toContain('PRIVATE-DEFAULT-PROMPT');
    expect(JSON.stringify(valid)).not.toContain('Run `git status`');

    await fs.writeFile(metadataFile, original.replace(/^  short_description:.*\n/mu, ''));
    const absent = await project();
    expect(absent.items[0]).toMatchObject({
      description: null, descriptionState: 'absent',
    });
    expect(absent.items[0]?.issue).toBeUndefined();

    await fs.writeFile(metadataFile, 'interface:\n  short_description: 42\n');
    const invalidField = await project();
    expect(invalidField.items[0]).toMatchObject({
      description: null, descriptionState: 'issue', issue: { code: 'invalidMetadata' },
    });

    await fs.writeFile(metadataFile, 'interface:\n  short_description: [invalid\nPRIVATE-YAML-TEXT\n');
    const invalid = await project();
    expect(invalid.items).toMatchObject([{
      id: 'command:review', description: null, descriptionState: 'issue',
      issue: { code: 'invalidMetadata' },
    }]);
    expect(invalid.coverage).toBe('complete');
    expect(JSON.stringify(invalid)).not.toContain('PRIVATE-YAML-TEXT');

    await fs.writeFile(metadataFile, `${original}${'#'.repeat(16 * 1024)}`);
    const oversized = await project();
    expect(oversized.items[0]).toMatchObject({
      descriptionState: 'issue', issue: { code: 'invalidMetadata' },
    });

    const outside = path.join(output, 'private-openai.yaml');
    await fs.writeFile(outside, 'interface:\n  short_description: PRIVATE-LINK-TEXT\n');
    await fs.remove(metadataFile);
    await fs.symlink(outside, metadataFile);
    const linked = await project();
    expect(linked.items[0]).toMatchObject({
      description: null, descriptionState: 'issue', issue: { code: 'unsafePath' },
    });
    expect(JSON.stringify(linked)).not.toContain('PRIVATE-LINK-TEXT');
    expect(JSON.stringify(linked)).not.toContain(outside);

    await fs.remove(metadataFile);
    const missing = await project();
    expect(missing.items[0]).toMatchObject({
      description: null, descriptionState: 'issue', issue: { code: 'incompleteList' },
    });
  });

  it('does not call a declared command list empty when platform manifests are missing', async () => {
    // Risk: damaged platform markers can turn an unreadable command list into a false zero count.
    const root = await fixtureRoot();
    await fs.remove(path.join(root, '.codex-plugin'));
    await fs.remove(path.join(root, '.claude-plugin'));
    const overview = await projectPluginContentOverview({
      pluginId: 'official/demo', catalogVersion: '9.1.0',
      plugin: plugin(root, { slashCommands: './slash-commands' }),
    });
    expect(overview.items).toEqual([]);
    expect(overview.coverage).toBe('unavailable');
    expect(overview.coverageIssue?.code).toBe('incompleteList');
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
