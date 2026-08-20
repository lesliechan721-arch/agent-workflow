import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  assertProviderProcessSupported,
  computeSkillDigest,
  createRuntimeSkillSnapshot,
  getRuntimeCapabilities,
  getSchema,
  getSchemaDigest,
  runExecutionPlan,
  runProviderProcess,
  validateExecutionPlan,
  validateRuntimeCapabilities,
  validateRunBundle,
} from '../../dist/index.js'

const execFileAsync = promisify(execFile)

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

describe('public Eval execution contracts', () => {
  it('prints stable command help and embedded canonical schemas', async () => {
    const bin = path.resolve('dist/bin.js')
    const help = await execFileAsync(process.execPath, [bin, '--help'], { cwd: path.resolve('.') })
    expect(help.stdout).toContain('capabilities --json')
    expect(help.stdout).toContain('bundle validate <bundle.json>')

    const printed = await execFileAsync(
      process.execPath,
      [bin, 'schema', 'print', 'eval-execution-plan'],
      { cwd: path.resolve('.') },
    )
    const schema = JSON.parse(printed.stdout)
    expect(schema).toEqual(await getSchema('eval-execution-plan'))
    expect(await getSchemaDigest('eval-execution-plan')).toBe(digest(JSON.stringify(schema)))
    await expect(validateRuntimeCapabilities(getRuntimeCapabilities())).resolves.toMatchObject({
      valid: true,
      errors: [],
      calculated: {
        schemaVersion: 1,
        provider: 'aw-skill-eval-process',
      },
    })
    await expect(validateRuntimeCapabilities({
      ...getRuntimeCapabilities(),
      schemaVersion: 2,
    })).resolves.toMatchObject({
      valid: false,
      calculated: null,
      errors: expect.arrayContaining(['$/schemaVersion: must equal 1']),
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
    await writeFile(path.join(source, 'evals', 'case.json'), '{}\n')
    const before = await computeSkillDigest(source)
    const snapshot = await createRuntimeSkillSnapshot(source, destination)
    expect(snapshot.digest).toBe(before)
    await expect(readFile(path.join(destination, 'SKILL.md'), 'utf8')).resolves.toBe('runtime\n')
    await expect(readFile(path.join(destination, 'evals', 'case.json'), 'utf8')).rejects.toThrow()
    expect(await computeSkillDigest(source)).toBe(before)
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

    assertProviderProcessSupported('linux')
    expect(() => assertProviderProcessSupported('win32')).toThrow('requires a terminateProcessTree hook')
    expect(() => assertProviderProcessSupported('win32', {
      terminateProcessTree: async () => undefined,
    })).not.toThrow()
    expect(getRuntimeCapabilities('win32').limitations).toContain(
      'Standalone Windows execution is disabled because the shared monitor cannot independently verify Windows Job Object membership. JavaScript callers can supply a terminateProcessTree hook that returns confirmed descendant-cleanup evidence.',
    )
    expect(getRuntimeCapabilities('win32').capabilities).toMatchObject({
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
      schemaVersion: 2,
      producer: 'run-agent-skill-evals',
      independentContext: false,
      provider: { id: 'fixture', version: '1' },
      planDigest: digest('plan'),
      targetSkillDigest: digest('skill'),
      caseCorpusDigest: digest('cases'),
      preflightAuditDigest: digest('audit'),
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
    const capabilities = getRuntimeCapabilities()
    const capabilitiesPath = path.join(root, 'capabilities.json')
    const capabilitiesRaw = JSON.stringify(capabilities)
    await writeFile(capabilitiesPath, capabilitiesRaw)
    const audit = {
      schemaVersion: 2,
      producer: 'audit-agent-skill-evals',
      independentContext: true,
      auditId: 'audit-1',
      mode: 'preflight',
      targetSkillDigest: targetDigest,
      caseCorpusDigest,
      validity: 'pass',
      optimizationPolicy: 'balanced',
      cases: [{ caseId: 'case-1', releaseRelevant: true, admission: 'pass', oracleConfidence: 'high', findings: [] }],
      blockedCases: [],
      releaseEligible: true,
      failureTriage: [],
      recommendedAction: 'collect-more-data',
    }
    const auditPath = path.join(root, 'audit.json')
    const auditRaw = JSON.stringify(audit)
    await writeFile(auditPath, auditRaw)
    const plan = {
      schemaVersion: 2,
      planId: 'plan-1',
      target: { name: 'fixture', path: 'skill', digest: targetDigest },
      cases: { paths: ['cases.json'], corpusDigest: caseCorpusDigest },
      audit: {
        path: 'audit.json',
        digest: digest(auditRaw),
        targetSkillDigest: targetDigest,
        caseCorpusDigest,
        validity: 'pass',
      },
      provider: {
        id: 'aw-skill-eval-process',
        command: [process.execPath, '-e', 'process.stdout.write(JSON.stringify({usage:{tokens:1,marker:process.env.AW_AGENT_SKILL_EVAL_PROCESS_MARKER},grading:{grader:{id:"fixture",version:"1"},result:{pass:true}}}))'],
        cwd: null,
        env: { AW_AGENT_SKILL_EVAL_PROCESS_MARKER: 'caller-controlled-marker' },
        capabilitiesPath: 'capabilities.json',
        capabilitiesDigest: digest(capabilitiesRaw),
        inheritEnvironment: false,
      },
      configurations: [{ id: 'current', skillMode: 'with-skill', comparisonId: null, env: {} }],
      runsPerCase: 1,
      timeoutMs: 1_000,
      outputRoot: 'output',
      capture: { outputs: true, trace: false, timing: true, usage: true },
    }
    const planPath = path.join(root, 'plan.json')
    await writeFile(planPath, JSON.stringify(plan))
    const result = await runExecutionPlan(planPath)
    expect(result.evidenceLevel).toBe('executed')
    const validated = await validateRunBundle(result.bundlePath)
    expect(validated).toMatchObject({
      valid: true,
      calculated: { bundleDigest: result.bundleDigest },
    })
    const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'))
    expect(bundle.runs[0].usage.marker).toBe('[redacted provider process marker]')
    expect(JSON.stringify(bundle)).not.toContain('caller-controlled-marker')
    expect(bundle.runs[0].artifacts).toEqual([
      expect.objectContaining({ role: 'grading', path: 'case-1/current/1/grading.json' }),
    ])
    expect(await computeSkillDigest(skill)).toBe(targetDigest)

    const windowsCapabilitiesRaw = JSON.stringify(getRuntimeCapabilities('win32'))
    await writeFile(capabilitiesPath, windowsCapabilitiesRaw)
    plan.provider.capabilitiesDigest = digest(windowsCapabilitiesRaw)
    await writeFile(planPath, JSON.stringify(plan))
    const windowsPlan = await validateExecutionPlan(planPath)
    expect(windowsPlan.valid).toBe(false)
    expect(windowsPlan.errors).toContain('provider does not support with-skill execution')
    let windowsProviderCalled = false
    await expect(runExecutionPlan(planPath, {
      processRunner: async () => {
        windowsProviderCalled = true
        throw new Error('must not execute')
      },
    })).rejects.toThrow('provider does not support with-skill execution')
    expect(windowsProviderCalled).toBe(false)
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
        `${setup}; process.stdout.write(JSON.stringify({grading:{grader:{id:"fixture",version:"1"},result:{pass:true}}}))`,
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

    const validPlanRaw = JSON.stringify(plan)
    const invalidBeforeExecution = [
      {
        filePath: casePath,
        invalid: '{',
        restore: JSON.stringify(cases),
      },
      {
        filePath: auditPath,
        invalid: JSON.stringify({ ...audit, validity: 'fail' }),
        restore: auditRaw,
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
      if (index > 0) {
        await writeFile(planPath, validPlanRaw)
        await runExecutionPlan(planPath)
      }
      await writeFile(invalid.filePath, invalid.invalid)
      await expect(runExecutionPlan(planPath)).rejects.toThrow()
      await expect(readFile(path.join(root, 'output', 'eval-run-bundle.json'))).rejects.toThrow()
      await writeFile(invalid.filePath, invalid.restore)
    }
    await writeFile(planPath, validPlanRaw)

    const mutationTargets = [
      { label: 'case corpus file 1', filePath: casePath },
      { label: 'preflight audit', filePath: auditPath },
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

    plan.configurations = [{ id: 'current', skillMode: 'with-skill', comparisonId: null, env: {} }]
    plan.provider.command = [process.execPath, '-e', 'process.stdout.write("ignored")']
    await writeFile(planPath, JSON.stringify(plan))
    const limited = await runExecutionPlan(planPath, {
      processRunner: async () => ({
        stdout: 'abcd',
        stderr: 'wxyz',
        exitCode: null,
        signal: 'SIGTERM',
        timedOut: false,
        cancelled: false,
        terminationReason: 'max-buffer',
        maxBufferExceeded: true,
        stdoutTruncated: true,
        stderrTruncated: true,
        descendantCleanupGuaranteed: true,
      }),
    })
    const limitedBundle = JSON.parse(await readFile(limited.bundlePath, 'utf8'))
    expect(limitedBundle.limitations).toContain(
      'Run case-1/current/1: Provider stdout and stderr exceeded the capture maxBuffer and was truncated.',
    )
    expect(limitedBundle.runs[0].stdoutDigest).toBe(digest('abcd'))
    const capturedStderr = await readFile(path.join(root, 'output', limitedBundle.runs[0].stderrPath), 'utf8')
    expect(capturedStderr).toContain('Provider stdout and stderr exceeded the capture maxBuffer and was truncated.')
    expect(limitedBundle.runs[0].stderrDigest).toBe(digest(capturedStderr))
    await expect(validateRunBundle(limited.bundlePath)).resolves.toMatchObject({
      valid: true,
      calculated: { bundleDigest: limited.bundleDigest },
    })

    plan.provider.command = [process.execPath, '-e', 'process.stdout.write(JSON.stringify({usage:{tokens:1}}))']
    await writeFile(planPath, JSON.stringify(plan))

    const outside = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-outside-'))
    await writeFile(path.join(outside, 'marker.txt'), 'keep\n')
    await rm(path.join(root, 'output'), { recursive: true })
    await symlink(outside, path.join(root, 'output'))
    const unsafe = await validateExecutionPlan(planPath)
    expect(unsafe.valid).toBe(false)
    expect(unsafe.errors.some((entry) => entry.includes('outputRoot is unavailable or unsafe'))).toBe(true)
    await expect(runExecutionPlan(planPath)).rejects.toThrow('outputRoot is not trustworthy')
    await expect(readFile(path.join(outside, 'marker.txt'), 'utf8')).resolves.toBe('keep\n')
  })
})
