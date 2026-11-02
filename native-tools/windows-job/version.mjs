import { readFile, writeFile } from 'node:fs/promises';
import { compareReleaseSemVer } from '../../scripts/release/common.mjs';

const version = process.argv.slice(2).filter((arg) => arg !== '--')[0];
if (process.argv.slice(2).filter((arg) => arg !== '--').length !== 1
  || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/u.test(version ?? '')) throw new Error('Expected one exact stable or beta.N native tool version.');
const target = new URL('./tool.json', import.meta.url);
const tool = JSON.parse(await readFile(target, 'utf8'));
if (compareReleaseSemVer(version, tool.version) <= 0) throw new Error('The next Windows Job version must be higher than the current version.');
await writeFile(target, `${JSON.stringify({ ...tool, version }, null, 2)}\n`);
console.log(`Windows Job is now ${version}. Build and qualify both architectures before publication.`);
