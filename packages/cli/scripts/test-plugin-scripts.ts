import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import {
  buildLifecycleSpawnEnv,
  bundleLocalPlugin,
  collectSensitivePluginConfigValues,
  discoverPlugins,
  formatMarketplaceProductsForError,
  formatSupportedPlatforms,
  matchesPluginTestEntryGlob,
  prepareLocalPluginBundleSource,
  readPluginManifest,
  redactPluginScriptOutput,
  resolveAwHome,
  resolveCliPackageRoot,
  resolveEffectivePluginConfig,
  resolvePluginConfigStorePath,
  resolveSupportedPlatforms,
  scanNodeImportContract,
} from './plugin-staging.js';
import {
  createCatalogRuntimeImportResolver,
  type CatalogRuntimeImportResolver,
} from '../src/utils/catalog-runtime-projection.js';
import type {
  PlatformName,
  PluginConfigValue,
  PluginMeta,
  Scope,
} from './plugin-staging.js';
import type { NormalizedPluginManifest } from '../src/types.js';

type PluginTestPlatformSelection = PlatformName | 'both';

export interface PluginTestRunnerOptions {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface ParsedArgs {
  pluginName?: string;
  all: boolean;
  scope: Scope;
  platform: PluginTestPlatformSelection;
  testName?: string;
}

interface PreparedPluginTestBundle {
  pluginName: string;
  sourceRoot: string;
  baselineRoot: string;
  bundleRoot: string;
  manifest: NormalizedPluginManifest;
  runtimeContext: Awaited<ReturnType<typeof prepareLocalPluginBundleSource>>['runtimeContext'];
  cleanup(): Promise<void>;
}

interface StagedPluginTestBundleSource {
  pluginName: string;
  sourceRoot: string;
  baselineRoot: string;
  bundleRoot: string;
  stagedPlugin: PluginMeta;
  manifest: NormalizedPluginManifest;
  runtimeContext: Awaited<ReturnType<typeof prepareLocalPluginBundleSource>>['runtimeContext'];
  cleanup(): Promise<void>;
}

interface PreparedPluginTestSelection extends StagedPluginTestBundleSource {
  platforms: PlatformName[];
}

interface NodeTestResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const NODE_RUNTIME_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const REPO_ROOT_ENV = 'AW_PLUGIN_TEST_REPO_ROOT';
const TEST_PLATFORM_ORDER: readonly PlatformName[] = ['codex', 'claude'];

function resolveRepoRoot(): string {
  return path.resolve(resolveCliPackageRoot(), '..', '..');
}

function print(write: (text: string) => void, text: string): void {
  write(`${text}\n`);
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    all: false,
    scope: 'user',
    platform: 'both',
  };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      continue;
    } else if (arg === '--all') {
      parsed.all = true;
    } else if (arg === '--scope') {
      const value = args[++index];
      if (value !== 'user' && value !== 'project') {
        throw new Error('--scope must be one of: user, project.');
      }
      parsed.scope = value;
    } else if (arg === '--platform') {
      const value = args[++index];
      if (value !== 'codex' && value !== 'claude' && value !== 'both') {
        throw new Error('--platform must be one of: codex, claude, both.');
      }
      parsed.platform = value;
    } else if (arg === '--test-name') {
      parsed.testName = args[++index];
      if (!parsed.testName) {
        throw new Error('--test-name requires a pattern.');
      }
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}".`);
    } else {
      positional.push(arg);
    }
  }

  if (parsed.all && positional.length > 0) {
    throw new Error('Use either <plugin> or --all, not both.');
  }
  if (!parsed.all && positional.length !== 1) {
    throw new Error('Usage: pnpm plugin:test <plugin> | --all [--scope user|project] [--platform codex|claude|both] [--test-name <pattern>].');
  }
  if (parsed.all && positional.length !== 0) {
    throw new Error('Use either <plugin> or --all, not both.');
  }
  parsed.pluginName = positional[0];
  return parsed;
}

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

function normalizeRelativePath(value: string): string {
  return stripDotSlash(value).split(path.sep).join('/');
}

async function listFiles(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFiles(entryPath);
      files.push(...nested.map((file) => path.join(entry.name, file).split(path.sep).join('/')));
    } else {
      files.push(entry.name);
    }
  }
  return files.sort();
}

async function matchTestEntries(rootDir: string, globs: string[] | undefined): Promise<string[]> {
  if (!globs || globs.length === 0) {
    return [];
  }
  const files = await listFiles(rootDir);
  return files.filter((file) => globs.some((glob) => matchesPluginTestEntryGlob(file, glob))).sort();
}

