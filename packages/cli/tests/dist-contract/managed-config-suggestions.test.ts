import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { expect, it } from 'vitest';

import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const exec = promisify(execFile);
const cliEntry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const guideSource = fileURLToPath(new URL('../../../../plugins/agent-subagent/', import.meta.url));

// Windows requires the packaged Job helper available to the candidate installation.
it.skipIf(process.platform === 'win32')('configuration suggestions probe a managed adapter in the invoking AW home', async () => {
  const { layout, env } = getCurrentSourceTestIsolation();
  const cwd = layout.fixtureCwd;
  const shadowBin = path.join(cwd, 'shadow-bin');
  const shadowAwUsed = path.join(cwd, 'shadow-aw-used');
  const adapterObserved = path.join(cwd, 'adapter-observed.jsonl');
  await fs.outputFile(path.join(shadowBin, 'aw'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(shadowAwUsed)}, 'called');\n`, { mode: 0o700 });
  const testEnv = { ...env, PATH: [shadowBin, env.PATH].join(path.delimiter), AW_COMMAND_HOST: '{untrustedEnvironment}' };
  const run = async (args: string[]) => {
    const { stdout } = await exec(process.execPath, [cliEntry, ...args, '--json'], { cwd, env: testEnv, timeout: 20_000 });
    return JSON.parse(stdout);
  };
  expect(env.AW_HOME).not.toBe(path.join(env.HOME!, '.aw'));

  const adapterRoot = path.join(cwd, 'adapter');
  await fs.outputFile(path.join(adapterRoot, 'adapter.mjs'), `
import fs from 'node:fs/promises';
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
await fs.appendFile(${JSON.stringify(adapterObserved)}, JSON.stringify({ request, home: process.env.AW_HOME }) + ${JSON.stringify('\n')});
if (request.executor === 'stalled') setInterval(() => {}, 1000);
else console.log(JSON.stringify({ protocolVersion: 6, type: 'introspection', status: 'supported',
  environment: { status: 'available' }, models: [{ id: 'fixture-live', displayName: 'Fixture Live', isDefault: true }] }));
`);
  const { data: { commands: [{ id: commandId }] } } = await run(['command', 'install', adapterRoot, '--name', 'probe-fixture', '--runner', 'node', '--entry', 'adapter.mjs']);

  const catalog = path.join(cwd, 'catalog');
  const guide = path.join(catalog, 'plugins', 'agent-subagent');
  await fs.copy(path.join(guideSource, 'commands', 'scripts'), path.join(guide, 'commands', 'scripts'));
  await fs.copy(path.join(guideSource, 'scripts', 'config-suggestions.mjs'), path.join(guide, 'scripts', 'config-suggestions.mjs'));
  await createCatalogSnapshotFixture(catalog, 'agent-subagent', [], 'Probe fixture', (manifest) => {
    manifest.scripts = { config: { suggestions: { runner: 'node', path: './scripts/config-suggestions.mjs' } } };
    manifest.config = { schemaVersion: 5, fields: {
      subagentCommands: { type: 'array', items: { type: 'object', properties: {
        key: { type: 'string', required: true }, adapter: { type: 'string', required: true },
        commandId: { type: 'string', required: true },
        models: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', required: true } } } },
      } }, default: [
        { key: 'managed', adapter: 'custom-managed', commandId },
        { key: 'stalled', adapter: 'custom-managed', commandId, models: [{ id: 'fixture-static' }] },
      ] },
      profile: { type: 'object', properties: {
        executor: { type: 'string' }, model: { type: 'string', suggestions: { provider: 'executor-models', dependsOn: ['executor'] } },
      } },
    } };
  });
  const previous = await readCatalogSourcesConfigSnapshot(testEnv);
  await replaceCatalogSourcesConfig({ env: testEnv, expectedDigest: previous.digest, config: {
    schemaVersion: 2, sources: [{ id: 'fixture', type: 'path', primary: true, path: catalog }],
  } });
  await syncCatalogSourceGeneration({ sourceId: 'fixture', cliVersion: '1.0.0', env: testEnv });

  const suggestions = (executor: string, ...options: string[]) => run([
    'plugin', 'config', 'suggestions', 'fixture/agent-subagent', 'profile.model', '--dep', `executor=${executor}`, ...options,
  ]);
  expect(await suggestions('managed')).toMatchObject({ status: 'success', data: { status: 'ok', items: [
    { value: 'fixture-live', title: 'Fixture Live', source: 'dynamic', recommended: true },
  ] } });
  expect(await suggestions('stalled', '--timeout-ms', '4500')).toMatchObject({ status: 'success', data: { status: 'ok', items: [
    { value: 'fixture-static', title: 'fixture-static', source: 'configured' },
  ], diagnostics: [{ code: 'introspectionTimeout' }] } });
  const observed = (await fs.readFile(adapterObserved, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(observed).toEqual(['managed', 'stalled'].map((executor) => ({ home: layout.awHomeDir, request: {
    protocolVersion: 6, type: 'introspect', executor, workspace: cwd, args: [],
  } })));
  expect(await fs.pathExists(shadowAwUsed)).toBe(false);
});
