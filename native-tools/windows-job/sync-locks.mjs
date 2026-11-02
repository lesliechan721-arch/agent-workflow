import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { windowsJobArtifactContract } from './windows-job-helper-artifacts.mjs';

const root = path.resolve(windowsJobArtifactContract.toolRoot, '../..');
for (const relative of [
  'packages/agent-skill-eval/src/native/windows-job.lock.json',
  'packages/cli/src/native/windows-job.lock.json',
  'plugins/codex-enhance/native-tools/windows-job.lock.json',
]) await copyFile(path.join(windowsJobArtifactContract.toolRoot, 'windows-job.lock.json'), path.join(root, relative));
console.log('Copied the local candidate lock. Consumer release still requires remote reference verification.');
