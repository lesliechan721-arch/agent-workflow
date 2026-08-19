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

export const PLUGIN_AUTO_RUNNER_EXTENSIONS = [
  '.js',
  '.mjs',
  '.cjs',
  '.sh',
  '.ps1',
  '.cmd',
  '.bat',
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

export function inferLifecycleScriptRunnerFromPath(
  scriptPath: string,
): Exclude<PluginLifecycleScriptRunner, 'auto'> | undefined {
  const extension = path.posix.extname(scriptPath).toLowerCase();
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return 'node';
  }
  if (extension === '.sh') {
    return 'sh';
  }
  if (extension === '.ps1') {
    return 'powershell';
  }
  if (extension === '.cmd' || extension === '.bat') {
    return 'cmd';
  }

  return undefined;
}

export interface ImportSpecifierReference {
  specifier: string;
  kind: 'import' | 'export' | 'require' | 'require-resolve' | 'dynamic-import';
}

interface JavaScriptToken {
  kind: 'identifier' | 'string' | 'punctuation' | 'literal';
  value: string;
}

function isJavaScriptIdentifierStart(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z_$]/u.test(value);
}

function isJavaScriptIdentifierPart(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_$]/u.test(value);
}

function decodeJavaScriptEscape(source: string, index: number): { value: string; next: number } {
  const escaped = source[index];
  const simple: Record<string, string> = {
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '0': '\0',
  };
  if (escaped === '\n') return { value: '', next: index + 1 };
  if (escaped === '\r') {
    return { value: '', next: source[index + 1] === '\n' ? index + 2 : index + 1 };
  }
  if (escaped && Object.prototype.hasOwnProperty.call(simple, escaped)) {
    return { value: simple[escaped]!, next: index + 1 };
  }
  if (escaped === 'x') {
    const hex = source.slice(index + 1, index + 3);
    if (/^[0-9A-Fa-f]{2}$/u.test(hex)) {
      return { value: String.fromCodePoint(Number.parseInt(hex, 16)), next: index + 3 };
    }
  }
  if (escaped === 'u') {
    if (source[index + 1] === '{') {
      const close = source.indexOf('}', index + 2);
      const hex = close === -1 ? '' : source.slice(index + 2, close);
      if (/^[0-9A-Fa-f]{1,6}$/u.test(hex)) {
        return { value: String.fromCodePoint(Number.parseInt(hex, 16)), next: close + 1 };
      }
    } else {
      const hex = source.slice(index + 1, index + 5);
      if (/^[0-9A-Fa-f]{4}$/u.test(hex)) {
        return { value: String.fromCodePoint(Number.parseInt(hex, 16)), next: index + 5 };
      }
    }
  }
  return { value: escaped ?? '', next: Math.min(index + 1, source.length) };
}

