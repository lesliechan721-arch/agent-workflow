import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from '../runtime/contracts.mjs';

export function windowsEnvironmentValue(environment, name) {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

export function windowsPowerShellEnvironment(environment) {
  // Windows PowerShell 5.1 needs a clean environment at startup even when
  // the parent process came from PowerShell 7.
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^(?:win)?psmodulepath$/i.test(name)));
}

export async function checkWindowsProbePath(target, kind = 'file') {
  let current = path.parse(target).root;
  for (const part of path.relative(current, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error) => {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail('pathMissing', 'An executable path is missing.');
      fail('executableInvalid', 'An executable path cannot be inspected.');
    });
    const directory = current !== target || kind === 'directory';
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
      fail('executableShimUnsupported', 'Windows executable and shim paths must be regular files with ordinary parent directories.');
    }
  }
  if (path.normalize(await fs.realpath(target)).toLowerCase() !== target.toLowerCase()) {
    fail('executableShimUnsupported', 'Windows executable paths cannot resolve through a link.');
  }
}

function npmShim(target, node) {
  return ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '', `IF EXIST "${node}" (`, `  SET "_prog=${node}"`, ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '', `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "${target}" %*`, ''].join('\n');
}

function pnpmShim(target, node, nodePath, nodeArgs) {
  const lines = ['@SETLOCAL'];
  if (nodePath) lines.push('@IF NOT DEFINED NODE_PATH (', `  @SET "NODE_PATH=${nodePath}"`, ') ELSE (', `  @SET "NODE_PATH=${nodePath};%NODE_PATH%"`, ')');
  lines.push(`@IF EXIST "${node}" (`, `  "${node}" ${nodeArgs} "${target}" %*`, ') ELSE (', '  @SET PATHEXT=%PATHEXT:;.JS;=;%', `  node ${nodeArgs} "${target}" %*`, ')', '');
  return lines.join('\n');
}

async function resolvePnpmPackageLink(lexical, checkPath) {
  const parts = lexical.split(path.sep);
  const packageIndex = parts.findLastIndex((part) => part.toLowerCase() === 'node_modules') + 1;
  if (!packageIndex) return;
  const binIndex = packageIndex + (parts[packageIndex]?.startsWith('@') ? 2 : 1);
  if (binIndex >= parts.length) return;
  const link = parts.slice(0, binIndex).join(path.sep);
  if (!(await fs.lstat(link).catch(() => null))?.isSymbolicLink()) return;
  // pnpm can link its package root. Every parent and the canonical package's
  // bin path must still pass the ordinary-path checks.
  await checkPath(path.dirname(link), 'directory');
  const packageRoot = await fs.realpath(link).catch(() => fail('executableShimUnsupported', 'The selected launcher package link could not be resolved.'));
  const entrypoint = path.join(packageRoot, ...parts.slice(binIndex));
  await checkPath(entrypoint);
  return { packageRoot, entrypoint, packageName: parts.slice(packageIndex, binIndex).join('/') };
}

export async function readWindowsShim(shim, {
  packageName, binName, checkPath = checkWindowsProbePath, followEntrypointLinks = false,
} = {}) {
  // Batch syntax is not executed. Only a complete known launcher and its
  // package.json bin contract can select an ordinary JavaScript entrypoint.
  await checkPath(shim);
  if ((await fs.stat(shim)).size > 65536) fail('executableShimUnsupported', 'The selected Windows launcher is too large.');
  const content = (await fs.readFile(shim, 'utf8')).replaceAll('\r\n', '\n');
  const [, prefix, target] = content.match(/"(%(?:dp0%|~dp0)\\?)([^"\r\n]*\.(?:c?js|mjs))"/) ?? [];
  const node = content.match(/^@?IF EXIST "(%(?:dp0%|~dp0)\\?node\.exe)" \($/m)?.[1];
  const nodePath = content.match(/^  @SET "NODE_PATH=([^"\n]+)"$/m)?.[1];
  const nodeArgs = content.includes('node --preserve-symlinks ') ? '--preserve-symlinks' : '';
  const npm = prefix?.startsWith('%dp0%') && node?.startsWith('%dp0%') && npmShim(prefix + target, node) === content;
  const pnpm = prefix?.startsWith('%~dp0') && node?.startsWith('%~dp0') && pnpmShim(prefix + target, node, nodePath, nodeArgs) === content;
  if (!npm && !pnpm) fail('executableShimUnsupported', 'The selected Windows launcher is not a supported npm or pnpm shim. Use a native executable or an explicit Node entrypoint.');
  if (/%|^(?:[\\/]|[A-Za-z]:)/.test(target) || /[\x00-\x1f]/.test(target)) fail('executableShimUnsupported', 'The selected launcher uses an unsupported entrypoint path.');
  const lexical = path.resolve(path.dirname(shim), target.replaceAll('\\', path.sep));
  const linkedPackage = pnpm && !followEntrypointLinks ? await resolvePnpmPackageLink(lexical, checkPath) : undefined;
  if (!linkedPackage && !followEntrypointLinks) await checkPath(lexical);
  const entrypoint = linkedPackage?.entrypoint ?? await fs.realpath(lexical).catch(() => fail('executableShimUnsupported', 'The selected launcher entrypoint is missing or unreadable.'));
  if (followEntrypointLinks) await checkPath(entrypoint);
  let directory = linkedPackage?.packageRoot ?? path.dirname(entrypoint);
  let metadata;
  let packageRoot;
  while (directory !== path.dirname(directory)) {
    try {
      const metadataPath = path.join(directory, 'package.json');
      await checkPath(metadataPath);
      metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      packageRoot = directory;
      break;
    } catch (error) { if (linkedPackage || error.code !== 'pathMissing') fail('executableShimUnsupported', 'The selected launcher package could not be verified.'); }
    directory = path.dirname(directory);
  }
  binName ??= path.basename(shim, path.extname(shim));
  const bin = typeof metadata?.bin === 'string' ? metadata.bin : metadata?.bin?.[binName];
  if (typeof metadata?.name !== 'string' || (packageName !== undefined && metadata.name !== packageName) ||
      (linkedPackage && metadata.name !== linkedPackage.packageName) || typeof bin !== 'string' ||
      path.resolve(packageRoot, bin) !== entrypoint) fail('executableShimUnsupported', 'The selected launcher does not match its package bin contract.');
  const relative = path.relative(packageRoot, entrypoint);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('executableShimUnsupported', 'The selected launcher entrypoint is outside its package.');
  return { entrypoint, nodePath, nodeArgs };
}