async function resolvePluginRuntimeSourceSet(
  repoRoot: string,
  initialPlugins: readonly PluginMeta[],
): Promise<PluginMeta[]> {
  const plugins = new Map(initialPlugins.map((plugin) => [plugin.manifest.name, plugin]));
  const queue = [...initialPlugins];
  while (queue.length > 0) {
    const plugin = queue.shift();
    if (!plugin) continue;
    const references = [
      ...(plugin.manifest.buildConfig?.buildImports ?? []),
      ...(plugin.manifest.buildConfig?.skillRuntimeFiles ?? [])
        .map((entry) => entry.import)
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    ];
    for (const reference of references) {
      if (reference.plugin.startsWith('@aw/') || plugins.has(reference.plugin)) continue;
      const provider = await readPluginManifest(path.join(repoRoot, 'plugins', reference.plugin));
      plugins.set(provider.manifest.name, provider);
      queue.push(provider);
    }
  }
  return [...plugins.values()];
}

async function stagePluginTestBundleSource(
  plugin: PluginMeta,
  runtimeResolver: CatalogRuntimeImportResolver,
): Promise<StagedPluginTestBundleSource> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-test-bundle-'));
  const prepared = await prepareLocalPluginBundleSource(plugin, {
    buildMode: 'staging',
    runtimeResolver,
  });
  try {
    return {
      pluginName: prepared.plugin.manifest.name,
      sourceRoot: plugin.rootDir,
      baselineRoot: prepared.plugin.rootDir,
      bundleRoot: path.join(tempRoot, 'bundle'),
      stagedPlugin: prepared.plugin,
      manifest: prepared.plugin.manifest,
      runtimeContext: prepared.runtimeContext,
      cleanup: async () => {
        await prepared.cleanup();
        await fs.remove(tempRoot);
      },
    };
  } catch (error) {
    await prepared.cleanup();
    await fs.remove(tempRoot);
    throw error;
  }
}

async function buildPreparedPluginTestBundle(
  staged: StagedPluginTestBundleSource,
): Promise<PreparedPluginTestBundle> {
  const result = await bundleLocalPlugin(staged.stagedPlugin, staged.bundleRoot, {
    buildMode: 'prepared',
    preparedRuntimeContext: staged.runtimeContext,
  });
  return {
    pluginName: result.plugin.manifest.name,
    sourceRoot: staged.sourceRoot,
    baselineRoot: staged.baselineRoot,
    bundleRoot: staged.bundleRoot,
    manifest: result.plugin.manifest,
    runtimeContext: staged.runtimeContext,
    cleanup: staged.cleanup,
  };
}

function platformSelectionError(options: {
  pluginName: string;
  selection: PluginTestPlatformSelection;
  manifest: NormalizedPluginManifest;
}): Error {
  const supportedPlatforms = resolveSupportedPlatforms(options.manifest);
  return new Error(
    `Cannot run plugin tests for "${options.pluginName}" with --platform=${options.selection}: staging manifest ${formatMarketplaceProductsForError(options.manifest)} resolves to supported platforms=${formatSupportedPlatforms(supportedPlatforms)}.`,
  );
}

function resolveSelectedPlatforms(
  manifest: NormalizedPluginManifest,
  selection: PluginTestPlatformSelection,
  pluginName: string,
): PlatformName[] {
  const supportedPlatforms = resolveSupportedPlatforms(manifest);
  if (selection === 'both') {
    const platforms = TEST_PLATFORM_ORDER.filter((platform) => supportedPlatforms.has(platform));
    if (platforms.length === 0) {
      throw platformSelectionError({ pluginName, selection, manifest });
    }
    return platforms;
  }

  if (!supportedPlatforms.has(selection)) {
    throw platformSelectionError({ pluginName, selection, manifest });
  }
  return [selection];
}

function isExplicitSinglePlatformSelection(
  selection: PluginTestPlatformSelection,
): selection is PlatformName {
  return selection === 'codex' || selection === 'claude';
}

