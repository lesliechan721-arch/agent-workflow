import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { setupTriggerWorkspace as setupDecisionTriggerWorkspace } from '../skills/decision-grill/evals/trigger-fixture.mjs';
import {
  gradeBuilderWorkflow,
  prepareBuilderWorkflow,
} from '../skills/decision-prototype/evals/prototype-builder-workflow.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const localPluginRoot = path.resolve(scriptDir, '..');
const requiredSkills = ['decision-grill', 'decision-prototype', 'decision-shape'];
const leafSkills = ['decision-grill', 'decision-prototype'];
const questionToolSkills = new Set(['decision-grill']);

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

function assertCaseDocument(document, skillName, availableSkills) {
  assert.equal(document.version, 1);
  assert.equal(document.suite?.unitUnderTest, skillName);
  assert.equal(Array.isArray(document.suite?.participants ?? []), true);
  const participants = new Set([
    document.suite.unitUnderTest,
    ...(document.suite.participants ?? []),
  ]);
  assert.equal([...participants].every((skill) => availableSkills.has(skill)), true);
  const entries = document.cases;
  assert.equal(Array.isArray(entries), true);
  assert.equal(entries.length > 0, true);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  for (const entry of entries) {
    assert.equal(typeof entry.id, 'string');
    if (document.suite.kind === 'trigger') {
      assert.equal(typeof entry.input?.query, 'string');
      const expectedLoad = entry.input?.expectedLoad;
      const loadedSkills = entry.input?.expected?.loadedSkills;
      assert.equal(expectedLoad !== undefined || loadedSkills !== undefined, true);
      if (expectedLoad !== undefined) assert.equal(typeof expectedLoad, 'boolean');
      if (loadedSkills !== undefined) {
        assert.equal(Array.isArray(loadedSkills), true);
        assert.equal(loadedSkills.every((skill) => participants.has(skill)), true);
      }
    } else if (document.suite.kind === 'conversation') {
      assert.equal(typeof entry.prompt, 'string');
      assert.equal(entry.prompt.trim().length > 0, true);
      assert.equal(Array.isArray(entry.assertions), true);
      assert.equal(entry.assertions.length > 0, true);
      assert.equal(entry.assertions.every((assertion) => (
        typeof assertion === 'string' && assertion.trim().length > 0
      )), true);
    } else if (document.suite.kind === 'codex-workflow') {
      assert.equal(entry.input && typeof entry.input === 'object', true);
      assert.equal(entry.expected !== undefined || entry.assertions !== undefined, true);
    }
  }
  return document;
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

test('decision-prototype keeps Builder ownership inside artifact', async () => {
  const skill = await readFile(
    path.join(context.sourceRoot, 'skills', 'decision-prototype', 'SKILL.md'),
    'utf8',
  );
  assert.match(skill, /优先使用 Builder 子代理/u);
  assert.match(skill, /Builder 只创建或修改 `artifact\/\*\*`/u);
  assert.match(skill, /主代理拥有 `brief\.md`、`prototype\.json`、用户反馈和 `verdict\.md`/u);
  assert.match(skill, /没有可用子代理、委派失败/u);
});

test('eval manifests point to parseable case documents with valid participant names', async () => {
  const participants = new Set(requiredSkills);
  for (const skillName of requiredSkills) {
    const evalRoot = path.join(context.sourceRoot, 'skills', skillName, 'evals');
    const manifest = await readJson(path.join(evalRoot, 'manifest.json'));
    assert.equal(manifest.version, 1);
    assert.equal(Array.isArray(manifest.suites), true);
    assert.equal(manifest.suites.length > 0, true);

    for (const suite of manifest.suites) {
      const casePath = path.resolve(evalRoot, suite.cases);
      await access(casePath);
      assertCaseDocument(await readJson(casePath), skillName, participants);
      if (suite.fixtureModule) {
        await access(path.resolve(evalRoot, suite.fixtureModule));
      }
      if (suite.kind === 'codex-workflow') {
        assert.equal(suite.provider?.type, 'codex-workflow');
        assert.equal(Array.isArray(suite.provider.command), true);
        assert.equal(suite.provider.command[0], 'node');
        await access(path.resolve(evalRoot, suite.provider.command[1]));
      }
    }
  }
});

function workflowEvidence(overrides = {}) {
  return {
    version: 1,
    rootThreadId: 'root',
    completion: { status: 'completed' },
    termination: {
      reason: 'completed',
      appServerProcessTreeCleanupConfirmed: true,
    },
    cleanup: { isolatedCodexHomeRemoved: true },
    workspaceDiff: { added: [], modified: [], removed: [] },
    skillLoads: [{ threadId: 'root', skill: 'decision-prototype', callId: 'read-skill' }],
    threadGraph: [{ threadId: 'root', parentThreadId: null }],
    collaborationCalls: [],
    ...overrides,
  };
}

async function workflowFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ask-me-builder-workflow-'));
  const paths = {
    workspace: path.join(root, 'workspace', 'subject'),
    fixtures: path.join(root, 'workspace', 'eval'),
    output: path.join(root, 'output'),
    evidence: path.join(root, 'output', 'workflow-evidence.json'),
    modelOutput: path.join(root, 'output', 'model-output.txt'),
  };
  await Promise.all([
    mkdir(paths.workspace, { recursive: true }),
    mkdir(paths.fixtures, { recursive: true }),
    mkdir(paths.output, { recursive: true }),
  ]);
  const schemaTarget = path.join(
    paths.workspace,
    '.agents',
    'skills',
    'decision-prototype',
    'assets',
    'prototype.schema.json',
  );
  await mkdir(path.dirname(schemaTarget), { recursive: true });
  await writeFile(schemaTarget, await readFile(path.join(
    context.sourceRoot,
    'skills',
    'decision-prototype',
    'assets',
    'prototype.schema.json',
  )));
  return { root, paths };
}

