import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  runChild,
  runPluginEvals,
  terminatePosixProcessTree,
  terminateWindowsProcessTree,
} from '../../scripts/eval-plugin-skills.js';
import { resetCodexEvalSignalShutdownForTests } from '../../scripts/codex-eval-runtime-config.js';
import {
  assertProcessTreeInspectionAvailable,
  createWindowsChildProcessTreeMonitor,
  processTreeCleanupIsUnconfirmed,
} from '../../scripts/codex-eval-process-tree.js';
import {
  registerCurrentTestReadonlyFixtureRoot,
  registerCurrentTestWritableStateRoot,
} from '../setup/test-isolation.js';

const tempDirs: string[] = [];

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

async function writeFakeCodex(root: string, skillName: string): Promise<string> {
  const codexBin = path.join(root, 'fake-codex');
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "if (process.argv[2] === '--version') { process.stdout.write('codex-fake 1.0\\n'); process.exit(0); }",
    "const sessionDir = path.join(process.env.CODEX_HOME, 'sessions');",
    'fs.mkdirSync(sessionDir, { recursive: true });',
    'fs.writeFileSync(path.join(sessionDir, "rollout.jsonl"), JSON.stringify({',
    "  type: 'response_item',",
    "  payload: { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ agent_type: 'worker', message: 'inspect' }), call_id: 'spawn-1' },",
    "}) + '\\n');",
    'const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
    `send({ type: "item.completed", item: { type: "command_execution", status: "completed", exit_code: 0, command: "cat .agents/skills/${skillName}/SKILL.md" } });`,
    'send({ type: "item.completed", item: { type: "collab_tool_call", tool: "spawn_agent", prompt: "inspect" } });',
    'send({ type: "turn.completed", usage: { total_tokens: 7 } });',
    'setTimeout(() => process.exit(0), 25);',
  ].join('\n'), 'utf8');
  await fs.chmod(codexBin, 0o755);
  return codexBin;
}

async function writeProviderCheckingFakeCodex(root: string, skillName: string): Promise<string> {
  const codexBin = path.join(root, 'fake-provider-codex');
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "if (process.argv[2] === '--version') { process.stdout.write('fixture-secret https://example.invalid/v1\\n'); process.exit(0); }",
    "if (process.argv.includes('--ignore-user-config')) { process.stderr.write('user config was ignored\\n'); process.exit(9); }",
    "const config = fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');",
    "if (!config.includes('model_provider = \"fixture-provider\"')) { process.stderr.write('provider missing\\n'); process.exit(10); }",
    "if (config.includes('[plugins.') || config.includes('[mcp_servers.')) { process.stderr.write('unsafe config copied\\n'); process.exit(11); }",
    "if (fs.existsSync(path.join(process.env.CODEX_HOME, 'auth.json'))) { process.stderr.write('official auth copied\\n'); process.exit(12); }",
    "if (process.env.OPENAI_API_KEY || process.env.UNRELATED_SECRET) { process.stderr.write('unrelated environment copied\\n'); process.exit(13); }",
    'const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
    `send({ type: "item.completed", item: { type: "command_execution", status: "completed", exit_code: 0, command: "cat .agents/skills/${skillName}/SKILL.md" } });`,
    'send({ type: "item.completed", item: { type: "agent_message", text: "fixture-secret https://example.invalid/v1" } });',
    "process.stderr.write('fixture-secret https://example.invalid/v1\\n');",
    'send({ type: "turn.completed", usage: { total_tokens: 7 } });',
  ].join('\n'), 'utf8');
  await fs.chmod(codexBin, 0o755);
  return codexBin;
}

