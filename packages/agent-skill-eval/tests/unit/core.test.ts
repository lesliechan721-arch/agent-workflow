import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  assertProviderProcessSupported,
  canonicalJson,
  computeCaseCorpusDigest,
  computeSkillDigest,
  createRuntimeSkillSnapshot,
  getRuntimeCapabilities,
  getSchema,
  getSchemaDigest,
  runExecutionPlan as runExecutionPlanWithoutContainment,
  runProviderProcess as runProviderProcessWithoutContainment,
  validateExecutionPlan,
  validateRuntimeCapabilities,
  validateRunBundle,
} from '../../dist/index.js'

const externalContainment = {
  confirmed: true,
  descendantCleanupGuaranteed: true,
  readOnlySkillSnapshotGuaranteed: true,
} as const

const containedProcessHooks = {
  externalContainment,
  terminateProcessTree: async ({ pid }: { pid: number }) => {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL')
    } catch {
      // The provider can already be closed.
    }
    return { confirmed: true as const }
  },
}

function getContainedRuntimeCapabilities() {
  const capabilities = getRuntimeCapabilities()
  return {
    ...capabilities,
    capabilities: {
      ...capabilities.capabilities,
      skillPathExecution: true,
      previousVersionBaseline: true,
      withoutSkillBaseline: true,
    },
  }
}

async function auditPathsForPlan(planPath: string): Promise<string[]> {
  const plan = JSON.parse(await readFile(planPath, 'utf8'))
  const caseIds: string[] = []
  for (const relativePath of plan.cases?.paths ?? []) {
    try {
      const value = JSON.parse(await readFile(path.resolve(path.dirname(planPath), relativePath), 'utf8'))
      const rows = Array.isArray(value) ? value : value.cases ?? value.evals ?? []
      caseIds.push(...rows.map((entry: { id?: unknown }) => String(entry.id ?? '')))
    } catch {
      caseIds.push('case-1')
    }
  }
  const skillDigests = new Set<string>([
    plan.target?.digest,
    ...(plan.configurations ?? []).flatMap((entry: { skillMode?: string; skillDigest?: string }) =>
      entry.skillMode === 'previous-version' && entry.skillDigest ? [entry.skillDigest] : []),
  ].filter(Boolean))
  const auditPaths: string[] = []
  for (const skillDigest of skillDigests) {
    const auditPath = path.join(
      path.dirname(planPath),
      `.audit-${skillDigest.slice('sha256:'.length, 'sha256:'.length + 12)}.json`,
    )
    await writeFile(auditPath, JSON.stringify({
      schemaVersion: 3,
      producer: 'audit-agent-skill-evals',
      independentContext: true,
      auditId: `audit-${skillDigest.slice(-12)}`,
      mode: 'preflight',
      targetSkillDigest: skillDigest,
      caseCorpusDigest: plan.cases?.corpusDigest ?? digest('invalid-corpus'),
      runBundleDigest: null,
      validity: 'pass',
      optimizationPolicy: 'balanced',
      cases: [...new Set(caseIds)].map((caseId) => ({
        caseId,
        releaseRelevant: true,
        admission: 'pass',
        oracleConfidence: 'high',
        findings: [],
      })),
      blockedCases: [],
      releaseEligible: false,
      failureTriage: [],
      recommendedAction: 'collect-more-data',
    }))
    auditPaths.push(auditPath)
  }
  return auditPaths
}

async function runExecutionPlan(
  planPath: string,
  options: Partial<Parameters<typeof runExecutionPlanWithoutContainment>[1]> = {},
) {
  return runExecutionPlanWithoutContainment(planPath, {
    ...options,
    auditPaths: options.auditPaths ?? await auditPathsForPlan(planPath),
    processHooks: { ...containedProcessHooks, ...options.processHooks },
  })
}

function runProviderProcess(
  ...args: Parameters<typeof runProviderProcessWithoutContainment>
) {
  const [request, hooks = {}, dependencies] = args
  return runProviderProcessWithoutContainment(
    request,
    { ...containedProcessHooks, ...hooks },
    dependencies,
  )
}

const execFileAsync = promisify(execFile)

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

