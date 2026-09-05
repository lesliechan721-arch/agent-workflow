import path from 'node:path';

import fs from 'fs-extra';

const CLAUDE_PACKAGE_NAME = '@anthropic-ai/claude-code';

export interface WindowsClaudeCommand {
  command: string;
  argsPrefix: string[];
}

function readWindowsEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function windowsExecutableNames(command: string, env: NodeJS.ProcessEnv): string[] {
  const pathExt = readWindowsEnvironmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD';
  const supported = new Set(['.com', '.exe', '.bat', '.cmd']);
  const extensions = pathExt.split(';')
    .map((extension) => extension.trim())
    .filter((extension) => supported.has(extension.toLowerCase()));
  return [
    ...extensions.filter((extension) => ['.com', '.exe'].includes(extension.toLowerCase())),
    ...extensions.filter((extension) => ['.bat', '.cmd'].includes(extension.toLowerCase())),
  ].map((extension) => `${command}${extension}`);
}

async function resolveWindowsPathCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const pathValue = readWindowsEnvironmentValue(env, 'PATH');
  if (pathValue === undefined) return undefined;
  for (const rawEntry of pathValue.split(';')) {
    const directory = path.resolve(cwd, rawEntry.replace(/^"|"$/gu, '') || '.');
    for (const executableName of windowsExecutableNames(command, env)) {
      const candidate = path.join(directory, executableName);
      try {
        if ((await fs.stat(candidate)).isFile()) return candidate;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') continue;
        throw error;
      }
    }
  }
  return undefined;
}

function renderNpmCmdShim(target: string): string {
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
  ].join('\n');
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveClaudeNpmShim(shimPath: string): Promise<WindowsClaudeCommand> {
  const prefixRoot = path.dirname(shimPath);
  const packageRoot = path.join(prefixRoot, 'node_modules', '@anthropic-ai', 'claude-code');
  const packageJsonPath = path.join(packageRoot, 'package.json');
  try {
    const [shimStats, packageStats, packageJsonStats, shimContent, packageJson] = await Promise.all([
      fs.lstat(shimPath),
      fs.lstat(packageRoot),
      fs.lstat(packageJsonPath),
      fs.readFile(shimPath, 'utf8'),
      fs.readJson(packageJsonPath) as Promise<{ name?: unknown; bin?: unknown }>,
    ]);
    if (
      !shimStats.isFile() || shimStats.isSymbolicLink()
      || !packageStats.isDirectory() || packageStats.isSymbolicLink()
      || !packageJsonStats.isFile() || packageJsonStats.isSymbolicLink()
    ) {
      throw new Error('the shim or package tree is not regular');
    }
    const bin = packageJson.bin;
    const launcherEntry = bin && typeof bin === 'object' && !Array.isArray(bin)
      ? (bin as Record<string, unknown>).claude
      : undefined;
    const launcherParts = typeof launcherEntry === 'string'
      ? launcherEntry.split(/[/\\]/u)
      : [];
    if (
      packageJson.name !== CLAUDE_PACKAGE_NAME
      || typeof launcherEntry !== 'string'
      || launcherParts.length === 0
      || launcherParts.some((part) => part.length === 0 || part === '.' || part === '..')
      || !/\.(?:c?js)$/u.test(launcherParts.at(-1) ?? '')
    ) {
      throw new Error('the package identity or launcher contract is invalid');
    }
    const launcherPath = path.join(packageRoot, ...launcherParts);
    const launcherStats = await fs.lstat(launcherPath);
    if (!launcherStats.isFile() || launcherStats.isSymbolicLink()) {
      throw new Error('the launcher is not a regular file');
    }
    const [canonicalPrefix, canonicalPackageRoot, canonicalLauncher] = await Promise.all([
      fs.realpath(prefixRoot),
      fs.realpath(packageRoot),
      fs.realpath(launcherPath),
    ]);
    if (
      !isPathWithin(canonicalPrefix, canonicalPackageRoot)
      || !isPathWithin(canonicalPackageRoot, canonicalLauncher)
    ) {
      throw new Error('the package or launcher resolves outside its npm prefix');
    }
    const shimTarget = path.join(
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      ...launcherParts,
    ).replaceAll('/', '\\');
    if (shimContent.replaceAll('\r\n', '\n') !== renderNpmCmdShim(shimTarget)) {
      throw new Error('the shim is not the supported npm launcher');
    }
    return { command: process.execPath, argsPrefix: [canonicalLauncher] };
  } catch (error) {
    throw new Error(
      `Windows Claude launcher is unsupported: ${error instanceof Error ? error.message : 'validation failed'}.`,
      { cause: error },
    );
  }
}

export async function resolveWindowsClaudeCommand(options: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<WindowsClaudeCommand> {
  const env = options.env ?? process.env;
  const hasDirectory = /[/\\]/u.test(options.command);
  const resolved = hasDirectory
    ? options.command
    : await resolveWindowsPathCommand(options.command, options.cwd ?? process.cwd(), env);
  if (!resolved) {
    throw Object.assign(new Error('Windows Claude executable was not found on PATH.'), {
      code: 'ENOENT',
    });
  }
  const extension = path.extname(resolved).toLowerCase();
  if (extension === '.cmd') return resolveClaudeNpmShim(resolved);
  if (extension === '.bat') {
    throw new Error('Windows Claude .bat launchers are unsupported.');
  }
  return { command: resolved, argsPrefix: [] };
}
