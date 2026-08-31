#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import {
  createEvalResultBinding,
  doctorEvalProviders,
  runEvalSpec,
  validateEvalAuditFile,
  validateEvalResultFile,
  validateEvalSpecFile,
  validateSelectedCasesFile,
} from './index.js'

const help = `Usage: aw-skill-eval <command>

Commands:
  spec validate <spec.json>
  audit validate <audit.json> --spec <spec.json>
  run <spec.json> --audit <audit.json>
  result validate <result.json> --spec <spec.json> --audit <audit.json>
  inspect-result <result.json> --spec <spec.json> --audit <audit.json>
  doctor --json
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
  cases: NonNullable<Awaited<ReturnType<typeof validateSelectedCasesFile>>['calculated']>
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
  return { spec: validation.calculated, cases: cases.calculated }
}

async function boundResult(specPath: string, auditPath: string) {
  const binding = await boundSpec(specPath)
  const audit = await validateEvalAuditFile(auditPath, {
    spec: binding.spec.spec,
    selectedCaseIds: binding.cases.cases.map((entry) => entry.id),
  })
  if (!audit.valid || !audit.calculated) {
    throw new Error(`EvalAudit is invalid: ${audit.errors.join('; ')}`)
  }
  return createEvalResultBinding(
    binding.spec,
    audit.calculated.auditDigest,
    binding.cases,
  )
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(help)
    return
  }
  const [command, action, value, ...extra] = argv
  if (command === 'doctor') {
    if (action !== '--json' || value !== undefined || extra.length > 0) {
      throw new Error('Usage: aw-skill-eval doctor --json')
    }
    process.stdout.write(`${JSON.stringify(await doctorEvalProviders(), null, 2)}\n`)
    return
  }
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
  if (command === 'run') {
    const runPath = requirePath(action, 'Usage: aw-skill-eval run <spec.json> --audit <audit.json>')
    if (value !== '--audit' || extra.length !== 1) {
      throw new Error('Usage: aw-skill-eval run <spec.json> --audit <audit.json>')
    }
    const controller = new AbortController()
    let receivedSignal: NodeJS.Signals | null = null
    const handleSignal = (signal: NodeJS.Signals): void => {
      if (receivedSignal) return
      receivedSignal = signal
      controller.abort()
    }
    const handleSigint = (): void => handleSignal('SIGINT')
    const handleSigterm = (): void => handleSignal('SIGTERM')
    process.on('SIGINT', handleSigint)
    process.on('SIGTERM', handleSigterm)
    try {
      const result = await runEvalSpec(runPath, {
        auditPath: requirePath(extra[0], '--audit requires a path'),
        signal: controller.signal,
      })
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } finally {
      process.off('SIGINT', handleSigint)
      process.off('SIGTERM', handleSigterm)
      if (receivedSignal) process.exitCode = receivedSignal === 'SIGINT' ? 130 : 143
    }
    return
  }
  if (command === 'result') {
    if (action !== 'validate' || !value || extra.length !== 4) {
      throw new Error('Usage: aw-skill-eval result validate <result.json> --spec <spec.json> --audit <audit.json>')
    }
    const specPath = optionPath(extra, '--spec', 'result validate requires one --spec path')
    const auditPath = optionPath(extra, '--audit', 'result validate requires one --audit path')
    const binding = await boundResult(specPath, auditPath)
    const result = await validateEvalResultFile(
      requirePath(value, 'result validate requires a result path'),
      binding,
    )
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.valid) process.exitCode = 1
    return
  }
  if (command === 'inspect-result') {
    const options = value === undefined ? [] : [value, ...extra]
    if (!action || options.length !== 4) {
      throw new Error('Usage: aw-skill-eval inspect-result <result.json> --spec <spec.json> --audit <audit.json>')
    }
    const binding = await boundResult(
      optionPath(options, '--spec', 'inspect-result requires one --spec path'),
      optionPath(options, '--audit', 'inspect-result requires one --audit path'),
    )
    const validation = await validateEvalResultFile(
      requirePath(action, 'inspect-result requires a result path'),
      binding,
    )
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
  if (command === 'audit' && action === 'validate' && value && extra.length === 2 && extra[0] === '--spec') {
    const binding = await boundSpec(requirePath(extra[1], 'audit validate requires a --spec path'))
    const result = await validateEvalAuditFile(requirePath(value, 'audit validate requires an audit path'), {
      spec: binding.spec.spec,
      selectedCaseIds: binding.cases.cases.map((entry) => entry.id),
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.valid) process.exitCode = 1
    return
  }
  throw new Error(`Unknown command: ${command}. Use --help for usage.`)
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`[ERROR] ${(error as Error).message}\n`)
  if (!process.exitCode) process.exitCode = 1
})
