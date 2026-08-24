import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const execFileAsync = promisify(execFile),
  local = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  ctx = process.env.AW_PLUGIN_CONTEXT
    ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
    : null,
  runtimeRoot = ctx?.platform ? path.join(local, ctx.platform) : local,
  prepare = path.join(
    runtimeRoot,
    'skills/author-aw-plugin/scripts/prepare-aw-authoring-context.mjs',
  ),
  validator = path.join(
    runtimeRoot,
    'skills/author-aw-plugin/scripts/validate-json-contract.mjs',
  ),
  schemaPath = path.join(
    runtimeRoot,
    'skills/author-aw-plugin/assets/aw-authoring-context.schema.json',
  ),
  temps = [];

after(async () => Promise.all(temps.map((entry) => rm(entry, { recursive: true, force: true }))));

async function fixture({ manifest = null } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'aw-authoring-context-v3-'));
  temps.push(directory);
  const workspace = path.join(directory, 'workspace');
  const pluginRoot = path.join(workspace, 'packages', 'target-plugin');
  await mkdir(pluginRoot, { recursive: true });
  if (manifest) {
    await mkdir(path.join(pluginRoot, '.agents-plugin'), { recursive: true });
    await writeFile(
      path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
      JSON.stringify(manifest),
    );
  }
  return { directory, workspace, pluginRoot };
}

async function roundTrip(target, components, extraArgs = []) {
  const componentsPath = path.join(target.directory, 'components.json');
  const contextPath = path.join(target.directory, 'context.json');
  await writeFile(componentsPath, JSON.stringify(components));
  const result = await execFileAsync(
    process.execPath,
    [
      prepare,
      target.pluginRoot,
      '--repo-root',
      target.workspace,
      '--components',
      componentsPath,
      ...extraArgs,
    ],
    { encoding: 'utf8' },
  );
  await writeFile(contextPath, result.stdout);
  await execFileAsync(process.execPath, [validator, schemaPath, contextPath], {
    encoding: 'utf8',
  });
  return JSON.parse(result.stdout);
}

const component = (id, type, operation, paths, profiles, skillInvocation) => ({
  id,
  type,
  operation,
  paths,
  profiles,
  ...(skillInvocation === undefined ? {} : { skillInvocation }),
});

test('schema v3 publishes components without a release target field', async () => {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  assert.equal(schema.properties.schemaVersion.const, 3);
  assert.equal(schema.properties.components.minItems, 1);
  assert.equal(schema.properties.componentType, undefined);
  assert.equal(schema.properties.skillInvocation, undefined);
  assert.deepEqual(schema.properties.components.items.required, [
    'id',
    'type',
    'operation',
    'paths',
    'profiles',
  ]);
  assert.deepEqual(schema.properties.components.items.properties.type.enum, [
    'manifest',
    'skill',
    'extension',
    'slash-command',
    'mcp',
    'app',
    'dynamic-artifact',
    'config-helper',
    'lifecycle',
    'node-build',
    'readme',
    'eval-assets',
  ]);
  const appProfileRule = schema.properties.components.items.allOf.find(
    (rule) => rule.if?.properties?.type?.const === 'app',
  );
  assert.deepEqual(appProfileRule?.then?.properties?.profiles?.const, ['CODEX']);
});

test('round-trips a new plugin with two skills', async () => {
  const target = await fixture();
  const components = [
    component('manifest', 'manifest', 'create', ['.agents-plugin/plugin.json'], ['CODEX', 'CLAUDE']),
    component('author', 'skill', 'create', ['skills/author'], ['CODEX', 'CLAUDE'], 'model'),
    component('review', 'skill', 'create', ['skills/review'], ['CODEX', 'CLAUDE'], 'manual'),
  ];
  const context = await roundTrip(target, components, ['--plugin', 'target-plugin']);
  assert.equal(context.schemaVersion, 3);
  assert.equal(context.plugin, 'target-plugin');
  assert.equal(context.changeMode, 'create');
  assert.deepEqual(context.products, ['CODEX', 'CLAUDE']);
  assert.deepEqual(context.components, components);
});

test('round-trips MCP using existing CLAUDE-only manifest facts', async () => {
  const target = await fixture({
    manifest: {
      name: 'target-plugin',
      marketplace: { policy: { products: ['CLAUDE'] } },
    },
  });
  const components = [
    component('mcp', 'mcp', 'change', ['.mcp.json'], ['CLAUDE']),
  ];
  const context = await roundTrip(target, components);
  assert.equal(context.plugin, 'target-plugin');
  assert.equal(context.changeMode, 'change');
  assert.deepEqual(context.products, ['CLAUDE']);
  assert.deepEqual(context.components, components);
});

