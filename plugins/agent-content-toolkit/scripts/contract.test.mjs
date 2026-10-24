import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.env.AW_PLUGIN_ROOT;
const windows = process.platform === 'win32';

function codexSkill(name) {
  return path.join(root, 'codex', 'skills', name);
}

function invocationPolicy(name) {
  const lines = readFileSync(path.join(codexSkill(name), 'agents', 'openai.yaml'), 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('allow_implicit_invocation:'));
  assert.deepEqual(lines, ['allow_implicit_invocation: true']);
}

test('publishes one model-callable Skill with valid public metadata', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, '.agents-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'agent-content-toolkit');
  assert.deepEqual(readdirSync(path.join(root, 'codex', 'skills')).sort(), ['agent-content']);
  invocationPolicy('agent-content');

  const skillRoot = codexSkill('agent-content');
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
