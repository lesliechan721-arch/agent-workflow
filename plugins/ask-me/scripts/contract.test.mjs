import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { setupTriggerWorkspace as setupDecisionTriggerWorkspace } from '../skills/decision-grill/evals/trigger-fixture.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const localPluginRoot = path.resolve(scriptDir, '..');
const requiredSkills = ['decision-grill', 'decision-prototype', 'decision-shape'];
const leafSkills = ['decision-grill', 'decision-prototype'];
const execFileAsync = promisify(execFile);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function resolveContext() {
  if (!process.env.AW_PLUGIN_CONTEXT) {
    return {
      sourceRoot: localPluginRoot,
      bundleRoot: localPluginRoot,
      platform: null,
    };
  }

  const context = await readJson(process.env.AW_PLUGIN_CONTEXT);
  assert.equal(context.event, 'test');
  assert.equal(context.plugin.name, 'ask-me');
  assert.ok(['codex', 'claude'].includes(context.platform));
  return {
    sourceRoot: context.sourceRoot,
    bundleRoot: context.plugin.rootDir,
    platform: context.platform,
  };
}

function assertStrictStableSemver(value) {
  assert.match(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
}

function assertOpenAiMetadata(openaiYaml, skillName) {
  assert.match(openaiYaml, /^interface:/m);
  assert.match(openaiYaml, new RegExp(`\\$${skillName}\\b`));
  assert.match(openaiYaml, /^policy:\n  allow_implicit_invocation: true$/m);
}

function assertCaseDocument(document, participants) {
  const entries = Array.isArray(document.cases)
    ? document.cases
    : Array.isArray(document.evals)
      ? document.evals
      : [];
  assert.equal(entries.length > 0, true);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  for (const entry of entries) {
    assert.equal(typeof entry.id, 'string');
    if (entry.expected_loaded_skills !== undefined) {
      assert.equal(Array.isArray(entry.expected_loaded_skills), true);
      assert.equal(
        entry.expected_loaded_skills.every((skill) => participants.has(skill)),
        true,
      );
    }
    if (entry.should_load_skill !== undefined) {
      assert.equal(typeof entry.should_load_skill, 'boolean');
    }
  }
}

const context = await resolveContext();

test('manifest exposes the three decision Skills', async () => {
  const manifest = await readJson(path.join(context.sourceRoot, '.agents-plugin', 'plugin.json'));

  assert.equal(manifest.name, 'ask-me');
  assertStrictStableSemver(manifest.version);
  assert.equal(manifest.skills, './skills');
  assert.equal(manifest.extensions?.instructions?.length ?? 0, 0);
  assert.equal(manifest.config, undefined);
  assert.equal(manifest.artifacts, undefined);
  assert.equal(manifest.scripts.artifacts, undefined);
  assert.deepEqual(manifest.interface.capabilities, ['Skills']);
});

test('source package contains the three public Skills and native metadata', async () => {
  const sourceSkillNames = new Set(await readdir(path.join(context.sourceRoot, 'skills')));
  assert.deepEqual([...sourceSkillNames].sort(), [...requiredSkills].sort());
  for (const skillName of requiredSkills) {
    assert.equal(sourceSkillNames.has(skillName), true);
    const skillRoot = path.join(context.sourceRoot, 'skills', skillName);
    const [skill, openaiYaml] = await Promise.all([
      readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'),
      readFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8'),
    ]);
    assert.match(skill, new RegExp(`^name: ${skillName}$`, 'm'));
    assertOpenAiMetadata(openaiYaml, skillName);
  }
});

test('eval manifests point to parseable case documents with valid participant names', async () => {
  const participants = new Set(requiredSkills);
  for (const skillName of requiredSkills) {
    const evalRoot = path.join(context.sourceRoot, 'skills', skillName, 'evals');
    const manifest = await readJson(path.join(evalRoot, 'manifest.json'));
    assert.equal(manifest.plugin, 'ask-me');
    assert.equal(manifest.skill, skillName);
    assert.equal(Array.isArray(manifest.suites), true);
    assert.equal(manifest.suites.length > 0, true);

    for (const suite of manifest.suites) {
      assert.equal(Array.isArray(suite.skills), true);
      assert.equal(
        suite.skills.every((name) => participants.has(name)),
        true,
      );
      const casePath = path.resolve(evalRoot, suite.cases);
      await access(casePath);
      assertCaseDocument(await readJson(casePath), participants);
      if (suite.fixtureModule) {
        await access(path.resolve(evalRoot, suite.fixtureModule));
      }
    }
  }
});

test('leaf behavior stays independent and decision-shape owns composition', async () => {
  for (const skillName of leafSkills) {
    const manifest = await readJson(
      path.join(context.sourceRoot, 'skills', skillName, 'evals', 'manifest.json'),
    );
    const router = manifest.suites.find((suite) => suite.id === 'router');
    assert.deepEqual([...router.skills].sort(), [...leafSkills].sort());
    assert.equal(router.forbidMultipleSkillLoads, true);

    for (const suite of manifest.suites.filter((entry) => entry.kind === 'conversation')) {
      assert.deepEqual(suite.skills, [skillName]);
    }
  }

  const shapeManifest = await readJson(
    path.join(context.sourceRoot, 'skills', 'decision-shape', 'evals', 'manifest.json'),
  );
  const shapeRouter = shapeManifest.suites.find((suite) => suite.id === 'router');
  assert.deepEqual([...shapeRouter.skills].sort(), [...requiredSkills].sort());
  assert.equal(shapeRouter.forbidMultipleSkillLoads, false);
  const shapeBehavior = shapeManifest.suites.find((suite) => suite.id === 'behavior');
  assert.deepEqual([...shapeBehavior.skills].sort(), [...requiredSkills].sort());

  const prototypeRoot = path.join(context.sourceRoot, 'skills', 'decision-prototype', 'evals');
  const behavior = await readJson(
    path.join(prototypeRoot, 'decision-prototype-release-evals.json'),
  );
  assert.equal(behavior.skill_name, 'decision-prototype');
  assert.equal(Array.isArray(behavior.evals), true);
  assert.equal(behavior.evals.length > 0, true);
  for (const entry of behavior.evals) {
    assert.equal(entry.sandbox, 'workspace-write');
    assert.equal(entry.review.workspace_unchanged, false);
    assert.equal(entry.review.allowed_workspace_changes.length > 0, true);
    assert.equal(
      Object.keys(entry.workspace_files).some((file) => file.startsWith('src/')),
      true,
    );
    assert.equal(
      entry.review.artifacts.every((artifact) => artifact.path.startsWith('prototypes/')),
      true,
    );
  }
});

test('published leaf Skills stay independent and the macro stays generic', async () => {
  const grill = await readFile(
    path.join(context.sourceRoot, 'skills', 'decision-grill', 'SKILL.md'),
    'utf8',
  );
  const prototype = await readFile(
    path.join(context.sourceRoot, 'skills', 'decision-prototype', 'SKILL.md'),
    'utf8',
  );
  const shape = await readFile(
    path.join(context.sourceRoot, 'skills', 'decision-shape', 'SKILL.md'),
    'utf8',
  );

  // Static contract exception: leaf independence and reverse coupling are properties of the published instruction text itself, so runtime behavior cannot prove that the forbidden dependency is absent.
  assert.doesNotMatch(grill, /decision-shape|decision-prototype/);
  assert.doesNotMatch(prototype, /decision-shape|decision-grill/);
  assert.match(shape, /decision-grill/);
  assert.match(shape, /decision-prototype/);
  assert.doesNotMatch(shape, /dev-workflow|docs\/dev|Fast|Standard|Assured/);
});

function waitForJsonLine(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for server: ${stderr}`)), 5000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(null, JSON.parse(stdout.slice(0, newline)));
      } catch (error) {
        finish(error);
      }
    });
    child.once('exit', (code) => {
      if (!settled) finish(new Error(`Server exited with ${code}: ${stderr}`));
    });
  });
}

test('prototype review scripts create a bundle and enforce feedback identity and containment', async () => {
  const prototypeRoot = await mkdtemp(path.join(os.tmpdir(), 'ask-me-prototype-review-'));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'ask-me-prototype-outside-'));
  const skillsRoot = context.platform
    ? path.join(context.bundleRoot, context.platform, 'skills')
    : path.join(context.sourceRoot, 'skills');
  const skillRoot = path.join(skillsRoot, 'decision-prototype');
  const createScript = path.join(skillRoot, 'scripts', 'create-review-bundle.mjs');
  const serveScript = path.join(skillRoot, 'scripts', 'serve-review-bundle.mjs');
  async function createBundle(root, config) {
    await mkdir(root, { recursive: true });
    for (const option of config.options || []) {
      const artifact = path.resolve(root, option.artifact);
      if (!artifact.startsWith(`${root}${path.sep}`)) continue;
      await mkdir(path.dirname(artifact), { recursive: true });
      try {
        await access(artifact);
      } catch {
        await writeFile(artifact, option.kind === 'html' ? '<h1 data-prototype-id="fixture">Fixture</h1>\n' : 'fixture\n');
      }
    }
    await writeFile(path.join(root, 'prototype.json'), `${JSON.stringify(config, null, 2)}\n`);
    return execFileAsync(process.execPath, [createScript, '--prototype', path.join(root, 'prototype.json')]);
  }
  async function assertInvalidBundle(name, config, pattern) {
    const root = path.join(prototypeRoot, name);
    await assert.rejects(createBundle(root, config), pattern);
  }
  let server;
  try {
    await mkdir(path.join(prototypeRoot, 'artifact'), { recursive: true });
    await writeFile(
      path.join(prototypeRoot, 'artifact', 'option.html'),
      '<h1 data-prototype-id="heading">Option A</h1><p data-prototype-id="summary" data-prototype-kind="text">Summary</p><div data-prototype-id="approval" data-prototype-kind="node">Approval</div><script>parent.document.body.textContent = "forged"; fetch("/api/feedback", { method: "POST", body: "{}" });</script>\n',
    );
    await writeFile(path.join(outsideRoot, 'secret.txt'), 'outside\n');
    await symlink(path.join(outsideRoot, 'secret.txt'), path.join(prototypeRoot, 'artifact', 'escape.txt'));
    await writeFile(path.join(prototypeRoot, 'prototype.json'), `${JSON.stringify({
      schemaVersion: 1,
      id: 'approval-layout',
      revision: 2,
      question: 'Which layout is clearer?',
      stopCondition: 'One direction is accepted.',
      options: [{ id: 'a', label: 'Option A', kind: 'html', artifact: 'artifact/option.html' }],
    }, null, 2)}\n`);

    const created = await execFileAsync(process.execPath, [
      createScript,
      '--prototype', path.join(prototypeRoot, 'prototype.json'),
    ]);
    const receipt = JSON.parse(created.stdout);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.reviewUrlPath, '/review/index.html');
    const normalizedConfig = await readJson(path.join(prototypeRoot, 'review', 'config.json'));
    assert.equal(normalizedConfig.allowOther, true);
    assert.equal(normalizedConfig.allowAnnotations, false);
    assert.equal(normalizedConfig.htmlExecution, 'static');

    const capabilitiesRoot = path.join(prototypeRoot, 'capabilities');
    await createBundle(capabilitiesRoot, {
      ...normalizedConfig,
      id: 'combined-capabilities',
      allowOther: false,
      allowAnnotations: true,
      guidedQuestions: [{ id: 'risk', label: 'Is the risk visible?', choices: ['yes', 'no'] }],
      editableCssVariables: { '--space': ['8px', '16px'] },
    });
    const capabilitiesConfig = await readJson(path.join(capabilitiesRoot, 'review', 'config.json'));
    assert.equal(capabilitiesConfig.allowOther, false);
    assert.equal(capabilitiesConfig.allowAnnotations, true);
    assert.deepEqual(capabilitiesConfig.editableCssVariables, { '--space': ['8px', '16px'] });

    const sandboxedRoot = path.join(prototypeRoot, 'sandboxed');
    await createBundle(sandboxedRoot, {
      ...normalizedConfig,
      id: 'sandboxed-html',
      htmlExecution: 'sandboxed',
    });
    assert.equal(
      (await readJson(path.join(sandboxedRoot, 'review', 'config.json'))).htmlExecution,
      'sandboxed',
    );

    const invalidRoot = path.join(prototypeRoot, 'invalid');
    await mkdir(invalidRoot, { recursive: true });
    await writeFile(path.join(invalidRoot, 'prototype.json'), `${JSON.stringify({
      ...normalizedConfig,
      id: 7,
      unexpected: true,
    })}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, [createScript, '--prototype', path.join(invalidRoot, 'prototype.json')]),
      /prototype\.id must be string|prototype\.unexpected is not allowed/,
    );
    await assertInvalidBundle('obsolete-mode', {
      ...normalizedConfig,
      mode: 'guided',
    }, /prototype\.mode is not allowed/);
    await assertInvalidBundle('empty-guided', {
      ...normalizedConfig,
      guidedQuestions: [],
    }, /prototype\.guidedQuestions must contain at least 1 item/);
    await assertInvalidBundle('annotations-without-target', {
      ...normalizedConfig,
      allowAnnotations: true,
      options: [{ id: 'text', label: 'Text', kind: 'text', artifact: 'artifact/option.txt' }],
    }, /prototype\.allowAnnotations requires an image or static html option/);
    await assertInvalidBundle('empty-css-variables', {
      ...normalizedConfig,
      editableCssVariables: {},
    }, /prototype\.editableCssVariables must contain at least one CSS custom property/);
    await assertInvalidBundle('invalid-css-variable', {
      ...normalizedConfig,
      editableCssVariables: { space: ['8px'] },
    }, /prototype\.editableCssVariables\.space must start with "--"/);
    await assertInvalidBundle('sandboxed-css-variables', {
      ...normalizedConfig,
      htmlExecution: 'sandboxed',
      editableCssVariables: { '--space': ['8px'] },
    }, /prototype\.editableCssVariables requires at least one static html option/);
    await assertInvalidBundle('sandbox-without-html', {
      ...normalizedConfig,
      htmlExecution: 'sandboxed',
      options: [{ id: 'image', label: 'Image', kind: 'image', artifact: 'artifact/option.png' }],
    }, /prototype\.htmlExecution "sandboxed" requires at least one html option/);
    await assert.rejects(
      execFileAsync(process.execPath, [createScript, '--prototype', path.join(prototypeRoot, 'prototype.json'), '--output', 'elsewhere']),
      /Unknown argument: --output/,
    );

    const policyUrl = pathToFileURL(path.join(prototypeRoot, 'review', 'review-policy.mjs')).href;
    const policyInputs = [
      normalizedConfig,
      { ...normalizedConfig, allowAnnotations: true },
      {
        ...normalizedConfig,
        htmlExecution: 'sandboxed',
        allowAnnotations: true,
        options: [{ id: 'image', label: 'Image', kind: 'image', artifact: 'artifact/option.png' }],
      },
    ];
    const policyResult = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { annotationTargets, iframeSandbox, imageAnnotationTarget, markedAnnotationTarget } from ${JSON.stringify(policyUrl)}; const configs = JSON.parse(process.argv[1]); console.log(JSON.stringify({ sandboxes: configs.map(iframeSandbox), targets: configs.map(annotationTargets), annotations: [markedAnnotationTarget('a', 'heading'), markedAnnotationTarget('a', 'summary', 'text'), markedAnnotationTarget('a', 'approval', 'node'), imageAnnotationTarget('image', 0.25, 0.75), markedAnnotationTarget('a', 'bad', 'unknown'), markedAnnotationTarget('a', '', 'dom'), imageAnnotationTarget('image', 2, 0.5)] }));`,
      JSON.stringify(policyInputs),
    ]);
    assert.deepEqual(JSON.parse(policyResult.stdout), {
      sandboxes: ['allow-same-origin', 'allow-same-origin', 'allow-scripts'],
      targets: [[], ['dom', 'text', 'node'], ['image']],
      annotations: [
        { kind: 'dom', value: { optionId: 'a', elementId: 'heading' } },
        { kind: 'text', value: { optionId: 'a', elementId: 'summary' } },
        { kind: 'node', value: { optionId: 'a', elementId: 'approval' } },
        { kind: 'point', value: { optionId: 'image', x: 0.25, y: 0.75 } },
        null,
        null,
        null,
      ],
    });

    server = spawn(process.execPath, [serveScript, '--root', prototypeRoot, '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const started = await waitForJsonLine(server);
    assert.equal(started.ok, true);
    assert.match(await (await fetch(started.url)).text(), /Prototype Review/);
    const session = await (await fetch(new URL('/api/session', started.url))).json();
    assert.equal(typeof session.token, 'string');
    assert.equal(session.token.length > 20, true);
    const feedbackUrl = new URL('/api/feedback', started.url);
    const feedbackHeaders = {
      'content-type': 'application/json',
      'origin': new URL(started.url).origin,
      'x-prototype-review-token': session.token,
    };

    const feedback = {
      schemaVersion: 1,
      prototypeId: 'approval-layout',
      prototypeRevision: 2,
      verdict: 'accepted',
      selectedOptions: ['a'],
      answers: [],
      annotations: [
        {
          id: 'annotation-text',
          target: { kind: 'text', value: { optionId: 'a', elementId: 'summary' } },
          comment: 'Shorten this text.',
        },
        {
          id: 'annotation-node',
          target: { kind: 'node', value: { optionId: 'a', elementId: 'approval' } },
          comment: 'Move this step earlier.',
        },
      ],
      globalNotes: 'Option A is clear.',
    };
    const forged = await fetch(feedbackUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(feedback),
    });
    assert.equal(forged.status, 403);

    const wrongOrigin = await fetch(feedbackUrl, {
      method: 'POST',
      headers: { ...feedbackHeaders, origin: 'http://example.test' },
      body: JSON.stringify(feedback),
    });
    assert.equal(wrongOrigin.status, 403);

    const wrongType = await fetch(feedbackUrl, {
      method: 'POST',
      headers: { ...feedbackHeaders, 'content-type': 'text/plain' },
      body: JSON.stringify(feedback),
    });
    assert.equal(wrongType.status, 415);

    const stale = await fetch(feedbackUrl, {
      method: 'POST',
      headers: feedbackHeaders,
      body: JSON.stringify({ ...feedback, prototypeRevision: 1 }),
    });
    assert.equal(stale.status, 409);

    const invalid = await fetch(feedbackUrl, {
      method: 'POST',
      headers: feedbackHeaders,
      body: JSON.stringify({ ...feedback, schemaVersion: 2 }),
    });
    assert.equal(invalid.status, 400);

    const invalidNested = await fetch(feedbackUrl, {
      method: 'POST',
      headers: feedbackHeaders,
      body: JSON.stringify({ ...feedback, annotations: [null] }),
    });
    assert.equal(invalidNested.status, 400);

    const invalidTextTarget = await fetch(feedbackUrl, {
      method: 'POST',
      headers: feedbackHeaders,
      body: JSON.stringify({
        ...feedback,
        annotations: [{
          id: 'invalid-text',
          target: { kind: 'text', value: 'summary' },
          comment: 'Invalid target.',
        }],
      }),
    });
    assert.equal(invalidTextTarget.status, 400);

    const invalidPointTarget = await fetch(feedbackUrl, {
      method: 'POST',
      headers: feedbackHeaders,
      body: JSON.stringify({
        ...feedback,
        annotations: [{
          id: 'invalid-point',
          target: { kind: 'point', value: { optionId: 'image', x: 1.5, y: 0.5 } },
          comment: 'Invalid target.',
        }],
      }),
    });
    assert.equal(invalidPointTarget.status, 400);

    const invalidExtra = await fetch(feedbackUrl, {
      method: 'POST',
      headers: feedbackHeaders,
      body: JSON.stringify({ ...feedback, unexpected: true }),
    });
    assert.equal(invalidExtra.status, 400);

    const accepted = await fetch(feedbackUrl, {
      method: 'POST',
      headers: feedbackHeaders,
      body: JSON.stringify(feedback),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await readJson(path.join(prototypeRoot, 'feedback.json')), feedback);

    const escaped = await fetch(new URL('/artifact/escape.txt', started.url));
    assert.equal(escaped.status, 400);
  } finally {
    if (server && server.exitCode === null) server.kill('SIGTERM');
    await Promise.all([
      rm(prototypeRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
  }
});

test('plan-review cases receive an actual migration plan fixture', async () => {
  const roots = await Promise.all([
    mkdtemp(path.join(os.tmpdir(), 'ask-me-plan-review-trigger-')),
    mkdtemp(path.join(os.tmpdir(), 'ask-me-plan-review-router-')),
  ]);
  try {
    await setupDecisionTriggerWorkspace({
      workspaceRoot: roots[0],
      evalCase: { id: 'n03_one_shot_plan_review' },
    });
    await setupDecisionTriggerWorkspace({
      workspaceRoot: roots[1],
      evalCase: { id: 'plan_review' },
    });
    for (const root of roots) {
      const plan = await readFile(path.join(root, 'docs', 'migration-plan.md'), 'utf8');
      assert.match(plan, /Session expiry migration plan/);
      assert.match(plan, /## Rollback/);
      assert.match(plan, /## Known risks/);
    }
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test('prepared bundle renders the three static Skills', async () => {
  if (!context.platform) return;

  const platformManifest = await readJson(
    path.join(context.bundleRoot, `.${context.platform}-plugin`, 'plugin.json'),
  );
  assert.equal(platformManifest.name, 'ask-me');
  assert.equal(platformManifest.skills, `./${context.platform}/skills`);
  const expectedTool = context.platform === 'codex' ? '`request_user_input`' : '`AskUserQuestion`';
  const otherTool = context.platform === 'codex' ? '`AskUserQuestion`' : '`request_user_input`';

  for (const skillName of requiredSkills) {
    const skill = await readFile(
      path.join(context.bundleRoot, context.platform, 'skills', skillName, 'SKILL.md'),
      'utf8',
    );
    assert.equal(skill.includes(expectedTool), true);
    assert.equal(skill.includes(otherTool), false);
    assert.equal(skill.includes('{{questionTool}}'), false);
  }
});
