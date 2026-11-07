import type { CodexOperationRequirement } from '../types.js';
import { DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS } from '../constants.js';
import { extractStrictSemVerTokenFromVersionOutput, getCodexOperationRequirement } from './agent-version.js';
import {
  discoverCodexExecutables,
  rethrowFatalError,
  type CodexExecutableDiscoveryOptions,
} from './codex-executable-discovery.js';
import { compareStrictSemVer } from './manifest.js';
import { runNativeCli, type CodexManager, type NativeCliRunner } from './native-cli.js';
import { getCodexHome } from './state-paths.js';

export type CodexManagerErrorCode = 'codexCliNotFound' | 'codexSystemCliUnsupported';

export class CodexManagerError extends Error {
  readonly code: CodexManagerErrorCode;

  constructor(code: CodexManagerErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'CodexManagerError';
    this.code = code;
  }
}

export interface CodexManagerOptions extends CodexExecutableDiscoveryOptions {
  operationRequirement?: CodexOperationRequirement;
  runner?: NativeCliRunner;
}

export interface CodexOperationConsumer {
  support: 'observed';
  manager: CodexManager;
  requirement: CodexOperationRequirement;
}

export interface ResolveCodexOperationConsumerOptions extends CodexManagerOptions {
  operationRequirement: CodexOperationRequirement;
}

export interface InspectSystemCodexOptions extends CodexExecutableDiscoveryOptions {
  runner?: NativeCliRunner;
  operationRequirement: CodexOperationRequirement;
}

interface CodexInspectionEvidence {
  requiredMinVersion: string;
  diagnostics?: string[];
}

export type SystemCodexInspection = CodexInspectionEvidence & (
  | { state: 'missing' }
  | { state: 'unobserved' }
  | { state: 'compatible'; detectedVersion: string; manager: CodexManager }
  | {
      state: 'incompatible';
      code: 'codexSystemCliUnsupported';
      detectedVersion: string;
      diagnostic: string;
    }
  | { state: 'unresolved'; code: 'codexSystemCliUnsupported'; diagnostic: string }
);

export type CodexManagerPreview =
  | { state: 'system'; manager: CodexManager; diagnostics?: string[] }
  | { state: 'blocked'; code: CodexManagerErrorCode; diagnostic: string; diagnostics?: string[] };

const MISSING_DIAGNOSTIC =
  'No Codex CLI was found in PATH or a supported Codex App. Install Codex CLI or App, repair PATH, and retry.';

function unsupportedDiagnostic(requiredMinVersion: string, detectedVersion?: string): string {
  const detected = detectedVersion ? ` Detected ${detectedVersion}.` : '';
  return `The Codex CLI is unsupported or its version could not be confirmed.${detected} Required minimum: ${requiredMinVersion}. Install or upgrade Codex CLI or App, repair its launcher or PATH, and retry.`;
}

/** Discovers PATH and supported Apps without writing to the host or AW state. */
export async function inspectSystemCodex(
  options: InspectSystemCodexOptions,
): Promise<SystemCodexInspection> {
  const requiredMinVersion = options.operationRequirement.minimumVersion;
  const discovery = await discoverCodexExecutables(options);
  const diagnostics = [...discovery.diagnostics];
  let selected: CodexManager | undefined;
  for (const candidate of discovery.candidates) {
    options.signal?.throwIfAborted();
    let version: string | null = null;
    try {
      const env = options.env ?? process.env;
      const result = await runNativeCli({
        command: candidate.manager.command,
        args: [...candidate.manager.argsPrefix, '--version'],
        agentKind: 'codex',
        cwd: options.cwd,
        env: { ...env, CODEX_HOME: getCodexHome(env) },
        timeoutMs: DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS,
        signal: options.signal,
      }, options.runner);
      if (result.exitCode === 0) {
        version = extractStrictSemVerTokenFromVersionOutput(`${result.stdout}\n${result.stderr}`);
      }
    } catch (error) {
      rethrowFatalError(error);
    }
    if (!version) {
      const message = 'A Codex CLI candidate failed its version query or returned an invalid version and was excluded.';
      if (!diagnostics.includes(message)) diagnostics.push(message);
      continue;
    }
    if (candidate.expectedVersion && version !== candidate.expectedVersion) {
      const message = 'A Windows npm Codex launcher did not match its package version and was excluded. Repair the npm installation.';
      if (!diagnostics.includes(message)) diagnostics.push(message);
      continue;
    }
    if (!selected || compareStrictSemVer(version, selected.version) > 0) {
      selected = { ...candidate.manager, version };
    }
  }
  const evidence: CodexInspectionEvidence = {
    requiredMinVersion,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
  if (!selected) {
    if (!discovery.foundEntry && diagnostics.length === 0) return { ...evidence, state: 'missing' };
    return {
      ...evidence,
      state: 'unresolved',
      code: 'codexSystemCliUnsupported',
      diagnostic: unsupportedDiagnostic(requiredMinVersion),
    };
  }
  if (compareStrictSemVer(selected.version, requiredMinVersion) < 0) {
    return {
      ...evidence,
      state: 'incompatible',
      code: 'codexSystemCliUnsupported',
      detectedVersion: selected.version,
      diagnostic: unsupportedDiagnostic(requiredMinVersion, selected.version),
    };
  }
  return { ...evidence, state: 'compatible', detectedVersion: selected.version, manager: selected };
}

export async function previewCodexManager(
  options: CodexManagerOptions = {},
): Promise<CodexManagerPreview> {
  const inspection = await inspectSystemCodex({
    ...options,
    operationRequirement: options.operationRequirement ?? getCodexOperationRequirement('user'),
  });
  const evidence = inspection.diagnostics ? { diagnostics: inspection.diagnostics } : {};
  if (inspection.state === 'compatible') {
    return { ...evidence, state: 'system', manager: inspection.manager };
  }
  if (inspection.state === 'missing') {
    return { ...evidence, state: 'blocked', code: 'codexCliNotFound', diagnostic: MISSING_DIAGNOSTIC };
  }
  return {
    ...evidence,
    state: 'blocked',
    code: 'codexSystemCliUnsupported',
    diagnostic: 'diagnostic' in inspection
      ? inspection.diagnostic
      : unsupportedDiagnostic(inspection.requiredMinVersion),
  };
}

export async function resolveCodexManager(
  options: CodexManagerOptions = {},
): Promise<CodexManager> {
  const preview = await previewCodexManager(options);
  if (preview.state === 'system') return preview.manager;
  throw new CodexManagerError(preview.code, preview.diagnostic);
}

export async function resolveCodexOperationConsumer(
  options: ResolveCodexOperationConsumerOptions,
): Promise<CodexOperationConsumer> {
  return {
    support: 'observed',
    manager: await resolveCodexManager(options),
    requirement: options.operationRequirement,
  };
}
