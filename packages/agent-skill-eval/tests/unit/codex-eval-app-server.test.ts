import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import fs from 'fs-extra'
import { describe, expect, it, vi } from 'vitest'

import {
  createPosixProcessTreeMonitor,
  inspectAppServerConfigWarning,
  runCodexConversationProviderCase,
  runCodexTriggerProviderCase,
  settleAppServerProcessCleanup,
  type AwSkillEvalTriggerCase,
  type AwSkillEvalTriggerSuiteCaseContract,
  type CodexEvalRuntimeConfig,
} from '../../src/index.js'
import { createDirectChildProcessMonitor } from '../../src/index.js'
import { CodexEvalAttemptControl, EvalAppServerSession } from '../../src/codex-eval-app-server.js'

describe('Codex provider app-server process boundary', () => {
  it.skipIf(process.platform !== 'darwin').each([false, true])(
    'sends the output schema and waits for the root conversation turn (structured=%s)', async (structured) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-output-schema-'))
      try {
        const subjectRoot = path.join(root, 'subject')
        const codexBin = path.join(root, 'fake-codex.mjs')
        await fs.ensureDir(subjectRoot)
        await fs.writeFile(codexBin, [
          '#!/usr/bin/env node',
          "let buffer = ''",
          "const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n')",
          "process.stdin.setEncoding('utf8')",
          "process.stdin.on('data', (chunk) => {",
          '  buffer += chunk',
          "  let newline = buffer.indexOf('\\n')",
          '  while (newline >= 0) {',
          '    const frame = JSON.parse(buffer.slice(0, newline))',
          '    buffer = buffer.slice(newline + 1)',
          "    if (frame.method === 'initialize') emit({ id: frame.id, result: {} })",
          "    if (frame.method === 'thread/start') emit({ id: frame.id, result: { thread: { id: 'thread-1' } } })",
          "    if (frame.method === 'turn/start') {",
          "      emit({ method: 'test/turnRequest', params: frame.params })",
          '      emit({ id: frame.id, result: {} })',
          "      emit({ method: 'item/tool/requestUserInput', id: 'child-question', params: { threadId: 'child-thread', questions: [] } })",
          "      emit({ method: 'item/completed', params: { threadId: 'child-thread', item: { type: 'agentMessage', phase: 'final_answer', text: 'child finished' } } })",
          "      emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'child-thread', tokenUsage: { total: { inputTokens: 999, outputTokens: 999 } } } })",
          "      emit({ method: 'turn/completed', params: { threadId: 'child-thread', turn: { status: 'completed' } } })",
          '      setTimeout(() => {',
          "        emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', phase: 'final_answer', text: '{\"answer\":\"done\"}' } } })",
          "        emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', tokenUsage: { total: { inputTokens: 10, outputTokens: 2 } } } })",
          "        emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } })",
          '      }, 100)',
          '    }',
          "    newline = buffer.indexOf('\\n')",
          '  }',
          '})',
          'setTimeout(() => process.exit(124), 30_000)',
        ].join('\n'))
        await fs.chmod(codexBin, 0o755)
        const schema = {
          type: 'object', properties: { answer: { type: 'string' } },
          required: ['answer'], additionalProperties: false,
        }
        const evidence = await runCodexConversationProviderCase({
          evalCase: {
            id: 'structured', prompt: 'Return an answer.', scriptedReplies: [],
            expectedOutput: 'A JSON answer.', checks: [], workspaceFiles: {},
            workspaceUnchanged: true, sandbox: 'read-only', allowedWorkspaceChanges: [],
            artifacts: [], environmentPathPrepend: [],
          },
          sourceProjectRoot: subjectRoot, skillMode: 'without-skill',
          skillName: 'unused', skillNames: [], codexBin,
          codexRuntime: {
            inherited: false, model: null, modelProvider: 'openai',
            credentialSource: 'environment', configToml: 'model_provider = "openai"\n',
            providerEnvironment: { OPENAI_API_KEY: 'fake-key' },
            sourceCodexHome: root, copyOpenAiAuth: false,
            sensitiveEnvironmentNames: ['OPENAI_API_KEY'], sensitiveValues: ['fake-key'],
            evidenceDigest: 'sha256:test',
          },
          timeoutMs: 5_000, sourceEnv: { PATH: process.env.PATH },
          isolation: 'standard', environmentFixtures: [],
          ...(structured ? { outputSchema: schema } : {}),
        })
        expect(evidence.complete).toBe(true)
        expect(evidence.mechanicalPassed).toBe(true)
        expect(evidence.rootThreadId).toBe('thread-1')
        expect(evidence.finalMessages).toEqual(['{"answer":"done"}'])
        expect(evidence.questions).toEqual([])
        expect(evidence.usage).toEqual({ total: { inputTokens: 10, outputTokens: 2 } })
        expect(evidence.eventTrace).toContainEqual({
          method: 'turn/completed', params: { threadId: 'child-thread', turn: { status: 'completed' } },
        })
        const request = evidence.eventTrace.find((event) => event !== null && typeof event === 'object'
          && (event as Record<string, unknown>).method === 'test/turnRequest') as
          { params: { outputSchema?: unknown } } | undefined
        expect(request).toBeDefined()
        expect(request?.params.outputSchema).toEqual(structured ? schema : undefined)
      } finally {
        await fs.remove(root)
      }
    },
  )

  it.skipIf(process.platform !== 'darwin').each(['none', 'modify', 'create', 'delete', 'directory'])(
    'enforces an empty write allowlist against actual workspace changes (%s)', async (mutation) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-deny-all-'))
      try {
        const subjectRoot = path.join(root, 'subject')
        const codexBin = path.join(root, 'fake-codex.mjs')
        await fs.ensureDir(subjectRoot)
        await fs.writeFile(codexBin, [
          '#!/usr/bin/env node',
          "import fs from 'node:fs'",
          "import path from 'node:path'",
          `const mutation = ${JSON.stringify(mutation)}`,
          "let buffer = ''",
          "const emit = frame => process.stdout.write(JSON.stringify(frame) + '\\n')",
          "process.stdin.setEncoding('utf8')",
          "process.stdin.on('data', chunk => {",
          '  buffer += chunk',
          "  let newline = buffer.indexOf('\\n')",
          '  while (newline >= 0) {',
          '    const frame = JSON.parse(buffer.slice(0, newline))',
          '    buffer = buffer.slice(newline + 1)',
          "    if (frame.method === 'initialize') emit({ id: frame.id, result: {} })",
          "    if (frame.method === 'thread/start') emit({ id: frame.id, result: { thread: { id: 'root' } } })",
          "    if (frame.method === 'turn/start') {",
          "      const file = path.join(frame.params.cwd, 'note.md')",
          "      if (mutation === 'modify') fs.writeFileSync(file, 'changed')",
          "      if (mutation === 'create') fs.writeFileSync(path.join(frame.params.cwd, 'new.md'), 'new')",
          "      if (mutation === 'delete') fs.unlinkSync(file)",
          "      if (mutation === 'directory') fs.mkdirSync(path.join(frame.params.cwd, 'new-directory'))",
          "      emit({ method: 'test/mutationCompleted', params: { mutation } })",
          '      emit({ id: frame.id, result: {} })',
          "      emit({ method: 'turn/completed', params: { threadId: 'root', turn: { status: 'completed' } } })",
          '    }',
          "    newline = buffer.indexOf('\\n')",
          '  }',
          '})',
          'setTimeout(() => process.exit(124), 30_000)',
        ].join('\n'))
        await fs.chmod(codexBin, 0o755)
        const evidence = await runCodexConversationProviderCase({
          evalCase: {
            id: 'deny-all', prompt: 'Inspect without editing.', scriptedReplies: [],
            expectedOutput: 'No changes.', checks: ['Does not write files.'],
            workspaceFiles: { 'note.md': 'original\n' },
            workspaceUnchanged: false, sandbox: 'workspace-write', allowedWorkspaceChanges: [],
            artifacts: [], environmentPathPrepend: [],
          },
          sourceProjectRoot: subjectRoot, skillMode: 'without-skill',
          skillName: 'unused', skillNames: [], codexBin,
          codexRuntime: {
            inherited: false, model: null, modelProvider: 'openai',
            credentialSource: 'environment', configToml: 'model_provider = "openai"\n',
            providerEnvironment: { OPENAI_API_KEY: 'fake-key' },
            sourceCodexHome: root, copyOpenAiAuth: false,
            sensitiveEnvironmentNames: ['OPENAI_API_KEY'], sensitiveValues: ['fake-key'],
            evidenceDigest: 'sha256:test',
          },
          timeoutMs: 5_000, sourceEnv: { PATH: process.env.PATH },
          isolation: 'standard', environmentFixtures: [],
        })
        expect(evidence.complete).toBe(true)
        expect(evidence.eventTrace).toContainEqual({
          method: 'test/mutationCompleted', params: { mutation },
        })
        expect(evidence.mechanicalPassed).toBe(mutation === 'none')
        if (mutation === 'none') expect(evidence.workspaceChanges).toEqual([])
        else {
          expect(evidence.workspaceChanges.length).toBeGreaterThan(0)
          expect(evidence.diagnostics.join('\n')).toContain('outside the allowed paths')
        }
      } finally {
        await fs.remove(root)
      }
    },
  )

  it('keeps the attempt budget separate from the 30 second RPC cap', () => {
    vi.useFakeTimers({ now: new Date('2026-08-31T00:00:00.000Z') })
    try {
      const long = new CodexEvalAttemptControl({ label: 'long', timeoutMs: 180_000 })
      expect(long.remaining('evaluation')).toBe(180_000)
      expect(long.rpcTimeout('initialize')).toBe(30_000)
      long.dispose()

      const partial = new CodexEvalAttemptControl({ label: 'partial', timeoutMs: 60_000 })
      vi.advanceTimersByTime(35_000)
      expect(partial.timeoutExpired).toBe(false)
      expect(partial.remaining('evaluation')).toBe(25_000)
      expect(partial.rpcTimeout('turn/start')).toBe(25_000)
      partial.dispose()

      const unmanaged = new CodexEvalAttemptControl({ label: 'unmanaged' })
      expect(unmanaged.rpcTimeout('initialize')).toBe(30_000)
      expect(() => unmanaged.remaining('evaluation')).toThrow('has no deadline')
      unmanaged.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('detects app-server config warnings for strict provider runs', () => {
    expect(inspectAppServerConfigWarning({
      method: 'configWarning',
      params: { summary: 'Project-local config is disabled.' },
    })).toBe('Project-local config is disabled.')
    expect(inspectAppServerConfigWarning({ method: 'turn/started', params: {} })).toBeNull()
  })

  it('releases open handles before reporting unconfirmed cleanup', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const unref = vi.fn()
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      unref,
    }) as unknown as ChildProcess
    const waitForClose = vi.fn(async () => false)

    await expect(settleAppServerProcessCleanup({
      child,
      processTreeMonitor: {
        terminate: async () => [
          'Could not confirm process-tree cleanup: token scan unavailable.',
        ],
      },
      waitForClose,
    })).rejects.toThrow('token scan unavailable')

    expect(waitForClose).toHaveBeenCalledWith(1_000)
    expect(stdin.destroyed).toBe(true)
    expect(stdout.destroyed).toBe(true)
    expect(stderr.destroyed).toBe(true)
    expect(unref).toHaveBeenCalledOnce()
  })

  it('settles direct child cleanup as soon as the child closes', async () => {
    vi.useFakeTimers()
    try {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        kill: vi.fn(() => true),
      }) as unknown as ChildProcess

      const termination = createDirectChildProcessMonitor(child).terminate()
      child.emit('close', 0, null)

      await expect(termination).resolves.toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows a tagged POSIX scan to use the full cleanup deadline', async () => {
    const processes = new Map([
      [100, { ppid: 1, state: 'S', startTime: 'root-start' }],
    ])
    const snapshot = () => new Map(processes)
    const monitor = createPosixProcessTreeMonitor(100, {
      treeId: 'tree-id',
      readProcessTable: async () => snapshot(),
      readTaggedProcessTable: async () => await new Promise((resolve) => {
        setTimeout(() => resolve(snapshot()), 1_100)
      }),
      kill: (pid, signal) => {
        const entry = processes.get(pid)
        if (entry && signal === 'SIGSTOP') {
          processes.set(pid, { ...entry, state: 'T' })
        }
        if (signal === 'SIGKILL') processes.delete(pid)
        return true
      },
    })

    await expect(monitor.terminate()).resolves.toEqual([])
  })

  it.each([
    { label: 'same process group', childPgid: 100, failure: undefined },
    { label: 'separate child process group', childPgid: 101, failure: undefined },
    { label: 'temporary marker loss', childPgid: 101, failure: 'lost its process marker', missingPid: 101, reason: 'known-process-marker-missing' },
    { label: 'root marker loss', childPgid: 101, failure: 'lost its process marker', missingPid: 100, reason: 'known-process-marker-missing' },
    { label: 'unmarked initial group member', childPgid: 101, failure: 'lost its process marker', missingPid: 102, reason: 'initial-group-marker-missing' },
    { label: 'temporary inspection failure', childPgid: 101, failure: 'POSIX process marker lookup failed' },
  ])('cleans a tagged app-server tree with $label', async ({ childPgid, failure, missingPid, reason }) => {
    vi.useFakeTimers()
    const marker = 'tree-id'
    const processes = new Map([
      [100, { ppid: 1, pgid: 100, state: 'S', startTime: 'root-start', marked: true }],
      [101, { ppid: 100, pgid: childPgid, state: 'S', startTime: 'child-start', marked: true }],
      [200, { ppid: 1, pgid: 200, state: 'S', startTime: 'foreign-start', marked: false }],
    ])
    let inspectionFailed = false
    const signals: Array<[number, string]> = []
    const monitor = createPosixProcessTreeMonitor(100, {
      treeId: marker,
      execFile: (_command, args, _options, callback) => callback(
        inspectionFailed && args.some((arg) => arg.includes('command='))
          ? new Error('inspection unavailable')
          : null,
        args.some((arg) => arg.includes('command='))
          ? [...processes]
              .map(([pid, entry]) => [
                pid,
                entry.ppid,
                entry.pgid,
                entry.state,
                entry.startTime,
                'node',
                '--token=private-command API_KEY=private-environment',
                ...(entry.marked ? [`AW_CODEX_EVAL_PROCESS_TREE_ID=${marker}`] : []),
              ].join(' '))
              .join('\n')
          : [...processes]
              .map(([pid, entry]) =>
                `${pid} ${entry.ppid} ${entry.pgid} ${entry.state} ${entry.startTime}`)
              .join('\n'),
      ),
      kill: (pid, signal) => {
        signals.push([pid, String(signal)])
        if (pid === -100 && signal === 'SIGTERM') {
          for (const [candidatePid, entry] of processes) {
            if (entry.pgid === 100) processes.set(candidatePid, { ...entry, state: 'T' })
          }
        }
        if (signal === 'SIGKILL') {
          if (pid === -100) {
            for (const [candidatePid, entry] of processes) {
              if (entry.pgid === 100) processes.delete(candidatePid)
            }
          } else {
            processes.delete(pid)
          }
        }
        return true
      },
    })

    try {
      await vi.advanceTimersByTimeAsync(0)
      // A transient runtime failure must remain visible even after inspection recovers.
      if (missingPid === 102) {
        processes.set(102, { ppid: 1, pgid: 100, state: 'S', startTime: 'new-start', marked: false })
      } else if (missingPid) processes.get(missingPid)!.marked = false
      inspectionFailed = failure === 'POSIX process marker lookup failed'
      await vi.advanceTimersByTimeAsync(1_000)
      if (missingPid) processes.get(missingPid)!.marked = true
      inspectionFailed = false

      const termination = monitor.terminate()
      await vi.runAllTimersAsync()
      const diagnostics = await termination
      expect(diagnostics).toEqual(failure ? [expect.stringContaining(failure)] : [])
      if (failure) {
        expect(monitor.snapshots).toHaveLength(2)
        expect(monitor.snapshots?.[0]).toMatchObject({
          stage: 'observation',
          reason: reason ?? 'marker-lookup-failed',
          rootPid: 100,
          affectedPids: missingPid ? [missingPid] : [],
          markerLookupSucceeded: Boolean(missingPid),
        })
        if (missingPid) expect(monitor.snapshots?.[0]?.processes).toContainEqual(
          expect.objectContaining({ pid: missingPid, present: true, markerMatches: false, state: 'S' }),
        )
        expect(monitor.snapshots?.[1]).toMatchObject({
          stage: 'termination-verification',
          processes: expect.arrayContaining([
            expect.objectContaining({ pid: 100, present: false }),
            expect.objectContaining({ pid: 101, present: false }),
          ]),
        })
        const saved = JSON.stringify(monitor.snapshots)
        for (const secret of [marker, 'private-command', 'private-environment', 'foreign-start']) {
          expect(saved).not.toContain(secret)
        }
      } else expect(monitor.snapshots).toEqual([])

      expect(signals).toContainEqual([-100, 'SIGTERM'])
      expect(signals).toContainEqual([-100, 'SIGKILL'])
      expect(signals).toContainEqual([101, 'SIGKILL'])
      expect(signals.some(([pid]) => pid === 200 || pid === -200 || pid === -101)).toBe(false)
      expect(processes.has(100)).toBe(false)
      expect(processes.has(101)).toBe(false)
      expect(processes.has(200)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    { label: 'delayed initialize', delay: 1_000, cleanupFailure: false },
    { label: 'delayed initialize with cleanup failure', delay: 1_000, cleanupFailure: true },
    { label: 'completed turn with cleanup failure', delay: 0, cleanupFailure: true },
  ])('preserves evidence for $label', async ({ delay, cleanupFailure }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-delayed-initialize-'))
    const cleanup = EvalAppServerSession.prototype.cleanup
    const cleanupSpy = cleanupFailure
      ? vi.spyOn(EvalAppServerSession.prototype, 'cleanup').mockImplementation(async function () {
          await cleanup.call(this)
          throw new Error('synthetic cleanup failure')
        })
      : undefined
    try {
      const subjectRoot = path.join(root, 'subject')
      const fixtureRoot = path.join(root, 'fixtures')
      const sourceCodexHome = path.join(root, 'source-codex-home')
      const requestLog = path.join(root, 'requests.log')
      const launchLog = path.join(root, 'launch.json')
      const codexBin = path.join(root, 'fake-codex.mjs')
      await Promise.all([
        fs.ensureDir(subjectRoot),
        fs.ensureDir(fixtureRoot),
        fs.ensureDir(sourceCodexHome),
      ])
      await fs.writeFile(codexBin, [
        '#!/usr/bin/env node',
        "import fs from 'node:fs'",
        `fs.writeFileSync(${JSON.stringify(launchLog)}, JSON.stringify({`,
        '  args: process.argv.slice(2),',
        '  gitConfigNoSystem: process.env.GIT_CONFIG_NOSYSTEM,',
        '  gitTerminalPrompt: process.env.GIT_TERMINAL_PROMPT,',
        '  gitOptionalLocks: process.env.GIT_OPTIONAL_LOCKS,',
        '}))',
        "let buffer = ''",
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk",
        "  let newline = buffer.indexOf('\\n')",
        "  while (newline >= 0) {",
        "    const frame = JSON.parse(buffer.slice(0, newline))",
        "    buffer = buffer.slice(newline + 1)",
        `    fs.appendFileSync(${JSON.stringify(requestLog)}, String(frame.method) + '\\n')`,
        "    if (frame.method === 'initialize') {",
        "      process.stdout.write(JSON.stringify({ method: 'test/observed', params: {} }) + '\\n')",
        `      setTimeout(() => process.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + '\\n'), ${delay})`,
        "    } else if (frame.method === 'thread/start') {",
        "      process.stdout.write(JSON.stringify({ id: frame.id, result: { thread: { id: 'thread-1' } } }) + '\\n')",
        "    } else if (frame.method === 'turn/start') {",
        "      process.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + '\\n')",
        "      process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } }) + '\\n')",
        "    }",
        "    newline = buffer.indexOf('\\n')",
        "  }",
        "})",
        "setTimeout(() => process.exit(124), 30_000)",
        "setInterval(() => {}, 1000)",
      ].join('\n'))
      await fs.chmod(codexBin, 0o755)
      const runtime: CodexEvalRuntimeConfig = {
        inherited: false,
        model: null,
        modelProvider: 'openai',
        credentialSource: 'environment',
        configToml: 'model_provider = "openai"\n',
        providerEnvironment: { OPENAI_API_KEY: 'fake-key' },
        sourceCodexHome,
        copyOpenAiAuth: false,
        sensitiveEnvironmentNames: ['OPENAI_API_KEY'],
        sensitiveValues: ['fake-key'],
        evidenceDigest: 'sha256:test',
      }
      const suite: AwSkillEvalTriggerSuiteCaseContract = {
        id: 'delayed-initialize',
        kind: 'trigger',
        skill: 'fixture-skill',
        skills: ['fixture-skill'],
        cases: 'cases.json',
        observeSpawnAgent: false,
        isolation: 'standard',
        strictNegativeSplits: [],
        forbidMultipleSkillLoads: false,
        profiles: ['project'],
        defaultRuns: 1,
        releaseSplits: ['validation'],
        requiredForRelease: true,
        perRunTimeoutMs: 1_000,
      }
      const evalCase: AwSkillEvalTriggerCase = {
        id: 'case-1',
        split: 'validation',
        query: 'Do the task.',
        should_load_skill: false,
      }

      const evidence = await runCodexTriggerProviderCase({
        suite,
        evalCase,
        subjectRoot,
        fixtureRoot,
        codexBin,
        codexRuntime: runtime,
        sourceEnv: { PATH: process.env.PATH },
        processManagement: {
          mode: 'unmanaged-confirmed',
          inspectionAvailable: false,
          userAcknowledged: true,
          descendantCleanupGuaranteed: false,
        },
        manageTimeout: true,
        timeoutMs: 1_000,
      })

      expect(evidence).toMatchObject({ termination: delay ? 'timeout' : 'completed', execution_error: true })
      expect(evidence.event_trace).toContainEqual({ method: 'test/observed', params: {} })
      if (cleanupFailure) expect(evidence.diagnostics).toContain('Trigger eval app-server cleanup failed: synthetic cleanup failure')
      const requests = await vi.waitFor(() => fs.readFile(requestLog, 'utf8'))
      expect(requests).toContain('initialize')
      if (delay) expect(requests).not.toContain('turn/start')
      else expect(requests).toContain('turn/start')
      const launch = JSON.parse(await fs.readFile(launchLog, 'utf8')) as {
        args: string[]
        gitConfigNoSystem?: string
        gitTerminalPrompt?: string
        gitOptionalLocks?: string
      }
      expect(launch).toMatchObject({
        gitConfigNoSystem: '1',
        gitTerminalPrompt: '0',
        gitOptionalLocks: '0',
      })
      expect(launch.args).toEqual(expect.arrayContaining([
        'shell_environment_policy.set.GIT_CONFIG_NOSYSTEM="1"',
        'shell_environment_policy.set.GIT_TERMINAL_PROMPT="0"',
        'shell_environment_policy.set.GIT_OPTIONAL_LOCKS="0"',
      ]))
    } finally {
      cleanupSpy?.mockRestore()
      await fs.remove(root)
    }
  })
})
