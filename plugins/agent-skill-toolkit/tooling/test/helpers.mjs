import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
export const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));
export const sourceEntry = name => path.join(pluginRoot, 'tooling', 'src', `${name}.mjs`);
export async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'skill-toolkit-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
export async function put(root, relative, content) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}
export function skill(name = 'sample-skill', fields = '', body = 'Read the supplied input and report its stated facts.') {
  return `---\nname: ${name}\ndescription: Summarize the supplied input.\n${fields}---\n\n${body}\n`;
}
export async function run(entry, args = [], options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [entry, ...args], { maxBuffer: 4 * 1024 * 1024, timeout: 10_000, ...options });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error.killed) throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}
export async function jsonRun(entry, ...args) {
  const result = await run(entry, [...args, '--format', 'json']);
  return { ...result, report: JSON.parse(result.stdout) };
}
