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
  runCodexTriggerProviderCase,
  settleAppServerProcessCleanup,
  type AwSkillEvalTriggerCase,
  type AwSkillEvalTriggerSuiteCaseContract,
  type CodexEvalRuntimeConfig,
} from '../../src/index.js'
import { createDirectChildProcessMonitor } from '../../src/index.js'
import { CodexEvalAttemptControl } from '../../src/codex-eval-app-server.js'

describe('Codex provider app-server process boundary', () => {
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

  it('uses shared POSIX cleanup for a tagged app-server tree', async () => {
    const marker = 'tree-id'
    const processes = new Map([
      [100, { ppid: 1, pgid: 100, state: 'S', startTime: 'root-start', marked: true }],
      [101, { ppid: 100, pgid: 100, state: 'S', startTime: 'child-start', marked: true }],
      [200, { ppid: 1, pgid: 200, state: 'S', startTime: 'foreign-start', marked: false }],
    ])
    const signals: Array<[number, string]> = []
    const monitor = createPosixProcessTreeMonitor(100, {
      treeId: marker,
      execFile: (_command, args, _options, callback) => callback(
        null,
        args.some((arg) => arg.includes('command='))
          ? [...processes]
              .map(([pid, entry]) => [
                pid,
                entry.ppid,
                entry.pgid,
                entry.state,
                entry.startTime,
                'node',
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

    await expect(monitor.terminate()).resolves.toEqual([])

    expect(signals).toContainEqual([-100, 'SIGTERM'])
    expect(signals).toContainEqual([-100, 'SIGKILL'])
    expect(processes.has(100)).toBe(false)
    expect(processes.has(101)).toBe(false)
    expect(processes.has(200)).toBe(true)
  })

  it('times out a delayed initialize before turn/start', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-delayed-initialize-'))
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
        "      setTimeout(() => process.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + '\\n'), 1000)",
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

      expect(evidence).toMatchObject({ termination: 'timeout', execution_error: true })
      const requests = await vi.waitFor(() => fs.readFile(requestLog, 'utf8'))
      expect(requests).toContain('initialize')
      expect(requests).not.toContain('turn/start')
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
      await fs.remove(root)
    }
  })
})
