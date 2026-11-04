import { cp, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runWindowsJobQualification } from '../../scripts/qualification/windows-job-containment.mjs';
import { createNativeToolReaderSource } from '../../packages/native-runtime/src/reader.mjs';
import { captureCommand, runCommand } from '../../scripts/release/common.mjs';
import { candidateToolContext, extractCandidateHelper, readCandidate, writeAtomicJson } from './candidate.mjs';
import { windowsJobArtifactContract } from './windows-job-helper-artifacts.mjs';

export async function qualifyWindowsJobCandidate(options = {}) {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Native qualification requires a real Windows x64 or arm64 host.');
  const selected = await readCandidate(options.root);
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-native-qualification-')));
  try {
    const ready = await extractCandidateHelper(selected, { destination: temporary });
    const evaluator = await import(pathToFileURL(path.resolve(windowsJobArtifactContract.toolRoot, '../../packages/agent-skill-eval/dist/index.js')).href);
    const report = await runWindowsJobQualification({ helperPath: ready.executable, runProviderProcess: evaluator.runProviderProcess });
    const context = candidateToolContext(ready);
    if (report.status === 'passed') {
      try {
        const toolchain = await captureCommand('go', ['version'], { env: { GOTOOLCHAIN: 'local' } });
        if (!toolchain.stdout.startsWith(`go version ${selected.candidate.goVersion} `)) throw new Error('Pinned Go toolchain required for native tests.');
        await runCommand('go', ['test', './...'], { cwd: path.join(windowsJobArtifactContract.toolRoot, 'job-helper'), env: { GOTOOLCHAIN: 'local', CGO_ENABLED: '0', GOWORK: 'off' } });
        report.checks.push({ id: 'go-native-tests', passed: true });
        const plugin = path.join(temporary, 'codex-enhance');
        await cp(path.resolve(windowsJobArtifactContract.toolRoot, '../../plugins/codex-enhance'), plugin, { recursive: true, filter: (source) => !source.split(path.sep).includes('node_modules') });
        await writeFile(path.join(plugin, 'skills/codex-subagent-guide/scripts/runtime/native-tool-reader.mjs'), createNativeToolReaderSource());
        await runCommand(process.execPath, [path.join(plugin, 'scripts/subagent-windows-file-boundaries.mjs')], {
          env: { AW_NATIVE_TOOL_CONTEXT: context },
        });
        report.checks.push({ id: 'plugin-files-acl-cross-volume', passed: true });
      } catch (error) {
        report.status = 'failed';
        report.checks.push({ id: 'native-qualification', passed: false, code: error instanceof Error ? error.message : 'unknownFailure' });
      }
    }
    const qualification = { ...report, kind: 'windows-job-qualification', mode: 'source-candidate', candidateDigest: selected.candidateDigest, sourceDigest: selected.candidate.sourceDigest };
    await writeAtomicJson(options.output ?? path.join(selected.root, `qualification-${process.arch}.json`), qualification);
    if (qualification.status !== 'passed') throw new Error('Windows Job qualification failed.');
    return qualification;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) try {
  const args = process.argv.slice(2);
  let root, output;
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (!value) throw new Error('Expected --candidate <directory> or --out <report.json>.');
    if (flag === '--candidate' && root === undefined) root = path.resolve(value);
    else if (flag === '--out' && output === undefined) output = path.resolve(value);
    else throw new Error('Expected --candidate <directory> or --out <report.json>.');
  }
  await qualifyWindowsJobCandidate({ root, output });
  console.log('Windows Job source candidate qualification passed.');
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
