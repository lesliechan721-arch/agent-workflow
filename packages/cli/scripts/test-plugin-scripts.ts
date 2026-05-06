import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import {
  buildLifecycleSpawnEnv,
  bundleLocalPlugin,
  collectSensitivePluginConfigValues,
  coercePluginConfigValue,
  discoverPlugins,
  formatMarketplaceProductsForError,
  formatSupportedPlatforms,
  prepareLocalPluginBundleSource,
  readPluginManifest,
  redactPluginScriptOutput,
  resolveAwHome,
  resolveCliPackageRoot,
  resolveEffectivePluginConfig,
  resolvePluginConfigStorePath,
  resolveSupportedPlatforms,
  scanJavaScriptImportSpecifiers,
  scanNodeImportContract,
} from './plugin-staging.js';
import type {
  PlatformName,
  PluginConfigSchemaField,
  PluginConfigValue,
  PluginManifestSource,
  PluginMeta,
  Scope,
} from './plugin-staging.js';

type PluginTestPlatformSelection = PlatformName | 'both' | 'auto';

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
  manifest: PluginManifestSource;
  cleanup(): Promise<void>;
}

interface StagedPluginTestBundleSource {
  pluginName: string;
  sourceRoot: string;
  baselineRoot: string;
  bundleRoot: string;
  stagedPlugin: PluginMeta;
  manifest: PluginManifestSource;
  cleanup(): Promise<void>;
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
    platform: 'auto',
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
      if (value !== 'codex' && value !== 'claude' && value !== 'both' && value !== 'auto') {
        throw new Error('--platform must be one of: codex, claude, both, auto.');
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
    throw new Error('Usage: pnpm plugin:test <plugin> | --all [--scope user|project] [--platform codex|claude|both|auto] [--test-name <pattern>].');
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

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizeRelativePath(glob);
  let output = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === '*' && next === '*') {
      const after = normalized[index + 2];
      if (after === '/') {
        output += '(?:.*\\/)?';
        index += 2;
      } else {
        output += '.*';
        index += 1;
      }
    } else if (char === '*') {
      output += '[^/]*';
    } else {
      output += escapeRegExp(char);
    }
  }
  output += '$';
  return new RegExp(output);
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
  const patterns = globs.map(globToRegExp);
  return files.filter((file) => patterns.some((pattern) => pattern.test(file))).sort();
}

async function findSourcePlugin(repoRoot: string, pluginName: string): Promise<PluginMeta> {
  const pluginRoot = path.join(repoRoot, 'plugins', pluginName);
  return readPluginManifest(pluginRoot);
}

async function stagePluginTestBundleSource(
  plugin: PluginMeta,
): Promise<StagedPluginTestBundleSource> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-test-bundle-'));
  const prepared = await prepareLocalPluginBundleSource(plugin, { buildMode: 'staging' });
  try {
    return {
      pluginName: prepared.plugin.manifest.name,
      sourceRoot: plugin.rootDir,
      baselineRoot: prepared.plugin.rootDir,
      bundleRoot: path.join(tempRoot, 'bundle'),
      stagedPlugin: prepared.plugin,
      manifest: prepared.plugin.manifest,
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
  const result = await bundleLocalPlugin(staged.stagedPlugin, staged.bundleRoot, { buildMode: 'prepared' });
  return {
    pluginName: result.plugin.manifest.name,
    sourceRoot: staged.sourceRoot,
    baselineRoot: staged.baselineRoot,
    bundleRoot: staged.bundleRoot,
    manifest: result.plugin.manifest,
    cleanup: staged.cleanup,
  };
}

function platformSelectionError(options: {
  pluginName: string;
  selection: PluginTestPlatformSelection;
  manifest: PluginManifestSource;
}): Error {
  const supportedPlatforms = resolveSupportedPlatforms(options.manifest);
  return new Error(
    `Cannot run plugin tests for "${options.pluginName}" with --platform=${options.selection}: staging manifest ${formatMarketplaceProductsForError(options.manifest)} resolves to supported platforms=${formatSupportedPlatforms(supportedPlatforms)}.`,
  );
}

function resolveSelectedPlatforms(
  manifest: PluginManifestSource,
  selection: PluginTestPlatformSelection,
  pluginName: string,
): PlatformName[] {
  const supportedPlatforms = resolveSupportedPlatforms(manifest);
  if (selection === 'auto') {
    return TEST_PLATFORM_ORDER.filter((platform) => supportedPlatforms.has(platform));
  }

  if (selection === 'both') {
    if (!supportedPlatforms.has('codex') || !supportedPlatforms.has('claude')) {
      throw platformSelectionError({ pluginName, selection, manifest });
    }
    return ['codex', 'claude'];
  }

  if (!supportedPlatforms.has(selection)) {
    throw platformSelectionError({ pluginName, selection, manifest });
  }
  return [selection];
}

function resolveRelativeImport(importer: string, specifier: string): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (base.startsWith('../') || path.posix.isAbsolute(base)) {
    throw new Error(`Test import "${specifier}" from "${importer}" escapes the plugin root.`);
  }
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.posix.join(base, 'index.js'),
    path.posix.join(base, 'index.mjs'),
    path.posix.join(base, 'index.cjs'),
  ];
  return candidates[0] ?? null;
}