function tokenizeJavaScriptImports(source: string): JavaScriptToken[] {
  const tokens: JavaScriptToken[] = [];
  let index = 0;
  let previousToken: JavaScriptToken | undefined;

  const push = (token: JavaScriptToken): void => {
    tokens.push(token);
    previousToken = token;
  };

  const skipQuotedString = (quote: string): void => {
    index += 1;
    let value = '';
    while (index < source.length) {
      const current = source[index]!;
      if (current === quote) {
        index += 1;
        push({ kind: 'string', value });
        return;
      }
      if (current === '\\') {
        const decoded = decodeJavaScriptEscape(source, index + 1);
        value += decoded.value;
        index = decoded.next;
        continue;
      }
      value += current;
      index += 1;
    }
  };

  const canStartRegexLiteral = (): boolean => {
    if (!previousToken) return true;
    if (previousToken.kind === 'identifier') {
      return new Set([
        'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new',
        'return', 'throw', 'typeof', 'void', 'yield',
      ]).has(previousToken.value);
    }
    return previousToken.kind === 'punctuation'
      && ['(', '[', '{', '=', ':', ',', ';', '!', '&', '|', '?', '~', '+', '-', '*', '%', '^', '<', '>']
        .includes(previousToken.value);
  };

  const skipRegexLiteral = (): void => {
    index += 1;
    let inCharacterClass = false;
    while (index < source.length) {
      const current = source[index]!;
      if (current === '\\') {
        index = Math.min(index + 2, source.length);
        continue;
      }
      if (current === '[') inCharacterClass = true;
      if (current === ']') inCharacterClass = false;
      index += 1;
      if (current === '/' && !inCharacterClass) {
        while (/[A-Za-z]/u.test(source[index] ?? '')) index += 1;
        push({ kind: 'literal', value: 'regex' });
        return;
      }
      if (current === '\n' || current === '\r') return;
    }
  };

  const scanCode = (stopAtTemplateExpressionEnd: boolean): void => {
    let braceDepth = 0;
    while (index < source.length) {
      const current = source[index]!;
      const next = source[index + 1];
      if (/\s/u.test(current)) {
        index += 1;
        continue;
      }
      if (current === '/' && next === '/') {
        index += 2;
        while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1;
        continue;
      }
      if (current === '/' && next === '*') {
        index += 2;
        while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
        index = Math.min(index + 2, source.length);
        continue;
      }
      if (current === '\'' || current === '"') {
        skipQuotedString(current);
        continue;
      }
      if (current === '`') {
        index += 1;
        while (index < source.length) {
          if (source[index] === '\\') {
            index = Math.min(index + 2, source.length);
          } else if (source[index] === '`') {
            index += 1;
            break;
          } else if (source[index] === '$' && source[index + 1] === '{') {
            index += 2;
            const outerPrevious = previousToken;
            previousToken = undefined;
            scanCode(true);
            previousToken = outerPrevious;
          } else {
            index += 1;
          }
        }
        push({ kind: 'literal', value: 'template' });
        continue;
      }
      if (current === '/' && canStartRegexLiteral()) {
        skipRegexLiteral();
        continue;
      }
      if (isJavaScriptIdentifierStart(current)) {
        const start = index;
        index += 1;
        while (isJavaScriptIdentifierPart(source[index])) index += 1;
        push({ kind: 'identifier', value: source.slice(start, index) });
        continue;
      }
      if (/[0-9]/u.test(current)) {
        index += 1;
        while (/[A-Za-z0-9_.]/u.test(source[index] ?? '')) index += 1;
        push({ kind: 'literal', value: 'number' });
        continue;
      }
      if (current === '{') {
        braceDepth += 1;
        index += 1;
        push({ kind: 'punctuation', value: current });
        continue;
      }
      if (current === '}') {
        if (stopAtTemplateExpressionEnd && braceDepth === 0) {
          index += 1;
          return;
        }
        braceDepth = Math.max(0, braceDepth - 1);
        index += 1;
        push({ kind: 'punctuation', value: current });
        continue;
      }
      index += 1;
      push({ kind: 'punctuation', value: current });
    }
  };

  scanCode(false);
  return tokens;
}

export function scanJavaScriptImportSpecifiers(source: string): ImportSpecifierReference[] {
  const references: ImportSpecifierReference[] = [];
  const tokens = tokenizeJavaScriptImports(source);
  let pendingStatic: 'import' | 'export' | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const previous = tokens[index - 1];
    if (token.value === ';') pendingStatic = undefined;
    if (pendingStatic && token.kind === 'identifier' && token.value === 'from') {
      const specifier = tokens[index + 1];
      if (specifier?.kind === 'string') {
        references.push({ specifier: specifier.value, kind: pendingStatic });
      }
      pendingStatic = undefined;
      continue;
    }
    if (token.kind !== 'identifier' || previous?.value === '.') continue;
    if (token.value === 'require' && tokens[index + 1]?.value === '(') {
      const specifier = tokens[index + 2];
      if (specifier?.kind === 'string') {
        references.push({ specifier: specifier.value, kind: 'require' });
      }
      continue;
    }
    if (
      token.value === 'require'
      && tokens[index + 1]?.value === '.'
      && tokens[index + 2]?.kind === 'identifier'
      && tokens[index + 2]?.value === 'resolve'
      && tokens[index + 3]?.value === '('
    ) {
      const specifier = tokens[index + 4];
      if (specifier?.kind === 'string') {
        references.push({ specifier: specifier.value, kind: 'require-resolve' });
      }
      continue;
    }
    if (token.value !== 'import' && token.value !== 'export') continue;
    pendingStatic = undefined;
    if (token.value === 'import' && tokens[index + 1]?.value === '(') {
      const specifier = tokens[index + 2];
      if (specifier?.kind === 'string') {
        references.push({ specifier: specifier.value, kind: 'dynamic-import' });
      }
      continue;
    }
    if (token.value === 'import' && tokens[index + 1]?.kind === 'string') {
      references.push({ specifier: tokens[index + 1]!.value, kind: 'import' });
      continue;
    }
    pendingStatic = token.value;
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
