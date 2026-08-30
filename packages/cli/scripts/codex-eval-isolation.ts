import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';

import type { AwSkillEvalIsolation } from '../src/eval/manifest.js';

const execFileAsync = promisify(execFile);

export const CODEX_EVAL_CREDENTIAL_CONFIG_LINES = [
  'cli_auth_credentials_store = "file"',
  'mcp_oauth_credentials_store = "file"',
  'features.secret_auth_storage = false',
] as const;

const CODEX_EVAL_CREDENTIAL_OVERRIDES = [
  'cli_auth_credentials_store="file"',
  'mcp_oauth_credentials_store="file"',
  'features.secret_auth_storage=false',
] as const;

export const CODEX_EVAL_STRICT_OVERRIDES = [
  'skills.bundled.enabled=false',
  'orchestrator.skills.enabled=false',
  'orchestrator.mcp.enabled=false',
  'include_apps_instructions=false',
  'include_collaboration_mode_instructions=false',
  'features.apps=false',
  'features.plugins=false',
  'features.remote_plugin=false',
  'features.plugin_sharing=false',
  'features.tool_suggest=false',
  'features.skill_mcp_dependency_install=false',
] as const;

const REQUIRED_STRICT_FALSE_PATHS = [
  'features.secret_auth_storage',
  ...CODEX_EVAL_STRICT_OVERRIDES.map((entry) => entry.slice(0, entry.indexOf('='))),
] as const;

const MACOS_MANAGED_PREFERENCE_KEYS = [
  'config_toml_base64',
  'requirements_toml_base64',
] as const;

export interface CodexEvalHostIsolationEvidence {
  system_config_root: string;
  system_config_present: false;
  managed_preferences_checked: boolean;
  managed_preference_keys_present: string[];
}

export interface CodexEvalRpcIsolationEvidence {
  config_layers: string[];
  config_requirements_absent: true;
  skill_paths: string[];
  mcp_server_count: 0;
  strict_overrides_effective: true;
}

export interface CodexEvalIsolationEvidence {
  mode: AwSkillEvalIsolation;
  isolated_home: true;
  source_user_config_filtered: true;
  credential_stores: {
    cli_auth: 'file';
    mcp_oauth: 'file';
    secret_auth_storage: false;
  };
  strict_surfaces_disabled: boolean;
  host_configuration: CodexEvalHostIsolationEvidence | null;
  runtime_probe: CodexEvalRpcIsolationEvidence | null;
}

