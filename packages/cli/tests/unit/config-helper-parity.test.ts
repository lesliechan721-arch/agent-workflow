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
        certificate: { type: 'string', validation: { format: 'file' } },
        workspace: { type: 'string', validation: { format: 'directory' } },
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
          properties: {
            certificate: { type: 'string', validation: { format: 'file' } },
          },
          additionalProperties: { type: 'string', validation: { format: 'directory' } },
        },
        labels: {
          type: 'object',
          properties: { 'fixed-key': { type: 'string' } },
          additionalProperties: { type: 'string' },
          validation: { key: { format: 'identifier' } },
        },
      },
    }).fields;
    const fixtures = [
      ['mode', 'x'],
      ['mode', 'safe'],
      ['certificate', './not-yet-created.pem'],
      ['certificate', ''],
      ['workspace', './not-yet-created-directory'],
      ['workspace', ''],
      ['credentials', { token: 'secret', retries: 2 }],
      ['credentials', { retries: -1 }],
      ['credentials', { token: 'secret', nested: {} }],
      ['locations', { certificate: './not-yet-created.pem', cache: './not-yet-created-directory' }],
      ['locations', { certificate: '', cache: '' }],
      ['labels', { 'fixed-key': 'fixed', dynamic_key: 'dynamic' }],
      ['labels', { 'fixed-key': 'fixed', 'bad key': 'dynamic' }],
    ] as const;

    for (const [key, value] of fixtures) {
      expect(helper.validatePluginConfigValue(fields[key]!, value, key))
        .toEqual(validatePluginConfigValue(fields[key]!, value, key));
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
});
