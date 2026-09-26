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
const requiredSkills = ['decision-grill', 'decision-prototype', 'decision-shape', 'project-context'];
const leafSkills = ['decision-grill', 'decision-prototype'];
const decisionSkills = [...leafSkills, 'decision-shape'];

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
  assert.equal(context.plugin.name, 'decision-kit');
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

test('manifest exposes the four decision and project knowledge Skills', async () => {
  const manifest = await readJson(path.join(context.sourceRoot, '.agents-plugin', 'plugin.json'));

  assert.equal(manifest.name, 'decision-kit');
  assertStrictStableSemver(manifest.version);
  assert.equal(manifest.skills, './skills');
  assert.equal(manifest.extensions?.instructions?.length ?? 0, 0);
  assert.equal(manifest.config, undefined);
  assert.deepEqual(manifest.distributions, { agentSkills: { skills: './skills' } });
  assert.equal(manifest.artifacts, undefined);
  assert.equal(manifest.scripts.artifacts, undefined);
  assert.deepEqual(manifest.interface.capabilities, ['Skills']);
});

test('source package contains the four public Skills and native metadata', async () => {
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
  const evidence = {
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
  evidence.collaborationCalls.forEach((call, index) => {
    call.ordinal = index + 1;
  });
  return evidence;
}

async function workflowFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'decision-kit-builder-workflow-'));
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
  const tiny = corpus.cases.find((entry) => entry.id === 'tiny-persisted-example-can-stay-local');
  assert.ok(persistent);
  assert.ok(technical);
  assert.ok(direct);
  assert.ok(tiny);
  const fixtures = [
    await workflowFixture(),
    await workflowFixture(),
    await workflowFixture(),
    await workflowFixture(),
  ];
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
      writeFile(
        path.join(prototypeRoot, 'brief.md'),
        '# 设置页信息密度\n\n比较 compact 和 comfortable 的信息密度。\n',
      ),
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
      writeFile(
        path.join(prototypeRoot, 'artifact', 'compact.html'),
        '<main><h1>compact</h1><p>通知</p><p>语言</p></main>\n',
      ),
      writeFile(
        path.join(prototypeRoot, 'artifact', 'comfortable.html'),
        '<main><h1>comfortable</h1><p>通知</p><p>语言</p></main>\n',
      ),
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
        {
          threadId: 'root',
          tool: 'exec_command',
          arguments: { cmd: "sed -n '1,160p' prototypes/settings-density/artifact/compact.html" },
          output: { exitCode: 0 },
          status: 'completed',
        },
      ],
    });
    await Promise.all([
      writeFile(fixtures[0].paths.evidence, JSON.stringify(evidence)),
      writeFile(fixtures[0].paths.modelOutput, '证据范围 -> 已核对 compact artifact。\n'),
    ]);
    const passing = await gradeBuilderWorkflow({
      case: persistent,
      variant: 'current',
      paths: fixtures[0].paths,
    });
    assert.equal(passing.passed, true, JSON.stringify(passing.details));

    evidence.collaborationCalls.push({
      ordinal: evidence.collaborationCalls.length + 1,
      threadId: 'root',
      linkedThreadId: 'builder',
      tool: 'wait_agent',
      output: { status: { builder: { completed: 'done' } } },
    });
    await writeFile(fixtures[0].paths.evidence, JSON.stringify(evidence));
    const repeatedTerminal = await gradeBuilderWorkflow({
      case: persistent,
      variant: 'current',
      paths: fixtures[0].paths,
    });
    assert.equal(repeatedTerminal.passed, true, JSON.stringify(repeatedTerminal.details));
    evidence.collaborationCalls.pop();

    const persistentRead = evidence.collaborationCalls.pop();
    await writeFile(fixtures[0].paths.evidence, JSON.stringify(evidence));
    const missingPersistentRead = await gradeBuilderWorkflow({
      case: persistent,
      variant: 'current',
      paths: fixtures[0].paths,
    });
    assert.equal(missingPersistentRead.passed, false);
    assert.equal(
      missingPersistentRead.details.assertions.find((entry) => (
        entry.name === 'root_artifact_read'
      )).passed,
      false,
    );
    evidence.collaborationCalls.push(persistentRead);

    evidence.collaborationCalls.splice(3, 0, evidence.collaborationCalls.pop());
    evidence.collaborationCalls.forEach((call, index) => {
      call.ordinal = index + 1;
    });
    await writeFile(fixtures[0].paths.evidence, JSON.stringify(evidence));
    const prematurePersistentRead = await gradeBuilderWorkflow({
      case: persistent,
      variant: 'current',
      paths: fixtures[0].paths,
    });
    assert.equal(prematurePersistentRead.passed, false);
    assert.equal(
      prematurePersistentRead.details.assertions.find((entry) => (
        entry.name === 'root_artifact_read'
      )).passed,
      false,
    );
    evidence.collaborationCalls.splice(3, 1);
    evidence.collaborationCalls.push(persistentRead);
    evidence.collaborationCalls.forEach((call, index) => {
      call.ordinal = index + 1;
    });
    await writeFile(fixtures[0].paths.modelOutput, 'done\n');
    const persistentDone = await gradeBuilderWorkflow({
      case: persistent,
      variant: 'current',
      paths: fixtures[0].paths,
    });
    assert.equal(persistentDone.passed, false);
    assert.equal(
      persistentDone.details.assertions.find((entry) => (
        entry.name === 'model_output_mapping:证据范围'
      )).passed,
      false,
    );
    await writeFile(fixtures[0].paths.modelOutput, '证据范围 -> 已核对 compact artifact。\n');
    await writeFile(fixtures[0].paths.evidence, JSON.stringify(evidence));

    await writeFile(path.join(prototypeRoot, 'artifact', 'compact.html'), '');
    const emptyArtifact = await gradeBuilderWorkflow({
      case: persistent,
      variant: 'current',
      paths: fixtures[0].paths,
    });
    assert.equal(emptyArtifact.passed, false);
    assert.equal(
      emptyArtifact.details.assertions.find((entry) => (
        entry.name === 'content:prototypes/settings-density/artifact/compact.html'
      )).passed,
      false,
    );
    await writeFile(
      path.join(prototypeRoot, 'artifact', 'compact.html'),
      '<main><h1>compact</h1><p>通知</p><p>语言</p></main>\n',
    );

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
      writeFile(path.join(spikeRoot, 'artifact', 'spike.mjs'), [
        "const input = new TextEncoder().encode('ask-me');",
        "const digest = await crypto.subtle.digest('SHA-256', input);",
        "const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');",
        "process.stdout.write(JSON.stringify({ runtime: process.version, sha256 }) + '\\n');",
        '',
      ].join('\n')),
      writeFile(path.join(spikeRoot, 'artifact', 'result.txt'), JSON.stringify({
        runtime: process.version,
        sha256: 'cde17348a6dbdbc1775b65ba025cc711120258318c69c0b8118bf7b15bbc3441',
      })),
    ]);
    const spikeEvidence = workflowEvidence({
      workspaceDiff: {
        added: [
          'prototypes/web-crypto-runtime/brief.md',
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
            input: 'const patch = "*** Begin Patch\\n*** Add File: /workspace/prototypes/web-crypto-runtime/brief.md\\n*** End Patch"; text(await tools.apply_patch(patch));',
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
          output: { exitCode: 0 },
          status: 'completed',
        },
        {
          threadId: 'root',
          linkedThreadId: 'builder',
          tool: 'wait_agent',
          output: { status: { builder: { completed: 'done' } } },
        },
        {
          threadId: 'root',
          tool: 'exec_command',
          arguments: { cmd: "sed -n '1,160p' prototypes/web-crypto-runtime/artifact/result.txt" },
          output: { exitCode: 0 },
          status: 'completed',
        },
      ],
    });
    await Promise.all([
      writeFile(fixtures[1].paths.evidence, JSON.stringify(spikeEvidence)),
      writeFile(fixtures[1].paths.modelOutput, '证据范围 -> 当前 Node 运行的 result.txt。\n'),
    ]);
    const spikeGrade = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(spikeGrade.passed, true, JSON.stringify(spikeGrade.details));

    const probeCommand = spikeEvidence.collaborationCalls.find((entry) => (
      entry.threadId === 'builder' && entry.tool === 'exec_command'
    ));
    probeCommand.output.exitCode = 1;
    await writeFile(fixtures[1].paths.evidence, JSON.stringify(spikeEvidence));
    const failedProbeCommand = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(failedProbeCommand.passed, false);
    assert.equal(
      failedProbeCommand.details.assertions.find((entry) => (
        entry.name === 'technical_probe_execution'
      )).passed,
      false,
    );
    probeCommand.output.exitCode = 0;
    await writeFile(fixtures[1].paths.evidence, JSON.stringify(spikeEvidence));

    const validSpikeSource = await readFile(path.join(spikeRoot, 'artifact', 'spike.mjs'), 'utf8');
    await writeFile(path.join(spikeRoot, 'artifact', 'spike.mjs'), '');
    const emptyProbeSource = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(emptyProbeSource.passed, false);
    assert.equal(
      emptyProbeSource.details.assertions.find((entry) => (
        entry.name === 'technical_probe_source'
      )).passed,
      false,
    );
    await writeFile(path.join(spikeRoot, 'artifact', 'spike.mjs'), validSpikeSource);

    await writeFile(path.join(spikeRoot, 'artifact', 'result.txt'), JSON.stringify({
      runtime: process.version,
      sha256: '0'.repeat(64),
    }));
    const invalidProbeResult = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(invalidProbeResult.passed, false);
    assert.equal(
      invalidProbeResult.details.assertions.find((entry) => (
        entry.name === 'technical_probe_result'
      )).passed,
      false,
    );
    await writeFile(path.join(spikeRoot, 'artifact', 'result.txt'), JSON.stringify({
      runtime: process.version,
      sha256: 'cde17348a6dbdbc1775b65ba025cc711120258318c69c0b8118bf7b15bbc3441',
    }));

    const rootRead = spikeEvidence.collaborationCalls.find((entry) => (
      entry.threadId === 'root'
      && entry.tool === 'exec_command'
      && entry.arguments.cmd.includes('result.txt')
    ));
    const rootReadGrade = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(rootReadGrade.passed, true, JSON.stringify(rootReadGrade.details));

    const rootVerification = {
      ordinal: spikeEvidence.collaborationCalls.length + 1,
      threadId: 'root',
      tool: 'exec_command',
      arguments: { cmd: 'node prototypes/web-crypto-runtime/artifact/spike.mjs' },
      output: { exitCode: 0 },
      status: 'completed',
    };
    spikeEvidence.collaborationCalls.push(rootVerification);
    await writeFile(fixtures[1].paths.evidence, JSON.stringify(spikeEvidence));
    const rootVerificationGrade = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(rootVerificationGrade.passed, true, JSON.stringify(rootVerificationGrade.details));

    rootVerification.arguments.cmd = 'node prototypes/web-crypto-runtime/artifact/spike.mjs > prototypes/web-crypto-runtime/artifact/result.txt';
    await writeFile(fixtures[1].paths.evidence, JSON.stringify(spikeEvidence));
    const rootOverwrite = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(rootOverwrite.passed, false);
    assert.equal(
      rootOverwrite.details.assertions.find((entry) => (
        entry.name === 'technical_probe_provenance'
      )).passed,
      false,
    );
    spikeEvidence.collaborationCalls.pop();

    const rootReadIndex = spikeEvidence.collaborationCalls.indexOf(rootRead);
    const [removedRootRead] = spikeEvidence.collaborationCalls.splice(rootReadIndex, 1);
    spikeEvidence.collaborationCalls.forEach((call, index) => {
      call.ordinal = index + 1;
    });
    await writeFile(fixtures[1].paths.evidence, JSON.stringify(spikeEvidence));
    const missingTechnicalRead = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(missingTechnicalRead.passed, false);
    assert.equal(
      missingTechnicalRead.details.assertions.find((entry) => (
        entry.name === 'root_artifact_read'
      )).passed,
      false,
    );
    spikeEvidence.collaborationCalls.push(removedRootRead);
    spikeEvidence.collaborationCalls.forEach((call, index) => {
      call.ordinal = index + 1;
    });

    spikeEvidence.collaborationCalls.splice(
      spikeEvidence.collaborationCalls.findIndex((entry) => (
        entry.threadId === 'builder' && entry.tool === 'exec_command'
      )),
      1,
    );
    spikeEvidence.collaborationCalls.forEach((call, index) => {
      call.ordinal = index + 1;
    });
    await writeFile(fixtures[1].paths.evidence, JSON.stringify(spikeEvidence));
    const missingExecution = await gradeBuilderWorkflow({
      case: technical,
      variant: 'current',
      paths: fixtures[1].paths,
    });
    assert.equal(missingExecution.passed, false);
    assert.equal(
      missingExecution.details.assertions.find((entry) => entry.name === 'technical_probe_execution').passed,
      false,
    );

    await prepareBuilderWorkflow({ case: direct, paths: fixtures[2].paths });
    await Promise.all([
      writeFile(fixtures[2].paths.evidence, JSON.stringify(workflowEvidence())),
      writeFile(fixtures[2].paths.modelOutput, [
        '批准 -> 确认当前方案可以继续。',
        '请求修改 -> 指出需要调整后再确认。',
        '拒绝 -> 结束当前方案，不再继续。',
        '',
      ].join('\n')),
    ]);
    const directGrade = await gradeBuilderWorkflow({
      case: direct,
      variant: 'current',
      paths: fixtures[2].paths,
    });
    assert.equal(directGrade.passed, true, JSON.stringify(directGrade.details));

    await writeFile(fixtures[2].paths.modelOutput, [
      '批准 -> 批准。',
      '请求修改 -> 指出需要调整后再确认。',
      '拒绝 -> 结束当前方案，不再继续。',
      '',
    ].join('\n'));
    const echoedDirectLabel = await gradeBuilderWorkflow({
      case: direct,
      variant: 'current',
      paths: fixtures[2].paths,
    });
    assert.equal(echoedDirectLabel.passed, false);
    assert.equal(
      echoedDirectLabel.details.assertions.find((entry) => (
        entry.name === 'model_output_mapping:批准'
      )).passed,
      false,
    );

    await writeFile(fixtures[2].paths.modelOutput, 'done\n');
    const directDone = await gradeBuilderWorkflow({
      case: direct,
      variant: 'current',
      paths: fixtures[2].paths,
    });
    assert.equal(directDone.passed, false);
    assert.equal(
      directDone.details.assertions.find((entry) => (
        entry.name === 'model_output_mapping:批准'
      )).passed,
      false,
    );

    await prepareBuilderWorkflow({ case: tiny, paths: fixtures[3].paths });
    const tinyRoot = path.join(fixtures[3].paths.workspace, 'prototypes', 'submitted-copy');
    await mkdir(path.join(tinyRoot, 'artifact'), { recursive: true });
    await Promise.all([
      writeFile(path.join(tinyRoot, 'brief.md'), '# 申请已提交\n'),
      writeFile(path.join(tinyRoot, 'artifact', 'index.html'), '<main><p>申请已提交</p></main>\n'),
    ]);
    const tinyEvidence = workflowEvidence({
      workspaceDiff: {
        added: [
          'prototypes/submitted-copy/brief.md',
          'prototypes/submitted-copy/artifact/index.html',
        ],
        modified: [],
        removed: [],
      },
      collaborationCalls: [{
        threadId: 'root',
        tool: 'exec',
        arguments: {
          input: 'const patch = "*** Begin Patch\\n*** Add File: /workspace/prototypes/submitted-copy/brief.md\\n*** Add File: /workspace/prototypes/submitted-copy/artifact/index.html\\n*** End Patch"; text(await tools.apply_patch(patch));',
        },
      }],
    });
    await Promise.all([
      writeFile(fixtures[3].paths.evidence, JSON.stringify(tinyEvidence)),
      writeFile(fixtures[3].paths.modelOutput, '小型页面已保存。\n'),
    ]);
    const tinyGrade = await gradeBuilderWorkflow({
      case: tiny,
      variant: 'current',
      paths: fixtures[3].paths,
    });
    assert.equal(tinyGrade.passed, true, JSON.stringify(tinyGrade.details));

    await writeFile(path.join(tinyRoot, 'brief.md'), '');
    const emptyTinyBrief = await gradeBuilderWorkflow({
      case: tiny,
      variant: 'current',
      paths: fixtures[3].paths,
    });
    assert.equal(emptyTinyBrief.passed, false);
    assert.equal(
      emptyTinyBrief.details.assertions.find((entry) => (
        entry.name === 'content:prototypes/submitted-copy/brief.md'
      )).passed,
      false,
    );
    await writeFile(path.join(tinyRoot, 'brief.md'), '# 申请已提交\n');
    await writeFile(path.join(tinyRoot, 'artifact', 'index.html'), '<!-- 申请已提交 -->\n');
    const hiddenTinyPage = await gradeBuilderWorkflow({
      case: tiny,
      variant: 'current',
      paths: fixtures[3].paths,
    });
    assert.equal(hiddenTinyPage.passed, false);
    assert.equal(
      hiddenTinyPage.details.assertions.find((entry) => (
        entry.name === 'content:prototypes/submitted-copy/artifact/index.html'
      )).passed,
      false,
    );
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
    [...decisionSkills].sort(),
  );
  assert.equal(shapeRouterCorpus.suite.runtime.forbidMultipleSkillLoads, false);
  for (const id of ['behavior', 'shared-frame', 'prototype-evidence']) {
    const suite = shapeManifest.suites.find((entry) => entry.id === id);
    assert.ok(suite);
    const corpus = await readJson(path.join(shapeEvalRoot, suite.cases));
    assert.deepEqual(
      [corpus.suite.unitUnderTest, ...(corpus.suite.participants ?? [])].sort(),
      [...decisionSkills].sort(),
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
  assert.doesNotMatch(shape, /\bdev-workflow\b|docs\/dev|Fast|Standard|Assured/);
});

test('plan-review cases receive an actual migration plan fixture', async () => {
  const roots = await Promise.all([
    mkdtemp(path.join(os.tmpdir(), 'decision-kit-plan-review-trigger-')),
    mkdtemp(path.join(os.tmpdir(), 'decision-kit-plan-review-router-')),
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

test('prepared bundle renders the four static Skills', async () => {
  if (!context.platform) return;

  const platformManifest = await readJson(
    path.join(context.bundleRoot, `.${context.platform}-plugin`, 'plugin.json'),
  );
  assert.equal(platformManifest.name, 'decision-kit');
  assert.equal(platformManifest.skills, `./${context.platform}/skills`);
  for (const skillName of requiredSkills) {
    const skill = await readFile(
      path.join(context.bundleRoot, context.platform, 'skills', skillName, 'SKILL.md'),
      'utf8',
    );
    // Static contract exception: portable Skill text must not bind questioning to a platform tool name; behavior tests cannot observe consumer-read Skill text.
    assert.equal(skill.includes('`request_user_input`'), false);
    assert.equal(skill.includes('`AskUserQuestion`'), false);
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
