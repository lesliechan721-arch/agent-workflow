import path from 'node:path';
import { Readable } from 'node:stream';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolvePluginConfigStorePath } from '../../src/utils/plugin-config.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import { createCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(withSkill = false) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const env = isolation.env;
  await git(cwd, ['init', '--quiet']);
  const sourceRoot = path.join(cwd, 'config-source');
  await createCatalogSnapshotFixture(sourceRoot, 'demo', [], '# Config fixture\n', (manifest) => {
    manifest.platforms = ['cursor', 'generic'];
    if (withSkill) manifest.skills = './skills';
    manifest.config = { schemaVersion: 5, fields: {
      mode: { type: 'string', default: 'common-default', choices: { allowCustom: true,
        presets: [{ id: 'fast', title: 'Common fast', value: 'common-fast' }] } },
      enabled: { type: 'boolean', default: true },
      token: { type: 'string', sensitive: true },
    }, platforms: { cursor: { fields: {
      mode: { type: 'string', default: 'cursor-default', choices: { allowCustom: true,
        presets: [{ id: 'fast', title: 'Cursor fast', value: 'cursor-fast' }] } },
      cursorOnly: { type: 'number', default: 1 },
    } } } };
  });
  if (withSkill) {
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    for (const platform of ['cursor', 'generic']) {
      const skillRoot = path.join(pluginRoot, platform, 'skills', 'config-demo');
      await fs.outputFile(path.join(skillRoot, 'SKILL.md'),
        '---\nname: config-demo\ndescription: Config apply fixture.\n---\n\nFixture.\n');
      await fs.outputFile(path.join(skillRoot, 'README.md'), '# Config apply fixture\n');
      await fs.outputJson(path.join(skillRoot, 'aw-plugin-requirements.json'), createAwPluginRequirementsReceipt(
        { name: plugin.manifest.name, version: plugin.manifest.version }, plugin.manifest.requires?.aw.capabilities ?? []));
    }
    const catalog = await fs.readJson(path.join(sourceRoot, 'catalog-manifest.json'));
    catalog.entries = [await createCatalogManifestV7Entry(plugin, pluginRoot)];
    await fs.writeJson(path.join(sourceRoot, 'catalog-manifest.json'), catalog);
  }
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ env, expectedDigest: snapshot.digest,
    config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] } });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
  const file = resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'demo', scope: 'user', cwd, env });
  const run = async (args: string[], input?: string | Buffer[]) => {
    const captured = createCapturedCliIo();
    const exitCode = await runCli([...args, '--json'], {
      cwd, env, interactive: false, io: captured.io,
      ...(input === undefined ? {} : { stdin: Readable.from(typeof input === 'string' ? [input] : input) })
    });
    return { exitCode, value: JSON.parse(captured.readStdout()), stdout: captured.readStdout(), stderr: captured.readStderr() };
  };
  return { cwd, env, file, run };
}

