import path from 'node:path';

import fs from 'fs-extra';
import { ParseError, parseTOML, type AST } from 'toml-eslint-parser';

import {
  parseCodexConfig,
  removeCodexAgentRegistration,
  type CodexAgentRegistrationSnapshot,
} from './codex-config.js';

export interface CodexRoleFileSnapshot {
  name?: string;
  description?: string;
  developerInstructions?: string;
  model?: string;
  modelReasoningEffort?: string;
}

export type CodexRoleNamespaceSource = 'registration' | 'discoveredRoleFile';

export interface CodexResolvedRole {
  finalName: string;
  source: CodexRoleNamespaceSource;
  tableKey?: string;
  configPath: string;
  roleLayerPath?: string;
  roleLayerExists: boolean;
  awManaged: boolean;
  registration?: CodexAgentRegistrationSnapshot;
  roleFile?: CodexRoleFileSnapshot;
  warnings: string[];
}

export interface CodexRoleNamespace {
  layerRoot: string;
  configPath: string;
  roles: CodexResolvedRole[];
  warnings: string[];
}

export interface ResolveCodexRoleNamespaceOptions {
  strict?: boolean;
  awManagedTableKeys?: string[];
  awManagedRoleLayerPaths?: string[];
}

export interface CodexRoleNameConflict {
  roleName: string;
  matches: CodexResolvedRole[];
  externalMatches: CodexResolvedRole[];
  awManagedMatches: CodexResolvedRole[];
  conflict: boolean;
}

export interface CodexRoleDescriptionMismatch {
  registrationDescription?: string;
  roleFileDescription?: string;
}

export type CodexRoleVisibilityState = 'visible' | 'unknownByExternalLayer';

export interface CodexHigherPriorityRoleLayerMatch {
  layerRoot: string;
  configPath: string;
  matches: CodexResolvedRole[];
}

export interface CodexRoleVisibilityDiagnosis {
  roleName: string;
  state: CodexRoleVisibilityState;
  higherPriorityLayerMatches: CodexHigherPriorityRoleLayerMatch[];
}

export interface CodexManagedRoleRemovalPlan {
  content: string;
  registrationRemoved: boolean;
  roleLayerPathToDelete: string;
  driftedConfigFilePath?: string;
}

function keySegments(key: AST.TOMLKey): string[] {
  return key.keys.map((segment) =>
    segment.type === 'TOMLBare' ? segment.name : segment.value,
  );
}

function readTopLevelStringValue(
  table: AST.TOMLTopLevelTable,
  keyName: string,
): string | undefined {
  const entry = table.body.find(
    (node): node is AST.TOMLKeyValue =>
      node.type === 'TOMLKeyValue' &&
      keySegments(node.key).length === 1 &&
      keySegments(node.key)[0] === keyName,
  );
  if (!entry || entry.value.type !== 'TOMLValue' || entry.value.kind !== 'string') {
    return undefined;
  }
  return entry.value.value;
}

function normalizeFsPath(filePath: string): string {
  return path.resolve(filePath);
}

function resolveCodexRoleLayerPath(layerRoot: string, configFile: string): string {
  return path.isAbsolute(configFile)
    ? normalizeFsPath(configFile)
    : normalizeFsPath(path.resolve(layerRoot, configFile));
}

function parseCodexRoleFileContent(content: string): CodexRoleFileSnapshot {
  try {
    const ast = parseTOML(content);
    const topLevel = ast.body[0];
    return {
      name: readTopLevelStringValue(topLevel, 'name'),
      description: readTopLevelStringValue(topLevel, 'description'),
      developerInstructions: readTopLevelStringValue(topLevel, 'developer_instructions'),
      model: readTopLevelStringValue(topLevel, 'model'),
      modelReasoningEffort: readTopLevelStringValue(topLevel, 'model_reasoning_effort'),
    };
  } catch (error) {
    if (error instanceof ParseError) {
      throw new Error(`Unable to parse Codex role TOML: ${error.message}`);
    }
    throw error;
  }
}

