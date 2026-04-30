import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import { TRACKING_MANIFEST_FILE } from '../../src/constants.js';
import type {
  InstalledLedger,
  LedgerStateReason,
  PlatformName,
  Scope,
} from '../../src/types.js';

export type ZeroWriteSnapshotTargetKind = 'path' | 'file' | 'directory' | 'jsonLedger';

export interface ZeroWriteSnapshotTarget {
  label: string;
  path: string;
  kind?: ZeroWriteSnapshotTargetKind;
}

export interface ZeroWriteSnapshotOptions {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  awHome?: string;
  codexHome?: string;
  claudeHome?: string;
  includeDefaultTargets?: boolean;
  extraTargets?: ZeroWriteSnapshotTarget[];
}

export interface ZeroWriteSnapshot {
  capturedAt: string;
  targets: CapturedZeroWriteTarget[];
}

export interface CapturedZeroWriteTarget extends Required<ZeroWriteSnapshotTarget> {
  entry: PathEntrySnapshot;
}

interface AbsentEntrySnapshot {
  state: 'absent';
}

interface FileEntrySnapshot {
  state: 'file';
  size: number;
  sha256: string;
  ledger?: JsonLedgerSnapshot;
}

interface DirectoryEntrySnapshot {
  state: 'directory';
  sha256: string;
  entries: DirectorySnapshotEntry[];
}

interface SymlinkEntrySnapshot {
  state: 'symlink';
  target: string;
}

interface OtherEntrySnapshot {
  state: 'other';
  mode: number;
  size: number;
}

type PathEntrySnapshot =
  | AbsentEntrySnapshot
  | FileEntrySnapshot
  | DirectoryEntrySnapshot
  | SymlinkEntrySnapshot
  | OtherEntrySnapshot;

interface DirectorySnapshotEntry {
  path: string;
  type: 'directory' | 'file' | 'symlink' | 'other';
  size?: number;
  sha256?: string;
  target?: string;
  mode?: number;
}

type JsonLedgerSnapshot =
  | {
    state: 'valid';
    normalized: string;
  }
  | {
    state: 'invalid';
    sha256: string;
    error: string;
  };

export type RepoManagedArtifactKind =
  | 'instruction'
  | 'permission'
  | 'hook'
  | 'agent'
  | 'skill'
  | 'mcpServer';

export interface CorruptedCodexConfigOptions {
  env?: NodeJS.ProcessEnv;
  codexHome?: string;
  contents?: string;
}

export interface CorruptedProjectCodexConfigOptions {
  repoRoot: string;
  contents?: string;
}

export interface CorruptedTrackingManifestOptions {
  repoRoot?: string;
  targetDir?: string;
  platform?: PlatformName;
  contents?: string;
}

export interface MissingArtifactKeyTrackingManifestOptions {
  repoRoot?: string;
  targetDir?: string;
  pluginName?: string;
  platform?: PlatformName;
  artifactKind?: RepoManagedArtifactKind;
  artifactPath?: string;
  generatedAt?: string;
}

export interface InstalledLedgerFixtureWriteResult {
  ledgerPath: string;
  ledger: InstalledLedger;
}

export interface DegradedInstalledLedgerOptions {
  env?: NodeJS.ProcessEnv;
  awHome?: string;
  reason?: LedgerStateReason;
  degradedAt?: string;
  plugins?: InstalledLedger['plugins'];
}

export interface MissingScopeInstalledLedgerOptions {
  env?: NodeJS.ProcessEnv;
  awHome?: string;
  pluginName?: string;
  platform?: PlatformName;
  scope?: Scope;
  lastResolvedVersion?: string;
  lastRequestedAt?: string;
}

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJson(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeJson(value[key])]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function explicitEnvPath(
  options: { env?: NodeJS.ProcessEnv },
  key: 'AW_HOME' | 'AW_CODEX_HOME' | 'AW_CLAUDE_HOME',
): string | undefined {
  const value = (options.env ?? process.env)[key];
  return value && value.trim() !== '' ? value : undefined;
}

function resolveAwHomeForFixture(options: { env?: NodeJS.ProcessEnv; awHome?: string }): string {
  const awHome = options.awHome ?? explicitEnvPath(options, 'AW_HOME');
  if (!awHome) {
    throw new Error('AW_HOME fixture path is required. Pass awHome or env.AW_HOME.');
  }
  return awHome;
}