export interface InspectCodexEvalHostOptions {
  platform?: NodeJS.Platform;
  sourceEnv?: NodeJS.ProcessEnv;
  readSystemEntries?: (root: string) => Promise<string[]>;
  readManagedPreference?: (key: string) => Promise<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(canonicalPath(root), canonicalPath(candidate));
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function valueAtPath(root: Record<string, unknown>, keyPath: string): unknown {
  let value: unknown = root;
  for (const segment of keyPath.split('.')) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function systemCodexRoot(
  platform: NodeJS.Platform,
  sourceEnv: NodeJS.ProcessEnv,
): string {
  if (platform === 'win32') {
    return path.join(
      sourceEnv.ProgramData ?? String.raw`C:\ProgramData`,
      'OpenAI',
      'Codex',
    );
  }
  return '/etc/codex';
}

async function readMacManagedPreference(key: string): Promise<boolean> {
  try {
    await execFileAsync('/usr/bin/defaults', ['read', 'com.openai.codex', key], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return true;
  } catch (error) {
    const row = error as NodeJS.ErrnoException & { stderr?: string };
    const message = `${row.message ?? ''}\n${row.stderr ?? ''}`;
    if (/does not exist|domain\/default pair.*not found/iu.test(message)) {
      return false;
    }
    throw new Error(
      `Unable to inspect the macOS managed Codex preference ${key}.`,
      { cause: error },
    );
  }
}

async function readMacUserKeychainSearchList(): Promise<string> {
  try {
    const result = await execFileAsync(
      '/usr/bin/security',
      ['list-keychains', '-d', 'user'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    return result.stdout;
  } catch (error) {
    throw new Error(
      'Unable to inspect the macOS user keychain search list before Codex model eval.',
      { cause: error },
    );
  }
}

export async function assertCodexEvalKeychainWrapperAbsent(options: {
  platform?: NodeJS.Platform;
  readUserKeychainSearchList?: () => Promise<string>;
} = {}): Promise<void> {
  if ((options.platform ?? process.platform) !== 'darwin') return;
  const searchList = await (
    options.readUserKeychainSearchList ?? readMacUserKeychainSearchList
  )();
  if (/accountsKeychainExport/iu.test(searchList)) {
    throw new Error(
      'Cannot start a Codex model eval from a macOS wrapper that injects ' +
      'accountsKeychainExport into the user keychain search list. Run ' +
      'aw-skill-eval run with its required --audit input from an ordinary Terminal session.',
    );
  }
}

export function codexEvalConfigOverrides(
  isolation: AwSkillEvalIsolation,
): string[] {
  return [
    ...CODEX_EVAL_CREDENTIAL_OVERRIDES,
    ...(isolation === 'strict' ? CODEX_EVAL_STRICT_OVERRIDES : []),
  ];
}

export function codexEvalIsolationEvidence(options: {
  mode: AwSkillEvalIsolation;
  host?: CodexEvalHostIsolationEvidence | null;
  runtimeProbe?: CodexEvalRpcIsolationEvidence | null;
}): CodexEvalIsolationEvidence {
  return {
    mode: options.mode,
    isolated_home: true,
    source_user_config_filtered: true,
    credential_stores: {
      cli_auth: 'file',
      mcp_oauth: 'file',
      secret_auth_storage: false,
    },
    strict_surfaces_disabled: options.mode === 'strict',
    host_configuration: options.host ?? null,
    runtime_probe: options.runtimeProbe ?? null,
  };
}

export async function inspectCodexEvalHostIsolation(
  options: InspectCodexEvalHostOptions = {},
): Promise<CodexEvalHostIsolationEvidence> {
  const platform = options.platform ?? process.platform;
  const sourceEnv = options.sourceEnv ?? process.env;
  const systemRoot = systemCodexRoot(platform, sourceEnv);
  const readSystemEntries = options.readSystemEntries ?? (async (root: string) =>
    fs.readdir(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    }));
  const systemEntries = await readSystemEntries(systemRoot);
  if (systemEntries.length > 0) {
    throw new Error(
      `Strict Codex eval is blocked because system configuration exists at ${systemRoot}.`,
    );
  }

  const presentKeys: string[] = [];
  if (platform === 'darwin') {
    const readManagedPreference = options.readManagedPreference ?? readMacManagedPreference;
    for (const key of MACOS_MANAGED_PREFERENCE_KEYS) {
      if (await readManagedPreference(key)) presentKeys.push(key);
    }
    if (presentKeys.length > 0) {
      throw new Error(
        `Strict Codex eval is blocked by macOS managed preference(s): ${presentKeys.join(', ')}.`,
      );
    }
  }

  return {
    system_config_root: systemRoot,
    system_config_present: false,
    managed_preferences_checked: platform === 'darwin',
    managed_preference_keys_present: [],
  };
}

function validateConfigLayers(
  response: Record<string, unknown>,
  codexHome: string,
  workspaceRoot: string,
): string[] {
  if (!Array.isArray(response.layers)) {
    throw new Error('Strict Codex eval config/read response is missing layers.');
  }
  const layerTypes: string[] = [];
  const projectConfigPath = path.join(workspaceRoot, '.codex', 'config.toml');
  const expectedProjectFolder = canonicalPath(path.dirname(projectConfigPath));
  const projectConfigExpected = fs.pathExistsSync(projectConfigPath);
  let projectConfigActive = false;
  for (const [index, value] of response.layers.entries()) {
    const layer = expectRecord(value, `config/read.layers[${index}]`);
    const name = expectRecord(layer.name, `config/read.layers[${index}].name`);
    const type = typeof name.type === 'string' ? name.type : '';
    const config = expectRecord(layer.config, `config/read.layers[${index}].config`);
    layerTypes.push(type);
    if (type === 'system') {
      if (Object.keys(config).length > 0) {
        throw new Error('Strict Codex eval found non-empty system configuration.');
      }
      continue;
    }
    if (type === 'user') {
      if (typeof name.file !== 'string' || !isPathInsideOrEqual(codexHome, name.file)) {
        throw new Error('Strict Codex eval found a user config layer outside isolated CODEX_HOME.');
      }
      continue;
    }
    if (type === 'project') {
      if (typeof layer.disabledReason === 'string' && layer.disabledReason.trim() !== '') {
        throw new Error(
          `Strict Codex eval found a disabled project config layer: ${layer.disabledReason}`,
        );
      }
      if (
        typeof name.dotCodexFolder !== 'string' ||
        canonicalPath(name.dotCodexFolder) !== expectedProjectFolder
      ) {
        throw new Error('Strict Codex eval found an unexpected project config layer.');
      }
      projectConfigActive = true;
      continue;
    }
    if (type === 'sessionFlags') continue;
    throw new Error(`Strict Codex eval found forbidden config layer ${JSON.stringify(type)}.`);
  }
  if (projectConfigExpected && !projectConfigActive) {
    throw new Error('Strict Codex eval did not activate the workspace project config layer.');
  }
  return layerTypes;
}

function validateEffectiveConfig(response: Record<string, unknown>): void {
  const config = expectRecord(response.config, 'config/read.config');
  if (config.cli_auth_credentials_store !== 'file') {
    throw new Error('Strict Codex eval did not apply cli_auth_credentials_store=file.');
  }
  if (config.mcp_oauth_credentials_store !== 'file') {
    throw new Error('Strict Codex eval did not apply mcp_oauth_credentials_store=file.');
  }
  if (valueAtPath(config, 'features.default_mode_request_user_input') !== true) {
    throw new Error(
      'Strict Codex eval did not enable features.default_mode_request_user_input.',
    );
  }
  for (const keyPath of REQUIRED_STRICT_FALSE_PATHS) {
    if (valueAtPath(config, keyPath) !== false) {
      throw new Error(`Strict Codex eval did not disable ${keyPath}.`);
    }
  }
  const mcpServers = config.mcp_servers;
  if (
    mcpServers !== undefined &&
    mcpServers !== null &&
    (!isRecord(mcpServers) || Object.keys(mcpServers).length > 0)
  ) {
    throw new Error('Strict Codex eval found effective MCP server configuration.');
  }
}

function validateRequirements(value: unknown): void {
  const response = expectRecord(value, 'configRequirements/read response');
  if (response.requirements !== null) {
    throw new Error('Strict Codex eval found managed configuration requirements.');
  }
}

function validateSkills(
  value: unknown,
  workspaceRoot: string,
  allowedSkillRoots: string[],
): string[] {
  const response = expectRecord(value, 'skills/list response');
  if (!Array.isArray(response.data)) {
    throw new Error('Strict Codex eval skills/list response is missing data.');
  }
  if (response.data.length !== 1) {
    throw new Error('Strict Codex eval skills/list must return exactly one workspace entry.');
  }
  const expectedSkills = new Map(allowedSkillRoots.map((root) => [
    canonicalPath(path.join(root, 'SKILL.md')),
    { root, name: path.basename(root) },
  ]));
  const paths: string[] = [];
  for (const [index, value] of response.data.entries()) {
    const entry = expectRecord(value, `skills/list.data[${index}]`);
    if (
      typeof entry.cwd !== 'string' ||
      !isPathInsideOrEqual(workspaceRoot, entry.cwd) ||
      !isPathInsideOrEqual(entry.cwd, workspaceRoot)
    ) {
      throw new Error('Strict Codex eval skills/list returned an unexpected workspace.');
    }
    if (!Array.isArray(entry.errors) || entry.errors.length > 0) {
      throw new Error('Strict Codex eval found Skill discovery errors.');
    }
    if (!Array.isArray(entry.skills)) {
      throw new Error('Strict Codex eval skills/list entry is missing skills.');
    }
    for (const [skillIndex, skillValue] of entry.skills.entries()) {
      const skill = expectRecord(skillValue, `skills/list.data[${index}].skills[${skillIndex}]`);
      if (typeof skill.path !== 'string') {
        throw new Error(`Strict Codex eval found an invalid Skill path ${String(skill.path)}.`);
      }
      const normalizedPath = canonicalPath(skill.path);
      const expected = expectedSkills.get(normalizedPath);
      if (!expected || !isPathInsideOrEqual(expected.root, skill.path)) {
        throw new Error(`Strict Codex eval found non-target Skill ${skill.path}.`);
      }
      if (
        skill.name !== expected.name ||
        skill.enabled !== true
      ) {
        throw new Error(`Strict Codex eval found an invalid target Skill ${skill.path}.`);
      }
      paths.push(normalizedPath);
    }
  }
  if (
    paths.length !== expectedSkills.size ||
    new Set(paths).size !== expectedSkills.size
  ) {
    throw new Error(
      expectedSkills.size > 0
        ? 'Strict Codex eval did not discover exactly the enabled participant Skills.'
        : 'Strict Codex eval found a Skill in an empty baseline workspace.',
    );
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

function validateMcpServers(value: unknown): void {
  const response = expectRecord(value, 'mcpServerStatus/list response');
  if (!Array.isArray(response.data) || response.data.length > 0) {
    throw new Error('Strict Codex eval found an active MCP server.');
  }
  if (response.nextCursor !== undefined && response.nextCursor !== null) {
    throw new Error('Strict Codex eval MCP inventory is unexpectedly paginated.');
  }
}

export function validateCodexEvalRpcIsolation(options: {
  config: unknown;
  requirements: unknown;
  skills: unknown;
  mcpServers: unknown;
  codexHome: string;
  workspaceRoot: string;
  allowedSkillRoots: string[];
}): CodexEvalRpcIsolationEvidence {
  const layers = validateCodexEvalConfigIsolation(options);
  const skillPaths = validateSkills(
    options.skills,
    options.workspaceRoot,
    options.allowedSkillRoots,
  );
  validateMcpServers(options.mcpServers);
  return {
    config_layers: layers,
    config_requirements_absent: true,
    skill_paths: skillPaths,
    mcp_server_count: 0,
    strict_overrides_effective: true,
  };
}

export function validateCodexEvalConfigIsolation(options: {
  config: unknown;
  requirements: unknown;
  codexHome: string;
  workspaceRoot: string;
}): string[] {
  const config = expectRecord(options.config, 'config/read response');
  const layers = validateConfigLayers(config, options.codexHome, options.workspaceRoot);
  validateEffectiveConfig(config);
  validateRequirements(options.requirements);
  return layers;
}
