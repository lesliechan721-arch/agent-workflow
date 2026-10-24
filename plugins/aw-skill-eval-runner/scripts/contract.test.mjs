import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = process.env.AW_PLUGIN_ROOT;
const windows = process.platform === 'win32';

test('case checker distinguishes writable tools from authorized file changes', (t) => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'aw-eval-no-write-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const checker = realpathSync(path.join(root, 'codex', 'skills', 'run-aw-skill-evals', 'scripts', 'validate-eval-cases.mjs'));
  const cases = [
    { expected: { workspaceUnchanged: false, allowedWorkspaceChanges: [] }, valid: true },
    { expected: { workspaceUnchanged: false }, valid: false },
    { expected: { workspaceUnchanged: false, allowedWorkspaceChanges: ['out/**'] }, valid: false },
    { expected: {
      workspaceUnchanged: false, allowedWorkspaceChanges: ['out/**'],
      artifacts: [{ path: 'out/result.md', exists: true }],
    }, valid: true },
  ];
  for (const [index, entry] of cases.entries()) {
    const file = path.join(temporary, `case-${index}.json`);
    writeFileSync(file, JSON.stringify({
      version: 1,
      suite: {
        kind: 'conversation', unitUnderTest: 'fixture-skill',
        policy: {
          optimization: 'balanced', falseNegativeCost: 'high', falsePositiveCost: 'high',
          rationale: 'Keep tool capability separate from allowed file changes.',
        },
      },
      cases: [{
        id: 'bounded', split: 'validation', tags: [], prompt: 'Follow the stated scope.',
        assertions: ['Preserves the requested write boundary.'], expected: entry.expected,
      }],
    }));
    const result = spawnSync(process.execPath, [checker, file, '--strict', '--format', 'json'], { encoding: 'utf8' });
    assert.ok(result.stdout.trim(), result.stderr || `Checker returned no JSON (exit ${result.status}).`);
    assert.equal(JSON.parse(result.stdout).valid, entry.valid, result.stderr || result.stdout);
    assert.equal(result.status === 0, entry.valid, result.stderr || result.stdout);
  }
});

test('publishes one model-callable Skill with the Eval capability', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, '.agents-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'aw-skill-eval-runner');
  assert.ok(manifest.requires.aw.capabilities.includes('aw.skill-eval.v2'));
  assert.deepEqual(readdirSync(path.join(root, 'codex', 'skills')).sort(), ['run-aw-skill-evals']);

  const skillRoot = path.join(root, 'codex', 'skills', 'run-aw-skill-evals');
  const policyLines = readFileSync(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('allow_implicit_invocation:'));
  assert.deepEqual(policyLines, ['allow_implicit_invocation: true']);

  const args = [
    'skill', 'validate', windows ? '"%AW_TEST_SKILL_ROOT%"' : skillRoot,
    '--frontmatter-profile', 'portable-agent-skills',
    '--codex-metadata', 'required',
    '--json',
  ];
  // Windows npm/CI launchers need cmd; only fixed tokens enter its command text.
  const result = windows
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/v:off', '/s', '/c', `aw ${args.join(' ')}`], {
      encoding: 'utf8', windowsVerbatimArguments: true,
      env: { ...process.env, AW_TEST_SKILL_ROOT: skillRoot },
    })
    : spawnSync('aw', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).ok, true);
});