test('round-trips App using a CODEX profile', async () => {
  const target = await fixture({
    manifest: {
      name: 'target-plugin',
      marketplace: { policy: { products: ['CODEX', 'CLAUDE'] } },
    },
  });
  const components = [
    component('app', 'app', 'create', ['.app.json'], ['CODEX'], null),
  ];
  assert.deepEqual((await roundTrip(target, components)).components, components);
});

test('round-trips slash command and README', async () => {
  const target = await fixture({
    manifest: {
      name: 'target-plugin',
      marketplace: { policy: { products: ['CODEX', 'CLAUDE'] } },
    },
  });
  const components = [
    component('command', 'slash-command', 'create', ['slash-commands/run.md'], ['CODEX', 'CLAUDE']),
    component('readme', 'readme', 'change', ['README.md'], ['CODEX', 'CLAUDE']),
  ];
  assert.deepEqual((await roundTrip(target, components)).components, components);
});

test('round-trips extension and config helper', async () => {
  const target = await fixture({
    manifest: {
      name: 'target-plugin',
      marketplace: { policy: { products: ['CODEX', 'CLAUDE'] } },
    },
  });
  const components = [
    component('extension', 'extension', 'change', ['extensions/rules'], ['CODEX']),
    component('config', 'config-helper', 'create', ['scripts/aw-config.mjs'], ['CODEX', 'CLAUDE']),
  ];
  assert.deepEqual((await roundTrip(target, components)).components, components);
});

test('round-trips a Node build repair without changing the stable target', async () => {
  const target = await fixture({
    manifest: {
      name: 'target-plugin',
      marketplace: { policy: { products: ['CODEX', 'CLAUDE'] } },
    },
  });
  const components = [
    component('build', 'node-build', 'change', ['package.json', 'scripts/build.mjs'], ['CODEX', 'CLAUDE']),
  ];
  const context = await roundTrip(target, components);
  assert.equal(context.buildRequired, true);
  assert.deepEqual(context.components, components);
});

test('round-trips a Claude model Skill with Eval assets', async () => {
  const target = await fixture({
    manifest: {
      name: 'target-plugin',
      marketplace: { policy: { products: ['CLAUDE'] } },
    },
  });
  const components = [
    component('skill', 'skill', 'change', ['skills/target'], ['CLAUDE'], 'claude-model-only'),
    component('evals', 'eval-assets', 'change', ['skills/target/evals'], ['CLAUDE']),
  ];
  assert.deepEqual((await roundTrip(target, components)).components, components);
});

test('rejects invalid invocation placement and legacy single-component flags', async () => {
  const target = await fixture({
    manifest: {
      name: 'target-plugin',
      marketplace: { policy: { products: ['CODEX', 'CLAUDE'] } },
    },
  });
  const invalidPath = path.join(target.directory, 'invalid-components.json');
  await writeFile(
    invalidPath,
    JSON.stringify([
      component('readme', 'readme', 'change', ['README.md'], ['CODEX'], 'model'),
    ]),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      prepare,
      target.pluginRoot,
      '--components',
      invalidPath,
    ]),
    (error) => error.stderr.includes('skillInvocation must be null or omitted'),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [prepare, target.pluginRoot, '--component-type', 'skill']),
    (error) =>
      error.stderr.includes('was removed') &&
      error.stderr.includes('--components <json-file>'),
  );
});

test('rejects claude-model-only outside the CLAUDE-only profile', async () => {
  const target = await fixture({
    manifest: {
      name: 'target-plugin',
      marketplace: { policy: { products: ['CODEX', 'CLAUDE'] } },
    },
  });
  const invalidPath = path.join(target.directory, 'invalid-claude-components.json');
  await writeFile(
    invalidPath,
    JSON.stringify([
      component('skill', 'skill', 'change', ['skills/target'], ['CODEX', 'CLAUDE'], 'claude-model-only'),
    ]),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [prepare, target.pluginRoot, '--components', invalidPath]),
    (error) => error.stderr.includes('must use profiles ["CLAUDE"]'),
  );
});

test('rejects App outside the CODEX profile', async () => {
  const target = await fixture({
    manifest: {
      name: 'target-plugin',
      marketplace: { policy: { products: ['CLAUDE'] } },
    },
  });
  const componentsPath = path.join(target.directory, 'claude-app-components.json');
  await writeFile(
    componentsPath,
    JSON.stringify([
      component('app', 'app', 'create', ['.app.json'], ['CLAUDE'], null),
    ]),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      prepare,
      target.pluginRoot,
      '--components',
      componentsPath,
    ]),
    (error) => error.stderr.includes('with app must use profiles ["CODEX"]'),
  );
});