// Test Value Gate: exercise argv, platform schema selection, the real atomic document, and save/apply receipts.
describe('platform configuration CLI', () => {
  it('uses common by default, compiles platform presets, and keeps project context in the user store', async () => {
    const f = await fixture();
    const initial = await f.run(['plugin', 'config', 'get', 'team/demo', 'mode']);
    expect(initial).toMatchObject({
      exitCode: 0, value: {
        schemaVersion: 1,
        data: {
          platform: 'common',
          context: { context: 'user' },
          fields: [{ effectiveValue: 'common-default', sourceLayer: 'default' }]
        }
      }
    });
    expect(await f.run(['plugin', 'config', 'set', 'team/demo', 'mode', '--preset', 'fast']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 1,
          data: {
            configWrite: 'succeeded',
            apply: { reason: 'notRequested' }
          }
        }
      });
    expect(await f.run(['plugin', 'config', 'set', 'team/demo', 'mode', '--platform', 'cursor', '--context', 'project', '--preset', 'fast']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 1,
          data: {
            context: { context: 'project', projectRoot: f.cwd },
            platform: 'cursor'
          }
        }
      });
    expect(await fs.readJson(f.file)).toMatchObject({ schemaVersion: 6, common: { mode: 'common-fast' }, platforms: { cursor: { mode: 'cursor-fast' } } });
    expect(await fs.pathExists(path.join(f.cwd, '.agent-workflows', 'plugin-config'))).toBe(false);
    expect(await f.run(['plugin', 'config', 'get', 'team/demo', 'mode', '--platform', 'cursor']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 1,
          data: { fields: [{ effectiveValue: 'cursor-fast', sourceLayer: 'platform' }] }
        }
      });
    expect(await f.run(['plugin', 'config', 'unset', 'team/demo', 'mode', '--platform', 'cursor']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 1,
          data: { configWrite: 'succeeded' }
        }
      });
    expect(await f.run(['plugin', 'config', 'get', 'team/demo', 'mode', '--platform', 'cursor']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 1,
          data: { fields: [{ effectiveValue: 'common-fast', sourceLayer: 'common' }] }
        }
      });
    expect(await f.run(['plugin', 'config', 'set', 'team/demo', 'cursorOnly', '--platform', 'cursor', '--value-json', '0']))
      .toMatchObject({ exitCode: 0 });
    expect(await f.run(['plugin', 'config', 'schema', 'team/demo', '--platform', 'cursor']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 1,
          data: {
            configSchemaVersion: 5,
            schema: { platform: 'cursor' },
            fields: { mode: { default: 'cursor-default' }, cursorOnly: { default: 1 }, enabled: { default: true } }
          }
        }
      });
    const resetBefore = await fs.readFile(f.file);
    expect(await f.run(['plugin', 'config', 'reset', 'team/demo', '--platform', 'cursor']))
      .toMatchObject({
        exitCode: 3, value: {
          command: 'plugin.config.reset', status: 'blocked',
          data: {
            confirmation: {
              required: true, provided: false, effects: [expect.objectContaining({
                code: 'deletePluginConfig', impact: 'user-wide', subject: { pluginId: 'team/demo', scope: 'user' },
              })]
            }
          },
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })]),
        }
      });
    expect(await fs.readFile(f.file)).toEqual(resetBefore);
    expect(await f.run(['plugin', 'config', 'reset', 'team/demo', '--platform', 'cursor', '--yes']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 1,
          data: { configWrite: 'succeeded', confirmation: { required: true, provided: true } }
        }
      });
    expect((await fs.readJson(f.file)).common).toEqual({ mode: 'common-fast' });
    expect((await fs.readJson(f.file)).platforms).toEqual({});
  });

  it.each([
    { args: ['plugin', 'config', 'set', 'team/demo', 'mode', '--scope', 'project', '--value-json', '"bad"'], code: 'invalidArguments' },
    { args: ['plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"bad"', '--apply-scope', 'project'], code: 'invalidArguments' },
    { args: ['plugin', 'config', 'set', 'team/demo', 'mode', '--platform', 'claude-code', '--value-json', '"bad"'], code: 'invalidOptionValue' },
    { args: ['plugin', 'config', 'set', 'team/demo', 'mode', '--platform', 'agent-skills', '--value-json', '"bad"'], code: 'invalidOptionValue' },
    { args: ['plugin', 'config', 'set', 'team/demo', 'mode', '--context', 'unknown', '--value-json', '"bad"'], code: 'invalidOptionValue' },
    { args: ['plugin', 'config', 'apply', 'team/demo', '--scope', 'user'], code: 'invalidArguments' },
    { args: ['plugin', 'config', 'apply', 'team/demo', '--target', 'gemini'], code: 'invalidArguments' },
  ])('rejects invalid arguments before changing the common document: $args', async ({ args, code }) => {
    const f = await fixture();
    expect(await f.run(['plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"saved"'])).toMatchObject({ exitCode: 0 });
    const before = await fs.readFile(f.file);
    const result = await f.run(args);
    expect(result).toMatchObject({
      exitCode: 2, value: {
        schemaVersion: 1,
        command: `plugin.config.${args[2]}`,
        status: 'failed',
        diagnostics: [{ code }],
        data: {}
      }
    });
    expect(result.value.data).toEqual({});
    expect(await fs.readFile(f.file)).toEqual(before);
  });

  it('keeps exact sensitive stdin bytes and rejects sensitive argv from a project context', async () => {
    const f = await fixture();
    const secret = ' \t密钥 café 🔑\r\nline-two\n';
    const bytes = Buffer.from(secret, 'utf8');
    const chunks = [bytes.subarray(0, 3), bytes.subarray(3, 14), bytes.subarray(14)];
    const rejected = await f.run(['plugin', 'config', 'set', 'team/demo', 'token', '--context', 'project', '--value-json', JSON.stringify(secret)]);
    expect(rejected).toMatchObject({
      exitCode: 2, value: {
        schemaVersion: 1,
        command: 'plugin.config.set',
        status: 'failed',
        diagnostics: [{ code: 'sensitiveConfigInputUnsupported' }],
        data: {}
      }
    });
    expect(rejected.value.data).toEqual({});
    expect(rejected.stdout + rejected.stderr).not.toContain('密钥');
    expect(rejected.stdout + rejected.stderr).not.toContain('line-two');
    expect(await fs.pathExists(f.file)).toBe(false);
    const saved = await f.run(['plugin', 'config', 'set', 'team/demo', 'token', '--context', 'project', '--value-stdin'], chunks);
    expect(saved).toMatchObject({
      exitCode: 0, value: {
        schemaVersion: 1,
        data: { configWrite: 'succeeded' }
      }
    });
    expect(saved.stdout + saved.stderr).not.toContain('密钥');
    expect(saved.stdout + saved.stderr).not.toContain('line-two');
    expect(Buffer.from((await fs.readJson(f.file)).common.token, 'utf8')).toEqual(bytes);
    const read = await f.run(['plugin', 'config', 'get', 'team/demo', 'token']);
    expect(read.stdout + read.stderr).not.toContain('密钥');
    expect(read.stdout + read.stderr).not.toContain('line-two');
  });

  it('reports a committed save separately when joint application is blocked', async () => {
    const f = await fixture(true);
    expect(await f.run(['target', 'set', 'cursor'])).toMatchObject({ exitCode: 0 });
    expect(await f.run(['plugin', 'install', 'team/demo', '--scope', 'project', '--yes']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 1,
          data: { targetResults: [expect.objectContaining({ pluginId: 'team/demo', target: 'cursor', scope: 'project', execution: 'applied' })] }
        }
      });
    const output = path.join(f.cwd, '.cursor', 'skills', 'config-demo');
    await fs.remove(path.join(output, SKILL_OWNER_MARKER));
    const existing = await fs.readFile(path.join(output, 'SKILL.md'));
    const result = await f.run(['plugin', 'config', 'set', 'team/demo', 'enabled', '--value-json', 'false', '--apply', '--yes']);
    expect(result).toMatchObject({
      exitCode: 4, value: {
        schemaVersion: 1,
        status: 'partial',
        data: {
          configWrite: 'succeeded',
          context: { context: 'project', projectRoot: f.cwd }
        }
      }
    });
    expect(result.value.data.apply.state).not.toBe('succeeded');
    expect((await fs.readJson(f.file)).common.enabled).toBe(false);
    expect(await fs.readFile(path.join(output, 'SKILL.md'))).toEqual(existing);
    expect(await fs.pathExists(path.join(output, SKILL_OWNER_MARKER))).toBe(false);
    const applied = await f.run(['plugin', 'config', 'apply', 'team/demo', '--context', 'project', '--target', 'cursor', '--yes']);
    expect(applied.value).toMatchObject({
      schemaVersion: 1,
      command: 'plugin.config.apply',
      data: { configWrite: 'notStarted' }
    });
    expect((await fs.readJson(f.file)).common.enabled).toBe(false);
  });
});
