import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import type { PluginMeta } from '../../src/types.js';
import { projectPluginContentOverview } from '../../src/tui/plugin-content.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(manifest: Partial<PluginMeta['manifest']> = {}) {
  const rootDir = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'content');
  await fs.ensureDir(rootDir);
  const plugin: PluginMeta = { rootDir, manifestPath: path.join(rootDir, '.agents-plugin', 'plugin.json'), manifest: {
    schemaVersion: 4, name: 'demo', version: '2.4.0', description: 'Demo.', ...manifest,
  } };
  return { rootDir, plugin, read: () => projectPluginContentOverview({ pluginId: 'team/demo', catalogVersion: '9.1.0', plugin }) };
}
const skill = (description: string, body = 'PRIVATE-BODY') => `---\nname: inspect\ndescription: ${description}\n---\n${body}\n`;

describe('TUI static source content', () => {
  // Test Value Gate: catalog browsing cannot claim frozen dynamic outputs or leak prompts, commands, MCP credentials, and renderer bodies.
  it('lists static declarations and marks the dynamic component set unknown without executing scripts', async () => {
    const value = await fixture({ platforms: ['codex', 'cursor', 'gemini', 'generic'], skills: './skills', mcpServers: './mcp.json',
      extensions: { agents: [{ name: 'reviewer', description: 'Review safely.', prompt: 'PRIVATE-PROMPT', agentOverrides: { cursor: null } }],
        instructions: [{ name: 'rules', title: 'Rules', content: 'PRIVATE-INSTRUCTIONS', coverage: ['main'] }],
        hooks: [{ id: 'guard', event: 'before_tool', feedback: 'block', command: 'PRIVATE-COMMAND' }] },
      artifacts: { configKeys: [] }, scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } } });
    await fs.outputFile(path.join(value.rootDir, 'skills', 'inspect', 'SKILL.md'), skill('Inspect safely.'));
    await fs.outputJson(path.join(value.rootDir, 'mcp.json'), { mcpServers: { repository: { command: 'PRIVATE-MCP-COMMAND', env: { TOKEN: 'PRIVATE-CREDENTIAL' } } } });
    const marker = path.join(value.rootDir, 'executed');
    await fs.writeFile(path.join(value.rootDir, 'render.mjs'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`);
    const overview = await value.read();
    expect(overview).toMatchObject({ evidence: 'catalogBundle', coverage: 'partial', pluginVersion: '2.4.0', catalogVersion: '9.1.0' });
    expect(overview.items.map((item) => item.type)).toEqual(expect.arrayContaining(['skill', 'agent', 'instruction', 'hook', 'mcpServer', 'renderer']));
    expect(overview.items.find((item) => item.type === 'agent')?.tools).toEqual(['Codex', 'Gemini CLI', 'Generic']);
    expect(overview.items.find((item) => item.type === 'skill')?.description).toBe('Inspect safely.');
    expect(overview.notices.join(' ')).toContain('动态组件集合尚未准备');
    expect(JSON.stringify(overview)).not.toContain('PRIVATE-');
    expect(await fs.pathExists(marker)).toBe(false);
  });

  // Test Value Gate: source inspection must not follow symlinks or invent a Skill for an unfinished directory.
  it('keeps unsafe metadata local, excludes linked directories, and reports incomplete coverage', async () => {
    const value = await fixture({ platforms: ['cursor'], skills: './skills' });
    const outside = path.join(value.rootDir, '..', 'private.md'); await fs.writeFile(outside, skill('PRIVATE-EXTERNAL'));
    await fs.ensureDir(path.join(value.rootDir, 'skills', 'unsafe'));
    await fs.symlink(outside, path.join(value.rootDir, 'skills', 'unsafe', 'SKILL.md'));
    await fs.ensureDir(path.join(value.rootDir, 'skills', 'unfinished'));
    await fs.symlink(path.dirname(outside), path.join(value.rootDir, 'skills', 'linked'), 'dir');
    const overview = await value.read();
    expect(overview.items).toEqual([expect.objectContaining({ id: 'skill:unsafe', descriptionState: 'issue', issue: { code: 'unsafePath', message: expect.any(String) } })]);
    expect(overview.coverage).toBe('partial'); expect(JSON.stringify(overview)).not.toContain('PRIVATE-EXTERNAL');
  });

  // Test Value Gate: only bounded frontmatter may supply summaries; malformed or excessive metadata stays a named issue.
  it('reads safe short descriptions and preserves named malformed or oversized metadata', async () => {
    const value = await fixture({ skills: './skills' });
    await fs.outputFile(path.join(value.rootDir, 'skills', 'short', 'SKILL.md'), '---\nname: short\ndescription: Long description.\nmetadata:\n  short-description: Short summary.\n---');
    await fs.outputFile(path.join(value.rootDir, 'skills', 'empty', 'SKILL.md'), '---\nname: empty\n---');
    await fs.outputFile(path.join(value.rootDir, 'skills', 'oversized', 'SKILL.md'), skill('a'.repeat(17000)));
    const overview = await value.read();
    expect(overview.items.find((item) => item.name === 'short')?.description).toBe('Short summary.');
    expect(overview.items.find((item) => item.name === 'empty')).toMatchObject({ description: null, descriptionState: 'absent' });
    expect(overview.items.find((item) => item.name === 'oversized')).toMatchObject({ descriptionState: 'issue', issue: { code: 'invalidMetadata' } });
  });

  // Test Value Gate: a readable empty declaration differs from an unreadable source or an unconfirmed declared MCP collection.
  it('distinguishes complete empty content from missing source and broken static declarations', async () => {
    const value = await fixture();
    expect(await value.read()).toMatchObject({ coverage: 'complete', items: [] });
    value.plugin.manifest.mcpServers = './missing.json';
    expect(await value.read()).toMatchObject({ coverage: 'unavailable', coverageIssue: { code: 'incompleteList' } });
    await fs.remove(value.rootDir);
    expect(await value.read()).toMatchObject({ evidence: 'unavailable', coverage: 'unavailable' });
  });
});
