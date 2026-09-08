import crypto from 'node:crypto'
import path from 'node:path'

import {
  canonicalJson,
  type EvalProvider,
  type SelectedCasesDocument,
} from '@lesliechan721/agent-skill-eval'
import fs from 'fs-extra'

import {
  resolveAwSkillEvalCustomCommand,
  type AwSkillEvalManifestV1Defaults,
  type AwSkillEvalManifestV1Suite,
} from '../eval/manifest-v1.js'
import { calculateFileDigest } from '../utils/bundle-integrity.js'

const digestPattern = /^sha256:[0-9a-f]{64}$/u
const safeSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

interface EvalFixtureFile {
  path: string
  mode: '100644' | '100755'
  digest: string
}

interface EvalFixtureRecords {
  directories: string[]
  files: EvalFixtureFile[]
}

export type AwSourceBindingEvalCaseSelection =
  | { split: string | null; caseId: string | null }
  | { caseIds: readonly string[] }

export interface AwSourceBindingEvalInput {
  manifestPath: string
  casesPath: string
  selectedCaseIds: string[]
  suiteDefaultsDigest: string
  selectedCasesDigest: string
  fixturesDigest: string
  providerDigest: string
  inputDigest: string
}

export interface ResolvedEvalSourceBindingInput {
  input: AwSourceBindingEvalInput
  selectedCases: SelectedCasesDocument
}

function digestCanonical(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function strictRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key))
}

function digestString(value: unknown): value is string {
  return typeof value === 'string' && digestPattern.test(value)
}

function safeSegment(value: unknown): value is string {
  return typeof value === 'string' && safeSegmentPattern.test(value)
}

function normalizeRelativePath(value: unknown): string {
  if (
    typeof value !== 'string'
    || value === ''
    || value.includes('\\')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value === '..'
    || value.startsWith('../')
  ) throw new Error('Eval source input path must be a safe relative POSIX path.')
  return value
}

function workspaceRelativePath(workspaceRoot: string, target: string): string {
  const relative = path.relative(workspaceRoot, target).split(path.sep).join('/')
  return normalizeRelativePath(relative)
}

function evalInputDigest(input: Omit<AwSourceBindingEvalInput, 'inputDigest'>): string {
  return digestCanonical(input)
}

export function parseAwSourceBindingEvalInput(value: unknown): AwSourceBindingEvalInput {
  const row = value as Record<string, unknown>
  if (
    !strictRecord(row, [
      'manifestPath',
      'casesPath',
      'selectedCaseIds',
      'suiteDefaultsDigest',
      'selectedCasesDigest',
      'fixturesDigest',
      'providerDigest',
      'inputDigest',
    ])
    || !Array.isArray(row.selectedCaseIds)
    || row.selectedCaseIds.length === 0
    || !digestString(row.suiteDefaultsDigest)
    || !digestString(row.selectedCasesDigest)
    || !digestString(row.fixturesDigest)
    || !digestString(row.providerDigest)
    || !digestString(row.inputDigest)
  ) throw new Error('Eval source input is invalid.')
  const selectedCaseIds = row.selectedCaseIds.map((entry) => {
    if (!safeSegment(entry)) throw new Error('Eval source input case id is invalid.')
    return entry
  })
  if (new Set(selectedCaseIds).size !== selectedCaseIds.length) {
    throw new Error('Eval source input case ids must be unique.')
  }
  const unsigned = {
    manifestPath: normalizeRelativePath(row.manifestPath),
    casesPath: normalizeRelativePath(row.casesPath),
    selectedCaseIds,
    suiteDefaultsDigest: row.suiteDefaultsDigest,
    selectedCasesDigest: row.selectedCasesDigest,
    fixturesDigest: row.fixturesDigest,
    providerDigest: row.providerDigest,
  }
  if (row.inputDigest !== evalInputDigest(unsigned)) {
    throw new Error('Eval source input digest is invalid.')
  }
  return { ...unsigned, inputDigest: row.inputDigest }
}

export function selectAwSourceBindingEvalCases(
  document: SelectedCasesDocument,
  selection: AwSourceBindingEvalCaseSelection,
): SelectedCasesDocument {
  if ('caseIds' in selection) {
    if (
      selection.caseIds.length === 0
      || selection.caseIds.some((caseId) => !safeSegment(caseId))
      || new Set(selection.caseIds).size !== selection.caseIds.length
    ) throw new Error('Eval case id selection is invalid.')
    const requested = new Set(selection.caseIds)
    const cases = document.cases.filter((entry) => requested.has(entry.id))
    if (cases.length !== requested.size) throw new Error('Eval case selection matched no cases.')
    return { ...document, cases }
  }
  if (selection.split !== null && selection.split !== 'all' && !safeSegment(selection.split)) {
    throw new Error('Eval split must be a safe path segment or all.')
  }
  if (selection.caseId !== null && !safeSegment(selection.caseId)) {
    throw new Error('Eval case id must be a safe path segment.')
  }
  const splitCases = selection.split === null || selection.split === 'all'
    ? document.cases
    : document.cases.filter((entry) => entry.split === selection.split)
  const cases = selection.caseId === null
    ? splitCases
    : splitCases.filter((entry) => entry.id === selection.caseId)
  if (cases.length === 0) throw new Error('Eval case selection matched no cases.')
  return { ...document, cases }
}