async function copyTestFileWithDependencies(options: {
  baselineRoot: string;
  bundleRoot: string;
  relativePath: string;
  isEntry: boolean;
  copied: Set<string>;
}): Promise<void> {
  const relativePath = normalizeRelativePath(options.relativePath);
  const sourcePath = path.join(options.baselineRoot, relativePath);
  const targetPath = path.join(options.bundleRoot, relativePath);
  if (options.isEntry && await fs.pathExists(targetPath)) {
    throw new Error(`Test entry "${relativePath}" conflicts with a runtime bundle file.`);
  }
  if (!options.isEntry && await fs.pathExists(targetPath)) {
    return;
  }
  if (options.copied.has(relativePath)) {
    return;
  }
  if (!(await fs.pathExists(sourcePath))) {
    throw new Error(`Missing test file "${relativePath}".`);
  }

  options.copied.add(relativePath);
  await fs.ensureDir(path.dirname(targetPath));
  await fs.copyFile(sourcePath, targetPath);

  if (!NODE_RUNTIME_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase())) {
    return;
  }
  const source = await fs.readFile(sourcePath, 'utf8');
  for (const reference of scanJavaScriptImportSpecifiers(source)) {
    const specifier = reference.specifier;
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      continue;
    }
    const resolved = resolveRelativeImport(relativePath, specifier);
    if (!resolved) {
      continue;
    }
    const candidates = [
      resolved,
      `${resolved}.js`,
      `${resolved}.mjs`,
      `${resolved}.cjs`,
      path.posix.join(resolved, 'index.js'),
      path.posix.join(resolved, 'index.mjs'),
      path.posix.join(resolved, 'index.cjs'),
    ];
    const existing = candidates.find((candidate) => fs.pathExistsSync(path.join(options.baselineRoot, candidate)));
    if (!existing) {
      if (candidates.some((candidate) => fs.pathExistsSync(path.join(options.bundleRoot, candidate)))) {
        continue;
      }
      throw new Error(`Unable to resolve test import "${specifier}" from "${relativePath}".`);
    }
    await copyTestFileWithDependencies({
      ...options,
      relativePath: existing,
      isEntry: false,
    });
  }
}

async function copyTestsIntoBundle(options: {
  baselineRoot: string;
  bundleRoot: string;
  entries: string[];
}): Promise<string[]> {
  const copied = new Set<string>();
  for (const entry of options.entries) {
    await copyTestFileWithDependencies({
      baselineRoot: options.baselineRoot,
      bundleRoot: options.bundleRoot,
      relativePath: entry,
      isEntry: true,
      copied,
    });
  }
  return options.entries.map((entry) => normalizeRelativePath(entry));
}

