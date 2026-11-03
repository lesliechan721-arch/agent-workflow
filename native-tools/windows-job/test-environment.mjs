import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateToolContext, extractCandidateHelper, readCandidate, readPreparedWindowsJobCandidate, WINDOWS_JOB_PROTOCOL } from './candidate.mjs';
import { windowsJobArtifactContract } from './windows-job-helper-artifacts.mjs';

const defaultRepoRoot = path.resolve(windowsJobArtifactContract.toolRoot, '../..');

export async function prepareWindowsJobSourceTestEnvironment(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const arch = options.arch ?? process.arch;
  if ((options.platform ?? process.platform) !== 'win32' || !['x64', 'arm64'].includes(arch)) throw new Error('Source native test preparation requires Windows x64 or arm64.');
  if (options.root && options.preparedCandidateRoot) throw new Error('Select either a native source candidate or a verified prepared CLI candidate.');
  const selected = options.preparedCandidateRoot
    ? await readPreparedWindowsJobCandidate(options.preparedCandidateRoot, { repoRoot })
    : await readCandidate(options.root, { ...options, repoRoot });
  const temporary = await realpath(await mkdtemp(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'aw-native-source-test-')));
  try {
    const candidate = await extractCandidateHelper(selected, { arch, destination: temporary });
    const bytes = await readFile(candidate.executable);
    const packageName = `aw-windows-job-win32-${arch}`;
    const packageRoot = path.join(repoRoot, 'packages', packageName);
    const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (metadata.name !== `@lesliechan721/${packageName}` || !(await lstat(packageRoot)).isDirectory()) throw new Error('The workspace Windows platform package is invalid.');
    const dist = path.join(packageRoot, 'dist');
    const distStats = await lstat(dist).catch((error) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (distStats && (!distStats.isDirectory() || distStats.isSymbolicLink())) throw new Error('The workspace Windows platform dist must be a regular directory.');
    await mkdir(dist, { recursive: true });
    const expectedExecutable = path.join(dist, 'aw-windows-job.exe');
    const existing = await lstat(expectedExecutable).catch((error) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('The workspace Windows helper output must be a regular file.');
    await writeFile(expectedExecutable, bytes, { mode: 0o755 });

    // CI prepares dependencies before building Eval. Anchor Node's normal
    // package resolution to Eval, then reject any dependency outside the
    // workspace package just materialized from this candidate.
    const requireFromEval = createRequire(path.join(repoRoot, 'packages/agent-skill-eval/package.json'));
    const executable = requireFromEval.resolve(`@lesliechan721/${packageName}/aw-windows-job.exe`);
    if (await realpath(executable) !== await realpath(expectedExecutable)
      || !(await readFile(executable)).equals(bytes)) throw new Error('Eval must resolve the workspace platform package from this source candidate.');
    return { state: 'ready', protocol: WINDOWS_JOB_PROTOCOL, executable };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main(argv) {
  const args = [...argv];
  let root, preparedCandidateRoot, contextFile, githubEnv = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--github-env' && !githubEnv) { githubEnv = true; continue; }
    const value = args.shift();
    if (flag === '--candidate' && value && root === undefined) root = path.resolve(value);
    else if (flag === '--prepared-candidate' && value && preparedCandidateRoot === undefined) preparedCandidateRoot = path.resolve(value);
    else if (flag === '--context-file' && value && contextFile === undefined) contextFile = path.resolve(value);
    else throw new Error('Expected [--github-env] [--context-file <path>] [--candidate <directory> | --prepared-candidate <verified CLI bundle>].');
  }
  if ((!githubEnv && !contextFile) || (githubEnv && !process.env.GITHUB_ENV)) throw new Error('Expected --context-file <path> or --github-env in a GitHub Actions test job.');
  const ready = await prepareWindowsJobSourceTestEnvironment({ root, preparedCandidateRoot });
  const context = candidateToolContext(ready);
  if (githubEnv) await appendFile(process.env.GITHUB_ENV, `AW_NATIVE_TOOL_CONTEXT=${context}\n`);
  if (contextFile) {
    await mkdir(path.dirname(contextFile), { recursive: true });
    await writeFile(contextFile, `${context}\n`, { flag: 'wx' });
  }
  console.log('Prepared the selected CLI candidate for explicit Windows tests.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
