import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import fs from 'fs-extra';

const execFileAsync = promisify(execFile);

export interface SmokeStagingRunner {
  installPackageRoot(packageRoot: string): Promise<void>;
  runNodeBuild(options: {
    pluginRoot: string;
    scriptPath: string;
    args: readonly string[];
  }): Promise<void>;
}

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

function smokePackageSource(packageName: string): string {
  if (packageName === 'yaml') {
    return [
      'function parse(source) {',
      '  const match = /^name:\\s*(.+)\\s*$/m.exec(source);',
      '  return match ? { name: match[1].trim() } : {};',
      '}',
      '',
      'export default { parse };',
      '',
    ].join('\n');
  }

  if (packageName === 'fs-extra') {
    return [
      'import { access } from "node:fs/promises";',
      '',
      'export async function pathExists(filePath) {',
      '  try {',
      '    await access(filePath);',
      '    return true;',
      '  } catch {',
      '    return false;',
      '  }',
      '}',
      '',
      'export default { pathExists };',
      '',
    ].join('\n');
  }

  return 'export default {};\n';
}

async function writeSmokeInstalledPackage(packageRoot: string, packageName: string): Promise<void> {
  const dependencyRoot = path.join(packageRoot, 'node_modules', ...packageName.split('/'));
  await fs.ensureDir(dependencyRoot);
  await fs.writeJson(
    path.join(dependencyRoot, 'package.json'),
    {
      name: packageName,
      version: '0.0.0-smoke',
      type: 'module',
      main: 'index.js',
      exports: './index.js',
    },
    { spaces: 2 },
  );
  await fs.writeFile(path.join(dependencyRoot, 'index.js'), smokePackageSource(packageName), 'utf8');
}

function readPackageDependencyNames(packageJson: {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}): string[] {
  return [...new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ])].sort();
}

export function createSmokeStagingRunner(): SmokeStagingRunner {
  return {
    async installPackageRoot(packageRoot) {
      const packageJson = await fs.readJson(path.join(packageRoot, 'package.json')) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      const nodeModulesRoot = path.join(packageRoot, 'node_modules');
      await fs.remove(nodeModulesRoot);
      await fs.ensureDir(nodeModulesRoot);
      for (const dependencyName of readPackageDependencyNames(packageJson)) {
        await writeSmokeInstalledPackage(packageRoot, dependencyName);
      }
    },
    async runNodeBuild({ pluginRoot, scriptPath, args }) {
      await execFileAsync(process.execPath, [path.join(pluginRoot, stripDotSlash(scriptPath)), ...args], {
        cwd: pluginRoot,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      });
    },
  };
}