async function readPackageDependencyNames(
  bundleRoot: string,
  manifest: PluginManifestSource,
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
  manifest: PluginManifestSource;
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

async function assertTestImportContract(
  bundleRoot: string,
  manifest: PluginManifestSource,
  testEntries: string[],
): Promise<void> {
  const files = await listFiles(bundleRoot);
  const jsFiles: Record<string, string> = {};
  await Promise.all(files
    .filter((file) => NODE_RUNTIME_EXTENSIONS.has(path.posix.extname(file).toLowerCase()))
    .map(async (file) => {
      jsFiles[file] = await fs.readFile(path.join(bundleRoot, file), 'utf8');
    }));
  const { dependencies, devDependencies } = await readPackageDependencyNames(bundleRoot, manifest);
  const scan = scanNodeImportContract({
    files: jsFiles,
    entryFiles: testEntries,
    dependencies,
    devDependencies,
    allowDevDependencies: Boolean(manifest.scripts?.node?.packageRoot),
  });
  if (scan.errors.length > 0) {
    throw new Error(`Invalid plugin test imports:\n${scan.errors.join('\n')}`);
  }
}

async function resolveConfigDefaults(options: {
  manifest: PluginManifestSource;
  cwd: string;
}): Promise<Record<string, string | number | boolean>> {
  const values: Record<string, string | number | boolean> = {};
  const schema = options.manifest.config?.schema ?? {};
  for (const [key, field] of Object.entries(schema)) {
    const typedField = field as PluginConfigSchemaField;
    if (typedField.default === undefined) {
      continue;
    }
    values[key] = await coercePluginConfigValue({
      key,
      field: typedField,
      value: typedField.default,
      projectRoot: options.cwd,
    });
  }
  return values;
}

async function writeTestContext(options: {
  bundleRoot: string;
  sourceRoot: string;
  manifest: PluginManifestSource;
  platform: PlatformName;
  scope: Scope;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  tempDir: string;
}): Promise<{ contextPath: string; sensitiveValues: string[] }> {
  const effective = options.manifest.config?.schema
    ? await resolveEffectivePluginConfig({
        manifest: options.manifest,
        cwd: options.projectRoot,
        env: options.env,
      }).catch(async () => ({
        values: await resolveConfigDefaults({
          manifest: options.manifest,
          cwd: options.projectRoot,
        }),
        sources: Object.fromEntries(Object.keys(options.manifest.config?.schema ?? {}).map((key) => [key, 'default'])),
        schema: options.manifest.config?.schema,
        issues: [],
      }))
    : { values: {}, sources: {}, schema: undefined, issues: [] };
  const contextPath = path.join(options.tempDir, 'context.json');
  await fs.writeJson(contextPath, {
    version: 1,
    event: 'test',
    plugin: {
      name: options.manifest.name,
      version: options.manifest.version,
      rootDir: options.bundleRoot,
    },
    sourceRoot: options.sourceRoot,
    platform: options.platform,
    scope: options.scope,
    cwd: options.projectRoot,
    paths: {
      awHome: resolveAwHome(options.env),
      configStores: {
        user: resolvePluginConfigStorePath({
          pluginName: options.manifest.name,
          scope: 'user',
          cwd: options.projectRoot,
          env: options.env,
        }),
        project: resolvePluginConfigStorePath({
          pluginName: options.manifest.name,
          scope: 'project',
          cwd: options.projectRoot,
          env: options.env,
        }),
      },
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
    });
    await assertTestImportContract(bundleRoot, options.prepared.manifest, copiedEntries);

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

async function runOnePlugin(options: {
  plugin: PluginMeta;
  parsed: ParsedArgs;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}): Promise<number> {
  const staged = await stagePluginTestBundleSource(options.plugin);
  try {
    const platforms = resolveSelectedPlatforms(
      staged.manifest,
      options.parsed.platform,
      staged.pluginName,
    );
    const prepared = await buildPreparedPluginTestBundle(staged);
    let exitCode = 0;
    for (const platform of platforms) {
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
    await staged.cleanup();
  }
}

export async function runPluginScriptTests(
  args: string[],
  options: PluginTestRunnerOptions = {},
): Promise<number> {
  const parsed = parseArgs(args);
  const env = options.env ?? process.env;
  const configuredRepoRoot = options.repoRoot ?? env[REPO_ROOT_ENV];
  const repoRoot = configuredRepoRoot ? path.resolve(configuredRepoRoot) : resolveRepoRoot();
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));

  if (parsed.all) {
    const plugins = await discoverPlugins(repoRoot);
    let exitCode = 0;
    for (const plugin of plugins) {
      try {
        const pluginExitCode = await runOnePlugin({ plugin, parsed, env, stdout, stderr });
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
    const plugin = await findSourcePlugin(repoRoot, parsed.pluginName!);
    return await runOnePlugin({ plugin, parsed, env, stdout, stderr });
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
