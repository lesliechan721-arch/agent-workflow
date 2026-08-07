import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { ParseError, parseTOML, type AST } from 'toml-eslint-parser';

const INHERITED_MODEL_KEYS = new Set([
  'model',
  'model_provider',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_verbosity',
]);
const OPENAI_AUTH_FILES = ['auth.json', '.credentials.json'] as const;
const EVAL_PROCESS_PASSTHROUGH_ENV = [
  'PATH',
  'LANG',
  'LC_ALL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const;
const RESERVED_PROVIDER_ENV = new Set([
  ...EVAL_PROCESS_PASSTHROUGH_ENV,
  'HOME',
  'USERPROFILE',
  'CODEX_HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'NODE_OPTIONS',
  'NODE_PATH',
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
]);
const SENSITIVE_PASSTHROUGH_ENV = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
]);
const ACTIVE_RUNTIME_ROOTS = new Set<string>();
const CAPSULE_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
const capsuleSignalHandlers = new Map<NodeJS.Signals, () => void>();
let capsuleSignalCleanupInProgress = false;

export type CodexEvalCredentialSource =
  | 'embedded'
  | 'environment'
  | 'openai-auth'
  | 'none';

export interface CodexEvalRuntimeConfig {
  inherited: boolean;
  model: string | null;
  modelProvider: string;
  credentialSource: CodexEvalCredentialSource;
  configToml: string | null;
  providerEnvironment: Record<string, string>;
  sourceCodexHome: string;
  copyOpenAiAuth: boolean;
  sensitiveEnvironmentNames: string[];
  sensitiveValues: string[];
  evidenceDigest: string;
}

export interface ResolveCodexEvalRuntimeOptions {
  sourceEnv?: NodeJS.ProcessEnv;
  inheritUserConfig: boolean;
  configPath?: string;
  modelOverride?: string;
  modelProviderOverride?: string;
}

