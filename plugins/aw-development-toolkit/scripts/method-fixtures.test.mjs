import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
if (context) {
  assert.equal(context.event, 'test');
  assert.equal(context.plugin.name, 'aw-development-toolkit');
  assert.equal(path.isAbsolute(context.sourceRoot), true);
}
const sourceRoot = context?.sourceRoot ?? fileURLToPath(new URL('../', import.meta.url));
const evalRoot = path.join(sourceRoot, 'skills', 'develop-aw', 'evals');
const cases = JSON.parse(readFileSync(path.join(evalRoot, 'method-cases.json'), 'utf8')).cases;

function fixture(t, selected) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'aw-method-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(selected.input.workspaceFiles)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const env = { ...process.env, AW_HOME: path.join(root, '_homes/aw'), AW_CODEX_HOME: path.join(root, '_homes/codex'),
    AW_CLAUDE_HOME: path.join(root, '_homes/claude'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, '_empty-git-config') };
  const run = (bin, args, cwd = root, expected = 0) => {
    const result = spawnSync(bin, args, { cwd, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, expected, result.stderr || result.stdout || result.error?.message);
    return result.stdout;
  };
  return { root, run };
}

// Test Value Gate: workspace_valid must be an actual author-valid fixture, including renderer prerequisites.
for (const selected of cases.filter(entry => entry.tags.includes('workspace_valid'))) {
  test(`public status and validate accept method fixture ${selected.id}`, t => {
    const { root, run } = fixture(t, selected);
    const workspaceRoot = path.join(root, selected.id === 'comparable_finals' ? 'project' : 'catalog');
    const status = JSON.parse(run('aw', ['catalog', 'status', '--workspace-root', workspaceRoot, '--json']));
    assert.equal(status.ok, true);
    assert.equal(status.workspace.valid, true);
    assert.equal(status.catalog.valid, true);
    assert.equal(status.dependencyGraph.valid, true);
    assert.equal(status.snapshot.state, 'absent');
    assert.ok(status.plugins.length > 0);
    for (const plugin of status.plugins) {
      const receipt = JSON.parse(run('aw', ['plugin', 'validate', path.join(workspaceRoot, 'plugins', plugin.name), '--json']));
      assert.equal(receipt.ok, true);
    }
  });
}

test('public remove accepts the isolated clean fixture and leaves an empty Catalog', t => {
  const selected = cases.find(entry => entry.id === 'catalog_remove_empty');
  const { root, run } = fixture(t, selected);
  const repo = path.join(root, '_remove');
  const workspaceRoot = path.join(repo, 'catalog');
  cpSync(path.join(root, 'catalog'), workspaceRoot, { recursive: true });
  run('git', ['init'], repo);
  run('git', ['add', '.'], repo);
  run('git', ['-c', 'user.name=AW Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], repo);
  const receipt = JSON.parse(run('aw', ['plugin', 'remove', 'notes', '--workspace-root', workspaceRoot, '--yes', '--json']));
  assert.equal(receipt.ok, true);
  assert.equal(existsSync(path.join(workspaceRoot, 'plugins/notes')), false);
  const status = JSON.parse(run('aw', ['catalog', 'status', '--workspace-root', workspaceRoot, '--json']));
  assert.equal(status.ok, true);
  assert.deepEqual(status.plugins, []);
  assert.deepEqual(status.dependencyGraph.order, []);
});

test('comparison fixture has actual dirty and untracked inputs and rejects an incomplete copy', t => {
  const selected = cases.find(entry => entry.id === 'comparable_finals');
  const { root, run } = fixture(t, selected);
  run(process.execPath, ['setup-comparison.mjs']);
  const status = run('git', ['status', '--porcelain'], path.join(root, 'project'));
  assert.match(status, / M plugins\/demo-plugin\/skills\/demo-skill\/SKILL\.md/u);
  assert.match(status, /\?\? plugins\/demo-plugin\/shared\/untracked-policy\.md/u);
  const control = JSON.parse(readFileSync(path.join(root, 'fixture-control.json'), 'utf8'));
  const baseline = path.join(root, control.baselineWorkspace);
  cpSync(path.join(root, 'project'), baseline, { recursive: true });
  const args = [path.join(evalRoot, 'simplify-fixtures/bin/aw.mjs'), 'review', 'prepare',
    path.join(baseline, control.skillRelative), '--workspace-root', baseline, '--platform', 'codex', '--scope', 'project',
    '--out', path.join(root, control.baselineOutput), '--json'];
  rmSync(path.join(baseline, control.additionalInputs[0]));
  const rejected = JSON.parse(run(process.execPath, args, root, 2));
  assert.equal(rejected.ok, false);
  cpSync(path.join(root, 'project', control.additionalInputs[0]), path.join(baseline, control.additionalInputs[0]));
  const prepared = JSON.parse(run(process.execPath, args));
  assert.equal(prepared.ok, true);
  assert.equal(existsSync(prepared.sourceBindingPath), true);
});
