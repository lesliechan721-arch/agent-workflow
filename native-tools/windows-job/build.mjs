import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { refreshWindowsJobArtifacts, windowsJobArtifactContract } from './windows-job-helper-artifacts.mjs'

try {
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  let version, nativeRoot
  while (args.length) {
    const flag = args.shift()
    const value = args.shift()
    if (flag === '--version' && value && version === undefined) version = value
    else if (flag === '--out' && value && nativeRoot === undefined) nativeRoot = path.resolve(value)
    else throw new Error('Expected [--version <CLI version>] [--out <candidate directory>].')
  }
  if (version !== undefined && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/u.test(version)) throw new Error('Expected an exact stable or beta.N CLI version.')
  const repoRoot = path.resolve(windowsJobArtifactContract.toolRoot, '../..')
  version ??= JSON.parse(await readFile(path.join(repoRoot, 'packages/cli/package.json'), 'utf8')).version
  await refreshWindowsJobArtifacts({ nativeRoot: nativeRoot ?? path.join(repoRoot, '.native/windows-job', version) })
  console.log(`Windows Job build passed for CLI ${version}.`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
