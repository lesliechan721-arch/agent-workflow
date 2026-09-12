#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ASSESSMENTS = new Set(['pass', 'needs-fixes', 'not-assessed']);
const SUBJECT_KINDS = new Set(['plugin', 'catalog', 'skill', 'workflow', 'portfolio']);
const SEVERITIES = new Set(['critical', 'major']);
const STATUS_EXIT = { ready: 0, blocked: 1, invalid: 2, unsupported: 2, incomplete: 3 };

class UnsupportedError extends Error {}
class UnsafeOutputError extends Error {}

function usage() {
  return [
    'Usage: check-aw-release.mjs --target <path> --evidence <file> [--materialization <receipt>]... [--eval-chain <file>]... [--output <new-file>] [--overwrite] [--format json|text]',
    'Each Eval chain file is a JSON object with exactly: spec, audit, result.',
  ].join('\n');
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  let target = null;
  let evidence = null;
  let output = null;
  let overwrite = false;
  let format = 'json';
  const materializations = [];
  const evalChains = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--target') {
      if (target !== null) throw new Error('--target can be specified only once.');
      target = path.resolve(valueAfter(argv, index, value));
      index += 1;
    } else if (value === '--evidence') {
      if (evidence !== null) throw new Error('--evidence can be specified only once.');
      evidence = path.resolve(valueAfter(argv, index, value));
      index += 1;
    } else if (value === '--materialization') {
      materializations.push(path.resolve(valueAfter(argv, index, value)));
      index += 1;
    } else if (value === '--eval-chain') {
      evalChains.push(path.resolve(valueAfter(argv, index, value)));
      index += 1;
    } else if (value === '--output') {
      if (output !== null) throw new Error('--output can be specified only once.');
      output = path.resolve(valueAfter(argv, index, value));
      index += 1;
    } else if (value === '--overwrite') {
      if (overwrite) throw new Error('--overwrite can be specified only once.');
      overwrite = true;
    } else if (value === '--format') {
      format = valueAfter(argv, index, value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (target === null || evidence === null) throw new Error(usage());
  if (!['json', 'text'].includes(format)) throw new Error('--format must be json or text.');
  if (overwrite && output === null) throw new Error('--overwrite requires --output.');
  return { target, evidence, output, overwrite, format, materializations, evalChains };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} must contain exactly: ${wanted.join(', ')}.`);
  }
}

async function assertPathComponents(filePath, finalType, label) {
  const absolute = path.resolve(filePath);
  const parsed = path.parse(absolute);
  const segments = path.relative(parsed.root, absolute).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await lstat(current).catch(() => null);
    const final = index === segments.length - 1;
    if (stat === null) {
      if (final && finalType === 'absent-or-file') return absolute;
      throw new Error(`${label} does not exist: ${absolute}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} cannot contain a symlink: ${current}`);
    if (!final && !stat.isDirectory()) throw new Error(`${label} has a non-directory path component: ${current}`);
    if (final && finalType === 'file' && !stat.isFile()) {
      throw new Error(`${label} must be a regular file: ${absolute}`);
    }
    if (final && finalType === 'directory' && !stat.isDirectory()) {
      throw new Error(`${label} must be a regular directory: ${absolute}`);
    }
    if (final && finalType === 'absent-or-file' && !stat.isFile()) {
      throw new Error(`${label} must be absent or a regular file: ${absolute}`);
    }
  }
  return absolute;
}

async function assertSafeOutput(filePath, overwrite) {
  const absolute = path.resolve(filePath);
  await assertPathComponents(path.dirname(absolute), 'directory', 'Output parent');
  const stat = await lstat(absolute).catch(() => null);
  if (stat?.isSymbolicLink()) throw new UnsafeOutputError(`Output cannot be a symlink: ${absolute}`);
  if (stat && !stat.isFile()) throw new UnsafeOutputError(`Output must be a regular file: ${absolute}`);
  if (stat && !overwrite) {
    throw new UnsafeOutputError(`Output already exists; use --overwrite to replace it: ${absolute}`);
  }
  return stat
    ? realpath(absolute)
    : path.join(await realpath(path.dirname(absolute)), path.basename(absolute));
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertOutputSeparated(output, inputs) {
  if (!output) return;
  for (const input of inputs) {
    if (!input) continue;
    const absolute = await realpath(path.resolve(input));
    const stat = await lstat(absolute);
    const overlaps = stat.isDirectory() ? isInside(absolute, output) : absolute === output;
    if (overlaps) throw new UnsafeOutputError(`Output must not overlap a checked input or target: ${input}`);
  }
}

async function fileDigest(filePath) {
  return `sha256:${createHash('sha256').update(await readFile(filePath)).digest('hex')}`;
}

function safeRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  if (value.includes('\\') || path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be a workspace-relative POSIX path.`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} must be a canonical workspace-relative POSIX path.`);
  }
  return value;
}

function workspaceRelative(workspaceRoot, absolutePath, label) {
  const relative = path.relative(workspaceRoot, absolutePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new UnsupportedError(`${label} is outside the inspected Catalog Workspace.`);
  }
  return relative.split(path.sep).join('/') || '.';
}

async function runPublicJson(command, args) {
  try {
    const result = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
    });
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new UnsupportedError(`${command} did not return one JSON object.`);
    }
  } catch (error) {
    if (error instanceof UnsupportedError) throw error;
    if (error?.code === 'ENOENT') throw new UnsupportedError(`${command} is not available on PATH.`);
    if (typeof error?.stdout === 'string' && error.stdout.trim()) {
      try {
        return JSON.parse(error.stdout);
      } catch {
        throw new UnsupportedError(`${command} returned an incompatible non-JSON failure.`);
      }
    }
    throw new UnsupportedError(`${command} could not provide its public validation result.`);
  }
}

function createState(rawTarget) {
  return {
    unsupported: [],
    invalid: [],
    blocked: [],
    missing: [],
    warnings: [],
    checkedSubjects: [],
    checkedEvalSelections: [],
    target: { kind: null, id: null, path: rawTarget ?? null, digest: null },
    inputDigests: { evidence: null, materializations: [], evalChains: [] },
  };
}

function addIssue(state, category, code, message, extra = {}) {
  const issue = { code, message, ...extra };
  if (category === 'missing') state.missing.push(issue);
  else if (category === 'warning') state.warnings.push(issue);
  else state[category].push(issue);
}

function validateInspection(receipt) {
  if (!isObject(receipt) || receipt.schemaVersion !== 2 || receipt.command !== 'review:inspect'
    || receipt.view !== 'release') {
    throw new UnsupportedError('aw review inspect did not return Review inspection schema 2 release view.');
  }
  if (!isObject(receipt.target) || !isObject(receipt.workspace)
    || typeof receipt.workspace.root !== 'string' || !Array.isArray(receipt.plugins)
    || !Array.isArray(receipt.subjects) || !Array.isArray(receipt.requiredFinals)
    || !Array.isArray(receipt.requiredEvals) || !Array.isArray(receipt.materializations)
    || !Array.isArray(receipt.issues)) {
    throw new UnsupportedError('aw review inspect returned an incomplete Review inspection schema 2 release receipt.');
  }
  return receipt;
}

function validateEvidenceShape(value) {
  exactKeys(value, ['version', 'target', 'subjects'], 'AWReviewEvidence');
  if (value.version !== 1) throw new Error('AWReviewEvidence version must be 1.');
  exactKeys(value.target, ['kind', 'path', 'digest'], 'AWReviewEvidence.target');
  if (!['plugin', 'catalog'].includes(value.target.kind)) {
    throw new Error('AWReviewEvidence.target.kind must be plugin or catalog.');
  }
  safeRelativePath(value.target.path, 'AWReviewEvidence.target.path');
  if (!DIGEST.test(value.target.digest)) throw new Error('AWReviewEvidence.target.digest must be a SHA-256 digest.');
  if (!Array.isArray(value.subjects) || value.subjects.length === 0) {
    throw new Error('AWReviewEvidence.subjects must be a non-empty array.');
  }
  for (const [index, subject] of value.subjects.entries()) {
    const label = `AWReviewEvidence.subjects[${index}]`;
    exactKeys(subject, [
      'kind', 'path', 'profile', 'digest', 'assessment', 'evidenceRefs', 'blockingFindings',
    ], label);
    if (!SUBJECT_KINDS.has(subject.kind)) throw new Error(`${label}.kind is invalid.`);
    safeRelativePath(subject.path, `${label}.path`);
    if (typeof subject.profile !== 'string' || subject.profile.length === 0) {
      throw new Error(`${label}.profile must be a non-empty string.`);
    }
    if (!DIGEST.test(subject.digest)) throw new Error(`${label}.digest must be a SHA-256 digest.`);
    if (!ASSESSMENTS.has(subject.assessment)) throw new Error(`${label}.assessment is invalid.`);
    if (!Array.isArray(subject.evidenceRefs) || !Array.isArray(subject.blockingFindings)) {
      throw new Error(`${label} evidenceRefs and blockingFindings must be arrays.`);
    }
    for (const [refIndex, reference] of subject.evidenceRefs.entries()) {
      const refLabel = `${label}.evidenceRefs[${refIndex}]`;
      exactKeys(reference, ['path', 'digest'], refLabel);
      if (typeof reference.path !== 'string' || reference.path.length === 0) {
        throw new Error(`${refLabel}.path must be a non-empty string.`);
      }
      if (!DIGEST.test(reference.digest)) throw new Error(`${refLabel}.digest must be a SHA-256 digest.`);
    }
    for (const [findingIndex, finding] of subject.blockingFindings.entries()) {
      const findingLabel = `${label}.blockingFindings[${findingIndex}]`;
      exactKeys(finding, ['id', 'severity', 'owner'], findingLabel);
      if (typeof finding.id !== 'string' || finding.id.length === 0
        || typeof finding.owner !== 'string' || finding.owner.length === 0
        || !SEVERITIES.has(finding.severity)) {
        throw new Error(`${findingLabel} is invalid.`);
      }
    }
    if (subject.assessment === 'pass'
      && (subject.evidenceRefs.length === 0 || subject.blockingFindings.length > 0)) {
      throw new Error(`${label} pass requires evidence and no blocking findings.`);
    }
    if (subject.assessment === 'needs-fixes'
      && (subject.evidenceRefs.length === 0 || subject.blockingFindings.length === 0)) {
      throw new Error(`${label} needs-fixes requires evidence and blocking findings.`);
    }
  }
  return value;
}

async function validateEvidenceReferences(evidence, evidencePath) {
  const base = path.dirname(evidencePath);
  const paths = [];
  for (const [subjectIndex, subject] of evidence.subjects.entries()) {
    for (const [referenceIndex, reference] of subject.evidenceRefs.entries()) {
      const resolved = path.isAbsolute(reference.path)
        ? path.resolve(reference.path)
        : path.resolve(base, reference.path);
      await assertPathComponents(
        resolved,
        'file',
        `AWReviewEvidence.subjects[${subjectIndex}].evidenceRefs[${referenceIndex}]`,
      );
      if (await fileDigest(resolved) !== reference.digest) {
        throw new Error(`Evidence reference digest does not match: ${reference.path}`);
      }
      paths.push(resolved);
    }
  }
  return paths;
}

function materializationProfile(profile) {
  if (!isObject(profile) || !['eval', 'portable', 'review'].includes(profile.kind)
    || typeof profile.id !== 'string' || profile.id.length === 0
    || !['user', 'project'].includes(profile.scope) || !DIGEST.test(profile.inputDigest)) {
    throw new UnsupportedError('Review inspection returned an invalid materialization profile.');
  }
  return `${profile.kind}:${profile.id}:${profile.scope}:${profile.inputDigest}`;
}

function canonicalSubjectKey(subject) {
  return [subject.kind, subject.path, subject.profile, subject.digest].join('\0');
}

function subjectCoordinate(subject) {
  return [subject.kind, subject.path, subject.profile].join('\0');
}

function deriveRequiredSubjects(inspection, workspaceRoot, state) {
  const byKey = new Map(inspection.subjects.map((subject) => [subject.key, subject]));
  const required = [];
  const addContainer = (key, kind) => {
    const subject = byKey.get(key);
    if (!subject || !DIGEST.test(subject.digest) || typeof subject.path !== 'string') {
      throw new UnsupportedError(`Review inspection is missing current container subject ${key}.`);
    }
    required.push({
      kind,
      path: workspaceRelative(workspaceRoot, subject.path, `Container subject ${key}`),
      profile: 'none',
      digest: subject.digest,
      inspectionKey: key,
    });
  };
  if (inspection.target.kind === 'catalog') {
    addContainer('catalog:source', 'catalog');
    for (const plugin of inspection.plugins) addContainer(plugin.sourceContainerKey, 'plugin');
  } else if (inspection.target.kind === 'plugin') {
    const plugin = inspection.plugins.find((entry) => entry.id === inspection.target.id);
    if (!plugin) throw new UnsupportedError('Review inspection does not contain its selected Plugin.');
    addContainer(plugin.sourceContainerKey, 'plugin');
  } else {
    throw new UnsupportedError('Review inspection target kind is not supported.');
  }

  for (const final of inspection.requiredFinals) {
    if (!isObject(final) || typeof final.key !== 'string' || typeof final.sourceSubjectKey !== 'string'
      || !Array.isArray(final.matchedFinalKeys)) {
      throw new UnsupportedError('Review inspection returned an invalid required final.');
    }
    if (final.status !== 'resolved' || final.matchedFinalKeys.length === 0) {
      addIssue(state, 'missing', 'requiredFinalMissing',
        `A current final is missing for ${String(final.plugin)}/${String(final.skill)}/${String(final.profile)}.`,
        { subject: final.key });
      continue;
    }
    const source = byKey.get(final.sourceSubjectKey);
    if (!source || typeof source.path !== 'string') {
      throw new UnsupportedError(`Review inspection cannot map final ${final.key} to a source subject.`);
    }
    const logicalPath = workspaceRelative(workspaceRoot, source.path, `Source subject ${final.sourceSubjectKey}`);
    for (const finalKey of final.matchedFinalKeys) {
      const subject = byKey.get(finalKey);
      if (!subject || subject.kind !== 'materialized-skill' || !DIGEST.test(subject.digest)) {
        throw new UnsupportedError(`Review inspection is missing materialized subject ${finalKey}.`);
      }
      const profile = subject.materializationProfile
        ? materializationProfile(subject.materializationProfile)
        : subject.profile;
      if (typeof profile !== 'string' || profile.length === 0) {
        throw new UnsupportedError(`Review inspection subject ${finalKey} has no profile.`);
      }
      required.push({
        kind: 'skill',
        path: logicalPath,
        profile,
        digest: subject.digest,
        inspectionKey: finalKey,
        requiredFinalKey: final.key,
      });
    }
  }
  const unique = new Map();
  for (const subject of required) unique.set(canonicalSubjectKey(subject), subject);
  return [...unique.values()].sort((left, right) =>
    canonicalSubjectKey(left).localeCompare(canonicalSubjectKey(right)));
}

function inspectIssues(inspection, state) {
  for (const issue of inspection.issues) {
    const extra = {
      ...(typeof issue.subjectKey === 'string' ? { subject: issue.subjectKey } : {}),
      ...(typeof issue.path === 'string' ? { path: issue.path } : {}),
    };
    if (issue.category === 'unsupported') {
      addIssue(state, 'unsupported', issue.code ?? 'inspectionUnsupported', issue.message ?? 'Inspection is unsupported.', extra);
    } else if (issue.category === 'invalid') {
      addIssue(state, 'invalid', issue.code ?? 'inspectionInvalid', issue.message ?? 'Inspection input is invalid.', extra);
    } else if (issue.code === 'requiredFinalMissing') {
      // deriveRequiredSubjects reports the missing final once.
    } else if (issue.code === 'sourceBindingDrifted') {
      addIssue(state, 'blocked', issue.code, issue.message, extra);
    } else if (issue.blocking && /Ambiguous$/u.test(issue.code ?? '')) {
      addIssue(state, 'invalid', issue.code, issue.message, extra);
    } else if (issue.blocking) {
      addIssue(state, 'missing', issue.code ?? 'inspectionIncomplete', issue.message ?? 'Inspection is incomplete.', extra);
    } else {
      addIssue(state, 'warning', issue.code ?? 'inspectionWarning', issue.message ?? 'Inspection reported a warning.', extra);
    }
  }
}

function matchReviewEvidence(requiredSubjects, evidence, state) {
  const byKey = new Map();
  const byCoordinate = new Map();
  for (const [index, subject] of evidence.subjects.entries()) {
    const key = canonicalSubjectKey(subject);
    const coordinate = subjectCoordinate(subject);
    if (byKey.has(key)) {
      addIssue(state, 'invalid', 'duplicateSubject',
        `AWReviewEvidence repeats subject ${subject.kind}/${subject.path}/${subject.profile}/${subject.digest}.`,
        { evidenceIndex: index });
    } else {
      byKey.set(key, subject);
    }
    byCoordinate.set(coordinate, [...(byCoordinate.get(coordinate) ?? []), subject]);
  }
  const requiredKeys = new Set(requiredSubjects.map(canonicalSubjectKey));
  for (const required of requiredSubjects) {
    const key = canonicalSubjectKey(required);
    const evidenceSubject = byKey.get(key);
    if (!evidenceSubject) {
      const stale = byCoordinate.get(subjectCoordinate(required)) ?? [];
      if (stale.length > 0) {
        addIssue(state, 'blocked', 'subjectDigestMismatch',
          `Review evidence for ${required.kind}/${required.path}/${required.profile} does not match the current digest.`,
          { subject: required.inspectionKey });
      } else {
        addIssue(state, 'missing', 'subjectNotAssessed',
          `Review evidence is missing for ${required.kind}/${required.path}/${required.profile}.`,
          { subject: required.inspectionKey });
      }
      state.checkedSubjects.push({ ...required, assessment: 'missing', evidenceRefs: [], blockingFindings: [] });
      continue;
    }
    state.checkedSubjects.push({
      ...required,
      assessment: evidenceSubject.assessment,
      evidenceRefs: evidenceSubject.evidenceRefs,
      blockingFindings: evidenceSubject.blockingFindings,
    });
    if (evidenceSubject.assessment === 'needs-fixes') {
      addIssue(state, 'blocked', 'subjectNeedsFixes',
        `Review evidence confirms blocking findings for ${required.kind}/${required.path}/${required.profile}.`,
        { subject: required.inspectionKey, findingIds: evidenceSubject.blockingFindings.map((entry) => entry.id) });
    } else if (evidenceSubject.assessment === 'not-assessed') {
      addIssue(state, 'missing', 'subjectNotAssessed',
        `The required subject is not assessed: ${required.kind}/${required.path}/${required.profile}.`,
        { subject: required.inspectionKey });
    }
  }
  for (const [index, subject] of evidence.subjects.entries()) {
    if (!requiredKeys.has(canonicalSubjectKey(subject))) {
      addIssue(state, 'warning', 'unusedSubject',
        `AWReviewEvidence subject ${subject.kind}/${subject.path}/${subject.profile} is not required by the current target.`,
        { evidenceIndex: index });
    }
  }
}

function sortedStrings(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left, right) {
  return JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));
}

function artifactMatches(artifact, kind, calculatedPath, calculatedDigest, skill) {
  return isObject(artifact) && artifact.kind === kind
    && (skill === null || artifact.skill === skill)
    && path.resolve(artifact.path) === path.resolve(calculatedPath)
    && artifact.digest === calculatedDigest;
}

function bindingMatches(required, materialization, calculated, selectedIds, subjectByKey) {
  const binding = materialization.verifiedBinding;
  if (!binding || !isObject(binding.evalInput) || !isObject(binding.profile)
    || !isObject(binding.subject) || !Array.isArray(binding.artifacts)) return false;
  const requiredFinalIsCurrent = required.materializedFinalKeys.some((key) => {
    const subject = subjectByKey.get(key);
    return subject?.digest === calculated.targetDigest && materialization.finalKeys.includes(key);
  });
  return requiredFinalIsCurrent
    && binding.subject.plugin === required.plugin
    && binding.subject.skill === required.skill
    && binding.subject.suite === required.suite.id
    && binding.profile.kind === 'eval'
    && binding.profile.id === required.evalProfile.id
    && binding.profile.scope === required.evalProfile.scope
    && binding.profile.inputDigest === required.evalProfile.inputDigest
    && binding.evalInput.suiteDefaultsDigest === required.suite.suiteDefaultsDigest
    && binding.evalInput.selectedCasesDigest === required.cases.selectedCasesDigest
    && binding.evalInput.providerDigest === calculated.providerDigest
    && sameStrings(binding.evalInput.selectedCaseIds ?? [], selectedIds)
    && binding.artifacts.some((entry) => artifactMatches(
      entry, 'eval-target', calculated.paths.target, calculated.targetDigest, required.skill,
    ))
    && binding.artifacts.some((entry) => artifactMatches(
      entry, 'eval-workspace', calculated.paths.workspace, calculated.workspaceDigest, null,
    ))
    && binding.artifacts.some((entry) => artifactMatches(
      entry, 'eval-cases', calculated.paths.cases, calculated.caseDigest, null,
    ));
}

async function readEvalChain(chainPath, output) {
  await assertPathComponents(chainPath, 'file', 'Eval chain');
  const descriptor = JSON.parse(await readFile(chainPath, 'utf8'));
  exactKeys(descriptor, ['spec', 'audit', 'result'], 'Eval chain');
  const base = path.dirname(chainPath);
  const paths = {};
  for (const key of ['spec', 'audit', 'result']) {
    if (typeof descriptor[key] !== 'string' || descriptor[key].length === 0) {
      throw new Error(`Eval chain ${key} must be a non-empty path.`);
    }
    paths[key] = path.isAbsolute(descriptor[key])
      ? path.resolve(descriptor[key])
      : path.resolve(base, descriptor[key]);
    await assertPathComponents(paths[key], 'file', `Eval chain ${key}`);
  }
  await assertOutputSeparated(output, [chainPath, paths.spec, paths.audit, paths.result]);
  return { descriptor, paths, descriptorDigest: await fileDigest(chainPath) };
}

async function validateEvalChain(chainPath, inspection, state, output) {
  const chain = await readEvalChain(chainPath, output);
  const input = { path: chainPath, digest: chain.descriptorDigest, spec: null, audit: null, result: null };
  state.inputDigests.evalChains.push(input);
  const specValidation = await runPublicJson('aw-skill-eval', ['spec', 'validate', chain.paths.spec]);
  if (!specValidation?.valid || !isObject(specValidation.calculated)) {
    addIssue(state, 'invalid', 'evalSpecInvalid',
      `EvalSpec validation failed: ${(specValidation?.errors ?? []).join('; ') || 'invalid validator result'}`,
      { path: chainPath });
    return null;
  }
  const calculated = specValidation.calculated;
  const spec = calculated.spec;
  input.spec = calculated.specDigest;
  if (!isObject(spec) || !isObject(spec.source) || !isObject(calculated.paths)
    || !DIGEST.test(calculated.specDigest) || !DIGEST.test(calculated.providerDigest)
    || !DIGEST.test(calculated.targetDigest) || !DIGEST.test(calculated.workspaceDigest)
    || !DIGEST.test(calculated.caseDigest)) {
    throw new UnsupportedError('aw-skill-eval spec validate returned an incomplete calculated contract.');
  }
  const auditValidation = await runPublicJson('aw-skill-eval', [
    'audit', 'validate', chain.paths.audit, '--spec', chain.paths.spec,
  ]);
  if (!auditValidation?.valid || !isObject(auditValidation.calculated)) {
    addIssue(state, 'invalid', 'evalAuditInvalid',
      `EvalAudit validation failed: ${(auditValidation?.errors ?? []).join('; ') || 'invalid validator result'}`,
      { path: chainPath });
    return null;
  }
  input.audit = auditValidation.calculated.auditDigest;
  const resultValidation = await runPublicJson('aw-skill-eval', [
    'result', 'validate', chain.paths.result,
    '--spec', chain.paths.spec, '--audit', chain.paths.audit,
  ]);
  if (!resultValidation?.valid || !isObject(resultValidation.calculated)) {
    addIssue(state, 'invalid', 'evalResultInvalid',
      `EvalResult validation failed: ${(resultValidation?.errors ?? []).join('; ') || 'invalid validator result'}`,
      { path: chainPath });
    return null;
  }
  input.result = resultValidation.calculated.resultDigest;
  const result = resultValidation.calculated.result;
  if (!isObject(result) || !Array.isArray(result.runs) || !isObject(result.processManagement)) {
    throw new UnsupportedError('aw-skill-eval result validate returned an incomplete calculated contract.');
  }
  const selectedDocument = JSON.parse(await readFile(calculated.paths.cases, 'utf8'));
  if (!isObject(selectedDocument) || !Array.isArray(selectedDocument.cases)
    || selectedDocument.cases.some((entry) => !isObject(entry) || typeof entry.id !== 'string')) {
    throw new UnsupportedError('The validated Eval selected-cases contract does not expose case IDs.');
  }
  const selectedIds = selectedDocument.cases.map((entry) => entry.id);
  const sourceCandidates = inspection.requiredEvals.filter((required) =>
    required.plugin === spec.source.plugin
    && required.skill === spec.source.skill
    && required.suite.id === spec.source.suite
    && required.evalProfile.id === spec.source.profile);
  if (sourceCandidates.length === 0) {
    addIssue(state, 'warning', 'unusedEvalChain',
      `Eval chain ${chainPath} is not required by the current target.`, { path: chainPath });
    return { requiredKey: null, resultDigest: input.result, valid: true };
  }
  const subjectByKey = new Map(inspection.subjects.map((subject) => [subject.key, subject]));
  const exactByRequired = new Map();
  for (const required of sourceCandidates) {
    if (!sameStrings(selectedIds, required.cases.selected.map((entry) => entry.id))) continue;
    for (const materialization of inspection.materializations) {
      if (materialization.state !== 'verified'
        || !required.verifiedBindingPaths.includes(materialization.path)) continue;
      if (bindingMatches(required, materialization, calculated, selectedIds, subjectByKey)) {
        if (!exactByRequired.has(required.key)) {
          exactByRequired.set(required.key, { required, materialization });
        }
      }
    }
  }
  const exact = [...exactByRequired.values()];
  if (exact.length !== 1) {
    const category = exact.length > 1 ? 'invalid' : 'blocked';
    addIssue(state, category, exact.length > 1 ? 'evalSelectionAmbiguous' : 'evalCurrentBindingMismatch',
      exact.length > 1
        ? `Eval chain ${chainPath} matches multiple current required selections.`
        : `Eval chain ${chainPath} is not bound to the current required target, workspace, cases, provider, and materialization.`,
      { path: chainPath });
    return { requiredKey: null, resultDigest: input.result, valid: false };
  }
  const required = exact[0].required;
  const selection = {
    key: required.key,
    plugin: required.plugin,
    skill: required.skill,
    suite: required.suite.id,
    profile: required.evalProfile.id,
    finalProfile: required.finalProfile,
    specDigest: input.spec,
    auditDigest: input.audit,
    resultDigest: input.result,
    providerDigest: calculated.providerDigest,
    workspaceDigest: calculated.workspaceDigest,
    targetDigest: calculated.targetDigest,
    caseDigest: calculated.caseDigest,
    sourceCorpusDigest: required.cases.sourceCorpusDigest,
    selectedCaseIds: sortedStrings(selectedIds),
    minimumRuns: required.runs,
    minimumPassRate: required.minimumPassRate,
    processManagement: result.processManagement.mode,
    status: 'pass',
  };
  let blocked = false;
  let incomplete = false;
  if (spec.runs < required.runs) {
    blocked = true;
    addIssue(state, 'blocked', 'evalRunsBelowRequirement',
      `Eval chain ${required.key} requests ${spec.runs} runs; the current release requirement is ${required.runs}.`,
      { selection: required.key });
  }
  if (required.processManagement === 'managed-only' && result.processManagement.mode !== 'managed') {
    blocked = true;
    addIssue(state, 'blocked', 'evalProcessManagementRejected',
      `Eval chain ${required.key} does not satisfy managed-only process policy.`,
      { selection: required.key });
  } else if (required.processManagement === 'allow-unmanaged-confirmed'
    && !['managed', 'unmanaged-confirmed'].includes(result.processManagement.mode)) {
    blocked = true;
    addIssue(state, 'blocked', 'evalProcessManagementRejected',
      `Eval chain ${required.key} has unsupported process evidence.`, { selection: required.key });
  }
  const expectedRuns = required.cases.selected.flatMap((entry) =>
    Array.from({ length: entry.minimumRuns }, (_, index) => ({ caseId: entry.id, attempt: index + 1 })));
  const currentRuns = result.runs.filter((run) => run.variant === 'current');
  const currentByRun = new Map(currentRuns
    .map((run) => [`${run.caseId}\0${run.attempt}`, run]));
  const observed = expectedRuns.map((expected) => currentByRun.get(`${expected.caseId}\0${expected.attempt}`));
  const absent = expectedRuns.filter((_, index) => observed[index] === undefined);
  if (absent.length > 0) {
    incomplete = true;
    addIssue(state, 'missing', 'evalRunsMissing',
      `Eval chain ${required.key} is missing ${absent.length} required current run(s).`,
      { selection: required.key });
  }
  const executionFailures = currentRuns.filter((run) => run.status !== 'completed');
  if (executionFailures.length > 0) {
    blocked = true;
    addIssue(state, 'blocked', 'evalExecutionFailed',
      `Eval chain ${required.key} has ${executionFailures.length} failed or timed-out current run(s).`,
      { selection: required.key });
  }
  const completed = currentRuns.filter((run) => run.status === 'completed' && run.grade !== null);
  const passed = completed.filter((run) => run.grade.passed === true).length;
  const passRate = completed.length === 0 ? 0 : passed / completed.length;
  selection.passRate = passRate;
  if (absent.length === 0 && passRate < required.minimumPassRate) {
    blocked = true;
    addIssue(state, 'blocked', 'evalPassRateBelowRequirement',
      `Eval chain ${required.key} pass rate ${passRate} is below ${required.minimumPassRate}.`,
      { selection: required.key });
  }
  if (spec.baseline.type !== 'none') {
    incomplete = true;
    addIssue(state, 'missing', 'baselinePolicyMissing',
      `Eval chain ${required.key} includes a baseline, but no pre-existing comparison policy is available.`,
      { selection: required.key });
  }
  selection.status = blocked ? 'blocked' : incomplete ? 'incomplete' : 'pass';
  state.checkedEvalSelections.push(selection);
  return { requiredKey: required.key, resultDigest: input.result, valid: !blocked && !incomplete };
}

async function checkEvalRequirements(options, inspection, state) {
  if (inspection.requiredEvals.length === 0) {
    for (const chainPath of options.evalChains) {
      await validateEvalChain(chainPath, inspection, state, options.output);
    }
    return;
  }
  const observed = new Map();
  for (const chainPath of options.evalChains) {
    const checked = await validateEvalChain(chainPath, inspection, state, options.output);
    if (!checked?.requiredKey) continue;
    const existing = observed.get(checked.requiredKey) ?? [];
    existing.push(checked);
    observed.set(checked.requiredKey, existing);
  }
  for (const required of inspection.requiredEvals) {
    const matches = observed.get(required.key) ?? [];
    if (matches.length === 0) {
      addIssue(state, 'missing', 'requiredEvalMissing',
        `A current Eval chain is missing for ${required.key}.`, { selection: required.key });
      continue;
    }
    if (new Set(matches.map((entry) => entry.resultDigest)).size > 1) {
      addIssue(state, 'invalid', 'conflictingEvalResults',
        `Required Eval selection ${required.key} has conflicting result inputs.`,
        { selection: required.key });
    } else if (matches.length > 1) {
      addIssue(state, 'warning', 'duplicateEvalChain',
        `Required Eval selection ${required.key} repeats the same result input.`,
        { selection: required.key });
    }
  }
}

function currentStatus(state) {
  if (state.unsupported.length > 0) return 'unsupported';
  if (state.invalid.length > 0) return 'invalid';
  if (state.blocked.length > 0) return 'blocked';
  if (state.missing.length > 0) return 'incomplete';
  return 'ready';
}

function finalResult(state) {
  const status = currentStatus(state);
  return {
    version: 1,
    producer: 'check-aw-release',
    status,
    ready: status === 'ready',
    target: state.target,
    checkedSubjects: state.checkedSubjects,
    checkedEvalSelections: state.checkedEvalSelections,
    missing: state.missing,
    failures: [...state.unsupported, ...state.invalid, ...state.blocked],
    warnings: state.warnings,
    inputDigests: state.inputDigests,
  };
}

function renderText(result) {
  const lines = [
    `AW release check: ${result.status}`,
    `Target: ${result.target.kind ?? 'unknown'} ${result.target.id ?? result.target.path ?? 'unknown'}`,
    `Checked subjects: ${result.checkedSubjects.length}`,
    `Checked Eval selections: ${result.checkedEvalSelections.length}`,
  ];
  for (const item of result.missing) lines.push(`MISSING ${item.code}: ${item.message}`);
  for (const item of result.failures) lines.push(`FAIL ${item.code}: ${item.message}`);
  for (const item of result.warnings) lines.push(`WARNING ${item.code}: ${item.message}`);
  return `${lines.join('\n')}\n`;
}

async function emit(result, options) {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options?.output) {
    await writeFile(options.output, json, { encoding: 'utf8', flag: options.overwrite ? 'w' : 'wx' });
  }
  process.stdout.write(options?.format === 'text' ? renderText(result) : json);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const state = createState(null);
    addIssue(state, 'invalid', 'invalidArguments', error.message);
    const result = finalResult(state);
    await emit(result, { format: 'json' });
    process.exitCode = STATUS_EXIT[result.status];
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const state = createState(options.target);
  try {
    if (options.output) {
      try {
        options.output = await assertSafeOutput(options.output, options.overwrite);
        await assertOutputSeparated(options.output, [
          options.evidence,
          ...options.materializations,
          ...options.evalChains,
        ]);
      } catch (error) {
        options.output = null;
        throw error;
      }
    }
    await assertPathComponents(options.evidence, 'file', 'AWReviewEvidence');
    for (const materialization of options.materializations) {
      await assertPathComponents(materialization, 'file', 'Materialization receipt');
      state.inputDigests.materializations.push({
        path: materialization,
        digest: await fileDigest(materialization),
      });
    }
    const inspectionArgs = ['review', 'inspect', options.target, '--view', 'release'];
    for (const materialization of options.materializations) {
      inspectionArgs.push('--materialization', materialization);
    }
    inspectionArgs.push('--json');
    const inspection = validateInspection(await runPublicJson('aw', inspectionArgs));
    const workspaceRoot = await realpath(inspection.workspace.root);
    await assertOutputSeparated(options.output, [
      inspection.target.path,
      ...inspection.subjects
        .filter((subject) => subject.kind === 'materialized-skill')
        .map((subject) => subject.path),
      ...inspection.materializations.flatMap((materialization) =>
        materialization.verifiedBinding?.artifacts?.map((artifact) => artifact.path) ?? []),
    ]);
    state.target = {
      kind: inspection.target.kind,
      id: inspection.target.id,
      path: workspaceRelative(workspaceRoot, inspection.target.path, 'Inspection target'),
      digest: null,
    };
    inspectIssues(inspection, state);
    const requiredSubjects = deriveRequiredSubjects(inspection, workspaceRoot, state);
    const currentTarget = requiredSubjects.find((subject) =>
      subject.kind === inspection.target.kind
      && subject.path === state.target.path
      && subject.profile === 'none');
    if (!currentTarget) throw new UnsupportedError('Review inspection cannot derive the current target container.');
    state.target.digest = currentTarget.digest;
    const evidence = validateEvidenceShape(JSON.parse(await readFile(options.evidence, 'utf8')));
    state.inputDigests.evidence = { path: options.evidence, digest: await fileDigest(options.evidence) };
    const evidenceReferences = await validateEvidenceReferences(evidence, options.evidence);
    await assertOutputSeparated(options.output, evidenceReferences);
    if (evidence.target.kind !== state.target.kind || evidence.target.path !== state.target.path) {
      addIssue(state, 'invalid', 'evidenceTargetMismatch',
        'AWReviewEvidence target kind or path does not match the current inspected target.');
    } else if (evidence.target.digest !== state.target.digest) {
      addIssue(state, 'blocked', 'evidenceTargetDigestMismatch',
        'AWReviewEvidence target digest does not match the current source container.');
    }
    matchReviewEvidence(requiredSubjects, evidence, state);
    await checkEvalRequirements(options, inspection, state);
  } catch (error) {
    if (error instanceof UnsafeOutputError) options.output = null;
    addIssue(
      state,
      error instanceof UnsupportedError ? 'unsupported' : 'invalid',
      error instanceof UnsupportedError ? 'requiredContractUnsupported' : 'invalidInput',
      error instanceof Error ? error.message : String(error),
    );
  }
  const result = finalResult(state);
  try {
    await emit(result, options);
  } catch (error) {
    process.stderr.write(`[ERROR] Cannot write release check output: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  process.exitCode = STATUS_EXIT[result.status];
}

await main();
