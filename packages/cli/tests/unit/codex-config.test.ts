import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  parseRenderedCodexMcpFileContent,
  getAwManagedSentinelPrefix,
  parseCodexConfig,
  removeCodexMcpServer,
  removeManagedDeveloperInstructions,
  resolveCodexMcpServerStatusSignal,
  upsertCodexMcpServer,
  upsertCodexMarketplace,
  upsertCodexPluginEnabled,
  upsertManagedDeveloperInstructions,
} from '../../src/utils/codex-config.js';

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    'codex-config',
    ...segments,
  );
}

describe('codex-config', () => {
  it('parses marketplace/plugin state and detects manifest-file sources', async () => {
    const input = await fs.readFile(fixturePath('user-input.toml'), 'utf8');

    const snapshot = parseCodexConfig(input);

    expect(snapshot.marketplaces.aw).toMatchObject({
      source: '/tmp/aw/.agents/plugins/marketplace.json',
      sourcePointsToManifest: true,
    });
    expect(snapshot.plugins['other-plugin@aw']).toMatchObject({
      enabled: true,
    });
    expect(snapshot.projects['/workspace/repo']).toMatchObject({
      trustLevel: 'trusted',
    });
    expect(snapshot.developerInstructions.defined).toBe(true);
    expect(snapshot.developerInstructions.managedBlocks['other-plugin']?.value).toContain(
      'existing managed block',
    );
  });

  it('round-trips marketplace, plugin enabled, and developer_instructions updates', async () => {
    const input = await fs.readFile(fixturePath('user-input.toml'), 'utf8');
    const expected = await fs.readFile(fixturePath('user-updated.toml'), 'utf8');

    const updatedMarketplace = upsertCodexMarketplace(input, 'aw', {
      source: '/Users/test/.aw',
      sourceType: 'local',
      lastUpdated: '2026-04-25T12:00:00.000Z',
    });
    const updatedPlugin = upsertCodexPluginEnabled(updatedMarketplace, 'git-commit@aw', {
      enabled: true,
    });
    const updatedInstructions = upsertManagedDeveloperInstructions(updatedPlugin, {
      pluginName: 'git-commit',
      value: ['## 提交规范', '- 使用 Conventional Commits', '- scope 要准确'].join('\n'),
    });

    expect(updatedInstructions).toBe(expected);
    expect(
      upsertManagedDeveloperInstructions(
        upsertCodexPluginEnabled(
          upsertCodexMarketplace(updatedInstructions, 'aw', {
            source: '/Users/test/.aw',
            sourceType: 'local',
            lastUpdated: '2026-04-25T12:00:00.000Z',
          }),
          'git-commit@aw',
          { enabled: true },
        ),
        {
          pluginName: 'git-commit',
          value: ['## 提交规范', '- 使用 Conventional Commits', '- scope 要准确'].join('\n'),
        },
      ),
    ).toBe(expected);
  });

  it('removes the developer_instructions field after deleting the last managed block', async () => {
    const input = await fs.readFile(
      fixturePath('remove-last-managed.input.toml'),
      'utf8',
    );
    const expected = await fs.readFile(
      fixturePath('remove-last-managed.expected.toml'),
      'utf8',
    );

    const next = removeManagedDeveloperInstructions(input, 'git-commit');

    expect(next).toBe(expected);
    expect(parseCodexConfig(next).developerInstructions.defined).toBe(false);
  });

  it('rejects instruction bodies that contain aw-managed sentinel lines', () => {
    expect(() =>
      upsertManagedDeveloperInstructions('', {
        pluginName: 'git-commit',
        value: `${getAwManagedSentinelPrefix()} bad`,
      }),
    ).toThrow('[[aw-managed:');
  });

  it('writes quoted-key MCP servers and preserves sibling content', () => {
    const input = [
      '# user comment',
      'title = "workspace"',
      '',
      '[mcp_servers.search]',
      'command = "search"',
      '',
      '[plugins."other@aw"]',
      'enabled = true',
      '',
    ].join('\n');

    const next = upsertCodexMcpServer(input, 'acme.tools v1', {
      command: 'node',
      args: ['./servers/acme-tools.js', '--stdio'],
      env: {
        ACME_MODE: 'fixture',
      },
      startup_timeout_sec: 10,
      tools: {
        'deploy.check': {
          approval_mode: 'manual',
        },
      },
    });

    expect(next).toContain('[mcp_servers."acme.tools v1"]');
    expect(next).toContain('[mcp_servers."acme.tools v1".env]');
    expect(next).toContain('[mcp_servers."acme.tools v1".tools."deploy.check"]');
    expect(next).toContain('[mcp_servers.search]');
    expect(next).toContain('# user comment');
    expect(parseCodexConfig(next).mcpServers['acme.tools v1']?.value).toEqual({
      command: 'node',
      args: ['./servers/acme-tools.js', '--stdio'],
      env: {
        ACME_MODE: 'fixture',
      },
      startup_timeout_sec: 10,
      tools: {
        'deploy.check': {
          approval_mode: 'manual',
        },
      },
    });
  });

  it('replaces an MCP server subtree and removes stale descendant tables', () => {
    const input = [
      '[mcp_servers."acme.tools v1"]',
      'command = "old"',
      '',
      '[mcp_servers."acme.tools v1".env]',
      'OLD = "1"',
      '',
      '[mcp_servers."acme.tools v1".tools.old]',
      'approval_mode = "manual"',
      '',
    ].join('\n');

    const next = upsertCodexMcpServer(input, 'acme.tools v1', {
      command: 'new',
      disabled: false,
    });

    expect(next).toContain('command = "new"');
    expect(next).toContain('disabled = false');
    expect(next).not.toContain('[mcp_servers."acme.tools v1".env]');
    expect(next).not.toContain('[mcp_servers."acme.tools v1".tools.old]');
    expect(parseCodexConfig(next).mcpServers['acme.tools v1']?.value).toEqual({
      command: 'new',
      disabled: false,
    });
  });

  it('removes an MCP server subtree without touching siblings', () => {
    const input = [
      '[mcp_servers."acme.tools v1"]',
      'command = "node"',
      '',
      '[mcp_servers."acme.tools v1".env]',
      'A = "1"',
      '',
      '[mcp_servers.sibling]',
      'command = "keep"',
      '',
    ].join('\n');

    const next = removeCodexMcpServer(input, 'acme.tools v1');

    expect(next).not.toContain('acme.tools v1');
    expect(next).toContain('[mcp_servers.sibling]');
    expect(parseCodexConfig(next).mcpServers).toEqual({
      sibling: {
        key: 'sibling',
        value: {
          command: 'keep',
        },
      },
    });
  });

  it('rejects rendered MCP values that include null or non-object servers', () => {
    expect(() =>
      parseRenderedCodexMcpFileContent({
        mcpServers: {
          broken: {
            env: {
              TOKEN: null,
            },
          },
        },
      }, 'fixture.mcp'),
    ).toThrow('null cannot be represented in TOML');

    expect(() =>
      parseRenderedCodexMcpFileContent({
        mcpServers: {
          broken: 'nope',
        },
      }, 'fixture.mcp'),
    ).toThrow('expected a server config object');
  });

  it('compares MCP status signals with quoted-key identity semantics', () => {
    const actual = parseCodexConfig(
      upsertCodexMcpServer('', 'acme.tools v1', {
        command: 'node',
        disabled: false,
      }),
    ).mcpServers['acme.tools v1'];

    expect(
      resolveCodexMcpServerStatusSignal({
        key: 'acme.tools v1',
        tracked: true,
        actual,
        expected: {
          command: 'node',
          disabled: false,
        },
      }),
    ).toMatchObject({
      state: 'visible',
      tracked: true,
    });

    expect(
      resolveCodexMcpServerStatusSignal({
        key: 'acme.tools v1',
        tracked: true,
        actual: undefined,
      }),
    ).toMatchObject({
      state: 'missing',
    });

    expect(
      resolveCodexMcpServerStatusSignal({
        key: 'acme.tools v1',
        tracked: true,
        actual,
        expected: {
          command: 'node',
          disabled: true,
        },
      }),
    ).toMatchObject({
      state: 'drifted',
    });

    expect(
      resolveCodexMcpServerStatusSignal({
        key: 'acme.tools v1',
        tracked: false,
        actual,
      }),
    ).toMatchObject({
      state: 'orphan',
      tracked: false,
    });
  });
});
