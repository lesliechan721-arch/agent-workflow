import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The macOS test harness may expose /var, an alias of /private/var. The tool
// deliberately rejects symlink target chains, so validate the real bundle root.
const root = realpathSync(process.env.AW_PLUGIN_ROOT);
const windows = process.platform === 'win32';
const skills = [
  'agent-skill',
  'audit-agent-skill-evals',
];

function runtimeSkill(platform, name) {
  return path.join(root, platform, 'skills', name);
}

test('publishes two model-callable Skills with valid public metadata', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, '.agents-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'agent-skill-toolkit');
  assert.ok(!(manifest.requires?.aw?.capabilities ?? []).includes('aw.review-publication.v1'));
  for (const platform of ['codex', 'claude']) {
    assert.deepEqual(readdirSync(path.join(root, platform, 'skills')).sort(), [...skills].sort());
    for (const skill of skills) {
      const frontmatter = readFileSync(path.join(runtimeSkill(platform, skill), 'SKILL.md'), 'utf8')
        .split(/^---\s*$/mu)[1].split(/\r?\n/u).map(line => line.trim());
      assert.equal(frontmatter.includes('disable-model-invocation: true'), false, `${platform}/${skill}`);
      assert.equal(frontmatter.includes('user-invocable: false'), false, `${platform}/${skill}`);
    }
  }

  for (const skill of skills) {
    const skillRoot = runtimeSkill('codex', skill);
    const policyLines = readFileSync(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('allow_implicit_invocation:'));
    assert.deepEqual(policyLines, ['allow_implicit_invocation: true'], skill);

    const args = [
      'dev', 'skill', 'validate', windows ? '"%AW_TEST_SKILL_ROOT%"' : skillRoot,
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
    assert.equal(JSON.parse(result.stdout).status, 'success');
  }
});

test('materializes co-located references and independent tools on both platforms', () => {
  const targets = [
    ['agent-skill', 'references/design-and-validation.md'],
    ['agent-skill', 'references/skill-invocation.md'],
    ['agent-skill', 'references/skill-composition.md'],
    ['agent-skill', 'references/skill-format.md'],
    ['agent-skill', 'references/trigger-development.md'],
    ['agent-skill', 'references/script-authoring.md'],
    ['agent-skill', 'references/eval-design.md'],
    ['agent-skill', 'references/ablation-acceptance.md'],
    ['agent-skill', 'scripts/init-skill.mjs'],
    ['agent-skill', 'scripts/check-skill.mjs'],
    ['agent-skill', 'assets/tooling-NOTICE.txt'],
    ['audit-agent-skill-evals', 'references/eval-audit-standard.md'],
    ['audit-agent-skill-evals', 'references/formal-admission.md'],
  ];
  for (const platform of ['codex', 'claude']) {
    for (const [skill, relative] of targets) {
      const file = path.join(runtimeSkill(platform, skill), relative);
      assert.equal(statSync(file).isFile(), true, `${platform}/${skill}/${relative}`);
      if (relative.startsWith('scripts/')) {
        const result = spawnSync(process.execPath, [file, '--help'], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
      }
    }
    for (const retired of ['author-agent-skill', 'review-agent-skill', 'simplify-agent-skill']) {
      assert.equal(existsSync(runtimeSkill(platform, retired)), false, `${platform}/${retired}`);
    }
    const checker = path.join(runtimeSkill(platform, 'agent-skill'), 'scripts/check-skill.mjs');
    for (const skill of skills) {
      const result = spawnSync(process.execPath, [checker, runtimeSkill(platform, skill), '--format', 'json'], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
      assert.equal(receipt.complete, true, JSON.stringify(receipt));
    }
  }
});
