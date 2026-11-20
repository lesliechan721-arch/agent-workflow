// The published browser-use plugin invokes the native executable for --version.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const [prefix, destination] = process.argv.slice(2);
const lock = JSON.parse(await fs.readFile(path.join(prefix, 'package-lock.json'), 'utf8'));
const pkg = lock.packages['node_modules/agent-browser'];
assert.equal(pkg.version, '0.38.1');
assert.equal(pkg.integrity, 'sha512-k58FCz0yUOCANoNkMiqJe+H2y6r6sUZazqXsWF+MYq1iRC42PjtLcBoag6SSTOD/FRQppvPDvE5HDYEhclvnhw==');
const windows = process.platform === 'win32';
const ext = windows ? '.exe' : '';
// The upstream 0.38.1 launcher uses the published x64 binary on Windows arm64.
const release = `agent-browser-${process.platform}-${windows ? 'x64' : process.arch}${ext}`;
await fs.mkdir(destination, { recursive: true });
const binary = path.join(destination, 'agent-browser' + ext);
await fs.copyFile(path.join(prefix, 'node_modules/agent-browser/bin', release), binary);
await fs.chmod(binary, 0o755);
const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
assert.equal(version, 'agent-browser 0.38.1');
console.log(release, version);
if (process.env.GITHUB_ENV) await fs.appendFile(process.env.GITHUB_ENV, `AW_QUALIFICATION_BROWSER_BIN=${path.resolve(destination)}\n`);