function resolveCodexHomeForFixture(options: { env?: NodeJS.ProcessEnv; codexHome?: string }): string {
  const codexHome = options.codexHome ?? explicitEnvPath(options, 'AW_CODEX_HOME');
  if (!codexHome) {
    throw new Error('Codex home fixture path is required. Pass codexHome or env.AW_CODEX_HOME.');
  }
  return codexHome;
}

function resolveTrackingDir(options: {
  repoRoot?: string;
  targetDir?: string;
  platform?: PlatformName;
}): string {
  if (options.targetDir) {
    return options.targetDir;
  }
  if (!options.repoRoot) {
    throw new Error('Tracking fixture requires repoRoot or targetDir.');
  }
  return path.join(options.repoRoot, options.platform === 'claude' ? '.claude' : '.codex');
}

function installedLedgerPath(awHome: string): string {
  return path.join(awHome, 'installed.json');
}

function trackingManifestPath(targetDir: string): string {
  return path.join(targetDir, TRACKING_MANIFEST_FILE);
}

function normalizeTarget(target: ZeroWriteSnapshotTarget): Required<ZeroWriteSnapshotTarget> {
  return {
    label: target.label,
    path: path.resolve(target.path),
    kind: target.kind ?? 'path',
  };
}

function dedupeTargets(targets: ZeroWriteSnapshotTarget[]): Required<ZeroWriteSnapshotTarget>[] {
  const seen = new Set<string>();
  const output: Required<ZeroWriteSnapshotTarget>[] = [];

  for (const target of targets.map(normalizeTarget)) {
    const key = `${target.kind}\0${target.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(target);
  }

  return output;
}

export function createDefaultZeroWriteSnapshotTargets(
  options: ZeroWriteSnapshotOptions,
): ZeroWriteSnapshotTarget[] {
  const repoRoot = path.resolve(options.repoRoot);
  const env = options.env ?? process.env;
  const awHome = options.awHome ?? explicitEnvPath({ env }, 'AW_HOME');
  const codexHome = options.codexHome ?? explicitEnvPath({ env }, 'AW_CODEX_HOME');
  const claudeHome = options.claudeHome ?? explicitEnvPath({ env }, 'AW_CLAUDE_HOME');

  const targets: ZeroWriteSnapshotTarget[] = [
    {
      label: 'repo .agents artifacts',
      path: path.join(repoRoot, '.agents'),
      kind: 'directory',
    },
    {
      label: 'repo .codex artifacts and tracking',
      path: path.join(repoRoot, '.codex'),
      kind: 'directory',
    },
    {
      label: 'repo .claude artifacts and tracking',
      path: path.join(repoRoot, '.claude'),
      kind: 'directory',
    },
    {
      label: 'project AW config store',
      path: path.join(repoRoot, '.agent-workflows', 'plugin-config'),
      kind: 'directory',
    },
  ];

  if (awHome) {
    targets.push(
      {
        label: 'AW installed ledger',
        path: installedLedgerPath(awHome),
        kind: 'jsonLedger',
      },
      {
        label: 'AW user config store',
        path: path.join(awHome, 'plugin-config'),
        kind: 'directory',
      },
      {
        label: 'AW install snapshots',
        path: path.join(awHome, 'plugin-install-snapshots'),
        kind: 'directory',
      },
      {
        label: 'AW local marketplace config',
        path: path.join(awHome, 'config.json'),
        kind: 'file',
      },
      {
        label: 'AW shared Codex runtime',
        path: path.join(awHome, '.agents'),
        kind: 'directory',
      },
      {
        label: 'AW shared Claude runtime',
        path: path.join(awHome, '.claude-plugin'),
        kind: 'directory',
      },
      {
        label: 'AW shared plugin bundles',
        path: path.join(awHome, 'plugins'),
        kind: 'directory',
      },
    );
  }

  if (codexHome) {
    targets.push({
      label: 'Codex native config',
      path: path.join(codexHome, 'config.toml'),
      kind: 'file',
    });
  }

  if (claudeHome) {
    targets.push(
      {
        label: 'Claude native settings',
        path: path.join(claudeHome, 'settings.json'),
        kind: 'file',
      },
      {
        label: 'Claude native plugins registry/cache',
        path: path.join(claudeHome, 'plugins'),
        kind: 'directory',
      },
    );
  }

  return targets;
}

export async function captureZeroWriteSnapshot(
  options: ZeroWriteSnapshotOptions,
): Promise<ZeroWriteSnapshot> {
  const targets = options.includeDefaultTargets === false
    ? []
    : createDefaultZeroWriteSnapshotTargets(options);
  targets.push(...(options.extraTargets ?? []));

  const capturedTargets: CapturedZeroWriteTarget[] = [];
  for (const target of dedupeTargets(targets)) {
    capturedTargets.push({
      ...target,
      entry: await capturePathEntry(target.path, target.kind),
    });
  }

  return {
    capturedAt: new Date().toISOString(),
    targets: capturedTargets,
  };
}

export async function collectZeroWriteSnapshotDiffs(
  snapshot: ZeroWriteSnapshot,
): Promise<string[]> {
  const diffs: string[] = [];

  for (const before of snapshot.targets) {
    const after = await capturePathEntry(before.path, before.kind);
    diffs.push(...comparePathEntry(before, before.entry, after));
  }

  return diffs;
}

export async function assertZeroWriteSnapshotUnchanged(
  snapshot: ZeroWriteSnapshot,
): Promise<void> {
  const diffs = await collectZeroWriteSnapshotDiffs(snapshot);
  if (diffs.length > 0) {
    throw new Error([
      'Expected command to leave zero-write snapshot unchanged, but state changed:',
      ...diffs.map((diff) => `- ${diff}`),
    ].join('\n'));
  }
}

export async function runWithZeroWriteSnapshot<T>(
  options: ZeroWriteSnapshotOptions,
  action: () => Promise<T>,
): Promise<T> {
  const snapshot = await captureZeroWriteSnapshot(options);
  let result: T | undefined;
  let actionError: unknown;

  try {
    result = await action();
  } catch (error) {
    actionError = error;
  }

  try {
    await assertZeroWriteSnapshotUnchanged(snapshot);
  } catch (snapshotError) {
    if (actionError) {
      const originalMessage = actionError instanceof Error ? actionError.message : String(actionError);
      const error = snapshotError instanceof Error ? snapshotError : new Error(String(snapshotError));
      error.message = `${error.message}\nOriginal action error: ${originalMessage}`;
      throw error;
    }
    throw snapshotError;
  }

  if (actionError) {
    throw actionError;
  }

  return result as T;
}

async function capturePathEntry(
  filePath: string,
  targetKind: ZeroWriteSnapshotTargetKind,
): Promise<PathEntrySnapshot> {
  const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });

  if (!stat) {
    return { state: 'absent' };
  }

  if (stat.isDirectory()) {
    const entries = await captureDirectoryEntries(filePath);
    return {
      state: 'directory',
      entries,
      sha256: sha256(stableJson(entries)),
    };
  }

  if (stat.isFile()) {
    const contents = await fs.readFile(filePath);
    const entry: FileEntrySnapshot = {
      state: 'file',
      size: stat.size,
      sha256: sha256(contents),
    };
    if (targetKind === 'jsonLedger') {
      entry.ledger = captureJsonLedger(contents);
    }
    return entry;
  }

  if (stat.isSymbolicLink()) {
    return {
      state: 'symlink',
      target: await fs.readlink(filePath),
    };
  }

  return {
    state: 'other',
    mode: stat.mode,
    size: stat.size,
  };
}

async function captureDirectoryEntries(rootDir: string): Promise<DirectorySnapshotEntry[]> {
  const entries: DirectorySnapshotEntry[] = [];

  async function visit(currentDir: string, relativeDir: string): Promise<void> {
    const dirents = await fs.readdir(currentDir, { withFileTypes: true });
    dirents.sort((left, right) => left.name.localeCompare(right.name));

    for (const dirent of dirents) {
      const absolutePath = path.join(currentDir, dirent.name);
      const relativePath = toPosixPath(path.join(relativeDir, dirent.name));
      const stat = await fs.lstat(absolutePath);

      if (stat.isDirectory()) {
        entries.push({
          path: relativePath,
          type: 'directory',
        });
        await visit(absolutePath, relativePath);
        continue;
      }

      if (stat.isFile()) {
        entries.push({
          path: relativePath,
          type: 'file',
          size: stat.size,
          sha256: sha256(await fs.readFile(absolutePath)),
        });
        continue;
      }

      if (stat.isSymbolicLink()) {
        entries.push({
          path: relativePath,
          type: 'symlink',
          target: await fs.readlink(absolutePath),
        });
        continue;
      }

      entries.push({
        path: relativePath,
        type: 'other',
        mode: stat.mode,
        size: stat.size,
      });
    }
  }

  await visit(rootDir, '');
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function captureJsonLedger(contents: Buffer): JsonLedgerSnapshot {
  try {
    return {
      state: 'valid',
      normalized: stableJson(JSON.parse(contents.toString('utf8'))),
    };
  } catch (error) {
    return {
      state: 'invalid',
      sha256: sha256(contents),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function comparePathEntry(
  target: CapturedZeroWriteTarget,
  before: PathEntrySnapshot,
  after: PathEntrySnapshot,
): string[] {
  if (before.state === 'absent') {
    return after.state === 'absent'
      ? []
      : [`${target.label} (${target.path}) was expected to remain absent, but became ${after.state}.`];
  }

  if (before.state !== after.state) {
    return [
      `${target.label} (${target.path}) changed from ${before.state} to ${after.state}.`,
    ];
  }

  if (before.state === 'file' && after.state === 'file') {
    if (target.kind === 'jsonLedger') {
      return compareJsonLedger(target, before, after);
    }
    return before.sha256 === after.sha256
      ? []
      : [`${target.label} (${target.path}) file content changed.`];
  }

  if (before.state === 'directory' && after.state === 'directory') {
    return before.sha256 === after.sha256
      ? []
      : [`${target.label} (${target.path}) directory content changed: ${summarizeDirectoryDiff(before, after)}.`];
  }

  if (before.state === 'symlink' && after.state === 'symlink') {
    return before.target === after.target
      ? []
      : [`${target.label} (${target.path}) symlink target changed.`];
  }

  if (before.state === 'other' && after.state === 'other') {
    return before.mode === after.mode && before.size === after.size
      ? []
      : [`${target.label} (${target.path}) special file metadata changed.`];
  }

  return [];
}

function compareJsonLedger(
  target: CapturedZeroWriteTarget,
  before: FileEntrySnapshot,
  after: FileEntrySnapshot,
): string[] {
  if (!before.ledger || !after.ledger) {
    return before.sha256 === after.sha256
      ? []
      : [`${target.label} (${target.path}) ledger file content changed.`];
  }

  if (before.ledger.state === 'valid' && after.ledger.state === 'valid') {
    return before.ledger.normalized === after.ledger.normalized
      ? []
      : [`${target.label} (${target.path}) JSON ledger value changed.`];
  }

  if (before.ledger.state === 'invalid' && after.ledger.state === 'invalid') {
    return before.ledger.sha256 === after.ledger.sha256
      ? []
      : [`${target.label} (${target.path}) invalid ledger bytes changed.`];
  }

  return [
    `${target.label} (${target.path}) ledger parse state changed from ${before.ledger.state} to ${after.ledger.state}.`,
  ];
}

function summarizeDirectoryDiff(
  before: DirectoryEntrySnapshot,
  after: DirectoryEntrySnapshot,
): string {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const added = after.entries
    .filter((entry) => !beforeByPath.has(entry.path))
    .map((entry) => entry.path);
  const removed = before.entries
    .filter((entry) => !afterByPath.has(entry.path))
    .map((entry) => entry.path);
  const changed = before.entries
    .filter((entry) => {
      const next = afterByPath.get(entry.path);
      return next && stableJson(entry) !== stableJson(next);
    })
    .map((entry) => entry.path);

  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(`added ${formatPathList(added)}`);
  }
  if (removed.length > 0) {
    parts.push(`removed ${formatPathList(removed)}`);
  }
  if (changed.length > 0) {
    parts.push(`changed ${formatPathList(changed)}`);
  }
  return parts.join('; ') || 'digest changed';
}

function formatPathList(paths: string[]): string {
  const visible = paths.slice(0, 5).join(', ');
  return paths.length > 5 ? `${visible}, ...` : visible;
}

export async function writeCorruptedCodexUserConfig(
  options: CorruptedCodexConfigOptions = {},
): Promise<string> {
  const configPath = path.join(resolveCodexHomeForFixture(options), 'config.toml');
  await fs.outputFile(
    configPath,
    options.contents ?? '[plugins."git-commit@aw"\nsource = "unterminated"\n',
    'utf8',
  );
  return configPath;
}

export async function writeCorruptedCodexProjectConfig(
  options: CorruptedProjectCodexConfigOptions,
): Promise<string> {
  const configPath = path.join(options.repoRoot, '.codex', 'config.toml');
  await fs.outputFile(
    configPath,
    options.contents ?? '[mcp_servers."acme.tools v1"\ncommand = "node"\n',
    'utf8',
  );
  return configPath;
}

export async function writeCorruptedTrackingManifest(
  options: CorruptedTrackingManifestOptions,
): Promise<string> {
  const manifestPath = trackingManifestPath(resolveTrackingDir(options));
  await fs.outputFile(
    manifestPath,
    options.contents ?? '{"version":1,"plugins":{"git-commit":',
    'utf8',
  );
  return manifestPath;
}

export async function writeTrackingManifestWithMissingArtifactKey(
  options: MissingArtifactKeyTrackingManifestOptions = {},
): Promise<{ manifestPath: string; manifest: Record<string, unknown> }> {
  const platform = options.platform ?? 'codex';
  const artifactKind = options.artifactKind ?? 'skill';
  const targetDir = resolveTrackingDir({
    repoRoot: options.repoRoot,
    targetDir: options.targetDir,
    platform,
  });
  const artifactPath = options.artifactPath ?? defaultArtifactPath({
    artifactKind,
    repoRoot: options.repoRoot,
    targetDir,
  });
  const manifestPath = trackingManifestPath(targetDir);
  const pluginName = options.pluginName ?? 'git-commit';
  const manifest = {
    version: 1,
    plugins: {
      [pluginName]: {
        name: pluginName,
        generatedAt: options.generatedAt ?? '2026-04-30T00:00:00.000Z',
        artifacts: [
          {
            path: artifactPath,
            kind: artifactKind,
            platform,
          },
        ],
      },
    },
  };

  await fs.outputJson(manifestPath, manifest, { spaces: 2 });
  return { manifestPath, manifest };
}

function defaultArtifactPath(options: {
  artifactKind: RepoManagedArtifactKind;
  repoRoot?: string;
  targetDir: string;
}): string {
  if (options.artifactKind === 'skill') {
    return path.join(options.repoRoot ?? path.dirname(options.targetDir), '.agents', 'skills', 'commit');
  }

  if (options.artifactKind === 'mcpServer') {
    return path.join(options.targetDir, 'config.toml');
  }

  return path.join(options.targetDir, `aw-git-commit-${options.artifactKind}`);
}

export function createDegradedInstalledLedgerFixture(
  options: Omit<DegradedInstalledLedgerOptions, 'env' | 'awHome'> = {},
): InstalledLedger {
  return {
    version: 1,
    ledgerState: {
      status: 'degraded',
      degradedAt: options.degradedAt ?? '2026-04-30T00:00:00.000Z',
      reason: options.reason ?? 'operation_interrupted_after_artifact_write',
    },
    plugins: options.plugins ?? {},
  };
}

export async function writeDegradedInstalledLedger(
  options: DegradedInstalledLedgerOptions = {},
): Promise<InstalledLedgerFixtureWriteResult> {
  const awHome = resolveAwHomeForFixture(options);
  const ledger = createDegradedInstalledLedgerFixture(options);
  return writeInstalledLedgerFixture(awHome, ledger);
}

export async function writeInstalledLedgerMissingScopeRecord(
  options: MissingScopeInstalledLedgerOptions = {},
): Promise<InstalledLedgerFixtureWriteResult> {
  const awHome = resolveAwHomeForFixture(options);
  const platform = options.platform ?? 'codex';
  const scope = options.scope ?? 'project';
  const pluginName = options.pluginName ?? 'git-commit';
  const platformRecord: Record<string, unknown> = {
    lastRequestedScope: scope,
    lastRequestedAt: options.lastRequestedAt ?? '2026-04-30T00:00:00.000Z',
  };

  if (scope === 'project') {
    platformRecord.projectScopes = {};
  }
  if (platform === 'codex') {
    platformRecord.sharedNativeRefs = {
      user: false,
      projects: [],
    };
  }

  const ledger = {
    version: 1,
    ledgerState: {
      status: 'available',
      degradedAt: null,
      reason: null,
    },
    plugins: {
      [pluginName]: {
        lastResolvedVersion: options.lastResolvedVersion ?? '0.1.0',
        platforms: {
          [platform]: platformRecord,
        },
      },
    },
  } satisfies InstalledLedger;

  return writeInstalledLedgerFixture(awHome, ledger);
}

async function writeInstalledLedgerFixture(
  awHome: string,
  ledger: InstalledLedger,
): Promise<InstalledLedgerFixtureWriteResult> {
  const ledgerPath = installedLedgerPath(awHome);
  await fs.outputJson(ledgerPath, ledger, { spaces: 2 });
  return {
    ledgerPath,
    ledger,
  };
}
