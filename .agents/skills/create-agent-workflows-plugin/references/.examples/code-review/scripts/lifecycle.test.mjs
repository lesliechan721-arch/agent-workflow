import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
    },
    platform: 'codex',
    scope: 'project',
    cwd: tempDir,
    paths: {
      awHome: join(tempDir, 'aw-home'),
      configStores: {
        user: join(tempDir, 'aw-home', 'plugin-config', 'code-review', 'config.json'),
        project: join(tempDir, '.agent-workflows', 'plugin-config', 'code-review', 'config.json'),
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
