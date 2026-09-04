import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  normalizePluginConfigDefinition,
  validatePluginConfigValue,
} from '@lesliechan721/aw-plugin-core/manifest';

import { resolveCliPackageRoot } from '../../src/utils/paths.js';

const execFileAsync = promisify(execFile);
const packageRoot = resolveCliPackageRoot();

describe('generated aw-config helper', () => {
  it('is current according to its check-only generator', async () => {
    await expect(execFileAsync(process.execPath, [
      path.join(packageRoot, 'scripts', 'generate-aw-config-helper.mjs'),
      '--check',
    ], { cwd: packageRoot })).resolves.toMatchObject({ stderr: '' });
  });

  it('has validation parity with plugin-core for scalar and object fixtures', async () => {
    const helper = await import(pathToFileURL(
      path.join(packageRoot, 'authoring', 'assets', 'aw-config.mjs'),
    ).href) as {
      validatePluginConfigValue: typeof validatePluginConfigValue;
    };
    const fields = normalizePluginConfigDefinition({
      fields: {
        mode: {
          type: 'string',
          validation: { minLength: 2 },
        },
        endpoint: { type: 'string', validation: { format: 'url' } },
        credentials: {
          type: 'object',
          properties: {
            token: { type: 'string', required: true, sensitive: true },
            retries: { type: 'number', validation: { integer: true, minimum: 0 } },
          },
          additionalProperties: false,
        },
        locations: {
          type: 'object',
          additionalProperties: { type: 'string', validation: { minLength: 2 } },
        },
        labels: {
          type: 'object',
          additionalProperties: { type: 'string' },
          validation: { key: { format: 'identifier' } },
        },
      },
    }).fields;
    const fixtures = [
      ['mode', 'x'],
      ['mode', 'safe'],
      ['endpoint', 'https://example.test'],
      ['endpoint', 'example.test'],
      ['credentials', { token: 'secret', retries: 2 }],
      ['credentials', { retries: -1 }],
      ['credentials', { token: 'secret', nested: {} }],
      ['locations', { certificate: 'pem', cache: 'directory' }],
      ['locations', { certificate: '', cache: '' }],
      ['labels', { fixed_key: 'fixed', dynamic_key: 'dynamic' }],
      ['labels', { fixed_key: 'fixed', 'bad key': 'dynamic' }],
      ['labels', Object.fromEntries([['__proto__', 'dangerous']])],
    ] as const;

    for (const [key, value] of fixtures) {
      expect(helper.validatePluginConfigValue(fields[key]!, value, key))
        .toEqual(validatePluginConfigValue(fields[key]!, value, key));
    }
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'fails closed for the top-level dangerous key %s',
    async (dangerousKey) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-config-helper-dangerous-key-'));
      try {
        const contextPath = path.join(root, 'context.json');
        const helperPath = path.join(packageRoot, 'authoring', 'assets', 'aw-config.mjs');
        await fs.writeFile(contextPath, `${JSON.stringify({
          plugin: { name: 'fixture-plugin' },
          config: {
            schema: { token: { type: 'string' } },
            values: Object.fromEntries([[dangerousKey, 'dangerous']]),
          },
        }, null, 2)}\n`, 'utf8');

        await expect(execFileAsync(process.execPath, [helperPath, 'json'], {
          cwd: root,
          env: { ...process.env, AW_PLUGIN_CONTEXT: contextPath, NODE_PATH: '' },
        })).rejects.toMatchObject({
          stderr: `[aw-config] dangerousKey: Config "${dangerousKey}" is not allowed.\n`,
        });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it('continues to filter an ordinary unknown top-level key', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-config-helper-unknown-key-'));
    try {
      const contextPath = path.join(root, 'context.json');
      const helperPath = path.join(packageRoot, 'authoring', 'assets', 'aw-config.mjs');
      await fs.writeFile(contextPath, `${JSON.stringify({
        plugin: { name: 'fixture-plugin' },
        config: {
          schema: { token: { type: 'string' } },
          values: { token: 'kept', futureKey: 'ignored' },
        },
      }, null, 2)}\n`, 'utf8');

      const result = await execFileAsync(process.execPath, [helperPath, 'json'], {
        cwd: root,
        env: { ...process.env, AW_PLUGIN_CONTEXT: contextPath, NODE_PATH: '' },
      });
      expect(JSON.parse(result.stdout).values).toEqual({ token: 'kept' });
      expect(result.stderr).toBe('');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('redacts nested sensitive strings from get and JSON output', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-config-helper-redaction-'));
    try {
      const contextPath = path.join(root, 'context.json');
      const helperPath = path.join(packageRoot, 'authoring', 'assets', 'aw-config.mjs');
      await fs.writeFile(contextPath, `${JSON.stringify({
        plugin: {
          name: 'fixture-plugin',
          sourceId: 'fixture-source',
          sourceIdentity: `sha256:${'a'.repeat(64)}`,
        },
        config: {
          schema: {
            credentials: {
              type: 'object',
              properties: {
                token: { type: 'string', required: true, sensitive: true },
                endpoint: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          mode: 'artifact-render',
          values: { credentials: { token: 'nested-secret', endpoint: 'https://example.test' } },
          sources: { credentials: 'user', ignored: 'projectLocal' },
          issues: [],
          ignoredUnknownKeys: [],
        },
        paths: { configStores: { projectLocal: '/private/legacy-store' } },
      }, null, 2)}\n`, 'utf8');
      const env = {
        ...process.env,
        AW_PLUGIN_CONTEXT: contextPath,
        NODE_PATH: '',
      };
      const [json, get] = await Promise.all([
        execFileAsync(process.execPath, [helperPath, 'json'], { cwd: root, env }),
        execFileAsync(process.execPath, [helperPath, 'get', 'credentials'], { cwd: root, env }),
      ]);

      expect(json.stdout).not.toContain('nested-secret');
      expect(get.stdout).not.toContain('nested-secret');
      expect(JSON.parse(json.stdout).values.credentials).toEqual({
        token: '[redacted]',
        endpoint: 'https://example.test',
      });
      expect(JSON.parse(json.stdout).paths.configStores).toEqual({});
      expect(new Set(Object.values(JSON.parse(json.stdout).sources)))
        .toEqual(new Set(['user']));
      expect(JSON.parse(get.stdout)).toEqual({
        token: '[redacted]',
        endpoint: 'https://example.test',
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(['user', 'project'])(
    'rejects an explicit %s store read when AW_PLUGIN_CONTEXT is present',
    async (scope) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-config-helper-context-scope-'));
      try {
        const contextPath = path.join(root, 'context.json');
        const helperPath = path.join(packageRoot, 'authoring', 'assets', 'aw-config.mjs');
        await fs.writeFile(contextPath, `${JSON.stringify({
          plugin: { name: 'fixture-plugin' },
          config: {
            mode: 'artifact-render',
            schema: { mode: { type: 'string' } },
            values: { mode: 'context-only' },
            sources: { mode: 'user' },
            issues: [],
          },
        }, null, 2)}\n`, 'utf8');

        await expect(execFileAsync(
          process.execPath,
          [helperPath, 'json', '--scope', scope],
          {
            cwd: root,
            env: {
              ...process.env,
              AW_PLUGIN_CONTEXT: contextPath,
              AW_HOME: path.join(root, 'real-aw-home'),
              NODE_PATH: '',
            },
          },
        )).rejects.toMatchObject({
          stderr: '[aw-config] AW_PLUGIN_CONTEXT only supports effective config reads; explicit user and project store reads are unavailable.\n',
        });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['user', 'project'])(
    'reads an explicit %s store for a non-renderer context',
    async (scope) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-config-helper-test-context-scope-'));
      try {
        const sourceId = 'fixture-source';
        const sourceIdentity = `sha256:${'b'.repeat(64)}`;
        const contextPath = path.join(root, 'context.json');
        const storePaths = {
          user: path.join(root, 'user.json'),
          project: path.join(root, 'project.json'),
        };
        await Promise.all(Object.entries(storePaths).map(([storeScope, storePath]) =>
          fs.writeFile(storePath, `${JSON.stringify({
            schemaVersion: 3,
            sourceId,
            sourceIdentity,
            pluginName: 'fixture-plugin',
            values: { mode: `${storeScope}-mode` },
          })}\n`, 'utf8')));
        await fs.writeFile(contextPath, `${JSON.stringify({
          plugin: { name: 'fixture-plugin', sourceId, sourceIdentity },
          config: {
            schema: { mode: { type: 'string' } },
            values: {},
            sources: { mode: 'missing' },
            issues: [],
          },
          paths: { configStores: storePaths },
        }, null, 2)}\n`, 'utf8');

        const result = await execFileAsync(
          process.execPath,
          [path.join(packageRoot, 'authoring', 'assets', 'aw-config.mjs'), 'json', '--scope', scope],
          {
            cwd: root,
            env: { ...process.env, AW_PLUGIN_CONTEXT: contextPath, NODE_PATH: '' },
          },
        );
        expect(JSON.parse(result.stdout)).toMatchObject({
          scope,
          values: { mode: `${scope}-mode` },
        });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it('uses user/default values for native refresh keys, preserves raw project values, and isolates renderer context', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-config-helper-native-fallback-'));
    try {
      const sourceId = 'fixture-source';
      const sourceIdentity = `sha256:${'c'.repeat(64)}`;
      const pluginName = 'fixture-plugin';
      const awHome = path.join(root, 'aw-home');
      const marketplaceRoot = path.join(awHome, 'marketplaces', sourceId);
      const bundleRoot = path.join(marketplaceRoot, 'plugins', pluginName);
      const projectRoot = path.join(root, 'project');
      const projectSubdir = path.join(projectRoot, 'nested');
      const userStorePath = path.join(
        awHome, 'plugin-config', sourceId, pluginName, 'config.json',
      );
      const projectStorePath = path.join(
        projectRoot, '.agent-workflows', 'plugin-config', sourceId, pluginName, 'config.json',
      );
      const helperPath = path.join(bundleRoot, 'scripts', 'aw-config.mjs');

      await Promise.all([
        fs.mkdir(path.dirname(helperPath), { recursive: true }),
        fs.mkdir(path.join(bundleRoot, '.agents-plugin'), { recursive: true }),
        fs.mkdir(path.dirname(userStorePath), { recursive: true }),
        fs.mkdir(path.dirname(projectStorePath), { recursive: true }),
        fs.mkdir(projectSubdir, { recursive: true }),
      ]);
      await Promise.all([
        fs.copyFile(path.join(packageRoot, 'authoring', 'assets', 'aw-config.mjs'), helperPath),
        fs.writeFile(path.join(projectRoot, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8'),
        fs.writeFile(path.join(marketplaceRoot, 'config.json'), `${JSON.stringify({
          schemaVersion: 2,
          sourceId,
          sourceIdentity,
          marketplaceName: `aw-${sourceId}`,
        })}\n`, 'utf8'),
        fs.writeFile(path.join(bundleRoot, '.agents-plugin', 'plugin.json'), `${JSON.stringify({
          name: pluginName,
          config: {
            fields: {
              nativeUser: { type: 'string', default: 'native-default' },
              nativeDefault: { type: 'string', default: 'native-default' },
              ordinary: { type: 'string', default: 'ordinary-default' },
            },
          },
          artifacts: {
            targets: [{
              id: 'native-skill',
              platform: 'codex',
              target: 'codex.skill',
              kind: 'skill',
              scopes: ['user'],
              states: ['present'],
              refreshKeys: ['nativeUser', 'nativeDefault'],
              delivery: {
                mode: 'codex-native',
                identity: 'shared',
                renderProfile: 'user',
              },
              skillKey: 'native-skill',
            }],
          },
        })}\n`, 'utf8'),
        fs.writeFile(userStorePath, `${JSON.stringify({
          schemaVersion: 3,
          sourceId,
          sourceIdentity,
          pluginName,
          values: {
            nativeUser: 'user-native',
            ordinary: 'user-ordinary',
          },
        })}\n`, 'utf8'),
        fs.writeFile(projectStorePath, `${JSON.stringify({
          schemaVersion: 3,
          sourceId,
          sourceIdentity,
          pluginName,
          values: {
            nativeUser: 'legacy-project-native',
            nativeDefault: 'legacy-project-native-default',
            ordinary: 'project-ordinary',
          },
        })}\n`, 'utf8'),
      ]);

      const fallbackEnv = {
        ...process.env,
        AW_HOME: awHome,
        AW_PLUGIN_CONTEXT: '',
        NODE_PATH: '',
      };
      const [effective, project] = await Promise.all([
        execFileAsync(process.execPath, [helperPath, 'json'], {
          cwd: projectSubdir,
          env: fallbackEnv,
        }),
        execFileAsync(process.execPath, [helperPath, 'json', '--scope', 'project'], {
          cwd: projectSubdir,
          env: fallbackEnv,
        }),
      ]);
      expect(JSON.parse(effective.stdout)).toMatchObject({
        scope: 'effective',
        values: {
          nativeUser: 'user-native',
          nativeDefault: 'native-default',
          ordinary: 'project-ordinary',
        },
        sources: {
          nativeUser: 'user',
          nativeDefault: 'default',
          ordinary: 'project',
        },
      });
      expect(JSON.parse(project.stdout)).toMatchObject({
        scope: 'project',
        values: {
          nativeUser: 'legacy-project-native',
          nativeDefault: 'legacy-project-native-default',
          ordinary: 'project-ordinary',
        },
        sources: {
          nativeUser: 'project',
          nativeDefault: 'project',
          ordinary: 'project',
        },
      });

      const contextPath = path.join(root, 'artifact-render-context.json');
      await fs.writeFile(contextPath, `${JSON.stringify({
        plugin: { name: pluginName, sourceId, sourceIdentity },
        config: {
          mode: 'artifact-render',
          schema: { nativeUser: { type: 'string' } },
          values: { nativeUser: 'renderer-only' },
          sources: { nativeUser: 'user' },
          issues: [],
        },
        paths: { configStores: { user: userStorePath, project: projectStorePath } },
      })}\n`, 'utf8');
      const rendererEnv = { ...fallbackEnv, AW_PLUGIN_CONTEXT: contextPath };
      const rendererResult = await execFileAsync(process.execPath, [helperPath, 'json'], {
        cwd: projectSubdir,
        env: rendererEnv,
      });
      expect(JSON.parse(rendererResult.stdout)).toMatchObject({
        scope: 'effective',
        values: { nativeUser: 'renderer-only' },
        sources: { nativeUser: 'user' },
        paths: { configStores: {} },
      });
      await expect(execFileAsync(process.execPath, [helperPath, 'json', '--scope', 'project'], {
        cwd: projectSubdir,
        env: rendererEnv,
      })).rejects.toMatchObject({
        stderr: '[aw-config] AW_PLUGIN_CONTEXT only supports effective config reads; explicit user and project store reads are unavailable.\n',
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
