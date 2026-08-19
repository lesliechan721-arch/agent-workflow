import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const localPluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8')).sourceRoot
  : localPluginRoot;

async function run(relative, args = []) {
  return execFileAsync(process.execPath, [path.join(pluginRoot, relative), ...args], {
    cwd: pluginRoot,
    encoding: 'utf8',
  });
}

test('generated content standards and contract assets are current', async () => {
  await run('scripts/validate-standard-views.mjs');
  await run('scripts/validate-contract-assets.mjs');
});

test('the plugin exposes only the two content skills and a versioned rule bundle', async () => {
  const [manifest, readme, rulesRaw] = await Promise.all([
    readFile(path.join(pluginRoot, '.agents-plugin/plugin.json'), 'utf8').then(JSON.parse),
    readFile(path.join(pluginRoot, 'README.md'), 'utf8'),
    readFile(path.join(pluginRoot, 'standards/rules.json'), 'utf8'),
  ]);
  assert.equal(manifest.name, 'agent-content-toolkit');
  assert.equal(manifest.version, '0.3.0');
  assert.match(readme, /write-agent-content/u);
  assert.match(readme, /review-agent-content/u);
  assert.doesNotMatch(readme, /author-agent-skill/u);
  assert.match('sha256:' + createHash('sha256').update(rulesRaw).digest('hex'), /^sha256:[0-9a-f]{64}$/u);
  assert.doesNotMatch(rulesRaw, /agent-workflows/u);
});

test('reference audit starter satisfies the canonical schema', async () => {
  await run('scripts/validate-json-contract.mjs', [
    path.join(pluginRoot, 'schemas/reference-audit-result.schema.json'),
    path.join(pluginRoot, 'skills/review-agent-content/assets/reference-audit-result.template.json'),
  ]);
});