test('decision-prototype Builder workflow grades normalized ownership evidence', async () => {
  const evalRoot = path.join(
    context.sourceRoot,
    'skills',
    'decision-prototype',
    'evals',
  );
  const corpus = await readJson(path.join(evalRoot, 'prototype-builder-workflow-cases.json'));
  const persistent = corpus.cases.find((entry) => entry.id === 'persistent-artifact-uses-builder');
  const technical = corpus.cases.find((entry) => entry.id === 'technical-spike-builder-runs-evidence');
  const direct = corpus.cases.find((entry) => entry.id === 'direct-chat-example-stays-local');
  assert.ok(persistent);
  assert.ok(technical);
  assert.ok(direct);
  const fixtures = [await workflowFixture(), await workflowFixture(), await workflowFixture()];
  try {
    const prepared = await prepareBuilderWorkflow({
      case: persistent,
      paths: fixtures[0].paths,
    });
    assert.equal(prepared.sandbox, 'workspace-write');
    assert.equal(prepared.roles[0].name, 'prototype-builder');
    assert.equal(prepared.roles[0].configFile, '.codex/agents/prototype-builder.toml');
    assert.match(
      await readFile(path.join(fixtures[0].paths.workspace, prepared.roles[0].configFile), 'utf8'),
      /只创建或修改指定 Prototype 的 artifact\/\*\*/u,
    );

    const prototypeRoot = path.join(
      fixtures[0].paths.workspace,
      'prototypes',
      'settings-density',
    );
    await mkdir(path.join(prototypeRoot, 'artifact'), { recursive: true });
    await Promise.all([
      writeFile(path.join(prototypeRoot, 'brief.md'), '# 设置页信息密度\n'),
      writeFile(path.join(prototypeRoot, 'prototype.json'), JSON.stringify({
        schemaVersion: 2,
        id: 'settings-density',
        revision: 1,
        question: '设置页应使用哪一种信息密度？',
        decisionContext: {
          goal: '选择设置页信息密度',
          priorities: ['可读性'],
          constraints: ['临时原型'],
        },
        selectionMode: 'single',
        options: [
          { id: 'compact', label: '紧凑', kind: 'html', artifact: 'artifact/compact.html' },
          { id: 'comfortable', label: '舒适', kind: 'html', artifact: 'artifact/comfortable.html' },
        ],
        stopCondition: '用户选择一种密度或要求修订',
      })),
      writeFile(path.join(prototypeRoot, 'artifact', 'compact.html'), '<h1>紧凑 临时原型</h1>\n'),
      writeFile(path.join(prototypeRoot, 'artifact', 'comfortable.html'), '<h1>舒适 临时原型</h1>\n'),
    ]);
    const added = [
      'prototypes/settings-density/brief.md',
      'prototypes/settings-density/prototype.json',
      'prototypes/settings-density/artifact/compact.html',
      'prototypes/settings-density/artifact/comfortable.html',
    ];
    const evidence = workflowEvidence({
      workspaceDiff: { added, modified: [], removed: [] },
      threadGraph: [
        { threadId: 'root', parentThreadId: null },
        { threadId: 'builder', parentThreadId: 'root', agentRole: 'prototype-builder' },
      ],
      collaborationCalls: [
        {
          threadId: 'root',
          tool: 'exec',
          arguments: {
            input: 'const patch = "*** Begin Patch\\n*** Add File: /workspace/prototypes/settings-density/brief.md\\n*** Add File: /workspace/prototypes/settings-density/prototype.json\\n*** End Patch"; text(await tools.apply_patch(patch));',
          },
        },
        {
          threadId: 'root',
          tool: 'spawn_agent',
          arguments: { agent_type: 'prototype-builder' },
        },
        {
          threadId: 'builder',
          tool: 'exec',
          arguments: {
            input: 'const patch = "*** Begin Patch\\n*** Add File: /workspace/prototypes/settings-density/artifact/compact.html\\n*** Add File: /workspace/prototypes/settings-density/artifact/comfortable.html\\n*** End Patch"; text(await tools.apply_patch(patch));',
          },
        },
        {
          threadId: 'root',
          linkedThreadId: 'builder',
          tool: 'wait_agent',
          output: { status: { builder: { completed: 'done' } } },
        },
      ],
    });
    await Promise.all([
      writeFile(fixtures[0].paths.evidence, JSON.stringify(evidence)),
      writeFile(fixtures[0].paths.modelOutput, '候选已准备，等待用户决定。\n'),
    ]);
    const passing = await gradeBuilderWorkflow({
      case: persistent,
      variant: 'current',
      paths: fixtures[0].paths,
    });
    assert.equal(passing.passed, true, JSON.stringify(passing.details));

    const builderThread = evidence.threadGraph[1];
    const builderSpawn = evidence.collaborationCalls.find((entry) => entry.tool === 'spawn_agent');
    builderThread.agentRole = 'worker';
    builderSpawn.arguments.agent_type = 'worker';
    await writeFile(fixtures[0].paths.evidence, JSON.stringify(evidence));
    const genericBuilder = await gradeBuilderWorkflow({
      case: persistent,
      variant: 'current',
      paths: fixtures[0].paths,
    });
    assert.equal(genericBuilder.passed, true, JSON.stringify(genericBuilder.details));
    assert.equal(
      genericBuilder.details.assertions.find((entry) => entry.name === 'builder_delegation').passed,
      true,
    );
    builderThread.agentRole = 'prototype-builder';
    builderSpawn.arguments.agent_type = 'prototype-builder';
    await writeFile(fixtures[0].paths.evidence, JSON.stringify(evidence));

    const validPrototype = await readFile(path.join(prototypeRoot, 'prototype.json'), 'utf8');
    await writeFile(path.join(prototypeRoot, 'prototype.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'settings-density',
      revision: 1,
      selectionMode: 'unsupported',
      unexpected: true,
    }));
    const invalidSchema = await gradeBuilderWorkflow({
      case: persistent,
      variant: 'current',
      paths: fixtures[0].paths,
    });
    assert.equal(invalidSchema.passed, false);
    assert.equal(
      invalidSchema.details.assertions.find((entry) => entry.name === 'prototype_schema').passed,
      false,
    );
    await writeFile(path.join(prototypeRoot, 'prototype.json'), validPrototype);

    evidence.collaborationCalls[0].arguments.input += ' *** Add File: /workspace/prototypes/settings-density/artifact/compact.html\\n';
    await writeFile(fixtures[0].paths.evidence, JSON.stringify(evidence));
    const wrongOwner = await gradeBuilderWorkflow({
      case: persistent,
      variant: 'current',
      paths: fixtures[0].paths,
    });
    assert.equal(wrongOwner.passed, false);
    assert.equal(
      wrongOwner.details.assertions.find((entry) => (
        entry.name === 'builder_owns:prototypes/settings-density/artifact/compact.html'
      )).passed,
      false,
    );

    await prepareBuilderWorkflow({ case: technical, paths: fixtures[1].paths });
    const spikeRoot = path.join(
      fixtures[1].paths.workspace,
      'prototypes',
      'web-crypto-runtime',
    );
    await mkdir(path.join(spikeRoot, 'artifact'), { recursive: true });
    await Promise.all([
      writeFile(path.join(spikeRoot, 'brief.md'), '# Node.js Web Crypto spike\n\n浏览器兼容范围不在本轮证据内。\n'),
      writeFile(path.join(spikeRoot, 'prototype.json'), JSON.stringify({
        schemaVersion: 2,
        id: 'web-crypto-runtime',
        revision: 1,
        question: '当前 Node.js 是否提供 Web Crypto？',
        decisionContext: {
          goal: '确认当前 Node.js 的 Web Crypto 能力',
          priorities: ['可重复证据'],
          constraints: ['不代表浏览器兼容性'],
        },
        selectionMode: 'single',
        options: [{
          id: 'runtime-result',
          label: 'Node.js Web Crypto 结果',
          kind: 'metrics',
          artifact: 'artifact/result.txt',
        }],
        stopCondition: '记录当前运行时证据并保留浏览器范围问题',
      })),
      writeFile(path.join(spikeRoot, 'artifact', 'spike.mjs'), 'console.log("Web Crypto supported")\n'),
      writeFile(path.join(spikeRoot, 'artifact', 'result.txt'), [
        'globalThis.crypto.present=true',
        'crypto.subtle.present=true',
        'getRandomValues.call=ok',
        'subtle.digest.call=ok',
        `subtle.digest.sha256=${'a'.repeat(64)}`,
        '',
      ].join('\n')),
    ]);
    const spikeEvidence = workflowEvidence({
      workspaceDiff: {
        added: [
          'prototypes/web-crypto-runtime/brief.md',
          'prototypes/web-crypto-runtime/prototype.json',
          'prototypes/web-crypto-runtime/artifact/spike.mjs',
          'prototypes/web-crypto-runtime/artifact/result.txt',
        ],
        modified: [],
        removed: [],
      },
      threadGraph: [
        { threadId: 'root', parentThreadId: null },
        { threadId: 'builder', parentThreadId: 'root', agentRole: 'prototype-builder' },
      ],
      collaborationCalls: [
        {
          threadId: 'root',
          tool: 'exec',
          arguments: {
            input: 'const patch = "*** Begin Patch\\n*** Add File: /workspace/prototypes/web-crypto-runtime/brief.md\\n*** Add File: /workspace/prototypes/web-crypto-runtime/prototype.json\\n*** End Patch"; text(await tools.apply_patch(patch));',
          },
        },
        {
          threadId: 'root',
          tool: 'spawn_agent',
          arguments: { agent_type: 'prototype-builder' },
        },
        {
          threadId: 'builder',
          tool: 'exec',
          arguments: { input: 'const patch = "*** Begin Patch\\n*** Add File: /workspace/prototypes/web-crypto-runtime/artifact/spike.mjs\\n*** Add File: /workspace/prototypes/web-crypto-runtime/artifact/result.txt\\n*** End Patch"; text(await tools.apply_patch(patch));' },
        },
        {
          threadId: 'builder',
          tool: 'exec_command',
          arguments: {
            cmd: 'node prototypes/web-crypto-runtime/artifact/spike.mjs > prototypes/web-crypto-runtime/artifact/result.txt',
          },
        },
        {
          threadId: 'root',
          linkedThreadId: 'builder',
          tool: 'wait_agent',
          output: { status: { builder: { completed: 'done' } } },
        },
      ],
    });
    await Promise.all([
      writeFile(fixtures[1].paths.evidence, JSON.stringify(spikeEvidence)),
      writeFile(fixtures[1].paths.modelOutput, 'Web Crypto 证据已保存。\n'),
    ]);
    const spikeGrade = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(spikeGrade.passed, true, JSON.stringify(spikeGrade.details));
    const fixedEvidence = await readFile(path.join(spikeRoot, 'artifact', 'result.txt'), 'utf8');
    await writeFile(path.join(spikeRoot, 'artifact', 'result.txt'), [
      'Web Crypto runtime spike',
      JSON.stringify({
        globalThisCrypto: true,
        globalThisCryptoSubtle: true,
        sha256Probe: 'a'.repeat(64),
      }, null, 2),
      '',
    ].join('\n'));
    const jsonEvidenceGrade = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(jsonEvidenceGrade.passed, true, JSON.stringify(jsonEvidenceGrade.details));

    await writeFile(path.join(spikeRoot, 'artifact', 'result.txt'), JSON.stringify({
      checks: {
        globalThisCrypto: {
          present: true,
          hasSubtle: true,
        },
      },
      probe: {
        success: true,
        sha256Hex: 'a'.repeat(64),
      },
    }, null, 2));
    const nestedJsonEvidenceGrade = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(
      nestedJsonEvidenceGrade.passed,
      true,
      JSON.stringify(nestedJsonEvidenceGrade.details),
    );

    await writeFile(path.join(spikeRoot, 'artifact', 'result.txt'), [
      'timestamp: 2026-09-03T02:16:11.751Z',
      'node_version: v24.14.1',
      'globalThis.crypto: present',
      'crypto.subtle: present',
      'digest_sha256_status: ok',
      `digest_sha256_hex: ${'a'.repeat(64)}`,
      'errors: none',
      'web_crypto_available: yes',
      '',
    ].join('\n'));
    const labeledEvidenceGrade = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(labeledEvidenceGrade.passed, true, JSON.stringify(labeledEvidenceGrade.details));

    await writeFile(path.join(spikeRoot, 'artifact', 'result.txt'), [
      'globalThis.crypto: present',
      'crypto.subtle: present',
      'digest_sha256_status: ok',
      'digest_sha256_hex: incomplete',
      '',
    ].join('\n'));
    const incompleteDigestGrade = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(incompleteDigestGrade.passed, false);
    assert.equal(
      incompleteDigestGrade.details.assertions.find((entry) => (
        entry.name === 'technical_runtime_evidence'
      )).passed,
      false,
    );

    await writeFile(path.join(spikeRoot, 'artifact', 'result.txt'), [
      'globalThis.crypto.present=true',
      'crypto.subtle.present=true',
      'subtle.digest.call=ok',
      'subtle.digest.sha256=incomplete',
      '',
    ].join('\n'));
    const incompleteFixedDigestGrade = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(incompleteFixedDigestGrade.passed, false);
    assert.equal(
      incompleteFixedDigestGrade.details.assertions.find((entry) => (
        entry.name === 'technical_runtime_evidence'
      )).passed,
      false,
    );

    await writeFile(path.join(spikeRoot, 'artifact', 'result.txt'), fixedEvidence);
    const rootRead = {
      threadId: 'root',
      tool: 'exec_command',
      arguments: { cmd: 'sed -n 1,20p prototypes/web-crypto-runtime/artifact/result.txt' },
    };
    spikeEvidence.collaborationCalls.push(rootRead);
    await writeFile(fixtures[1].paths.evidence, JSON.stringify(spikeEvidence));
    const rootReadGrade = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(rootReadGrade.passed, true, JSON.stringify(rootReadGrade.details));

    rootRead.arguments.cmd = 'node prototypes/web-crypto-runtime/artifact/spike.mjs > prototypes/web-crypto-runtime/artifact/result.txt';
    await writeFile(fixtures[1].paths.evidence, JSON.stringify(spikeEvidence));
    const rootOverwrite = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(rootOverwrite.passed, false);
    assert.equal(
      rootOverwrite.details.assertions.find((entry) => (
        entry.name === 'builder_generates:prototypes/web-crypto-runtime/artifact/result.txt'
      )).passed,
      false,
    );

    spikeEvidence.collaborationCalls.pop();
    spikeEvidence.collaborationCalls.splice(
      spikeEvidence.collaborationCalls.findIndex((entry) => (
        entry.threadId === 'builder' && entry.tool === 'exec_command'
      )),
      1,
    );
    await writeFile(fixtures[1].paths.evidence, JSON.stringify(spikeEvidence));
    const missingExecution = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(missingExecution.passed, false);
    assert.equal(
      missingExecution.details.assertions.find((entry) => entry.name === 'builder_execution').passed,
      false,
    );

    await prepareBuilderWorkflow({ case: direct, paths: fixtures[2].paths });
    await Promise.all([
      writeFile(fixtures[2].paths.evidence, JSON.stringify(workflowEvidence())),
      writeFile(fixtures[2].paths.modelOutput, '批准 / 请求修改 / 拒绝\n'),
    ]);
    const directGrade = await gradeBuilderWorkflow({
      case: direct,
      variant: 'current',
      paths: fixtures[2].paths,
    });
    assert.equal(directGrade.passed, true, JSON.stringify(directGrade.details));
  } finally {
    await Promise.all(fixtures.map(({ root }) => rm(root, { recursive: true, force: true })));
  }
});

