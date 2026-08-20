import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const localPluginRoot = fileURLToPath(new URL('../', import.meta.url));

async function sourceRoot() {
  if (!process.env.AW_PLUGIN_CONTEXT) return localPluginRoot;
  const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
  assert.equal(context.plugin.name, 'codex-enhance');
  return context.sourceRoot;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

test('release behavior corpus defines a three-run gate by Skill matrix', async () => {
  const evalRoot = path.join(await sourceRoot(), 'skills', 'codex-clarifier', 'evals');
  const [manifest, corpus] = await Promise.all([
    readJson(path.join(evalRoot, 'manifest.json')),
    readJson(path.join(evalRoot, 'codex-clarifier-release-evals.json')),
  ]);

  const behavior = manifest.suites.find((suite) => suite.id === 'behavior');
  assert.ok(behavior);
  assert.equal(behavior.kind, 'conversation');
  assert.equal(behavior.defaultRuns, 3);
  assert.equal(corpus.skill_name, 'codex-clarifier');
  assert.equal(corpus.evals.length, 6);

  const byFamily = Map.groupBy(corpus.evals, (entry) => entry.scenario_family);
  assert.equal(byFamily.size, 3);
  for (const entries of byFamily.values()) {
    assert.deepEqual(entries.map((entry) => entry.preconditions.eval_gate_enabled).sort(), [
      false,
      true,
    ]);
    const gate = entries.find((entry) => entry.preconditions.eval_gate_enabled);
    const noGate = entries.find((entry) => !entry.preconditions.eval_gate_enabled);
    assert.equal(typeof gate.workspace_files?.['AGENTS.md'], 'string');
    assert.equal(noGate.workspace_files?.['AGENTS.md'], undefined);
    assert.equal(gate.prompt, noGate.prompt);
  }
});
