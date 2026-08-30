import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  computeSkillDigest,
  getSchema,
  runExecutionPlan,
  validateAuditResult,
  validateExecutionPlan,
  validateProviderCapabilities,
  validateProviderOutput,
  validateRunBundle,
} from '../../dist/index.js'

const execFileAsync = promisify(execFile)

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

const processHooks = {
  externalContainment: {
    confirmed: true,
    descendantCleanupGuaranteed: true,
    readOnlySkillSnapshotGuaranteed: true,
  } as const,
  terminateProcessTree: async ({ pid }: { pid: number }) => {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL')
    } catch {
      // The provider can already be closed.
    }
    return { confirmed: true as const }
  },
}

interface Fixture {
  root: string
  planPath: string
  auditPath: string
  capabilities: Record<string, unknown>
  plan: Record<string, any>
  describeMarker: string
  runMarker: string
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-v4-'))
  const skill = path.join(root, 'skill')
  await mkdir(skill)
  await writeFile(path.join(skill, 'SKILL.md'), 'runtime\n')
  const targetDigest = await computeSkillDigest(skill)
  const cases = [{ id: 'case-1', prompt: 'hello' }]
  const casesRaw = JSON.stringify(cases)
  await writeFile(path.join(root, 'cases.json'), casesRaw)
  const capabilities = {
    schemaVersion: 2,
    provider: 'fixture-provider',
    providerVersion: '1.0.0',
    capabilities: {
      triggerDiscovery: true,
      conversation: true,
      skillPathExecution: true,
      previousVersionBaseline: true,
      withoutSkillBaseline: true,
      cleanContext: true,
      parallelRuns: false,
      toolTrace: false,
      tokenUsage: true,
      duration: true,
      sandbox: false,
      materialization: true,
    },
    limitations: [],
  }
  const capabilitiesRaw = `${JSON.stringify(capabilities, null, 2)}\n`
  await writeFile(path.join(root, 'capabilities.json'), capabilitiesRaw)
  const describeMarker = path.join(root, 'describe.marker')
  const runMarker = path.join(root, 'run.marker')
  const providerOutput = {
    schemaVersion: 1,
    provider: { id: 'fixture-provider', version: '1.0.0' },
    usage: { tokens: 1 },
    grading: null,
    artifacts: [],
  }
  const plan = {
    schemaVersion: 4,
    planId: 'plan-1',
    target: { name: 'fixture', path: 'skill', digest: targetDigest },
    cases: { paths: ['cases.json'], corpusDigest: digest(casesRaw) },
    provider: {
      id: 'fixture-provider',
      command: [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(runMarker)}, 'run'); process.stdout.write(${JSON.stringify(JSON.stringify(providerOutput))})`,
      ],
      describeCommand: [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(describeMarker)}, 'describe'); process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(path.join(root, 'capabilities.json'))}, 'utf8'))`,
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
  }
  const planPath = path.join(root, 'plan.json')
  await writeFile(planPath, JSON.stringify(plan))
  const audit = {
    schemaVersion: 3,
    producer: 'audit-agent-skill-evals',
    independentContext: true,
    auditId: 'audit-1',
    mode: 'preflight',
    targetSkillDigest: targetDigest,
    caseCorpusDigest: digest(casesRaw),
    runBundleDigest: null,
    validity: 'pass',
    optimizationPolicy: 'balanced',
    cases: [{
      caseId: 'case-1',
      releaseRelevant: true,
      admission: 'pass',
      oracleConfidence: 'high',
      findings: [],
    }],
    blockedCases: [],
    releaseEligible: false,
    failureTriage: [],
    recommendedAction: 'collect-more-data',
  }
  const auditPath = path.join(root, 'audit.json')
  await writeFile(auditPath, JSON.stringify(audit))
  return { root, planPath, auditPath, capabilities, plan, describeMarker, runMarker }
}

