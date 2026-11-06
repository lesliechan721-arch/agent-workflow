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
  const run = async (args: string[], input?: string) => {
    const captured = createCapturedCliIo();
    const exitCode = await runCli(['plugin', ...args, '--json'], { cwd, env, interactive: false, io: captured.io,
      ...(input === undefined ? {} : { stdin: Readable.from([input]) }) });
    return { exitCode, value: JSON.parse(captured.readStdout()), stdout: captured.readStdout(), stderr: captured.readStderr() };
  };
  return { cwd, env, file, run };
}

// Test Value Gate: exercise argv, platform schema selection, the real atomic document, and save/apply receipts.
describe('platform configuration CLI', () => {
  it('uses common by default, compiles platform presets, and keeps project context in the user store', async () => {
    const f = await fixture();
    const initial = await f.run(['config', 'get', 'team/demo', 'mode']);
    expect(initial).toMatchObject({ exitCode: 0, value: { platform: 'common', context: { context: 'user' },
      fields: [{ effectiveValue: 'common-default', sourceLayer: 'default' }] } });
    expect(await f.run(['config', 'set', 'team/demo', 'mode', '--preset', 'fast']))
      .toMatchObject({ exitCode: 0, value: { configWrite: 'succeeded', apply: { reason: 'notRequested' } } });
    expect(await f.run(['config', 'set', 'team/demo', 'mode', '--platform', 'cursor', '--context', 'project', '--preset', 'fast']))
      .toMatchObject({ exitCode: 0, value: { context: { context: 'project', projectRoot: f.cwd }, platform: 'cursor' } });
    expect(await fs.readJson(f.file)).toMatchObject({ schemaVersion: 6, common: { mode: 'common-fast' }, platforms: { cursor: { mode: 'cursor-fast' } } });
    expect(await fs.pathExists(path.join(f.cwd, '.agent-workflows', 'plugin-config'))).toBe(false);
    expect(await f.run(['config', 'get', 'team/demo', 'mode', '--platform', 'cursor']))
      .toMatchObject({ exitCode: 0, value: { fields: [{ effectiveValue: 'cursor-fast', sourceLayer: 'platform' }] } });
    expect(await f.run(['config', 'unset', 'team/demo', 'mode', '--platform', 'cursor']))
      .toMatchObject({ exitCode: 0, value: { configWrite: 'succeeded' } });
    expect(await f.run(['config', 'get', 'team/demo', 'mode', '--platform', 'cursor']))
      .toMatchObject({ exitCode: 0, value: { fields: [{ effectiveValue: 'common-fast', sourceLayer: 'common' }] } });
    expect(await f.run(['config', 'set', 'team/demo', 'cursorOnly', '--platform', 'cursor', '--value-json', '0']))
      .toMatchObject({ exitCode: 0 });
    expect(await f.run(['config', 'schema', 'team/demo', '--platform', 'cursor']))
      .toMatchObject({ exitCode: 0, value: { configSchemaVersion: 5, schema: { platform: 'cursor' },
        fields: { mode: { default: 'cursor-default' }, cursorOnly: { default: 1 }, enabled: { default: true } } } });
    expect(await f.run(['config', 'reset', 'team/demo', '--platform', 'cursor', '--yes']))
      .toMatchObject({ exitCode: 0, value: { configWrite: 'succeeded' } });
    expect((await fs.readJson(f.file)).common).toEqual({ mode: 'common-fast' });
    expect((await fs.readJson(f.file)).platforms).toEqual({});
  });

  it.each([
    ['config', 'set', 'team/demo', 'mode', '--scope', 'project', '--value-json', '"bad"'],
    ['config', 'set', 'team/demo', 'mode', '--value-json', '"bad"', '--apply-scope', 'project'],
    ['config', 'set', 'team/demo', 'mode', '--platform', 'claude-code', '--value-json', '"bad"'],
    ['config', 'set', 'team/demo', 'mode', '--platform', 'agent-skills', '--value-json', '"bad"'],
    ['config', 'set', 'team/demo', 'mode', '--context', 'unknown', '--value-json', '"bad"'],
    ['config', 'apply', 'team/demo', '--scope', 'user'],
    ['config', 'apply', 'team/demo', '--target', 'gemini'],
  ])('rejects retired arguments before changing the common document: %s', async (...args) => {
    const f = await fixture();
    expect(await f.run(['config', 'set', 'team/demo', 'mode', '--value-json', '"saved"'])).toMatchObject({ exitCode: 0 });
    const before = await fs.readFile(f.file);
    const result = await f.run(args);
    expect(result).toMatchObject({ exitCode: 2, value: { ok: false, errors: [{ code: 'invalidArguments' }] } });
    expect(await fs.readFile(f.file)).toEqual(before);
  });

  it('keeps exact sensitive stdin bytes and rejects sensitive argv from a project context', async () => {
    const f = await fixture();
    const secret = 'line-one\nline-two\n';
    const rejected = await f.run(['config', 'set', 'team/demo', 'token', '--context', 'project', '--value-json', JSON.stringify(secret)]);
    expect(rejected).toMatchObject({ exitCode: 1, value: { configWrite: 'notStarted', errors: [{ code: 'sensitiveConfigInputUnsupported' }] } });
    expect(rejected.stdout + rejected.stderr).not.toContain(secret);
    expect(await fs.pathExists(f.file)).toBe(false);
    expect(await f.run(['config', 'set', 'team/demo', 'token', '--context', 'project', '--value-stdin'], secret))
      .toMatchObject({ exitCode: 0, value: { configWrite: 'succeeded' } });
    expect((await fs.readJson(f.file)).common.token).toBe(secret);
    const read = await f.run(['config', 'get', 'team/demo', 'token']);
    expect(read.stdout).not.toContain('line-one');
  });

  it('reports a committed save separately when joint application is blocked', async () => {
    const f = await fixture(true);
    expect(await f.run(['targets', 'set', 'cursor'])).toMatchObject({ exitCode: 0 });
    expect(await f.run(['install', 'team/demo', '--scope', 'project', '--yes']))
      .toMatchObject({ exitCode: 0, value: { targetResults: [expect.objectContaining({ agent: 'cursor', execution: 'applied' })] } });
    const output = path.join(f.cwd, '.cursor', 'skills', 'config-demo');
    await fs.remove(path.join(output, SKILL_OWNER_MARKER));
    const existing = await fs.readFile(path.join(output, 'SKILL.md'));
    const result = await f.run(['config', 'set', 'team/demo', 'enabled', '--value-json', 'false', '--apply', '--yes']);
    expect(result).toMatchObject({ exitCode: 1, value: { configWrite: 'succeeded', overallState: 'partial',
      context: { context: 'project', projectRoot: f.cwd } } });
    expect(result.value.apply.state).not.toBe('succeeded');
    expect((await fs.readJson(f.file)).common.enabled).toBe(false);
    expect(await fs.readFile(path.join(output, 'SKILL.md'))).toEqual(existing);
    expect(await fs.pathExists(path.join(output, SKILL_OWNER_MARKER))).toBe(false);
    const applied = await f.run(['config', 'apply', 'team/demo', '--context', 'project', '--target', 'cursor', '--yes']);
    expect(applied.value).toMatchObject({ receiptSchemaVersion: 7, command: 'config:apply', configWrite: 'notStarted' });
    expect((await fs.readJson(f.file)).common.enabled).toBe(false);
  });
});