describe('public Eval execution contracts', () => {
  it('uses code-unit key ordering for the canonical case corpus digest', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-corpus-'))
    const casePath = path.join(root, 'cases.json')
    try {
      const document = { path: { 'a/b': 1, 'A.b': 2, '_key': 3 }, cases: [] }
      await writeFile(casePath, JSON.stringify(document))
      expect(canonicalJson(document)).toBe('{"cases":[],"path":{"A.b":2,"_key":3,"a/b":1}}')
      expect(await computeCaseCorpusDigest([casePath])).toBe(digest(canonicalJson(document)))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prints stable command help and embedded canonical schemas', async () => {
    const bin = path.resolve('dist/bin.js')
    const help = await execFileAsync(process.execPath, [bin, '--help'], { cwd: path.resolve('.') })
    expect(help.stdout).toContain('capabilities --json')
    expect(help.stdout).toContain('bundle validate <bundle.json>')

    const printed = await execFileAsync(
      process.execPath,
      [bin, 'schema', 'print', 'aw-skill-eval-execution-plan'],
      { cwd: path.resolve('.') },
    )
    const schema = JSON.parse(printed.stdout)
    expect(schema).toEqual(await getSchema('aw-skill-eval-execution-plan'))
    expect(await getSchemaDigest('aw-skill-eval-execution-plan')).toBe(digest(JSON.stringify(schema)))
    await expect(execFileAsync(
      process.execPath,
      [bin, 'schema', 'print', 'eval-execution-plan'],
      { cwd: path.resolve('.') },
    )).rejects.toThrow()
    await expect(execFileAsync(
      process.execPath,
      [bin, 'schema', 'print', 'eval-audit-result'],
      { cwd: path.resolve('.') },
    )).resolves.toMatchObject({ stdout: expect.stringContaining('EvalAuditResult') })
    await expect(validateRuntimeCapabilities(getRuntimeCapabilities())).resolves.toMatchObject({
      valid: true,
      errors: [],
      calculated: {
        schemaVersion: 2,
        provider: 'aw-skill-eval-process',
      },
    })
    await expect(validateRuntimeCapabilities({
      ...getRuntimeCapabilities(),
      schemaVersion: 1,
    })).resolves.toMatchObject({
      valid: false,
      calculated: null,
      errors: expect.arrayContaining(['$/schemaVersion: must equal 2']),
    })
  })

  it('copies only runtime Skill content without changing the source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-snapshot-'))
    const source = path.join(root, 'source')
    const destination = path.join(root, 'snapshot')
    await mkdir(path.join(source, 'references'), { recursive: true })
    await mkdir(path.join(source, 'evals'), { recursive: true })
    await writeFile(path.join(source, 'SKILL.md'), 'runtime\n')
    await writeFile(path.join(source, 'references', 'guide.md'), 'guide\n')
    await writeFile(path.join(source, '.DS_Store'), 'finder metadata\n')
    await mkdir(path.join(source, 'references', '.DS_Store'))
    await writeFile(path.join(source, 'references', '.DS_Store', 'nested'), 'finder metadata\n')
    await writeFile(path.join(source, '.runtime-hidden'), 'production hidden file\n')
    await writeFile(path.join(source, 'evals', 'case.json'), '{}\n')
    const before = await computeSkillDigest(source)
    const executablePath = path.join(source, 'references', 'guide.md')
    const windowsModeBefore = await computeSkillDigest(source, { platform: 'win32' })
    if (process.platform !== 'win32') {
      await chmod(executablePath, 0o755)
      expect(await computeSkillDigest(source)).not.toBe(before)
      expect(await computeSkillDigest(source, { platform: 'win32' })).toBe(windowsModeBefore)
    }
    const sourceDigest = await computeSkillDigest(source)
    const snapshot = await createRuntimeSkillSnapshot(source, destination)
    expect(snapshot.digest).toBe(sourceDigest)
    await expect(readFile(path.join(destination, 'SKILL.md'), 'utf8')).resolves.toBe('runtime\n')
    await expect(readFile(path.join(destination, '.runtime-hidden'), 'utf8')).resolves.toBe(
      'production hidden file\n',
    )
    await expect(readFile(path.join(destination, '.DS_Store'), 'utf8')).rejects.toThrow()
    await expect(readFile(path.join(destination, 'references', '.DS_Store', 'nested'), 'utf8'))
      .rejects.toThrow()
    await expect(readFile(path.join(destination, 'evals', 'case.json'), 'utf8')).rejects.toThrow()
    expect(await computeSkillDigest(source)).toBe(sourceDigest)
    if (process.platform !== 'win32') {
      expect((await stat(path.join(destination, 'references', 'guide.md'))).mode & 0o777).toBe(0o755)
    }
  })

  it('does not collide when binary content encodes a following legacy record', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-digest-record-'))
    const singleRecord = path.join(root, 'single')
    const twoRecords = path.join(root, 'two')
    await Promise.all([mkdir(singleRecord), mkdir(twoRecords)])
    await writeFile(
      path.join(singleRecord, 'a'),
      Buffer.concat([
        Buffer.from('payload'),
        Buffer.from([0]),
        Buffer.from('b'),
        Buffer.from([0]),
        Buffer.from('100644'),
        Buffer.from([0]),
        Buffer.from('tail'),
      ]),
    )
    await writeFile(path.join(twoRecords, 'a'), 'payload')
    await writeFile(path.join(twoRecords, 'b'), 'tail')

    try {
      expect(await computeSkillDigest(singleRecord)).not.toBe(
        await computeSkillDigest(twoRecords),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('executes the captured Skill bytes across a source A-B-A swap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-snapshot-race-'))
    const skill = path.join(root, 'skill')
    const references = path.join(skill, 'references')
    await mkdir(references, { recursive: true })
    await writeFile(path.join(skill, 'SKILL.md'), 'runtime\n')
    await writeFile(path.join(references, '000-marker.txt'), 'marker\n')
    for (let index = 0; index < 40; index += 1) {
      await writeFile(
        path.join(references, `middle-${String(index).padStart(2, '0')}.txt`),
        Buffer.alloc(64 * 1024, index),
      )
    }
    const sourcePayload = path.join(references, 'zzz-payload.txt')
    await writeFile(sourcePayload, 'source-a\n')
    const targetDigest = await computeSkillDigest(skill)

    const cases = [{ id: 'case-1', prompt: 'hello' }]
    const casePath = path.join(root, 'cases.json')
    const caseRaw = JSON.stringify(cases)
    await writeFile(casePath, caseRaw)
    const capabilities = getContainedRuntimeCapabilities()
    const capabilitiesPath = path.join(root, 'capabilities.json')
    const capabilitiesRaw = JSON.stringify(capabilities)
    await writeFile(capabilitiesPath, capabilitiesRaw)
    const planPath = path.join(root, 'plan.json')
    await writeFile(planPath, JSON.stringify({
      schemaVersion: 4,
      planId: 'snapshot-race',
      target: { name: 'fixture', path: 'skill', digest: targetDigest },
      cases: { paths: ['cases.json'], corpusDigest: digest(caseRaw) },
      provider: {
        id: 'aw-skill-eval-process',
        command: [process.execPath, '-e', 'process.stdout.write("{}")'],
        describeCommand: [
          process.execPath,
          '-e',
          `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(capabilitiesPath)}, 'utf8'))`,
        ],
        cwd: null,
        env: {},
        capabilitiesPath: 'capabilities.json',
        capabilitiesDigest: digest(capabilitiesRaw),
        inheritEnvironment: false,
      },
      runtimeInputs: [],
      configurations: [{ id: 'current', skillMode: 'with-skill', comparisonId: null, env: {} }],
      runsPerCase: 1,
      timeoutMs: 1_000,
      outputRoot: 'output',
      capture: { outputs: true, trace: false, timing: true, usage: true },
    }))

    try {
      const snapshotCheck = [
        `const fs = require('node:fs')`,
        `fs.writeFileSync(${JSON.stringify(sourcePayload)}, 'source-b\\n')`,
        `const snapshot = fs.readFileSync(require('node:path').join(process.env.AGENT_EVAL_SKILL_PATH, 'references', 'zzz-payload.txt'), 'utf8')`,
        `fs.writeFileSync(${JSON.stringify(sourcePayload)}, 'source-a\\n')`,
        `if (snapshot !== 'source-a\\n') process.exit(9)`,
        `process.stdout.write(JSON.stringify({schemaVersion:1,provider:{id:${JSON.stringify(capabilities.provider)},version:${JSON.stringify(capabilities.providerVersion)}},usage:null,grading:null,artifacts:[]}))`,
      ].join(';')
      const plan = JSON.parse(await readFile(planPath, 'utf8'))
      plan.provider.command = [process.execPath, '-e', snapshotCheck]
      await writeFile(planPath, JSON.stringify(plan))
      const result = await runExecutionPlan(planPath)
      expect(result.valid).toBe(true)
      expect(await computeSkillDigest(skill)).toBe(targetDigest)
      plan.provider.command = [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(require('node:path').join(process.env.AGENT_EVAL_SKILL_PATH, 'SKILL.md'), 'provider mutation\\n'); process.stdout.write('{}')`,
      ]
      await writeFile(planPath, JSON.stringify(plan))
      await expect(runExecutionPlan(planPath)).rejects.toThrow(
        'Provider modified the captured Runtime Skill snapshot',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('captures successful, failed, and timed-out provider processes', async () => {
    const request = {
      executable: process.execPath,
      cwd: path.resolve('.'),
      env: process.env,
      timeoutMs: 2_000,
      maxBufferBytes: 1024,
    }
    const completed = await runProviderProcess({
      ...request,
      args: ['-e', 'process.stdout.write("ok")'],
    })
    expect(completed).toMatchObject({
      stdout: 'ok',
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      descendantCleanupGuaranteed: true,
    })

    const failed = await runProviderProcess({
      ...request,
      args: ['-e', 'process.stderr.write("failed");process.exit(7)'],
    })
    expect(failed).toMatchObject({ stderr: 'failed', exitCode: 7, timedOut: false })

    const timedOut = await runProviderProcess({
      ...request,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 50,
    })
    expect(timedOut).toMatchObject({ exitCode: null, timedOut: true, cancelled: false })

    const missing = await runProviderProcess({
      ...request,
      executable: path.join(os.tmpdir(), 'aw-skill-eval-command-does-not-exist'),
      args: [],
    })
    expect(missing).toMatchObject({ exitCode: null, timedOut: false, cancelled: false })
    expect(missing.stderr).toMatch(/ENOENT|not found/iu)

    expect(() => assertProviderProcessSupported('linux')).toThrow('explicitly confirmed external containment')
    expect(() => assertProviderProcessSupported('win32')).toThrow('explicitly confirmed external containment')
    expect(() => assertProviderProcessSupported('win32', containedProcessHooks)).not.toThrow()
    expect(getRuntimeCapabilities('win32').limitations).toContain(
      'Standalone win32 execution uses process observation and before/after Skill digests; it does not guarantee descendant cleanup.',
    )
    expect(getRuntimeCapabilities('win32').capabilities).toMatchObject({
      skillPathExecution: true,
      previousVersionBaseline: true,
      withoutSkillBaseline: true,
    })
    expect(getRuntimeCapabilities('aix').capabilities).toMatchObject({
      skillPathExecution: false,
      previousVersionBaseline: false,
      withoutSkillBaseline: false,
    })

    const stdoutLimited = await runProviderProcess({
      ...request,
      args: ['-e', 'process.stdout.write("abcdefghij")'],
      maxBufferBytes: 4,
    })
    expect(stdoutLimited).toMatchObject({
      stdout: 'abcd',
      terminationReason: 'max-buffer',
      maxBufferExceeded: true,
      stdoutTruncated: true,
      stderrTruncated: false,
    })
    const stderrLimited = await runProviderProcess({
      ...request,
      args: ['-e', 'process.stderr.write("abcdefghij")'],
      maxBufferBytes: 4,
    })
    expect(stderrLimited).toMatchObject({
      stderr: 'abcd',
      terminationReason: 'max-buffer',
      maxBufferExceeded: true,
      stdoutTruncated: false,
      stderrTruncated: true,
    })

    await expect(runProviderProcess({
      ...request,
      args: ['-e', 'process.exit(0)'],
    }, {
      terminateProcessTree: async () => { throw new Error('immediate cleanup failure') },
    })).rejects.toThrow('cleanup could not be proven')

    await expect(runProviderProcess({
      ...request,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 25,
    }, {
      terminateProcessTree: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        throw new Error('slow cleanup failure')
      },
    })).rejects.toThrow('cleanup could not be proven')
  })

  it('rejects an empty bundle and forged comparative evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-bundle-'))
    const bundlePath = path.join(root, 'bundle.json')
    const base = {
      schemaVersion: 4,
      runner: { id: 'fixture', version: '1' },
      independentContext: false,
      provider: { id: 'fixture', version: '1' },
      providerCapabilitiesDigest: digest('capabilities'),
      planDigest: digest('plan'),
      targetSkillDigest: digest('skill'),
      caseCorpusDigest: digest('cases'),
      runtimeInputs: [],
      comparisonPlanned: false,
      evidenceLevel: 'executed',
      runs: [],
      aggregate: {
        cases: 1,
        configurations: 1,
        runs: 0,
        completed: 0,
        processFailed: 0,
        timedOut: 0,
        comparisons: [],
      },
      limitations: [],
    }
    await writeFile(bundlePath, JSON.stringify(base))
    const empty = await validateRunBundle(bundlePath)
    expect(empty.valid).toBe(false)
    expect(empty.calculated?.bundleDigest).toBe(digest(JSON.stringify(base)))

    await writeFile(path.join(root, 'stdout.txt'), '{}')
    await writeFile(path.join(root, 'stderr.txt'), '')
    const run = {
      caseId: 'case-1',
      configuration: 'current',
      comparisonId: 'pair-1',
      skillMode: 'with-skill',
      skillDigest: base.targetSkillDigest,
      runIndex: 1,
      status: 'completed',
      exitCode: 0,
      durationMs: 1,
      stdoutPath: 'stdout.txt',
      stdoutDigest: digest('{}'),
      stderrPath: 'stderr.txt',
      stderrDigest: digest(''),
      usage: null,
      grading: { grader: { id: 'g', version: '1' }, result: { pass: true } },
      artifacts: [],
    }
    const forged = {
      ...base,
      comparisonPlanned: true,
      evidenceLevel: 'comparative',
      runs: [
        run,
        {
          ...run,
          configuration: 'baseline',
          skillMode: 'without-skill',
          skillDigest: null,
        },
      ],
      aggregate: {
        cases: 1,
        configurations: 2,
        runs: 2,
        completed: 2,
        processFailed: 0,
        timedOut: 0,
        comparisons: [{ comparisonId: 'pair-1', caseId: 'case-1', runIndex: 1, paired: true, comparable: false }],
      },
      limitations: ['No baseline completed.'],
    }
    await writeFile(bundlePath, JSON.stringify(forged))
    const result = await validateRunBundle(bundlePath)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('runs[0] grading requires exactly one grading artifact')
    expect(result.errors).toContain('runs[1] grading requires exactly one grading artifact')
    expect(result.errors).toContain('evidenceLevel must be executed for the supplied runs')

    const mismatchedGrading = JSON.stringify({
      grader: { id: 'g', version: '1' },
      result: { pass: false },
    })
    await writeFile(path.join(root, 'grading-current.json'), mismatchedGrading)
    await writeFile(path.join(root, 'grading-baseline.json'), mismatchedGrading)
    forged.runs[0].artifacts = [{
      role: 'grading',
      path: 'grading-current.json',
      digest: digest(mismatchedGrading),
    }]
    forged.runs[1].artifacts = [{
      role: 'grading',
      path: 'grading-baseline.json',
      digest: digest(mismatchedGrading),
    }]
    await writeFile(bundlePath, JSON.stringify(forged))
    const mismatched = await validateRunBundle(bundlePath)
    expect(mismatched.valid).toBe(false)
    expect(mismatched.errors).toContain('runs[0] grading artifact does not match run.grading')
    expect(mismatched.errors).toContain('evidenceLevel must be executed for the supplied runs')

    const matchingGrading = JSON.stringify(run.grading)
    await writeFile(path.join(root, 'grading-current.json'), matchingGrading)
    await writeFile(path.join(root, 'grading-baseline.json'), matchingGrading)
    forged.runs[0].artifacts[0].digest = digest(matchingGrading)
    forged.runs[1].artifacts[0].digest = digest(matchingGrading)
    forged.aggregate.comparisons[0].comparable = true
    Object.assign(forged, {
      evidenceRequirement: {
        minimumEvidenceLevel: 'comparative',
        plannedComparisons: 1,
        comparableComparisons: 1,
        satisfied: true,
      },
      processManagement: {
        mode: 'observed',
        descendantCleanupGuaranteed: false,
        limitation: 'Observed process management cannot support comparative evidence.',
      },
      limitations: ['Observed process management cannot support comparative evidence.'],
    })
    await writeFile(bundlePath, JSON.stringify(forged))
    const observedComparative = await validateRunBundle(bundlePath)
    expect(observedComparative.valid).toBe(false)
    expect(observedComparative.errors).toContain(
      'accepted comparative evidence requires managed or verified-observed process management',
    )

    forged.evidenceRequirement.minimumEvidenceLevel = 'executed'
    delete (forged as typeof forged & { processManagement?: unknown }).processManagement
    await writeFile(bundlePath, JSON.stringify(forged))
    const missingProcessEvidence = await validateRunBundle(bundlePath)
    expect(missingProcessEvidence.valid).toBe(false)
    expect(missingProcessEvidence.errors).toContain(
      'accepted comparative evidence requires processManagement evidence',
    )
  })

  it('runs a valid plan and emits a self-validating evidence bundle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-run-'))
    const skill = path.join(root, 'skill')
    await mkdir(skill)
    await writeFile(path.join(skill, 'SKILL.md'), 'runtime\n')
    const targetDigest = await computeSkillDigest(skill)
    const cases = [{ id: 'case-1', prompt: 'hello' }]
    const casePath = path.join(root, 'cases.json')
    await writeFile(casePath, JSON.stringify(cases))
    const caseCorpusDigest = digest(JSON.stringify(cases))
    const bin = path.resolve('dist/bin.js')
    const capabilitiesCommand = await execFileAsync(
      process.execPath,
      [bin, 'capabilities', '--json'],
      { cwd: path.resolve('.') },
    )
    const capabilities = JSON.parse(capabilitiesCommand.stdout)
    const capabilitiesPath = path.join(root, 'capabilities.json')
    const capabilitiesRaw = capabilitiesCommand.stdout
    await writeFile(capabilitiesPath, capabilitiesRaw)
    const plan = {
      schemaVersion: 4,
      planId: 'plan-1',
      target: { name: 'fixture', path: 'skill', digest: targetDigest },
      cases: { paths: ['cases.json'], corpusDigest: caseCorpusDigest },
      provider: {
        id: 'aw-skill-eval-process',
        command: [
          process.execPath,
          '-e',
          `process.stdout.write(JSON.stringify({schemaVersion:1,provider:{id:${JSON.stringify(capabilities.provider)},version:${JSON.stringify(capabilities.providerVersion)}},usage:{tokens:1,marker:process.env.AW_AGENT_SKILL_EVAL_PROCESS_MARKER},grading:{grader:{id:"fixture",version:"1"},result:{pass:true}},artifacts:[]}))`,
        ],
        describeCommand: [
          process.execPath,
          '-e',
          `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(capabilitiesPath)}, 'utf8'))`,
        ],
        cwd: null,
        env: { AW_AGENT_SKILL_EVAL_PROCESS_MARKER: 'caller-controlled-marker' },
        capabilitiesPath: 'capabilities.json',
        capabilitiesDigest: digest(capabilitiesRaw),
        inheritEnvironment: false,
      },
      runtimeInputs: [],
      configurations: [{ id: 'current', skillMode: 'with-skill', comparisonId: null, env: {} }],
      runsPerCase: 1,
      timeoutMs: 1_000,
      outputRoot: 'output',
      capture: { outputs: true, trace: false, timing: true, usage: true },
    }
    const planPath = path.join(root, 'plan.json')
    await writeFile(planPath, JSON.stringify(plan))
    const validatedPlan = await execFileAsync(
      process.execPath,
      [bin, 'plan', 'validate', planPath],
      { cwd: path.resolve('.') },
    )
    expect(JSON.parse(validatedPlan.stdout)).toMatchObject({ valid: true, errors: [] })
    await writeFile(planPath, JSON.stringify({
      ...plan,
      minimumEvidenceLevel: 'comparative',
    }))
    await expect(validateExecutionPlan(planPath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        'minimumEvidenceLevel comparative requires at least one comparison',
      ]),
    })
    await writeFile(planPath, JSON.stringify(plan))

    const mismatchedCapabilitiesRaw = JSON.stringify({
      ...capabilities,
      providerVersion: '9.9.9',
    })
    await writeFile(capabilitiesPath, mismatchedCapabilitiesRaw)
    plan.provider.capabilitiesDigest = digest(mismatchedCapabilitiesRaw)
    await writeFile(planPath, JSON.stringify(plan))
    const mismatchedCapabilities = await validateExecutionPlan(planPath)
    expect(mismatchedCapabilities.valid).toBe(true)
    await expect(runExecutionPlan(planPath)).rejects.toThrow('Generated EvalRunBundle is invalid')

    await writeFile(capabilitiesPath, capabilitiesRaw)
    plan.provider.capabilitiesDigest = digest(capabilitiesRaw)
    await writeFile(planPath, JSON.stringify(plan))
    const binaryRun = await execFileAsync(
      process.execPath,
      [bin, 'run', planPath, '--audit', ...(await auditPathsForPlan(planPath))],
      { cwd: path.resolve('.') },
    )
    const binaryResult = JSON.parse(binaryRun.stdout)
    expect(binaryResult).toMatchObject({ valid: true, evidenceLevel: 'executed' })
    const binaryBundleValidation = await execFileAsync(
      process.execPath,
      [bin, 'bundle', 'validate', binaryResult.bundlePath],
      { cwd: path.resolve('.') },
    )
    expect(JSON.parse(binaryBundleValidation.stdout)).toMatchObject({ valid: true, errors: [] })

    const result = await runExecutionPlanWithoutContainment(planPath, {
      auditPaths: await auditPathsForPlan(planPath),
    })
    expect(result.evidenceLevel).toBe('executed')
    const validated = await validateRunBundle(result.bundlePath)
    expect(validated).toMatchObject({
      valid: true,
      calculated: { bundleDigest: result.bundleDigest },
    })
    const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'))
    expect(bundle.runner).toEqual({ id: 'aw-skill-eval', version: capabilities.providerVersion })
    expect(bundle.runs[0].usage.marker).toBe('[redacted provider process marker]')
    expect(JSON.stringify(bundle)).not.toContain('caller-controlled-marker')
    expect(bundle.runs[0].artifacts).toEqual([])
    expect(bundle.limitations).toEqual(expect.arrayContaining([
      expect.stringContaining('does not guarantee descendant cleanup'),
      expect.stringContaining('provider grading was not accepted'),
    ]))
    expect(await computeSkillDigest(skill)).toBe(targetDigest)

    plan.minimumEvidenceLevel = 'comparative'
    plan.configurations = [
      { id: 'current', skillMode: 'with-skill', comparisonId: 'pair-1', env: {} },
      { id: 'baseline', skillMode: 'without-skill', comparisonId: 'pair-1', env: {} },
    ]
    await writeFile(planPath, JSON.stringify(plan))
    const comparative = await runExecutionPlan(planPath)
    expect(comparative).toMatchObject({
      evidenceLevel: 'comparative',
      requirementsMet: true,
    })
    const comparativeBundle = JSON.parse(await readFile(comparative.bundlePath, 'utf8'))
    expect(comparativeBundle).toMatchObject({
      evidenceRequirement: {
        minimumEvidenceLevel: 'comparative',
        plannedComparisons: 1,
        comparableComparisons: 1,
        satisfied: true,
      },
      processManagement: {
        mode: 'managed',
        descendantCleanupGuaranteed: true,
      },
    })

    const startedPath = path.join(root, 'restricted-started')
    plan.provider.command = [
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(startedPath)}, 'started')`,
    ]
    await writeFile(planPath, JSON.stringify(plan))
    const priorBundle = await readFile(path.join(root, 'output', 'eval-run-bundle.json'), 'utf8')
    await expect(runExecutionPlanWithoutContainment(planPath, {
      auditPaths: await auditPathsForPlan(planPath),
      sourceEnv: { CODEX_PERMISSION_PROFILE: ':workspace' },
      platform: 'linux',
    })).rejects.toThrow('one-off sandbox_permissions=require_escalated request is not Full Access')
    await expect(stat(startedPath)).rejects.toThrow()
    await expect(readFile(path.join(root, 'output', 'eval-run-bundle.json'), 'utf8')).resolves.toBe(priorBundle)

    plan.provider.command = [
      process.execPath,
      '-e',
      `process.stdout.write(JSON.stringify({schemaVersion:1,provider:{id:${JSON.stringify(capabilities.provider)},version:${JSON.stringify(capabilities.providerVersion)}},usage:null,grading:{grader:{id:"fixture",version:"1"},result:{pass:true}},artifacts:[]}))`,
    ]
    await writeFile(planPath, JSON.stringify(plan))
    let diagnosticCleanupCalls = 0
    const diagnostic = await runExecutionPlan(planPath, {
      processHooks: {
        terminateProcessTree: async () => {
          diagnosticCleanupCalls += 1
          if (diagnosticCleanupCalls > 1) throw new Error('cleanup fixture failure')
          return { confirmed: true }
        },
      },
    })
    expect(diagnostic).toMatchObject({ evidenceLevel: 'executed', requirementsMet: false })
    const diagnosticBundle = JSON.parse(await readFile(diagnostic.bundlePath, 'utf8'))
    expect(diagnosticBundle).toMatchObject({
      evidenceRequirement: {
        minimumEvidenceLevel: 'comparative',
        plannedComparisons: 1,
        comparableComparisons: 0,
        satisfied: false,
      },
      processManagement: {
        mode: 'observed',
        descendantCleanupGuaranteed: false,
        limitation: 'Provider process cleanup could not be verified.',
      },
      aggregate: { runs: 1, processFailed: 1 },
    })
    expect(diagnosticBundle.runs[0].grading).toBeNull()

    delete plan.minimumEvidenceLevel
    plan.configurations = [{ id: 'current', skillMode: 'with-skill', comparisonId: null, env: {} }]

    await writeFile(planPath, JSON.stringify(plan))
    let executedCleanupCalls = 0
    const executedDiagnostic = await runExecutionPlan(planPath, {
      processHooks: {
        terminateProcessTree: async () => {
          executedCleanupCalls += 1
          if (executedCleanupCalls > 1) throw new Error('executed cleanup fixture failure')
          return { confirmed: true }
        },
      },
    })
    expect(executedDiagnostic).toMatchObject({ evidenceLevel: 'executed', requirementsMet: false })
    await expect(readFile(executedDiagnostic.bundlePath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      evidenceRequirement: {
        minimumEvidenceLevel: 'executed',
        satisfied: false,
      },
      processManagement: {
        mode: 'observed',
        descendantCleanupGuaranteed: false,
        limitation: 'Provider process cleanup could not be verified.',
      },
    })

    plan.provider.command = [
      process.execPath,
      '-e',
      `process.stdout.write(JSON.stringify({schemaVersion:1,provider:{id:${JSON.stringify(capabilities.provider)},version:${JSON.stringify(capabilities.providerVersion)}},usage:{engine:"core"},grading:null,artifacts:[]}))`,
    ]
    await writeFile(planPath, JSON.stringify(plan))
    let forgedRunnerCalled = false
    const coreResult = await runExecutionPlan(planPath, {
      processRunner: async () => {
        forgedRunnerCalled = true
        throw new Error('forged runner must not execute')
      },
    } as unknown as Parameters<typeof runExecutionPlanWithoutContainment>[1])
    const coreBundle = JSON.parse(await readFile(coreResult.bundlePath, 'utf8'))
    expect(forgedRunnerCalled).toBe(false)
    expect(coreBundle.runs[0].usage).toEqual({ engine: 'core' })

    const outputRoot = path.join(root, 'output')
    const preservedBundle = 'preserve prior bundle\n'
    const expectOutputInputRejected = async (
      candidatePlan: typeof plan,
      errorFragment: string,
      candidatePlanPath: string = planPath,
    ): Promise<void> => {
      await writeFile(candidatePlanPath, JSON.stringify(candidatePlan))
      const candidateOutputRoot = path.resolve(path.dirname(candidatePlanPath), candidatePlan.outputRoot)
      await mkdir(candidateOutputRoot, { recursive: true })
      const candidateBundlePath = path.join(candidateOutputRoot, 'eval-run-bundle.json')
      await writeFile(candidateBundlePath, preservedBundle)
      const validation = await validateExecutionPlan(candidatePlanPath)
      expect(validation.valid).toBe(false)
      expect(validation.errors.some((entry) => entry.includes(errorFragment))).toBe(true)
      await expect(runExecutionPlan(candidatePlanPath)).rejects.toThrow(errorFragment)
      await expect(readFile(candidateBundlePath, 'utf8')).resolves.toBe(preservedBundle)
    }

    const outputCasePath = path.join(outputRoot, 'case-1', 'current', '1', 'case.json')
    const outputCaseBefore = await readFile(outputCasePath, 'utf8')
    await expectOutputInputRejected({
      ...plan,
      cases: {
        ...plan.cases,
        paths: ['output/case-1/current/1/case.json'],
      },
    }, 'case path must not be inside outputRoot')
    await expect(readFile(outputCasePath, 'utf8')).resolves.toBe(outputCaseBefore)

    const outputCapabilitiesPath = path.join(outputRoot, 'bound-capabilities.json')
    await writeFile(outputCapabilitiesPath, capabilitiesRaw)
    await expectOutputInputRejected({
      ...plan,
      provider: { ...plan.provider, capabilitiesPath: 'output/bound-capabilities.json' },
    }, 'capabilities path must not be inside outputRoot')
    await expect(readFile(outputCapabilitiesPath, 'utf8')).resolves.toBe(capabilitiesRaw)

    const outputSkill = path.join(outputRoot, 'bound-skill')
    await mkdir(outputSkill, { recursive: true })
    await writeFile(path.join(outputSkill, 'SKILL.md'), 'bound\n')
    const outputSkillDigest = await computeSkillDigest(outputSkill)
    await expectOutputInputRejected({
      ...plan,
      target: { ...plan.target, path: 'output/bound-skill', digest: outputSkillDigest },
    }, 'outputRoot must not overlap the target Skill tree')
    await expect(readFile(path.join(outputSkill, 'SKILL.md'), 'utf8')).resolves.toBe('bound\n')

    await expectOutputInputRejected({
      ...plan,
      configurations: [{
        id: 'previous',
        skillMode: 'previous-version',
        comparisonId: null,
        skillPath: 'output/bound-skill',
        skillDigest: outputSkillDigest,
        env: {},
      }],
    }, 'previous-version path overlaps outputRoot')
    await expect(readFile(path.join(outputSkill, 'SKILL.md'), 'utf8')).resolves.toBe('bound\n')

    const nestedPlanDirectory = path.join(outputRoot, 'config')
    const nestedPlanPath = path.join(nestedPlanDirectory, 'plan.json')
    await mkdir(nestedPlanDirectory, { recursive: true })
    await expectOutputInputRejected({
      ...plan,
      target: { ...plan.target, path: '../../skill' },
      cases: { ...plan.cases, paths: ['../../cases.json'] },
      provider: {
        ...plan.provider,
        capabilitiesPath: '../../capabilities.json',
      },
      outputRoot: '.',
    }, 'execution plan must not be inside outputRoot', nestedPlanPath)
    await expect(readFile(nestedPlanPath, 'utf8')).resolves.toBeTruthy()
    await writeFile(planPath, JSON.stringify(plan))

    const windowsCapabilitiesRaw = JSON.stringify(getRuntimeCapabilities('aix'))
    await writeFile(capabilitiesPath, windowsCapabilitiesRaw)
    plan.provider.capabilitiesDigest = digest(windowsCapabilitiesRaw)
    await writeFile(planPath, JSON.stringify(plan))
    const unsupportedPlan = await validateExecutionPlan(planPath)
    expect(unsupportedPlan.valid).toBe(false)
    expect(unsupportedPlan.errors).toContain('provider does not support with-skill execution')
    await expect(runExecutionPlan(planPath)).rejects.toThrow(
      'provider does not support with-skill execution',
    )
    await writeFile(capabilitiesPath, capabilitiesRaw)
    plan.provider.capabilitiesDigest = digest(capabilitiesRaw)
    await writeFile(planPath, JSON.stringify(plan))

    const victimPath = path.join(root, 'grading-victim.json')
    await writeFile(victimPath, 'do not replace\n')
    const maliciousGradingSetups = [
      `require('node:fs').symlinkSync(${JSON.stringify(victimPath)}, require('node:path').join(process.env.AGENT_EVAL_OUTPUT_DIR, 'grading.json'))`,
      `require('node:fs').linkSync(${JSON.stringify(victimPath)}, require('node:path').join(process.env.AGENT_EVAL_OUTPUT_DIR, 'grading.json'))`,
      `require('node:fs').writeFileSync(require('node:path').join(process.env.AGENT_EVAL_OUTPUT_DIR, 'grading.json'), 'provider file')`,
      `require('node:fs').mkdirSync(require('node:path').join(process.env.AGENT_EVAL_OUTPUT_DIR, 'grading.json'))`,
    ]
    for (const setup of maliciousGradingSetups) {
      plan.provider.command = [
        process.execPath,
        '-e',
        `${setup}; process.stdout.write(JSON.stringify({schemaVersion:1,provider:{id:${JSON.stringify(capabilities.provider)},version:${JSON.stringify(capabilities.providerVersion)}},usage:null,grading:{grader:{id:"fixture",version:"1"},result:{pass:true}},artifacts:[]}))`,
      ]
      await writeFile(planPath, JSON.stringify(plan))
      await expect(runExecutionPlan(planPath)).rejects.toThrow('Cannot commit runner-owned grading evidence')
      await expect(readFile(path.join(root, 'output', 'eval-run-bundle.json'))).rejects.toThrow()
      await expect(readFile(victimPath, 'utf8')).resolves.toBe('do not replace\n')
    }

    const processEvidenceSetups = [
      (targetPath: string) => `require('node:fs').symlinkSync(${JSON.stringify(victimPath)}, ${targetPath})`,
      (targetPath: string) => `require('node:fs').linkSync(${JSON.stringify(victimPath)}, ${targetPath})`,
      (targetPath: string) => `require('node:fs').writeFileSync(${targetPath}, 'provider file')`,
      (targetPath: string) => `require('node:fs').mkdirSync(${targetPath})`,
    ]
    for (const evidenceName of ['stdout.txt', 'stderr.txt']) {
      for (const setup of processEvidenceSetups) {
        const targetExpression = `require('node:path').join(process.env.AGENT_EVAL_OUTPUT_DIR, ${JSON.stringify(evidenceName)})`
        plan.provider.command = [
          process.execPath,
          '-e',
          `${setup(targetExpression)}; process.stdout.write(JSON.stringify({usage:{tokens:1}}))`,
        ]
        await writeFile(planPath, JSON.stringify(plan))
        await expect(runExecutionPlan(planPath)).rejects.toThrow('Cannot commit runner-owned process evidence')
        await expect(readFile(path.join(root, 'output', 'eval-run-bundle.json'))).rejects.toThrow()
        await expect(readFile(victimPath, 'utf8')).resolves.toBe('do not replace\n')
      }
    }

    plan.provider.command = [process.execPath, '-e', 'process.stdout.write(JSON.stringify({usage:{tokens:1}}))']
    await writeFile(planPath, JSON.stringify(plan))
    await expect(runExecutionPlan(planPath, {
      beforeBundleCommit: async () => writeFile(casePath, `${JSON.stringify(cases)} `),
    })).rejects.toThrow('Bound Eval input changed during execution: case corpus file 1')
    await expect(readFile(path.join(root, 'output', 'eval-run-bundle.json'))).rejects.toThrow()
    await writeFile(casePath, JSON.stringify(cases))
    const skillPath = path.join(skill, 'SKILL.md')
    await expect(runExecutionPlan(planPath, {
      beforeBundleCommit: async () => writeFile(skillPath, 'changed in commit seam\n'),
    })).rejects.toThrow('Bound Eval input changed during execution: target Skill')
    await expect(readFile(path.join(root, 'output', 'eval-run-bundle.json'))).rejects.toThrow()
    await writeFile(skillPath, 'runtime\n')

    await writeFile(planPath, JSON.stringify({
      ...plan,
      provider: { ...plan.provider, containment: 'unmanaged-confirmed' },
    }))
    const unmanagedPlan = await validateExecutionPlan(planPath)
    expect(unmanagedPlan.valid).toBe(false)
    expect(unmanagedPlan.errors.some((entry) => entry.includes('containment'))).toBe(true)
    await writeFile(planPath, JSON.stringify(plan))

    plan.provider.command = [
      process.execPath,
      '-e',
      `process.stdout.write(JSON.stringify({schemaVersion:1,provider:{id:${JSON.stringify(capabilities.provider)},version:${JSON.stringify(capabilities.providerVersion)}},usage:{tokens:1},grading:null,artifacts:[]}))`,
    ]
    const validPlanRaw = JSON.stringify(plan)
    const invalidBeforeExecution = [
      {
        filePath: casePath,
        invalid: '{',
        restore: JSON.stringify(cases),
      },
      {
        filePath: capabilitiesPath,
        invalid: JSON.stringify({ ...capabilities, schemaVersion: 99 }),
        restore: capabilitiesRaw,
      },
      {
        filePath: planPath,
        invalid: JSON.stringify({ ...plan, runsPerCase: 0 }),
        restore: validPlanRaw,
      },
    ]
    for (let index = 0; index < invalidBeforeExecution.length; index += 1) {
      const invalid = invalidBeforeExecution[index]
      let priorBundle: string | null = null
      if (index > 0) {
        await writeFile(planPath, validPlanRaw)
        const prior = await runExecutionPlan(planPath)
        priorBundle = await readFile(prior.bundlePath, 'utf8')
      }
      await writeFile(invalid.filePath, invalid.invalid)
      await expect(runExecutionPlan(planPath)).rejects.toThrow()
      if (priorBundle === null)
        await expect(readFile(path.join(root, 'output', 'eval-run-bundle.json'))).rejects.toThrow()
      else
        await expect(readFile(path.join(root, 'output', 'eval-run-bundle.json'), 'utf8')).resolves.toBe(priorBundle)
      await writeFile(invalid.filePath, invalid.restore)
    }
    await writeFile(planPath, validPlanRaw)

    const mutationTargets = [
      { label: 'case corpus file 1', filePath: casePath },
      { label: 'provider capabilities', filePath: capabilitiesPath },
      { label: 'execution plan', filePath: planPath },
    ]
    for (const target of mutationTargets) {
      plan.configurations = [{ id: 'current', skillMode: 'with-skill', comparisonId: null, env: {} }]
      plan.provider.command = [
        process.execPath,
        '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(target.filePath)}, ' ')`,
      ]
      await writeFile(planPath, JSON.stringify(plan))
      const before = await readFile(target.filePath)
      await expect(runExecutionPlan(planPath)).rejects.toThrow(`Bound Eval input changed during execution: ${target.label}`)
      await expect(readFile(path.join(root, 'output', 'eval-run-bundle.json'))).rejects.toThrow()
      await writeFile(target.filePath, before)
    }

    const currentSkillPath = path.join(skill, 'SKILL.md')
    plan.configurations = [{ id: 'current', skillMode: 'with-skill', comparisonId: null, env: {} }]
    plan.provider.command = [
      process.execPath,
      '-e',
      `require('node:fs').appendFileSync(${JSON.stringify(currentSkillPath)}, 'changed')`,
    ]
    await writeFile(planPath, JSON.stringify(plan))
    await expect(runExecutionPlan(planPath)).rejects.toThrow('Bound Eval input changed during execution: target Skill')
    await expect(readFile(path.join(root, 'output', 'eval-run-bundle.json'))).rejects.toThrow()
    await writeFile(currentSkillPath, 'runtime\n')

    const previous = path.join(root, 'previous')
    await mkdir(previous)
    const previousSkillPath = path.join(previous, 'SKILL.md')
    await writeFile(previousSkillPath, 'previous\n')
    const previousDigest = await computeSkillDigest(previous)
    plan.configurations = [{
      id: 'previous',
      skillMode: 'previous-version',
      comparisonId: null,
      skillPath: 'previous',
      skillDigest: previousDigest,
      env: {},
    }]
    plan.provider.command = [
      process.execPath,
      '-e',
      `require('node:fs').appendFileSync(${JSON.stringify(previousSkillPath)}, 'changed')`,
    ]
    await writeFile(planPath, JSON.stringify(plan))
    await expect(runExecutionPlan(planPath)).rejects.toThrow('Bound Eval input changed during execution: previous Skill')
    await expect(readFile(path.join(root, 'output', 'eval-run-bundle.json'))).rejects.toThrow()
    await writeFile(previousSkillPath, 'previous\n')


    plan.provider.command = [process.execPath, '-e', 'process.stdout.write(JSON.stringify({usage:{tokens:1}}))']
    await writeFile(planPath, JSON.stringify(plan))

    const outside = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-outside-'))
    await writeFile(path.join(outside, 'marker.txt'), 'keep\n')
    await rm(path.join(root, 'output'), { recursive: true })
    await symlink(outside, path.join(root, 'output'))
    const unsafe = await validateExecutionPlan(planPath)
    expect(unsafe.valid).toBe(false)
    expect(unsafe.errors.some((entry) => entry.includes('outputRoot is unavailable or unsafe'))).toBe(true)
    await expect(runExecutionPlan(planPath)).rejects.toThrow('outputRoot is unavailable or unsafe')
    await expect(readFile(path.join(outside, 'marker.txt'), 'utf8')).resolves.toBe('keep\n')
  })
})
