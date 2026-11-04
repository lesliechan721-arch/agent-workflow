import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertNoReparsePath, resolveSafeCommand, windowsOperation } from '../runtime/platform.mjs';

const execFileAsync = promisify(execFile);
const field = 'codexCliSource';

function discoveryError(code, source, message) {
  const error = new Error(`Codex executable discovery (${source}): ${message}`);
  error.code = code;
  error.diagnostic = { code, field, message: error.message };
  return error;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function existing(target, kind) {
  try {
    const stat = await fs.stat(target);
    return kind === 'directory' ? stat.isDirectory() : stat.isFile();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    throw error;
  }
}

async function macApp(environment, cwd, source) {
  const home = environment.HOME || os.homedir();
  const directories = [path.join(home, 'Applications'), '/Applications'];
  for (const directory of directories) {
    for (const name of ['Codex.app', 'ChatGPT.app']) {
      const bundle = path.join(directory, name);
      if (!await existing(bundle, 'directory')) continue;
      const root = await fs.realpath(bundle);
      const plist = path.join(root, 'Contents', 'Info.plist');
      if (!await existing(plist, 'file')) continue;
      if (!inside(root, await fs.realpath(plist))) continue;
      let identifier;
      try {
        const result = await execFileAsync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], {
          env: environment, cwd, timeout: 5000, maxBuffer: 4096, shell: false,
        });
        identifier = result.stdout.trim();
      } catch (error) {
        // A malformed plist is not a matching bundle. Failure to run the OS
        // query is different from an absent or unrelated App.
        if (Number.isSafeInteger(error.code) && error.killed !== true) continue;
        throw discoveryError('codexAppQueryFailed', source, 'The macOS bundle identity query failed. Repair the App or retry after the system query is available.');
      }
      if (identifier !== 'com.openai.codex') continue;
      const embedded = path.join(root, 'Contents', 'Resources', 'codex');
      if (!await existing(embedded, 'file')) continue;
      const canonical = await fs.realpath(embedded);
      if (!inside(root, canonical)) continue;
      try {
        return await resolveSafeCommand(canonical, [], { cwd, env: environment });
      } catch (error) {
        if (['executableNotFound', 'executableNotRunnable', 'executableInvalid'].includes(error.code)) continue;
        throw error;
      }
    }
  }
  return null;
}

const windowsPackagesQuery = [
  "$families = @(Get-StartApps -ErrorAction Stop | Where-Object { $_.AppID -like 'OpenAI.Codex_*!App' } | ForEach-Object { $_.AppID.Substring(0, $_.AppID.Length - 4) } | Sort-Object -Unique)",
  "$architecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITEW6432')",
  "if (!$architecture) { $architecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE') }",
  "switch ($architecture) { 'AMD64' { $architecture = 'X64' }; 'ARM64' { $architecture = 'Arm64' }; 'X86' { $architecture = 'X86' }; default { throw 'The system architecture is unavailable.' } }",
  '$packages = @()',
  'if ($families.Count -gt 0) {',
  '  $registered = @(Get-AppxPackage -PackageTypeFilter Main -ErrorAction Stop)',
  '  foreach ($family in $families) {',
  '    foreach ($package in $registered) {',
  "      if ($package.PackageFamilyName -ieq $family -and ($package.Architecture.ToString() -ieq $architecture -or $package.Architecture.ToString() -ieq 'Neutral')) {",
  '        $packages += @{ family = $family; root = $package.InstallLocation; version = $package.Version.ToString() }',
  '      }',
  '    }',
  '  }',
  '}',
  'ConvertTo-Json -InputObject @($packages) -Compress -Depth 4',
].join('\n');