export function windowsShimEnvironment(shim, nodePath, source) {
  if (!nodePath) return source;
  const environment = { ...source };
  // Preserve the validated shim's Node module lookup without executing SET.
  if (nodePath.replaceAll('%~dp0', '').includes('%')) fail('executableShimUnsupported', 'The selected launcher uses unsupported environment expansion.');
  const directory = path.join(path.dirname(shim), path.sep);
  const expanded = nodePath.replaceAll('%~dp0', () => directory);
  const existing = windowsEnvironmentValue(environment, 'NODE_PATH');
  for (const name of Object.keys(environment)) if (name.toLowerCase() === 'node_path') delete environment[name];
  environment.NODE_PATH = existing ? `${expanded};${existing}` : expanded;
  return environment;
}

async function findProbeCommand(command, cwd, environment, platform) {
  if (path.isAbsolute(command) || /[/\\]/.test(command)) return path.resolve(cwd, command);
  const windows = platform === 'win32';
  const searchPath = windows ? windowsEnvironmentValue(environment, 'PATH') : environment.PATH;
  const extensions = windows && !path.extname(command) ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  let notRunnable = false;
  for (const directory of (searchPath ?? '').split(windows ? ';' : path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.resolve(cwd, directory.replace(/^"|"$/g, ''), `${command}${extension}`);
      const stat = await fs.lstat(candidate).catch(() => null);
      if (!stat || !stat.isFile() && !stat.isSymbolicLink()) continue;
      if (windows) return candidate;
      try {
        if (!(await fs.stat(candidate)).isFile()) continue;
        await fs.access(candidate, constants.X_OK);
        return candidate;
      } catch { notRunnable = true; }
    }
  }
  if (notRunnable) fail('executableNotRunnable', 'The PATH command is not executable.');
  fail('executableNotFound', 'The executable was not found on PATH.');
}

export async function resolveProbeExecutable(command, args = [], {
  cwd = process.cwd(), env = process.env, platform = process.platform, packageName, binName,
} = {}) {
  if (typeof command !== 'string' || !command || command.includes('\0') || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0')) || !path.isAbsolute(cwd)) {
    fail('executableInvalid', 'Use an executable, arguments without NUL, and an absolute working directory.');
  }
  const resolved = await findProbeCommand(command, cwd, env, platform);
  if (platform === 'win32') {
    const extension = path.extname(resolved).toLowerCase();
    if (extension === '.cmd') {
      const shim = await readWindowsShim(resolved, { packageName, binName });
      return {
        command: process.execPath,
        args: [...(shim.nodeArgs ? [shim.nodeArgs] : []), shim.entrypoint, ...args],
        env: windowsShimEnvironment(resolved, shim.nodePath, env),
      };
    }
    if (!['.exe', '.com'].includes(extension)) fail('executableShimUnsupported', 'Windows probes require a native executable or a verified package-manager shim.');
    await checkWindowsProbePath(resolved);
  }
  const canonical = await fs.realpath(resolved).catch(() => fail('executableNotFound', 'The executable is missing or unreadable.'));
  if (!(await fs.stat(canonical)).isFile()) fail('executableInvalid', 'The executable is not a regular file.');
  if (platform !== 'win32') {
    try { await fs.access(canonical, constants.X_OK); }
    catch { fail('executableNotRunnable', 'The executable does not have execute permission.'); }
  }
  return { command: canonical, args: [...args] };
}
