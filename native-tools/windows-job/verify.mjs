import path from 'node:path'
import { readCandidate } from './candidate.mjs'
try {
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  if (args.length && (args.length !== 2 || args[0] !== '--candidate' || !args[1])) throw new Error('Expected [--candidate <directory>].')
  await readCandidate(args.length ? path.resolve(args[1]) : undefined)
  console.log('Windows Job candidate verify passed.')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
