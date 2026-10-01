import path from 'node:path';

import fs from 'fs-extra';

import { readEnvironmentValue } from '../utils/state-paths.js';
import { renderNpmCmdShim, resolveWindowsPathCommand } from '../utils/windows-claude-shim.js';

function renderPnpmCmdShim(target: string, nodePath?: string): string {
  // pnpm@10.33.0 uses @zkochan/cmd-shim@7.0.0 for its Node package bins.
  return [
    '@SETLOCAL',
    ...(nodePath ? [
      '@IF NOT DEFINED NODE_PATH (',
      `  @SET "NODE_PATH=${nodePath}"`,
      ') ELSE (',
      `  @SET "NODE_PATH=${nodePath};%NODE_PATH%"`,
      ')',
    ] : []),
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*`,
    ') ELSE (',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    `  node  "%~dp0\\${target}" %*`,
    ')',
    '',
  ].join('\n');
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveSkillsNodeBin(shimPath: string): Promise<{ launcher: string; nodePath?: string }> {
  const shimStats = await fs.lstat(shimPath);
  if (!shimStats.isFile() || shimStats.isSymbolicLink()) {
    throw new Error('Skills shim 必须是普通文件。');
  }
  const content = (await fs.readFile(shimPath, 'utf8')).replaceAll('\r\n', '\n');
  const npmTarget = content.match(/"%_prog%"  "%dp0%\\([^"\r\n]+)" %\*\n$/u)?.[1];
  const pnpmTarget = content.match(/^  node  "%~dp0\\([^"\r\n]+)" %\*$/mu)?.[1];
  // Default pnpm isolated installs prepend literal NODE_PATH entries, without batch expansion.
  const nodePath = content.match(/^@SETLOCAL\n@IF NOT DEFINED NODE_PATH \(\n  @SET "NODE_PATH=([^"\r\n%!]+)"\n\) ELSE \(\n  @SET "NODE_PATH=\1;%NODE_PATH%"\n\)\n/u)?.[1];
  const target = npmTarget ?? pnpmTarget;
  if (!target || /[%!]/u.test(target)
    || content !== (npmTarget ? renderNpmCmdShim(target) : renderPnpmCmdShim(target, nodePath))) {
    throw new Error('Skills shim 不是受支持的 npm/pnpm Node 入口。');
  }
  const targetParts = target.split(/[/\\]/u);
  if (path.win32.isAbsolute(target) || targetParts.some((part) => part === '' || part === '.')
    || targetParts.slice(-2).join('/') !== 'bin/cli.mjs') {
    throw new Error('Skills shim 的 package bin 路径无效。');
  }
  const launcher = path.resolve(path.dirname(shimPath), ...targetParts);
  const packageRoot = path.dirname(path.dirname(launcher));
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const [packageStats, packageJsonStats, launcherStats, packageJson] = await Promise.all([
    fs.stat(packageRoot),
    fs.lstat(packageJsonPath),
    fs.lstat(launcher),
    fs.readJson(packageJsonPath) as Promise<{ name?: unknown; bin?: unknown }>,
  ]);
  const bin = packageJson.bin;
  const entry = bin && typeof bin === 'object' && !Array.isArray(bin)
    ? (bin as Record<string, unknown>).skills : undefined;
  // skills@1.5.23 publishes this ESM bin; never interpret the .cmd or its arguments.
  // Source: https://github.com/vercel-labs/skills/blob/v1.5.23/package.json
  if (!packageStats.isDirectory() || !packageJsonStats.isFile() || packageJsonStats.isSymbolicLink()
    || !launcherStats.isFile() || launcherStats.isSymbolicLink()
    || packageJson.name !== 'skills' || (entry !== './bin/cli.mjs' && entry !== 'bin/cli.mjs')) {
    throw new Error('Skills package 身份或 Node bin 合同无效。');
  }
  // pnpm may link the package root into its store; children must stay inside that package.
  const [canonicalRoot, canonicalManifest, canonicalLauncher] = await Promise.all([
    fs.realpath(packageRoot), fs.realpath(packageJsonPath), fs.realpath(launcher),
  ]);
  if (!isPathWithin(canonicalRoot, canonicalManifest) || !isPathWithin(canonicalRoot, canonicalLauncher)) {
    throw new Error('Skills package bin 越出 package 根目录。');
  }
  return { launcher: canonicalLauncher, ...(nodePath ? { nodePath } : {}) };
}

export async function resolveWindowsSkillsCommand(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ command: string; argsPrefix: string[]; env: NodeJS.ProcessEnv }> {
  const pathValue = readEnvironmentValue(options.env, 'PATH', 'win32');
  const resolved = pathValue
    ? await resolveWindowsPathCommand('skills', options.cwd, options.env) : undefined;
  if (!resolved) {
    throw Object.assign(new Error('PATH 中没有 Skills CLI。'), { code: 'ENOENT' });
  }
  const extension = path.extname(resolved).toLowerCase();
  if (extension === '.cmd') {
    try {
      const { launcher, nodePath } = await resolveSkillsNodeBin(resolved);
      let env = options.env;
      if (nodePath) {
        const previousNodePath = readEnvironmentValue(env, 'NODE_PATH', 'win32');
        env = { ...env, NODE_PATH: `${nodePath}${previousNodePath ? `;${previousNodePath}` : ''}` };
      }
      return { command: process.execPath, argsPrefix: [launcher], env };
    } catch (error) {
      throw new Error('Windows Skills CLI 入口不受支持；请修复或重新安装 npm/pnpm skills。', { cause: error });
    }
  }
  if (extension === '.bat') throw new Error('Windows Skills CLI 不支持 .bat 入口。');
  return { command: resolved, argsPrefix: [], env: options.env };
}
