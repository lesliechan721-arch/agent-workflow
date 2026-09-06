import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyWindowsJobArtifacts } from './windows-job-helper-artifacts.mjs'

const arch = process.argv[2]
if (arch !== 'x64' && arch !== 'arm64') {
  throw new Error('Expected Windows Job package architecture x64 or arm64.')
}

const evalPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = path.resolve(evalPackageRoot, '..', `aw-windows-job-win32-${arch}`)
const outputRoot = path.join(packageRoot, 'dist')

await verifyWindowsJobArtifacts()
await fs.rm(outputRoot, { recursive: true, force: true })
await fs.mkdir(outputRoot, { recursive: true })
await fs.copyFile(
  path.join(evalPackageRoot, 'native', 'windows', arch, 'aw-windows-job.exe'),
  path.join(outputRoot, 'aw-windows-job.exe'),
)