export interface CodexEvalRuntimeCapsule {
  home: string;
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keySegments(key: AST.TOMLKey): string[] {
  return key.keys.map((segment) =>
    segment.type === 'TOMLBare' ? segment.name : segment.value,
  );
}

function scalarString(node: AST.TOMLKeyValue['value']): string | undefined {
  return node.type === 'TOMLValue' && node.kind === 'string'
    ? node.value
    : undefined;
}

function tableEntry(
  table: AST.TOMLTable,
  key: string,
): AST.TOMLKeyValue | undefined {
  return table.body.find((entry) => keySegments(entry.key).join('.') === key);
}

function inlineStringValues(
  node: AST.TOMLKeyValue['value'] | undefined,
): string[] {
  if (!node || node.type !== 'TOMLInlineTable') {
    return [];
  }
  return node.body.flatMap((entry) => {
    const value = scalarString(entry.value);
    return value ? [value] : [];
  });
}

function sourceCodexHome(sourceEnv: NodeJS.ProcessEnv): string {
  return path.resolve(
    sourceEnv.CODEX_HOME ?? path.join(sourceEnv.HOME ?? os.homedir(), '.codex'),
  );
}

function topLevelEntries(program: AST.TOMLProgram): Array<AST.TOMLKeyValue | AST.TOMLTable> {
  return program.body[0].body;
}

function topLevelString(
  program: AST.TOMLProgram,
  key: string,
): string | undefined {
  const entry = topLevelEntries(program).find(
    (candidate): candidate is AST.TOMLKeyValue =>
      candidate.type === 'TOMLKeyValue' && keySegments(candidate.key).join('.') === key,
  );
  return entry ? scalarString(entry.value) : undefined;
}

function providerTables(
  program: AST.TOMLProgram,
  provider: string,
): AST.TOMLTable[] {
  return topLevelEntries(program).filter(
    (entry): entry is AST.TOMLTable => {
      if (entry.type !== 'TOMLTable') return false;
      const segments = keySegments(entry.key);
      return segments[0] === 'model_providers' && segments[1] === provider;
    },
  );
}

function providerEnvironmentNames(tables: AST.TOMLTable[]): string[] {
  const provider = tables.find((table) => keySegments(table.key).length === 2);
  if (!provider) return [];
  const names = new Set<string>();
  const envKey = tableEntry(provider, 'env_key');
  const envKeyName = envKey ? scalarString(envKey.value) : undefined;
  if (envKeyName) names.add(envKeyName);
  const inlineHeaders = tableEntry(provider, 'env_http_headers');
  for (const name of inlineStringValues(inlineHeaders?.value)) names.add(name);
  for (const table of tables) {
    const segments = keySegments(table.key);
    if (segments.length !== 3 || segments[2] !== 'env_http_headers') continue;
    for (const entry of table.body) {
      const value = scalarString(entry.value);
      if (value) names.add(value);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function assertSafeProviderEnvironmentName(name: string, provider: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error(
      `Codex eval model provider ${JSON.stringify(provider)} declares invalid environment variable ${JSON.stringify(name)}.`,
    );
  }
  if (
    RESERVED_PROVIDER_ENV.has(name) ||
    name.startsWith('AW_') ||
    name.startsWith('XDG_') ||
    name.startsWith('DYLD_')
  ) {
    throw new Error(
      `Codex eval model provider ${JSON.stringify(provider)} cannot use reserved environment variable ${name}.`,
    );
  }
}

function providerHasEmbeddedBearer(tables: AST.TOMLTable[]): boolean {
  const provider = tables.find((table) => keySegments(table.key).length === 2);
  const entry = provider ? tableEntry(provider, 'experimental_bearer_token') : undefined;
  return Boolean(entry && scalarString(entry.value));
}

function providerSensitiveValues(tables: AST.TOMLTable[]): string[] {
  const values = new Set<string>();
  const provider = tables.find((table) => keySegments(table.key).length === 2);
  for (const key of ['base_url', 'experimental_bearer_token']) {
    const entry = provider ? tableEntry(provider, key) : undefined;
    const value = entry ? scalarString(entry.value) : undefined;
    if (value) values.add(value);
  }
  const inlineHeaders = provider ? tableEntry(provider, 'http_headers') : undefined;
  for (const value of inlineStringValues(inlineHeaders?.value)) values.add(value);
  for (const table of tables) {
    const segments = keySegments(table.key);
    if (segments.length !== 3 || segments[2] !== 'http_headers') continue;
    for (const entry of table.body) {
      const value = scalarString(entry.value);
      if (value) values.add(value);
    }
  }
  return [...values];
}

function addSensitiveValues(runtime: CodexEvalRuntimeConfig, values: Iterable<string>): void {
  const unique = new Set(runtime.sensitiveValues);
  for (const value of values) {
    if (value) unique.add(value);
  }
  runtime.sensitiveValues = [...unique].sort((left, right) => right.length - left.length);
}

function sensitivePassthroughEnvironment(
  sourceEnv: NodeJS.ProcessEnv,
): { names: string[]; values: string[] } {
  const names: string[] = [];
  const values: string[] = [];
  for (const name of SENSITIVE_PASSTHROUGH_ENV) {
    const value = sourceEnv[name];
    if (value === undefined) continue;
    names.push(name);
    if (value) values.push(value);
  }
  return { names: names.sort(), values };
}

function jsonStringValues(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(jsonStringValues);
  if (isRecord(value)) return Object.values(value).flatMap(jsonStringValues);
  return [];
}

function renderFilteredConfig(options: {
  content: string;
  program: AST.TOMLProgram;
  provider: string;
  tables: AST.TOMLTable[];
  modelOverride?: string;
  providerOverride?: string;
}): string | null {
  const lines: string[] = [];
  for (const entry of topLevelEntries(options.program)) {
    if (entry.type !== 'TOMLKeyValue') continue;
    const key = keySegments(entry.key).join('.');
    if (!INHERITED_MODEL_KEYS.has(key)) continue;
    if (key === 'model' && options.modelOverride) continue;
    if (key === 'model_provider') continue;
    lines.push(options.content.slice(entry.range[0], entry.range[1]));
  }
  if (options.modelOverride) {
    lines.push(`model = ${JSON.stringify(options.modelOverride)}`);
  }
  lines.push(`model_provider = ${JSON.stringify(options.providerOverride ?? options.provider)}`);
  for (const table of options.tables) {
    lines.push(options.content.slice(table.range[0], table.range[1]));
  }
  return lines.length > 0 ? `${lines.join('\n\n')}\n` : null;
}

function evidenceDigest(value: {
  inherited: boolean;
  model: string | null;
  modelProvider: string;
  credentialSource: CodexEvalCredentialSource;
}): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function cleanCodexEvalRuntimeConfig(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  modelOverride?: string,
): CodexEvalRuntimeConfig {
  const model = modelOverride ?? null;
  const sensitivePassthrough = sensitivePassthroughEnvironment(sourceEnv);
  const descriptor = {
    inherited: false,
    model,
    modelProvider: 'openai',
    credentialSource: sourceEnv.OPENAI_API_KEY ? 'environment' as const : 'openai-auth' as const,
  };
  return {
    ...descriptor,
    configToml: model ? `model = ${JSON.stringify(model)}\nmodel_provider = "openai"\n` : null,
    providerEnvironment: sourceEnv.OPENAI_API_KEY
      ? { OPENAI_API_KEY: sourceEnv.OPENAI_API_KEY }
      : {},
    sourceCodexHome: sourceCodexHome(sourceEnv),
    copyOpenAiAuth: !sourceEnv.OPENAI_API_KEY,
    sensitiveEnvironmentNames: [
      ...(sourceEnv.OPENAI_API_KEY ? ['OPENAI_API_KEY'] : []),
      ...sensitivePassthrough.names,
    ].sort(),
    sensitiveValues: [
      ...(sourceEnv.OPENAI_API_KEY ? [sourceEnv.OPENAI_API_KEY] : []),
      ...sensitivePassthrough.values,
    ],
    evidenceDigest: evidenceDigest(descriptor),
  };
}

export async function resolveCodexEvalRuntimeConfig(
  options: ResolveCodexEvalRuntimeOptions,
): Promise<CodexEvalRuntimeConfig> {
  const sourceEnv = options.sourceEnv ?? process.env;
  if (!options.inheritUserConfig) {
    if (options.configPath || options.modelProviderOverride) {
      throw new Error(
        '--no-inherit-codex-config cannot be combined with --codex-config or --model-provider.',
      );
    }
    return cleanCodexEvalRuntimeConfig(sourceEnv, options.modelOverride);
  }

  const codexHome = sourceCodexHome(sourceEnv);
  const configPath = path.resolve(options.configPath ?? path.join(codexHome, 'config.toml'));
  if (!(await fs.pathExists(configPath))) {
    if (options.configPath) {
      throw new Error(`Codex eval config does not exist: ${configPath}`);
    }
    return cleanCodexEvalRuntimeConfig(sourceEnv, options.modelOverride);
  }
  const content = await fs.readFile(configPath, 'utf8');
  let program: AST.TOMLProgram;
  try {
    program = parseTOML(content);
  } catch (error) {
    const message = error instanceof ParseError ? error.message : String(error);
    throw new Error(`Unable to parse Codex eval config ${configPath}: ${message}`);
  }

  const provider = options.modelProviderOverride ?? topLevelString(program, 'model_provider') ?? 'openai';
  const tables = providerTables(program, provider);
  if (provider !== 'openai' && tables.length === 0) {
    throw new Error(
      `Codex eval model provider ${JSON.stringify(provider)} is not defined in ${configPath}.`,
    );
  }
  const model = options.modelOverride ?? topLevelString(program, 'model') ?? null;
  const builtInOpenAiProvider = provider === 'openai' && tables.length === 0;
  const names = providerEnvironmentNames(tables);
  const providerEnvironment: Record<string, string> = {};
  for (const name of names) {
    assertSafeProviderEnvironmentName(name, provider);
    const value = sourceEnv[name];
    if (!value) {
      throw new Error(
        `Codex eval model provider ${JSON.stringify(provider)} requires environment variable ${name}.`,
      );
    }
    providerEnvironment[name] = value;
  }
  if (builtInOpenAiProvider && sourceEnv.OPENAI_API_KEY) {
    providerEnvironment.OPENAI_API_KEY = sourceEnv.OPENAI_API_KEY;
  }

  const embedded = providerHasEmbeddedBearer(tables);
  const environmentCredential = Object.keys(providerEnvironment).length > 0;
  const copyOpenAiAuth = builtInOpenAiProvider && !embedded && !environmentCredential;
  const sensitivePassthrough = sensitivePassthroughEnvironment(sourceEnv);
  const credentialSource: CodexEvalCredentialSource = embedded
    ? 'embedded'
    : environmentCredential
      ? 'environment'
      : copyOpenAiAuth
        ? 'openai-auth'
        : 'none';
  const descriptor = {
    inherited: true,
    model,
    modelProvider: provider,
    credentialSource,
  };
  return {
    ...descriptor,
    configToml: renderFilteredConfig({
      content,
      program,
      provider,
      tables,
      modelOverride: options.modelOverride,
      providerOverride: options.modelProviderOverride,
    }),
    providerEnvironment,
    sourceCodexHome: codexHome,
    copyOpenAiAuth,
    sensitiveEnvironmentNames: [
      ...Object.keys(providerEnvironment),
      ...sensitivePassthrough.names,
    ].sort(),
    sensitiveValues: [
      ...providerSensitiveValues(tables),
      ...Object.values(providerEnvironment),
      ...sensitivePassthrough.values,
    ],
    evidenceDigest: evidenceDigest(descriptor),
  };
}

export async function materializeCodexEvalRuntimeHome(
  runtime: CodexEvalRuntimeConfig,
  destination: string,
): Promise<void> {
  await fs.ensureDir(destination);
  await fs.chmod(destination, 0o700).catch(() => undefined);
  if (runtime.configToml) {
    const configPath = path.join(destination, 'config.toml');
    await fs.writeFile(configPath, runtime.configToml, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(configPath, 0o600).catch(() => undefined);
  }
  if (!runtime.copyOpenAiAuth) return;
  for (const name of OPENAI_AUTH_FILES) {
    const source = path.join(runtime.sourceCodexHome, name);
    if (!(await fs.pathExists(source))) continue;
    const target = path.join(destination, name);
    const content = await fs.readFile(source, 'utf8');
    try {
      addSensitiveValues(runtime, jsonStringValues(JSON.parse(content)));
    } catch {
      addSensitiveValues(runtime, [content.trim()]);
    }
    await fs.copyFile(source, target);
    await fs.chmod(target, 0o600).catch(() => undefined);
  }
}

export function applyCodexEvalProviderEnvironment(
  env: NodeJS.ProcessEnv,
  runtime: CodexEvalRuntimeConfig,
): NodeJS.ProcessEnv {
  return { ...runtime.providerEnvironment, ...env };
}

function filteredEvalProcessEnvironment(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of EVAL_PROCESS_PASSTHROUGH_ENV) {
    if (sourceEnv[name] !== undefined) env[name] = sourceEnv[name];
  }
  return env;
}

function removeCapsuleSignalHandlers(): void {
  for (const [signal, handler] of capsuleSignalHandlers) {
    process.off(signal, handler);
  }
  capsuleSignalHandlers.clear();
}

export async function cleanupActiveCodexEvalRuntimeCapsules(): Promise<void> {
  const roots = [...ACTIVE_RUNTIME_ROOTS];
  ACTIVE_RUNTIME_ROOTS.clear();
  await Promise.all(roots.map((root) => fs.remove(root)));
  if (!capsuleSignalCleanupInProgress) removeCapsuleSignalHandlers();
}

export function registerCodexEvalTemporaryRoot(root: string): () => void {
  ACTIVE_RUNTIME_ROOTS.add(root);
  installCapsuleSignalHandlers();
  return () => {
    ACTIVE_RUNTIME_ROOTS.delete(root);
    if (ACTIVE_RUNTIME_ROOTS.size === 0 && !capsuleSignalCleanupInProgress) {
      removeCapsuleSignalHandlers();
    }
  };
}

function installCapsuleSignalHandlers(): void {
  if (capsuleSignalHandlers.size > 0) return;
  for (const signal of CAPSULE_SIGNALS) {
    const handler = (): void => {
      if (capsuleSignalCleanupInProgress) return;
      capsuleSignalCleanupInProgress = true;
      void cleanupActiveCodexEvalRuntimeCapsules().finally(() => {
        removeCapsuleSignalHandlers();
        capsuleSignalCleanupInProgress = false;
        try {
          process.kill(process.pid, signal);
        } catch {
          process.exitCode = 1;
        }
      });
    };
    capsuleSignalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
}

export async function createCodexEvalRuntimeCapsule(
  runtime: CodexEvalRuntimeConfig,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Promise<CodexEvalRuntimeCapsule> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-eval-runtime-'));
  const home = path.join(root, 'codex-home');
  const unregister = registerCodexEvalTemporaryRoot(root);
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      await fs.remove(root);
    } finally {
      unregister();
    }
  };
  try {
    await materializeCodexEvalRuntimeHome(runtime, home);
    const baseEnv = filteredEvalProcessEnvironment(sourceEnv);
    return {
      home,
      env: applyCodexEvalProviderEnvironment({
        ...baseEnv,
        CODEX_HOME: home,
        AW_CODEX_EVAL_RUNTIME_HOME: home,
        AW_CODEX_EVAL_MODEL_PROVIDER: runtime.modelProvider,
        AW_CODEX_EVAL_SENSITIVE_ENV_NAMES: JSON.stringify(
          runtime.sensitiveEnvironmentNames,
        ),
      }, runtime),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function redactCodexEvalText(
  value: string,
  runtime: CodexEvalRuntimeConfig,
): string {
  let redacted = value;
  const secrets = [...new Set(runtime.sensitiveValues)]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, '[redacted]');
  }
  return redacted;
}

export function redactCodexEvalValue<T>(
  value: T,
  runtime: CodexEvalRuntimeConfig,
): T {
  if (typeof value === 'string') {
    return redactCodexEvalText(value, runtime) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactCodexEvalValue(entry, runtime)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactCodexEvalValue(entry, runtime)]),
    ) as T;
  }
  return value;
}

export function codexEvalRuntimeEvidence(
  runtime: CodexEvalRuntimeConfig,
): Record<string, unknown> {
  return {
    inherited: runtime.inherited,
    model: runtime.model,
    model_provider: runtime.modelProvider,
    credential_source: runtime.credentialSource,
    config_digest: runtime.evidenceDigest,
  };
}

export function isCodexEvalRuntimeEvidence(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.model_provider === 'string';
}
