#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  computeSkillDigest,
  getRuntimeCapabilities,
  getSchema,
  runEvalSpec,
  runExecutionPlan,
  validateEvalAuditFile,
  validateEvalResultFile,
  validateEvalSpecFile,
  validateSelectedCasesFile,
  validateAuditResult,
  validateExecutionPlan,
  validateProviderCapabilities,
  validateProviderOutput,
  validateRunBundle,
} from './index.js'
import { isSchemaName } from './schemas.js'

const help = `Usage: aw-skill-eval <command>

Commands:
  spec validate <spec.json>
  audit validate <audit.json> --spec <spec.json>
  run <spec.json> --audit <audit.json>
  result validate <result.json> --spec <spec.json> --audit <audit.json>
  inspect-result <result.json>

Transitional legacy commands:
  capabilities --json
  schema print <aw-skill-eval-execution-plan|eval-run-bundle|eval-audit-result|eval-provider-capabilities|eval-provider-output>
  plan validate <plan.json>
  run <plan.json> --audit <audit.json> [--audit <audit.json>...]
  bundle validate <bundle.json>
  audit validate <audit.json>
  provider-capabilities validate <capabilities.json>
  provider-output validate <output.json>
  digest skill <skill-dir>
`

function requirePath(value: string | undefined, usage: string): string {
  if (!value) throw new Error(usage)
  return path.resolve(value)
}

function optionPath(argv: string[], name: string, usage: string): string {
  const index = argv.indexOf(name)
  if (index < 0 || !argv[index + 1] || argv.indexOf(name, index + 1) >= 0) throw new Error(usage)
  return requirePath(argv[index + 1], usage)
}

