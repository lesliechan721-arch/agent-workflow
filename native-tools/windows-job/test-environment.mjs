import { appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveNativeTool } from '../../packages/native-runtime/src/index.mjs';
import { readCandidate } from './candidate.mjs';

if (process.argv.slice(2).join(' ') !== '--github-env' || !process.env.GITHUB_ENV) throw new Error('Expected --github-env in a GitHub Actions test job.');
if (process.platform !== 'win32') throw new Error('Source native test preparation requires Windows.');
const selected = await readCandidate();
const archive = selected.candidate.packages.find((entry) => entry.arch === process.arch);
if (!archive) throw new Error('Unsupported Windows source candidate architecture.');
const archivePath = path.join(selected.root, archive.path);
const cacheRoot = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), `aw-native-source-${selected.candidate.version}-${process.arch}`);
const ready = await resolveNativeTool({ descriptor: selected.descriptor, archivePath, cacheRoot, mode: 'source-candidate' });
const environment = {
  AW_NATIVE_TOOL_CONTEXT: JSON.stringify({ schemaVersion: 1, tools: { 'windows-job': ready } }),
  AW_NATIVE_RESOLVER_MODE: 'source-candidate',
  AW_NATIVE_TEST_CONFIG: JSON.stringify({ mode: 'source-candidate', archivePath, cacheRoot, descriptorPath: path.join(selected.root, 'windows-job.lock.json') }),
};
await appendFile(process.env.GITHUB_ENV, Object.entries(environment).map(([key, value]) => `${key}=${value}\n`).join(''));
console.log('Prepared the current source candidate for explicit Windows tests.');
