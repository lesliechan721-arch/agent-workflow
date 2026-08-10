import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function staticModuleSpecifiers(sourcePath: string): string[] {
  const source = ts.createSourceFile(
    sourcePath,
    fs.readFileSync(sourcePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  const moduleText = (node: ts.Node | undefined): string | null => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      return node.text;
    }
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && moduleText(node.moduleSpecifier) !== null
    ) {
      specifiers.push(moduleText(node.moduleSpecifier)!);
    }
    if (
      ts.isCallExpression(node)
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      )
      && node.arguments.length === 1
      && moduleText(node.arguments[0]) !== null
    ) {
      specifiers.push(moduleText(node.arguments[0])!);
    }
    if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && moduleText(node.moduleReference.expression) !== null
    ) {
      specifiers.push(moduleText(node.moduleReference.expression)!);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function resolveSourceImport(sourcePath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const resolved = ts.resolveModuleName(specifier, sourcePath, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
  }, ts.sys).resolvedModule?.resolvedFileName;
  if (resolved && /\.(?:ts|tsx|mts|cts)$/.test(resolved) && fs.pathExistsSync(resolved)) {
    return path.resolve(resolved);
  }
  const base = path.resolve(path.dirname(sourcePath), specifier);
  const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts'];
  const runtimeExtension = path.extname(base);
  const withoutRuntimeExtension = ['.js', '.jsx', '.mjs', '.cjs'].includes(runtimeExtension)
    ? base.slice(0, -runtimeExtension.length)
    : base;
  const candidates = [
    base,
    ...sourceExtensions.map((extension) => `${withoutRuntimeExtension}${extension}`),
    ...sourceExtensions.map((extension) => path.join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => fs.pathExistsSync(candidate)) ?? null;
}

describe('rebuild runtime import boundary', () => {
  it('stays inside the rebuild core architecture allowlist', () => {
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
    const entry = path.join(srcRoot, 'commands', 'rebuild-operations.ts');
    const pending = [entry];
    const visited = new Set<string>();

    while (pending.length > 0) {
      const sourcePath = pending.pop()!;
      if (visited.has(sourcePath)) {
        continue;
      }
      visited.add(sourcePath);
      for (const specifier of staticModuleSpecifiers(sourcePath)) {
        const resolved = resolveSourceImport(sourcePath, specifier);
        if (resolved) {
          pending.push(resolved);
        }
      }
    }

    const relativeModules = [...visited].map((sourcePath) =>
      path.relative(srcRoot, sourcePath).split(path.sep).join('/')).sort();
    const allowedModules = new Set([
      'commands/rebuild-operations.ts',
      'types.ts',
      'utils/active-marketplace-runtime-lock.ts',
      'utils/bundle-integrity.ts',
      'utils/lifecycle-active-store.ts',
      'utils/ownership.ts',
      'utils/plugin-script-contract.ts',
      'utils/process-lock.ts',
      'utils/state-paths.ts',
      'utils/test-path-fence.ts',
    ]);
    expect(relativeModules.filter((modulePath) => !allowedModules.has(modulePath))).toEqual([]);
    expect(relativeModules).toEqual(expect.arrayContaining([
      'commands/rebuild-operations.ts',
      'utils/lifecycle-active-store.ts',
      'utils/ownership.ts',
    ]));
  });
});
