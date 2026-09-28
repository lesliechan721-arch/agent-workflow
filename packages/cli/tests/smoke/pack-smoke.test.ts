import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { afterAll, describe, expect, it } from 'vitest';

import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';
import { installCurrentSmokeDistIsolationBridge } from '../setup/test-isolation-smoke.js';
import { execPnpmForTest } from '../helpers/pnpm.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import {
  createAwPluginRequirementsReceipt,
  readPluginManifest,
} from '../../src/utils/manifest.js';

const execFileAsync = promisify(execFile);
const sharedTempBase = os.tmpdir();
const tempDirs: string[] = [];
let packedCliPromise: Promise<{
  packageRoot: string;
  cliTarballPath: string;
  evalTarballPath: string;
  coreTarballPath: string;
  windowsX64TarballPath: string;
  windowsArm64TarballPath: string;
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
    ['-xzf', tarballPath, '-C', unpackDir],
    {
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  return path.join(unpackDir, 'package');
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
  windowsX64TarballPath: string;
  windowsArm64TarballPath: string;
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
    await execPnpmForTest(
      ['pack:cli', '--pack-destination', packDir],
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
    expect(tarballs).toHaveLength(5);
    const cliTarballName = tarballs.find((entry) =>
      /-aw-\d/u.test(entry));
    const evalTarballName = tarballs.find((entry) => entry.includes('-agent-skill-eval-'));
    const coreTarballName = tarballs.find((entry) => entry.includes('-aw-plugin-core-'));
    const windowsX64TarballName = tarballs.find((entry) => entry.includes('-aw-windows-job-win32-x64-'));
    const windowsArm64TarballName = tarballs.find((entry) => entry.includes('-aw-windows-job-win32-arm64-'));
    expect(cliTarballName).toBeDefined();
    expect(evalTarballName).toBeDefined();
    expect(coreTarballName).toBeDefined();
    expect(windowsX64TarballName).toBeDefined();
    expect(windowsArm64TarballName).toBeDefined();
    const cliTarballPath = path.join(packDir, cliTarballName!);
    const evalTarballPath = path.join(packDir, evalTarballName!);
    const coreTarballPath = path.join(packDir, coreTarballName!);
    const windowsX64TarballPath = path.join(packDir, windowsX64TarballName!);
    const windowsArm64TarballPath = path.join(packDir, windowsArm64TarballName!);

    return {
      packageRoot: await unpackTarball(cliTarballPath, unpackDir),
      cliTarballPath,
      evalTarballPath,
      coreTarballPath,
      windowsX64TarballPath,
      windowsArm64TarballPath,
      tempRoot,
    };
  })();
  return packedCliPromise;
}

