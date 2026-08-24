#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import {
  computeSkillDigest,
  getRuntimeCapabilities,
  getSchema,
  runExecutionPlan,
  validateExecutionPlan,
  validateRunBundle,
} from './index.js'
import { isSchemaName } from './schemas.js'

const help = `Usage: aw-skill-eval <command>

Commands:
  capabilities --json
  schema print <aw-skill-eval-execution-plan|eval-run-bundle>
  plan validate <plan.json>
  run <plan.json>
  bundle validate <bundle.json>
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
  if (extra.length > 0) throw new Error('Too many arguments. Use --help for usage.')
  if (command === 'capabilities') {
    if (action !== '--json' || value !== undefined) throw new Error('Usage: aw-skill-eval capabilities --json')
    process.stdout.write(`${JSON.stringify(getRuntimeCapabilities(), null, 2)}\n`)
    return
  }
  if (command === 'schema') {
    if (action !== 'print' || !value || !isSchemaName(value) || value === 'eval-runtime-capabilities')
      throw new Error('Usage: aw-skill-eval schema print <aw-skill-eval-execution-plan|eval-run-bundle>')
    process.stdout.write(`${JSON.stringify(await getSchema(value), null, 2)}\n`)
    return
  }
  if (command === 'plan') {
    if (action !== 'validate') throw new Error('Usage: aw-skill-eval plan validate <plan.json>')
    const result = await validateExecutionPlan(requirePath(value, 'Usage: aw-skill-eval plan validate <plan.json>'))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.valid) process.exitCode = 1
    return
  }
  if (command === 'run') {
    if (value !== undefined) throw new Error('Usage: aw-skill-eval run <plan.json>')
    const result = await runExecutionPlan(requirePath(action, 'Usage: aw-skill-eval run <plan.json>'))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  if (command === 'bundle') {
    if (action !== 'validate') throw new Error('Usage: aw-skill-eval bundle validate <bundle.json>')
    const result = await validateRunBundle(requirePath(value, 'Usage: aw-skill-eval bundle validate <bundle.json>'))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.valid) process.exitCode = 1
    return
  }
  if (command === 'digest') {
    if (action !== 'skill') throw new Error('Usage: aw-skill-eval digest skill <skill-dir>')
    process.stdout.write(`${await computeSkillDigest(requirePath(value, 'Usage: aw-skill-eval digest skill <skill-dir>'))}\n`)
    return
  }
  throw new Error(`Unknown command: ${command}. Use --help for usage.`)
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`[ERROR] ${(error as Error).message}\n`)
  process.exitCode = 1
})
