import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
const execFileAsync = promisify(execFile),
  local = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  ctx = process.env.AW_PLUGIN_CONTEXT
    ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
    : null,
  sourceRoot = ctx?.sourceRoot ?? local,
  runtimeRoot = ctx?.platform ? path.join(local, ctx.platform) : local,
  repo = path.resolve(sourceRoot, '..', '..'),
  temps = [];
after(async () => Promise.all(temps.map((p) => rm(p, { recursive: true, force: true }))));
async function run(script, args = [], cwd = repo) {
  return execFileAsync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}
test('canonical contracts are materialized without committed Skill copies', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(sourceRoot, '.agents-plugin/plugin.json'), 'utf8'),
  );
  assert.ok(manifest.buildConfig.skillRuntimeFiles.length > 0);
  for (const projection of manifest.buildConfig.skillRuntimeFiles) {
    const relative = path.join('skills', projection.skill, projection.target);
    await assert.rejects(readFile(path.join(sourceRoot, relative), 'utf8'));
    assert.ok((await readFile(path.join(runtimeRoot, relative), 'utf8')).length > 0, relative);
    if (projection.source) {
      assert.ok(
        (await readFile(path.join(sourceRoot, projection.source), 'utf8')).length > 0,
        projection.source,
      );
    }
  }
  for (const relative of [
    'skills/author-aw-plugin/references/skill-frontmatter-capabilities.generated.md',
    'skills/review-aw-plugin/assets/review-result-rules.generated.json',
  ]) {
    await assert.rejects(readFile(path.join(sourceRoot, relative), 'utf8'));
    assert.ok((await readFile(path.join(runtimeRoot, relative), 'utf8')).length > 200, relative);
  }
});
test('final Author Skill uses only stable CLI authoring commands', async () => {
  const skillRoot = path.join(runtimeRoot, 'skills/author-aw-plugin');
  const removedCopies = [
    'scripts/init_plugin.mjs',
    'scripts/add_skill.mjs',
    'scripts/validate_plugin.mjs',
    'scripts/check_plugin_versions.mjs',
    'scripts/lib/javascript-import-scanner.mjs',
    'scripts/lib/plugin-version-check.mjs',
    'scripts/lib/semver.mjs',
    'scripts/lib/skill-scaffold.mjs',
  ];
  for (const relative of removedCopies) {
    await assert.rejects(readFile(path.join(skillRoot, relative), 'utf8'), relative);
  }
  const skill = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
  // Static contract exception: installed agents must discover every public authoring command and must not execute an undeclared fallback; behavior test is not suitable because the consumer contract is the final Skill instruction itself.
  for (const command of ['init', 'add-skill', 'validate', 'check-versions']) {
    assert.match(skill, new RegExp(`aw plugin ${command} --help`, 'u'));
    assert.match(skill, new RegExp(`aw plugin ${command}(?: <| --)`, 'u'));
  }
  assert.match(skill, /aw --version/u);
  assert.match(skill, /不得使用 `npx`/u);
  assert.match(skill, /不得猜测仓库路径/u);
  assert.match(skill, /不得回退到本 Skill 的本地工具副本/u);
});
test('built CLI performs representative Author Skill operations', async () => {
  const cli = path.join(repo, 'packages', 'cli', 'dist', 'index.js');
  const fixture = path.join(
    repo,
    'packages',
    'cli',
    'tests',
    'fixtures',
    'repo-template',
  );
  const tRoot = await mkdtemp(path.join(tmpdir(), 'aw-plugin-cli-authoring-'));
  temps.push(tRoot);
  const workspace = path.join(tRoot, 'workspace');
  await cp(fixture, workspace, { recursive: true });
  const runAw = (args, cwd = repo) => run(cli, args, cwd);

  const version = await runAw(['--version']);
  assert.match(version.stdout, /\d+\.\d+\.\d+/u);
  for (const command of ['init', 'add-skill', 'validate', 'check-versions']) {
    const help = await runAw(['plugin', command, '--help']);
    assert.match(help.stdout, new RegExp(`aw plugin ${command}`, 'u'));
  }

  await runAw([
    'plugin',
    'init',
    'cli-authoring-fixture',
    '--description',
    'Fixture plugin for the stable authoring command contract.',
    '--skill-description',
    'Create and maintain the fixture plugin through the stable AW authoring command.',
    '--skill-short-description',
    'Maintain a fixture plugin with stable AW commands.',
    '--skill-invocation',
    'manual',
    '--repo-root',
    workspace,
    '--plugin-root',
    'tools/cli-authoring-fixture',
  ]);
  await runAw([
    'plugin',
    'add-skill',
    'cli-authoring-fixture',
    '--skill-name',
    'second-workflow',
    '--skill-description',
    'Run a second deterministic fixture workflow after explicit user invocation.',
    '--skill-short-description',
    'Run the second deterministic fixture workflow.',
    '--skill-invocation',
    'manual',
    '--repo-root',
    workspace,
    '--plugin-root',
    'tools/cli-authoring-fixture',
  ]);
  const pluginRoot = path.join(workspace, 'tools', 'cli-authoring-fixture');
  for (const skillName of ['cli-authoring-fixture', 'second-workflow']) {
    const skillPath = path.join(pluginRoot, 'skills', skillName, 'SKILL.md');
    const scaffold = await readFile(skillPath, 'utf8');
    await writeFile(
      skillPath,
      scaffold.replace(/\[TODO:[^\]]+\]/gu, 'Complete and verify the deterministic fixture task'),
      'utf8',
    );
  }
  const validation = await runAw(['plugin', 'validate', pluginRoot, '--json']);
  assert.equal(JSON.parse(validation.stdout).ok, true);

  const versionCheck = JSON.parse((await runAw([
    'plugin',
    'check-versions',
    'aw-plugin-development',
    '--base',
    'HEAD',
    '--repo-root',
    repo,
    '--json',
  ])).stdout);
  assert.equal(versionCheck.schemaVersion, 2);
  assert.equal(versionCheck.ok, true);
  assert.ok(versionCheck.checks.some((entry) => entry.plugin === 'aw-plugin-development'));
});
test('cacheable build is reproducible outside the repository cwd', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(sourceRoot, '.agents-plugin/plugin.json'), 'utf8'),
  );
  assert.equal(manifest.buildConfig.cacheable, true);
  const buildRoot = await mkdtemp(path.join(tmpdir(), 'aw-cacheable-build-'));
  temps.push(buildRoot);
  const declaredImports = {
    AW_PLUGIN_IMPORT_SKILL_FRONTMATTER_CAPABILITIES: path.join(
      repo,
      'packages/cli/src/utils/skill-frontmatter-capabilities.json',
    ),
    AW_PLUGIN_IMPORT_SKILL_RULES: path.join(
      repo,
      'plugins/agent-skill-toolkit/standards/skill-rules.json',
    ),
    AW_PLUGIN_IMPORT_REVIEW_DIMENSIONS: path.join(
      repo,
      'plugins/agent-skill-toolkit/standards/review-dimensions.json',
    ),
  };
  async function materialize(id) {
    const target = path.join(buildRoot, id, 'plugin');
    const cwd = path.join(buildRoot, id, 'unrelated-cwd');
    await cp(sourceRoot, target, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await execFileAsync(process.execPath, [path.join(target, 'scripts/build-runtime-assets.mjs')], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...declaredImports,
        AW_PLUGIN_UNDECLARED_BUILD_NOISE: id,
      },
    });
    return Promise.all([
      readFile(
        path.join(
          target,
          'skills/author-aw-plugin/references/skill-frontmatter-capabilities.generated.md',
        ),
      ),
      readFile(
        path.join(target, 'skills/review-aw-plugin/assets/review-result-rules.generated.json'),
      ),
    ]);
  }
  const [first, second] = await Promise.all([materialize('first'), materialize('second')]);
  assert.deepEqual(second, first);
});
test('review inspection expands related globs with the CLI production dependency closure', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-review-related-glob-'));
  temps.push(t);
  const cleanRepo = path.join(t, 'repository'),
    cleanCli = path.join(cleanRepo, 'packages', 'cli'),
    modules = path.join(cleanCli, 'node_modules'),
    cliPackage = JSON.parse(
      await readFile(path.join(repo, 'packages', 'cli', 'package.json'), 'utf8'),
    );
  await mkdir(modules, { recursive: true });
  await writeFile(
    path.join(cleanCli, 'package.json'),
    JSON.stringify({ type: 'module', dependencies: cliPackage.dependencies }),
  );
  for (const dependency of Object.keys(cliPackage.dependencies)) {
    const destination = path.join(modules, dependency);
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(
      path.join(repo, 'packages', 'cli', 'node_modules', dependency),
      destination,
      'junction',
    );
  }
  const target = path.join(cleanRepo, 'target'),
    roles = path.join(target, 'roles');
  await mkdir(roles, { recursive: true });
  await writeFile(path.join(target, 'SKILL.md'), '---\nname: target\ndescription: target\n---\n');
  await writeFile(
    path.join(roles, 'reader.toml'),
    'name = "reader"\ninstructions = "Read evidence."\n',
  );
  const result = JSON.parse(
    (
      await run(
        path.join(runtimeRoot, 'skills/review-aw-plugin/scripts/inspect-aw-target.mjs'),
        [
          target,
          '--repo-root',
          cleanRepo,
          '--related',
          path.join(roles, '*.toml'),
          '--format',
          'json',
        ],
        cleanRepo,
      )
    ).stdout,
  );
  assert.deepEqual(
    result.related_toml.files.map((entry) => entry.path),
    [path.join(roles, 'reader.toml')],
  );
});
test('author keeps README policy in plugin bundle', async () => {
  const [skill, ref] = await Promise.all([
    readFile(path.join(runtimeRoot, 'skills/author-aw-plugin/SKILL.md'), 'utf8'),
    readFile(
      path.join(runtimeRoot, 'skills/author-aw-plugin/references/aw-readme-authoring.md'),
      'utf8',
    ),
  ]);
  assert.match(skill, /references\/aw-readme-authoring\.md/u);
  assert.doesNotMatch(skill, /docs\/readme-standard\.md/u);
  assert.match(ref, /\.agents-plugin\/plugin\.json/u);
});
test('authoring context supports external workspace', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-author-'));
  temps.push(t);
  const ws = path.join(t, 'workspace'),
    target = path.join(ws, 'packages', 'p');
  await mkdir(path.join(target, '.agents-plugin'), { recursive: true });
  await writeFile(
    path.join(target, '.agents-plugin', 'plugin.json'),
    JSON.stringify({ name: 'p', marketplace: { policy: { products: ['CODEX', 'CLAUDE'] } } }),
  );
  const components = path.join(t, 'components.json');
  await writeFile(
    components,
    JSON.stringify([
      {
        id: 'skill',
        type: 'skill',
        operation: 'change',
        paths: ['skills/skill'],
        profiles: ['CLAUDE'],
        skillInvocation: 'claude-model-only',
      },
    ]),
  );
  const result = JSON.parse(
    (
      await run(
        path.join(runtimeRoot, 'skills/author-aw-plugin/scripts/prepare-aw-authoring-context.mjs'),
        [
          target,
          '--repo-root',
          ws,
          '--components',
          components,
        ],
      )
    ).stdout,
  );
  assert.equal(result.repository, 'workspace');
  assert.deepEqual(result.products, ['CODEX', 'CLAUDE']);
  assert.deepEqual(result.components[0].profiles, ['CLAUDE']);
});
test('starter adapter documents satisfy schemas', async () => {
  const validator = path.join(
    runtimeRoot,
    'skills/author-aw-plugin/scripts/validate-json-contract.mjs',
  );
  for (const [s, v] of [
    [
      'skills/author-aw-plugin/assets/aw-authoring-context.schema.json',
      'skills/author-aw-plugin/assets/aw-authoring-context.json',
    ],
    [
      'skills/review-aw-plugin/assets/aw-review-summary.schema.json',
      'skills/review-aw-plugin/assets/aw-review-summary.json',
    ],
    [
      'skills/review-aw-plugin/assets/review-input-bundle.schema.json',
      'skills/review-aw-plugin/assets/review-input-bundle.json',
    ],
  ])
    await run(validator, [path.join(runtimeRoot, s), path.join(runtimeRoot, v)]);
});
test('AW summary decision follows generic reviews and project gates', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-summary-'));
  temps.push(t);
  const v = JSON.parse(
    await readFile(
      path.join(runtimeRoot, 'skills/review-aw-plugin/assets/aw-review-summary.json'),
      'utf8',
    ),
  );
  v.design = 'pass';
  const p = path.join(t, 'summary.json');
  await writeFile(p, JSON.stringify(v));
  await assert.rejects(
    run(
      path.join(runtimeRoot, 'skills/review-aw-plugin/scripts/validate-aw-review-summary.mjs'),
      [p],
    ),
    /Command failed/u,
  );
});
test('final artifacts remain materials rather than completed review stages', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'aw-final-stage-'));
  temps.push(t);
  const repository = path.join(t, 'repository'),
    plugin = path.join(repository, 'plugins', 'agent-content-toolkit'),
    final = path.join(repository, '.tmp', 'final');
  await cp(path.join(repo, 'plugins', 'agent-content-toolkit'), plugin, { recursive: true });
  await mkdir(final, { recursive: true });
  await writeFile(path.join(final, 'SKILL.md'), '---\nname: fixture\ndescription: fixture\n---\n');
  const result = JSON.parse(
    (
      await run(
        path.join(runtimeRoot, 'skills/review-aw-plugin/scripts/prepare-aw-review-bundle.mjs'),
        [
          plugin,
          '--repo-root',
          repository,
          '--final',
          'codex=' + final,
        ],
      )
    ).stdout,
  );
  assert.ok(result.artifacts.some((a) => a.role === 'final'));
  assert.deepEqual(result.orchestration.providedStages, []);
});
test('adapter release version and dependency contract are current', async () => {
  const [manifest, dependency] = await Promise.all([
    readFile(path.join(sourceRoot, '.agents-plugin/plugin.json'), 'utf8').then(JSON.parse),
    readFile(path.join(sourceRoot, 'DEPENDENCY.md'), 'utf8'),
  ]);
  assert.equal(manifest.version, '0.8.4');
  assert.match(dependency, /agent-content-toolkit >= 0\.5\.0/u);
  // Static contract exception: AW 0.8.4 consumers must reject toolkit 0.7.0 because it lacks the ReviewInputBundle currentness contract; behavior test is not suitable because DEPENDENCY.md is the published manual dependency resolver input.
  const skillFloor = dependency.match(/agent-skill-toolkit >= (\d+\.\d+\.\d+)/u)?.[1];
  assert.equal(skillFloor, '0.7.1');
  const parts = (version) => version.split('.').map(Number);
  const satisfies = (version) => {
    const candidate = parts(version), floor = parts(skillFloor);
    const difference = candidate.findIndex((value, index) => value !== floor[index]);
    return difference === -1 || candidate[difference] > floor[difference];
  };
  assert.equal(satisfies('0.7.0'), false);
  assert.equal(satisfies('0.7.1'), true);
  assert.match(dependency, /agent-skill-eval-runner >= 0\.3\.0/u);
});
