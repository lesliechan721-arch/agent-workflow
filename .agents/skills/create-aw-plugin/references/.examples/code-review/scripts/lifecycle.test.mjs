import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));

async function writeContext(tempDir, overrides = {}) {
  const contextPath = join(tempDir, 'context.json');
  const context = {
    event: 'install',
    plugin: {
      name: 'code-review',
      version: '0.2.0',
      rootDir: join(tempDir, 'bundle'),
      sourceId: 'official',
      sourceIdentity: `sha256:${'1'.repeat(64)}`,
      pluginId: 'official/code-review',
    },
    platform: 'codex',
    scope: 'project',
    cwd: tempDir,
    paths: {
      awHome: join(tempDir, 'aw-home'),
      configStores: {
        user: join(tempDir, 'aw-home', 'plugin-config', 'official', 'code-review', 'config.json'),
        project: join(tempDir, '.agent-workflows', 'plugin-config', 'official', 'code-review', 'config.json'),
        projectLocal: join(tempDir, '.agent-workflows', 'plugin-config.local', 'official', 'code-review', 'config.json'),
      },
    },
    config: {
      values: {
        reviewServiceApiKey: 'secret-token',
        reviewMode: 'strict',
        maxFilesPerReview: 12,
      },
      sources: {
        reviewServiceApiKey: 'user',
        reviewMode: 'project',
        maxFilesPerReview: 'project',
      },
      schema: {
        reviewServiceApiKey: {
          type: 'string',
          required: true,
          sensitive: true,
        },
        reviewMode: {
          type: 'enum',
          values: ['standard', 'strict'],
          default: 'standard',
        },
        maxFilesPerReview: {
          type: 'number',
          default: 20,
          min: 1,
          max: 100,
        },
      },
      issues: [],
    },
    script: {
      source: 'plugin-test',
      runner: 'node',
      path: null,
    },
    artifacts: [],
    ...overrides,
  };
  await writeFile(contextPath, JSON.stringify(context, null, 2), 'utf8');
  return { contextPath, context };
}

test('aw config helper reads effective config from AW_PLUGIN_CONTEXT', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'code-review-helper-'));
  const { contextPath } = await writeContext(tempDir);
  const helperPath = join(scriptDir, 'aw-config.mjs');

  const { stdout } = await execFileAsync(process.execPath, [helperPath, 'get', 'reviewMode'], {
    cwd: tempDir,
    env: { ...process.env, AW_PLUGIN_CONTEXT: contextPath, AW_HOME: join(tempDir, 'unused-aw-home') },
  });

  assert.equal(stdout.trim(), 'strict');
});

test('aw config helper exposes redacted values for diagnostics', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'code-review-helper-json-'));
  const { contextPath } = await writeContext(tempDir);
  const helperPath = join(scriptDir, 'aw-config.mjs');

  const { stdout } = await execFileAsync(process.execPath, [helperPath, 'json'], {
    cwd: tempDir,
    env: { ...process.env, AW_PLUGIN_CONTEXT: contextPath, AW_HOME: join(tempDir, 'unused-aw-home') },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.values.reviewServiceApiKey, 'secret-token');
  assert.equal(result.redactedValues.reviewServiceApiKey, '[redacted]');
});

