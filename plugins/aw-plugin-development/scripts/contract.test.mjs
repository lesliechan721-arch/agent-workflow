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
  const final = path.join(t, 'final');
  await mkdir(final, { recursive: true });
  await writeFile(path.join(final, 'SKILL.md'), '---\nname: fixture\ndescription: fixture\n---\n');
  const result = JSON.parse(
    (
      await run(
        path.join(runtimeRoot, 'skills/review-aw-plugin/scripts/prepare-aw-review-bundle.mjs'),
        [
          path.join(repo, 'plugins', 'agent-content-toolkit'),
          '--repo-root',
          repo,
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
  assert.equal(manifest.version, '0.7.0');
  assert.match(dependency, /agent-content-toolkit >= 0\.5\.0/u);
  assert.match(dependency, /agent-skill-toolkit >= 0\.7\.0/u);
  assert.match(dependency, /agent-skill-eval-runner >= 0\.3\.0/u);
});