describe('stage 1 execution contracts', () => {
  it('packs the current canonical schemas from a fresh package build', async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const destination = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-pack-'))
    try {
      await execFileAsync('pnpm', [
        '--config.ignore-scripts=true',
        'pack',
        '--pack-destination',
        destination,
      ], { cwd: packageRoot })
      const tarball = (await readdir(destination)).find((entry) => entry.endsWith('.tgz'))
      expect(tarball).toBeDefined()
      const schemaRelative = 'dist/schemas/eval-run-bundle.schema.json'
      const { stdout } = await execFileAsync('tar', [
        '-xOf',
        path.join(destination, tarball!),
        `package/${schemaRelative}`,
      ], { encoding: 'utf8' })
      await expect(readFile(path.join(packageRoot, 'schemas/eval-run-bundle.schema.json'), 'utf8'))
        .resolves.toBe(stdout)
    } finally {
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('publishes only the current Plan, Bundle, Audit, provider capabilities, and provider output schemas', async () => {
    await expect(getSchema('aw-skill-eval-execution-plan')).resolves.toMatchObject({
      properties: { schemaVersion: { const: 4 } },
    })
    await expect(getSchema('eval-run-bundle')).resolves.toMatchObject({
      properties: { schemaVersion: { const: 4 } },
    })
    await expect(getSchema('eval-audit-result')).resolves.toMatchObject({
      properties: { schemaVersion: { const: 3 } },
    })
    await expect(getSchema('eval-provider-capabilities')).resolves.toMatchObject({
      properties: { schemaVersion: { const: 2 } },
    })
    await expect(getSchema('eval-provider-output')).resolves.toMatchObject({
      properties: { schemaVersion: { const: 1 } },
    })
    await expect(validateProviderCapabilities({ schemaVersion: 1 })).resolves.toMatchObject({ valid: false })
    await expect(validateProviderOutput({ schemaVersion: 0 })).resolves.toMatchObject({ valid: false })
    await expect(validateAuditResult({
      schemaVersion: 3,
      producer: 'audit-agent-skill-evals',
      independentContext: true,
      auditId: 'invalid-preflight',
      mode: 'preflight',
      targetSkillDigest: digest('skill'),
      caseCorpusDigest: digest('cases'),
      runBundleDigest: digest('bundle'),
      validity: 'pass',
      optimizationPolicy: 'balanced',
      cases: [],
      blockedCases: [],
      releaseEligible: false,
      failureTriage: [],
      recommendedAction: 'collect-more-data',
    })).resolves.toMatchObject({ valid: false })
  })

  it('blocks before describe and output creation when Audit admission is absent or invalid', async () => {
    const fixture = await createFixture()
    try {
      await expect(runExecutionPlan(fixture.planPath, {
        auditPaths: [],
        processHooks,
      })).rejects.toThrow('at least one preflight Audit')
      await expect(stat(fixture.describeMarker)).rejects.toThrow()
      await expect(stat(fixture.runMarker)).rejects.toThrow()
      await expect(stat(path.join(fixture.root, 'output'))).rejects.toThrow()

      const audit = JSON.parse(await readFile(fixture.auditPath, 'utf8'))
      audit.cases[0].admission = 'fail'
      await writeFile(fixture.auditPath, JSON.stringify(audit))
      await expect(runExecutionPlan(fixture.planPath, {
        auditPaths: [fixture.auditPath],
        processHooks,
      })).rejects.toThrow('passing Audit admission')
      await expect(stat(fixture.describeMarker)).rejects.toThrow()
      await expect(stat(fixture.runMarker)).rejects.toThrow()
      await expect(stat(path.join(fixture.root, 'output'))).rejects.toThrow()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('describes the provider once after Audit and binds v4 output to provider capabilities', async () => {
    const fixture = await createFixture()
    try {
      const result = await runExecutionPlan(fixture.planPath, {
        auditPaths: [fixture.auditPath],
        processHooks,
      })
      const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'))
      expect(bundle).toMatchObject({
        schemaVersion: 4,
        provider: { id: 'fixture-provider', version: '1.0.0' },
        providerCapabilitiesDigest: fixture.plan.provider.capabilitiesDigest,
        runtimeInputs: [],
        aggregate: { runs: 1, completed: 1 },
      })
      await expect(readFile(fixture.describeMarker, 'utf8')).resolves.toBe('describe')
      await expect(readFile(fixture.runMarker, 'utf8')).resolves.toBe('run')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('returns self-validating diagnostic Bundles for provider failure and timeout', async () => {
    const scenarios = [
      {
        name: 'process failure',
        command: `process.stderr.write('provider failed'); process.exit(7)`,
        expected: { status: 'process-failed', exitCode: 7, stderr: 'provider failed' },
      },
      {
        name: 'timeout',
        command: `setInterval(() => {}, 10_000)`,
        expected: { status: 'timeout', exitCode: null, stderr: '' },
      },
    ]
    for (const scenario of scenarios) {
      const fixture = await createFixture()
      try {
        fixture.plan.provider.command = [process.execPath, '-e', scenario.command]
        await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
        const result = await runExecutionPlan(fixture.planPath, {
          auditPaths: [fixture.auditPath],
          processHooks,
        })
        const outputRoot = path.dirname(result.bundlePath)
        await expect(validateRunBundle(result.bundlePath, {
          providerCapabilitiesPath: path.join(fixture.root, 'capabilities.json'),
        })).resolves.toMatchObject({ valid: true })
        const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'))
        expect(result.requirementsMet, scenario.name).toBe(false)
        expect(bundle.evidenceRequirement.satisfied, scenario.name).toBe(false)
        expect(bundle.runs[0], scenario.name).toMatchObject({
          status: scenario.expected.status,
          exitCode: scenario.expected.exitCode,
          usage: null,
          grading: null,
          artifacts: [],
        })
        const stdout = await readFile(path.join(outputRoot, bundle.runs[0].stdoutPath))
        const stderr = await readFile(path.join(outputRoot, bundle.runs[0].stderrPath))
        expect(stdout.toString('utf8'), scenario.name).toBe('')
        expect(stderr.toString('utf8'), scenario.name).toBe(scenario.expected.stderr)
        expect(bundle.runs[0].stdoutDigest, scenario.name).toBe(digest(stdout))
        expect(bundle.runs[0].stderrDigest, scenario.name).toBe(digest(stderr))
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    }
  })

  it('uses failure status before valid provider output and marks invalid completed output as an error', async () => {
    const fixture = await createFixture()
    try {
      const providerOutput = {
        schemaVersion: 1,
        provider: { id: 'fixture-provider', version: '1.0.0' },
        usage: { tokens: 99 },
        grading: { grader: { id: 'fixture', version: '1' }, result: { pass: true } },
        artifacts: [{ path: 'provider.txt', role: 'output' }],
      }
      fixture.plan.provider.command = [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(require('node:path').join(process.env.AGENT_EVAL_OUTPUT_DIR, 'provider.txt'), 'ignored'); process.stdout.write(${JSON.stringify(JSON.stringify(providerOutput))}); process.exit(7)`,
      ]
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      const failed = await runExecutionPlan(fixture.planPath, {
        auditPaths: [fixture.auditPath],
        processHooks,
      })
      await expect(readFile(failed.bundlePath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
        runs: [{ status: 'process-failed', usage: null, grading: null, artifacts: [] }],
        evidenceRequirement: { satisfied: false },
      })

      fixture.plan.provider.command = [process.execPath, '-e', `process.stdout.write('not JSON')`]
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      const invalid = await runExecutionPlan(fixture.planPath, {
        auditPaths: [fixture.auditPath],
        processHooks,
      })
      const invalidBundle = JSON.parse(await readFile(invalid.bundlePath, 'utf8'))
      expect(invalidBundle.runs[0]).toMatchObject({ status: 'error', usage: null, grading: null, artifacts: [] })
      await expect(readFile(path.join(path.dirname(invalid.bundlePath), invalidBundle.runs[0].stderrPath), 'utf8'))
        .resolves.toContain('Provider JSON/artifact error:')
      await expect(validateRunBundle(invalid.bundlePath, {
        providerCapabilitiesPath: path.join(fixture.root, 'capabilities.json'),
      })).resolves.toMatchObject({ valid: true })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('resolves only allowlisted provider credentials at execution time', async () => {
    const fixture = await createFixture()
    try {
      const secret = 'provider-secret-"slash\\line\nnext-must-not-be-evidence'
      let secretReads = 0
      const sourceEnv = new Proxy({
        PATH: process.env.PATH,
        CUSTOM_PROVIDER_TOKEN: secret,
        UNRELATED_PROVIDER_TOKEN: 'unrelated-secret',
      }, {
        get(target, property, receiver) {
          if (property === 'CUSTOM_PROVIDER_TOKEN') secretReads += 1
          return Reflect.get(target, property, receiver)
        },
      })
      fixture.plan.provider.environmentAllowlist = ['CUSTOM_PROVIDER_TOKEN']
      fixture.plan.provider.describeCommand = [
        process.execPath,
        '-e',
        [
          `if (process.env.CUSTOM_PROVIDER_TOKEN) process.exit(8)`,
          `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(path.join(fixture.root, 'capabilities.json'))}, 'utf8'))`,
        ].join(';'),
      ]
      fixture.plan.provider.command = [
        process.execPath,
        '-e',
        [
          `const fs = require('node:fs')`,
          `const path = require('node:path')`,
          `const secret = process.env.CUSTOM_PROVIDER_TOKEN`,
          `if (!process.env.CUSTOM_PROVIDER_TOKEN) process.exit(9)`,
          `if (process.env.UNRELATED_PROVIDER_TOKEN) process.exit(10)`,
          `fs.writeFileSync(path.join(process.env.AGENT_EVAL_OUTPUT_DIR, 'provider-artifact.txt'), 'artifact=' + secret)`,
          `process.stderr.write('stderr=' + secret)`,
          `process.stdout.write(JSON.stringify({schemaVersion:1,provider:{id:'fixture-provider',version:'1.0.0'},usage:{credentialAvailable:true,echo:secret},grading:{grader:{id:'fixture',version:'1'},result:{echo:secret}},artifacts:[{path:'provider-artifact.txt',role:'report'}]}))`,
        ].join(';'),
      ]
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      expect(await readFile(fixture.planPath, 'utf8')).not.toContain(secret)

      await expect(runExecutionPlan(fixture.planPath, {
        auditPaths: [],
        processHooks,
        sourceEnv,
      })).rejects.toThrow('at least one preflight Audit')
      expect(secretReads).toBe(0)

      const result = await runExecutionPlan(fixture.planPath, {
        auditPaths: [fixture.auditPath],
        processHooks,
        sourceEnv,
      })
      const bundle = await readFile(result.bundlePath, 'utf8')
      expect(bundle).not.toContain(secret)
      expect(bundle).not.toContain('unrelated-secret')
      expect(JSON.parse(bundle)).toMatchObject({
        runs: [{
          usage: { credentialAvailable: true, echo: '[REDACTED]' },
          grading: {
            grader: { id: 'fixture', version: '1' },
            result: { echo: '[REDACTED]' },
          },
        }],
      })
      const outputRoot = path.join(fixture.root, 'output')
      const evidenceFiles: string[] = []
      const visit = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const target = path.join(directory, entry.name)
          if (entry.isDirectory()) await visit(target)
          if (entry.isFile()) evidenceFiles.push(target)
        }
      }
      await visit(outputRoot)
      for (const evidencePath of evidenceFiles) {
        const bytes = await readFile(evidencePath)
        expect(bytes.includes(Buffer.from(secret)), evidencePath).toBe(false)
        expect(bytes.includes(Buffer.from(JSON.stringify(secret).slice(1, -1))), evidencePath).toBe(false)
      }
      const runRoot = path.join(outputRoot, 'case-1', 'current', '1')
      await expect(readFile(path.join(runRoot, 'provider-artifact.txt'), 'utf8'))
        .resolves.toBe('artifact=[REDACTED]')
      await expect(readFile(path.join(runRoot, 'stderr.txt'), 'utf8'))
        .resolves.toBe('stderr=[REDACTED]')
      await expect(readFile(path.join(runRoot, 'stdout.txt'), 'utf8').then(JSON.parse))
        .resolves.toMatchObject({ usage: { echo: '[REDACTED]' } })

      fixture.plan.provider.environmentAllowlist = ['INVALID-NAME']
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      await expect(validateExecutionPlan(fixture.planPath)).resolves.toMatchObject({
        valid: false,
        errors: expect.arrayContaining([
          expect.stringContaining('environmentAllowlist'),
        ]),
      })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('requires one non-duplicate Audit for each distinct current and previous Skill digest', async () => {
    const fixture = await createFixture()
    try {
      const previous = path.join(fixture.root, 'previous')
      await mkdir(previous)
      await writeFile(path.join(previous, 'SKILL.md'), 'previous\n')
      const previousDigest = await computeSkillDigest(previous)
      fixture.plan.configurations = [
        ...fixture.plan.configurations,
        {
          id: 'previous',
          skillMode: 'previous-version',
          comparisonId: null,
          skillPath: 'previous',
          skillDigest: previousDigest,
          env: {},
        },
      ]
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      const previousAuditPath = path.join(fixture.root, 'previous-audit.json')
      const previousAudit = JSON.parse(await readFile(fixture.auditPath, 'utf8'))
      previousAudit.auditId = 'previous-audit'
      previousAudit.targetSkillDigest = previousDigest
      await writeFile(previousAuditPath, JSON.stringify(previousAudit))

      await expect(runExecutionPlan(fixture.planPath, {
        auditPaths: [fixture.auditPath],
        processHooks,
      })).rejects.toThrow('has no independent passing preflight Audit')
      await expect(runExecutionPlan(fixture.planPath, {
        auditPaths: [fixture.auditPath, fixture.auditPath, previousAuditPath],
        processHooks,
      })).rejects.toThrow('Duplicate or conflicting Audit binding')
      await expect(stat(fixture.describeMarker)).rejects.toThrow()
      await expect(stat(fixture.runMarker)).rejects.toThrow()
      await expect(stat(path.join(fixture.root, 'output'))).rejects.toThrow()

      const result = await runExecutionPlan(fixture.planPath, {
        auditPaths: [fixture.auditPath, previousAuditPath],
        processHooks,
      })
      await expect(readFile(result.bundlePath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
        aggregate: { runs: 2, completed: 2 },
      })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a describe identity mismatch before output creation or provider run', async () => {
    const fixture = await createFixture()
    try {
      fixture.plan.provider.describeCommand = [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(fixture.describeMarker)}, 'describe'); process.stdout.write(${JSON.stringify(JSON.stringify({
          ...fixture.capabilities,
          providerVersion: '2.0.0',
        }))})`,
      ]
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      await expect(runExecutionPlan(fixture.planPath, {
        auditPaths: [fixture.auditPath],
        processHooks,
      })).rejects.toThrow('describe output')
      await expect(readFile(fixture.describeMarker, 'utf8')).resolves.toBe('describe')
      await expect(stat(fixture.runMarker)).rejects.toThrow()
      await expect(stat(path.join(fixture.root, 'output'))).rejects.toThrow()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('creates one immutable runtime input snapshot per run and passes only snapshot paths', async () => {
    const fixture = await createFixture()
    try {
      const runtimeInput = path.join(fixture.root, 'workspace')
      await mkdir(runtimeInput)
      await writeFile(path.join(runtimeInput, 'value.txt'), 'source\n')
      const runtimeDigest = await computeSkillDigest(runtimeInput)
      const snapshotsPath = path.join(fixture.root, 'snapshots.txt')
      fixture.plan.runtimeInputs = [{
        id: 'workspace',
        kind: 'directory',
        path: 'workspace',
        digest: runtimeDigest,
      }]
      fixture.plan.runsPerCase = 2
      fixture.plan.provider.command = [
        process.execPath,
        '-e',
        [
          `const fs = require('node:fs')`,
          `const inputs = JSON.parse(process.env.AGENT_EVAL_RUNTIME_INPUTS_JSON)`,
          `fs.appendFileSync(${JSON.stringify(snapshotsPath)}, inputs.workspace + '\\n')`,
          `if (fs.readFileSync(require('node:path').join(inputs.workspace, 'value.txt'), 'utf8') !== 'source\\n') process.exit(8)`,
          `process.stdout.write(${JSON.stringify(JSON.stringify({
            schemaVersion: 1,
            provider: { id: 'fixture-provider', version: '1.0.0' },
            usage: null,
            grading: null,
            artifacts: [],
          }))})`,
        ].join(';'),
      ]
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      const result = await runExecutionPlan(fixture.planPath, {
        auditPaths: [fixture.auditPath],
        processHooks,
      })
      const snapshots = (await readFile(snapshotsPath, 'utf8')).trim().split('\n')
      expect(new Set(snapshots).size).toBe(2)
      expect(snapshots.every((entry) => entry.includes(`${path.sep}output${path.sep}`))).toBe(true)
      await expect(readFile(path.join(runtimeInput, 'value.txt'), 'utf8')).resolves.toBe('source\n')
      await expect(readFile(result.bundlePath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
        runtimeInputs: [{ id: 'workspace', digest: runtimeDigest }],
      })

      fixture.plan.provider.command = [
        process.execPath,
        '-e',
        [
          `const inputs = JSON.parse(process.env.AGENT_EVAL_RUNTIME_INPUTS_JSON)`,
          `require('node:fs').writeFileSync(require('node:path').join(inputs.workspace, 'value.txt'), 'changed\\n')`,
          `process.stdout.write(${JSON.stringify(JSON.stringify({
            schemaVersion: 1,
            provider: { id: 'fixture-provider', version: '1.0.0' },
            usage: null,
            grading: null,
            artifacts: [],
          }))})`,
        ].join(';'),
      ]
      fixture.plan.runsPerCase = 1
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      await expect(runExecutionPlan(fixture.planPath, {
        auditPaths: [fixture.auditPath],
        processHooks,
      })).rejects.toThrow('Provider modified runtime input snapshot workspace')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('captures one canonical provider cwd and rejects symlinks or input/output overlap', async () => {
    const fixture = await createFixture()
    try {
      const providerCwd = path.join(fixture.root, 'provider-cwd')
      const workspace = path.join(fixture.root, 'workspace')
      const describeCwd = path.join(fixture.root, 'describe-cwd.txt')
      const runCwd = path.join(fixture.root, 'run-cwd.txt')
      await Promise.all([mkdir(providerCwd), mkdir(workspace)])
      await writeFile(path.join(workspace, 'input.txt'), 'input\n')
      const runtimeDigest = await computeSkillDigest(workspace)
      fixture.plan.provider.cwd = 'provider-cwd'
      fixture.plan.provider.describeCommand = [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(describeCwd)}, process.cwd()); process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(path.join(fixture.root, 'capabilities.json'))}, 'utf8'))`,
      ]
      fixture.plan.provider.command = [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(runCwd)}, process.cwd()); process.stdout.write(${JSON.stringify(JSON.stringify({
          schemaVersion: 1,
          provider: { id: 'fixture-provider', version: '1.0.0' },
          usage: null,
          grading: null,
          artifacts: [],
        }))})`,
      ]
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      await runExecutionPlan(fixture.planPath, {
        auditPaths: [fixture.auditPath],
        processHooks,
      })
      const canonicalCwd = await realpath(providerCwd)
      await expect(readFile(describeCwd, 'utf8')).resolves.toBe(canonicalCwd)
      await expect(readFile(runCwd, 'utf8')).resolves.toBe(canonicalCwd)

      fixture.plan.provider.cwd = 'skill'
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      await expect(validateExecutionPlan(fixture.planPath)).resolves.toMatchObject({ valid: false })

      const previous = path.join(fixture.root, 'previous')
      await mkdir(previous)
      await writeFile(path.join(previous, 'SKILL.md'), 'previous\n')
      fixture.plan.configurations.push({
        id: 'previous',
        skillMode: 'previous-version',
        comparisonId: null,
        skillPath: 'previous',
        skillDigest: await computeSkillDigest(previous),
        env: {},
      })
      fixture.plan.provider.cwd = 'previous'
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      const previousOverlap = await validateExecutionPlan(fixture.planPath)
      expect(previousOverlap.errors).toContain('provider cwd must not overlap previous Skill content')

      fixture.plan.runtimeInputs = [{
        id: 'workspace',
        kind: 'directory',
        path: 'workspace',
        digest: runtimeDigest,
      }]
      fixture.plan.provider.cwd = 'workspace'
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      const runtimeOverlap = await validateExecutionPlan(fixture.planPath)
      expect(runtimeOverlap.errors).toContain('provider cwd must not overlap runtime input workspace')

      fixture.plan.provider.cwd = 'output'
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      const outputOverlap = await validateExecutionPlan(fixture.planPath)
      expect(outputOverlap.errors).toContain('provider cwd must not overlap outputRoot')

      await symlink('provider-cwd', path.join(fixture.root, 'linked-cwd'))
      fixture.plan.provider.cwd = 'linked-cwd'
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      const linked = await validateExecutionPlan(fixture.planPath)
      expect(linked.errors.some((entry) => entry.includes('symlink path component'))).toBe(true)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('reparses provider stdout and rejects Bundle identity, usage, grading, or artifact tampering', async () => {
    const fixture = await createFixture()
    try {
      const providerOutput = {
        schemaVersion: 1,
        provider: { id: 'fixture-provider', version: '1.0.0' },
        usage: { tokens: 7 },
        grading: {
          grader: { id: 'fixture-grader', version: '1.0.0' },
          result: { score: 1 },
        },
        artifacts: [{ path: 'provider.txt', role: 'output' }],
      }
      fixture.plan.provider.command = [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(require('node:path').join(process.env.AGENT_EVAL_OUTPUT_DIR, 'provider.txt'), ${JSON.stringify('provider artifact\n')}); process.stdout.write(${JSON.stringify(JSON.stringify(providerOutput))})`,
      ]
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      const execution = await runExecutionPlan(fixture.planPath, {
        auditPaths: [fixture.auditPath],
        processHooks,
      })
      const outputRoot = path.dirname(execution.bundlePath)
      const capabilitiesPath = path.join(fixture.root, 'capabilities.json')
      await expect(validateRunBundle(execution.bundlePath, {
        providerCapabilitiesPath: capabilitiesPath,
      })).resolves.toMatchObject({ valid: true })
      const bundle = JSON.parse(await readFile(execution.bundlePath, 'utf8'))
      const mutations: Array<[string, (value: Record<string, any>) => void, string]> = [
        ['provider', (value) => { value.provider.version = '2.0.0' }, 'ProviderOutput provider'],
        ['capabilities', (value) => { value.providerCapabilitiesDigest = digest('changed capabilities') }, 'capabilities evidence'],
        ['usage', (value) => { value.runs[0].usage.tokens = 99 }, 'ProviderOutput usage'],
        ['grading', (value) => { value.runs[0].grading.result.score = 0 }, 'accepted grading'],
        ['artifact', (value) => {
          value.runs[0].artifacts.find((entry: { role: string }) => entry.role !== 'grading').role = 'report'
        }, 'provider-declared bundle artifacts'],
      ]
      for (const [name, mutate, expectedError] of mutations) {
        const changed = structuredClone(bundle)
        mutate(changed)
        const changedPath = path.join(fixture.root, `${name}-tampered.json`)
        await writeFile(changedPath, JSON.stringify(changed))
        const validation = await validateRunBundle(changedPath, {
          evidenceRoot: outputRoot,
          providerCapabilitiesPath: capabilitiesPath,
        })
        expect(validation.valid).toBe(false)
        expect(validation.errors.some((entry) => entry.includes(expectedError))).toBe(true)
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects usage, grading, and provider artifacts added to a failed run', async () => {
    const fixture = await createFixture()
    try {
      fixture.plan.provider.command = [process.execPath, '-e', `process.stderr.write('failed'); process.exit(7)`]
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      const execution = await runExecutionPlan(fixture.planPath, {
        auditPaths: [fixture.auditPath],
        processHooks,
      })
      const outputRoot = path.dirname(execution.bundlePath)
      const capabilitiesPath = path.join(fixture.root, 'capabilities.json')
      const bundle = JSON.parse(await readFile(execution.bundlePath, 'utf8'))
      const mutations: Array<[string, (value: Record<string, any>) => void, string]> = [
        ['usage', (value) => { value.runs[0].usage = { tokens: 7 } }, 'failed run must have usage=null'],
        ['grading', (value) => {
          value.runs[0].grading = { grader: { id: 'fixture', version: '1' }, result: { pass: true } }
        }, 'failed run must have grading=null'],
        ['artifact', (value) => {
          value.runs[0].artifacts = [{
            role: 'output',
            path: value.runs[0].stdoutPath,
            digest: value.runs[0].stdoutDigest,
          }]
        }, 'failed run must not declare provider artifacts'],
      ]
      for (const [name, mutate, expectedError] of mutations) {
        const changed = structuredClone(bundle)
        mutate(changed)
        const changedPath = path.join(fixture.root, `failed-${name}-tampered.json`)
        await writeFile(changedPath, JSON.stringify(changed))
        const validation = await validateRunBundle(changedPath, {
          evidenceRoot: outputRoot,
          providerCapabilitiesPath: capabilitiesPath,
        })
        expect(validation.valid).toBe(false)
        expect(validation.errors.some((entry) => entry.includes(expectedError))).toBe(true)
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects v3 Plans and runtime inputs that leave the Plan directory', async () => {
    const fixture = await createFixture()
    const outside = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-v4-outside-'))
    try {
      fixture.plan.schemaVersion = 3
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      await expect(validateExecutionPlan(fixture.planPath)).resolves.toMatchObject({ valid: false })

      fixture.plan.schemaVersion = 4
      fixture.plan.runtimeInputs = [{
        id: 'outside',
        kind: 'directory',
        path: path.relative(fixture.root, outside),
        digest: digest('outside'),
      }]
      await writeFile(fixture.planPath, JSON.stringify(fixture.plan))
      const validation = await validateExecutionPlan(fixture.planPath)
      expect(validation.valid).toBe(false)
      expect(validation.errors.some((entry) => entry.includes('leaves the plan directory'))).toBe(true)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
