import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const coreSourcePath = path.join(repoRoot, 'packages', 'plugin-core', 'src', 'plugin-config.ts');
const templatePath = path.join(packageRoot, 'authoring', 'templates', 'aw-config-runtime.mjs');
const outputPath = path.join(packageRoot, 'authoring', 'assets', 'aw-config.mjs');
const marker = '/* @aw-config-core */';

const coreSource = await fs.readFile(coreSourcePath, 'utf8');
const transpiled = ts.transpileModule(coreSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    removeComments: false,
  },
  fileName: coreSourcePath,
  reportDiagnostics: true,
});
if (transpiled.diagnostics?.length) {
  throw new Error(ts.formatDiagnosticsWithColorAndContext(transpiled.diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => '\n',
  }));
}
if (/^\s*import\s/mu.test(transpiled.outputText)) {
  throw new Error('Core config contract gained a runtime import and cannot be embedded as a standalone helper.');
}
const template = await fs.readFile(templatePath, 'utf8');
if (template.split(marker).length !== 2) throw new Error('aw-config runtime template must contain one core marker.');
const generated = template.replace(
  marker,
  `/* Generated validator contract from packages/plugin-core/src/plugin-config.ts. */\n${transpiled.outputText.trim()}`,
);

if (process.argv.includes('--check')) {
  const current = await fs.readFile(outputPath, 'utf8').catch(() => '');
  if (current !== generated) {
    throw new Error('Generated aw-config.mjs is stale. Run the CLI generate:config-helper command.');
  }
} else {
  await fs.writeFile(outputPath, generated);
}