async function copyTestsIntoBundle(options: {
  baselineRoot: string;
  bundleRoot: string;
  entries: string[];
  manifest: NormalizedPluginManifest;
}): Promise<string[]> {
  const entries = options.entries.map((entry) => normalizeRelativePath(entry));
  const baselineFiles = await listFiles(options.baselineRoot);
  const bundleFiles = await listFiles(options.bundleRoot);
  const baselineFileSet = new Set(baselineFiles);
  const bundleFileSet = new Set(bundleFiles);
  for (const entry of entries) {
    if (await fs.pathExists(path.join(options.bundleRoot, entry))) {
      throw new Error(`Test entry "${entry}" conflicts with a runtime bundle file.`);
    }
  }

  const filePaths = [...new Set([...baselineFiles, ...bundleFiles])];
  const scanFiles: Record<string, string> = {};
  await Promise.all(filePaths
    .filter((file) => (
      NODE_RUNTIME_EXTENSIONS.has(path.posix.extname(file).toLowerCase())
      || path.posix.basename(file) === 'package.json'
    ))
    .map(async (file) => {
      const root = bundleFileSet.has(file) ? options.bundleRoot : options.baselineRoot;
      scanFiles[file] = await fs.readFile(path.join(root, file), 'utf8');
    }));
  const { dependencies, devDependencies } = await readPackageDependencyNames(
    options.bundleRoot,
    options.manifest,
  );
  const scan = scanNodeImportContract({
    files: scanFiles,
    filePaths,
    entryFiles: entries,
    dependencies,
    devDependencies,
    allowDevDependencies: Boolean(options.manifest.scripts?.node?.packageRoot),
  });
  if (scan.errors.length > 0) {
    throw new Error(`Invalid plugin test imports:\n${scan.errors.join('\n')}`);
  }

  for (const file of scan.files) {
    if (bundleFileSet.has(file)) {
      continue;
    }
    if (!baselineFileSet.has(file)) {
      throw new Error(`Missing test file "${file}".`);
    }
    const targetPath = path.join(options.bundleRoot, file);
    await fs.ensureDir(path.dirname(targetPath));
    await fs.copyFile(path.join(options.baselineRoot, file), targetPath);
  }
  return entries;
}

async function readPackageDependencyNames(
  bundleRoot: string,
  manifest: NormalizedPluginManifest,
): Promise<{ dependencies: string[]; devDependencies: string[] }> {
  const packageRoot = manifest.scripts?.node?.packageRoot;
  if (!packageRoot) {
    return { dependencies: [], devDependencies: [] };
  }
  const packageJson = await fs.readJson(path.join(bundleRoot, stripDotSlash(packageRoot), 'package.json'));
  const dependencies = packageJson.dependencies && typeof packageJson.dependencies === 'object'
    ? Object.keys(packageJson.dependencies)
    : [];
  const devDependencies = packageJson.devDependencies && typeof packageJson.devDependencies === 'object'
    ? Object.keys(packageJson.devDependencies)
    : [];
  return { dependencies, devDependencies };
}

async function copyTestPackageNodeModules(options: {
  baselineRoot: string;
  bundleRoot: string;
  manifest: NormalizedPluginManifest;
}): Promise<void> {
  const packageRoot = options.manifest.scripts?.node?.packageRoot;
  if (!packageRoot) {
    return;
  }
  const sourcePackageRoot = path.join(options.baselineRoot, stripDotSlash(packageRoot));
  const targetPackageRoot = path.join(options.bundleRoot, stripDotSlash(packageRoot));
  const sourceNodeModules = path.join(sourcePackageRoot, 'node_modules');
  if (!(await fs.pathExists(sourceNodeModules))) {
    return;
  }

  const targetNodeModules = path.join(targetPackageRoot, 'node_modules');
  await fs.remove(targetNodeModules);
  await fs.copy(sourceNodeModules, targetNodeModules, { dereference: false });
}

