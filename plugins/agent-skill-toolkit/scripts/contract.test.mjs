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
  'author-agent-skill',
  'review-agent-skill',
  'simplify-agent-skill',
  'audit-agent-skill-evals',
];
const manualSkills = new Set(['review-agent-skill', 'simplify-agent-skill']);

function runtimeSkill(platform, name) {
  return path.join(root, platform, 'skills', name);
}

test('publishes four Skills with explicit review and simplification policies', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, '.agents-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'agent-skill-toolkit');
  assert.ok(!(manifest.requires?.aw?.capabilities ?? []).includes('aw.review-publication.v1'));
  for (const platform of ['codex', 'claude']) {
    assert.deepEqual(readdirSync(path.join(root, platform, 'skills')).sort(), [...skills].sort());
    for (const skill of skills) {
      const frontmatter = readFileSync(path.join(runtimeSkill(platform, skill), 'SKILL.md'), 'utf8')
        .split(/^---\s*$/mu)[1].split(/\r?\n/u).map(line => line.trim());
      assert.equal(frontmatter.includes('disable-model-invocation: true'), manualSkills.has(skill), `${platform}/${skill}`);
      assert.equal(frontmatter.includes('user-invocable: false'), false, `${platform}/${skill}`);
      if (manualSkills.has(skill)) assert.ok(frontmatter.includes('user-invocable: true'), `${platform}/${skill}`);
    }
  }

  for (const skill of skills) {
    const skillRoot = runtimeSkill('codex', skill);
    const policyLines = readFileSync(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('allow_implicit_invocation:'));
    assert.deepEqual(policyLines, [`allow_implicit_invocation: ${!manualSkills.has(skill)}`], skill);

    const args = [
      'skill', 'validate', windows ? '"%AW_TEST_SKILL_ROOT%"' : skillRoot,
      '--frontmatter-profile', manualSkills.has(skill) ? 'claude-current' : 'portable-agent-skills',
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

test('materializes shared methods and independent tools on both platforms', () => {
  const targets = [
    ['author-agent-skill', 'references/skill-invocation.md'],
    ['author-agent-skill', 'references/skill-composition.md'],
    ['author-agent-skill', 'references/skill-format.md'],
    ['author-agent-skill', 'scripts/init-skill.mjs'],
    ['author-agent-skill', 'scripts/check-skill.mjs'],
    ['author-agent-skill', 'assets/tooling-NOTICE.txt'],
    ['simplify-agent-skill', 'references/skill-composition.md'],
    ['simplify-agent-skill', 'references/skill-format.md'],
    ['simplify-agent-skill', 'scripts/check-skill.mjs'],
    ['simplify-agent-skill', 'assets/tooling-NOTICE.txt'],
    ['review-agent-skill', 'references/skill-invocation.md'],
    ['review-agent-skill', 'references/skill-composition.md'],
    ['review-agent-skill', 'references/skill-format.md'],
    ['review-agent-skill', 'scripts/check-skill.mjs'],
    ['review-agent-skill', 'assets/tooling-NOTICE.txt'],
    ['review-agent-skill', 'references/architecture-review.md'],
    ['review-agent-skill', 'references/public-surface-review.md'],
  ];
  for (const platform of ['codex', 'claude']) {
    const copies = new Map();
    for (const [skill, relative] of targets) {
      const file = path.join(runtimeSkill(platform, skill), relative);
      assert.equal(statSync(file).isFile(), true);
      const bytes = readFileSync(file);
      if (copies.has(relative)) assert.deepEqual(bytes, copies.get(relative), `${platform}/${relative}`);
      else copies.set(relative, bytes);
      if (relative.startsWith('scripts/')) {
        const result = spawnSync(process.execPath, [file, '--help'], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
      }
    }
    for (const oldName of ['invocation-and-description.md', 'composition-audit.md']) {
      assert.equal(existsSync(path.join(runtimeSkill(platform, 'author-agent-skill'), 'references', oldName)), false);
    }
    const checker = path.join(runtimeSkill(platform, 'author-agent-skill'), 'scripts/check-skill.mjs');
    for (const skill of skills) {
      const result = spawnSync(process.execPath, [checker, runtimeSkill(platform, skill), '--format', 'json'], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.ok, true);
      assert.equal(receipt.complete, true);
    }
  }
});
