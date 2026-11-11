import os from 'node:os';
import path from 'node:path';
import type { ExecFileOptions } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { afterAll, afterEach, beforeEach, describe, expect, it, type TestContext } from 'vitest';

import { getCurrentSourceTestIsolation, registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';
import { installCurrentSmokeDistIsolationBridge } from '../setup/test-isolation-smoke.js';
import { createTestPnpmInvocation } from '../helpers/pnpm.js';
import { TestCommandDiagnostics, sanitizeTestDiagnostic } from '../helpers/test-command-diagnostics.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import {
  createAwPluginRequirementsReceipt,
  readPluginManifest,
} from '../../src/utils/manifest.js';

let commands: TestCommandDiagnostics;
let npmLogSource: { directory: string; cache: string } | undefined;
let cleanupUnconfirmed = false;

beforeEach(({ task, signal }) => {
  commands = new TestCommandDiagnostics('npm', task.name, signal);
  npmLogSource = undefined;
  if (cleanupUnconfirmed) throw new Error('A previous pack smoke process could not be cleaned up; its temporary state cannot be reused.');
});

afterEach(async () => {
  try {
    await commands.finish();
    if (npmLogSource) await commands.npmLogs(npmLogSource.directory, npmLogSource.cache);
  } catch (error) {
    cleanupUnconfirmed = true;
    packedCliPromise = null;
    // Restore env/cwd as usual, but keep this case's HOME/TMP while a process may still use them.
    getCurrentSourceTestIsolation().cleanup = async () => {
      process.stderr.write('[pack-smoke] Retained this case\'s isolated HOME/TMP because process cleanup is unconfirmed.\n');
    };
    throw error;
  }
});

function smokeCase(body: () => Promise<void>) {
  return (_context: TestContext): Promise<void> => commands.run(body);
}

type CapturedExecFileOptions = ExecFileOptions & {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

async function execFileAsync(command: string, args: string[], options: CapturedExecFileOptions = {}) {
  return commands.command(command, args, {
    cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
    env: options.env,
    timeoutMs: options.timeout,
    maxBuffer: options.maxBuffer,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
  });
}

function readCommandResult(stdout: string, command: string | null) {
  const result = JSON.parse(stdout);
  expect(result).toMatchObject({
    schemaVersion: 1, command, data: expect.any(Object),
    diagnostics: expect.any(Array), nextActions: expect.any(Array),
  });
  expect(result).not.toHaveProperty('ok');
  expect(result).not.toHaveProperty('receiptSchemaVersion');
  return result;
}

const sharedTempBase = os.tmpdir();
const tempDirs: string[] = [];
let packedCliPromise: Promise<{
  packageRoot: string;
  cliTarballPath: string;
  evalTarballPath: string;
  coreTarballPath: string;
  windowsJobTarballPath?: string;
  tempRoot: string;
}> | null = null;

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

function registerSmokeWritableRoot(rootPath: string, source: string): string {
  return registerCurrentTestWritableStateRoot(rootPath, source);
}

async function createSmokeTempRoot(prefix: string, source: string): Promise<string> {
  const rootPath = await fs.mkdtemp(path.join(sharedTempBase, prefix));
  tempDirs.push(rootPath);
  return registerSmokeWritableRoot(rootPath, source);
}

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFilesRecursively(entryPath);
      files.push(...nested.map((file) => path.join(entry.name, file).split(path.sep).join('/')));
      continue;
    }
    files.push(entry.name);
  }
  return files.sort();
}

