import type {
  NormalizedPluginManifest,
  Scope,
} from '../types.js';
import { resolvePlatformHookDefinitions } from './hooks-contract.js';
import { resolvePlatformEntries } from './platform-entries.js';
import { supportsPlatform } from './platform-support.js';

export const QUALIFIED_CODEX_NATIVE_KINDS = [
  'skill',
  'mcp',
  'hook',
  'app',
] as const;

export type CodexNativeKind = typeof QUALIFIED_CODEX_NATIVE_KINDS[number];
export type CodexUnsupportedNativeKind = 'slashCommand';
export type CodexExtensionKind =
  | 'skill'
  | 'instruction'
  | 'permission'
  | 'agent'
  | 'config';
export type CodexSurfaceClassification =
  | 'empty'
  | 'native'
  | 'aw-extension'
  | 'mixed'
  | 'unsupported';
export type CodexSurfaceDeliveryOwner = 'none' | 'codex-native' | 'aw' | 'split' | 'unsupported';
export type CodexScopeOverlap = 'none' | 'native-compatible' | 'aw-owned-conflict';

export interface CodexSurfaceComponent {
  key: string;
  kind: CodexNativeKind | CodexExtensionKind;
  owner: 'codex-native' | 'aw';
  scopes: Scope[];
  dynamic: boolean;
  name?: string;
}

export interface CodexSurfaceOwnerCollision {
  kind: CodexNativeKind | CodexExtensionKind;
  name: string;
  owners: ['codex-native', 'aw'];
}

export interface CodexSurfaceAnalysisOptions {
  nativeArtifactNames?: Partial<Record<CodexNativeKind, readonly string[]>>;
}

export interface CodexSurfaceAnalysis {
  ok: boolean;
  nativeKinds: CodexNativeKind[];
  extensionKinds: CodexExtensionKind[];
  unsupportedKinds: CodexUnsupportedNativeKind[];
  classification: CodexSurfaceClassification;
  deliveryOwner: CodexSurfaceDeliveryOwner;
  scopeOverlap: CodexScopeOverlap;
  components: CodexSurfaceComponent[];
  collisions: CodexSurfaceOwnerCollision[];
  missingNativeIdentityKinds: CodexNativeKind[];
  errorCode?:
    | 'codexSurfaceOwnerCollision'
    | 'codexSurfaceNativeIdentityMissing'
    | 'codexNativeKindUnsupported';
}

export class CodexSurfaceAnalysisError extends Error {
  readonly code:
    | 'codexSurfaceOwnerCollision'
    | 'codexSurfaceNativeIdentityMissing'
    | 'codexNativeKindUnsupported';
  readonly analysis: CodexSurfaceAnalysis;

  constructor(analysis: CodexSurfaceAnalysis) {
    const code = analysis.errorCode ?? 'codexNativeKindUnsupported';
    super(`${code}: Codex surface delivery is ambiguous or unsupported.`);
    this.name = 'CodexSurfaceAnalysisError';
    this.code = code;
    this.analysis = analysis;
  }
}

const BOTH_SCOPES: Scope[] = ['project', 'user'];
const NATIVE_KIND_ORDER: Array<CodexNativeKind | CodexUnsupportedNativeKind> = [
  'skill',
  'mcp',
  'hook',
  'app',
  'slashCommand',
];
const EXTENSION_KIND_ORDER: CodexExtensionKind[] = [
  'skill',
  'instruction',
  'permission',
  'agent',
  'config',
];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addNativeComponents(
  components: CodexSurfaceComponent[],
  kind: CodexNativeKind,
  key: string,
  names: readonly string[] | undefined,
): void {
  const canonicalNames = [...new Set(names ?? [])].sort(compareText);
  if (canonicalNames.length === 0) {
    components.push({
      key,
      kind,
      owner: 'codex-native',
      scopes: [...BOTH_SCOPES],
      dynamic: false,
    });
    return;
  }
  for (const name of canonicalNames) {
    components.push({
      key: `${key}:${name}`,
      kind,
      owner: 'codex-native',
      scopes: [...BOTH_SCOPES],
      dynamic: false,
      name,
    });
  }
}

function addAwComponent(
  components: CodexSurfaceComponent[],
  component: Omit<CodexSurfaceComponent, 'owner'>,
): void {
  components.push({ ...component, owner: 'aw' });
}

function collectOwnerCollisions(
  components: readonly CodexSurfaceComponent[],
): CodexSurfaceOwnerCollision[] {
  const byIdentity = new Map<string, Set<'codex-native' | 'aw'>>();
  for (const component of components) {
    if (!component.name) continue;
    const identity = `${component.kind}\0${component.name}`;
    const owners = byIdentity.get(identity) ?? new Set();
    owners.add(component.owner);
    byIdentity.set(identity, owners);
  }
  return [...byIdentity.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([identity]) => {
      const [kind, name] = identity.split('\0') as [CodexNativeKind | CodexExtensionKind, string];
      return {
        kind,
        name,
        owners: ['codex-native', 'aw'] as ['codex-native', 'aw'],
      };
    })
    .sort((left, right) => compareText(`${left.kind}\0${left.name}`, `${right.kind}\0${right.name}`));
}