async function windowsApp(environment, cwd, source) {
  let packages;
  try {
    packages = await windowsOperation(windowsPackagesQuery);
    if (!Array.isArray(packages) || packages.some((item) => !item || !/^OpenAI\.Codex_[^!\s]+$/i.test(item.family) || typeof item.root !== 'string' || !path.isAbsolute(item.root) || item.root.includes('\0') || typeof item.version !== 'string')) throw new Error();
  } catch {
    throw discoveryError('codexAppQueryFailed', source, 'The Windows registered App/package query failed. Retry after the system package query is available.');
  }
  const candidates = new Map();
  const roots = new Set();
  let inspected = 0;
  for (const item of packages) {
    if (!await existing(item.root, 'directory')) continue;
    const root = await fs.realpath(item.root);
    if (roots.has(root)) continue;
    roots.add(root);
    await assertNoReparsePath(item.root, 'directory');
    const pending = [{ directory: root, depth: 0 }];
    while (pending.length > 0) {
      const { directory, depth } = pending.pop();
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (++inspected > 50000) throw discoveryError('codexAppSearchLimit', source, 'The registered App package exceeds the bounded executable search. Use a PATH CLI or repair the App.');
        const target = path.join(directory, entry.name);
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue;
        const canonical = await fs.realpath(target);
        if (!inside(root, canonical)) continue;
        if (stat.isDirectory()) {
          if (depth >= 16) throw discoveryError('codexAppSearchLimit', source, 'The registered App package exceeds the bounded executable search. Use a PATH CLI or repair the App.');
          pending.push({ directory: canonical, depth: depth + 1 });
        } else if (entry.name.toLowerCase() === 'codex.exe') {
          await assertNoReparsePath(target, 'file');
          const invocation = await resolveSafeCommand(canonical, [], { cwd, env: environment });
          candidates.set(invocation.command, invocation);
        }
      }
    }
  }
  if (candidates.size > 1) throw discoveryError('codexAppAmbiguous', source, 'Several executable entries exist in registered Codex App packages. Repair the App registration or select a PATH CLI.');
  return candidates.values().next().value ?? null;
}

async function selected(invocation, selectedSource, source, environment, cwd) {
  let version;
  try {
    const { stdout } = await execFileAsync(invocation.command, [...invocation.args, '--version'], {
      env: invocation.env ?? environment, cwd, timeout: 3000, maxBuffer: 4096, shell: false, windowsHide: true,
    });
    // Do not publish arbitrary backend stdout or configuration values.
    version = stdout.trim().match(/^codex-cli ([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$/)?.[1];
  } catch { /* Version evidence is optional; the selected entry never changes. */ }
  return {
    ...invocation,
    diagnostic: { code: 'codexExecutableSelected', field, message: `Codex executable (${source}) selected ${selectedSource}: ${invocation.command}${version ? `; version ${version}` : ''}.` },
  };
}

export async function resolveCodexExecutable({ source = 'auto', environment = process.env, platform = process.platform, cwd = process.cwd() } = {}) {
  if (!['auto', 'cli', 'app'].includes(source)) throw discoveryError('protocolInvalid', 'invalid', 'codexCliSource must be auto, cli, or app.');
  if (source !== 'app') {
    try {
      const invocation = await resolveSafeCommand('codex', [], { env: environment, cwd, packageName: '@openai/codex', binName: 'codex' });
      return await selected(invocation, 'path', source, environment, cwd);
    } catch (error) {
      if (error.code === 'executableNotRunnable' && source === 'cli') throw discoveryError(error.code, source, 'The PATH Codex entry is not executable. Repair its permissions or select the App source.');
      if (!['executableNotFound', 'executableNotRunnable'].includes(error.code)) {
        throw discoveryError(error.code ?? 'codexExecutableInvalid', source, 'The PATH Codex entry could not be safely resolved. Repair its launcher or select the App source.');
      }
    }
  }
  if (source === 'app' && platform === 'linux') throw discoveryError('codexAppUnsupported', source, 'Codex App discovery is not supported on Linux. Install a PATH CLI and select cli or auto.');
  if (source !== 'cli' && ['darwin', 'win32'].includes(platform)) {
    let invocation;
    try {
      invocation = platform === 'darwin' ? await macApp(environment, cwd, source) : await windowsApp(environment, cwd, source);
    } catch (error) {
      if (error.diagnostic) throw error;
      throw discoveryError('codexAppDiscoveryFailed', source, 'The selected App could not be inspected safely. Repair the App or select a PATH CLI.');
    }
    if (invocation) return selected(invocation, 'app', source, environment, cwd);
  }
  throw discoveryError('codexExecutableNotFound', source, source === 'cli'
    ? 'No executable PATH CLI was found. Install Codex CLI, repair PATH, or select the App source.'
    : source === 'app'
      ? 'No matching App executable was found. Install or repair Codex App, or select the CLI source.'
      : 'No executable was found in the selected PATH/App search. Install Codex CLI, repair PATH, or install a supported Codex App.');
}
