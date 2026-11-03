import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import ts from 'typescript';
import { readNativeTool } from '@lesliechan721/aw-native-runtime/reader';
import { expect, it } from 'vitest';

import { TestCommandDiagnostics } from '../helpers/test-command-diagnostics.js';
import { writeFixtureConfig } from '../helpers/vitest-fixture.js';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const vitestRoot = path.dirname(createRequire(import.meta.url).resolve('vitest/package.json'));
const needsWindowsCandidate = process.platform === 'win32'
  && readNativeTool('windows-job', 'aw.windows-job.v1').state !== 'ready';

it.skipIf(needsWindowsCandidate)('loads Eval with native ESM for explicit candidates and keeps ordinary unit tests build free', async ({ task, signal }) => {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, 'aw-vitest-eval-'));
  const cliRoot = path.join(root, 'packages', 'cli');
  const evalRoot = path.join(root, 'packages', 'agent-skill-eval');
  const nativeRoot = path.join(evalRoot, 'node_modules', '@lesliechan721', 'aw-windows-job-win32-x64');
  const executable = path.join(nativeRoot, 'dist', 'aw-windows-job.exe');
  const scope = new TestCommandDiagnostics('publisher', task.name, signal);
  try {
    await fs.ensureDir(path.join(root, 'node_modules'));
    await fs.symlink(vitestRoot, path.join(root, 'node_modules', 'vitest'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.outputJson(path.join(cliRoot, 'package.json'), { type: 'module' });
    await fs.outputJson(path.join(evalRoot, 'package.json'), { type: 'module' });
    await fs.copy(path.join(packageRoot, 'vitest.config.ts'), path.join(cliRoot, 'vitest.config.ts'));
    await fs.copy(path.join(packageRoot, 'scripts', 'test-workers.mjs'), path.join(cliRoot, 'scripts', 'test-workers.mjs'));
    await fs.outputFile(path.join(cliRoot, 'tests', 'setup', 'test-isolation.ts'), '');
    const source = await fs.readFile(path.join(packageRoot, '..', 'agent-skill-eval', 'src', 'windows-job.ts'), 'utf8');
    await fs.outputFile(path.join(evalRoot, 'src', 'windows-job.ts'), source);
    await fs.outputFile(path.join(evalRoot, 'src', 'index.ts'), 'export { resolveWindowsJobHelperPath } from "./windows-job.js";\n');
    const fixture = path.join(cliRoot, 'tests', 'integration', 'eval-dependency.test.ts');
    await fs.outputFile(fixture, [
      'import { expect, it } from "vitest";',
      'import { resolveWindowsJobHelperPath } from "@lesliechan721/agent-skill-eval";',
      'it("imports source without a build", async () => {',
      '  await expect(resolveWindowsJobHelperPath({ platform: "linux", arch: "x64" })).rejects.toMatchObject({ code: "nativePlatformUnsupported" });',
      '});',
    ].join('\n'));
    const launch = path.join(cliRoot, 'launch.mjs');
    await fs.writeFile(launch, [
      'for (const key of Object.keys(process.env)) if (key.toUpperCase() === "AW_NATIVE_TOOL_CONTEXT") delete process.env[key];',
      // This context selects the test boundary. Its path must never become the production resolver result.
      'if (process.env.AW_EVAL_BOUNDARY_COMPILED) process.env.AW_NATIVE_TOOL_CONTEXT = JSON.stringify({ schemaVersion: 1, tools: { "windows-job": { state: "ready", protocol: "aw.windows-job.v1", executable: "foreign-context.exe" } } });',
      'const selection = process.env.AW_EVAL_BOUNDARY_CONFIG ? ["--config", process.env.AW_EVAL_BOUNDARY_CONFIG] : ["--config", "vitest.config.ts", "--project", "integration"];',
      `process.argv = [process.execPath, ${JSON.stringify(path.join(vitestRoot, 'vitest.mjs'))}, "run", ...selection, "--maxWorkers=1", "--no-file-parallelism"];`,
      `await import(${JSON.stringify(pathToFileURL(path.join(vitestRoot, 'vitest.mjs')).href)});`,
    ].join('\n'));
    const run = async (compiled: boolean, config?: string): Promise<void> => {
      const result = await scope.command(process.execPath, [launch], {
        cwd: cliRoot,
        env: {
          ...process.env,
          AW_EVAL_BOUNDARY_COMPILED: compiled ? '1' : '',
          AW_EVAL_BOUNDARY_CONFIG: config ?? '',
        },
        timeoutMs: 20_000,
      });
      expect(result.stdout).toContain('1 passed');
    };
    await run(false);
    const nestedConfig = await writeFixtureConfig(cliRoot, 'tests/integration/eval-dependency.test.ts', {
      basePackageRoot: cliRoot,
    });
    await run(false, nestedConfig);

    await fs.outputFile(path.join(evalRoot, 'dist', 'index.js'), ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText);
    await fs.outputJson(path.join(nativeRoot, 'package.json'), {
      name: '@lesliechan721/aw-windows-job-win32-x64',
      exports: { './aw-windows-job.exe': './dist/aw-windows-job.exe' },
    });
    await fs.outputFile(executable, 'fixture bytes; never executed');
    await fs.writeFile(fixture, [
      'import { rm } from "node:fs/promises";',
      'import { expect, it } from "vitest";',
      'import { resolveWindowsJobHelperPath } from "@lesliechan721/agent-skill-eval";',
      'it("resolves only the normal Eval dependency and fails when it is absent", async () => {',
      `  const expected = ${JSON.stringify(executable)};`,
      '  await expect(resolveWindowsJobHelperPath({ platform: "win32", arch: "x64" })).resolves.toBe(expected);',
      '  await expect(resolveWindowsJobHelperPath({ platform: "win32", arch: "arm64" })).rejects.toMatchObject({ code: "nativePackageUnavailable" });',
      '  await rm(expected);',
      '  await expect(resolveWindowsJobHelperPath({ platform: "win32", arch: "x64" })).rejects.toMatchObject({ code: "nativePackageUnavailable" });',
      '});',
    ].join('\n'));
    await run(true);
    await fs.outputFile(executable, 'fixture bytes; never executed');
    await run(true, nestedConfig);
  } finally {
    await scope.finish();
    await fs.remove(root);
  }
}, 60_000);
