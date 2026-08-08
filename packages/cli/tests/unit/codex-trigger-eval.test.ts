import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  inspectTriggerExecEvent,
  readTriggerSpawnCalls,
  runCodexTriggerSuite,
  summarizeTriggerCase,
  type TriggerRunEvidence,
} from '../../scripts/codex-trigger-eval.js';
import { resolveCodexEvalRuntimeConfig } from '../../scripts/codex-eval-runtime-config.js';
import type {
  PluginEvalTriggerCase,
  PluginEvalTriggerSuite,
} from '../../scripts/plugin-eval-contract.js';

const tempDirs: string[] = [];

function suite(overrides: Partial<PluginEvalTriggerSuite> = {}): PluginEvalTriggerSuite {
  return {
    id: 'trigger',
    kind: 'trigger',
    skill: 'eval-fixture',
    cases: './evals/trigger-cases.json',
    observeSpawnAgent: true,
    isolation: 'standard',
    strictNegativeSplits: [],
    profiles: ['project-default'],
    defaultRuns: 1,
    releaseSplits: ['validation'],
    requiredForRelease: true,
    perRunTimeoutMs: 10_000,
    ...overrides,
  };
}

function runEvidence(overrides: Partial<TriggerRunEvidence>): TriggerRunEvidence {
  return {
    loaded: false,
    spawned: false,
    load_evidence: null,
    spawn_evidence: null,
    spawn_calls: [],
    termination: 'completed',
    exit_code: 0,
    signal: null,
    execution_error: false,
    fixture_unchanged: true,
    final_message: null,
    duration_ms: 1,
    usage: null,
    event_trace: [],
    diagnostics: [],
    ...overrides,
  };
}