export function analyzeCodexSurface(
  manifest: NormalizedPluginManifest,
  options: CodexSurfaceAnalysisOptions = {},
): CodexSurfaceAnalysis {
  if (!supportsPlatform(manifest, 'codex')) {
    return {
      ok: true,
      nativeKinds: [],
      extensionKinds: [],
      unsupportedKinds: [],
      classification: 'empty',
      deliveryOwner: 'none',
      scopeOverlap: 'none',
      components: [],
      collisions: [],
      missingNativeIdentityKinds: [],
    };
  }

  const components: CodexSurfaceComponent[] = [];
  const nativeKinds = new Set<CodexNativeKind>();
  const extensionKinds = new Set<CodexExtensionKind>();
  const unsupportedKinds = new Set<CodexUnsupportedNativeKind>();
  const declareNative = (kind: CodexNativeKind, key: string): void => {
    nativeKinds.add(kind);
    addNativeComponents(components, kind, key, options.nativeArtifactNames?.[kind]);
  };

  if (manifest.skills) declareNative('skill', 'manifest.skills');
  if (manifest.mcpServers) declareNative('mcp', 'manifest.mcpServers');
  if (resolvePlatformHookDefinitions(manifest, 'codex').length > 0) {
    declareNative('hook', 'manifest.hooks');
  }
  if (manifest.apps) declareNative('app', 'manifest.apps');
  if (manifest.slashCommands) unsupportedKinds.add('slashCommand');

  if (manifest.config) {
    extensionKinds.add('config');
    addAwComponent(components, {
      key: 'manifest.config',
      kind: 'config',
      scopes: [...BOTH_SCOPES],
      dynamic: true,
    });
  }

  for (const instruction of resolvePlatformEntries(manifest.extensions?.instructions, 'codex')) {
    extensionKinds.add('instruction');
    addAwComponent(components, {
      key: `extensions.instructions:${instruction.name}`,
      kind: 'instruction',
      scopes: [...BOTH_SCOPES],
      dynamic: false,
      name: instruction.name,
    });
  }
  for (const permission of resolvePlatformEntries(manifest.extensions?.permissions, 'codex')) {
    extensionKinds.add('permission');
    addAwComponent(components, {
      key: `extensions.permissions:${permission.name}`,
      kind: 'permission',
      scopes: [...BOTH_SCOPES],
      dynamic: false,
      name: permission.name,
    });
  }
  for (const agent of resolvePlatformEntries(manifest.extensions?.agents, 'codex')) {
    extensionKinds.add('agent');
    addAwComponent(components, {
      key: `extensions.agents:${agent.name}`,
      kind: 'agent',
      scopes: [...BOTH_SCOPES],
      dynamic: false,
      name: agent.name,
    });
  }
  for (const target of manifest.artifacts?.targets ?? []) {
    if (target.platform !== 'codex') continue;
    const kind: CodexExtensionKind = target.target === 'codex.skill'
      ? 'skill'
      : target.target === 'codex.agentRole'
        ? 'agent'
        : 'instruction';
    extensionKinds.add(kind);
    addAwComponent(components, {
      key: `artifacts.targets:${target.id}`,
      kind,
      scopes: [...target.scopes],
      dynamic: true,
      name: target.skillKey ?? target.roleKey ?? target.id,
    });
  }

  const orderedNativeKinds = NATIVE_KIND_ORDER
    .filter((kind): kind is CodexNativeKind => kind !== 'slashCommand' && nativeKinds.has(kind));
  const orderedExtensionKinds = EXTENSION_KIND_ORDER.filter((kind) => extensionKinds.has(kind));
  const orderedUnsupportedKinds = NATIVE_KIND_ORDER
    .filter((kind): kind is CodexUnsupportedNativeKind => kind === 'slashCommand' && unsupportedKinds.has(kind));
  const collisions = collectOwnerCollisions(components);
  const missingNativeIdentityKinds = orderedNativeKinds.filter((kind) =>
    components.some((component) => component.owner === 'aw'
      && component.dynamic
      && component.kind === kind)
    && (options.nativeArtifactNames?.[kind]?.length ?? 0) === 0);
  const errorCode = collisions.length > 0
    ? 'codexSurfaceOwnerCollision' as const
    : missingNativeIdentityKinds.length > 0
      ? 'codexSurfaceNativeIdentityMissing' as const
      : orderedUnsupportedKinds.length > 0
        ? 'codexNativeKindUnsupported' as const
        : undefined;
  const classification: CodexSurfaceClassification = errorCode
    ? 'unsupported'
    : orderedNativeKinds.length > 0 && orderedExtensionKinds.length > 0
      ? 'mixed'
      : orderedNativeKinds.length > 0
        ? 'native'
        : orderedExtensionKinds.length > 0
          ? 'aw-extension'
          : 'empty';
  const deliveryOwner: CodexSurfaceDeliveryOwner = errorCode
    ? 'unsupported'
    : classification === 'mixed'
      ? 'split'
      : classification === 'native'
        ? 'codex-native'
        : classification === 'aw-extension'
          ? 'aw'
          : 'none';
  return {
    ok: errorCode === undefined,
    nativeKinds: orderedNativeKinds,
    extensionKinds: orderedExtensionKinds,
    unsupportedKinds: orderedUnsupportedKinds,
    classification,
    deliveryOwner,
    scopeOverlap: errorCode
      ? 'none'
      : orderedExtensionKinds.length > 0
        ? 'aw-owned-conflict'
        : orderedNativeKinds.length > 0
          ? 'native-compatible'
          : 'none',
    components,
    collisions,
    missingNativeIdentityKinds,
    ...(errorCode ? { errorCode } : {}),
  };
}

export function assertCodexSurfaceSupported(
  analysis: CodexSurfaceAnalysis,
): CodexSurfaceAnalysis {
  if (!analysis.ok) throw new CodexSurfaceAnalysisError(analysis);
  return analysis;
}
