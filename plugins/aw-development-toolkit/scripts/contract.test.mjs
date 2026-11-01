import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.env.AW_PLUGIN_ROOT;
const windows = process.platform === 'win32';
const invocation = new Map([
  ['develop-aw', true],
  ['publish-aw-catalog', false],
]);

function runtimeSkill(platform, name) {
  return path.join(root, platform, 'skills', name);
}

test('publishes one AW development entry and one manual-only Publisher', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, '.agents-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'aw-development-toolkit');
  assert.ok(manifest.requires.aw.capabilities.includes('aw.review-preparation.v1'));
  assert.ok(manifest.requires.aw.capabilities.includes('aw.portable-skills.v1'));
  assert.ok(manifest.requires.aw.capabilities.includes('aw.review-inspection.v2'));
  assert.equal(manifest.requires.aw.capabilities.includes('aw.review-inspection.v1'), false);
  assert.equal(manifest.requires.aw.capabilities.includes('aw.review-publication.v1'), false);
  assert.equal(manifest.buildConfig?.runtimeExports?.some(entry => entry.name === 'review-publication-reference') ?? false, false);
  for (const platform of ['codex', 'claude']) {
    assert.deepEqual(readdirSync(path.join(root, platform, 'skills')).sort(), [...invocation.keys()].sort());
  }

  for (const [skill, expected] of invocation) {
    const skillRoot = runtimeSkill('codex', skill);
    const policyLines = readFileSync(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('allow_implicit_invocation:'));
    assert.deepEqual(policyLines, [`allow_implicit_invocation: ${expected}`], skill);

    const args = [
      'skill', 'validate', windows ? '"%AW_TEST_SKILL_ROOT%"' : skillRoot,
      '--frontmatter-profile', 'claude-current',
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
  }
});

test('materializes complete AW methods on both platforms', () => {
  for (const platform of ['codex', 'claude']) {
    const skillRoot = runtimeSkill(platform, 'develop-aw');
    for (const relative of [
      'references/source-materialization.md',
      'references/plugin-development.md',
      'references/plugin-components.md',
      'references/managed-commands.md',
      'references/build-and-sharing.md',
      'references/platform-projection.md',
      'references/catalog-development.md',
      'references/portable-skills.md',
      'references/aw-domain-review.md',
      'references/aw-artifact-renderer.md',
      'references/aw-pre-apply.md',
      'references/development-source.md',
    ]) assert.equal(statSync(path.join(skillRoot, relative)).isFile(), true, `${platform}/${relative}`);
    for (const relative of [
      'references/plugin-removal.md',
      'references/release-check.md',
      'references/report-publication.md',
      'assets/aw-review-evidence.schema.json',
      'assets/aw-review-evidence.template.json',
      'scripts/check-aw-release.mjs',
    ]) assert.equal(existsSync(path.join(skillRoot, relative)), false, `${platform}/${relative}`);
  }
});