async function createExternalNativeCliFixture(tempRoot: string): Promise<string> {
  const nativeBin = path.join(tempRoot, 'external-native-bin');
  await fs.ensureDir(nativeBin);

  const claudeScript = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };",
    "const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\\n'); };",
    "const home = process.env.AW_CLAUDE_HOME;",
    "if (args[0] === '--version') { console.log('2.1.88'); process.exit(0); }",
    "if (!home) { console.error('AW_CLAUDE_HOME is required'); process.exit(2); }",
    "const scope = args.includes('--scope') ? args[args.indexOf('--scope') + 1] : 'user';",
    "const projectPath = fs.realpathSync(process.cwd());",
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
    "if (args[0] === '--version') { console.log('codex-cli 0.151.0'); process.exit(0); }",
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
    "  const header = `[projects.${JSON.stringify(fs.realpathSync(cwd))}]`;",
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
    "  const manifest = readJson(path.join(sourceRoot, '.agents-plugin', 'plugin.json'), {});",
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
    await fs.ensureDir(path.dirname(codexLauncher));
    await Promise.all([
      fs.writeFile(path.join(nativeBin, 'claude.cjs'), claudeScript, 'utf8'),
      fs.writeFile(path.join(nativeBin, 'claude.cmd'), '@node "%~dp0\\claude.cjs" %*\r\n', 'utf8'),
      fs.writeFile(
        path.join(nativeBin, 'codex.cmd'),
        '@node "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
        'utf8',
      ),
      fs.writeJson(path.join(codexPackageRoot, 'package.json'), {
        name: '@openai/codex',
        version: '0.151.0',
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
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('pack smoke', () => {
  it('packs one Windows Job helper in each platform tarball and none in Eval', async () => {
    const { evalTarballPath, windowsX64TarballPath, windowsArm64TarballPath } = await preparePackedCli();
    const platformUnpackRoot = await createSmokeTempRoot(
      'aw-platform-pack-smoke-',
      'platform package smoke unpack root',
    );
    const x64UnpackRoot = path.join(platformUnpackRoot, 'x64');
    const arm64UnpackRoot = path.join(platformUnpackRoot, 'arm64');
    await Promise.all([fs.ensureDir(x64UnpackRoot), fs.ensureDir(arm64UnpackRoot)]);
    const [{ stdout: evalEntries }, { stdout: x64Entries }, { stdout: arm64Entries }] = await Promise.all([
      execFileAsync('tar', ['-tzf', evalTarballPath], { maxBuffer: 20 * 1024 * 1024 }),
      execFileAsync('tar', ['-tzf', windowsX64TarballPath], { maxBuffer: 20 * 1024 * 1024 }),
      execFileAsync('tar', ['-tzf', windowsArm64TarballPath], { maxBuffer: 20 * 1024 * 1024 }),
    ]);
    expect(evalEntries).not.toContain('aw-windows-job.exe');
    const expectedEntries = new Set([
      'package/dist/aw-windows-job.exe',
      'package/package.json',
    ]);
    expect(new Set(x64Entries.trim().split('\n'))).toEqual(expectedEntries);
    expect(new Set(arm64Entries.trim().split('\n'))).toEqual(expectedEntries);

    const [x64PackageRoot, arm64PackageRoot] = await Promise.all([
      unpackTarball(windowsX64TarballPath, x64UnpackRoot),
      unpackTarball(windowsArm64TarballPath, arm64UnpackRoot),
    ]);
    for (const [arch, packageRoot, machine] of [
      ['x64', x64PackageRoot, 0x8664],
      ['arm64', arm64PackageRoot, 0xaa64],
    ] as const) {
      await expect(fs.readJson(path.join(packageRoot, 'package.json'))).resolves.toMatchObject({
        name: `@lesliechan721/aw-windows-job-win32-${arch}`,
        os: ['win32'],
        cpu: [arch],
        exports: { './aw-windows-job.exe': './dist/aw-windows-job.exe' },
      });
      const bytes = await fs.readFile(path.join(packageRoot, 'dist', 'aw-windows-job.exe'));
      expect(bytes.subarray(0, 2).toString('ascii')).toBe('MZ');
      const peOffset = bytes.readUInt32LE(0x3c);
      expect(bytes.subarray(peOffset, peOffset + 4).toString('ascii')).toBe('PE\0\0');
      expect(bytes.readUInt16LE(peOffset + 4)).toBe(machine);
    }
  }, 300_000);

  it('runs external authoring workflow from installed tarballs', async () => {
    const { packageRoot, cliTarballPath, evalTarballPath, coreTarballPath, tempRoot } = await preparePackedCli();
    const installPrefix = path.join(tempRoot, 'install-prefix');
    registerSmokeWritableRoot(installPrefix, 'pack smoke clean npm install prefix');
    await fs.ensureDir(installPrefix);
    const { NODE_PATH: _ignoredNodePath, ...envWithoutNodePath } = process.env;

    await execFileAsync(
      'npm',
      [
        'install',
        '--global',
        '--omit=optional',
        '--prefix',
        installPrefix,
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

    const externalNativeBin = await createExternalNativeCliFixture(tempRoot);
    const externalAuthoringEnv = {
      ...envWithoutNodePath,
      AW_HOME: path.join(tempRoot, 'external-aw-home'),
      AW_CODEX_HOME: path.join(tempRoot, 'external-codex-home'),
      AW_CLAUDE_HOME: path.join(tempRoot, 'external-claude-home'),
      PATH: `${externalNativeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    await Promise.all([
      fs.ensureDir(externalAuthoringEnv.AW_HOME),
      fs.ensureDir(externalAuthoringEnv.AW_CODEX_HOME),
      fs.ensureDir(externalAuthoringEnv.AW_CLAUDE_HOME),
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
    const installedCodexManagerImport = pathToFileURL(path.join(
      globalNodeModules,
      '@lesliechan721',
      'aw',
      'dist',
      'src',
      'utils',
      'codex-manager.js',
    )).href;
    const installedRuntimeHome = path.join(tempRoot, 'installed-manager-aw-home');
    const installedManagerProbe = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          'const { resolveCodexManager } = await import(process.argv[1]);',
          'let pnpmEntry;',
          'try {',
          '  await resolveCodexManager({',
          "    env: { ...process.env, AW_HOME: process.argv[2], PATH: '' },",
          '    authorizer: async () => true,',
          '    runner: async (invocation) => {',
          '      pnpmEntry = invocation.args[0];',
          "      return { exitCode: 1, stdout: '', stderr: '' };",
          '    },',
          '  });',
          '} catch (error) {',
          "  if (error?.code !== 'managedCodexUnavailable') throw error;",
          '}',
          "if (!pnpmEntry) throw new Error('The installed CLI did not resolve pnpm.');",
          'console.log(JSON.stringify({ pnpmEntry }));',
        ].join('\n'),
        installedCodexManagerImport,
        installedRuntimeHome,
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
    const installedPnpmEntry = (JSON.parse(installedManagerProbe.stdout) as {
      pnpmEntry: string;
    }).pnpmEntry;
    await expect(fs.pathExists(installedPnpmEntry)).resolves.toBe(true);
    expect(path.relative(globalNodeModules, installedPnpmEntry).startsWith(`..${path.sep}`)).toBe(false);
    expect(path.relative(repoRoot(), installedPnpmEntry).startsWith(`..${path.sep}`)).toBe(true);
    expect(installedPnpmEntry).toContain(`${path.sep}pnpm${path.sep}`);

    const parentWorkspace = path.join(tempRoot, 'managed-runtime-parent-workspace');
    const managedRuntimeHome = path.join(parentWorkspace, 'state', 'aw-home');
    const localCodexFixture = path.join(tempRoot, 'local-managed-codex');
    const localCodexPack = path.join(tempRoot, 'local-managed-codex-pack');
    const parentLockfile = path.join(parentWorkspace, 'pnpm-lock.yaml');
    const parentMarker = path.join(parentWorkspace, 'workspace.marker');
    const parentNodeModules = path.join(parentWorkspace, 'node_modules');
    const workspaceAppNodeModules = path.join(
      parentWorkspace,
      'packages',
      'workspace-app',
      'node_modules',
    );
    await Promise.all([
      fs.outputJson(path.join(parentWorkspace, 'package.json'), {
        name: 'managed-runtime-parent-workspace',
        private: true,
      }),
      fs.outputFile(
        path.join(parentWorkspace, 'pnpm-workspace.yaml'),
        "packages:\n  - 'packages/*'\n  - 'state/**'\n",
      ),
      fs.outputJson(path.join(parentWorkspace, 'packages', 'workspace-app', 'package.json'), {
        name: 'workspace-app',
        private: true,
        dependencies: { 'workspace-marker-package': 'workspace:*' },
      }),
      fs.outputJson(path.join(parentWorkspace, 'packages', 'workspace-marker', 'package.json'), {
        name: 'workspace-marker-package',
        version: '1.0.0',
      }),
      fs.outputJson(path.join(localCodexFixture, 'package.json'), {
        name: '@openai/codex',
        version: '0.151.0',
        bin: { codex: 'bin/codex.js' },
      }),
      fs.outputFile(path.join(localCodexFixture, 'bin', 'codex.js'), [
        "const args = process.argv.slice(2);",
        "if (args.length === 1 && args[0] === '--version') { console.log('codex-cli 0.151.0'); process.exit(0); }",
        "if (args[0] === 'plugin' && args[1] === '--help') { console.log('plugin help'); process.exit(0); }",
        'process.exit(2);',
      ].join('\n')),
      fs.outputFile(parentLockfile, [
        "lockfileVersion: '9.0'",
        '',
        'settings:',
        '  autoInstallPeers: true',
        '  excludeLinksFromLockfile: false',
        '',
        'importers:',
        '',
        '  .: {}',
        '',
      ].join('\n')),
      fs.outputFile(parentMarker, 'parent-workspace-marker\n'),
      fs.outputFile(path.join(parentNodeModules, 'parent-node-modules.marker'), 'unchanged\n'),
      fs.ensureDir(localCodexPack),
      fs.ensureDir(path.dirname(managedRuntimeHome)),
    ]);
    await execFileAsync('npm', ['pack', '--pack-destination', localCodexPack], {
      cwd: localCodexFixture,
      env: envWithoutNodePath,
    });
    const localCodexTarball = path.join(
      localCodexPack,
      (await fs.readdir(localCodexPack)).find((entry) => entry.endsWith('.tgz'))!,
    );
    const parentLockfileBefore = await fs.readFile(parentLockfile, 'utf8');
    const parentMarkerBefore = await fs.readFile(parentMarker, 'utf8');
    const parentNodeModulesBefore = await listFilesRecursively(parentNodeModules);
    const managedRuntimeResult = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "import fs from 'node:fs/promises';",
          "import { execFile } from 'node:child_process';",
          "import path from 'node:path';",
          "import { promisify } from 'node:util';",
          'const execFileAsync = promisify(execFile);',
          'const { resolveCodexManager } = await import(process.argv[1]);',
          'const awHome = process.argv[2];',
          'const fixtureTarball = process.argv[3];',
          'let pnpmEntry;',
          'const runner = async (invocation) => {',
          "  if (invocation.args[1] === 'install') {",
          '    pnpmEntry = invocation.args[0];',
          "    const packageJsonPath = path.join(invocation.cwd, 'package.json');",
          "    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));",
          "    if (packageJson.dependencies?.['@openai/codex'] !== '0.151.0') throw new Error('Unexpected managed Codex dependency.');",
          "    packageJson.dependencies['@openai/codex'] = `file:${fixtureTarball}`;",
          "    await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\\n`);",
          '  }',
          '  try {',
          '    const result = await execFileAsync(invocation.command, invocation.args, {',
          '      cwd: invocation.cwd, env: invocation.env, maxBuffer: 10 * 1024 * 1024,',
          '    });',
          "    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };",
          '  } catch (error) {',
          "    return { exitCode: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) };",
          '  }',
          '};',
          'const manager = await resolveCodexManager({',
          "  env: { ...process.env, AW_HOME: awHome, PATH: '' },",
          '  authorizer: async () => true,',
          '  runner,',
          '});',
          'console.log(JSON.stringify({ manager, pnpmEntry }));',
        ].join('\n'),
        installedCodexManagerImport,
        managedRuntimeHome,
        localCodexTarball,
      ],
      {
        cwd: parentWorkspace,
        env: {
          ...envWithoutNodePath,
          HOME: path.join(tempRoot, 'managed-runtime-home'),
        },
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const managedRuntime = JSON.parse(managedRuntimeResult.stdout) as {
      manager: { kind: string; runtimeRoot: string };
      pnpmEntry: string;
    };
    const expectedRuntimeRoot = path.join(
      managedRuntimeHome,
      'runtimes',
      'codex',
      '0.151.0',
      `${process.platform}-${process.arch}`,
    );
    expect(managedRuntime).toEqual({
      manager: expect.objectContaining({
        kind: 'aw-managed',
        runtimeRoot: expectedRuntimeRoot,
      }),
      pnpmEntry: installedPnpmEntry,
    });
    await expect(fs.readJson(path.join(
      expectedRuntimeRoot,
      'node_modules',
      '@openai',
      'codex',
      'package.json',
    ))).resolves.toMatchObject({ name: '@openai/codex', version: '0.151.0' });
    await expect(fs.readFile(parentLockfile, 'utf8')).resolves.toBe(parentLockfileBefore);
    await expect(fs.readFile(parentMarker, 'utf8')).resolves.toBe(parentMarkerBefore);
    await expect(listFilesRecursively(parentNodeModules)).resolves.toEqual(parentNodeModulesBefore);
    await expect(fs.pathExists(workspaceAppNodeModules)).resolves.toBe(false);

    await expect(execFileAsync(awBin, ['--version'], {
      cwd: tempRoot,
      env: externalAuthoringEnv,
    })).resolves.toMatchObject({ stdout: `${cliPackageJson.version}\n`, stderr: '' });
    await expect(execFileAsync(awBin, ['plugin', '--help'], {
      cwd: tempRoot,
      env: externalAuthoringEnv,
    })).resolves.toMatchObject({
      stdout: expect.stringMatching(/(?=[\s\S]*status)(?=[\s\S]*test)(?=[\s\S]*build)/u),
      stderr: '',
    });
    await expect(execFileAsync(awBin, ['catalog', '--help'], {
      cwd: tempRoot,
      env: externalAuthoringEnv,
    })).resolves.toMatchObject({
      stdout: expect.stringMatching(/init[\s\S]*version[\s\S]*build[\s\S]*validate[\s\S]*publish/u),
      stderr: '',
    });
    const capabilities = await execFileAsync(awBin, ['self', 'describe', '--json'], {
      cwd: tempRoot, env: externalAuthoringEnv,
    });
    expect(JSON.parse(capabilities.stdout).capabilities).toContain('aw.project-recovery.v1');
    for (const projectCommand of [
      ['project', '--help'], ['project', 'status', '--help'], ['project', 'targets', 'set', '--help'],
    ]) {
      await expect(execFileAsync(awBin, projectCommand, {
        cwd: tempRoot, env: externalAuthoringEnv,
      })).resolves.toMatchObject({ stderr: '' });
    }

    const standaloneWorkspace = path.join(tempRoot, 'standalone-workspace');
    registerSmokeWritableRoot(standaloneWorkspace, 'packed CLI standalone author workspace');
    await fs.ensureDir(standaloneWorkspace);
    await expect(fs.pathExists(path.join(standaloneWorkspace, 'node_modules'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(standaloneWorkspace, 'packages', 'cli'))).resolves.toBe(false);
    await execFileAsync(awBin, [
      'catalog', 'init', '--workspace-root', standaloneWorkspace,
      '--owner-url', 'https://catalog.example.com/packed-build',
    ], {
      cwd: standaloneWorkspace,
      env: externalAuthoringEnv,
    });
    await execFileAsync(awBin, [
      'plugin', 'init', 'packed-build',
      '--description', 'Packed build fixture.',
      '--no-skills', '--with-mcp',
      '--workspace-root', standaloneWorkspace,
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    const packedPluginDirectory = path.join('plugins', 'packed-build');
    await expect(execFileAsync(awBin, [
      'plugin', 'validate', packedPluginDirectory,
      '--workspace-root', standaloneWorkspace, '--json',
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv })).resolves.toMatchObject({
      stdout: expect.stringMatching(/"ok":\s*true/u),
      stderr: '',
    });
    await expect(execFileAsync(awBin, [
      'plugin', 'test', packedPluginDirectory,
      '--workspace-root', standaloneWorkspace, '--json',
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv })).resolves.toMatchObject({
      stdout: expect.stringMatching(/"ok":\s*true/u),
      stderr: '',
    });
    await execFileAsync(awBin, [
      'plugin', 'build', packedPluginDirectory,
      '--workspace-root', standaloneWorkspace,
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    await execFileAsync(awBin, [
      'catalog', 'build', '--workspace-root', standaloneWorkspace,
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    await expect(execFileAsync(awBin, [
      'catalog', 'validate', path.join(standaloneWorkspace, '.aw', 'catalog'), '--json',
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv })).resolves.toMatchObject({
      stdout: expect.stringMatching(/"ok":\s*true/u),
      stderr: '',
    });
    const externalPathSource = await execFileAsync(awBin, [
      'catalog', 'dev', 'activate', '--workspace-root', standaloneWorkspace, '--primary', '--json',
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    const developmentSourceReceipt = JSON.parse(externalPathSource.stdout);
    expect(developmentSourceReceipt).toMatchObject({
      command: 'catalog:dev:activate', ok: true,
      snapshot: { action: 'reused' },
      source: { action: 'added', primary: true },
    });
    const developmentSourceId = developmentSourceReceipt.source.id as string;
    const projectInstallBeforeTrust = await execFileAsync(awBin, [
      'install', `${developmentSourceId}/packed-build`, '-p', 'codex', '--scope', 'project', '--json',
    ], {
      cwd: standaloneWorkspace,
      env: externalAuthoringEnv,
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(JSON.parse(projectInstallBeforeTrust.stdout)).toMatchObject({
      schemaVersion: 1,
      kind: 'aw-project-recovery',
      ok: true,
      command: 'install',
      intent: { state: 'valid', roots: [`${developmentSourceId}/packed-build`] },
      selection: { agents: ['codex'], origin: 'argument' },
      declarationChanged: true,
      targetResults: expect.arrayContaining([expect.objectContaining({
        pluginId: `${developmentSourceId}/packed-build`,
        agent: 'codex',
        delivery: { kind: 'native', platform: 'codex' },
        observation: 'verified',
      })]),
    });
    const projectConfigBeforeTrust = await fs.readFile(
      path.join(standaloneWorkspace, '.codex', 'config.toml'),
      'utf8',
    );
    expect(projectConfigBeforeTrust).toContain('[plugins."packed-build@aw"]');
    expect(projectConfigBeforeTrust).toContain('enabled = true');
    await fs.appendFile(path.join(externalAuthoringEnv.AW_CODEX_HOME, 'config.toml'), [
      '',
      `[projects.${JSON.stringify(await fs.realpath(standaloneWorkspace))}]`,
      'trust_level = "trusted"',
      '',
    ].join('\n'));
    const externalInstall = await execFileAsync(awBin, [
      'install', `${developmentSourceId}/packed-build`, '-p', 'both', '--scope', 'project', '--json',
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv, maxBuffer: 10 * 1024 * 1024 }).catch((error: unknown) => {
      const failure = error as { stdout?: string; stderr?: string };
      throw new Error(`Packed project install failed. stdout=${failure.stdout ?? ''} stderr=${failure.stderr ?? ''}`);
    });
    expect(JSON.parse(externalInstall.stdout)).toMatchObject({
      schemaVersion: 1,
      kind: 'aw-project-recovery',
      ok: true,
      command: 'install',
      intent: { state: 'valid', roots: [`${developmentSourceId}/packed-build`] },
      selection: { agents: expect.arrayContaining(['codex', 'claude-code']), origin: 'argument' },
      declarationChanged: false,
      targetResults: expect.arrayContaining([
        expect.objectContaining({
          pluginId: `${developmentSourceId}/packed-build`, agent: 'codex',
          delivery: { kind: 'native', platform: 'codex' }, observation: 'verified',
        }),
        expect.objectContaining({
          pluginId: `${developmentSourceId}/packed-build`, agent: 'claude-code',
          delivery: { kind: 'native', platform: 'claude' }, observation: 'verified',
        }),
      ]),
    });
    const projectCodexConfig = await fs.readFile(
      path.join(standaloneWorkspace, '.codex', 'config.toml'),
      'utf8',
    );
    expect(projectCodexConfig).toContain('[plugins."packed-build@aw"]');
    expect(projectCodexConfig).not.toContain('mcp_servers');
    await expect(fs.pathExists(path.join(standaloneWorkspace, '.codex', 'hooks.json')))
      .resolves.toBe(false);
    await expect(fs.pathExists(path.join(
      externalAuthoringEnv.AW_CODEX_HOME,
      'plugins',
      'cache',
      'aw',
      'packed-build',
      '0.1.0',
      '.codex-plugin',
      'plugin.json',
    ))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(standaloneWorkspace, '.claude', 'settings.json'))).resolves.toBe(true);
    await expect(fs.readJson(path.join(externalAuthoringEnv.AW_HOME, 'catalog-sources.json')))
      .resolves.toMatchObject({
        schemaVersion: 2,
        sources: expect.arrayContaining([expect.objectContaining({
          id: developmentSourceId,
          type: 'path',
          managedBy: expect.objectContaining({ kind: 'catalog-workspace' }),
        })]),
      });
    const claudeInstalledPlugins = await fs.readJson(
      path.join(externalAuthoringEnv.AW_CLAUDE_HOME, 'plugins', 'installed_plugins.json'),
    ) as { plugins: Record<string, Array<Record<string, unknown>>> };
    expect(Object.values(claudeInstalledPlugins.plugins).flat()).toContainEqual(expect.objectContaining({
      name: 'packed-build',
      scope: 'project',
      projectPath: await fs.realpath(standaloneWorkspace),
    }));
    const developmentSourceRemoval = await execFileAsync(awBin, [
      'catalog', 'dev', 'deactivate', '--workspace-root', standaloneWorkspace, '--yes', '--json',
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    expect(JSON.parse(developmentSourceRemoval.stdout)).toMatchObject({
      receiptSchemaVersion: 4,
      command: 'catalog:dev:deactivate', ok: true,
      source: { id: developmentSourceId, action: 'removed', previousPrimary: true },
      replacementPrimarySourceId: 'official',
      impact: {
        inventorySchemaVersion: 2,
        primaryChange: { fromSourceId: developmentSourceId, toSourceId: 'official' },
        inventoryComplete: true,
        references: expect.arrayContaining([expect.objectContaining({
          category: 'installation',
          sourceId: developmentSourceId,
          pluginId: `${developmentSourceId}/packed-build`,
          scope: 'project',
          projectRecord: 'current',
        })]),
        errors: [],
      },
    });
    await expect(fs.pathExists(path.join(standaloneWorkspace, '.aw', 'catalog'))).resolves.toBe(true);
    const packedCatalogRemote = path.join(tempRoot, 'packed-catalog.git');
    registerSmokeWritableRoot(packedCatalogRemote, 'packed CLI Catalog publication remote');
    await execFileAsync('git', ['init', '--bare', packedCatalogRemote], { env: process.env });
    await execFileAsync('git', ['init'], { cwd: standaloneWorkspace, env: process.env });
    await execFileAsync('git', ['add', '.'], { cwd: standaloneWorkspace, env: process.env });
    await execFileAsync('git', [
      '-c', 'user.name=Pack Smoke', '-c', 'user.email=pack-smoke@example.invalid',
      'commit', '-m', 'packed Catalog source',
    ], { cwd: standaloneWorkspace, env: process.env });
    await execFileAsync('git', ['remote', 'add', 'origin', packedCatalogRemote], {
      cwd: standaloneWorkspace,
      env: process.env,
    });
    const packedPlan = await execFileAsync(awBin, [
      'catalog', 'publish', 'plan', '--workspace-root', standaloneWorkspace,
      '--remote', 'origin', '--branch', 'catalog', '--json',
    ], { cwd: standaloneWorkspace, env: process.env });
    const packedPlanDigest = JSON.parse(packedPlan.stdout).planDigest;
    const packedPublish = await execFileAsync(awBin, [
      'catalog', 'publish', 'apply', '--workspace-root', standaloneWorkspace,
      '--remote', 'origin', '--branch', 'catalog',
      '--expected-plan-digest', packedPlanDigest, '--yes', '--json',
    ], { cwd: standaloneWorkspace, env: process.env });
    const packedPublishReceipt = JSON.parse(packedPublish.stdout) as { ok: boolean; commit: string };
    expect(packedPublishReceipt.ok).toBe(true);
    expect((await execFileAsync('git', [
      '--git-dir', packedCatalogRemote, 'rev-parse', 'refs/heads/catalog',
    ], { env: process.env })).stdout.trim()).toBe(packedPublishReceipt.commit);
    expect((await execFileAsync('git', [
      '--git-dir', packedCatalogRemote, 'rev-parse', 'refs/tags/catalog-v0.1.0^{}',
    ], { env: process.env })).stdout.trim()).toBe(packedPublishReceipt.commit);
    const packedConsumerEnv = {
      ...process.env,
      AW_HOME: path.join(tempRoot, 'packed-catalog-consumer-home'),
    };
    const sourceAdd = await execFileAsync(awBin, [
      'catalog', 'source', 'add', 'packed', '--git', packedCatalogRemote,
      '--ref', 'refs/heads/catalog', '--primary', '--json',
    ], { cwd: tempRoot, env: packedConsumerEnv });
    expect(JSON.parse(sourceAdd.stdout)).toMatchObject({ ok: true, sourceId: 'packed' });
    const sourceSync = await execFileAsync(awBin, [
      'catalog', 'source', 'sync', 'packed', '--json',
    ], { cwd: tempRoot, env: packedConsumerEnv });
    expect(JSON.parse(sourceSync.stdout)).toMatchObject({
      command: 'catalog:source:sync',
      ok: true,
      sourceId: 'packed',
      mode: 'sync',
      outcome: 'activated',
      activeChanged: true,
      active: { snapshotDigest: expect.stringMatching(/^sha256:/u) },
    });
    expect(sourceSync.stderr).toBe('');
    const consumedStatus = await execFileAsync(
      awBin,
      ['status', 'packed/packed-build', '--json'],
      { cwd: tempRoot, env: packedConsumerEnv },
    ).then(
      () => null,
      (error: unknown) => error as { stdout?: string },
    );
    expect(consumedStatus).not.toBeNull();
    expect(JSON.parse(consumedStatus?.stdout ?? '{}')).toMatchObject({
      catalog: { sources: expect.arrayContaining([expect.objectContaining({ id: 'packed' })]) },
      targets: expect.arrayContaining([expect.objectContaining({
        pluginId: 'packed/packed-build',
      })]),
    });
    const packedRemoval = await execFileAsync(awBin, [
      'plugin', 'remove', 'packed-build',
      '--workspace-root', standaloneWorkspace, '--yes', '--json',
    ], { cwd: standaloneWorkspace, env: externalAuthoringEnv });
    expect(JSON.parse(packedRemoval.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'plugin:remove',
      ok: true,
      plugin: { name: 'packed-build', version: '0.1.0' },
      removed: true,
      errors: [],
    });
    expect(packedRemoval.stderr).toBe('');
    await expect(fs.pathExists(path.join(standaloneWorkspace, 'plugins', 'packed-build')))
      .resolves.toBe(false);

    const authorRepo = path.join(tempRoot, 'author-repo');
    registerSmokeWritableRoot(authorRepo, 'pack smoke plugin author repository');
    await fs.copy(fixturePath('repo-template'), authorRepo);
    await execFileAsync(awBin, [
      'plugin',
      'init',
      'validate-fixture',
      '--description',
      'A deterministic fixture for the packed CLI validator.',
      '--no-skills',
      '--workspace-root',
      authorRepo,
    ], { cwd: authorRepo, env: process.env });
    const validation = await execFileAsync(awBin, [
      'plugin',
      'validate',
      path.join(authorRepo, 'plugins', 'validate-fixture'),
      '--json',
    ], { cwd: authorRepo, env: process.env });
    expect(JSON.parse(validation.stdout)).toMatchObject({
      ok: true,
      profile: 'aw-source',
    });
    expect(validation.stderr).toBe('');

    const portablePluginRoot = path.join(authorRepo, 'plugins', 'validate-fixture');
    const portableManifestPath = path.join(portablePluginRoot, '.agents-plugin', 'plugin.json');
    const portableManifest = await fs.readJson(portableManifestPath);
    portableManifest.extensions = {
      instructions: [{ name: 'native', title: 'Native surface', content: 'Native.' }],
    };
    portableManifest.distributions = { agentSkills: { skills: './portable-skills' } };
    await fs.writeJson(portableManifestPath, portableManifest, { spaces: 2 });
    await fs.outputFile(
      path.join(portablePluginRoot, 'portable-skills', 'packed-portable', 'SKILL.md'),
      '---\nname: packed-portable\ndescription: Packed portable validator fixture.\n---\n\n# Packed portable\n',
    );
    await fs.outputFile(
      path.join(portablePluginRoot, 'portable-skills', 'packed-portable', 'README.md'),
      '# Packed portable fixture\n',
    );
    const portableValidation = await execFileAsync(awBin, [
      'plugin',
      'validate',
      portablePluginRoot,
      '--json',
    ], { cwd: authorRepo, env: process.env });
    expect(JSON.parse(portableValidation.stdout)).toMatchObject({ ok: true });

    const portableCatalog = path.join(tempRoot, 'portable-path-catalog');
    await Promise.all([
      fs.outputFile(
        path.join(portableCatalog, 'plugins', 'portable-pack', 'agent-skills', 'skills', 'packed-portable', 'SKILL.md'),
        '---\nname: packed-portable\ndescription: Installed tarball command fixture.\n---\n\n# Packed portable\n',
      ),
      fs.outputFile(
        path.join(portableCatalog, 'plugins', 'portable-pack', 'agent-skills', 'skills', 'packed-portable', 'README.md'),
        '# Installed tarball command fixture\n',
      ),
    ]);
    await createCatalogSnapshotFixture(
      portableCatalog,
      'portable-pack',
      [],
      '# Portable pack plugin\n',
      (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'native', title: 'Native surface', content: 'Native.' }],
        };
        manifest.distributions = { agentSkills: { skills: './agent-skills/skills' } };
      },
    );
    const catalogPortablePluginRoot = path.join(portableCatalog, 'plugins', 'portable-pack');
    const portablePlugin = await readPluginManifest(catalogPortablePluginRoot, { mode: 'bundle' });
    await fs.outputJson(
      path.join(
        catalogPortablePluginRoot,
        'agent-skills',
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
    const fakeBin = path.join(tempRoot, 'fake-skills-bin');
    const fakeLog = path.join(tempRoot, 'fake-skills-log.jsonl');
    const fakeState = path.join(tempRoot, 'fake-skills-added');
    const materializedOut = path.join(tempRoot, 'materialized-portable');
    await Promise.all([
      fs.ensureDir(portableCwd),
      fs.ensureDir(fakeBin),
      fs.outputJson(path.join(portableHome, 'catalog-sources.json'), {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: portableCatalog }],
      }),
    ]);
    const fakeSkills = path.join(fakeBin, process.platform === 'win32' ? 'skills.cmd' : 'skills');
    if (process.platform === 'win32') {
      await fs.writeFile(fakeSkills, '@node "%~dp0\\skills.cjs" %*\r\n', 'utf8');
    }
    const fakeSkillsScript = process.platform === 'win32'
      ? path.join(fakeBin, 'skills.cjs')
      : fakeSkills;
    await fs.writeFile(fakeSkillsScript, [
      ...(process.platform === 'win32' ? [] : ['#!/usr/bin/env node']),
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.FAKE_SKILLS_LOG, JSON.stringify(args) + '\\n');",
      "if (args[0] === '--version') { console.log('1.5.23'); process.exit(0); }",
      "if (args[0] === 'add') { fs.writeFileSync(process.env.FAKE_SKILLS_STATE, 'added'); process.exit(0); }",
      "if (args[0] === 'list') { console.log(fs.existsSync(process.env.FAKE_SKILLS_STATE) ? JSON.stringify([{name:'packed-portable',agents:['Codex'],scope:'project',path:'/fake/packed-portable'}]) : '[]'); process.exit(0); }",
      'process.exit(2);',
    ].join('\n'), 'utf8');
    if (process.platform !== 'win32') await fs.chmod(fakeSkills, 0o755);
    const portableEnv = {
      ...process.env,
      AW_HOME: portableHome,
      AW_CODEX_HOME: path.join(tempRoot, 'portable-codex-home'),
      AW_CLAUDE_HOME: path.join(tempRoot, 'portable-claude-home'),
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_SKILLS_LOG: fakeLog,
      FAKE_SKILLS_STATE: fakeState,
    };
    const portableSourceSync = await execFileAsync(awBin, [
      'catalog', 'source', 'sync', 'local', '--json',
    ], { cwd: portableCwd, env: portableEnv });
    expect(JSON.parse(portableSourceSync.stdout)).toMatchObject({
      command: 'catalog:source:sync',
      ok: true,
      sourceId: 'local',
      mode: 'sync',
      outcome: 'activated',
      activeChanged: true,
      active: { snapshotDigest: expect.stringMatching(/^sha256:/u) },
    });
    expect(portableSourceSync.stderr).toBe('');
    await execFileAsync(awBin, [
      'skill', 'materialize', 'local/portable-pack',
      '--scope', 'project', '--out', materializedOut,
    ], { cwd: portableCwd, env: portableEnv });
    await expect(fs.readJson(path.join(materializedOut, '.aw-materialization.json')))
      .resolves.toMatchObject({
        schemaVersion: 1,
        plugin: { id: 'local/portable-pack', version: '1.0.0' },
        scope: 'project',
      });

    const installed = await execFileAsync(awBin, [
      'skill', 'install', 'local/portable-pack', '--scope', 'project', '--yes', '--json',
    ], { cwd: portableCwd, env: portableEnv, maxBuffer: 10 * 1024 * 1024 });
    expect(JSON.parse(installed.stdout)).toMatchObject({
      ok: true,
      status: 'succeeded',
      selectedSkills: [{ name: 'packed-portable', providerPluginId: 'local/portable-pack' }],
    });
    const fakeCalls = (await fs.readFile(fakeLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(fakeCalls).toContainEqual(['--version']);
    expect(fakeCalls).toContainEqual(['list', '--json']);
    expect(fakeCalls).toContainEqual(expect.arrayContaining([
      'add', '--skill', 'packed-portable', '--yes',
    ]));

    await execFileAsync(awBin, [
      'plugin',
      'init',
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
    await expect(execFileAsync(awBin, [
      'plugin',
      'validate',
      path.join('plugins', 'author-smoke'),
      '--workspace-root',
      authorRepo,
      '--json',
    ], { cwd: authorRepo, env: externalAuthoringEnv })).resolves.toMatchObject({
      stdout: expect.stringMatching(/"ok":\s*true/u),
      stderr: '',
    });
    const buildReceipt = await execFileAsync(awBin, [
      'plugin',
      'build',
      path.join('plugins', 'author-smoke'),
      '--workspace-root',
      authorRepo,
      '--json',
    ], { cwd: authorRepo, env: externalAuthoringEnv });
    const builtHelperPath = path.join(JSON.parse(buildReceipt.stdout).outputRoot, 'scripts', 'aw-config.mjs');
    await expect(fs.pathExists(path.join(
      path.dirname(builtHelperPath),
      're2-wasm',
    ))).resolves.toBe(false);
    const helperHelp = await execFileAsync(process.execPath, [builtHelperPath, '--help'], {
      cwd: authorRepo,
      env: externalAuthoringEnv,
    });
    expect(helperHelp.stdout).toContain('--scope effective');
    expect(helperHelp.stderr).toBe('');
    await execFileAsync(awBin, [
      'plugin',
      'add-skill',
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
    const evalHelp = await execFileAsync(evalBin, ['--help'], {
      cwd: tempRoot,
      env: process.env,
    });
    expect(evalHelp.stdout).toContain('spec validate <spec.json>');
    expect(evalHelp.stdout).toContain('audit validate <audit.json> --spec <spec.json>');
    expect(evalHelp.stdout).toContain('result validate <result.json> --spec <spec.json> --audit <audit.json>');
    expect(evalHelp.stdout).not.toContain('capabilities');
    expect(evalHelp.stderr).toBe('');

    if (process.platform !== 'win32') {
      const installedEvalRoot = path.join(
        installPrefix,
        'lib',
        'node_modules',
        '@lesliechan721',
        'agent-skill-eval',
      );
      expect((await fs.lstat(installedEvalRoot)).isSymbolicLink()).toBe(false);
    }
  }, 300_000);

  it('packs the CLI tarball without the staged plugins-dist snapshot', async () => {
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
    await expect(execFileAsync(
      process.execPath,
      [path.join(unpackedPackageRoot, 'dist', 'index.js'), '--version'],
      {
        cwd: unpackedPackageRoot,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    )).resolves.toMatchObject({
      stdout: `${unpackedPackageJson.version}\n`,
      stderr: '',
    });
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
  });

  it('bundles public slashCommands correctly from the unpacked tarball runtime', async () => {
    const root = repoRoot();
    const packageRoot = path.join(root, 'packages', 'cli');
    const { packageRoot: unpackedPackageRoot, tempRoot } = await preparePackedCli();
    const tempRepo = path.join(tempRoot, 'repo');
    const outputRoot = path.join(tempRoot, 'plugins-dist');
    registerSmokeWritableRoot(tempRepo, 'pack smoke slash commands repo root');
    registerSmokeWritableRoot(outputRoot, 'pack smoke slash commands output root');
    await fs.copy(fixturePath('repo-template'), tempRepo);
    await fs.copy(
      fixturePath('codex-project-repo-managed', 'plugins', 'slashCommands-only'),
      path.join(tempRepo, 'plugins', 'slash-commands-only'),
    );

    await installDeclaredDependencyOnlyView(unpackedPackageRoot, packageRoot);
    await installCurrentSmokeDistIsolationBridge(unpackedPackageRoot);

    const { bundlePlugins } = (await import(
      pathToFileURL(path.join(unpackedPackageRoot, 'dist', 'scripts', 'bundle-plugins.js')).href
    )) as { bundlePlugins: (options: { repoRoot: string; outputRoot: string }) => Promise<unknown> };
    await bundlePlugins({ repoRoot: tempRepo, outputRoot });

    const pluginRoot = path.join(outputRoot, 'plugins', 'slash-commands-only');
    await expect(
      fs.pathExists(path.join(pluginRoot, 'claude', 'commands', 'review.md')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'codex', 'skills', 'review', 'agents', 'openai.yaml')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'slash-commands', 'review.md')),
    ).resolves.toBe(false);
    await expect(
      fs.readFile(path.join(pluginRoot, 'codex', 'skills', 'review', 'SKILL.md'), 'utf8'),
    ).resolves.not.toContain('$ARGUMENTS');

    const { validateBundleLayout } = (await import(
      pathToFileURL(path.join(unpackedPackageRoot, 'dist', 'src', 'utils', 'bundle-layout.js')).href
    )) as { validateBundleLayout: (rootDir: string) => Promise<void> };
    await expect(validateBundleLayout(outputRoot)).resolves.toBeUndefined();
  });
});