async function writeCommandPlugin(
  repo: string,
  options: {
    name: string;
    script: string;
    defaultRuns: number;
    perRunTimeoutMs: number;
    suiteTimeoutMs: number;
    supports: string[];
  },
): Promise<void> {
  const pluginRoot = path.join(repo, 'plugins', options.name);
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.ensureDir(path.join(pluginRoot, 'skills', options.name, 'agents'));
  await fs.ensureDir(path.join(pluginRoot, 'evals'));
  await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
    name: options.name,
    version: '0.1.0',
    description: 'Exercise the central command suite contract.',
    compatibility: { aw: { minVersion: '0.0.0' } },
    skills: './skills',
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
    },
  }, { spaces: 2 });
  await fs.writeFile(
    path.join(pluginRoot, 'skills', options.name, 'SKILL.md'),
    [
      '---',
      `name: ${options.name}`,
      'description: Use only to test the central command suite contract.',
      'disable-model-invocation: true',
      'user-invocable: true',
      '---',
      '',
      '# Timeout Demo',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(pluginRoot, 'skills', options.name, 'agents', 'openai.yaml'),
    'policy:\n  allow_implicit_invocation: false\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(pluginRoot, 'evals', 'runner.mjs'),
    options.script,
    'utf8',
  );
  await fs.writeJson(path.join(pluginRoot, 'evals', 'manifest.json'), {
    schemaVersion: 1,
    plugin: options.name,
    profiles: [{
      id: 'project-default',
      scope: 'project',
      config: {},
      runModel: true,
      requiredForRelease: true,
    }],
    suites: [{
      id: 'command',
      kind: 'command',
      entry: './evals/runner.mjs',
      profiles: ['project-default'],
      defaultRuns: options.defaultRuns,
      releaseSplits: [],
      requiredForRelease: true,
      perRunTimeoutMs: options.perRunTimeoutMs,
      suiteTimeoutMs: options.suiteTimeoutMs,
      supports: options.supports,
    }],
  }, { spaces: 2 });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin eval runner', () => {
  it('prints help without treating it as an argument error', async () => {
    let stdout = '';
    const exitCode = await runPluginEvals(['--help'], {
      stdout: (text) => { stdout += text; },
      stderr: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: pnpm plugin:eval');
    expect(stdout).toContain('--materialize-only');
    expect(stdout).toContain('--model-provider');
    expect(stdout).toContain('--codex-config');
    expect(stdout).toContain('--no-inherit-codex-config');
  });

  it('rejects plugin path traversal before resolving a manifest', async () => {
    let stderr = '';
    const exitCode = await runPluginEvals(['../skill-review', '--materialize-only'], {
      repoRoot: repoRoot(),
      stderr: (text) => { stderr += text; },
    });

    expect(exitCode).toBe(2);
    expect(stderr).toContain('without path separators');
  });

  it('materializes every Codex profile through the real staging and renderer paths', async () => {
    const root = repoRoot();
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-all-'));
    tempDirs.push(outputRoot);
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    let stdout = '';
    let stderr = '';

    const exitCode = await runPluginEvals([
      '--all',
      '--materialize-only',
      '--output-dir',
      outputRoot,
    ], {
      repoRoot: root,
      env: process.env,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    });

    expect(exitCode, stderr).toBe(0);
    const commandReport = JSON.parse(stdout);
    expect(commandReport.bundles.map((bundle: { plugin: string }) => bundle.plugin).sort()).toEqual([
      'ask-me',
      'codex-explore',
      'codex-subagent-guide',
      'git-commit',
    ]);
    for (const bundle of commandReport.bundles) {
      expect(bundle).toMatchObject({
        platform: 'codex',
        codexVersion: null,
        outcome: 'passed',
        complete: true,
        mechanicalPassed: true,
        suites: [],
      });
      expect(bundle.subjects).toEqual(expect.arrayContaining([
        expect.objectContaining({
          profile: 'project-default',
          scope: 'project',
          modelExecution: true,
          evidenceLevel: 'runtime-project',
        }),
        expect.objectContaining({
          profile: 'user-default',
          scope: 'user',
          modelExecution: false,
          evidenceLevel: 'materialized-user',
        }),
      ]));
      await expect(
        fs.pathExists(path.join(outputRoot, bundle.plugin, 'evaluation.json')),
      ).resolves.toBe(true);
    }

    for (const pluginName of ['codex-explore', 'codex-subagent-guide']) {
      const bundle = commandReport.bundles.find(
        (entry: { plugin: string }) => entry.plugin === pluginName,
      );
      expect(bundle.subjects).toHaveLength(4);
      const defaultProfile = bundle.subjects.find(
        (entry: { profile: string }) => entry.profile === 'project-default',
      );
      const nondefaultProfile = bundle.subjects.find(
        (entry: { profile: string }) => entry.profile === 'project-nondefault',
      );
      expect(nondefaultProfile.configDigest).not.toBe(defaultProfile.configDigest);
      expect(nondefaultProfile.modelExecution).toBe(false);
      expect(nondefaultProfile.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'skill' }),
        expect.objectContaining({ kind: 'agent' }),
        expect.objectContaining({ kind: 'instruction' }),
      ]));
    }
  });

  it('rejects suite flags that the selected driver cannot honor', async () => {
    const root = repoRoot();
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-flags-'));
    tempDirs.push(outputRoot);
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    let stderr = '';

    const exitCode = await runPluginEvals([
      'ask-me',
      '--no-inherit-codex-config',
      '--suite',
      'requirements-clarifier-behavior',
      '--split',
      'validation',
      '--output-dir',
      outputRoot,
    ], {
      repoRoot: root,
      env: process.env,
      stdout: () => undefined,
      stderr: (text) => { stderr += text; },
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      'Conversation suite "requirements-clarifier-behavior" does not support --split.',
    );
  });

  it.runIf(process.platform !== 'win32')(
    'runs a selected trigger case from a non-first release split',
    async () => {
      const root = repoRoot();
      const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-case-'));
      tempDirs.push(outputRoot);
      registerCurrentTestReadonlyFixtureRoot(root);
      registerCurrentTestWritableStateRoot(outputRoot);
      const codexBin = await writeFakeCodex(outputRoot, 'codex-explore');
      let stdout = '';
      let stderr = '';

      const exitCode = await runPluginEvals([
        'codex-explore',
        '--no-inherit-codex-config',
        '--suite',
        'trigger',
        '--case',
        'casual_unknown_repo',
        '--runs',
        '1',
        '--codex-bin',
        codexBin,
        '--output-dir',
        outputRoot,
      ], {
        repoRoot: root,
        env: process.env,
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
      });

      expect(exitCode, stderr).toBe(1);
      expect(stderr).toContain('codex-explore/trigger/all');
      expect(stderr).not.toContain('codex-explore/trigger/validation');
      const commandReport = JSON.parse(stdout);
      expect(commandReport.bundles[0]).toMatchObject({
        outcome: 'incomplete',
        complete: false,
        mechanicalPassed: true,
        diagnostics: expect.arrayContaining([
          expect.stringContaining('--suite'),
          expect.stringContaining('--case'),
          expect.stringContaining('--runs'),
        ]),
      });
      expect(commandReport.bundles[0].suites).toEqual([
        expect.objectContaining({ split: 'all', outcome: 'passed' }),
      ]);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'inherits only the selected Codex provider and keeps embedded credentials out of reports',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-provider-'));
      const sourceCodexHome = path.join(root, 'source-codex-home');
      const outputRoot = path.join(root, 'output');
      tempDirs.push(root);
      await fs.ensureDir(sourceCodexHome);
      await fs.writeFile(path.join(sourceCodexHome, 'auth.json'), '{"token":"official"}\n', 'utf8');
      await fs.writeFile(path.join(sourceCodexHome, 'config.toml'), [
        'model = "fixture-model"',
        'model_provider = "fixture-provider"',
        '',
        '[model_providers.fixture-provider]',
        'name = "Fixture"',
        'base_url = "https://example.invalid/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        'experimental_bearer_token = "fixture-secret"',
        '',
        '[plugins."do-not-copy@local"]',
        'enabled = true',
      ].join('\n'), 'utf8');
      const codexBin = await writeProviderCheckingFakeCodex(root, 'requirements-clarifier');
      let stdout = '';
      let stderr = '';

      const exitCode = await runPluginEvals([
        'ask-me',
        '--suite',
        'requirements-clarifier-trigger',
        '--case',
        'p06_explicit_complete',
        '--runs',
        '1',
        '--codex-bin',
        codexBin,
        '--output-dir',
        outputRoot,
      ], {
        repoRoot: repoRoot(),
        env: {
          ...process.env,
          CODEX_HOME: sourceCodexHome,
          OPENAI_API_KEY: 'official-api-key',
          UNRELATED_SECRET: 'unrelated-secret',
        },
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
      });

      expect(exitCode, stderr).toBe(1);
      const commandReport = JSON.parse(stdout);
      expect(commandReport.bundles[0]).toMatchObject({
        model: 'fixture-model',
        modelProvider: 'fixture-provider',
        credentialSource: 'embedded',
        outcome: 'incomplete',
        complete: false,
      });
      expect(stdout).not.toContain('fixture-secret');
      expect(stdout).not.toContain('https://example.invalid/v1');
      expect(stderr).not.toContain('fixture-secret');
      expect(stderr).not.toContain('https://example.invalid/v1');
      expect(
        await fs.readFile(path.join(outputRoot, 'ask-me', 'evaluation.json'), 'utf8'),
      ).not.toContain('fixture-secret');
      expect(
        await fs.readFile(
          path.join(
            outputRoot,
            'ask-me',
            'reports',
            'requirements-clarifier-trigger-all-project-default.json',
          ),
          'utf8',
        ),
      ).not.toContain('https://example.invalid/v1');
    },
  );

  it('redacts command-suite provider values and excludes unrelated host secrets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-command-redaction-'));
    const outputRoot = path.join(root, 'output');
    const sourceCodexHome = path.join(root, 'source-codex-home');
    tempDirs.push(root);
    await writeCommandPlugin(root, {
      name: 'redaction-demo',
      script: [
        "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        "if (process.env.UNRELATED_SECRET || process.env.OPENAI_API_KEY) process.exit(9);",
        "const config = await readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');",
        "const endpoint = config.match(/base_url = \\\"([^\\\"]+)/)?.[1];",
        "process.stderr.write(`${process.env.CUSTOM_TOKEN} ${endpoint}\\n`);",
        "const output = process.argv[process.argv.indexOf('--output') + 1];",
        "await mkdir(path.dirname(output), { recursive: true });",
        "await writeFile(output, JSON.stringify({ complete: true, passed: true, summary: { token: process.env.CUSTOM_TOKEN, endpoint, owner: process.env.AW_CODEX_EVAL_PROCESS_TREE_ID } }));",
        "process.stdout.write(JSON.stringify({ complete: true, passed: true, summary: { token: process.env.CUSTOM_TOKEN, endpoint } }));",
      ].join('\n'),
      defaultRuns: 1,
      perRunTimeoutMs: 1_000,
      suiteTimeoutMs: 2_000,
      supports: ['codexBin'],
    });
    await fs.ensureDir(sourceCodexHome);
    await fs.writeFile(path.join(sourceCodexHome, 'config.toml'), [
      'model_provider = "custom"',
      '[model_providers.custom]',
      'name = "Custom"',
      'base_url = "https://private.invalid/v1"',
      'env_key = "CUSTOM_TOKEN"',
    ].join('\n'), 'utf8');
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    let stdout = '';
    let stderr = '';

    const exitCode = await runPluginEvals([
      'redaction-demo',
      '--codex-bin',
      process.execPath,
      '--output-dir',
      outputRoot,
    ], {
      repoRoot: root,
      env: {
        ...process.env,
        CODEX_HOME: sourceCodexHome,
        CUSTOM_TOKEN: 'command-token',
        OPENAI_API_KEY: 'official-api-key',
        UNRELATED_SECRET: 'unrelated-secret',
      },
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    });

    expect(exitCode, stderr).toBe(0);
    expect(stdout).not.toContain('command-token');
    expect(stdout).not.toContain('https://private.invalid/v1');
    expect(stderr).toContain('[redacted] [redacted]\n');
    expect(stderr).not.toContain('command-token');
    expect(stderr).not.toContain('https://private.invalid/v1');
    const evaluation = await fs.readFile(
      path.join(outputRoot, 'redaction-demo', 'evaluation.json'),
      'utf8',
    );
    expect(evaluation).not.toContain('command-token');
    expect(evaluation).not.toContain('https://private.invalid/v1');
    const persistedReport = await fs.readFile(
      path.join(outputRoot, 'redaction-demo', 'reports', 'command-project-default.json'),
      'utf8',
    );
    expect(persistedReport).not.toContain('command-token');
    expect(persistedReport).not.toContain('https://private.invalid/v1');
    expect(persistedReport).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u,
    );
    expect(persistedReport).toContain('[redacted]');
    expect(persistedReport).toContain('[process-tree-id]');
  });

  it('isolates raw command reports for plugins with the same suite identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-command-isolation-'));
    const outputRoot = path.join(root, 'output');
    tempDirs.push(root);
    await writeCommandPlugin(root, {
      name: 'first-command',
      script: [
        "import { mkdir, writeFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        "const outputIndex = process.argv.indexOf('--output');",
        'const output = process.argv[outputIndex + 1];',
        'await mkdir(path.dirname(output), { recursive: true });',
        "await writeFile(output, JSON.stringify({ complete: true, passed: true, summary: { plugin: 'first' } }));",
      ].join('\n'),
      defaultRuns: 1,
      perRunTimeoutMs: 1_000,
      suiteTimeoutMs: 2_000,
      supports: [],
    });
    await writeCommandPlugin(root, {
      name: 'second-command',
      script: "process.stdout.write(JSON.stringify({ complete: true, passed: false, summary: { plugin: 'second' } }));\n",
      defaultRuns: 1,
      perRunTimeoutMs: 1_000,
      suiteTimeoutMs: 2_000,
      supports: [],
    });
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    let stdout = '';
    let stderr = '';

    const exitCode = await runPluginEvals([
      '--all',
      '--no-inherit-codex-config',
      '--output-dir',
      outputRoot,
    ], {
      repoRoot: root,
      env: process.env,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    });

    expect(exitCode, stderr).toBe(1);
    const bundles = JSON.parse(stdout).bundles as Array<{
      plugin: string;
      suites: Array<{ outcome: string; summary: { plugin: string } }>;
    }>;
    expect(bundles.find((bundle) => bundle.plugin === 'first-command')?.suites[0]).toMatchObject({
      outcome: 'passed',
      summary: { plugin: 'first' },
    });
    expect(bundles.find((bundle) => bundle.plugin === 'second-command')?.suites[0]).toMatchObject({
      outcome: 'failed',
      summary: { plugin: 'second' },
    });
  });

  it.runIf(process.platform !== 'win32')(
    'reports an incomplete suite and kills descendants of a timed-out command',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-timeout-'));
      const outputRoot = path.join(root, 'output');
      const descendantMarker = path.join(root, 'descendant-finished');
      tempDirs.push(root);
      const descendantScript = [
        "const fs = require('node:fs');",
        'process.on("SIGTERM", () => {});',
        `setTimeout(() => { fs.writeFileSync(${JSON.stringify(descendantMarker)}, 'alive'); process.exit(0); }, 1800);`,
      ].join('\n');
      await writeCommandPlugin(root, {
        name: 'timeout-demo',
        script: [
          "import { spawn } from 'node:child_process';",
          `spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: 'ignore' });`,
          'process.on("SIGTERM", () => {});',
          'setInterval(() => {}, 1000);',
        ].join('\n'),
        defaultRuns: 1,
        perRunTimeoutMs: 100,
        suiteTimeoutMs: 500,
        supports: ['codexBin'],
      });
      registerCurrentTestReadonlyFixtureRoot(root);
      registerCurrentTestWritableStateRoot(outputRoot);
      const startedAt = Date.now();
      let stdout = '';
      let stderr = '';

      const exitCode = await runPluginEvals([
        'timeout-demo',
        '--no-inherit-codex-config',
        '--suite',
        'command',
        '--codex-bin',
        process.execPath,
        '--output-dir',
        outputRoot,
      ], {
        repoRoot: root,
        env: process.env,
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
      });

      expect(exitCode).toBe(1);
      expect(stderr).toContain('Suite exceeded central timeout of 500ms.');
      const commandReport = JSON.parse(stdout);
      expect(commandReport.bundles[0].suites).toEqual([
        expect.objectContaining({
          outcome: 'incomplete',
          complete: false,
          mechanicalPassed: false,
          diagnostics: expect.arrayContaining([expect.stringContaining('signal=SIGKILL')]),
        }),
      ]);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await expect(fs.pathExists(descendantMarker)).resolves.toBe(false);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'cleans a detached descendant after a successful command closes',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-success-tree-'));
      tempDirs.push(root);
      const marker = path.join(root, 'descendant-survived');
      const pidPath = path.join(root, 'descendant-pid');
      const descendantScript = [
        'process.on("SIGTERM", () => {});',
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 300);`,
        'setInterval(() => {}, 1000);',
      ].join('\n');
      const rootScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: 'ignore' });`,
        'child.unref();',
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
        'process.exit(0);',
      ].join('\n');
      let descendantPid: number | undefined;
      let cleanupStderr = '';
      try {
        await expect(runChild(process.execPath, ['-e', rootScript], {
          cwd: root,
          env: process.env,
          stderr: (text) => { cleanupStderr += text; },
          timeoutMs: 2_000,
        })).resolves.toMatchObject({ exitCode: 0, timedOut: false });
        descendantPid = Number(await fs.readFile(pidPath, 'utf8'));
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(await fs.pathExists(marker), cleanupStderr).toBe(false);
      } finally {
        if (descendantPid) {
          try {
            process.kill(descendantPid, 'SIGKILL');
          } catch {
            // Best-effort test cleanup.
          }
        }
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'keeps the process-tree token out of command output',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-tree-token-'));
      tempDirs.push(root);
      let renderedStderr = '';
      const result = await runChild(process.execPath, ['-e', [
        "const value = process.env.AW_CODEX_EVAL_PROCESS_TREE_ID;",
        'process.stdout.write(value);',
        'process.stderr.write(value);',
      ].join('\n')], {
        cwd: root,
        env: process.env,
        stderr: (text) => { renderedStderr += text; },
        timeoutMs: 2_000,
      });

      expect(result.stdout).toBe('[process-tree-id]');
      expect(result.stderr).toBe('[process-tree-id]');
      expect(renderedStderr.trim()).toBe('[process-tree-id]');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'uses the deadline when an exited root leaves inherited pipes open',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-open-pipe-'));
      tempDirs.push(root);
      const marker = path.join(root, 'descendant-survived');
      const pidPath = path.join(root, 'descendant-pid');
      const descendantScript = [
        'process.on("SIGTERM", () => {});',
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 2500);`,
        'setInterval(() => {}, 1000);',
      ].join('\n');
      const rootScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });`,
        'child.unref();',
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
        'setTimeout(() => process.exit(0), 100);',
      ].join('\n');
      let descendantPid: number | undefined;
      try {
        await expect(runChild(process.execPath, ['-e', rootScript], {
          cwd: root,
          env: process.env,
          stderr: () => undefined,
          timeoutMs: 400,
        })).resolves.toMatchObject({ timedOut: true });
        descendantPid = Number(await fs.readFile(pidPath, 'utf8'));
        await new Promise((resolve) => setTimeout(resolve, 500));
        await expect(fs.pathExists(marker)).resolves.toBe(false);
      } finally {
        if (descendantPid) {
          try {
            process.kill(descendantPid, 'SIGKILL');
          } catch {
            // Best-effort test cleanup.
          }
        }
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'does not time out a child that closes before cleanup crosses the deadline',
    async () => {
      await assertProcessTreeInspectionAvailable();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        pid: 42_424,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        stdin: null,
        stdout,
        stderr,
        kill: vi.fn(() => true),
        unref: vi.fn(),
      }) as unknown as ChildProcessWithoutNullStreams;
      const spawnChild = vi.fn(() => {
        setTimeout(() => {
          Object.assign(child, { exitCode: 0 });
          stdout.end();
          stderr.end();
          child.emit('close', 0, null);
        }, 99);
        return child;
      });
      const terminate = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return [];
      });

      await expect(runChild('fake-command', [], {
        cwd: process.cwd(),
        env: process.env,
        stderr: () => undefined,
        timeoutMs: 100,
        spawnChild,
        createProcessTreeMonitor: () => ({ terminate }),
      })).resolves.toMatchObject({
        exitCode: 0,
        signal: null,
        timedOut: false,
      });
      expect(terminate).toHaveBeenCalledOnce();
    },
  );

  it.runIf(process.platform !== 'win32')(
    'terminates an active command suite and prevents the next suite before re-emitting SIGTERM',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-signal-'));
      tempDirs.push(root);
      const baselineHandlers = new Set(process.listeners('SIGTERM'));
      const originalKill = process.kill.bind(process);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === process.pid) return true;
        return originalKill(pid, signal);
      });

      try {
        const childResult = runChild(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000);'],
          {
            cwd: root,
            env: process.env,
            stderr: () => undefined,
            timeoutMs: 10_000,
          },
        );
        await vi.waitFor(() => {
          expect(process.listeners('SIGTERM').some((handler) => !baselineHandlers.has(handler)))
            .toBe(true);
        });
        const signalHandler = process.listeners('SIGTERM')
          .find((handler) => !baselineHandlers.has(handler));
        expect(signalHandler).toBeDefined();
        signalHandler!();

        await expect(childResult).resolves.toMatchObject({
          signal: 'SIGKILL',
          timedOut: false,
        });
        await vi.waitFor(() => {
          expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
        });
        const secondSuiteMarker = path.join(root, 'second-suite-started');
        await expect(runChild(
          process.execPath,
          [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(secondSuiteMarker)}, 'started');`,
          ],
          {
            cwd: root,
            env: process.env,
            stderr: () => undefined,
            timeoutMs: 10_000,
          },
        )).rejects.toThrow('signal shutdown is in progress');
        await expect(fs.pathExists(secondSuiteMarker)).resolves.toBe(false);
      } finally {
        resetCodexEvalSignalShutdownForTests();
        killSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'stops polling and reports when SIGKILL termination cannot be confirmed',
    async () => {
      const fakePid = 2_147_483_000;
      const originalKill = process.kill.bind(process);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === fakePid || pid === -fakePid) return true;
        return originalKill(pid, signal);
      });
      const startedAt = Date.now();

      try {
        await expect(terminatePosixProcessTree(fakePid, {
          readProcessTable: async () => {
            throw new Error('ps unavailable');
          },
          kill: (pid, signal) => killSpy(pid, signal),
        })).resolves.toContainEqual(
          expect.stringContaining('Could not confirm process-tree cleanup'),
        );
        expect(Date.now() - startedAt).toBeLessThan(4_000);
      } finally {
        killSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'freezes the root before discovering a descendant created at termination',
    async () => {
      const rootPid = 41_000;
      const descendantPid = 41_001;
      const processes = new Map([
        [rootPid, { ppid: 1, state: 'S', startTime: 'root-start' }],
      ]);
      const readProcessTable = vi.fn(async () => new Map(processes));
      let descendantCreated = false;
      const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
        if (pid === -rootPid) {
          if (signal === 0) {
            throw Object.assign(new Error('process group is gone'), { code: 'ESRCH' });
          }
          return true;
        }
        if (pid === rootPid && signal === 'SIGSTOP' && !descendantCreated) {
          descendantCreated = true;
          processes.set(rootPid, { ppid: 1, state: 'T', startTime: 'root-start' });
          processes.set(descendantPid, {
            ppid: rootPid,
            state: 'S',
            startTime: 'descendant-start',
          });
        }
        if (pid === rootPid && signal === 'SIGTERM') {
          processes.delete(rootPid);
          const descendant = processes.get(descendantPid);
          if (descendant) processes.set(descendantPid, { ...descendant, ppid: 1 });
        }
        if (pid === descendantPid && signal === 'SIGSTOP') {
          const descendant = processes.get(descendantPid);
          if (descendant) processes.set(descendantPid, { ...descendant, state: 'T' });
        }
        if (signal === 'SIGKILL') processes.delete(pid);
        return true;
      });

      await terminatePosixProcessTree(rootPid, { readProcessTable, kill });

      expect(kill).toHaveBeenCalledWith(rootPid, 'SIGSTOP');
      expect(kill).toHaveBeenCalledWith(descendantPid, 'SIGKILL');
    },
  );

  it('uses the process group when the POSIX root is missing or already a zombie', async () => {
    const rootPid = 42_000;
    for (const rootEntry of [undefined, { ppid: 1, state: 'Z', startTime: 'root-start' }]) {
      let processGroupRunning = true;
      const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
        if (pid !== -rootPid) return true;
        if (signal === 'SIGKILL') processGroupRunning = false;
        if (signal === 0 && !processGroupRunning) {
          throw Object.assign(new Error('process group is gone'), { code: 'ESRCH' });
        }
        return true;
      });
      const table = new Map<number, { ppid: number; state: string; startTime: string }>();
      if (rootEntry) table.set(rootPid, rootEntry);

      await expect(terminatePosixProcessTree(rootPid, {
        readProcessTable: async () => table,
        kill,
      })).resolves.toEqual([]);

      expect(kill).toHaveBeenCalledWith(-rootPid, 'SIGKILL');
      expect(kill).not.toHaveBeenCalledWith(rootPid, 'SIGSTOP');
    }
  });

  it('does not terminate a reused POSIX descendant PID', async () => {
    const rootPid = 43_000;
    const descendantPid = 43_001;
    const processes = new Map([
      [rootPid, { ppid: 1, state: 'S', startTime: 'root-start' }],
      [descendantPid, { ppid: rootPid, state: 'S', startTime: 'old-start' }],
    ]);
    const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (pid === rootPid && signal === 'SIGSTOP') {
        processes.set(rootPid, { ppid: 1, state: 'T', startTime: 'root-start' });
      }
      if (pid === descendantPid && signal === 'SIGSTOP') {
        processes.set(descendantPid, {
          ppid: rootPid,
          state: 'S',
          startTime: 'reused-start',
        });
      }
      if (pid === rootPid && signal === 'SIGKILL') {
        processes.delete(rootPid);
        processes.set(descendantPid, {
          ppid: 1,
          state: 'S',
          startTime: 'reused-start',
        });
      }
      return true;
    });

    await terminatePosixProcessTree(rootPid, {
      readProcessTable: async () => new Map(processes),
      kill,
    });

    expect(kill).toHaveBeenCalledWith(descendantPid, 'SIGSTOP');
    expect(kill).not.toHaveBeenCalledWith(descendantPid, 'SIGKILL');
    expect(kill).toHaveBeenCalledWith(rootPid, 'SIGKILL');
  });

  function createUnclosedWindowsChild(exitCode: number | null = null): {
    child: ChildProcess;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
    stdout: PassThrough;
    stderr: PassThrough;
  } {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const kill = vi.fn(() => true);
    const unref = vi.fn();
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode,
      signalCode: null,
      stdout,
      stderr,
      kill,
      unref,
    }) as unknown as ChildProcess;
    return { child, kill, unref, stdout, stderr };
  }

  it('bounds Windows close confirmation after taskkill succeeds', async () => {
    const fixture = createUnclosedWindowsChild(0);

    await expect(terminateWindowsProcessTree(fixture.child, {
      closeTimeoutMs: 10,
      runTaskkill: async () => undefined,
    })).resolves.toContainEqual(expect.stringContaining(
      'Could not confirm Windows process-tree termination within 10ms after taskkill',
    ));
    expect(fixture.stdout.destroyed).toBe(true);
    expect(fixture.stderr.destroyed).toBe(true);
    expect(fixture.unref).toHaveBeenCalledOnce();
  });

  it('bounds Windows close confirmation after the SIGKILL fallback', async () => {
    const fixture = createUnclosedWindowsChild();

    await expect(terminateWindowsProcessTree(fixture.child, {
      closeTimeoutMs: 10,
      runTaskkill: async () => { throw new Error('taskkill unavailable'); },
    })).resolves.toEqual(expect.arrayContaining([
      expect.stringContaining('taskkill failure: taskkill unavailable'),
      expect.stringContaining('and SIGKILL fallback'),
    ]));
    expect(fixture.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fixture.stdout.destroyed).toBe(true);
    expect(fixture.stderr.destroyed).toBe(true);
    expect(fixture.unref).toHaveBeenCalledOnce();
  });

  it('keeps Windows tree cleanup unconfirmed when taskkill fails but SIGKILL closes the root', async () => {
    const fixture = createUnclosedWindowsChild();
    fixture.kill.mockImplementation(() => {
      fixture.child.emit('close');
      return true;
    });

    const diagnostics = await terminateWindowsProcessTree(fixture.child, {
      closeTimeoutMs: 10,
      runTaskkill: async () => { throw new Error('taskkill unavailable'); },
    });

    expect(diagnostics).toEqual([
      expect.stringContaining('Could not verify Windows process-tree termination'),
    ]);
    expect(processTreeCleanupIsUnconfirmed(diagnostics)).toBe(true);
  });

  it('waits for close after taskkill fails even when the Windows child has exited', async () => {
    const fixture = createUnclosedWindowsChild(1);

    await expect(terminateWindowsProcessTree(fixture.child, {
      closeTimeoutMs: 10,
      runTaskkill: async () => { throw new Error('process already exited'); },
    })).resolves.toEqual(expect.arrayContaining([
      expect.stringContaining('taskkill failure: process already exited'),
      expect.stringContaining('after taskkill failure; process 4242 may still be running'),
    ]));
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(fixture.stdout.destroyed).toBe(true);
    expect(fixture.stderr.destroyed).toBe(true);
    expect(fixture.unref).toHaveBeenCalledOnce();
  });

  it('does not taskkill an exited Windows root PID', async () => {
    const fixture = createUnclosedWindowsChild(0);
    const runTaskkill = vi.fn(async () => undefined);

    const diagnostics = await createWindowsChildProcessTreeMonitor(fixture.child, {
      closeTimeoutMs: 10,
      runTaskkill,
    }).terminate();

    expect(runTaskkill).not.toHaveBeenCalled();
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(processTreeCleanupIsUnconfirmed(diagnostics)).toBe(false);
    expect(diagnostics).toContainEqual(expect.stringContaining(
      'potentially reused PID',
    ));
  });

  it('taskkills a Windows root that is still running', async () => {
    const fixture = createUnclosedWindowsChild();
    const runTaskkill = vi.fn(async () => {
      fixture.child.emit('close');
    });

    await expect(createWindowsChildProcessTreeMonitor(fixture.child, {
      closeTimeoutMs: 10,
      runTaskkill,
    }).terminate()).resolves.toEqual([]);

    expect(runTaskkill).toHaveBeenCalledOnce();
    expect(runTaskkill).toHaveBeenCalledWith(4242);
  });

  it('marks every debug coverage selector as incomplete evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-coverage-'));
    tempDirs.push(root);
    await writeCommandPlugin(root, {
      name: 'coverage-demo',
      script: 'process.stdout.write(JSON.stringify({ complete: true, passed: true }));\n',
      defaultRuns: 2,
      perRunTimeoutMs: 1_000,
      suiteTimeoutMs: 2_000,
      supports: ['split', 'case', 'runs', 'codexBin'],
    });
    registerCurrentTestReadonlyFixtureRoot(root);

    const cases = [
      { name: 'suite', args: ['--suite', 'command'], diagnostic: '--suite' },
      { name: 'profile', args: ['--profile', 'project-default'], diagnostic: '--profile' },
      { name: 'split', args: ['--split', 'validation'], diagnostic: '--split' },
      {
        name: 'case',
        args: ['--suite', 'command', '--case', 'selected-case'],
        diagnostic: '--case',
      },
      { name: 'runs', args: ['--runs', '1'], diagnostic: '--runs' },
    ];

    for (const testCase of cases) {
      const outputRoot = path.join(root, `output-${testCase.name}`);
      registerCurrentTestWritableStateRoot(outputRoot);
      let stdout = '';
      let stderr = '';
      const exitCode = await runPluginEvals([
        'coverage-demo',
        '--no-inherit-codex-config',
        ...testCase.args,
        '--codex-bin',
        process.execPath,
        '--output-dir',
        outputRoot,
      ], {
        repoRoot: root,
        env: process.env,
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
      });

      expect(exitCode, stderr).toBe(1);
      const bundle = JSON.parse(stdout).bundles[0];
      expect(bundle).toMatchObject({
        outcome: 'incomplete',
        complete: false,
        mechanicalPassed: true,
        diagnostics: expect.arrayContaining([
          expect.stringContaining(testCase.diagnostic),
        ]),
      });
      expect(bundle.suites).toEqual([
        expect.objectContaining({ outcome: 'passed', complete: true }),
      ]);
    }
  });

  it('allows multiple legal runs to exceed the per-run timeout in aggregate', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-multi-run-'));
    const outputRoot = path.join(root, 'output');
    tempDirs.push(root);
    await writeCommandPlugin(root, {
      name: 'multi-run-demo',
      script: [
        'const valueAfter = (flag) => process.argv[process.argv.indexOf(flag) + 1];',
        'const runs = Number(valueAfter("--runs"));',
        'const timeoutMs = Number(valueAfter("--timeout-ms"));',
        'for (let index = 0; index < runs; index += 1) {',
        '  await new Promise((resolve) => setTimeout(resolve, 75));',
        '}',
        'process.stdout.write(JSON.stringify({ complete: true, passed: true, summary: { runs, timeoutMs } }));',
      ].join('\n'),
      defaultRuns: 3,
      perRunTimeoutMs: 100,
      suiteTimeoutMs: 2_000,
      supports: ['runs', 'codexBin', 'timeout'],
    });
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    let stdout = '';
    let stderr = '';

    const exitCode = await runPluginEvals([
      'multi-run-demo',
      '--no-inherit-codex-config',
      '--codex-bin',
      process.execPath,
      '--output-dir',
      outputRoot,
    ], {
      repoRoot: root,
      env: process.env,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    });

    expect(exitCode, stderr).toBe(0);
    const commandReport = JSON.parse(stdout);
    expect(commandReport.bundles[0].suites).toEqual([
      expect.objectContaining({
        outcome: 'passed',
        complete: true,
        summary: expect.objectContaining({ runs: 3, timeoutMs: 100 }),
      }),
    ]);
  });
});
