import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { resolveSlashCommands } from '../../src/utils/slash-commands.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function createTempPlugin(
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-slash-commands-'));
  tempDirs.push(tempRoot);

  const pluginRoot = path.join(tempRoot, manifest.name as string);
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest, { spaces: 2 });

  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      await fs.outputFile(path.join(pluginRoot, relativePath), content, 'utf8');
    }),
  );

  return pluginRoot;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('slashCommands source and bundle contract', () => {
  it('resolves and bundles public slashCommands into Claude commands and Codex manual-only skills', async () => {
    const pluginRoot = fixturePath(
      'codex-project-repo-managed',
      'plugins',
      'slashCommands-only',
    );
    const plugin = await readPluginManifest(pluginRoot);
    const resolved = await resolveSlashCommands(pluginRoot, plugin.manifest);

    expect(resolved).toMatchObject({
      rootRelativePath: './slash-commands',
      commands: [
        {
          name: 'review',
          claude: {
            description: 'Review the current change set with Claude Code tools.',
            argumentHint: '[path]',
            shell: 'bash',
          },
          codex: {
            description: 'Review the current change set as a manual Codex skill.',
            interface: {
              displayName: 'Fixture Review',
              shortDescription: 'Review repository changes',
              iconSmall: './assets/review-16.svg',
              iconLarge: './assets/review-64.svg',
              brandColor: '#2563EB',
              defaultPrompt: 'Use $review to inspect the current change set.',
            },
          },
        },
      ],
    });
    expect(resolved?.commands[0]?.codex.body).not.toContain('$ARGUMENTS');
    expect(resolved?.commands[0]?.codex.body).not.toContain('```!');
    expect(resolved?.commands[0]?.codex.assets).toEqual([
      {
        sourceRelativePath: 'slash-commands/assets/review-16.svg',
        generatedRelativePath: './assets/review-16.svg',
      },
      {
        sourceRelativePath: 'slash-commands/assets/review-64.svg',
        generatedRelativePath: './assets/review-64.svg',
      },
    ]);

    const outputRoot = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'aw-slash-commands-bundle-')),
      'bundle',
    );
    tempDirs.push(path.dirname(outputRoot));
    const bundled = await bundleLocalPlugin(plugin, outputRoot);

    expect(bundled.claudeManifest.commands).toBe('./claude/commands');
    expect(bundled.codexManifest.skills).toBe('./codex/skills');
    await expect(
      fs.pathExists(path.join(outputRoot, 'slash-commands', 'review.md')),
    ).resolves.toBe(false);
    await expect(
      fs.readFile(path.join(outputRoot, 'claude', 'commands', 'review.md'), 'utf8'),
    ).resolves.toContain('disable-model-invocation: true');
    await expect(
      fs.readFile(path.join(outputRoot, 'claude', 'commands', 'review.md'), 'utf8'),
    ).resolves.toContain('argument-hint: "[path]"');
    const skillContent = await fs.readFile(
      path.join(outputRoot, 'codex', 'skills', 'review', 'SKILL.md'),
      'utf8',
    );
    expect(skillContent).not.toContain('$ARGUMENTS');
    expect(skillContent).not.toContain('```!');

    const openAiYaml = YAML.parse(
      await fs.readFile(
        path.join(outputRoot, 'codex', 'skills', 'review', 'agents', 'openai.yaml'),
        'utf8',
      ),
    ) as {
      interface?: Record<string, string>;
      policy?: { allow_implicit_invocation?: boolean };
    };
    expect(openAiYaml).toMatchObject({
      interface: {
        display_name: 'Fixture Review',
        short_description: 'Review repository changes',
        icon_small: './assets/review-16.svg',
        icon_large: './assets/review-64.svg',
        brand_color: '#2563EB',
        default_prompt: 'Use $review to inspect the current change set.',
      },
      policy: {
        allow_implicit_invocation: false,
      },
    });
    await expect(
      fs.pathExists(path.join(outputRoot, 'codex', 'skills', 'review', 'assets', 'review-16.svg')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(outputRoot, 'codex', 'skills', 'review', 'assets', 'review-64.svg')),
    ).resolves.toBe(true);
  });

  it('fails fast when slash-commands exists without a slashCommands manifest declaration', async () => {
    const pluginRoot = await createTempPlugin(
      {
        name: 'missing-slash-commands-declaration',
        version: '0.1.0',
        description: 'missing declaration',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'NONE',
          },
        },
      },
      {
        'slash-commands/review.md': [
          '---',
          'description: Review the repo.',
          '---',
          '',
          '# Review',
        ].join('\n'),
      },
    );

    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'found slash-commands but missing "slashCommands" declaration',
    );
  });

  it('rejects Codex icon paths and Claude-only syntax leaks in rendered slashCommands', async () => {
    const invalidIconPluginRoot = fixturePath(
      'codex-project-repo-managed',
      'negative',
      'slashCommands-invalid-icon',
    );
    await expect(readPluginManifest(invalidIconPluginRoot)).rejects.toThrow(
      'codex.interface.icon_small',
    );

    const leakedSyntaxPluginRoot = await createTempPlugin(
      {
        name: 'slash-command-codex-leak',
        version: '0.1.0',
        description: 'leaks Claude syntax into Codex',
        slashCommands: './slash-commands',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'NONE',
          },
        },
      },
      {
        'slash-commands/review.md': [
          '---',
          'description: Review the repo.',
          '---',
          '',
          'Use $ARGUMENTS to narrow the scope.',
        ].join('\n'),
      },
    );

    await expect(readPluginManifest(leakedSyntaxPluginRoot)).rejects.toThrow(
      'Codex render still contains Claude-only syntax "$ARGUMENTS"',
    );
  });

  it('rejects nested command directories, root non-Markdown files, and skill name conflicts', async () => {
    const nestedPluginRoot = await createTempPlugin(
      {
        name: 'slash-command-invalid-structure',
        version: '0.1.0',
        description: 'invalid structure',
        slashCommands: './slash-commands',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'NONE',
          },
        },
      },
      {
        'slash-commands/group/review.md': '---\ndescription: Review.\n---\n\n# Review\n',
      },
    );
    await expect(readPluginManifest(nestedPluginRoot)).rejects.toThrow(
      'nested directory',
    );

    const filePluginRoot = await createTempPlugin(
      {
        name: 'slash-command-invalid-file',
        version: '0.1.0',
        description: 'invalid structure',
        slashCommands: './slash-commands',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'NONE',
          },
        },
      },
      {
        'slash-commands/review.txt': 'not markdown\n',
      },
    );
    await expect(readPluginManifest(filePluginRoot)).rejects.toThrow(
      'only root "*.md" commands and "assets/" are allowed',
    );

    const conflictPluginRoot = await createTempPlugin(
      {
        name: 'slash-command-skill-conflict',
        version: '0.1.0',
        description: 'conflict',
        skills: './skills',
        slashCommands: './slash-commands',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'NONE',
          },
        },
      },
      {
        'skills/review/SKILL.md': '---\nname: review\ndescription: Review.\n---\n\n# Review\n',
        'skills/review/agents/openai.yaml': 'policy:\n  allow_implicit_invocation: false\n',
        'slash-commands/review.md': '---\ndescription: Review.\n---\n\n# Review\n',
      },
    );
    await expect(readPluginManifest(conflictPluginRoot)).rejects.toThrow(
      'conflicts with source skill "review"',
    );
  });

  it('rejects missing frontmatter, missing description, and Claude-only fields declared at the top level', async () => {
    const missingFrontmatterPluginRoot = await createTempPlugin(
      {
        name: 'slash-command-missing-frontmatter',
        version: '0.1.0',
        description: 'missing frontmatter',
        slashCommands: './slash-commands',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'NONE',
          },
        },
      },
      {
        'slash-commands/review.md': '# Review\n',
      },
    );
    await expect(readPluginManifest(missingFrontmatterPluginRoot)).rejects.toThrow(
      'missing YAML frontmatter',
    );

    const missingDescriptionPluginRoot = await createTempPlugin(
      {
        name: 'slash-command-missing-description',
        version: '0.1.0',
        description: 'missing description',
        slashCommands: './slash-commands',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'NONE',
          },
        },
      },
      {
        'slash-commands/review.md': [
          '---',
          'claude:',
          '  allowed-tools:',
          '    - Read',
          '---',
          '',
          '# Review',
        ].join('\n'),
      },
    );
    await expect(readPluginManifest(missingDescriptionPluginRoot)).rejects.toThrow(
      'frontmatter.description',
    );

    const misplacedFieldPluginRoot = await createTempPlugin(
      {
        name: 'slash-command-misplaced-field',
        version: '0.1.0',
        description: 'misplaced field',
        slashCommands: './slash-commands',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'NONE',
          },
        },
      },
      {
        'slash-commands/review.md': [
          '---',
          'description: Review the repo.',
          'allowed-tools:',
          '  - Read',
          '---',
          '',
          '# Review',
        ].join('\n'),
      },
    );
    await expect(readPluginManifest(misplacedFieldPluginRoot)).rejects.toThrow(
      'must be nested under "claude"',
    );
  });
});
