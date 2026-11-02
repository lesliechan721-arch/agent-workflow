import { refreshWindowsJobArtifacts } from './windows-job-helper-artifacts.mjs'
try {
  await refreshWindowsJobArtifacts()
  console.log('Windows Job build passed.')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
