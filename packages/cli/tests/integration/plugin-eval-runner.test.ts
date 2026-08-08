import type { ChildProcess } from 'node:child_process';
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
    skillTriggers: {
      [options.name]: { defaultTrigger: 'manual', allowDynamicTrigger: false },
    },
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'NONE', products: ['CODEX'] },
    },
  }, { spaces: 2 });
  await fs.writeFile(
    path.join(pluginRoot, 'skills', options.name, 'SKILL.md'),
    [
      '---',
      `name: ${options.name}`,
      'description: Use only to test the central command suite contract.',
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
      triggerPreference: 'default',
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
      'behavior',
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
    expect(stderr).toContain('Conversation suite "behavior" does not support --split.');
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
      const codexBin = await writeProviderCheckingFakeCodex(root, 'ask-me');
      let stdout = '';
      let stderr = '';

      const exitCode = await runPluginEvals([
        'ask-me',
        '--suite',
        'trigger',
        '--case',
        'explicit_hidden_assumptions',
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
        await fs.readFile(path.join(outputRoot, 'ask-me', 'reports', 'trigger-all-project-default.json'), 'utf8'),
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
        "import { readFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        "if (process.env.UNRELATED_SECRET || process.env.OPENAI_API_KEY) process.exit(9);",
        "const config = await readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');",
        "const endpoint = config.match(/base_url = \\\"([^\\\"]+)/)?.[1];",
        "process.stderr.write(`${process.env.CUSTOM_TOKEN} ${endpoint}\\n`);",
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
    expect(persistedReport).toContain('[redacted]');
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
          signal: 'SIGTERM',
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
        await expect(terminatePosixProcessTree(fakePid)).resolves.toContainEqual(
          expect.stringContaining('Could not confirm process-tree termination'),
        );
        expect(Date.now() - startedAt).toBeLessThan(4_000);
      } finally {
        killSpy.mockRestore();
      }
    },
  );

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