async function boundSpec(specPath: string): Promise<{
  spec: NonNullable<Awaited<ReturnType<typeof validateEvalSpecFile>>['calculated']>
  caseIds: string[]
}> {
  const validation = await validateEvalSpecFile(specPath)
  if (!validation.valid || !validation.calculated) {
    throw new Error(`EvalSpec is invalid: ${validation.errors.join('; ')}`)
  }
  const cases = await validateSelectedCasesFile(validation.calculated.paths.cases)
  if (!cases.valid || !cases.calculated) {
    throw new Error(`Selected cases are invalid: ${cases.errors.join('; ')}`)
  }
  if (cases.calculated.suite.unitUnderTest !== validation.calculated.spec.source.skill) {
    throw new Error('Selected cases unitUnderTest does not match EvalSpec source.skill.')
  }
  return { spec: validation.calculated, caseIds: cases.calculated.cases.map((entry) => entry.id) }
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(help)
    return
  }
  const [command, action, value, ...extra] = argv
  if (command === 'spec') {
    if (action !== 'validate' || !value || extra.length > 0) {
      throw new Error('Usage: aw-skill-eval spec validate <spec.json>')
    }
    const specPath = requirePath(value, 'Usage: aw-skill-eval spec validate <spec.json>')
    const validation = await validateEvalSpecFile(specPath)
    const cases = validation.valid && validation.calculated
      ? await validateSelectedCasesFile(validation.calculated.paths.cases)
      : null
    const errors = [...validation.errors, ...(cases?.errors ?? [])]
    const unitMatches = !validation.calculated || !cases?.calculated ||
      cases.calculated.suite.unitUnderTest === validation.calculated.spec.source.skill
    if (!unitMatches) errors.push('Selected cases unitUnderTest does not match EvalSpec source.skill.')
    const result = {
      valid: errors.length === 0,
      errors,
      calculated: errors.length === 0 ? validation.calculated : null,
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.valid) process.exitCode = 1
    return
  }
  if (command === 'capabilities') {
    if (action !== '--json' || value !== undefined || extra.length > 0)
      throw new Error('Usage: aw-skill-eval capabilities --json')
    process.stdout.write(`${JSON.stringify(getRuntimeCapabilities(), null, 2)}\n`)
    return
  }
  if (command === 'schema') {
    if (extra.length > 0 || action !== 'print' || !value || !isSchemaName(value))
      throw new Error('Usage: aw-skill-eval schema print <schema-name>')
    process.stdout.write(`${JSON.stringify(await getSchema(value), null, 2)}\n`)
    return
  }
  if (command === 'plan') {
    if (extra.length > 0 || action !== 'validate') throw new Error('Usage: aw-skill-eval plan validate <plan.json>')
    const result = await validateExecutionPlan(requirePath(value, 'Usage: aw-skill-eval plan validate <plan.json>'))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.valid) process.exitCode = 1
    return
  }
  if (command === 'run') {
    const runPath = requirePath(action, 'Usage: aw-skill-eval run <spec.json> --audit <audit.json>')
    const document = JSON.parse(await readFile(runPath, 'utf8')) as Record<string, unknown>
    if (document.version === 1) {
      if (value !== '--audit' || extra.length !== 1) {
        throw new Error('Usage: aw-skill-eval run <spec.json> --audit <audit.json>')
      }
      const result = await runEvalSpec(runPath, {
        auditPath: requirePath(extra[0], '--audit requires a path'),
      })
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }
    const auditPaths: string[] = []
    for (let index = 0; index < argv.length - 2; index += 2) {
      if (argv[index + 2] !== '--audit' || !argv[index + 3])
        throw new Error('Usage: aw-skill-eval run <plan.json> --audit <audit.json> [--audit <audit.json>...]')
      auditPaths.push(requirePath(argv[index + 3], '--audit requires a path'))
    }
    if (value !== '--audit' || auditPaths.length === 0)
      throw new Error('Usage: aw-skill-eval run <plan.json> --audit <audit.json> [--audit <audit.json>...]')
    const result = await runExecutionPlan(
      requirePath(action, 'Usage: aw-skill-eval run <plan.json> --audit <audit.json>'),
      { auditPaths },
    )
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.requirementsMet) process.exitCode = 1
    return
  }
  if (command === 'result') {
    if (action !== 'validate' || !value || extra.length !== 4) {
      throw new Error('Usage: aw-skill-eval result validate <result.json> --spec <spec.json> --audit <audit.json>')
    }
    const specPath = optionPath(extra, '--spec', 'result validate requires one --spec path')
    const auditPath = optionPath(extra, '--audit', 'result validate requires one --audit path')
    const binding = await boundSpec(specPath)
    const audit = await validateEvalAuditFile(auditPath, {
      spec: binding.spec.spec,
      selectedCaseIds: binding.caseIds,
    })
    if (!audit.valid || !audit.calculated) {
      throw new Error(`EvalAudit is invalid: ${audit.errors.join('; ')}`)
    }
    const result = await validateEvalResultFile(requirePath(value, 'result validate requires a result path'), {
      specDigest: binding.spec.specDigest,
      auditDigest: audit.calculated.auditDigest,
      targetDigest: binding.spec.targetDigest,
      caseDigest: binding.spec.caseDigest,
      provider: binding.spec.spec.provider,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.valid) process.exitCode = 1
    return
  }
  if (command === 'inspect-result') {
    if (!action || value !== undefined || extra.length > 0) {
      throw new Error('Usage: aw-skill-eval inspect-result <result.json>')
    }
    const validation = await validateEvalResultFile(requirePath(action, 'inspect-result requires a result path'))
    if (!validation.valid || !validation.calculated) {
      process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`)
      process.exitCode = 1
      return
    }
    const groups = new Map<string, {
      caseId: string
      attempt: number
      variants: Record<string, unknown>
    }>()
    for (const run of validation.calculated.result.runs) {
      const key = `${run.caseId}\0${run.attempt}`
      const group = groups.get(key) ?? { caseId: run.caseId, attempt: run.attempt, variants: {} }
      group.variants[run.variant] = {
        status: run.status,
        durationMs: run.durationMs,
        outputDir: run.outputDir,
        usage: run.usage,
        grade: run.grade,
        error: run.error,
      }
      groups.set(key, group)
    }
    process.stdout.write(`${JSON.stringify({
      version: 1,
      summary: validation.calculated.result.summary,
      groups: [...groups.values()],
    }, null, 2)}\n`)
    return
  }
  if (command === 'bundle') {
    if (extra.length > 0 || action !== 'validate') throw new Error('Usage: aw-skill-eval bundle validate <bundle.json>')
    const result = await validateRunBundle(requirePath(value, 'Usage: aw-skill-eval bundle validate <bundle.json>'))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.valid) process.exitCode = 1
    return
  }
  if (command === 'audit' && action === 'validate' && value && extra.length === 2 && extra[0] === '--spec') {
    const binding = await boundSpec(requirePath(extra[1], 'audit validate requires a --spec path'))
    const result = await validateEvalAuditFile(requirePath(value, 'audit validate requires an audit path'), {
      spec: binding.spec.spec,
      selectedCaseIds: binding.caseIds,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.valid) process.exitCode = 1
    return
  }
  if (command === 'audit' || command === 'provider-capabilities' || command === 'provider-output') {
    if (extra.length > 0 || action !== 'validate') throw new Error(`Usage: aw-skill-eval ${command} validate <file.json>`)
    const filePath = requirePath(value, `Usage: aw-skill-eval ${command} validate <file.json>`)
    const document = JSON.parse(await readFile(filePath, 'utf8')) as unknown
    const result = command === 'audit'
      ? await validateAuditResult(document)
      : command === 'provider-capabilities'
        ? await validateProviderCapabilities(document)
        : await validateProviderOutput(document)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.valid) process.exitCode = 1
    return
  }
  if (command === 'digest') {
    if (extra.length > 0 || action !== 'skill') throw new Error('Usage: aw-skill-eval digest skill <skill-dir>')
    process.stdout.write(`${await computeSkillDigest(requirePath(value, 'Usage: aw-skill-eval digest skill <skill-dir>'))}\n`)
    return
  }
  throw new Error(`Unknown command: ${command}. Use --help for usage.`)
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`[ERROR] ${(error as Error).message}\n`)
  process.exitCode = 1
})