export function parseCodexRoleFile(content: string): CodexRoleFileSnapshot {
  return parseCodexRoleFileContent(content);
}

async function listCodexRoleTomlFiles(root: string): Promise<string[]> {
  if (!(await fs.pathExists(root))) {
    return [];
  }

  const discovered: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.toml')) {
        discovered.push(normalizeFsPath(entryPath));
      }
    }
  };

  await visit(root);
  return discovered;
}

async function readRoleFileForNamespace(
  roleLayerPath: string,
  strict: boolean,
): Promise<{ exists: boolean; snapshot?: CodexRoleFileSnapshot; warning?: string }> {
  if (!(await fs.pathExists(roleLayerPath))) {
    return { exists: false };
  }

  try {
    return {
      exists: true,
      snapshot: parseCodexRoleFileContent(await fs.readFile(roleLayerPath, 'utf8')),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const warning = `${message} (${roleLayerPath})`;
    if (strict) {
      throw new Error(warning);
    }
    return {
      exists: true,
      warning,
    };
  }
}

function roleSortKey(role: CodexResolvedRole): string {
  return [
    role.finalName,
    role.source,
    role.tableKey ?? '',
    role.roleLayerPath ?? '',
  ].join('\u0000');
}

export async function resolveCodexRoleNamespace(
  configPath: string,
  options: ResolveCodexRoleNamespaceOptions = {},
): Promise<CodexRoleNamespace> {
  const layerRoot = path.dirname(configPath);
  const agentsDir = path.join(layerRoot, 'agents');
  const strict = options.strict === true;
  const awManagedTableKeys = new Set(options.awManagedTableKeys ?? []);
  const awManagedRoleLayerPaths = new Set(
    (options.awManagedRoleLayerPaths ?? []).map((roleLayerPath) => normalizeFsPath(roleLayerPath)),
  );
  const warnings: string[] = [];
  const roles: CodexResolvedRole[] = [];
  const referencedRoleLayerPaths = new Set<string>();
  let registrations: Record<string, CodexAgentRegistrationSnapshot> = {};

  if (await fs.pathExists(configPath)) {
    try {
      const content = await fs.readFile(configPath, 'utf8');
      registrations = parseCodexConfig(content).agents;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (strict) {
        throw error;
      }
      warnings.push(`${message} (${configPath})`);
    }
  }

  for (const tableKey of Object.keys(registrations).sort()) {
    const registration = registrations[tableKey];
    const roleWarnings: string[] = [];
    const roleLayerPath = registration.configFile
      ? resolveCodexRoleLayerPath(layerRoot, registration.configFile)
      : undefined;
    if (roleLayerPath) {
      referencedRoleLayerPaths.add(roleLayerPath);
    }

    let roleLayerExists = false;
    let roleFile: CodexRoleFileSnapshot | undefined;
    if (roleLayerPath) {
      const roleLayerState = await readRoleFileForNamespace(roleLayerPath, strict);
      roleLayerExists = roleLayerState.exists;
      roleFile = roleLayerState.snapshot;
      if (roleLayerState.warning) {
        warnings.push(roleLayerState.warning);
        roleWarnings.push(roleLayerState.warning);
      }
      if (!roleLayerState.exists) {
        roleWarnings.push(`Referenced role file is missing: ${roleLayerPath}`);
      }
    }

    roles.push({
      finalName: roleFile?.name ?? tableKey,
      source: 'registration',
      tableKey,
      configPath,
      roleLayerPath,
      roleLayerExists,
      awManaged:
        awManagedTableKeys.has(tableKey) ||
        (roleLayerPath !== undefined && awManagedRoleLayerPaths.has(roleLayerPath)),
      registration,
      roleFile,
      warnings: roleWarnings,
    });
  }

  const discoveredRoleFiles = await listCodexRoleTomlFiles(agentsDir);
  for (const roleLayerPath of discoveredRoleFiles) {
    if (referencedRoleLayerPaths.has(roleLayerPath)) {
      continue;
    }

    const roleWarnings: string[] = [];
    const roleLayerState = await readRoleFileForNamespace(roleLayerPath, strict);
    const roleFile = roleLayerState.snapshot;
    if (roleLayerState.warning) {
      warnings.push(roleLayerState.warning);
      roleWarnings.push(roleLayerState.warning);
    }

    roles.push({
      finalName: roleFile?.name ?? path.basename(roleLayerPath, '.toml'),
      source: 'discoveredRoleFile',
      configPath,
      roleLayerPath,
      roleLayerExists: roleLayerState.exists,
      awManaged: awManagedRoleLayerPaths.has(roleLayerPath),
      roleFile,
      warnings: roleWarnings,
    });
  }

  return {
    layerRoot,
    configPath,
    roles: [...roles].sort((left, right) => roleSortKey(left).localeCompare(roleSortKey(right))),
    warnings,
  };
}

export function findCodexRoleNameConflict(
  namespace: CodexRoleNamespace,
  roleName: string,
): CodexRoleNameConflict | undefined {
  const matches = namespace.roles.filter((role) => role.finalName === roleName);
  if (matches.length === 0) {
    return undefined;
  }

  const externalMatches = matches.filter((role) => !role.awManaged);
  const awManagedMatches = matches.filter((role) => role.awManaged);
  return {
    roleName,
    matches,
    externalMatches,
    awManagedMatches,
    conflict: externalMatches.length > 0,
  };
}

export function getCodexRoleDescriptionMismatch(
  role: CodexResolvedRole,
): CodexRoleDescriptionMismatch | undefined {
  if (!role.registration || !role.roleLayerPath) {
    return undefined;
  }

  const registrationDescription = role.registration.description?.trim();
  const roleFileDescription = role.roleFile?.description?.trim();
  if (
    registrationDescription === undefined &&
    roleFileDescription === undefined
  ) {
    return undefined;
  }
  if (registrationDescription === roleFileDescription) {
    return undefined;
  }

  return {
    registrationDescription,
    roleFileDescription,
  };
}

export function diagnoseCodexRoleVisibility(
  roleName: string,
  higherPriorityNamespaces: CodexRoleNamespace[],
): CodexRoleVisibilityDiagnosis {
  const higherPriorityLayerMatches = higherPriorityNamespaces
    .map((namespace) => ({
      layerRoot: namespace.layerRoot,
      configPath: namespace.configPath,
      matches: namespace.roles.filter((role) => role.finalName === roleName),
    }))
    .filter((match) => match.matches.length > 0)
    .map((match) => ({
      ...match,
      matches: [...match.matches].sort((left, right) =>
        roleSortKey(left).localeCompare(roleSortKey(right)),
      ),
    }));

  return {
    roleName,
    state:
      higherPriorityLayerMatches.length > 0
        ? 'unknownByExternalLayer'
        : 'visible',
    higherPriorityLayerMatches,
  };
}

export function planCodexManagedRoleRemoval(options: {
  content: string;
  configPath: string;
  roleKey: string;
  managedRoleLayerPath: string;
}): CodexManagedRoleRemovalPlan {
  const snapshot = parseCodexConfig(options.content);
  const registration = snapshot.agents[options.roleKey];
  const expectedRoleLayerPath = normalizeFsPath(options.managedRoleLayerPath);
  const currentRoleLayerPath = registration?.configFile
    ? resolveCodexRoleLayerPath(path.dirname(options.configPath), registration.configFile)
    : undefined;

  return {
    content: removeCodexAgentRegistration(options.content, options.roleKey),
    registrationRemoved: registration !== undefined,
    roleLayerPathToDelete: expectedRoleLayerPath,
    driftedConfigFilePath:
      currentRoleLayerPath && currentRoleLayerPath !== expectedRoleLayerPath
        ? currentRoleLayerPath
        : undefined,
  };
}