async function unpackTarball(tarballPath: string, unpackDir: string): Promise<string> {
  await execFileAsync(
    'tar',
    ['-xzf', path.basename(tarballPath), '-C', unpackDir.split(path.sep).join('/')],
    {
      cwd: path.dirname(tarballPath),
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  return path.join(unpackDir, 'package');
}

async function listTarballEntries(tarballPath: string): Promise<string> {
  const { stdout } = await execFileAsync('tar', ['-tzf', path.basename(tarballPath)], {
    cwd: path.dirname(tarballPath),
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

async function resolveNpmCli(env: NodeJS.ProcessEnv): Promise<string> {
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const npmExecPath = env.npm_execpath;
  if (npmExecPath && path.basename(npmExecPath) === 'npm-cli.js') candidates.push(npmExecPath);
  const inheritedPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  for (const directory of inheritedPath.split(path.delimiter)) {
    candidates.push(path.join(directory, 'npm'), path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  for (const candidate of candidates) {
    try {
      const resolved = await fs.realpath(candidate);
      if (path.basename(resolved) === 'npm-cli.js') return resolved;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw new Error('The Node installation must provide npm-cli.js.');
}

function npmCmdShim(target: string): string {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ' +
      `"%_prog%"  "%dp0%\\${target}" %*`,
    '',
  ].join('\r\n');
}

async function listBuildSnapshotEntries(root: string): Promise<string[]> {
  return (await fs.readdir(path.join(root, '.release', 'build-snapshots')).catch(() => []))
    .filter((entry) => entry.startsWith('build-'))
    .sort();
}

async function installDeclaredDependencyOnlyView(
  unpackedPackageRoot: string,
  workspacePackageRoot: string,
): Promise<void> {
  const packageJson = await fs.readJson(
    path.join(unpackedPackageRoot, 'package.json'),
  ) as { dependencies?: Record<string, string> };
  const nodeModulesRoot = path.join(unpackedPackageRoot, 'node_modules');
  await fs.remove(nodeModulesRoot);
  await fs.ensureDir(nodeModulesRoot);

  for (const dependencyName of Object.keys(packageJson.dependencies ?? {}).sort()) {
    const sourceDependency = path.join(
      workspacePackageRoot,
      'node_modules',
      ...dependencyName.split('/'),
    );
    const targetDependency = path.join(nodeModulesRoot, ...dependencyName.split('/'));
    await expect(fs.pathExists(sourceDependency)).resolves.toBe(true);
    await fs.ensureDir(path.dirname(targetDependency));
    await fs.symlink(
      sourceDependency,
      targetDependency,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
}

async function preparePackedCli(): Promise<{
  packageRoot: string;
  cliTarballPath: string;
  evalTarballPath: string;
  coreTarballPath: string;
  windowsJobTarballPath?: string;
  tempRoot: string;
}> {
  if (packedCliPromise) {
    const packed = await packedCliPromise;
    registerSmokeWritableRoot(packed.tempRoot, 'shared pack smoke temp root');
    return packed;
  }

  packedCliPromise = (async () => {
    const root = repoRoot();
    const tempRoot = await createSmokeTempRoot('aw-pack-smoke-', 'pack smoke temp root');
    const packDir = path.join(tempRoot, 'pack');
    const unpackDir = path.join(tempRoot, 'unpack');
    registerSmokeWritableRoot(packDir, 'pack smoke tarball staging root');
    registerSmokeWritableRoot(unpackDir, 'pack smoke tarball unpack root');
    await fs.ensureDir(packDir);
    await fs.ensureDir(unpackDir);

    const packageRoot = path.join(root, 'packages', 'cli');
    const staleDistPath = path.join(packageRoot, 'dist', 'stale-build-sentinel.js');
    await fs.outputFile(staleDistPath, 'export const stale = true;\n', 'utf8');
    const snapshotEntriesBefore = await listBuildSnapshotEntries(root);
    await execFileAsync(
      process.execPath, ['--input-type=module', '--eval',
        'const { withReleaseBuildSnapshot, packEval, packCore, packCli } = await import(process.argv[1]); ' +
        'await withReleaseBuildSnapshot(async (snapshot) => { for (const pack of [packEval, packCore, packCli]) await pack({ snapshot, destination: process.argv[2] }); });',
        pathToFileURL(path.join(root, 'scripts/release/common.mjs')).href, packDir],
      {
        cwd: root,
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    await expect(fs.pathExists(staleDistPath)).resolves.toBe(false);
    const snapshotEntriesAfter = await listBuildSnapshotEntries(root);
    expect(snapshotEntriesAfter).toEqual(snapshotEntriesBefore);

    const tarballs = (await fs.readdir(packDir))
      .filter((entry) => entry.endsWith('.tgz'))
      .sort();
    expect(tarballs).toHaveLength(3);
    const cliTarballName = tarballs.find((entry) =>
      /-aw-\d/u.test(entry));
    const evalTarballName = tarballs.find((entry) => entry.includes('-agent-skill-eval-'));
    const coreTarballName = tarballs.find((entry) => entry.includes('-aw-plugin-core-'));
    expect(cliTarballName).toBeDefined();
    expect(evalTarballName).toBeDefined();
    expect(coreTarballName).toBeDefined();
    const cliTarballPath = path.join(packDir, cliTarballName!);
    const evalTarballPath = path.join(packDir, evalTarballName!);
    const coreTarballPath = path.join(packDir, coreTarballName!);

    let windowsJobTarballPath: string | undefined;
    if (process.platform === 'win32') {
      const { readNativeTool } = await import('../../../../packages/native-runtime/src/reader.mjs');
      const helper = readNativeTool('windows-job', 'aw.windows-job.v1', process.env);
      if (helper.state !== 'ready') throw new Error('Windows pack smoke requires its explicit source candidate helper.');
      const nativeSource = path.join(tempRoot, 'native-package');
      const nativePackage = path.join(nativeSource, 'package');
      await fs.ensureDir(path.join(nativePackage, 'dist'));
      const template = await fs.readJson(path.join(root, 'packages', `aw-windows-job-win32-${process.arch}`, 'package.json'));
      const version = (await fs.readJson(path.join(root, 'packages/cli/package.json'))).version;
      await fs.writeJson(path.join(nativePackage, 'package.json'), { ...template, version });
      await fs.copyFile(helper.executable, path.join(nativePackage, 'dist/aw-windows-job.exe'));
      windowsJobTarballPath = path.join(tempRoot, 'windows-platform.tgz');
      await execFileAsync('tar', [
        '-czf', path.basename(windowsJobTarballPath), '-C', path.basename(nativeSource), 'package',
      ], { cwd: tempRoot });
    }

    return {
      packageRoot: await unpackTarball(cliTarballPath, unpackDir),
      cliTarballPath,
      evalTarballPath,
      coreTarballPath,
      windowsJobTarballPath,
      tempRoot,
    };
  })();
  try {
    return await packedCliPromise;
  } catch (error) {
    packedCliPromise = null;
    throw error;
  }
}

async function createExternalNativeCliFixture(tempRoot: string): Promise<string> {
  const nativeBin = path.join(tempRoot, 'external-native-bin');
  await fs.ensureDir(nativeBin);

  const claudeScript = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "if (process.env.AW_PACK_NATIVE_CALL_LOG) fs.appendFileSync(process.env.AW_PACK_NATIVE_CALL_LOG, JSON.stringify({ platform: 'claude', args, cwd: process.cwd() }) + '\\n');",
    "const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };",
    "const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\\n'); };",
    "const home = process.env.CLAUDE_CONFIG_DIR;",
    "if (args[0] === '--version') { console.log('2.1.292 (Claude Code)'); process.exit(0); }",
    "if (!home) { console.error('CLAUDE_CONFIG_DIR is required'); process.exit(2); }",
    "const scope = args.includes('--scope') ? args[args.indexOf('--scope') + 1] : 'user';",
    // Native realpath removes Windows namespace prefixes from the child cwd.
    "const projectPath = fs.realpathSync.native(process.cwd());",
    "const settingsPath = scope === 'project' ? path.join(projectPath, '.claude', 'settings.json') : path.join(home, 'settings.json');",
    "const knownPath = path.join(home, 'plugins', 'known_marketplaces.json');",
    "const installedPath = path.join(home, 'plugins', 'installed_plugins.json');",
    "if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {",
    "  const marketplaceRoot = args[3];",
    "  const marketplace = readJson(path.join(marketplaceRoot, 'config.json'), {});",
    "  const marketplaceName = marketplace.marketplaceName;",
    "  if (typeof marketplaceName !== 'string') { console.error('marketplace name missing'); process.exit(2); }",
    "  const settings = readJson(settingsPath, {});",
    "  settings.extraKnownMarketplaces = { ...(settings.extraKnownMarketplaces || {}), [marketplaceName]: { source: { source: 'directory', path: marketplaceRoot } } };",
    "  writeJson(settingsPath, settings);",
    "  const known = readJson(knownPath, {});",
    "  known[marketplaceName] = { source: { source: 'directory', path: marketplaceRoot }, installLocation: marketplaceRoot };",
    "  writeJson(knownPath, known);",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'plugin' && args[1] === 'install') {",
    "  const pluginId = args[2];",
    "  const at = pluginId.lastIndexOf('@');",
    "  const pluginName = pluginId.slice(0, at);",
    "  const marketplaceName = pluginId.slice(at + 1);",
    "  const known = readJson(knownPath, {});",
    "  const marketplaceRoot = known[marketplaceName] && known[marketplaceName].source && known[marketplaceName].source.path;",
    "  const manifest = readJson(path.join(marketplaceRoot, 'plugins', pluginName, '.agents-plugin', 'plugin.json'), {});",
    "  const settings = readJson(settingsPath, {});",
    "  settings.enabledPlugins = { ...(settings.enabledPlugins || {}), [pluginId]: true };",
    "  writeJson(settingsPath, settings);",
    "  const installed = readJson(installedPath, { plugins: {} });",
    "  installed.plugins = { ...(installed.plugins || {}), [pluginId]: [{ name: pluginName, marketplace: marketplaceName, scope, ...(scope === 'project' ? { projectPath } : {}), version: manifest.version }] };",
    "  writeJson(installedPath, installed);",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'plugin' && args[1] === 'list') { console.log('[]'); process.exit(0); }",
    "console.error(`Unsupported fake claude command: ${args.join(' ')}`);",
    'process.exit(2);',
  ].join('\n');
  const codexScript = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "if (process.env.AW_PACK_NATIVE_CALL_LOG) fs.appendFileSync(process.env.AW_PACK_NATIVE_CALL_LOG, JSON.stringify({ platform: 'codex', args, cwd: process.cwd() }) + '\\n');",
    "if (args[0] === '--version') { console.log('codex-cli 0.167.0'); process.exit(0); }",
    "if (args[0] === 'plugin' && args[1] === '--help') { console.log('plugin help'); process.exit(0); }",
    "const home = process.env.CODEX_HOME;",
    "if (!home) { console.error('CODEX_HOME is required'); process.exit(2); }",
    "const configPath = path.join(home, 'config.toml');",
    "const statePath = path.join(home, 'fake-plugin-state.json');",
    "const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };",
    "const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\\n'); };",
    "const writeTable = (file, header, body) => {",
    "  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';",
    "  const lines = content.trimEnd() ? content.trimEnd().split(/\\r?\\n/u) : [];",
    "  const start = lines.indexOf(header);",
    "  if (start >= 0) {",
    "    let end = start + 1;",
    "    while (end < lines.length && !lines[end].startsWith('[')) end += 1;",
    "    lines.splice(start, end - start, header, ...body);",
    "  } else {",
    "    if (lines.length > 0) lines.push('');",
    "    lines.push(header, ...body);",
    "  }",
    "  fs.mkdirSync(path.dirname(file), { recursive: true });",
    "  fs.writeFileSync(file, lines.join('\\n') + '\\n');",
    "};",
    "const tableEnabled = (file, pluginId) => {",
    "  if (!fs.existsSync(file)) return false;",
    "  const lines = fs.readFileSync(file, 'utf8').split(/\\r?\\n/u);",
    "  const start = lines.indexOf(`[plugins.${JSON.stringify(pluginId)}]`);",
    "  if (start < 0) return false;",
    "  for (let index = start + 1; index < lines.length && !lines[index].startsWith('['); index += 1) {",
    "    if (/^enabled\\s*=\\s*true\\s*$/u.test(lines[index])) return true;",
    "    if (/^enabled\\s*=\\s*false\\s*$/u.test(lines[index])) return false;",
    "  }",
    "  return false;",
    "};",
    "const projectTrusted = (file, cwd) => {",
    "  if (!fs.existsSync(file)) return false;",
    "  const lines = fs.readFileSync(file, 'utf8').split(/\\r?\\n/u);",
    "  const header = `[projects.${JSON.stringify(fs.realpathSync.native(cwd))}]`;",
    "  const start = lines.indexOf(header);",
    "  if (start < 0) return false;",
    "  for (let index = start + 1; index < lines.length && !lines[index].startsWith('['); index += 1) {",
    "    if (/^trust_level\\s*=\\s*\"trusted\"\\s*$/u.test(lines[index])) return true;",
    "  }",
    "  return false;",
    "};",
    "if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {",
    "  const marketplaceRoot = args[3];",
    "  const metadata = readJson(path.join(marketplaceRoot, 'config.json'), {});",
    "  const marketplaceName = metadata.marketplaceName;",
    "  if (typeof marketplaceName !== 'string') { console.error('marketplace name missing'); process.exit(2); }",
    "  const state = readJson(statePath, { marketplaces: {}, plugins: {} });",
    "  state.marketplaces[marketplaceName] = marketplaceRoot;",
    "  writeJson(statePath, state);",
    "  writeTable(configPath, `[marketplaces.${JSON.stringify(marketplaceName)}]`, [",
    "    'source_type = \\\"local\\\"',",
    "    `source = ${JSON.stringify(marketplaceRoot)}` ,",
    "  ]);",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'list') {",
    "  console.log(JSON.stringify(readJson(statePath, { marketplaces: {} }).marketplaces));",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'plugin' && args[1] === 'add') {",
    "  const pluginId = args[2];",
    "  const at = pluginId.lastIndexOf('@');",
    "  const pluginName = pluginId.slice(0, at);",
    "  const marketplaceName = pluginId.slice(at + 1);",
    "  const state = readJson(statePath, { marketplaces: {}, plugins: {} });",
    "  const marketplaceRoot = state.marketplaces[marketplaceName];",
    "  const sourceRoot = path.join(marketplaceRoot, 'plugins', pluginName);",
    "  const manifest = readJson(path.join(sourceRoot, '.codex-plugin', 'plugin.json'), {});",
    "  const cacheRoot = path.join(home, 'plugins', 'cache', marketplaceName, pluginName, manifest.version);",
    "  fs.rmSync(cacheRoot, { recursive: true, force: true });",
    "  fs.mkdirSync(path.dirname(cacheRoot), { recursive: true });",
    "  fs.cpSync(sourceRoot, cacheRoot, { recursive: true });",
    "  state.plugins[pluginId] = { pluginName, marketplaceName, version: manifest.version, path: sourceRoot };",
    "  writeJson(statePath, state);",
    "  writeTable(configPath, `[plugins.${JSON.stringify(pluginId)}]`, ['enabled = true']);",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'plugin' && args[1] === 'list') {",
    "  if (!args.includes('--json')) { console.log('[]'); process.exit(0); }",
    "  const state = readJson(statePath, { marketplaces: {}, plugins: {} });",
    "  const projectConfig = path.join(process.cwd(), '.codex', 'config.toml');",
    "  const installed = Object.entries(state.plugins).map(([pluginId, plugin]) => ({",
    "    pluginId, installed: true,",
    "    enabled: tableEnabled(configPath, pluginId)",
    "      || (tableEnabled(projectConfig, pluginId) && projectTrusted(configPath, process.cwd())),",
    "    version: plugin.version, source: { source: 'local', path: plugin.path },",
    "  }));",
    "  console.log(JSON.stringify({ installed, available: [] }));",
    "  process.exit(0);",
    "}",
    "console.error(`Unsupported fake codex command: ${args.join(' ')}`);",
    'process.exit(2);',
  ].join('\n');

  if (process.platform === 'win32') {
    const codexPackageRoot = path.join(nativeBin, 'node_modules', '@openai', 'codex');
    const codexLauncher = path.join(codexPackageRoot, 'bin', 'codex.js');
    const claudePackageRoot = path.join(nativeBin, 'node_modules', '@anthropic-ai', 'claude-code');
    const claudeLauncher = path.join(claudePackageRoot, 'cli.js');
    await Promise.all([fs.ensureDir(path.dirname(codexLauncher)), fs.ensureDir(claudePackageRoot)]);
    await Promise.all([
      fs.writeFile(claudeLauncher, `${claudeScript}\n`, 'utf8'),
      fs.writeJson(path.join(claudePackageRoot, 'package.json'), {
        name: '@anthropic-ai/claude-code',
        version: '2.1.292',
        bin: { claude: 'cli.js' },
      }),
      fs.writeFile(
        path.join(nativeBin, 'claude.cmd'),
        npmCmdShim('node_modules\\@anthropic-ai\\claude-code\\cli.js'),
        'utf8',
      ),
      fs.writeFile(
        path.join(nativeBin, 'codex.cmd'),
        npmCmdShim('node_modules\\@openai\\codex\\bin\\codex.js'),
        'utf8',
      ),
      fs.writeJson(path.join(codexPackageRoot, 'package.json'), {
        name: '@openai/codex',
        version: '0.167.0',
        bin: { codex: 'bin/codex.js' },
      }),
      fs.writeFile(codexLauncher, `${codexScript}\n`, 'utf8'),
    ]);
    return nativeBin;
  }

  const claudePath = path.join(nativeBin, 'claude');
  const codexPath = path.join(nativeBin, 'codex');
  await Promise.all([
    fs.writeFile(claudePath, `#!/usr/bin/env node\n${claudeScript}\n`, 'utf8'),
    fs.writeFile(codexPath, `#!/usr/bin/env node\n${codexScript}\n`, 'utf8'),
  ]);
  await Promise.all([fs.chmod(claudePath, 0o755), fs.chmod(codexPath, 0o755)]);
  return nativeBin;
}

afterAll(async () => {
  if (cleanupUnconfirmed) throw new Error('Pack smoke process cleanup is unconfirmed; temporary state was retained.');
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('pack smoke', () => {
  it('packs three universal CLI products with exact native optional dependencies and no PE files', smokeCase(async () => {
    const bundle = await preparePackedCli();
    for (const [name, tarball] of [
      ['eval', bundle.evalTarballPath], ['core', bundle.coreTarballPath], ['cli', bundle.cliTarballPath],
    ]) {
      const unpack = await createSmokeTempRoot(`aw-${name}-pack-`, 'text-only product unpack root');
      const packageRoot = await unpackTarball(tarball, unpack);
      const files = await listFilesRecursively(packageRoot);
      expect(files.some((file) => file.endsWith('.exe'))).toBe(false);
      for (const file of files) {
        const bytes = await fs.readFile(path.join(packageRoot, file));
        expect(bytes.subarray(0, 2).toString('ascii')).not.toBe('MZ');
      }
      const metadata = await fs.readJson(path.join(packageRoot, 'package.json'));
      expect(metadata.dependencies?.['@lesliechan721/aw-native-runtime']).toBeUndefined();
      if (name === 'eval') {
        expect(metadata.optionalDependencies).toEqual({
          '@lesliechan721/aw-windows-job-win32-x64': metadata.version,
          '@lesliechan721/aw-windows-job-win32-arm64': metadata.version,
        });
      } else expect(metadata.optionalDependencies).toBeUndefined();
      expect(files.some((file) => file.endsWith('windows-job.lock.json'))).toBe(false);
    }
  }), 300_000);

  // A cold Windows npm install can use four minutes before authoring starts.
  it('runs external authoring workflow from installed tarballs', smokeCase(async () => {
    const startedAt = Date.now();
    const markStage = (stage: string): void => {
      process.stderr.write(`[pack-smoke] ${stage} (${Date.now() - startedAt}ms)\n`);
    };
    markStage('prepare tarballs start');
    const {
      packageRoot, cliTarballPath, evalTarballPath, coreTarballPath, windowsJobTarballPath, tempRoot,
    } = await preparePackedCli();
    markStage('prepare tarballs end');
    const installPrefix = path.join(tempRoot, 'install-prefix');
    registerSmokeWritableRoot(installPrefix, 'pack smoke clean npm install prefix');
    await fs.ensureDir(installPrefix);
    const envWithoutNodePath = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'node_path'),
    );
    const npmCli = await resolveNpmCli(envWithoutNodePath);

    const npmLogsDir = path.join(tempRoot, 'npm-logs');
    await fs.ensureDir(npmLogsDir);
    npmLogSource = { directory: npmLogsDir, cache: '' };
    const npmDiagnosticsArgs = ['--timing', '--logs-dir', npmLogsDir, '--loglevel=http'];
    const { stdout: npmCache } = await execFileAsync(
      process.execPath, [npmCli, 'config', 'get', 'cache', ...npmDiagnosticsArgs],
      { cwd: tempRoot, env: envWithoutNodePath },
    );
    npmLogSource.cache = npmCache.trim();
    markStage('npm install tarballs start');
    try {
      await execFileAsync(
        process.execPath,
        [
          npmCli,
          'install',
          ...npmDiagnosticsArgs,
          '--global',
          ...(process.platform === 'win32' ? [] : ['--omit=optional']),
          '--ignore-scripts',
          '--prefix',
          installPrefix,
          ...(windowsJobTarballPath ? [windowsJobTarballPath] : []),
          evalTarballPath,
          coreTarballPath,
          cliTarballPath,
        ],
        {
          cwd: tempRoot,
          env: envWithoutNodePath,
          maxBuffer: 20 * 1024 * 1024,
        },
      );
    } finally {
      // Collect only numeric timers and cache counters before any temporary state is removed.
      await commands.npmLogs(npmLogsDir, npmCache.trim());
    }
    markStage('npm install tarballs end');

    const externalNativeBin = await createExternalNativeCliFixture(tempRoot);
    const inheritedPath = Object.entries(envWithoutNodePath)
      .find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
    const externalNodeBin = path.join(tempRoot, 'external-node-bin');
    await fs.ensureDir(externalNodeBin);
    if (process.platform === 'win32') {
      await fs.copyFile(process.execPath, path.join(externalNodeBin, 'node.exe'));
    } else {
      await fs.symlink(process.execPath, path.join(externalNodeBin, 'node'));
    }
    let gitExecutable: string | undefined;
    for (const directory of inheritedPath.split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(directory, process.platform === 'win32' ? 'git.exe' : 'git');
      if (await fs.pathExists(candidate)) {
        gitExecutable = await fs.realpath(candidate);
        break;
      }
    }
    if (!gitExecutable) throw new Error('The pack smoke requires an installed Git executable.');
    const childToolPath = [externalNativeBin, externalNodeBin];
    const systemRoot = Object.entries(envWithoutNodePath)
      .find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
    // Git source sync also extracts archives with system tar.
    const systemToolDirectories = process.platform === 'win32'
      ? [path.dirname(gitExecutable), ...(systemRoot ? [path.join(systemRoot, 'System32')] : [])]
      : [path.dirname(gitExecutable), '/usr/bin', '/bin'];
    if (process.platform === 'win32') {
      // Git needs sh.exe for local transports; the Git executable directory alone is insufficient.
      const { stdout: gitShellPath } = await execFileAsync(gitExecutable, ['var', 'GIT_SHELL_PATH'], {
        env: envWithoutNodePath,
      });
      systemToolDirectories.push(path.dirname(await fs.realpath(gitShellPath.trim())));
    }
    for (const directory of new Set(systemToolDirectories)) {
      const entries = await fs.readdir(directory);
      expect(entries.some((entry) => /^codex(?:\.(?:exe|com|cmd|bat))?$/iu.test(entry))).toBe(false);
      childToolPath.push(directory);
    }
    const externalAuthoringEnv = {
      ...Object.fromEntries(Object.entries(envWithoutNodePath).filter(([key]) => key.toLowerCase() !== 'path')),
      AW_HOME: path.join(tempRoot, 'external-aw-home'),
      CODEX_HOME: path.join(tempRoot, 'external-codex-home'),
      CLAUDE_CONFIG_DIR: path.join(tempRoot, 'external-claude-home'),
      AW_PACK_NATIVE_CALL_LOG: path.join(tempRoot, 'external-native-calls.jsonl'),
      PATH: childToolPath.join(path.delimiter),
    };
    await Promise.all([
      fs.ensureDir(externalAuthoringEnv.AW_HOME),
      fs.ensureDir(externalAuthoringEnv.CODEX_HOME),
      fs.ensureDir(externalAuthoringEnv.CLAUDE_CONFIG_DIR),
    ]);
    expect(externalAuthoringEnv.NODE_PATH).toBeUndefined();

    const cliPackageJson = await fs.readJson(path.join(packageRoot, 'package.json')) as {
      version: string;
    };
    const binRoot = process.platform === 'win32' ? installPrefix : path.join(installPrefix, 'bin');
    const awBin = path.join(binRoot, process.platform === 'win32' ? 'aw.cmd' : 'aw');
    const evalBin = path.join(
      binRoot,
      process.platform === 'win32' ? 'aw-skill-eval.cmd' : 'aw-skill-eval',
    );
    const globalNodeModules = process.platform === 'win32'
      ? path.join(installPrefix, 'node_modules')
      : path.join(installPrefix, 'lib', 'node_modules');
    const installedCliRoot = path.join(globalNodeModules, '@lesliechan721', 'aw');
    const installedCliManifest = await fs.readJson(path.join(installedCliRoot, 'package.json')) as {
      bin: { aw: string };
    };
    const installedAwEntry = path.resolve(installedCliRoot, installedCliManifest.bin.aw);
    const discoveryPrelude = path.join(tempRoot, 'external-codex-discovery.mjs');
    const installedDiscoveryImport = pathToFileURL(path.join(
      installedCliRoot, 'dist', 'src', 'utils', 'codex-executable-discovery.js',
    )).href;
    // Fixture children keep the isolated homes without importing the CLI discovery graph.
    await fs.outputFile(discoveryPrelude, [
      "import path from 'node:path';",
      `const awEntries = ${JSON.stringify([path.resolve(awBin), installedAwEntry])};`,
      'if (process.argv[1] && awEntries.includes(path.resolve(process.argv[1]))) {',
      `  const { setCodexDiscoveryOverridesForTests } = await import(${JSON.stringify(installedDiscoveryImport)});`,
      '  setCodexDiscoveryOverridesForTests({',
      '    macApplicationsDirectories: [],',
      "    queryRunner: async () => ({ exitCode: 0, stdout: '[]', stderr: '' }),",
      '  });',
      '}',
    ].join('\n'));
    const discoveryPreludeImport = pathToFileURL(discoveryPrelude).href;
    await expect(fs.pathExists(awBin)).resolves.toBe(true);
    const execAw = async (args: string[], options: CapturedExecFileOptions): Promise<{ stdout: string; stderr: string }> => {
      const stage = `aw ${args.slice(0, 3).join(' ')}`;
      markStage(`${stage} start`);
      const commandEnv = options.env ?? process.env;
      const result = await execFileAsync(
        process.platform === 'win32' ? process.execPath : awBin,
        [...(process.platform === 'win32' ? [installedAwEntry] : []), ...args],
        { ...options, encoding: 'utf8', env: {
          ...Object.fromEntries(Object.entries(commandEnv).filter(([key]) => key.toLowerCase() !== 'path')),
          PATH: externalAuthoringEnv.PATH,
          NODE_OPTIONS: [commandEnv.NODE_OPTIONS, `--import=${discoveryPreludeImport}`].filter(Boolean).join(' '),
        } },
      );
      markStage(`${stage} end`);
      return result;
    };
    for (const packageName of [
      '@lesliechan721/aw',
      '@lesliechan721/aw-plugin-core',
      '@lesliechan721/agent-skill-eval',
    ]) {
      const packageStats = await fs.lstat(path.join(globalNodeModules, ...packageName.split('/')));
      expect(packageStats.isSymbolicLink()).toBe(false);
    }
    const installedRe2Wasm = path.join(
      globalNodeModules,
      '@lesliechan721',
      'aw-plugin-core',
      'node_modules',
      're2-wasm',
      'build',
      'wasm',
      're2.wasm',
    );
    await expect(fs.pathExists(installedRe2Wasm)).resolves.toBe(true);
    const installedCoreManifestImport = pathToFileURL(path.join(
      globalNodeModules,
      '@lesliechan721',
      'aw-plugin-core',
      'dist',
      'manifest.js',
    )).href;
    markStage('installed core config start');
    await expect(execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      [
        'const { normalizePluginConfigDefinition, validatePluginConfigValue } = await import(process.argv[1]);',
        "const config = normalizePluginConfigDefinition({ fields: { value: { type: 'string', validation: { pattern: '\\\\p{Han}+', maxLength: 20 } } } });",
        "if (validatePluginConfigValue(config.fields.value, 'prefix中文suffix', 'value').length !== 0) process.exit(1);",
      ].join('\n'),
      installedCoreManifestImport,
    ], {
      cwd: tempRoot,
      env: envWithoutNodePath,
      maxBuffer: 10 * 1024 * 1024,
    })).resolves.toMatchObject({ stdout: '' });
    markStage('installed core config end');
    const installedCodexManagerImport = pathToFileURL(path.join(
      globalNodeModules,
      '@lesliechan721',
      'aw',
      'dist',
      'src',
      'utils',
      'codex-manager.js',
    )).href;
    // Test Value Gate: installed production imports must discover a local CLI without repository modules or managed installation.
    const installedRuntimeHome = path.join(tempRoot, 'installed-manager-aw-home');
    const oldRuntimeRoot = path.join(installedRuntimeHome, 'runtimes', 'codex',
      '0.151.0', `${process.platform}-${process.arch}`);
    await fs.outputFile(path.join(oldRuntimeRoot, '.aw-managed-runtime.json'), '{old runtime residue\n');
    const oldLauncher = path.join(oldRuntimeRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    await fs.outputFile(oldLauncher, 'throw new Error("Old AW runtime must not run");\n');
    const oldRuntimeFiles = await listFilesRecursively(oldRuntimeRoot);
    const oldRuntimeMarker = await fs.readFile(path.join(oldRuntimeRoot, '.aw-managed-runtime.json'), 'utf8');
    markStage('installed local Codex resolver start');
    const installedManagerProbe = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "import path from 'node:path';",
          'const { resolveCodexManager } = await import(process.argv[1]);',
          'const awHome = process.argv[2];',
          'const fixtureBin = process.argv[3];',
          'const discovery = {',
          '  macApplicationsDirectories: [],',
          "  queryRunner: async () => ({ exitCode: 0, stdout: '[]', stderr: '' }),",
          '};',
          'const env = { ...process.env, AW_HOME: awHome,',
          '  PATH: [fixtureBin, process.argv[4]].join(path.delimiter) };',
          'const manager = await resolveCodexManager({ ...discovery, env });',
          'const missingCalls = [];',
          'let missingCode;',
          'try {',
          '  await resolveCodexManager({',
          '    ...discovery, env: { ...env, PATH: "" },',
          '    runner: async (invocation) => {',
          '      missingCalls.push({ command: invocation.command, args: invocation.args });',
          "      throw new Error('No CLI may be invoked without a local candidate.');",
          '    },',
          '  });',
          '} catch (error) {',
          "  if (error?.code !== 'codexCliNotFound') throw error;",
          '  missingCode = error.code;',
          '}',
          'console.log(JSON.stringify({ manager, missingCode, missingCalls }));',
        ].join('\n'),
        installedCodexManagerImport,
        installedRuntimeHome,
        externalNativeBin,
        externalNodeBin,
      ],
      {
        cwd: tempRoot,
        env: {
          ...externalAuthoringEnv,
          HOME: path.join(tempRoot, 'installed-manager-home'),
        },
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    markStage('installed local Codex resolver end');
    const installedManager = JSON.parse(installedManagerProbe.stdout) as {
      manager: { kind: string; version: string; command: string; argsPrefix: string[] };
      missingCode: string;
      missingCalls: unknown[];
    };
    expect(installedManager).toMatchObject({
      manager: { kind: 'system', version: '0.167.0' },
      missingCode: 'codexCliNotFound', missingCalls: [],
    });
    const localEntry = installedManager.manager.command === process.execPath
      ? installedManager.manager.argsPrefix[0]!
      : installedManager.manager.command;
    const relativeLocalEntry = path.relative(await fs.realpath(externalNativeBin), await fs.realpath(localEntry));
    expect(path.isAbsolute(relativeLocalEntry)).toBe(false);
    expect(relativeLocalEntry).not.toBe('..');
    expect(relativeLocalEntry.startsWith(`..${path.sep}`)).toBe(false);
    await expect(listFilesRecursively(oldRuntimeRoot)).resolves.toEqual(oldRuntimeFiles);
    await expect(fs.readFile(path.join(oldRuntimeRoot, '.aw-managed-runtime.json'), 'utf8'))
      .resolves.toBe(oldRuntimeMarker);
    await expect(fs.readFile(oldLauncher, 'utf8'))
      .resolves.toBe('throw new Error("Old AW runtime must not run");\n');

    const installedVersion = await execAw(['--version', '--json'], {
      cwd: tempRoot,
      env: externalAuthoringEnv,
    });
    expect(readCommandResult(installedVersion.stdout, 'version')).toMatchObject({
      status: 'success', data: { version: cliPackageJson.version },
    });
    await expect(execAw(['dev', 'plugin', '--help'], {
      cwd: tempRoot,
      env: externalAuthoringEnv,
    })).resolves.toMatchObject({
      stdout: expect.stringMatching(/(?=[\s\S]*status)(?=[\s\S]*test)(?=[\s\S]*build)/u),
      stderr: '',
    });
    await expect(execAw(['dev', 'catalog', '--help'], {
      cwd: tempRoot,
      env: externalAuthoringEnv,
    })).resolves.toMatchObject({
      stdout: expect.stringMatching(/create[\s\S]*version[\s\S]*build[\s\S]*validate[\s\S]*publish/u),
      stderr: '',
    });
    const capabilities = await execAw(['self', 'describe', '--json'], {
      cwd: tempRoot, env: externalAuthoringEnv,
    });
    expect(readCommandResult(capabilities.stdout, 'self.describe').data.capabilities).toContain('aw.plugin-recovery.v2');
    for (const recoveryCommand of [
      ['plugin', 'install', '--help'], ['plugin', 'status', '--help'], ['target', 'set', '--help'],
    ]) {
      await expect(execAw(recoveryCommand, {
        cwd: tempRoot, env: externalAuthoringEnv,
      })).resolves.toMatchObject({ stderr: '' });
    }

    const standaloneWorkspace = path.join(tempRoot, 'standalone-workspace');
    registerSmokeWritableRoot(standaloneWorkspace, 'packed CLI standalone author workspace');
    await fs.ensureDir(standaloneWorkspace);
    await expect(fs.pathExists(path.join(standaloneWorkspace, 'node_modules'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(standaloneWorkspace, 'packages', 'cli'))).resolves.toBe(false);
    await execAw([
      'dev', 'catalog', 'create', '--workspace-root', standaloneWorkspace,
      '--owner-url', 'https://catalog.example.com/packed-build',
    ], {
      cwd: standaloneWorkspace,
      env: externalAuthoringEnv,
    });
    await execAw([
      'dev', 'plugin', 'create', 'packed-build',
      '--description', 'Packed build fixture.',
      '--no-skills', '--with-mcp',
      '--workspace-root', standaloneWorkspace,
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    const packedPluginDirectory = path.join('plugins', 'packed-build');
    const packedPluginRoot = path.join(standaloneWorkspace, packedPluginDirectory);
    const packedManifestPath = path.join(packedPluginRoot, '.agents-plugin', 'plugin.json');
    const packedManifest = await fs.readJson(packedManifestPath);
    expect(await fs.readJson(path.join(packedPluginRoot, '.mcp.json'))).toEqual({ mcpServers: {} });
    packedManifest.skills = './skills';
    packedManifest.requires = { aw: { capabilities: ['aw.managed-commands.v1', 'aw.native-tools.v2'] } };
    packedManifest.managedCommands = {
      packages: [{ key: 'native-tool', scope: 'user', platforms: ['codex', 'claude'], sourceDir: './command' }],
      sets: [{ set: 'native-tools', producer: { kind: 'package', packageKey: 'native-tool' }, mode: 'static', entries: [{ key: 'run', runner: 'node', entry: 'entry.mjs' }] }],
    };
    packedManifest.nativeTools = {
      reader: './command/native-reader.mjs',
      definitions: [{ key: 'job', protocol: 'aw.windows-job.v1' }],
      consumers: [
        { kind: 'managed-command-set', key: 'native-tools', tools: [{ key: 'job', platforms: ['win32'], policy: 'required' }] },
        { kind: 'plugin-test', key: 'node', tools: [{ key: 'job', platforms: ['win32'], policy: 'required' }] },
      ],
    };
    packedManifest.scripts = { tests: { node: ['./scripts/native.test.mjs'] } };
    await Promise.all([
      fs.writeJson(packedManifestPath, packedManifest, { spaces: 2 }),
      fs.outputFile(path.join(packedPluginRoot, 'skills', 'packed-native', 'SKILL.md'),
        '---\nname: packed-native\ndescription: Installed tarball native Skill fixture.\n---\nUse this native Skill fixture.\n'),
      fs.outputFile(path.join(packedPluginRoot, 'skills', 'packed-native', 'README.md'), '# Native Skill fixture\n'),
      fs.outputFile(path.join(packedPluginRoot, 'skills', 'packed-native', 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n'),
      fs.outputFile(path.join(packedPluginRoot, 'command', 'entry.mjs'), [
        "import { readNativeTool } from './native-reader.mjs';",
        "if (process.platform === 'win32') readNativeTool('job', 'aw.windows-job.v1');",
        'process.stdout.write(JSON.stringify(process.argv.slice(2)));',
      ].join('\n')),
      fs.outputFile(path.join(packedPluginRoot, 'scripts', 'native.test.mjs'), [
        "import assert from 'node:assert/strict';",
        "import { test } from 'node:test';",
        "import { readNativeTool } from '../command/native-reader.mjs';",
        "test('uses the AW generated reader and explicit platform binding', () => {",
        "  if (process.platform === 'win32') assert.equal(readNativeTool('job', 'aw.windows-job.v1').state, 'ready');",
        "  else assert.throws(() => readNativeTool('job', 'aw.windows-job.v1'), { code: 'nativeContextInvalid' });",
        '});',
      ].join('\n')),
    ]);
    const nativeFixturePath = path.join(tempRoot, 'native-test-context.json');
    await fs.writeJson(nativeFixturePath, {
      schemaVersion: 1,
      tools: { job: { state: 'ready', protocol: 'aw.windows-job.v1', executable: process.execPath } },
    });
    const packedValidation = await execAw([
      'dev', 'plugin', 'validate', packedPluginDirectory,
      '--workspace-root', standaloneWorkspace, '--json',
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    expect(readCommandResult(packedValidation.stdout, 'dev.plugin.validate')).toMatchObject({
      status: 'success', data: { profile: 'aw-source' },
    });
    const packedTest = await execAw([
      'dev', 'plugin', 'test', packedPluginDirectory,
      '--workspace-root', standaloneWorkspace, '--native-mode', 'fixture',
      '--native-context', nativeFixturePath, '--json',
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    expect(readCommandResult(packedTest.stdout, 'dev.plugin.test')).toMatchObject({ status: 'success', data: { exitCode: 0 } });
    await execAw([
      'dev', 'plugin', 'build', packedPluginDirectory,
      '--workspace-root', standaloneWorkspace,
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    await execAw([
      'dev', 'catalog', 'build', '--workspace-root', standaloneWorkspace,
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    const nativeSnapshotRoot = path.join(standaloneWorkspace, '.aw', 'catalog', 'plugins', 'packed-build');
    await expect(fs.pathExists(path.join(nativeSnapshotRoot, 'command', 'native-reader.mjs'))).resolves.toBe(true);
    expect((await listFilesRecursively(nativeSnapshotRoot)).some((file) => file.endsWith('.lock.json'))).toBe(false);
    await expect(fs.pathExists(path.join(packedPluginRoot, 'command', 'native-reader.mjs'))).resolves.toBe(false);
    expect((await listFilesRecursively(nativeSnapshotRoot)).some((file) => file.endsWith('.exe'))).toBe(false);
    const packedCatalogValidation = await execAw([
      'dev', 'catalog', 'validate', path.join(standaloneWorkspace, '.aw', 'catalog'), '--json',
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    expect(readCommandResult(packedCatalogValidation.stdout, 'dev.catalog.validate')).toMatchObject({ status: 'success', data: { catalogVersion: '0.1.0' } });
    const externalPathSource = await execAw([
      'dev', 'source', 'activate', '--workspace-root', standaloneWorkspace, '--primary', '--yes', '--json',
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    const developmentSourceReceipt = readCommandResult(externalPathSource.stdout, 'dev.source.activate');
    expect(developmentSourceReceipt).toMatchObject({
      status: 'success',
      data: { snapshot: { action: 'reused' }, source: { action: 'added', primary: true } },
    });
    const developmentSourceId = developmentSourceReceipt.data.source.id as string;
    await execFileAsync('git', ['init'], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    await execAw(['target', 'set', 'codex', '--json'], {
      cwd: standaloneWorkspace, env: externalAuthoringEnv,
    });
    // The fixed production qualification covers plain Codex Skills on macOS arm64.
    const codexSkillQualified = process.platform === 'darwin' && process.arch === 'arm64';
    const privateCacheFile = path.join(externalAuthoringEnv.CODEX_HOME, 'plugins', 'cache', 'foreign', 'keep.txt');
    await fs.outputFile(privateCacheFile, 'Keep private client content.\n');
    const installNative = async () => {
      let rawStdout = '';
      let rawStderr = '';
      const output = await execAw([
        'plugin', 'install', `${developmentSourceId}/packed-build`, '--scope', 'project', '--yes', '--json',
      ], { cwd: standaloneWorkspace, env: externalAuthoringEnv, maxBuffer: 10 * 1024 * 1024,
        onStdout: (chunk) => { rawStdout += chunk; }, onStderr: (chunk) => { rawStderr += chunk; } }).then(
        (value) => ({ ...value, exitCode: 0 }),
        (error: unknown) => {
          const failure = error as { code?: unknown };
          if (typeof failure.code !== 'number' || !rawStdout) throw error;
          return { exitCode: failure.code, stdout: rawStdout, stderr: rawStderr };
        },
      );
      const receipt = readCommandResult(output.stdout, 'plugin.install');
      const nativeCalls = (await fs.readFile(externalAuthoringEnv.AW_PACK_NATIVE_CALL_LOG, 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line));
      return { ...output, receipt, diagnostic: sanitizeTestDiagnostic(JSON.stringify({ receipt, nativeCalls }, null, 2), externalAuthoringEnv) };
    };
    const nativeStatePath = path.join(externalAuthoringEnv.CODEX_HOME, 'fake-plugin-state.json');
    const readNativeState = async (): Promise<{
      marketplaces: Record<string, string>;
      plugins: Record<string, { pluginName: string; marketplaceName: string; version: string; path: string }>;
    }> => await fs.pathExists(nativeStatePath) ? fs.readJson(nativeStatePath) : { marketplaces: {}, plugins: {} };
    const projectInstallBeforeTrust = await installNative();
    expect(projectInstallBeforeTrust.exitCode, projectInstallBeforeTrust.diagnostic).toBe(4);
    expect(projectInstallBeforeTrust.receipt, projectInstallBeforeTrust.diagnostic).toMatchObject({
      status: 'partial',
      data: {
        request: { scope: 'project', targets: ['codex'], targetOrigin: 'preference' },
        requirements: { state: 'valid', roots: [`${developmentSourceId}/packed-build`] },
        changes: { requirements: 'changed' },
        targetResults: expect.arrayContaining([expect.objectContaining({
          pluginId: `${developmentSourceId}/packed-build`,
          target: 'codex',
          delivery: { kind: 'native', platform: 'codex' },
          observation: 'unknown',
        })]),
      },
    });
    const codexBeforeTrust = projectInstallBeforeTrust.receipt.data.targetResults.find((target: { target: string }) => target.target === 'codex');
    const nativeBeforeTrust = await readNativeState();
    const installedNativeEntry = Object.entries(nativeBeforeTrust.plugins);
    let nativePluginId: string | undefined;
    let nativePackageRoot: string | undefined;
    let nativePackageFiles: string[] | undefined;
    if (codexSkillQualified) {
      expect(installedNativeEntry).toHaveLength(1);
      const [id, nativePlugin] = installedNativeEntry[0]!;
      nativePluginId = id;
      nativePackageRoot = nativePlugin.path;
      expect(id).toBe(`packed-build@${nativePlugin.marketplaceName}`);
      expect(nativePlugin.marketplaceName).toMatch(new RegExp(`^aw-${developmentSourceId}-[a-f0-9]{12}$`, 'u'));
      expect(nativePackageRoot).toBe(path.join(nativeBeforeTrust.marketplaces[nativePlugin.marketplaceName]!, 'plugins', 'packed-build'));
      expect(codexBeforeTrust, projectInstallBeforeTrust.diagnostic).toMatchObject({ execution: 'partial', deploymentReceipts: expect.arrayContaining([
        expect.objectContaining({ after: expect.objectContaining({ package: 'present', registration: 'present', ownership: 'aw',
          consumers: expect.arrayContaining([expect.objectContaining({ activation: 'unknown', trust: 'unknown' })]) }) }),
      ]) });
      expect(await fs.readJson(path.join(nativePackageRoot, '.agent-workflows-owner.json'))).toMatchObject({
        schemaVersion: 3, owner: 'agent-workflows', sourceId: developmentSourceId,
        pluginId: `${developmentSourceId}/packed-build`, platform: 'codex', scope: 'user',
        sourceIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        physicalKey: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        nativeProjection: { components: expect.arrayContaining([expect.objectContaining({
          id: 'skill:packed-native', nativeName: 'packed-native',
          relativeOutputs: expect.arrayContaining(['skills/packed-native/SKILL.md']),
        })]) },
      });
      expect(await fs.readJson(path.join(nativePackageRoot, '.codex-plugin', 'plugin.json'))).toMatchObject({ name: 'packed-build', version: '0.1.0' });
      const projectConfigBeforeTrust = await fs.readFile(path.join(standaloneWorkspace, '.codex', 'config.toml'), 'utf8');
      expect(projectConfigBeforeTrust).toContain(`[plugins.${JSON.stringify(id)}]`);
      expect(projectConfigBeforeTrust).toContain('enabled = true');
      nativePackageFiles = await listFilesRecursively(nativePackageRoot);
    } else {
      expect(installedNativeEntry).toEqual([]);
      expect(codexBeforeTrust).toMatchObject({ execution: 'not-run', blockerCodes: ['noSupportedComponents'] });
      expect(codexBeforeTrust).not.toHaveProperty('deploymentReceipts');
      expect(codexBeforeTrust.deploymentPlans).toEqual(expect.arrayContaining([
        expect.objectContaining({ effects: [], expected: expect.objectContaining({ components: [], unmet: expect.arrayContaining([
          expect.objectContaining({ id: 'skill:packed-native', kind: 'skill', reasonCode: 'capability-unverified' }),
        ]) }) }),
      ]));
      expect(await fs.pathExists(path.join(standaloneWorkspace, '.codex', 'config.toml'))).toBe(false);
    }
    await fs.appendFile(path.join(externalAuthoringEnv.CODEX_HOME, 'config.toml'), [
      '',
      `[projects.${JSON.stringify(await fs.realpath(standaloneWorkspace))}]`,
      'trust_level = "trusted"',
      '',
    ].join('\n'));
    await execAw(['target', 'set', 'codex', 'claude', '--json'], {
      cwd: standaloneWorkspace, env: externalAuthoringEnv,
    });
    const externalInstall = await installNative();
    expect(externalInstall.exitCode, externalInstall.diagnostic).toBe(codexSkillQualified ? 4 : 3);
    expect(externalInstall.receipt, externalInstall.diagnostic).toMatchObject({
      status: codexSkillQualified ? 'partial' : 'blocked',
      data: {
        request: { scope: 'project', targets: expect.arrayContaining(['codex', 'claude']), targetOrigin: 'preference' },
        requirements: { state: 'valid', roots: [`${developmentSourceId}/packed-build`] },
        changes: { requirements: 'none' },
        targetResults: expect.arrayContaining([
          expect.objectContaining({
            pluginId: `${developmentSourceId}/packed-build`, target: 'codex',
            delivery: { kind: 'native', platform: 'codex' }, observation: codexSkillQualified ? 'verified' : 'unknown',
          }),
          expect.objectContaining({
            pluginId: `${developmentSourceId}/packed-build`, target: 'claude',
            delivery: { kind: 'native', platform: 'claude' }, observation: 'unknown',
            execution: 'not-run', blockerCodes: ['noSupportedComponents'],
            deploymentPlans: expect.arrayContaining([expect.objectContaining({ effects: [],
              expected: expect.objectContaining({ components: [], unmet: expect.arrayContaining([expect.objectContaining({ id: 'skill:packed-native', kind: 'skill',
                reasonCode: 'capability-unverified', requiredFeatures: [{ feature: 'component.kind.skill' }] })]),
              }),
            })]),
          }),
        ]),
      },
    });
    expect(externalInstall.receipt.data.targetResults.find((target: { target: string }) => target.target === 'claude'))
      .not.toHaveProperty('deploymentReceipts');
    if (codexSkillQualified) {
      const projectCodexConfig = await fs.readFile(path.join(standaloneWorkspace, '.codex', 'config.toml'), 'utf8');
      expect(projectCodexConfig).toContain(`[plugins.${JSON.stringify(nativePluginId)}]`);
      expect(projectCodexConfig).not.toContain('mcp_servers');
      expect(await listFilesRecursively(nativePackageRoot!)).toEqual(nativePackageFiles);
      expect((await readNativeState()).plugins[nativePluginId!]?.path).toBe(nativePackageRoot);
    } else {
      expect((await readNativeState()).plugins).toEqual({});
      expect(await fs.pathExists(path.join(standaloneWorkspace, '.codex', 'config.toml'))).toBe(false);
    }
    await expect(fs.pathExists(path.join(standaloneWorkspace, '.codex', 'hooks.json')))
      .resolves.toBe(false);
    expect(await fs.readFile(privateCacheFile, 'utf8')).toBe('Keep private client content.\n');
    for (const file of [path.join(standaloneWorkspace, '.claude', 'settings.json'),
      path.join(standaloneWorkspace, '.claude', 'settings.local.json'),
      path.join(externalAuthoringEnv.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json'),
      path.join(externalAuthoringEnv.CLAUDE_CONFIG_DIR, 'plugins', 'known_marketplaces.json')]) {
      expect(await fs.pathExists(file), file).toBe(false);
    }
    const nativeCalls = (await fs.readFile(externalAuthoringEnv.AW_PACK_NATIVE_CALL_LOG, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { platform: string; args: string[]; cwd: string });
    expect(nativeCalls.filter((call) => call.platform === 'claude' && call.args[0] === 'plugin' && call.args[1] !== 'list')).toEqual([]);
    if (codexSkillQualified) {
      expect(nativeCalls).toContainEqual(expect.objectContaining({ platform: 'codex', args: ['plugin', 'add', nativePluginId] }));
    } else {
      expect(nativeCalls.filter((call) => call.platform === 'codex' && call.args[0] === 'plugin'
        && !['list', '--help'].includes(call.args[1]!))).toEqual([]);
    }
    await expect(fs.readJson(path.join(externalAuthoringEnv.AW_HOME, 'catalog-sources.json')))
      .resolves.toMatchObject({
        schemaVersion: 2,
        sources: expect.arrayContaining([expect.objectContaining({
          id: developmentSourceId,
          type: 'path',
          managedBy: expect.objectContaining({ kind: 'catalog-workspace' }),
        })]),
      });
    // Independent command packages do not require a qualified Native component.
    const nativePackageSync = await execAw([
      'command', 'package', 'sync', `${developmentSourceId}/packed-build`, 'native-tool',
      '--scope', 'user', '--yes', '--json',
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    expect(readCommandResult(nativePackageSync.stdout, 'command.package.sync')).toMatchObject({ status: 'success' });
    const commandList = await execAw(['command', 'list', '--json'], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    const managedCommands = readCommandResult(commandList.stdout, 'command.list');
    const nativeCommand = managedCommands.data.commands.find((command: { name: string }) => command.name === 'native-tools/run/default');
    expect(nativeCommand).toMatchObject({ availability: 'ready', owner: { kind: 'plugin', producer: {
      kind: 'package', key: 'native-tool', sourceId: developmentSourceId, pluginName: 'packed-build', scope: 'user', platform: null,
    } } });
    expect(await fs.pathExists(path.join(nativeCommand.resourceRoot, 'native-reader.mjs'))).toBe(true);
    const commandRun = await execAw(['command', 'run', nativeCommand.id, '--', 'packed-argument'], {
      cwd: standaloneWorkspace, env: externalAuthoringEnv,
    });
    expect(JSON.parse(commandRun.stdout)).toEqual(['packed-argument']);
    const nativeStateBeforeDeactivate = await readNativeState();
    const nativeCommandBeforeDeactivate = await fs.readFile(path.join(nativeCommand.resourceRoot, 'entry.mjs'));
    const developmentSourceRemoval = await execAw([
      'dev', 'source', 'deactivate', '--workspace-root', standaloneWorkspace, '--yes', '--json',
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    expect(readCommandResult(developmentSourceRemoval.stdout, 'dev.source.deactivate')).toMatchObject({
      status: 'success',
      data: {
        source: { id: developmentSourceId, action: 'removed', previousPrimary: true },
        replacementPrimarySourceId: 'official',
        impact: {
          inventorySchemaVersion: 2,
          primaryChange: { fromSourceId: developmentSourceId, toSourceId: 'official' },
          inventoryComplete: true,
          references: expect.arrayContaining([expect.objectContaining({
            sourceId: developmentSourceId,
            pluginId: `${developmentSourceId}/packed-build`,
            scope: 'project',
          })]),
          errors: [],
        },
      },
    });
    expect(await readNativeState()).toEqual(nativeStateBeforeDeactivate);
    expect(await fs.readFile(path.join(nativeCommand.resourceRoot, 'entry.mjs'))).toEqual(nativeCommandBeforeDeactivate);
    expect(await fs.readFile(privateCacheFile, 'utf8')).toBe('Keep private client content.\n');
    await expect(fs.pathExists(path.join(standaloneWorkspace, '.aw', 'catalog'))).resolves.toBe(true);
    const packedCatalogRemote = path.join(tempRoot, 'packed-catalog.git');
    registerSmokeWritableRoot(packedCatalogRemote, 'packed CLI Catalog publication remote');
    markStage('prepare Catalog Git remote start');
    await execFileAsync('git', ['init', '--bare', packedCatalogRemote], { env: process.env });
    await execFileAsync('git', ['add', '.'], { cwd: standaloneWorkspace, env: process.env });
    await execFileAsync('git', [
      '-c', 'user.name=Pack Smoke', '-c', 'user.email=pack-smoke@example.invalid',
      'commit', '-m', 'packed Catalog source',
    ], { cwd: standaloneWorkspace, env: process.env });
    await execFileAsync('git', ['remote', 'add', 'origin', packedCatalogRemote], {
      cwd: standaloneWorkspace,
      env: process.env,
    });
    markStage('prepare Catalog Git remote end');
    const packedPlan = await execAw([
      'dev', 'catalog', 'publish', 'plan', '--workspace-root', standaloneWorkspace,
      '--remote', 'origin', '--branch', 'catalog', '--json',
    ], { cwd: standaloneWorkspace, env: process.env });
    const planResult = readCommandResult(packedPlan.stdout, 'dev.catalog.publish.plan');
    expect(planResult).toMatchObject({ status: 'success', data: { prepared: true, planDigest: expect.stringMatching(/^sha256:/u) } });
    const packedPlanDigest = planResult.data.planDigest as string;
    const packedPublish = await execAw([
      'dev', 'catalog', 'publish', 'apply', '--workspace-root', standaloneWorkspace,
      '--remote', 'origin', '--branch', 'catalog',
      '--expected-plan-digest', packedPlanDigest, '--yes', '--json',
    ], { cwd: standaloneWorkspace, env: process.env });
    const packedPublishReceipt = readCommandResult(packedPublish.stdout, 'dev.catalog.publish.apply');
    expect(packedPublishReceipt.status).toBe('success');
    expect((await execFileAsync('git', [
      '--git-dir', packedCatalogRemote, 'rev-parse', 'refs/heads/catalog',
    ], { env: process.env })).stdout.trim()).toBe(packedPublishReceipt.data.commit);
    expect((await execFileAsync('git', [
      '--git-dir', packedCatalogRemote, 'rev-parse', 'refs/tags/catalog-v0.1.0^{}',
    ], { env: process.env })).stdout.trim()).toBe(packedPublishReceipt.data.commit);
    const packedConsumerEnv = {
      ...externalAuthoringEnv,
      AW_HOME: path.join(tempRoot, 'packed-catalog-consumer-home'),
      HOME: path.join(tempRoot, 'packed-catalog-consumer-user'),
      USERPROFILE: path.join(tempRoot, 'packed-catalog-consumer-user'),
      CODEX_HOME: path.join(tempRoot, 'packed-catalog-consumer-user', '.codex'),
      CLAUDE_CONFIG_DIR: path.join(tempRoot, 'packed-catalog-consumer-user', '.claude'),
      XDG_STATE_HOME: path.join(tempRoot, 'packed-catalog-consumer-user', '.local', 'state'),
    };
    const projectIntentPath = path.join(standaloneWorkspace, '.agent-workflows', 'plugin-intents.json');
    const projectIntentBeforeUserRecovery = await fs.readFile(projectIntentPath, 'utf8');
    for (const removedCommand of [
      ['project', 'status', '--json'],
      ['sync', '--all', '--scope', 'user', '--platform', 'both', '--json'],
    ]) {
      const failure = await execAw(removedCommand, {
        cwd: tempRoot, env: packedConsumerEnv,
      }).then(() => null, (error: unknown) => error as { code: number; stdout: string });
      expect(failure?.code).toBe(2);
      expect(readCommandResult(failure!.stdout, null)).toMatchObject({
        status: 'failed', data: {},
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'invalidArguments' })]),
      });
    }
    const sourceAdd = await execAw([
      'source', 'add', 'packed', '--git', packedCatalogRemote,
      '--ref', 'refs/heads/catalog', '--primary', '--yes', '--json',
    ], { cwd: tempRoot, env: packedConsumerEnv });
    expect(readCommandResult(sourceAdd.stdout, 'source.add')).toMatchObject({ status: 'success', data: { sourceId: 'packed' } });
    const sourceSync = await execAw([
      'source', 'sync', 'packed', '--json',
    ], { cwd: tempRoot, env: packedConsumerEnv });
    expect(readCommandResult(sourceSync.stdout, 'source.sync')).toMatchObject({
      status: 'success',
      data: {
        sourceId: 'packed', mode: 'sync', outcome: 'activated', activeChanged: true,
        active: { snapshotDigest: expect.stringMatching(/^sha256:/u) },
      },
    });
    expect(sourceSync.stderr).toBe('');
    await execAw(['target', 'set', 'codex', '--context', 'user', '--json'], {
      cwd: tempRoot, env: packedConsumerEnv,
    });
    const consumedIntent = await execAw([
      'plugin', 'install', 'packed/packed-build', '--scope', 'user', '--only', 'requirements', '--json',
    ], { cwd: tempRoot, env: packedConsumerEnv });
    expect(readCommandResult(consumedIntent.stdout, 'plugin.install')).toMatchObject({
      status: 'success',
      data: { request: { scope: 'user', mode: 'requirements-only' }, requirements: { roots: ['packed/packed-build'] }, targetResults: [] },
    });
    expect(await fs.readFile(projectIntentPath, 'utf8')).toBe(projectIntentBeforeUserRecovery);
    let consumedStatusStdout = '';
    let consumedStatusStderr = '';
    const consumedStatus = await execAw([
      'plugin', 'status', '--context', 'user', '--json',
    ], { cwd: tempRoot, env: packedConsumerEnv,
      onStdout: (chunk) => { consumedStatusStdout += chunk; },
      onStderr: (chunk) => { consumedStatusStderr += chunk; } }).then(
      (value) => ({ ...value, exitCode: 0 }),
      (error: unknown) => {
        const failure = error as { code?: unknown };
        if (typeof failure.code !== 'number' || !consumedStatusStdout) throw error;
        return { exitCode: failure.code, stdout: consumedStatusStdout, stderr: consumedStatusStderr };
      },
    );
    expect(consumedStatus.exitCode).toBe(codexSkillQualified ? 0 : 3);
    const consumedStatusReceipt = readCommandResult(consumedStatus.stdout, 'plugin.status');
    expect(consumedStatusReceipt).toMatchObject({
      status: codexSkillQualified ? 'success' : 'blocked',
      data: {
        context: 'user', requirements: { state: 'valid' },
        inventory: expect.arrayContaining([expect.objectContaining({ pluginId: 'packed/packed-build' })]),
      },
    });
    if (!codexSkillQualified) {
      expect(consumedStatusReceipt.diagnostics).toContainEqual(expect.objectContaining({ code: 'capability-unverified' }));
    }
    expect(consumedStatus.stderr).toBe(codexSkillQualified ? ''
      : 'capability-unverified: The operation could not complete (capability-unverified).\n');
    const packedRemoval = await execAw([
      'dev', 'plugin', 'remove', 'packed-build',
      '--workspace-root', standaloneWorkspace, '--yes', '--json',
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    expect(readCommandResult(packedRemoval.stdout, 'dev.plugin.remove')).toMatchObject({
      status: 'success',
      data: { plugin: { name: 'packed-build', version: '0.1.0' }, removed: true },
      diagnostics: [],
    });
    expect(packedRemoval.stderr).toBe('');
    await expect(fs.pathExists(path.join(standaloneWorkspace, 'plugins', 'packed-build')))
      .resolves.toBe(false);

    const authorRepo = path.join(tempRoot, 'author-repo');
    registerSmokeWritableRoot(authorRepo, 'pack smoke plugin author repository');
    await fs.copy(fixturePath('repo-template'), authorRepo);
    await execAw([
      'dev',
      'plugin',
      'create',
      'validate-fixture',
      '--description',
      'A deterministic fixture for the packed CLI validator.',
      '--no-skills',
      '--workspace-root',
      authorRepo,
    ], { cwd: authorRepo, env: process.env });
    const validation = await execAw([
      'dev',
      'plugin',
      'validate',
      path.join(authorRepo, 'plugins', 'validate-fixture'),
      '--json',
    ], { cwd: authorRepo, env: process.env });
    const validationResult = readCommandResult(validation.stdout, 'dev.plugin.validate');
    expect(validationResult).toMatchObject({
      status: 'success', data: { profile: 'aw-source' },
    });
    expect(validationResult.diagnostics).not.toContainEqual(expect.objectContaining({ severity: 'error' }));

    const portablePluginRoot = path.join(authorRepo, 'plugins', 'validate-fixture');
    const portableManifestPath = path.join(portablePluginRoot, '.agents-plugin', 'plugin.json');
    const portableManifest = await fs.readJson(portableManifestPath);
    portableManifest.platforms = ['generic'];
    portableManifest.skills = './skills';
    delete portableManifest.extensions;
    await fs.writeJson(portableManifestPath, portableManifest, { spaces: 2 });
    await fs.outputFile(
      path.join(portablePluginRoot, 'skills', 'packed-portable', 'SKILL.md'),
      '---\nname: packed-portable\ndescription: Packed portable validator fixture.\n---\n\n# Packed portable\n',
    );
    await fs.outputFile(
      path.join(portablePluginRoot, 'skills', 'packed-portable', 'README.md'),
      '# Packed portable fixture\n',
    );
    const portableValidation = await execAw([
      'dev',
      'plugin',
      'validate',
      portablePluginRoot,
      '--json',
    ], { cwd: authorRepo, env: process.env });
    expect(readCommandResult(portableValidation.stdout, 'dev.plugin.validate')).toMatchObject({ status: 'success', data: { profile: 'aw-source' } });

    const portableCatalog = path.join(tempRoot, 'portable-path-catalog');
    await Promise.all([
      fs.outputFile(
        path.join(portableCatalog, 'plugins', 'portable-pack', 'generic', 'skills', 'packed-portable', 'SKILL.md'),
        '---\nname: packed-portable\ndescription: Installed tarball command fixture.\n---\n\n# Packed portable\n',
      ),
      fs.outputFile(
        path.join(portableCatalog, 'plugins', 'portable-pack', 'generic', 'skills', 'packed-portable', 'README.md'),
        '# Installed tarball command fixture\n',
      ),
    ]);
    await createCatalogSnapshotFixture(
      portableCatalog,
      'portable-pack',
      [],
      '# Portable pack plugin\n',
      (manifest) => {
        manifest.platforms = ['generic'];
        manifest.skills = './skills';
      },
    );
    const catalogPortablePluginRoot = path.join(portableCatalog, 'plugins', 'portable-pack');
    const portablePlugin = await readPluginManifest(catalogPortablePluginRoot, { mode: 'bundle' });
    await fs.outputJson(
      path.join(
        catalogPortablePluginRoot,
        'generic',
        'skills',
        'packed-portable',
        'aw-plugin-requirements.json',
      ),
      createAwPluginRequirementsReceipt(
        { name: portablePlugin.manifest.name, version: portablePlugin.manifest.version },
        portablePlugin.manifest.requires?.aw.capabilities ?? [],
      ),
      { spaces: 2 },
    );
    const portableCatalogManifestPath = path.join(portableCatalog, 'catalog-manifest.json');
    const portableCatalogManifest = await fs.readJson(portableCatalogManifestPath);
    portableCatalogManifest.entries = [
      await createCatalogManifestV7Entry(portablePlugin, portablePlugin.rootDir),
    ];
    await fs.writeJson(portableCatalogManifestPath, portableCatalogManifest, { spaces: 2 });
    const portableCwd = path.join(tempRoot, 'portable-project');
    const portableHome = path.join(tempRoot, 'portable-aw-home');
    const materializedOut = path.join(tempRoot, 'materialized-portable');
    await Promise.all([
      fs.ensureDir(portableCwd),
      fs.outputJson(path.join(portableHome, 'catalog-sources.json'), {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: portableCatalog }],
      }),
    ]);
    const portableEnv = {
      ...externalAuthoringEnv,
      AW_HOME: portableHome,
      CODEX_HOME: path.join(tempRoot, 'portable-codex-home'),
      CLAUDE_CONFIG_DIR: path.join(tempRoot, 'portable-claude-home'),
    };
    const portableSourceSync = await execAw([
      'source', 'sync', 'local', '--json',
    ], { cwd: portableCwd, env: portableEnv });
    expect(readCommandResult(portableSourceSync.stdout, 'source.sync')).toMatchObject({
      status: 'success',
      data: {
        sourceId: 'local', mode: 'sync', outcome: 'activated', activeChanged: true,
        active: { snapshotDigest: expect.stringMatching(/^sha256:/u) },
      },
    });
    expect(portableSourceSync.stderr).toBe('');
    await execAw([
      'dev', 'skill', 'export', 'local/portable-pack',
      '--platform', 'generic', '--scope', 'project', '--out', materializedOut,
    ], { cwd: portableCwd, env: portableEnv });
    await expect(fs.readJson(path.join(materializedOut, '.aw-materialization.json')))
      .resolves.toMatchObject({
        schemaVersion: 1,
        plugin: { id: 'local/portable-pack', version: '1.0.0' },
        scope: 'project',
        platform: 'generic',
      });

    // Keep the installed tarball's real generic Skill writer in the external smoke boundary.
    await execFileAsync('git', ['init'], { cwd: portableCwd, env: portableEnv });
    await execAw(['target', 'set', 'generic', '--context', 'user', '--json'], {
      cwd: portableCwd, env: portableEnv,
    });
    const portableInstall = await execAw([
      'plugin', 'install', 'local/portable-pack', '--scope', 'project', '--yes', '--json',
    ], { cwd: portableCwd, env: portableEnv, maxBuffer: 10 * 1024 * 1024 });
    expect(readCommandResult(portableInstall.stdout, 'plugin.install')).toMatchObject({
      status: 'success',
      data: {
        request: { scope: 'project', targets: ['generic'], targetOrigin: 'preference' },
        requirements: { state: 'valid', roots: ['local/portable-pack'] },
        targetResults: expect.arrayContaining([expect.objectContaining({
          pluginId: 'local/portable-pack', target: 'generic', scope: 'project',
          delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'generic' },
          observation: 'verified',
        })]),
      },
    });
    expect(portableInstall.stderr).toBe('');
    const installedPortableRoot = path.join(portableCwd, '.agents', 'skills', 'packed-portable');
    expect((await fs.lstat(installedPortableRoot)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(installedPortableRoot, 'SKILL.md'), 'utf8'))
      .toBe(await fs.readFile(path.join(materializedOut, 'skills', 'packed-portable', 'SKILL.md'), 'utf8'));
    await expect(fs.pathExists(path.join(installedPortableRoot, 'README.md'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(portableCwd, '.codex', 'config.toml'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(portableCwd, '.claude', 'settings.json'))).resolves.toBe(false);

    await execAw([
      'dev',
      'plugin',
      'create',
      'author-smoke',
      '--description',
      'A deterministic fixture for packed CLI scaffolding.',
      '--with-config-api',
      '--no-skills',
      '--workspace-root',
      authorRepo,
    ], { cwd: authorRepo, env: process.env });
    const helperPath = path.join(
      authorRepo,
      'plugins',
      'author-smoke',
      'scripts',
      'aw-config.mjs',
    );
    await expect(fs.pathExists(path.join(
      path.dirname(helperPath),
      're2-wasm',
    ))).resolves.toBe(false);
    const authorValidation = await execAw([
      'dev',
      'plugin',
      'validate',
      path.join('plugins', 'author-smoke'),
      '--workspace-root',
      authorRepo,
      '--json',
    ], { cwd: authorRepo, env: externalAuthoringEnv });
    expect(readCommandResult(authorValidation.stdout, 'dev.plugin.validate')).toMatchObject({ status: 'success', data: { profile: 'aw-source' } });
    const buildReceipt = await execAw([
      'dev',
      'plugin',
      'build',
      path.join('plugins', 'author-smoke'),
      '--workspace-root',
      authorRepo,
      '--json',
    ], { cwd: authorRepo, env: externalAuthoringEnv });
    const buildResult = readCommandResult(buildReceipt.stdout, 'dev.plugin.build');
    expect(buildResult.status).toBe('success');
    const builtHelperPath = path.join(buildResult.data.outputRoot, 'scripts', 'aw-config.mjs');
    await expect(fs.pathExists(path.join(
      path.dirname(builtHelperPath),
      're2-wasm',
    ))).resolves.toBe(false);
    markStage('built config helper start');
    const helperHelp = await execFileAsync(process.execPath, [builtHelperPath, '--help'], {
      cwd: authorRepo,
      env: externalAuthoringEnv,
    });
    markStage('built config helper end');
    expect(helperHelp.stdout).toContain('--scope effective');
    expect(helperHelp.stderr).toBe('');
    await execAw([
      'dev',
      'skill',
      'create',
      '--plugin',
      'author-smoke',
      '--skill-name',
      'second-skill',
      '--skill-description',
      'Add a second deterministic Skill from the packed CLI runtime.',
      '--skill-short-description',
      'Add a second packed CLI Skill fixture.',
      '--workspace-root',
      authorRepo,
    ], { cwd: authorRepo, env: process.env });
    await expect(fs.pathExists(path.join(
      authorRepo,
      'plugins',
      'author-smoke',
      'skills',
      'second-skill',
      'SKILL.md',
    ))).resolves.toBe(true);
    const installedEvalRoot = path.join(globalNodeModules, '@lesliechan721', 'agent-skill-eval');
    const installedEvalManifest = await fs.readJson(path.join(installedEvalRoot, 'package.json')) as {
      bin: { 'aw-skill-eval': string };
    };
    await expect(fs.pathExists(evalBin)).resolves.toBe(true);
    markStage('installed Eval help start');
    const evalHelp = await execFileAsync(
      process.platform === 'win32' ? process.execPath : evalBin,
      process.platform === 'win32'
        ? [path.resolve(installedEvalRoot, installedEvalManifest.bin['aw-skill-eval']), '--help']
        : ['--help'],
      {
        cwd: tempRoot,
        env: externalAuthoringEnv,
      },
    );
    markStage('installed Eval help end');
    expect(evalHelp.stdout).toContain('spec validate <spec.json>');
    expect(evalHelp.stdout).toContain('audit validate <audit.json> --spec <spec.json>');
    expect(evalHelp.stdout).toContain('result validate <result.json> --spec <spec.json> --audit <audit.json>');
    expect(evalHelp.stdout).not.toContain('capabilities');
    expect(evalHelp.stderr).toBe('');

    expect((await fs.lstat(installedEvalRoot)).isSymbolicLink()).toBe(false);
  }), process.platform === 'win32' ? 600_000 : 300_000);

  it('packs the CLI tarball without the staged plugins-dist snapshot', smokeCase(async () => {
    const packageRoot = path.join(repoRoot(), 'packages', 'cli');
    const { packageRoot: unpackedPackageRoot } = await preparePackedCli();
    const unpackedFiles = await listFilesRecursively(unpackedPackageRoot);
    await expect(fs.pathExists(path.join(unpackedPackageRoot, 'dist', 'index.js'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(
      unpackedPackageRoot,
      'dist',
      'authoring',
      'scripts',
      'validate-plugin.mjs',
    ))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(
      unpackedPackageRoot,
      'dist',
      'authoring',
      'scripts',
      'remove-plugin.mjs',
    ))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(
      unpackedPackageRoot,
      'dist',
      'src',
      'portable',
      'materializer.js',
    ))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(
      unpackedPackageRoot,
      'dist',
      'authoring',
      'assets',
      'aw-config.mjs',
    ))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(unpackedPackageRoot, 'plugins-dist'))).resolves.toBe(false);
    expect(unpackedFiles).not.toContain('dist/stale-build-sentinel.js');
    expect(unpackedFiles).not.toContain('dist/src/commands/review-publication.js');
    expect(unpackedFiles.some((file) => file.startsWith('plugins-dist/'))).toBe(false);
    expect(unpackedFiles.some((file) => file === 'node_modules' || file.startsWith('node_modules/')))
      .toBe(false);
    expect(unpackedFiles.some((file) => file.includes('build-snapshots'))).toBe(false);
    expect(unpackedFiles.some((file) => file.startsWith('.release/'))).toBe(false);
    const unpackedPackageJson = await fs.readJson(
      path.join(unpackedPackageRoot, 'package.json'),
    ) as {
      version: string;
      dependencies: Record<string, string>;
      bin: Record<string, string>;
    };
    expect(unpackedPackageJson).toMatchObject({
      name: '@lesliechan721/aw',
      engines: {
        node: '>=22',
      },
      files: ['dist/'],
    });
    expect(unpackedPackageJson.dependencies['@lesliechan721/agent-skill-eval'])
      .toBe(unpackedPackageJson.version);
    expect(unpackedPackageJson.dependencies['@lesliechan721/aw-plugin-core'])
      .toBe(unpackedPackageJson.version);
    expect(unpackedPackageJson.bin).toEqual({ aw: './dist/index.js' });

    await installDeclaredDependencyOnlyView(unpackedPackageRoot, packageRoot);
    const isolatedVersion = await execFileAsync(
      process.execPath,
      [path.join(unpackedPackageRoot, 'dist', 'index.js'), '--version', '--json'],
      {
        cwd: unpackedPackageRoot,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    expect(readCommandResult(isolatedVersion.stdout, 'version')).toMatchObject({
      status: 'success', data: { version: unpackedPackageJson.version },
    });
    expect(isolatedVersion.stderr).toBe('');
    await expect(execFileAsync(
      process.execPath,
      [path.join(unpackedPackageRoot, 'dist', 'index.js'), '--help'],
      {
        cwd: unpackedPackageRoot,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    )).resolves.toMatchObject({
      stdout: expect.stringContaining('Usage: aw'),
      stderr: '',
    });

    const reviewHelp = await execFileAsync(
      process.execPath,
      [path.join(unpackedPackageRoot, 'dist', 'index.js'), 'dev', 'review', '--help'],
      { cwd: unpackedPackageRoot, env: process.env },
    );
    expect(reviewHelp.stderr).toBe('');
    expect(reviewHelp.stdout).toMatch(/^\s+inspect(?:\s|$)/mu);
    expect(reviewHelp.stdout).toMatch(/^\s+prepare(?:\s|$)/mu);
    expect(reviewHelp.stdout).not.toMatch(/^\s+(?:digest|publish|verify|list|show)(?:\s|$)/mu);
    const skillHelp = await execFileAsync(
      process.execPath,
      [path.join(unpackedPackageRoot, 'dist', 'index.js'), 'dev', 'skill', '--help'],
      { cwd: unpackedPackageRoot, env: process.env },
    );
    expect(skillHelp.stderr).toBe('');
    expect(skillHelp.stdout).toMatch(/^\s+export(?:\s|$)/mu);
    expect(skillHelp.stdout).toMatch(/^\s+validate(?:\s|$)/mu);

    const criticalImports = [
      path.join(unpackedPackageRoot, 'dist', 'src', 'utils', 'manifest.js'),
      path.join(unpackedPackageRoot, 'dist', 'src', 'generators', 'local-plugin.js'),
      path.join(unpackedPackageRoot, 'dist', 'scripts', 'bundle-plugins.js'),
    ].map((filePath) => pathToFileURL(filePath).href);
    await expect(execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        'await Promise.all(process.argv.slice(1).map((specifier) => import(specifier)));',
        ...criticalImports,
      ],
      {
        cwd: unpackedPackageRoot,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    )).resolves.toMatchObject({ stdout: '', stderr: '' });

    const undeclaredImportProbe = path.join(unpackedPackageRoot, 'undeclared-import-probe.mjs');
    await fs.writeFile(undeclaredImportProbe, 'import "vitest";\n', 'utf8');
    await expect(execFileAsync(
      process.execPath,
      [undeclaredImportProbe],
      {
        cwd: unpackedPackageRoot,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    )).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('ERR_MODULE_NOT_FOUND'),
    });
  }));

  it('validates the staging package manager from the unpacked tarball runtime', smokeCase(async () => {
    const { packageRoot, tempRoot } = await preparePackedCli();
    await installDeclaredDependencyOnlyView(packageRoot, path.join(repoRoot(), 'packages', 'cli'));
    const packageJson = await fs.readJson(path.join(packageRoot, 'package.json')) as {
      dependencies: Record<string, string>;
    };
    const packageManager = `pnpm@${packageJson.dependencies.pnpm}`;
    const stagingPackageRoot = path.join(tempRoot, 'staging-package');
    await fs.ensureDir(stagingPackageRoot);
    await fs.writeJson(path.join(stagingPackageRoot, 'package.json'), {
      name: 'staging-package',
      version: '1.0.0',
      packageManager,
    });

    const generatorUrl = pathToFileURL(
      path.join(packageRoot, 'dist', 'src', 'generators', 'local-plugin.js'),
    ).href;
    await expect(execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      'const { validateStagingPackageManager } = await import(process.argv[1]); '
        + 'console.log(await validateStagingPackageManager(process.argv[2]));',
      generatorUrl,
      stagingPackageRoot,
    ], {
      cwd: tempRoot,
      env: process.env,
    })).resolves.toMatchObject({ stdout: `${packageManager}\n`, stderr: '' });
  }));

  it('bundles manually invoked Skills from the unpacked tarball runtime', smokeCase(async () => {
    const root = repoRoot();
    const packageRoot = path.join(root, 'packages', 'cli');
    const { packageRoot: unpackedPackageRoot, tempRoot } = await preparePackedCli();
    const tempRepo = path.join(tempRoot, 'repo');
    const outputRoot = path.join(tempRoot, 'plugins-dist');
    registerSmokeWritableRoot(tempRepo, 'pack smoke manual Skill repo root');
    registerSmokeWritableRoot(outputRoot, 'pack smoke manual Skill output root');
    await fs.copy(fixturePath('repo-template'), tempRepo);
    const sourceRoot = path.join(tempRepo, 'plugins', 'manual-review-only');
    await fs.outputJson(path.join(sourceRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 4, name: 'manual-review-only', version: '1.0.0', description: 'A manually invoked review Skill.',
      platforms: ['codex', 'claude'], skills: './skills',
      marketplace: { category: 'workflow', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    });
    const skill = '---\nname: review\ndescription: Review the caller request.\ndisable-model-invocation: true\n---\nReview the caller request.\n';
    await fs.outputFile(path.join(sourceRoot, 'README.md'), '# Manual Review\n');
    await fs.outputFile(path.join(sourceRoot, 'skills/review/SKILL.md'), skill);
    await fs.outputFile(path.join(sourceRoot, 'skills/review/README.md'), '# Manual Review\n');
    await fs.outputFile(path.join(sourceRoot, 'skills/review/agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');

    await installDeclaredDependencyOnlyView(unpackedPackageRoot, packageRoot);
    await installCurrentSmokeDistIsolationBridge(unpackedPackageRoot);
    const { bundlePlugins } = (await import(
      pathToFileURL(path.join(unpackedPackageRoot, 'dist', 'scripts', 'bundle-plugins.js')).href
    )) as { bundlePlugins: (options: { repoRoot: string; outputRoot: string }) => Promise<unknown> };
    await bundlePlugins({ repoRoot: tempRepo, outputRoot });

    const pluginRoot = path.join(outputRoot, 'plugins', 'manual-review-only');
    for (const platform of ['claude', 'codex']) {
      await expect(fs.readFile(path.join(pluginRoot, platform, 'skills/review/SKILL.md'), 'utf8')).resolves.toBe(skill);
      await expect(fs.readFile(path.join(pluginRoot, platform, 'skills/review/agents/openai.yaml'), 'utf8'))
        .resolves.toContain('allow_implicit_invocation: false');
    }
    await expect(fs.readFile(path.join(pluginRoot, 'skills/review/SKILL.md'), 'utf8')).resolves.toBe(skill);
    const { validateBundleLayout } = (await import(
      pathToFileURL(path.join(unpackedPackageRoot, 'dist', 'src', 'utils', 'bundle-layout.js')).href
    )) as { validateBundleLayout: (rootDir: string) => Promise<void> };
    await expect(validateBundleLayout(outputRoot)).resolves.toBeUndefined();
  }));
});
