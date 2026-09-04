#!/usr/bin/env node
import { runCodexNativePerformanceQualification } from './codex-native-performance-lib.mjs'

let report
try {
  report = await runCodexNativePerformanceQualification()
} catch {
  report = {
    schemaVersion: 1,
    kind: 'codex-native-performance-qualification',
    result: 'failed',
    errorCode: 'qualificationInitializationFailed',
  }
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.exitCode = report.result === 'passed' ? 0 : report.result === 'missing' ? 2 : 1