export function computeAwSourceBindingSelectedCasesDigest(
  document: SelectedCasesDocument,
): string {
  return digestCanonical(document)
}

export function computeAwSourceBindingSuiteDefaultsDigest(
  suite: AwSkillEvalManifestV1Suite,
  defaults: AwSkillEvalManifestV1Defaults,
): string {
  return digestCanonical({ suite, defaults })
}

export async function resolveAwSourceBindingEvalProvider(options: {
  evalRoot: string
  preparedEvalRoot: string
  suite: AwSkillEvalManifestV1Suite
}): Promise<EvalProvider> {
  if (options.suite.kind === 'trigger') return 'codex-trigger'
  if (options.suite.kind === 'conversation') return 'codex-conversation'
  const resolved = await resolveAwSkillEvalCustomCommand(options.evalRoot, options.suite.provider!)
  const command = [...resolved.command]
  for (const [index, { prefix, relative }] of resolved.localArguments) {
    if (!await fs.pathExists(path.join(options.preparedEvalRoot, relative))) {
      throw new Error(`Prepared custom provider asset is missing: ${relative}`)
    }
    command[index] = `${prefix}workspace/eval/${relative}`
  }
  return options.suite.provider!.type === 'custom-process'
    ? { type: 'custom-process', command }
    : {
        type: 'codex-workflow',
        command,
        allowedModels: options.suite.provider!.allowedModels,
      }
}

async function collectFixtureRecords(
  root: string,
  excludedPaths: ReadonlySet<string>,
): Promise<EvalFixtureRecords> {
  const rootInfo = await fs.lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('Eval fixture root must be a regular directory.')
  }
  const directories: string[] = []
  const files: EvalFixtureFile[] = []
  const walk = async (directory: string, relativeDirectory = ''): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => compareText(left.name, right.name))
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      const relativePath = path.posix.join(relativeDirectory, entry.name)
      if (excludedPaths.has(relativePath)) continue
      const info = await fs.lstat(absolutePath)
      if (info.isSymbolicLink()) throw new Error(`Eval fixture path contains a symbolic link: ${relativePath}`)
      if (info.isDirectory()) {
        directories.push(relativePath)
        await walk(absolutePath, relativePath)
      } else if (info.isFile()) {
        files.push({
          path: relativePath,
          mode: process.platform !== 'win32' && (info.mode & 0o111) !== 0 ? '100755' : '100644',
          digest: await calculateFileDigest(absolutePath),
        })
      } else {
        throw new Error(`Eval fixture path has an unsupported node: ${relativePath}`)
      }
    }
  }
  await walk(root)
  directories.sort(compareText)
  files.sort((left, right) => compareText(left.path, right.path))
  return { directories, files }
}

export async function resolveEvalSourceBindingInput(options: {
  workspaceRoot: string
  evalRoot: string
  manifestPath: string
  suite: AwSkillEvalManifestV1Suite
  defaults: AwSkillEvalManifestV1Defaults
  cases: SelectedCasesDocument
  corpusPaths: readonly string[]
  selection: AwSourceBindingEvalCaseSelection
  providerDigest: string
  preparedEvalRoot?: string
}): Promise<ResolvedEvalSourceBindingInput> {
  const selectedCases = selectAwSourceBindingEvalCases(options.cases, options.selection)
  if (!digestString(options.providerDigest)) throw new Error('Eval provider digest is invalid.')
  const fixtureRecords = await collectFixtureRecords(
    options.evalRoot,
    new Set(['manifest.json', ...options.corpusPaths]),
  )
  const fixturesDigest = digestCanonical(fixtureRecords)
  if (options.preparedEvalRoot) {
    const preparedFixtures = await collectFixtureRecords(options.preparedEvalRoot, new Set())
    if (digestCanonical(preparedFixtures) !== fixturesDigest) {
      throw new Error('Prepared Eval fixtures do not match the current source fixtures.')
    }
  }
  const unsigned = {
    manifestPath: workspaceRelativePath(options.workspaceRoot, options.manifestPath),
    casesPath: workspaceRelativePath(options.workspaceRoot, path.join(options.evalRoot, options.suite.cases)),
    selectedCaseIds: selectedCases.cases.map((entry) => entry.id),
    suiteDefaultsDigest: computeAwSourceBindingSuiteDefaultsDigest(options.suite, options.defaults),
    selectedCasesDigest: computeAwSourceBindingSelectedCasesDigest(selectedCases),
    fixturesDigest,
    providerDigest: options.providerDigest,
  }
  return {
    selectedCases,
    input: { ...unsigned, inputDigest: evalInputDigest(unsigned) },
  }
}
