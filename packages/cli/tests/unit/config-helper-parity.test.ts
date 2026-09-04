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
          validation: { minLength: 2, maxLength: 20, pattern: '\\p{Latin}+' },
        },
        endpoint: { type: 'string', validation: { format: 'url' } },
        credentials: {
          type: 'object',
          properties: {
            token: { type: 'string', required: true },
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

  it('redacts a top-level sensitive string from get and JSON output', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-config-helper-redaction-'));
    try {
      const contextPath = path.join(root, 'context.json');
      const helperPath = path.join(packageRoot, 'authoring', 'assets', 'aw-config.mjs');
      await fs.writeFile(contextPath, `${JSON.stringify({
        plugin: {
          name: 'fixture-plugin',
          sourceId: 'fixture-source',
          sourceIdentity: `sha256:${'a'.repeat(64)}`,
          logicalIdentity: 'fixture-catalog',
        },
        config: {
          schema: {
            token: { type: 'string', required: true, sensitive: true },
          },
          values: { token: 'top-level-secret' },
          sources: { token: 'user', ignored: 'projectLocal' },
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
        execFileAsync(process.execPath, [helperPath, 'get', 'token'], { cwd: root, env }),
      ]);

      expect(json.stdout).not.toContain('top-level-secret');
      expect(get.stdout).not.toContain('top-level-secret');
      expect(JSON.parse(json.stdout).values.token).toBe('[redacted]');
      expect(JSON.parse(json.stdout).paths.configStores).toEqual({});
      expect(new Set(Object.values(JSON.parse(json.stdout).sources)))
        .toEqual(new Set(['user']));
      expect(get.stdout).toBe('[redacted]\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
