import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { resolveCliPackageRoot } from '../../src/utils/paths.js';

const execFileAsync = promisify(execFile);
const helperPath = path.join(
  resolveCliPackageRoot(),
  'authoring',
  'assets',
  'aw-config.mjs',
);

async function withContext(
  context: unknown,
  run: (options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-config-helper-'));
  try {
    const contextPath = path.join(root, 'context.json');
    await fs.writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, 'utf8');
    await run({
      cwd: root,
      env: { ...process.env, AW_PLUGIN_CONTEXT: contextPath, NODE_PATH: '' },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('standard aw-config helper', () => {
  it('reads effective context values without repeating schema validation and redacts secrets', async () => {
    await withContext({
      plugin: {
        name: 'fixture-plugin',
        sourceId: 'fixture-source',
        pluginId: 'fixture-source/fixture-plugin',
      },
      config: {
        schema: {
          token: { type: 'string', sensitive: true },
          mode: {
            type: 'string',
            validation: { pattern: '^strict$', maxLength: 16 },
          },
        },
        values: {
          token: 'top-level-secret',
          mode: 'trusted-context-value',
          unknown: 'ignored',
        },
        sources: { token: 'user', mode: 'project', unknown: 'project' },
        issues: [],
      },
    }, async ({ cwd, env }) => {
      const [json, token, mode] = await Promise.all([
        execFileAsync(process.execPath, [helperPath, 'json'], { cwd, env }),
        execFileAsync(process.execPath, [helperPath, 'get', 'token'], { cwd, env }),
        execFileAsync(process.execPath, [helperPath, 'get', 'mode'], { cwd, env }),
      ]);

      expect(json.stdout).not.toContain('top-level-secret');
      expect(JSON.parse(json.stdout)).toMatchObject({
        pluginName: 'fixture-plugin',
        pluginId: 'fixture-source/fixture-plugin',
        scope: 'effective',
        values: { token: '[redacted]', mode: 'trusted-context-value' },
        sources: { token: 'user', mode: 'project' },
        paths: { configStores: {} },
      });
      expect(JSON.parse(json.stdout).values).not.toHaveProperty('unknown');
      expect(token.stdout).toBe('[redacted]\n');
      expect(mode.stdout).toBe('trusted-context-value\n');
    });
  });

  it.each(['user', 'project'])(
    'rejects the %s scope instead of reading config stores',
    async (scope) => {
      await withContext({
        plugin: { name: 'fixture-plugin' },
        config: { schema: {}, values: {} },
      }, async ({ cwd, env }) => {
        await expect(execFileAsync(
          process.execPath,
          [helperPath, 'json', '--scope', scope],
          { cwd, env },
        )).rejects.toMatchObject({
          stderr: expect.stringContaining('use aw config for user or project scope'),
        });
      });
    },
  );

  it('fails closed without AW_PLUGIN_CONTEXT', async () => {
    await expect(execFileAsync(process.execPath, [helperPath, 'json'], {
      env: { ...process.env, AW_PLUGIN_CONTEXT: '', NODE_PATH: '' },
    })).rejects.toMatchObject({
      stderr: '[aw-config] AW_PLUGIN_CONTEXT is required.\n',
    });
  });
});
