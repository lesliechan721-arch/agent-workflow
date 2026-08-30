#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  computeSkillDigest,
  getRuntimeCapabilities,
  getSchema,
  runExecutionPlan,
  validateAuditResult,
  validateExecutionPlan,
  validateProviderCapabilities,
  validateProviderOutput,
  validateRunBundle,
} from './index.js'
import { isSchemaName } from './schemas.js'

const help = `Usage: aw-skill-eval <command>

Commands:
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

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(help)
    return
  }
  const [command, action, value, ...extra] = argv
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
  if (command === 'bundle') {
    if (extra.length > 0 || action !== 'validate') throw new Error('Usage: aw-skill-eval bundle validate <bundle.json>')
    const result = await validateRunBundle(requirePath(value, 'Usage: aw-skill-eval bundle validate <bundle.json>'))
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
