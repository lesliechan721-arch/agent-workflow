import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  validateProviderCapabilities,
  validateProviderOutput,
  type EvalProviderOutput,
  type RuntimeCapabilities,
} from '@lesliechan721/agent-skill-eval'
import fs from 'fs-extra'

import {
  normalizeConversationProviderCase,
  runCodexEvalIsolationProbe,
  runCodexConversationProviderCase,
  type AppServerRunEvidence,
} from '../../scripts/codex-eval-app-server.js'
import {
  runCodexTriggerProviderCase,
  summarizeTriggerCase,
  type TriggerRunEvidence,
} from '../../scripts/codex-trigger-eval.js'
import { cleanCodexEvalRuntimeConfig } from '../../scripts/codex-eval-runtime-config.js'
import { inspectCodexEvalHostIsolation } from '../../scripts/codex-eval-isolation.js'
import type {
  AwSkillEvalConversationSuite,
} from './manifest.js'
import {
  normalizeAwSkillEvalTriggerCase,
  type AwSkillEvalTriggerSuiteCaseContract,
} from '../../scripts/aw-skill-eval-cases.js'

export const BUILTIN_EVAL_PROVIDER_VERSION = 'builtin-v1'
export const CUSTOM_EVAL_PROVIDER_VERSION = 'manifest-v1'

export const CODEX_PROVIDER_ENVIRONMENT_ALLOWLIST = [
  'ALL_PROXY',
  'AW_SKILL_EVAL_CODEX_BIN',
  'AW_SKILL_EVAL_CODEX_MODEL',
  'CODEX_HOME',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'OPENAI_API_KEY',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
] as const

const builtinCapabilities: RuntimeCapabilities['capabilities'] = {
  triggerDiscovery: false,
  conversation: false,
  skillPathExecution: true,
  previousVersionBaseline: true,
  withoutSkillBaseline: true,
  cleanContext: true,
  parallelRuns: false,
  toolTrace: true,
  tokenUsage: true,
  duration: true,
  sandbox: true,
  materialization: true,
}

export function builtInEvalProviderCapabilities(
  kind: 'codex-trigger' | 'codex-conversation',
): RuntimeCapabilities {
  return {
    schemaVersion: 2,
    provider: kind,
    providerVersion: BUILTIN_EVAL_PROVIDER_VERSION,
    capabilities: {
      ...builtinCapabilities,
      triggerDiscovery: kind === 'codex-trigger',
      conversation: kind === 'codex-conversation',
    },
    limitations: [
      'Codex app-server isolation is configuration isolation, not OS-level containment.',
      'Usage is null when Codex does not emit token usage for the run.',
    ],
  }
}

export function encodeCustomProviderCapabilities(capabilities: RuntimeCapabilities): string {
  return Buffer.from(JSON.stringify(capabilities), 'utf8').toString('base64url')
}

export async function decodeCustomProviderCapabilities(encoded: string): Promise<RuntimeCapabilities> {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch (error) {
    throw new Error(`Custom provider capabilities are invalid: ${(error as Error).message}`)
  }
  const validation = await validateProviderCapabilities(value)
  if (!validation.valid || !validation.calculated) {
    throw new Error(`Custom provider capabilities are invalid: ${validation.errors.join('; ')}`)
  }
  return validation.calculated
}

interface ProviderInvocation {
  caseValue: Record<string, unknown>
  caseId: string
  configuration: string
  skillMode: 'with-skill' | 'without-skill' | 'previous-version'
  skillPath: string | null
  outputDir: string
  runtimeInputs: Record<string, string>
}

interface ProviderSuiteBase {
  id: string
  kind: 'trigger' | 'conversation' | 'provider'
  skill: string
  skills: string[]
  perRunTimeoutMs: number
}

interface CustomProviderSuite extends ProviderSuiteBase {
  kind: 'provider'
  provider: {
    id: string
    entry: string
  }
}

export interface CustomEvalProviderInput {
  case: Record<string, unknown>
  caseId: string
  configuration: string
  skillMode: ProviderInvocation['skillMode']
  skillPath: string | null
  workspacePath: string
  outputDir: string
  runtimeInputs: Readonly<Record<string, string>>
}

export type CustomEvalProviderEntry = (
  input: CustomEvalProviderInput,
) => Promise<EvalProviderOutput> | EvalProviderOutput

