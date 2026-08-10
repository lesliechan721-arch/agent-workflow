import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  inspectTriggerAppServerConfigWarning,
  inspectTriggerAppServerFrame,
  runCodexTriggerSuite,
  summarizeTriggerCase,
  type TriggerRunEvidence,
} from '../../scripts/codex-trigger-eval.js';
import { resolveCodexEvalRuntimeConfig } from '../../scripts/codex-eval-runtime-config.js';
import {
  createPosixProcessTreeMonitor,
  processTreeCleanupIsUnconfirmed,
  terminatePosixProcessTree,
} from '../../scripts/codex-eval-process-tree.js';
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
  rootExitDelayMs?: number;
  useProjectRules?: boolean;
} = {}): Promise<{
  pluginRoot: string;
  subjectRoot: string;
  codexBin: string;
  descendantPidPath: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-trigger-driver-test-'));
  tempDirs.push(root);
  const pluginRoot = path.join(root, 'plugin');
  const subjectRoot = path.join(root, 'subject');
  const descendantPidPath = path.join(root, 'descendant-pid.txt');
  await fs.ensureDir(path.join(pluginRoot, 'evals'));
  await fs.ensureDir(path.join(subjectRoot, '.agents', 'skills', 'eval-fixture'));
  await fs.ensureDir(path.join(subjectRoot, '.codex', 'rules'));
  await fs.ensureDir(path.join(subjectRoot, '.git'));
  await fs.writeFile(
    path.join(subjectRoot, '.agents', 'skills', 'eval-fixture', 'SKILL.md'),
    '# Eval Fixture\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(subjectRoot, '.codex', 'rules', 'eval.rules'),
    'prefix_rule(pattern = ["node"], decision = "allow")\n',
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
      ...(options.useProjectRules ? { use_project_rules: true } : {}),
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
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
      )}], { detached: true, stdio: 'ignore' });`,
      'descendant.unref();',
      `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
    ] : []),
    "if (process.argv[2] !== 'app-server') process.exit(3);",
    `if (fs.existsSync(path.join(process.cwd(), '.codex', 'rules', 'eval.rules')) !== ${
      options.useProjectRules === true
    }) process.exit(3);`,
    "if (!process.argv.includes('features.multi_agent=true')) process.exit(3);",
    "if (!process.argv.includes('features.multi_agent_v2.hide_spawn_agent_metadata=true')) process.exit(3);",
    "if (!process.argv.includes('features.multi_agent_v2.expose_spawn_agent_model_overrides=true')) process.exit(3);",
    'const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
    "const readline = require('node:readline');",
    'const input = readline.createInterface({ input: process.stdin });',
    "input.on('line', (line) => {",
    '  const frame = JSON.parse(line);',
    "  if (frame.method === 'initialize') send({ id: frame.id, result: {} });",
    "  else if (frame.method === 'thread/start') send({ id: frame.id, result: { thread: { id: 'thread-1' } } });",
    "  else if (frame.method === 'turn/start') {",
    "    send({ id: frame.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });",
    "    send({ method: 'item/completed', params: { threadId: 'thread-1', item: { id: 'read-1', type: 'commandExecution', status: 'completed', exitCode: 0, command: 'cat .agents/skills/eval-fixture/SKILL.md' } } });",
    "    const activity = { id: 'spawn-1', type: 'subAgentActivity', kind: 'started', agentThreadId: 'agent-1', agentPath: '/root/evidence' };",
    "    send({ method: 'item/started', params: { threadId: 'thread-1', item: activity } });",
    "    send({ method: 'item/completed', params: { threadId: 'thread-1', item: activity } });",
    "    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', tokenUsage: { totalTokens: 7 } } });",
    "    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });",
    '  }',
    '});',
    'process.on("SIGTERM", () => process.exit(0));',
    `setTimeout(() => process.exit(0), ${options.rootExitDelayMs ?? 100});`,
  ].join('\n'), 'utf8');
  await fs.chmod(codexBin, 0o755);
  return {
    pluginRoot,
    subjectRoot,
    codexBin,
    descendantPidPath,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('Codex native trigger eval driver', () => {
  it('only accepts completed successful skill-read evidence', () => {
    const skillPath = '/tmp/project/.agents/skills/eval-fixture/SKILL.md';
    expect(inspectTriggerAppServerFrame({
      method: 'item/started',
      params: {
        item: {
          type: 'commandExecution',
          command: 'cat .agents/skills/eval-fixture/SKILL.md',
        },
      },
    }, skillPath)).toEqual({});
    expect(inspectTriggerAppServerFrame({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          status: 'completed',
          exitCode: 0,
          command: 'cat .agents/skills/eval-fixture/SKILL.md',
        },
      },
    }, skillPath)).toEqual({
      loaded: true,
      loadEvidence: 'cat .agents/skills/eval-fixture/SKILL.md',
    });
    expect(inspectTriggerAppServerFrame({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          status: 'completed',
          exitCode: 0,
          command: 'echo .agents/skills/eval-fixture/SKILL.md',
        },
      },
    }, skillPath)).toEqual({});
  });

  it('detects config warnings emitted by strict Codex app-server', () => {
    expect(inspectTriggerAppServerConfigWarning({
      method: 'configWarning',
      params: {
        summary: 'Project-local config is disabled until the project is trusted.',
      },
    })).toContain('project is trusted');
    expect(inspectTriggerAppServerConfigWarning({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', text: 'done' } },
    })).toBeNull();
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

  it('observes V2 spawn from app-server sub-agent activity', () => {
    expect(inspectTriggerAppServerFrame({
      method: 'item/started',
      params: {
        item: {
          id: 'spawn-1',
          type: 'subAgentActivity',
          kind: 'started',
          agentThreadId: 'agent-1',
          agentPath: '/root/evidence',
        },
      },
    }, '/tmp/project/.agents/skills/eval-fixture/SKILL.md')).toMatchObject({
      spawned: true,
      spawnEvidence: 'app-server:/root/evidence',
      spawnCall: {
        source: 'app_server_sub_agent_activity',
        agent_thread_id: 'agent-1',
        agent_path: '/root/evidence',
      },
    });
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
      expect(report, JSON.stringify(report, null, 2)).toMatchObject({
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
        credential_stores: {
          cli_auth: 'file',
          mcp_oauth: 'file',
          secret_auth_storage: false,
        },
        strict_surfaces_disabled: false,
        host_configuration: null,
        runtime_probe: null,
      });
      expect(evidence.results[0].runs[0].spawn_calls).toHaveLength(1);
      expect(evidence.results[0].runs[0].fixture_unchanged).toBe(true);
    },
  );

  it('continues a root after the initial monitor snapshot settles during cleanup', async () => {
    const rootPid = 51_000;
    let resolveInitial: ((table: Map<number, {
      ppid: number;
      state: string;
      startTime: string;
    }>) => void) | undefined;
    const initialSnapshot = new Promise<Map<number, {
      ppid: number;
      state: string;
      startTime: string;
    }>>((resolve) => {
      resolveInitial = resolve;
    });
    let lookup = 0;
    const readProcessTable = vi.fn(() => {
      lookup += 1;
      return lookup === 1 ? initialSnapshot : Promise.resolve(new Map());
    });
    const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (pid === -rootPid && signal === 0) {
        throw Object.assign(new Error('process group is gone'), { code: 'ESRCH' });
      }
      return true;
    });

    const monitor = createPosixProcessTreeMonitor(rootPid, { readProcessTable, kill });
    const termination = monitor.terminate();
    expect(kill).toHaveBeenCalledWith(rootPid, 'SIGSTOP');
    expect(kill).not.toHaveBeenCalledWith(rootPid, 'SIGCONT');

    resolveInitial!(new Map());
    await termination;

    const continueIndex = kill.mock.calls.findIndex((call) =>
      call[0] === rootPid && call[1] === 'SIGCONT'
    );
    const groupKillIndex = kill.mock.calls.findIndex((call) =>
      call[0] === -rootPid && call[1] === 'SIGKILL'
    );
    expect(continueIndex).toBeGreaterThanOrEqual(0);
    expect(groupKillIndex).toBeGreaterThan(continueIndex);
  });

  it('continues a root and reports an initial monitor snapshot failure', async () => {
    const rootPid = 52_000;
    let lookup = 0;
    const readProcessTable = vi.fn(() => {
      lookup += 1;
      if (lookup === 1) throw new Error('initial ps failed');
      return Promise.resolve(new Map());
    });
    const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (pid === -rootPid && signal === 0) {
        throw Object.assign(new Error('process group is gone'), { code: 'ESRCH' });
      }
      return true;
    });

    const diagnostics = await createPosixProcessTreeMonitor(rootPid, {
      readProcessTable,
      kill,
    }).terminate();

    expect(kill).toHaveBeenCalledWith(rootPid, 'SIGSTOP');
    expect(kill).toHaveBeenCalledWith(rootPid, 'SIGCONT');
    expect(diagnostics).toContainEqual(expect.stringContaining('initial ps failed'));
  });

  it('does not bind or signal a reused root PID after the initial stop misses', async () => {
    const rootPid = 52_100;
    const reusedTable = new Map([
      [rootPid, { ppid: 1, state: 'S', startTime: 'reused-start' }],
    ]);
    let initialStop = true;
    const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (initialStop && pid === rootPid && signal === 'SIGSTOP') {
        initialStop = false;
        throw Object.assign(new Error('original root exited'), { code: 'ESRCH' });
      }
      return true;
    });
    const diagnostics = await createPosixProcessTreeMonitor(rootPid, {
      treeId: 'tree-token',
      canUseProcessGroup: () => false,
      readProcessTable: async () => new Map(reusedTable),
      readTaggedProcessTable: async () => new Map(),
      kill,
    }).terminate();

    expect(processTreeCleanupIsUnconfirmed(diagnostics)).toBe(true);
    expect(kill.mock.calls).toEqual([[rootPid, 'SIGSTOP']]);
  });

  it('bounds a pending process-tree token scan and uses fallback cleanup', async () => {
    vi.useFakeTimers();
    try {
      const rootPid = 53_000;
      const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
        if (pid === -rootPid && signal === 0) {
          throw Object.assign(new Error('process group is gone'), { code: 'ESRCH' });
        }
        return true;
      });
      const monitor = createPosixProcessTreeMonitor(rootPid, {
        treeId: 'tree-token',
        readProcessTable: async () => new Map(),
        readTaggedProcessTable: async () => new Promise(() => {}),
        kill,
      });

      const termination = monitor.terminate();
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(termination).resolves.toContainEqual(expect.stringContaining(
        'process-tree token scan exceeded 1000ms',
      ));
      expect(kill).toHaveBeenCalledWith(-rootPid, 'SIGKILL');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a slow token scan to freeze a live root within the cleanup budget', async () => {
    vi.useFakeTimers();
    try {
      const rootPid = 53_100;
      const processes = new Map([
        [rootPid, { ppid: 1, state: 'S', startTime: 'root-start' }],
      ]);
      const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
        const entry = processes.get(pid);
        if (signal === 'SIGSTOP' && entry) {
          processes.set(pid, { ...entry, state: 'T' });
        }
        if (signal === 'SIGCONT' && entry) {
          processes.set(pid, { ...entry, state: 'S' });
        }
        if (signal === 'SIGKILL') processes.delete(pid);
        return true;
      });
      const readTaggedProcessTable = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return new Map(processes);
      });
      const monitor = createPosixProcessTreeMonitor(rootPid, {
        treeId: 'tree-token',
        canUseProcessGroup: () => false,
        readProcessTable: async () => new Map(processes),
        readTaggedProcessTable,
        kill,
      });

      const termination = monitor.terminate();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(600);
      const diagnostics = await termination;

      expect(readTaggedProcessTable).toHaveBeenCalledOnce();
      expect(processTreeCleanupIsUnconfirmed(diagnostics)).toBe(false);
      expect(kill).toHaveBeenCalledWith(rootPid, 'SIGSTOP');
      expect(kill).toHaveBeenCalledWith(rootPid, 'SIGKILL');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rescans the token after freezing a root that immediately reparents a child', async () => {
    vi.useFakeTimers();
    try {
      const rootPid = 53_200;
      const childPid = 53_201;
      const processes = new Map([
        [rootPid, { ppid: 1, state: 'S', startTime: 'root-start' }],
      ]);
      const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
        const entry = processes.get(pid);
        if (signal === 'SIGSTOP' && entry) {
          processes.set(pid, { ...entry, state: 'T' });
        }
        if (signal === 'SIGCONT' && entry) {
          processes.set(pid, { ...entry, state: 'S' });
          if (pid === rootPid) {
            processes.set(childPid, {
              ppid: 1,
              state: 'S',
              startTime: 'child-start',
            });
          }
        }
        if (signal === 'SIGKILL') processes.delete(pid);
        return true;
      });
      const readTaggedProcessTable = vi.fn(async () => new Map(processes));
      const monitor = createPosixProcessTreeMonitor(rootPid, {
        treeId: 'tree-token',
        canUseProcessGroup: () => false,
        readProcessTable: async () => new Map(processes),
        readTaggedProcessTable,
        kill,
      });

      const termination = monitor.terminate();
      await vi.advanceTimersByTimeAsync(250);
      const diagnostics = await termination;

      expect(readTaggedProcessTable.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(processTreeCleanupIsUnconfirmed(diagnostics)).toBe(false);
      expect(kill).toHaveBeenCalledWith(childPid, 'SIGSTOP');
      expect(kill).toHaveBeenCalledWith(childPid, 'SIGKILL');
      expect(processes.has(childPid)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('freezes the root before accepting an empty token snapshot', async () => {
    vi.useFakeTimers();
    try {
      const rootPid = 53_250;
      const childPid = 53_251;
      const processes = new Map([
        [rootPid, { ppid: 1, state: 'S', startTime: 'root-start' }],
      ]);
      const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
        const entry = processes.get(pid);
        if (signal === 'SIGSTOP' && entry) {
          processes.set(pid, { ...entry, state: 'T' });
        }
        if (signal === 'SIGCONT' && entry) {
          processes.set(pid, { ...entry, state: 'S' });
        }
        if (signal === 'SIGKILL') processes.delete(pid);
        return true;
      });
      const readTaggedProcessTable = vi.fn(async () => {
        if (processes.get(rootPid)?.state === 'S') {
          processes.set(childPid, {
            ppid: 1,
            state: 'S',
            startTime: 'child-start',
          });
        }
        return new Map();
      });
      const monitor = createPosixProcessTreeMonitor(rootPid, {
        treeId: 'tree-token',
        canUseProcessGroup: () => false,
        readProcessTable: async () => new Map(processes),
        readTaggedProcessTable,
        kill,
      });

      const termination = monitor.terminate();
      const diagnostics = await termination;

      expect(readTaggedProcessTable).toHaveBeenCalledOnce();
      expect(processTreeCleanupIsUnconfirmed(diagnostics)).toBe(false);
      expect(processes.has(childPid)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds slow token, lineage, and confirmation scans by one deadline', async () => {
    vi.useFakeTimers();
    try {
      const rootPid = 53_300;
      const rootTable = () => new Map([
        [rootPid, { ppid: 1, state: 'S', startTime: 'root-start' }],
      ]);
      let ordinaryReads = 0;
      const readProcessTable = vi.fn(async () => {
        ordinaryReads += 1;
        if (ordinaryReads === 1) return rootTable();
        if (ordinaryReads >= 4) return new Map();
        await new Promise((resolve) => setTimeout(resolve, 900));
        return rootTable();
      });
      const readTaggedProcessTable = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return rootTable();
      });
      const kill = vi.fn(() => true);
      const monitor = createPosixProcessTreeMonitor(rootPid, {
        treeId: 'tree-token',
        canUseProcessGroup: () => false,
        readProcessTable,
        readTaggedProcessTable,
        kill,
      });

      const startedAt = Date.now();
      const termination = monitor.terminate();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(900);
      await vi.advanceTimersByTimeAsync(900);
      await vi.advanceTimersByTimeAsync(900);
      await vi.advanceTimersByTimeAsync(300);
      const diagnostics = await termination;

      expect(Date.now() - startedAt).toBe(3_000);
      expect(processTreeCleanupIsUnconfirmed(diagnostics)).toBe(true);
      expect(diagnostics).toContainEqual(expect.stringContaining(
        'process-tree token scan exceeded 300ms',
      ));
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a pending pre-frozen kill confirmation and ignores its late result', async () => {
    vi.useFakeTimers();
    try {
      const rootPid = 53_400;
      const processes = new Map([
        [rootPid, { ppid: 1, state: 'S', startTime: 'root-start' }],
      ]);
      let ordinaryReads = 0;
      let resolveLateRead: ((table: Map<number, {
        ppid: number;
        state: string;
        startTime: string;
      }>) => void) | undefined;
      const lateRead = new Promise<Map<number, {
        ppid: number;
        state: string;
        startTime: string;
      }>>((resolve) => {
        resolveLateRead = resolve;
      });
      const readProcessTable = vi.fn(async () => {
        ordinaryReads += 1;
        return ordinaryReads <= 3 ? new Map(processes) : lateRead;
      });
      const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
        const entry = processes.get(pid);
        if (signal === 'SIGSTOP' && entry) {
          processes.set(pid, { ...entry, state: 'T' });
        }
        if (signal === 'SIGCONT' && entry) {
          processes.set(pid, { ...entry, state: 'S' });
        }
        return true;
      });
      const monitor = createPosixProcessTreeMonitor(rootPid, {
        treeId: 'tree-token',
        canUseProcessGroup: () => false,
        readProcessTable,
        readTaggedProcessTable: async () => new Map(processes),
        kill,
      });

      const startedAt = Date.now();
      const termination = monitor.terminate();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
      const diagnostics = await termination;

      expect(Date.now() - startedAt).toBe(2_000);
      expect(processTreeCleanupIsUnconfirmed(diagnostics)).toBe(true);
      expect(diagnostics).toContainEqual(expect.stringContaining(
        'kill-confirmation scan exceeded 2000ms',
      ));
      resolveLateRead!(new Map());
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a pending ordinary freeze snapshot', async () => {
    vi.useFakeTimers();
    try {
      const rootPid = 53_500;
      let ordinaryReads = 0;
      let resolveLateRead: ((table: Map<number, {
        ppid: number;
        state: string;
        startTime: string;
      }>) => void) | undefined;
      const lateRead = new Promise<Map<number, {
        ppid: number;
        state: string;
        startTime: string;
      }>>((resolve) => {
        resolveLateRead = resolve;
      });
      const readProcessTable = vi.fn(async () => {
        ordinaryReads += 1;
        if (ordinaryReads === 1) {
          return new Map([
            [rootPid, { ppid: 1, state: 'S', startTime: 'root-start' }],
          ]);
        }
        return lateRead;
      });
      const kill = vi.fn(() => true);

      const startedAt = Date.now();
      const termination = terminatePosixProcessTree(rootPid, {
        canUseProcessGroup: () => false,
        readProcessTable,
        kill,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const diagnostics = await termination;

      expect(Date.now() - startedAt).toBe(1_000);
      expect(processTreeCleanupIsUnconfirmed(diagnostics)).toBe(true);
      expect(diagnostics).toContainEqual(expect.stringContaining(
        'lineage scan exceeded 1000ms',
      ));
      resolveLateRead!(new Map());
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('includes a pending initial snapshot in the ordinary freeze deadline', async () => {
    vi.useFakeTimers();
    try {
      const rootPid = 53_600;
      let resolveLateRead: ((table: Map<number, {
        ppid: number;
        state: string;
        startTime: string;
      }>) => void) | undefined;
      const lateRead = new Promise<Map<number, {
        ppid: number;
        state: string;
        startTime: string;
      }>>((resolve) => {
        resolveLateRead = resolve;
      });

      const startedAt = Date.now();
      const termination = terminatePosixProcessTree(rootPid, {
        canUseProcessGroup: () => false,
        readProcessTable: async () => lateRead,
        kill: vi.fn(() => true),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const diagnostics = await termination;

      expect(Date.now() - startedAt).toBe(1_000);
      expect(processTreeCleanupIsUnconfirmed(diagnostics)).toBe(true);
      expect(diagnostics).toContainEqual(expect.stringContaining(
        'initial scan exceeded 1000ms',
      ));
      resolveLateRead!(new Map());
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not restart the deadline for group fallback after kill confirmation stalls', async () => {
    vi.useFakeTimers();
    try {
      const rootPid = 53_700;
      let ordinaryReads = 0;
      let resolveLateRead: ((table: Map<number, {
        ppid: number;
        state: string;
        startTime: string;
      }>) => void) | undefined;
      const lateRead = new Promise<Map<number, {
        ppid: number;
        state: string;
        startTime: string;
      }>>((resolve) => {
        resolveLateRead = resolve;
      });
      const readProcessTable = vi.fn(async () => {
        ordinaryReads += 1;
        if (ordinaryReads === 1) {
          return new Map([
            [rootPid, { ppid: 1, state: 'S', startTime: 'root-start' }],
          ]);
        }
        if (ordinaryReads === 2) {
          return new Map([
            [rootPid, { ppid: 1, state: 'T', startTime: 'root-start' }],
          ]);
        }
        return lateRead;
      });
      const kill = vi.fn(() => true);

      const startedAt = Date.now();
      const termination = terminatePosixProcessTree(rootPid, {
        canUseProcessGroup: () => true,
        readProcessTable,
        kill,
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      const diagnostics = await termination;

      expect(Date.now() - startedAt).toBe(1_000);
      expect(processTreeCleanupIsUnconfirmed(diagnostics)).toBe(true);
      expect(kill).toHaveBeenCalledWith(rootPid, 'SIGKILL');
      expect(kill.mock.calls.some(([pid]) => (pid as number) < 0)).toBe(false);
      resolveLateRead!(new Map());
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('repeats token scans until newly detached tagged descendants are frozen', async () => {
    const rootPid = 54_000;
    const taggedParentPid = 54_001;
    const taggedChildPid = 54_002;
    const processes = new Map([
      [rootPid, { ppid: 1, state: 'S', startTime: 'root-start' }],
      [taggedParentPid, { ppid: rootPid, state: 'S', startTime: 'parent-start' }],
    ]);
    const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      const entry = processes.get(pid);
      if (signal === 'SIGSTOP' && entry) {
        processes.set(pid, { ...entry, state: 'T' });
        if (pid === taggedParentPid && !processes.has(taggedChildPid)) {
          processes.set(taggedChildPid, {
            ppid: 1,
            state: 'S',
            startTime: 'child-start',
          });
        }
      }
      if (signal === 'SIGKILL') processes.delete(pid);
      return true;
    });
    const readTaggedProcessTable = vi.fn(async () => new Map(
      [...processes].filter(([pid]) => pid !== rootPid),
    ));
    const monitor = createPosixProcessTreeMonitor(rootPid, {
      treeId: 'tree-token',
      canUseProcessGroup: () => false,
      readProcessTable: async () => new Map(processes),
      readTaggedProcessTable,
      kill,
    });

    await monitor.terminate();

    expect(readTaggedProcessTable.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(kill).toHaveBeenCalledWith(taggedParentPid, 'SIGSTOP');
    expect(kill).toHaveBeenCalledWith(taggedChildPid, 'SIGSTOP');
    expect(kill).toHaveBeenCalledWith(taggedParentPid, 'SIGKILL');
    expect(kill).toHaveBeenCalledWith(taggedChildPid, 'SIGKILL');
  });

  it('does not stop a tagged PID that was reused before fresh validation', async () => {
    const rootPid = 55_000;
    const reusedPid = 55_001;
    const reusedTable = new Map([
      [reusedPid, { ppid: 1, state: 'S', startTime: 'reused-start' }],
    ]);
    let initialLookup = true;
    const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (pid === -rootPid && signal === 0) {
        throw Object.assign(new Error('process group is gone'), { code: 'ESRCH' });
      }
      return true;
    });
    const monitor = createPosixProcessTreeMonitor(rootPid, {
      treeId: 'tree-token',
      canUseProcessGroup: () => false,
      readProcessTable: async () => {
        if (initialLookup) {
          initialLookup = false;
          return new Map();
        }
        return new Map(reusedTable);
      },
      readTaggedProcessTable: async () => new Map([
        [reusedPid, { ppid: rootPid, state: 'S', startTime: 'old-start' }],
      ]),
      kill,
    });

    const diagnostics = await monitor.terminate();

    expect(kill).not.toHaveBeenCalledWith(reusedPid, 'SIGSTOP');
    expect(kill).not.toHaveBeenCalledWith(reusedPid, 'SIGKILL');
    expect(kill.mock.calls.every(([pid]) => (pid as number) >= 0)).toBe(true);
    expect(diagnostics).toContainEqual(expect.stringContaining(
      'root identity and process-group ownership',
    ));
  });

  it('kills a tagged reparented descendant when the root identity was not observed', async () => {
    const rootPid = 56_000;
    const descendantPid = 56_001;
    const processes = new Map([
      [descendantPid, { ppid: 1, state: 'S', startTime: 'descendant-start' }],
    ]);
    let initialLookup = true;
    const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      const entry = processes.get(pid);
      if (signal === 'SIGSTOP' && entry) {
        processes.set(pid, { ...entry, state: 'T' });
      }
      if (signal === 'SIGKILL') processes.delete(pid);
      return true;
    });
    const monitor = createPosixProcessTreeMonitor(rootPid, {
      treeId: 'tree-token',
      canUseProcessGroup: () => false,
      readProcessTable: async () => {
        if (initialLookup) {
          initialLookup = false;
          throw new Error('initial ps failed');
        }
        return new Map(processes);
      },
      readTaggedProcessTable: async () => new Map(processes),
      kill,
    });

    const diagnostics = await monitor.terminate();

    expect(kill).toHaveBeenCalledWith(descendantPid, 'SIGSTOP');
    expect(kill).toHaveBeenCalledWith(descendantPid, 'SIGKILL');
    expect(kill.mock.calls.every(([pid]) => (pid as number) >= 0)).toBe(true);
    expect(diagnostics.some((entry) => entry.startsWith(
      'Could not confirm process-tree cleanup',
    ))).toBe(false);
  });

  it('reports unconfirmed cleanup without a blind group signal when token scans fail', async () => {
    const rootPid = 57_000;
    const kill = vi.fn(() => true);
    const diagnostics = await createPosixProcessTreeMonitor(rootPid, {
      treeId: 'secret-tree-token',
      canUseProcessGroup: () => false,
      readProcessTable: async () => new Map(),
      readTaggedProcessTable: async () => {
        throw new Error('tag scan unavailable');
      },
      kill,
    }).terminate();

    expect(processTreeCleanupIsUnconfirmed(diagnostics)).toBe(true);
    expect(kill.mock.calls.every(([pid]) => (pid as number) >= 0)).toBe(true);
    expect(diagnostics.join('\n')).not.toContain('secret-tree-token');
  });

  it.runIf(process.platform !== 'win32')(
    'cleans an observed detached descendant after an early trigger stop',
    async () => {
      const fixture = await createFixture({
        detachedDescendant: true,
        rootExitDelayMs: 100,
      });
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
        const report = await runCodexTriggerSuite({
          suite: suite(),
          split: 'validation',
          subjectRoot: fixture.subjectRoot,
          pluginRoot: fixture.pluginRoot,
          profile: 'project-default',
          runs: 1,
          codexBin: fixture.codexBin,
          sourceEnv: process.env,
        });
        expect(report, JSON.stringify(report, null, 2)).toMatchObject({
          outcome: 'passed',
          complete: true,
          mechanicalPassed: true,
        });
        descendantPid = Number(await fs.readFile(fixture.descendantPidPath, 'utf8'));
        expect(processExists(descendantPid)).toBe(false);
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
    'preserves project exec-policy rules only when the case requests them',
    async () => {
      const fixture = await createFixture({ useProjectRules: true });
      const report = await runCodexTriggerSuite({
        suite: suite(),
        split: 'validation',
        subjectRoot: fixture.subjectRoot,
        pluginRoot: fixture.pluginRoot,
        profile: 'project-default',
        runs: 1,
        codexBin: fixture.codexBin,
        sourceEnv: process.env,
      });
      expect(report, JSON.stringify(report, null, 2)).toMatchObject({
        outcome: 'passed',
        complete: true,
        mechanicalPassed: true,
      });
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