test('aw config helper merges namespaced stores through project-local in no-context mode', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'code-review-helper-fallback-'));
  const awHome = join(tempDir, 'aw-home');
  const projectRoot = join(tempDir, 'project');
  const sourceId = 'official';
  const sourceIdentity = `sha256:${'2'.repeat(64)}`;
  const bundleRoot = join(awHome, 'marketplaces', sourceId, 'plugins', 'code-review');
  const helperPath = join(bundleRoot, 'scripts', 'aw-config.mjs');
  const manifestPath = join(bundleRoot, '.agents-plugin', 'plugin.json');

  await mkdir(join(projectRoot, '.git'), { recursive: true });
  await mkdir(dirname(helperPath), { recursive: true });
  await mkdir(dirname(manifestPath), { recursive: true });
  await copyFile(join(scriptDir, 'aw-config.mjs'), helperPath);
  await copyFile(join(scriptDir, '..', '.agents-plugin', 'plugin.json'), manifestPath);
  await writeFile(
    join(awHome, 'marketplaces', sourceId, 'config.json'),
    JSON.stringify({ schemaVersion: 2, sourceId, sourceIdentity, marketplaceName: 'aw' }),
    'utf8',
  );

  const envelope = (values) => ({
    schemaVersion: 2,
    sourceId,
    sourceIdentity,
    pluginName: 'code-review',
    values,
  });
  const stores = [
    [join(awHome, 'plugin-config', sourceId, 'code-review', 'config.json'), {
      reviewServiceApiKey: 'user-secret',
      reviewMode: 'strict',
      maxFilesPerReview: 10,
    }],
    [join(projectRoot, '.agent-workflows', 'plugin-config', sourceId, 'code-review', 'config.json'), {
      reviewMode: 'standard',
      maxFilesPerReview: 20,
    }],
    [join(projectRoot, '.agent-workflows', 'plugin-config.local', sourceId, 'code-review', 'config.json'), {
      maxFilesPerReview: 30,
    }],
  ];
  for (const [storePath, values] of stores) {
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, JSON.stringify(envelope(values)), 'utf8');
  }

  const env = {
    ...process.env,
    AW_HOME: awHome,
    HOME: join(tempDir, 'isolated-home'),
    AW_PLUGIN_CONTEXT: '',
  };
  const effective = JSON.parse((await execFileAsync(
    process.execPath,
    [helperPath, 'json'],
    { cwd: projectRoot, env },
  )).stdout);
  assert.equal(effective.pluginId, 'official/code-review');
  assert.deepEqual(effective.values, {
    reviewServiceApiKey: 'user-secret',
    reviewMode: 'standard',
    maxFilesPerReview: 30,
  });
  assert.deepEqual(effective.sources, {
    reviewServiceApiKey: 'user',
    reviewMode: 'projectShared',
    maxFilesPerReview: 'projectLocal',
  });

  const projectLocal = JSON.parse((await execFileAsync(
    process.execPath,
    [helperPath, 'json', '--scope', 'project-local'],
    { cwd: projectRoot, env },
  )).stdout);
  assert.equal(projectLocal.scope, 'projectLocal');
  assert.deepEqual(projectLocal.values, { maxFilesPerReview: 30 });
  assert.equal(projectLocal.sources.maxFilesPerReview, 'projectLocal');

  await writeFile(
    stores[2][0],
    JSON.stringify({ ...envelope({ maxFilesPerReview: 30 }), sourceIdentity: `sha256:${'3'.repeat(64)}` }),
    'utf8',
  );
  await assert.rejects(
    execFileAsync(process.execPath, [helperPath, 'json'], { cwd: projectRoot, env }),
    (error) => {
      assert.match(error.stderr, /schema 2 source identity/);
      return true;
    },
  );
});

test('lifecycle reads context without logging sensitive config', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'code-review-lifecycle-'));
  const { contextPath, context } = await writeContext(tempDir);
  const lifecyclePath = join(scriptDir, 'lifecycle.mjs');

  const { stdout } = await execFileAsync(process.execPath, [lifecyclePath], {
    cwd: tempDir,
    env: { ...process.env, AW_PLUGIN_CONTEXT: contextPath },
  });

  assert.match(stdout, /install lifecycle completed in strict mode/);
  assert.doesNotMatch(stdout, /secret-token/);

  const state = JSON.parse(
    await readFile(join(context.paths.awHome, 'code-review', 'last-install.json'), 'utf8'),
  );
  assert.equal(state.reviewMode, 'strict');
  assert.equal(state.maxFilesPerReview, 12);
});