async function writeTestContext(options: {
  bundleRoot: string;
  sourceRoot: string;
  manifest: NormalizedPluginManifest;
  platform: PlatformName;
  scope: Scope;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  tempDir: string;
}): Promise<{ contextPath: string; sensitiveValues: string[] }> {
  const sourceId = 'plugin-test';
  const sourceIdentity = `sha256:${crypto.createHash('sha256')
    .update(`${sourceId}/${options.manifest.name}`, 'utf8')
    .digest('hex')}`;
  const configStores = {
    user: resolvePluginConfigStorePath({
      sourceId,
      pluginName: options.manifest.name,
      scope: 'user',
      cwd: options.projectRoot,
      env: options.env,
    }),
    project: resolvePluginConfigStorePath({
      sourceId,
      pluginName: options.manifest.name,
      scope: 'project',
      cwd: options.projectRoot,
      env: options.env,
    }),
  };
  if (options.manifest.config?.fields) {
    await Promise.all(Object.values(configStores).map((storePath) => fs.outputJson(storePath, {
      schemaVersion: 3,
      sourceId,
      sourceIdentity,
      pluginName: options.manifest.name,
      values: {},
    }, { spaces: 2 })));
  }
  const effective = options.manifest.config?.fields
    ? await resolveEffectivePluginConfig({
        sourceId,
        sourceIdentity,
        manifest: options.manifest,
        cwd: options.projectRoot,
        env: options.env,
      })
    : { values: {}, sources: {}, schema: undefined, issues: [] };
  const contextPath = path.join(options.tempDir, 'context.json');
  await fs.writeJson(contextPath, {
    version: 1,
    event: 'test',
    plugin: {
      name: options.manifest.name,
      version: options.manifest.version,
      rootDir: options.bundleRoot,
      sourceId,
      sourceIdentity,
      pluginId: `${sourceId}/${options.manifest.name}`,
    },
    sourceRoot: options.sourceRoot,
    platform: options.platform,
    scope: options.scope,
    cwd: options.projectRoot,
    paths: {
      awHome: resolveAwHome(options.env),
      configStores,
    },
    config: {
      values: effective.values,
      sources: effective.sources,
      schema: effective.schema,
      issues: effective.issues,
    },
    script: {
      source: 'plugin-test',
      runner: 'node',
      path: null,
    },
    artifacts: [],
  }, { spaces: 2 });
  try {
    await fs.chmod(contextPath, 0o600);
  } catch {
    // Best effort.
  }
  return {
    contextPath,
    sensitiveValues: collectSensitivePluginConfigValues(options.manifest, effective.values as Record<string, PluginConfigValue>),
  };
}