test('leaf behavior stays independent and decision-shape owns composition', async () => {
  for (const skillName of leafSkills) {
    const manifest = await readJson(
      path.join(context.sourceRoot, 'skills', skillName, 'evals', 'manifest.json'),
    );
    const router = manifest.suites.find((suite) => suite.id === 'router');
    const routerCorpus = await readJson(path.join(
      context.sourceRoot, 'skills', skillName, 'evals', router.cases,
    ));
    assert.deepEqual(
      [routerCorpus.suite.unitUnderTest, ...(routerCorpus.suite.participants ?? [])].sort(),
      [...leafSkills].sort(),
    );
    assert.equal(routerCorpus.suite.runtime.forbidMultipleSkillLoads, true);

    for (const suite of manifest.suites.filter((entry) => entry.kind === 'conversation')) {
      const corpus = await readJson(path.join(
        context.sourceRoot, 'skills', skillName, 'evals', suite.cases,
      ));
      assert.equal(corpus.suite.unitUnderTest, skillName);
      assert.deepEqual(corpus.suite.participants ?? [], []);
    }
  }

  const shapeManifest = await readJson(
    path.join(context.sourceRoot, 'skills', 'decision-shape', 'evals', 'manifest.json'),
  );
  const shapeRouter = shapeManifest.suites.find((suite) => suite.id === 'router');
  const shapeEvalRoot = path.join(context.sourceRoot, 'skills', 'decision-shape', 'evals');
  const shapeRouterCorpus = await readJson(path.join(shapeEvalRoot, shapeRouter.cases));
  assert.deepEqual(
    [shapeRouterCorpus.suite.unitUnderTest, ...(shapeRouterCorpus.suite.participants ?? [])].sort(),
    [...requiredSkills].sort(),
  );
  assert.equal(shapeRouterCorpus.suite.runtime.forbidMultipleSkillLoads, false);
  for (const suite of shapeManifest.suites.filter((entry) => entry.kind === 'conversation')) {
    const corpus = await readJson(path.join(shapeEvalRoot, suite.cases));
    assert.deepEqual(
      [corpus.suite.unitUnderTest, ...(corpus.suite.participants ?? [])].sort(),
      [...requiredSkills].sort(),
    );
  }
  const sharedFrameSuite = shapeManifest.suites.find((suite) => suite.id === 'shared-frame');
  assert.ok(sharedFrameSuite);
  assert.equal(sharedFrameSuite.cases, 'shared-frame-cases.json');
  const sharedFrameCorpus = await readJson(path.join(shapeEvalRoot, sharedFrameSuite.cases));
  assert.deepEqual(
    sharedFrameCorpus.cases.map((entry) => entry.id),
    [
      'shape-shares-provisional-frame',
      'shape-passes-frame-to-prototype',
      'shape-passes-frame-to-grill',
      'frame-change-reopens-affected-only',
    ],
  );

  const prototypeRoot = path.join(context.sourceRoot, 'skills', 'decision-prototype', 'evals');
  const behavior = await readJson(
    path.join(prototypeRoot, 'decision-prototype-release-evals.json'),
  );
  assert.equal(behavior.version, 1);
  assert.equal(behavior.suite.unitUnderTest, 'decision-prototype');
  assert.equal(behavior.suite.runtime.isolation, 'strict');
  assert.equal(Array.isArray(behavior.cases), true);
  assert.equal(behavior.cases.length > 0, true);
  for (const entry of behavior.cases) {
    assert.equal(entry.expected.workspaceUnchanged, false);
    assert.equal(entry.expected.allowedWorkspaceChanges.length > 0, true);
    assert.equal(
      Object.keys(entry.input.workspaceFiles).some((file) => file.startsWith('src/')),
      true,
    );
    assert.equal(
      entry.expected.artifacts.every((artifact) => artifact.path.startsWith('prototypes/')),
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
    // Static contract exception: a materialized Skill must name only its target platform question tool; behavior test is not suitable because the platform-specific tool name is consumer-read Skill text.
    assert.equal(skill.includes(expectedTool), questionToolSkills.has(skillName));
    assert.equal(skill.includes(otherTool), false);
    assert.equal(skill.includes('{{questionTool}}'), false);
  }

  await access(path.join(
    context.bundleRoot,
    context.platform,
    'skills',
    'decision-grill',
    'references',
    'decision-presentation.md',
  ));

  const prototypeBundleRoot = path.join(
    context.bundleRoot,
    context.platform,
    'skills',
    'decision-prototype',
  );
  await access(path.join(prototypeBundleRoot, 'assets', 'prototype-verdict.md'));
  await access(path.join(prototypeBundleRoot, 'references', 'prototype-review.md'));
  await assert.rejects(
    access(path.join(prototypeBundleRoot, 'references', 'prototype-review-runtime.md')),
    (error) => error?.code === 'ENOENT',
  );
});
