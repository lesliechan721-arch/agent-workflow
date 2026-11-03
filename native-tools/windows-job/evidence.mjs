import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WINDOWS_JOB_REQUIRED_CHECKS } from '../../scripts/qualification/windows-job-containment.mjs';

export const WINDOWS_JOB_EVIDENCE_FILES = [
  'candidate.json', 'reproducibility.json', 'qualification-x64.json', 'qualification-arm64.json',
];
const requiredChecks = [...WINDOWS_JOB_REQUIRED_CHECKS, 'plugin-files-acl-cross-volume', 'go-native-tests'];

export async function assertWindowsJobCandidateEvidence(selected) {
  const read = async (name, message) => {
    try {
      const report = JSON.parse(await readFile(path.join(selected.root, name), 'utf8'));
      if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('Evidence must be a JSON object.');
      return report;
    } catch (cause) { throw new Error(message, { cause }); }
  };
  const reproMessage = 'Current x64 and arm64 reproducibility evidence is required.';
  const repro = await read('reproducibility.json', reproMessage);
  if (repro.schemaVersion !== 1 || repro.kind !== 'windows-job-reproducibility' || repro.status !== 'passed'
    || repro.candidateDigest !== selected.candidateDigest || repro.sourceDigest !== selected.candidate.sourceDigest
    || repro.goVersion !== selected.candidate.goVersion || !Array.isArray(repro.architectures)
    || repro.architectures.join(',') !== 'x64,arm64') throw new Error(reproMessage);
  for (const arch of ['x64', 'arm64']) {
    const message = `Real Windows x64 and arm64 qualification for this exact candidate is required; ${arch} evidence is missing or invalid.`;
    const report = await read(`qualification-${arch}.json`, message);
    if (report.schemaVersion !== 1 || report.kind !== 'windows-job-qualification' || report.mode !== 'source-candidate'
      || report.platform !== 'win32' || report.arch !== arch || report.status !== 'passed'
      || report.candidateDigest !== selected.candidateDigest || report.sourceDigest !== selected.candidate.sourceDigest
      || !Array.isArray(report.checks) || report.checks.some((check) => !check || typeof check !== 'object' || check.passed !== true || check.skipped)
      || requiredChecks.some((id) => report.checks.filter((check) => check.id === id && check.passed === true).length !== 1)) throw new Error(message);
  }
  return WINDOWS_JOB_EVIDENCE_FILES.map((name) => path.join(selected.root, name));
}
