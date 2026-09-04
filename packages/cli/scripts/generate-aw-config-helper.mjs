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
const runtimeSourceRoot = path.join(repoRoot, 'packages', 'plugin-core', 'node_modules', 're2-wasm');
const runtimeOutputRoot = path.join(packageRoot, 'authoring', 'assets', 're2-wasm');
const runtimeFiles = [
  'LICENSE',
  'package.json',
  'build/src/re2.js',
  'build/wasm/re2.js',
  'build/wasm/re2.wasm',
];
const marker = '/* @aw-config-core */';

function vendorRuntimeFile(relativePath, content) {
  const cleanJavaScript = (source) => source.replace(/[\t ]+$/gmu, '').replace(/\n*$/u, '\n');
  if (relativePath === 'build/src/re2.js') {
    return Buffer.from(
      cleanJavaScript(content.toString('utf8').replace(/\n\/\/# sourceMappingURL=re2\.js\.map\s*$/u, '\n')),
      'utf8',
    );
  }
  if (relativePath !== 'build/wasm/re2.js') return content;
  return Buffer.from(
    cleanJavaScript(content.toString('utf8')
      .replaceAll("require('fs')", "require('node:fs')")
      .replaceAll("require('path')", "require('node:path')")),
    'utf8',
  );
}

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
const embeddedCore = transpiled.outputText.replace(
  /^import \{ RE2 \} from 're2-wasm';\n/mu,
  '',
);
if (/^\s*import\s/mu.test(embeddedCore)) {
  throw new Error('Core config contract gained a runtime import and cannot be embedded as a standalone helper.');
}
const template = await fs.readFile(templatePath, 'utf8');
if (template.split(marker).length !== 2) throw new Error('aw-config runtime template must contain one core marker.');
const generated = template.replace(
  marker,
  `/* Generated validator contract from packages/plugin-core/src/plugin-config.ts. */\n${embeddedCore.trim()}`,
);

if (process.argv.includes('--check')) {
  const current = await fs.readFile(outputPath, 'utf8').catch(() => '');
  if (current !== generated) {
    throw new Error('Generated aw-config.mjs is stale. Run the CLI generate:config-helper command.');
  }
  for (const relativePath of runtimeFiles) {
    const [sourceRuntime, currentRuntime] = await Promise.all([
      fs.readFile(path.join(runtimeSourceRoot, relativePath)),
      fs.readFile(path.join(runtimeOutputRoot, relativePath)).catch(() => Buffer.alloc(0)),
    ]);
    const source = vendorRuntimeFile(relativePath, sourceRuntime);
    if (!source.equals(currentRuntime)) {
      throw new Error(`Generated re2-wasm runtime is stale: ${relativePath}. Run the CLI generate:config-helper command.`);
    }
  }
} else {
  await fs.writeFile(outputPath, generated);
  for (const relativePath of runtimeFiles) {
    const targetPath = path.join(runtimeOutputRoot, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const source = vendorRuntimeFile(
      relativePath,
      await fs.readFile(path.join(runtimeSourceRoot, relativePath)),
    );
    await fs.writeFile(targetPath, source);
  }
}
