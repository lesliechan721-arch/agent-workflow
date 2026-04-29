import path from 'node:path';

import type {
  PluginLifecycleRuntimeOs,
  PluginLifecycleScriptEntry,
  PluginLifecycleScriptRunner,
  PluginLifecycleScriptSelector,
} from '../types.js';

export const PLUGIN_LIFECYCLE_EVENTS = ['install', 'upgrade', 'uninstall'] as const;
export const PLUGIN_LIFECYCLE_OS_SELECTORS = [
  'default',
  'unix',
  'windows',
  'linux',
  'darwin',
  'win32',
] as const;
export const PLUGIN_SCRIPT_RUNNERS = [
  'node',
  'sh',
  'bash',
  'pwsh',
  'powershell',
  'cmd',
  'auto',
] as const;

export const PLUGIN_SCRIPT_TIMEOUT_DEFAULT_MS = 30_000;
export const PLUGIN_SCRIPT_TIMEOUT_MIN_MS = 1_000;
export const PLUGIN_SCRIPT_TIMEOUT_MAX_MS = 300_000;

export function isPluginLifecycleOsSelector(value: string): boolean {
  return (PLUGIN_LIFECYCLE_OS_SELECTORS as readonly string[]).includes(value);
}

export function isPluginScriptRunner(value: string): value is PluginLifecycleScriptRunner {
  return (PLUGIN_SCRIPT_RUNNERS as readonly string[]).includes(value);
}

export function getLifecycleSelectorOrder(os: PluginLifecycleRuntimeOs): readonly string[] {
  if (os === 'linux') {
    return ['linux', 'unix', 'default'];
  }

  if (os === 'darwin') {
    return ['darwin', 'unix', 'default'];
  }

  return ['win32', 'windows', 'default'];
}

export function resolveLifecycleScriptForOs(
  selector: PluginLifecycleScriptSelector,
  os: PluginLifecycleRuntimeOs,
): PluginLifecycleScriptEntry | undefined {
  for (const key of getLifecycleSelectorOrder(os)) {
    const entry = selector[key as keyof PluginLifecycleScriptSelector];
    if (entry) {
      return entry;
    }
  }

  return undefined;
}

export interface ImportSpecifierReference {
  specifier: string;
  kind: 'import' | 'export' | 'require' | 'dynamic-import';
}

export function scanJavaScriptImportSpecifiers(source: string): ImportSpecifierReference[] {
  const references: ImportSpecifierReference[] = [];
  const patterns: Array<[RegExp, ImportSpecifierReference['kind']]> = [
    [/\bimport\s+(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"]/gs, 'import'],
    [/\bexport\s+(?:[^'"]*?\s+from\s*)['"]([^'"]+)['"]/gs, 'export'],
    [/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gs, 'require'],
    [/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gs, 'dynamic-import'],
  ];

  for (const [pattern, kind] of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) {
        references.push({ specifier, kind });
      }
    }
  }

  return references;
}

export interface NodeImportContractScanOptions {
  files: Record<string, string>;
  entryFiles: string[];
  dependencies?: readonly string[];
  devDependencies?: readonly string[];
  allowDevDependencies?: boolean;
}

export interface NodeImportContractScanResult {
  files: string[];
  bareSpecifiers: string[];
  errors: string[];
}

function normalizePluginFilePath(value: string): string {
  const withoutDotSlash = value.startsWith('./') ? value.slice(2) : value;
  return path.posix.normalize(withoutDotSlash);
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

function isBareSpecifier(specifier: string): boolean {
  return !isRelativeSpecifier(specifier) && !specifier.startsWith('/') && !specifier.startsWith('node:');
}

function getPackageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return `${scope}/${name ?? ''}`;
  }

  return specifier.split('/')[0] ?? specifier;
}

function resolveRelativeFile(
  importer: string,
  specifier: string,
  files: Record<string, string>,
): string | undefined {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
    return resolved;
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

  return candidates.find((candidate) => Object.prototype.hasOwnProperty.call(files, candidate));
}

export function scanNodeImportContract(
  options: NodeImportContractScanOptions,
): NodeImportContractScanResult {
  const files = Object.fromEntries(
    Object.entries(options.files).map(([file, source]) => [normalizePluginFilePath(file), source]),
  );
  const dependencies = new Set(options.dependencies ?? []);
  const devDependencies = new Set(options.devDependencies ?? []);
  const queue = options.entryFiles.map(normalizePluginFilePath);
  const visited = new Set<string>();
  const bareSpecifiers = new Set<string>();
  const errors: string[] = [];

  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || visited.has(file)) {
      continue;
    }

    visited.add(file);
    const source = files[file];
    if (source === undefined) {
      errors.push(`Missing runtime import file "${file}".`);
      continue;
    }

    for (const reference of scanJavaScriptImportSpecifiers(source)) {
      const { specifier } = reference;
      if (specifier.startsWith('node:')) {
        continue;
      }

      if (isRelativeSpecifier(specifier)) {
        const resolved = resolveRelativeFile(file, specifier, files);
        if (!resolved) {
          errors.push(`Unable to resolve relative import "${specifier}" from "${file}".`);
          continue;
        }
        if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
          errors.push(`Relative import "${specifier}" from "${file}" escapes the plugin root.`);
          continue;
        }
        queue.push(resolved);
        continue;
      }

      if (!isBareSpecifier(specifier)) {
        errors.push(`Unsupported import specifier "${specifier}" from "${file}".`);
        continue;
      }

      const packageName = getPackageName(specifier);
      bareSpecifiers.add(packageName);
      if (dependencies.has(packageName)) {
        continue;
      }
      if (devDependencies.has(packageName)) {
        if (!options.allowDevDependencies) {
          errors.push(`Runtime import "${specifier}" from "${file}" uses dev dependency "${packageName}".`);
        }
        continue;
      }
      errors.push(`Runtime import "${specifier}" from "${file}" is not declared in dependencies.`);
    }
  }

  return {
    files: [...visited].sort(),
    bareSpecifiers: [...bareSpecifiers].sort(),
    errors,
  };
}

