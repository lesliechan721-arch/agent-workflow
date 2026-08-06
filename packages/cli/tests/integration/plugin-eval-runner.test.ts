import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { runPluginEvals } from '../../scripts/eval-plugin-skills.js';
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

      expect(exitCode, stderr).toBe(0);
      expect(stderr).toContain('codex-explore/trigger/all');
      expect(stderr).not.toContain('codex-explore/trigger/validation');
      const commandReport = JSON.parse(stdout);
      expect(commandReport.bundles[0].suites).toEqual([
        expect.objectContaining({ split: 'all', outcome: 'passed' }),
      ]);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'reports an incomplete suite after force-killing a timed-out command',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-timeout-'));
      const outputRoot = path.join(root, 'output');
      tempDirs.push(root);
      await writeCommandPlugin(root, {
        name: 'timeout-demo',
        script: 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n',
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
    },
  );

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
