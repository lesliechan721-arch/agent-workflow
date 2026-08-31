#!/usr/bin/env node
import {
  assertQualificationReport,
  createQualificationFailureReport,
  runQualification,
} from './codex-project-native-lib.mjs'

let report
try {
  report = assertQualificationReport(await runQualification())
} catch {
  report = createQualificationFailureReport()
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.exitCode = report.minimumContractPassed ? 0 : 1