async function rejectProviderStdout<T>(operation: () => Promise<T> | T): Promise<T> {
  const stdout = process.stdout
  const originalWrite = stdout.write
  let wroteStdout = false
  stdout.write = ((
    _chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    wroteStdout = true
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    done?.()
    return true
  }) as typeof stdout.write
  try {
    const result = await operation()
    if (wroteStdout) throw new Error('Custom provider entry must not write to stdout.')
    return result
  } finally {
    stdout.write = originalWrite
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Provider requires ${name}.`)
  return value
}

async function readProviderInvocation(env: NodeJS.ProcessEnv): Promise<ProviderInvocation> {
  const casePath = requiredEnvironment(env, 'AGENT_EVAL_CASE_PATH')
  const caseValue = record(await fs.readJson(casePath), 'provider case')
  const caseId = requiredEnvironment(env, 'AGENT_EVAL_CASE_ID')
  if (caseValue.id !== caseId) throw new Error('Provider case id does not match AGENT_EVAL_CASE_ID.')
  const skillMode = requiredEnvironment(env, 'AGENT_EVAL_SKILL_MODE')
  if (!['with-skill', 'without-skill', 'previous-version'].includes(skillMode)) {
    throw new Error('AGENT_EVAL_SKILL_MODE is invalid.')
  }
  const runtimeInputs = record(
    JSON.parse(requiredEnvironment(env, 'AGENT_EVAL_RUNTIME_INPUTS_JSON')),
    'provider runtime inputs',
  )
  for (const [id, inputPath] of Object.entries(runtimeInputs)) {
    if (typeof inputPath !== 'string' || !(await fs.lstat(inputPath)).isDirectory()) {
      throw new Error(`Provider runtime input ${id} must be a directory.`)
    }
  }
  const outputDir = requiredEnvironment(env, 'AGENT_EVAL_OUTPUT_DIR')
  if (!(await fs.lstat(outputDir)).isDirectory()) throw new Error('Provider output directory must exist.')
  const skillPath = env.AGENT_EVAL_SKILL_PATH ?? null
  if (skillMode === 'without-skill' && skillPath !== null) {
    throw new Error('without-skill provider invocation must not have AGENT_EVAL_SKILL_PATH.')
  }
  if (skillMode !== 'without-skill' && skillPath === null) {
    throw new Error(`${skillMode} provider invocation requires AGENT_EVAL_SKILL_PATH.`)
  }
  return {
    caseValue,
    caseId,
    configuration: requiredEnvironment(env, 'AGENT_EVAL_CONFIGURATION'),
    skillMode: skillMode as ProviderInvocation['skillMode'],
    skillPath,
    outputDir,
    runtimeInputs: runtimeInputs as Record<string, string>,
  }
}

async function readSuite(invocation: ProviderInvocation): Promise<{
  root: string
  evalRoot: string
  suite: ProviderSuiteBase & Record<string, unknown>
}> {
  const root = invocation.runtimeInputs['eval-suite']
  if (!root) throw new Error('Provider requires the eval-suite runtime input.')
  const suite = record(await fs.readJson(path.join(root, 'suite.json')), 'provider suite')
  if (
    typeof suite.id !== 'string'
    || typeof suite.skill !== 'string'
    || !Array.isArray(suite.skills)
    || suite.skills.some((entry) => typeof entry !== 'string')
    || !Number.isInteger(suite.perRunTimeoutMs)
  ) throw new Error('Provider suite snapshot is invalid.')
  return {
    root,
    evalRoot: path.join(root, 'eval-root'),
    suite: suite as ProviderSuiteBase & Record<string, unknown>,
  }
}

async function materializeSubject(options: {
  invocation: ProviderInvocation
  skillName: string
}): Promise<string> {
  const subjectBase = options.invocation.runtimeInputs['aw-subject-base']
  if (!subjectBase) throw new Error('Provider requires the aw-subject-base runtime input.')
  const subjectRoot = path.join(options.invocation.outputDir, '.aw-provider-subject')
  await fs.remove(subjectRoot)
  await fs.copy(subjectBase, subjectRoot, { dereference: false, errorOnExist: true })
  const targetRoot = path.join(subjectRoot, '.agents', 'skills', options.skillName)
  await fs.remove(targetRoot)
  if (options.invocation.skillMode !== 'without-skill') {
    await fs.ensureDir(path.dirname(targetRoot))
    await fs.copy(options.invocation.skillPath!, targetRoot, {
      dereference: false,
      errorOnExist: true,
    })
  }
  return subjectRoot
}

function usageRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

async function writeProviderArtifacts(options: {
  outputDir: string
  evidence: TriggerRunEvidence | AppServerRunEvidence
  finalMessages: string[]
}): Promise<EvalProviderOutput['artifacts']> {
  const evidencePath = path.join(options.outputDir, 'provider-evidence.json')
  const tracePath = path.join(options.outputDir, 'provider-trace.json')
  await Promise.all([
    fs.writeJson(evidencePath, options.evidence, { spaces: 2 }),
    fs.writeJson(
      tracePath,
      'eventTrace' in options.evidence
        ? options.evidence.eventTrace
        : options.evidence.event_trace,
      { spaces: 2 },
    ),
  ])
  const artifacts: EvalProviderOutput['artifacts'] = [
    { path: path.basename(evidencePath), role: 'report' },
    { path: path.basename(tracePath), role: 'trace' },
  ]
  if (options.finalMessages.length > 0) {
    const outputPath = path.join(options.outputDir, 'model-output.txt')
    await fs.writeFile(outputPath, `${options.finalMessages.join('\n\n')}\n`)
    artifacts.push({ path: path.basename(outputPath), role: 'output' })
  }
  return artifacts
}

async function runCodexTriggerProvider(
  invocation: ProviderInvocation,
  suiteRoot: Awaited<ReturnType<typeof readSuite>>,
  env: NodeJS.ProcessEnv,
): Promise<EvalProviderOutput> {
  if (suiteRoot.suite.kind !== 'trigger') throw new Error('codex-trigger requires a trigger suite.')
  const suite = suiteRoot.suite as unknown as AwSkillEvalTriggerSuiteCaseContract
  const evalCase = normalizeAwSkillEvalTriggerCase(invocation.caseValue, 0, suite)
  const subjectRoot = await materializeSubject({ invocation, skillName: suite.skill })
  try {
    const runtime = cleanCodexEvalRuntimeConfig(env, env.AW_SKILL_EVAL_CODEX_MODEL)
    if (suite.isolation === 'strict') {
      await inspectCodexEvalHostIsolation({ sourceEnv: env })
      await runCodexEvalIsolationProbe({
        subjectRoot,
        skillName: suite.skill,
        skillNames: suite.skills.filter((name) =>
          name !== suite.skill || invocation.skillMode !== 'without-skill'),
        codexBin: env.AW_SKILL_EVAL_CODEX_BIN ?? 'codex',
        codexRuntime: runtime,
        sourceEnv: env,
        processManagement: {
          mode: 'unmanaged-confirmed',
          inspectionAvailable: false,
          userAcknowledged: true,
          descendantCleanupGuaranteed: false,
          limitation: 'The AwSkillEval engine owns the provider process tree and timeout.',
        },
      })
    }
    const evidence = await runCodexTriggerProviderCase({
      suite,
      evalCase,
      subjectRoot,
      fixtureRoot: suiteRoot.root,
      codexBin: env.AW_SKILL_EVAL_CODEX_BIN ?? 'codex',
      ...(runtime.model ? { model: runtime.model } : {}),
      codexRuntime: runtime,
      sourceEnv: env,
    })
    const summary = summarizeTriggerCase(suite, evalCase, [evidence])
    return {
      schemaVersion: 1,
      provider: { id: 'codex-trigger', version: BUILTIN_EVAL_PROVIDER_VERSION },
      usage: usageRecord(evidence.usage),
      grading: {
        grader: { id: 'codex-trigger-mechanical', version: '1' },
        result: { passed: summary.passed, complete: summary.complete },
      },
      artifacts: await writeProviderArtifacts({
        outputDir: invocation.outputDir,
        evidence,
        finalMessages: evidence.final_message ? [evidence.final_message] : [],
      }),
    }
  } finally {
    await fs.remove(subjectRoot)
  }
}

async function runCodexConversationProvider(
  invocation: ProviderInvocation,
  suiteRoot: Awaited<ReturnType<typeof readSuite>>,
  env: NodeJS.ProcessEnv,
): Promise<EvalProviderOutput> {
  if (suiteRoot.suite.kind !== 'conversation') {
    throw new Error('codex-conversation requires a conversation suite.')
  }
  const suite = suiteRoot.suite as unknown as AwSkillEvalConversationSuite & { skill: string }
  const subjectRoot = await materializeSubject({ invocation, skillName: suite.skill })
  try {
    const suitePathPrepend = suite.environment?.pathPrepend ?? []
    const evalCase = normalizeConversationProviderCase({
      value: invocation.caseValue,
      expectedSkill: suite.skill,
      fixtureRoot: suiteRoot.evalRoot,
      suitePathPrepend: suitePathPrepend.map((entry) => entry.replace(/^eval-root\//u, '')),
    })
    const runtime = cleanCodexEvalRuntimeConfig(env, env.AW_SKILL_EVAL_CODEX_MODEL)
    if (suite.isolation === 'strict') await inspectCodexEvalHostIsolation({ sourceEnv: env })
    const evidence = await runCodexConversationProviderCase({
      evalCase,
      sourceProjectRoot: subjectRoot,
      skillMode: invocation.skillMode,
      skillName: suite.skill,
      skillNames: suite.skills,
      codexBin: env.AW_SKILL_EVAL_CODEX_BIN ?? 'codex',
      ...(runtime.model ? { model: runtime.model } : {}),
      codexRuntime: runtime,
      timeoutMs: suite.perRunTimeoutMs,
      sourceEnv: env,
      isolation: suite.isolation,
      forbiddenHostRoots: Object.values(invocation.runtimeInputs),
      environmentFixtures: [
        ...suitePathPrepend.map((relativePath) => ({
          fixtureRoot: suiteRoot.root,
          relativePath,
        })),
        ...evalCase.environmentPathPrepend.map((relativePath) => ({
          fixtureRoot: suiteRoot.evalRoot,
          relativePath,
        })),
      ],
    })
    return {
      schemaVersion: 1,
      provider: { id: 'codex-conversation', version: BUILTIN_EVAL_PROVIDER_VERSION },
      usage: usageRecord(evidence.usage),
      grading: {
        grader: { id: 'codex-conversation-mechanical', version: '1' },
        result: {
          passed: evidence.mechanicalPassed,
          complete: evidence.complete,
          qualitativeReview: 'required',
        },
      },
      artifacts: await writeProviderArtifacts({
        outputDir: invocation.outputDir,
        evidence,
        finalMessages: evidence.finalMessages,
      }),
    }
  } finally {
    await fs.remove(subjectRoot)
  }
}

async function runCustomProvider(
  invocation: ProviderInvocation,
  suiteRoot: Awaited<ReturnType<typeof readSuite>>,
): Promise<EvalProviderOutput> {
  if (suiteRoot.suite.kind !== 'provider') throw new Error('custom requires a provider suite.')
  const suite = suiteRoot.suite as unknown as CustomProviderSuite
  const provider = record(suite.provider, 'custom provider') as CustomProviderSuite['provider']
  if (typeof provider.id !== 'string' || typeof provider.entry !== 'string') {
    throw new Error('Custom provider snapshot is invalid.')
  }
  const entryPath = path.resolve(suiteRoot.root, provider.entry)
  const relative = path.relative(suiteRoot.root, entryPath)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Custom provider entry leaves the eval-suite runtime input.')
  }
  const entryStat = await fs.lstat(entryPath)
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
    throw new Error('Custom provider entry must be a regular file in the eval-suite runtime input.')
  }
  const loaded = await rejectProviderStdout(async () =>
    await import(pathToFileURL(entryPath).href) as {
      runEvalProvider?: CustomEvalProviderEntry
    })
  if (typeof loaded.runEvalProvider !== 'function') {
    throw new Error('Custom provider entry must export runEvalProvider(input).')
  }
  const subjectRoot = await materializeSubject({ invocation, skillName: suite.skill })
  try {
    const input: CustomEvalProviderInput = {
      case: invocation.caseValue,
      caseId: invocation.caseId,
      configuration: invocation.configuration,
      skillMode: invocation.skillMode,
      skillPath: invocation.skillPath,
      workspacePath: subjectRoot,
      outputDir: invocation.outputDir,
      runtimeInputs: Object.freeze({ ...invocation.runtimeInputs }),
    }
    const value = await rejectProviderStdout(() => loaded.runEvalProvider!(input))
    const validation = await validateProviderOutput(value)
    if (!validation.valid || !validation.calculated) {
      throw new Error(`Custom provider output is invalid: ${validation.errors.join('; ')}`)
    }
    if (
      validation.calculated.provider.id !== provider.id
      || validation.calculated.provider.version !== CUSTOM_EVAL_PROVIDER_VERSION
    ) throw new Error('Custom provider output identity does not match the Plan.')
    return validation.calculated
  } finally {
    await fs.remove(subjectRoot)
  }
}

export async function runSkillEvalProvider(
  kind: 'codex-trigger' | 'codex-conversation' | 'custom',
  env: NodeJS.ProcessEnv,
): Promise<EvalProviderOutput> {
  const invocation = await readProviderInvocation(env)
  const suite = await readSuite(invocation)
  if (kind === 'codex-trigger') return runCodexTriggerProvider(invocation, suite, env)
  if (kind === 'codex-conversation') return runCodexConversationProvider(invocation, suite, env)
  return runCustomProvider(invocation, suite)
}