function runNodeTest(options: {
  testFiles: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  testName?: string;
}): Promise<NodeTestResult> {
  return new Promise((resolve, reject) => {
    const args = ['--test'];
    if (options.testName) {
      args.push('--test-name-pattern', options.testName);
    }
    args.push(...options.testFiles);
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

async function runPreparedPluginTests(options: {
  prepared: PreparedPluginTestBundle;
  scope: Scope;
  platform: PlatformName;
  testName?: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}): Promise<number> {
  const entries = await matchTestEntries(
    options.prepared.baselineRoot,
    options.prepared.manifest.scripts?.tests?.node,
  );
  if (entries.length === 0) {
    print(options.stdout, `${options.prepared.pluginName} / ${options.platform}: skipped (no tests matched)`);
    return 0;
  }

  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-test-run-'));
  try {
    const bundleRoot = path.join(runRoot, 'bundle');
    const projectRoot = path.join(runRoot, 'project');
    const awHome = path.join(runRoot, 'aw-home');
    const tempDir = path.join(runRoot, 'tmp');
    await fs.copy(options.prepared.bundleRoot, bundleRoot);
    await copyTestPackageNodeModules({
      baselineRoot: options.prepared.baselineRoot,
      bundleRoot,
      manifest: options.prepared.manifest,
    });
    await fs.ensureDir(projectRoot);
    await fs.ensureDir(awHome);
    await fs.ensureDir(tempDir);
    await fs.ensureDir(path.join(tempDir, 'home'));
    await fs.ensureDir(path.join(tempDir, 'tmp'));
    const canonicalProjectRoot = await fs.realpath(projectRoot);
    const copiedEntries = await copyTestsIntoBundle({
      baselineRoot: options.prepared.baselineRoot,
      bundleRoot,
      entries,
      manifest: options.prepared.manifest,
    });

    const env = {
      ...options.env,
      AW_HOME: awHome,
      AW_CODEX_HOME: path.join(runRoot, 'codex-home'),
      AW_CLAUDE_HOME: path.join(runRoot, 'claude-home'),
      NODE_PATH: '',
    } as NodeJS.ProcessEnv;
    const writtenContext = await writeTestContext({
      bundleRoot,
      sourceRoot: options.prepared.sourceRoot,
      manifest: options.prepared.manifest,
      platform: options.platform,
      scope: options.scope,
      projectRoot: canonicalProjectRoot,
      env,
      tempDir,
    });
    const spawnEnv = buildLifecycleSpawnEnv({
      commandEnv: env,
      contextPath: writtenContext.contextPath,
      tempDir,
      plugin: {
        name: options.prepared.manifest.name,
        version: options.prepared.manifest.version,
      },
      event: 'test',
      platform: options.platform,
      scope: options.scope,
      bundleRoot,
    });
    spawnEnv.NODE_PATH = '';

    const testFiles = copiedEntries.map((entry) => path.join(bundleRoot, entry));
    const result = await runNodeTest({
      testFiles,
      cwd: canonicalProjectRoot,
      env: spawnEnv,
      testName: options.testName,
    });
    const stdout = redactPluginScriptOutput(result.stdout, writtenContext.sensitiveValues);
    const stderr = redactPluginScriptOutput(result.stderr, writtenContext.sensitiveValues);
    if (stdout.trim()) {
      options.stdout(stdout);
    }
    if (stderr.trim()) {
      options.stderr(stderr);
    }
    if (result.exitCode === 0) {
      print(options.stdout, `${options.prepared.pluginName} / ${options.platform}: passed (${entries.length} test file${entries.length === 1 ? '' : 's'})`);
      return 0;
    }
    print(options.stderr, `${options.prepared.pluginName} / ${options.platform}: failed`);
    return result.exitCode ?? 1;
  } finally {
    await fs.remove(runRoot);
  }
}

async function preparePluginSelection(options: {
  plugin: PluginMeta;
  parsed: ParsedArgs;
  runtimeResolver: CatalogRuntimeImportResolver;
}): Promise<PreparedPluginTestSelection> {
  const staged = await stagePluginTestBundleSource(options.plugin, options.runtimeResolver);
  try {
    const platforms = resolveSelectedPlatforms(
      staged.manifest,
      options.parsed.platform,
      staged.pluginName,
    );
    return {
      ...staged,
      platforms,
    };
  } catch (error) {
    await staged.cleanup();
    throw error;
  }
}

async function runPreparedPluginSelection(options: {
  selection: PreparedPluginTestSelection;
  parsed: ParsedArgs;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}): Promise<number> {
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    await options.selection.cleanup();
  };

  try {
    const prepared = await buildPreparedPluginTestBundle(options.selection);
    try {
      let exitCode = 0;
      for (const platform of options.selection.platforms) {
        const platformExitCode = await runPreparedPluginTests({
          prepared,
          scope: options.parsed.scope,
          platform,
          testName: options.parsed.testName,
          env: options.env,
          stdout: options.stdout,
          stderr: options.stderr,
        });
        if (platformExitCode !== 0) {
          exitCode = platformExitCode;
        }
      }
      return exitCode;
    } finally {
      await cleanup();
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function runPluginScriptTests(
  args: string[],
  options: PluginTestRunnerOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    print(stderr, error instanceof Error ? error.message : String(error));
    return 1;
  }
  const configuredRepoRoot = options.repoRoot ?? env[REPO_ROOT_ENV];
  const repoRoot = configuredRepoRoot ? path.resolve(configuredRepoRoot) : resolveRepoRoot();

  if (parsed.all) {
    const plugins = await discoverPlugins(repoRoot);
    const runtimeResolver = createCatalogRuntimeImportResolver(plugins);
    if (isExplicitSinglePlatformSelection(parsed.platform)) {
      const preparedSelections: PreparedPluginTestSelection[] = [];
      const failures: string[] = [];
      for (const plugin of plugins) {
        try {
          preparedSelections.push(await preparePluginSelection({ plugin, parsed, runtimeResolver }));
        } catch (error) {
          failures.push(
            `${plugin.manifest.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (failures.length > 0) {
        await Promise.all(preparedSelections.map(async (selection) => selection.cleanup()));
        failures.forEach((failure) => print(stderr, failure));
        return 1;
      }

      let exitCode = 0;
      for (const selection of preparedSelections) {
        try {
          const pluginExitCode = await runPreparedPluginSelection({
            selection,
            parsed,
            env,
            stdout,
            stderr,
          });
          if (pluginExitCode !== 0) {
            exitCode = pluginExitCode;
          }
        } catch (error) {
          print(
            stderr,
            `${selection.pluginName}: ${error instanceof Error ? error.message : String(error)}`,
          );
          exitCode = 1;
        }
      }
      return exitCode;
    }

    let exitCode = 0;
    for (const plugin of plugins) {
      try {
        const selection = await preparePluginSelection({ plugin, parsed, runtimeResolver });
        const pluginExitCode = await runPreparedPluginSelection({
          selection,
          parsed,
          env,
          stdout,
          stderr,
        });
        if (pluginExitCode !== 0) {
          exitCode = pluginExitCode;
        }
      } catch (error) {
        print(stderr, `${plugin.manifest.name}: ${error instanceof Error ? error.message : String(error)}`);
        exitCode = 1;
      }
    }
    return exitCode;
  }

  try {
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', parsed.pluginName!));
    const sourceSet = await resolvePluginRuntimeSourceSet(repoRoot, [plugin]);
    const runtimeResolver = createCatalogRuntimeImportResolver(sourceSet);
    const selection = await preparePluginSelection({ plugin, parsed, runtimeResolver });
    return await runPreparedPluginSelection({ selection, parsed, env, stdout, stderr });
  } catch (error) {
    print(stderr, error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const currentEntryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentEntryPath) {
  runPluginScriptTests(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
