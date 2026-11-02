import { verifyWindowsJobArtifacts } from './windows-job-helper-artifacts.mjs'
try {
  await verifyWindowsJobArtifacts()
  console.log('Windows Job verify passed.')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