async function createFixture(options: {
  protectedEnv?: boolean;
  detachedDescendant?: boolean;
} = {}): Promise<{
  pluginRoot: string;
  subjectRoot: string;
  codexBin: string;
  descendantPidPath: string;
  descendantSurvivalPath: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-trigger-driver-test-'));
  tempDirs.push(root);
  const pluginRoot = path.join(root, 'plugin');
  const subjectRoot = path.join(root, 'subject');
  const descendantPidPath = path.join(root, 'descendant-pid.txt');
  const descendantSurvivalPath = path.join(root, 'descendant-survived.txt');
  await fs.ensureDir(path.join(pluginRoot, 'evals'));
  await fs.ensureDir(path.join(subjectRoot, '.agents', 'skills', 'eval-fixture'));
  await fs.ensureDir(path.join(subjectRoot, '.git'));
  await fs.writeFile(
    path.join(subjectRoot, '.agents', 'skills', 'eval-fixture', 'SKILL.md'),
    '# Eval Fixture\n',
    'utf8',
  );
  await fs.writeJson(path.join(pluginRoot, 'evals', 'trigger-cases.json'), {
    schemaVersion: 1,
    skill: 'eval-fixture',
    cases: [{
      id: 'load_and_spawn',
      split: 'validation',
      query: 'Load the fixture and spawn one agent.',
      should_load_skill: true,
      should_spawn_agent: true,
    }],
  }, { spaces: 2 });
  await fs.writeFile(
    path.join(pluginRoot, 'evals', 'fixture.mjs'),
    options.protectedEnv
      ? 'export function setupTriggerWorkspace() { return { environment: { HOME: "/tmp/escape" } }; }\n'
      : [
        "import { writeFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        'export async function setupTriggerWorkspace({ workspaceRoot }) {',
        "  await writeFile(path.join(workspaceRoot, 'fixture.txt'), 'ready\\n', 'utf8');",
        '}',
      ].join('\n'),
    'utf8',
  );
  const codexBin = path.join(root, 'fake-codex');
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "if (process.argv[2] === '--version') { process.stdout.write('codex-fake 1.0\\n'); process.exit(0); }",
    ...(options.detachedDescendant ? [
      "const { spawn } = require('node:child_process');",
      `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(
        `process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(descendantSurvivalPath)}, "alive"), 2500); setInterval(() => {}, 1000);`,
      )}], { detached: true, stdio: 'ignore' });`,
      'descendant.unref();',
      `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
    ] : []),
    "const cwdIndex = process.argv.indexOf('--cd');",
    'const cwd = process.argv[cwdIndex + 1];',
    "const sessionDir = path.join(process.env.CODEX_HOME, 'sessions');",
    'fs.mkdirSync(sessionDir, { recursive: true });',
    'fs.writeFileSync(path.join(sessionDir, "rollout.jsonl"), JSON.stringify({',
    "  type: 'response_item',",
    "  payload: { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ agent_type: 'worker', message: 'inspect' }), call_id: 'spawn-1' },",
    "}) + '\\n');",
    'const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
    'send({ type: "item.completed", item: { type: "command_execution", status: "completed", exit_code: 0, command: "cat .agents/skills/eval-fixture/SKILL.md" } });',
    'send({ type: "item.completed", item: { type: "collab_tool_call", tool: "spawn_agent", prompt: "inspect" } });',
    'send({ type: "turn.completed", usage: { total_tokens: 7 } });',
    'process.on("SIGTERM", () => process.exit(0));',
    'setTimeout(() => process.exit(0), 100);',
    'void cwd;',
  ].join('\n'), 'utf8');
  await fs.chmod(codexBin, 0o755);
  return {
    pluginRoot,
    subjectRoot,
    codexBin,
    descendantPidPath,
    descendantSurvivalPath,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('Codex native trigger eval driver', () => {
  it('only accepts completed successful skill-read evidence', () => {
    const skillPath = '/tmp/project/.agents/skills/eval-fixture/SKILL.md';
    expect(inspectTriggerExecEvent({
      type: 'item.started',
      item: { type: 'command_execution', command: 'cat .agents/skills/eval-fixture/SKILL.md' },
    }, skillPath)).toEqual({});
    expect(inspectTriggerExecEvent({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        status: 'completed',
        exit_code: 0,
        command: 'cat .agents/skills/eval-fixture/SKILL.md',
      },
    }, skillPath)).toEqual({
      loaded: true,
      loadEvidence: 'cat .agents/skills/eval-fixture/SKILL.md',
    });
    expect(inspectTriggerExecEvent({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        status: 'completed',
        exit_code: 0,
        command: 'echo .agents/skills/eval-fixture/SKILL.md',
      },
    }, skillPath)).toEqual({});
  });

  it('preserves per-suite strict negative scoring', () => {
    const evalCase: PluginEvalTriggerCase = {
      id: 'negative',
      split: 'validation',
      query: 'Do not load it.',
      should_load_skill: false,
      should_spawn_agent: false,
    };
    const runs = [
      runEvidence({ loaded: true }),
      runEvidence({}),
      runEvidence({}),
    ];
    expect(summarizeTriggerCase(suite(), evalCase, runs).passed).toBe(true);
    expect(summarizeTriggerCase(
      suite({ strictNegativeSplits: ['validation'] }),
      evalCase,
      runs,
    ).passed).toBe(false);
  });

  it('deduplicates raw spawn_agent rollout calls', async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-trigger-rollout-'));
    tempDirs.push(codexHome);
    const sessionRoot = path.join(codexHome, 'sessions');
    await fs.ensureDir(sessionRoot);
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        arguments: JSON.stringify({ agent_type: 'worker' }),
        call_id: 'call-1',
      },
    });
    await fs.writeFile(path.join(sessionRoot, 'rollout.jsonl'), `${line}\n${line}\n`, 'utf8');
    await expect(readTriggerSpawnCalls(codexHome)).resolves.toHaveLength(1);
  });

  it.runIf(process.platform !== 'win32')(
    'runs a materialized Skill and fixture through the central trigger suite',
    async () => {
      const fixture = await createFixture();
      const reportPath = path.join(fixture.pluginRoot, 'report.json');
      const report = await runCodexTriggerSuite({
        suite: suite({ fixtureModule: './evals/fixture.mjs' }),
        split: 'validation',
        subjectRoot: fixture.subjectRoot,
        pluginRoot: fixture.pluginRoot,
        profile: 'project-default',
        runs: 1,
        codexBin: fixture.codexBin,
        sourceEnv: process.env,
        reportPath,
      });
      expect(report).toMatchObject({
        kind: 'trigger',
        outcome: 'passed',
        complete: true,
        mechanicalPassed: true,
      });
      const evidence = await fs.readJson(reportPath);
      expect(evidence.environment.codex_version).toBe('codex-fake 1.0');
      expect(evidence.environment.isolation).toMatchObject({
        mode: 'standard',
        isolated_home: true,
        system_cloud_and_managed_layers_disabled: false,
      });
      expect(evidence.results[0].runs[0].spawn_calls).toHaveLength(1);
      expect(evidence.results[0].runs[0].fixture_unchanged).toBe(true);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'waits for early-stop process-tree cleanup before completing the trigger run',
    async () => {
      const fixture = await createFixture({ detachedDescendant: true });
      let descendantPid: number | undefined;
      const processExists = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
      };
      try {
        await expect(runCodexTriggerSuite({
          suite: suite(),
          split: 'validation',
          subjectRoot: fixture.subjectRoot,
          pluginRoot: fixture.pluginRoot,
          profile: 'project-default',
          runs: 1,
          codexBin: fixture.codexBin,
          sourceEnv: process.env,
        })).resolves.toMatchObject({
          outcome: 'passed',
          complete: true,
          mechanicalPassed: true,
        });
        descendantPid = Number(await fs.readFile(fixture.descendantPidPath, 'utf8'));
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await expect(fs.pathExists(fixture.descendantSurvivalPath)).resolves.toBe(false);
      } finally {
        if (descendantPid && processExists(descendantPid)) {
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
    'rejects fixture attempts to replace isolation-owned environment variables',
    async () => {
      const fixture = await createFixture({ protectedEnv: true });
      const report = await runCodexTriggerSuite({
        suite: suite({ fixtureModule: './evals/fixture.mjs' }),
        split: 'validation',
        subjectRoot: fixture.subjectRoot,
        pluginRoot: fixture.pluginRoot,
        profile: 'project-default',
        runs: 1,
        codexBin: fixture.codexBin,
      });
      expect(report).toMatchObject({ outcome: 'incomplete', complete: false });
      expect(report.diagnostics.join('\n')).toContain(
        'cannot override protected environment variable HOME',
      );
    },
  );

  it('redacts provider values when fixture loading fails', async () => {
    const fixture = await createFixture();
    const codexHome = path.join(fixture.pluginRoot, 'codex-home');
    const reportPath = path.join(fixture.pluginRoot, 'fixture-error-report.json');
    await fs.ensureDir(codexHome);
    await fs.writeFile(path.join(codexHome, 'config.toml'), [
      'model_provider = "custom"',
      '[model_providers.custom]',
      'name = "Custom"',
      'base_url = "https://private.invalid/v1"',
      'experimental_bearer_token = "fixture-secret"',
    ].join('\n'), 'utf8');
    await fs.writeFile(
      path.join(fixture.pluginRoot, 'evals', 'fixture.mjs'),
      'throw new Error("fixture-secret https://private.invalid/v1");\n',
      'utf8',
    );
    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: codexHome },
      inheritUserConfig: true,
    });

    const report = await runCodexTriggerSuite({
      suite: suite({ fixtureModule: './evals/fixture.mjs' }),
      split: 'validation',
      subjectRoot: fixture.subjectRoot,
      pluginRoot: fixture.pluginRoot,
      profile: 'project-default',
      runs: 1,
      codexBin: fixture.codexBin,
      codexRuntime: runtime,
      reportPath,
    });

    expect(report.outcome).toBe('incomplete');
    expect(JSON.stringify(report)).not.toContain('fixture-secret');
    const persisted = await fs.readFile(reportPath, 'utf8');
    expect(persisted).not.toContain('fixture-secret');
    expect(persisted).not.toContain('https://private.invalid/v1');
  });
});
