import {
  execFile,
  type ChildProcess,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import {
  computeSkillDigest,
  getRuntimeCapabilities,
} from '@lesliechan721/agent-skill-eval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readSourceRevision,
  runChild,
  runPluginEvals as runPluginEvalsProduction,
  terminatePosixProcessTree,
  terminateWindowsProcessTree,
  type PluginEvalRunnerOptions,
} from '../../scripts/eval-plugin-skills.js';
import {
  createPluginEvalRunLayout,
  type EvalRunLayout,
} from '../../scripts/eval-run-layout.js';
import { createEnvironmentDigest } from '../../scripts/skill-reporting.js';
import { resetCodexEvalSignalShutdownForTests } from '../../scripts/codex-eval-runtime-config.js';
import {
  assertProcessTreeInspectionAvailable,
  createWindowsChildProcessTreeMonitor,
  processTreeCleanupIsUnconfirmed,
} from '../../scripts/codex-eval-process-tree.js';
import {
  registerCurrentTestReadonlyFixtureRoot,
  registerCurrentTestWritableStateRoot,
} from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
let testRunCounter = 0;

async function deployTestEvalCli(target: string): Promise<void> {
  await fs.outputJson(path.join(target, 'package.json'), {
    name: '@fixture/aw',
    version: '0.1.0',
  });
  await fs.outputFile(path.join(target, 'dist', 'index.js'), 'export {};\n');
}

function runPluginEvals(
  args: string[],
  options: PluginEvalRunnerOptions = {},
): Promise<number> {
  return runPluginEvalsProduction(args, {
    deployEvalCli: deployTestEvalCli,
    ...options,
  });
}

function testRunLayoutFactory(outputRoot: string) {
  return async (options: {
    repoRoot: string;
    plugin: string;
    skill: string;
    batchName?: string;
    batchId?: string;
    runId?: string;
    source: {
      digest: string;
      gitHead: string | null;
      inScopeDirty: boolean;
    };
    environmentDigest: string;
    modelEnvironmentDigest?: string | null;
    harnessDigest: string;
    requiredTargets: string[];
    targetCompositions?: Record<string, string[]>;
  }): Promise<EvalRunLayout> => {
    testRunCounter += 1;
    const runId = options.runId ?? `20260811T000000Z-${testRunCounter.toString(16).padStart(8, '0')}`;
    const batchId = options.batchId ?? '20260811T000000Z-test-batch-00000000';
    const batchRoot = path.join(outputRoot, options.plugin, options.skill, batchId);
    const reportRoot = path.join(batchRoot, 'evals', 'runs', runId);
    const rawRoot = path.join(reportRoot, 'raw');
    const workRoot = path.join(outputRoot, '.tmp', runId);
    await Promise.all([fs.ensureDir(rawRoot), fs.ensureDir(workRoot)]);
    const batchPath = path.join(batchRoot, 'batch.json');
    if (!(await fs.pathExists(batchPath))) {
      await fs.writeJson(batchPath, {
        schemaVersion: 1,
        batchId,
        name: options.batchName ?? 'test-batch',
        owner: {
          kind: 'plugin-skill',
          plugin: options.plugin,
          skill: options.skill,
        },
        status: 'open',
        createdAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z',
        source: options.source,
        environmentDigest: options.environmentDigest,
        modelEnvironmentDigest: options.modelEnvironmentDigest ?? null,
        harnessDigest: options.harnessDigest,
        requiredTargets: options.requiredTargets,
        targetCompositions: options.targetCompositions ?? {},
      }, { spaces: 2 });
    }
    return {
      batchId,
      batchRoot,
      reportBoundaryRoot: outputRoot,
      runId,
      reportRoot,
      rawRoot,
      workRoot,
      startedAt: '2026-08-11T00:00:00.000Z',
      pid: process.pid,
      host: os.hostname(),
      cleanupWork: () => fs.remove(workRoot),
    };
  };
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function writeFakeCodex(
  root: string,
  skillName: string,
  cliProbePath?: string,
): Promise<string> {
  const codexBin = path.join(root, 'fake-codex');
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "if (process.argv[2] === '--version') { process.stdout.write('codex-fake 1.0\\n'); process.exit(0); }",
    "if (process.argv[2] !== 'app-server') process.exit(3);",
    ...(cliProbePath ? [
      "const { execFileSync } = require('node:child_process');",
      "const resolvedAw = execFileSync('/bin/sh', ['-c', 'command -v aw'], { encoding: 'utf8' }).trim();",
      "const launcher = fs.readFileSync(resolvedAw, 'utf8');",
      "const envEntry = process.env.AW_PLUGIN_EVAL_CLI_ENTRY;",
      "const entryRealpath = fs.realpathSync(envEntry);",
      "const moduleRealpath = fs.realpathSync(require.resolve('commander', { paths: [path.dirname(envEntry)] }));",
      "const dependencyBinPresent = fs.existsSync(path.join(path.dirname(path.dirname(envEntry)), 'node_modules', '.bin'));",
      "const awVersion = execFileSync('aw', ['--version'], { encoding: 'utf8' }).trim();",
      "const validateHelp = execFileSync('aw', ['plugin', 'validate', '--help'], { encoding: 'utf8' });",
      `fs.appendFileSync(${JSON.stringify(cliProbePath)}, JSON.stringify({ resolvedAw, launcher, envEntry, entryRealpath, moduleRealpath, dependencyBinPresent, awVersion, validateHelp }) + '\\n');`,
    ] : []),
    'const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
    "const readline = require('node:readline');",
    'const input = readline.createInterface({ input: process.stdin });',
    "input.on('line', (line) => {",
    '  const frame = JSON.parse(line);',
    "  if (frame.method === 'initialize') send({ id: frame.id, result: {} });",
    "  else if (frame.method === 'config/read') send({ id: frame.id, result: {",
    "    config: { cli_auth_credentials_store: 'file', mcp_oauth_credentials_store: 'file', include_apps_instructions: false, include_collaboration_mode_instructions: false, mcp_servers: {}, features: { secret_auth_storage: false, default_mode_request_user_input: true, apps: false, plugins: false, remote_plugin: false, plugin_sharing: false, tool_suggest: false, skill_mcp_dependency_install: false }, skills: { bundled: { enabled: false } }, orchestrator: { skills: { enabled: false }, mcp: { enabled: false } } },",
    "    origins: {}, layers: [{ name: { type: 'system', file: '/etc/codex/config.toml' }, version: '1', config: {} }, { name: { type: 'user', file: path.join(process.env.CODEX_HOME, 'config.toml') }, version: '1', config: {} }, { name: { type: 'project', dotCodexFolder: path.join(frame.params.cwd, '.codex') }, version: '1', config: {} }, { name: { type: 'sessionFlags' }, version: '1', config: {} }],",
    "  } });",
    "  else if (frame.method === 'configRequirements/read') send({ id: frame.id, result: { requirements: null } });",
    "  else if (frame.method === 'skills/list') { const cwd = frame.params.cwds[0]; const skillPath = path.join(cwd, '.agents', 'skills', " + JSON.stringify(skillName) + ", 'SKILL.md'); send({ id: frame.id, result: { data: [{ cwd, skills: [{ name: " + JSON.stringify(skillName) + ", path: skillPath, scope: 'repo', enabled: true }], errors: [] }] } }); }",
    "  else if (frame.method === 'mcpServerStatus/list') send({ id: frame.id, result: { data: [], nextCursor: null } });",
    "  else if (frame.method === 'thread/start') send({ id: frame.id, result: { thread: { id: 'thread-1' } } });",
    "  else if (frame.method === 'turn/start') {",
    "    send({ id: frame.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });",
    '    send({ method: "item/completed", params: { threadId: "thread-1", item: { id: "read-1", type: "commandExecution", status: "completed", exitCode: 0, command: ' + JSON.stringify('cat .agents/skills/' + skillName + '/SKILL.md') + ' } } });',
    "    const activity = { id: 'spawn-1', type: 'subAgentActivity', kind: 'started', agentThreadId: 'agent-1', agentPath: '/root/evidence' };",
    "    send({ method: 'item/started', params: { threadId: 'thread-1', item: activity } });",
    "    send({ method: 'item/completed', params: { threadId: 'thread-1', item: activity } });",
    "    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });",
    '  }',
    '});',
    'setInterval(() => {}, 1000);',
  ].join('\n'), 'utf8');
  await fs.chmod(codexBin, 0o755);
  return codexBin;
}

async function writeProviderCheckingFakeCodex(root: string, skillName: string): Promise<string> {
  const codexBin = path.join(root, 'fake-provider-codex');
  await fs.writeFile(codexBin, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "if (process.argv[2] === '--version') { process.stdout.write('fixture-secret https://example.invalid/v1\\n'); process.exit(0); }",
    "if (process.argv.includes('--ignore-user-config')) { process.stderr.write('user config was ignored\\n'); process.exit(9); }",
    "const config = fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');",
    "if (!config.includes('model_provider = \"fixture-provider\"')) { process.stderr.write('provider missing\\n'); process.exit(10); }",
    "if (config.includes('[plugins.') || config.includes('[mcp_servers.')) { process.stderr.write('unsafe config copied\\n'); process.exit(11); }",
    "if (fs.existsSync(path.join(process.env.CODEX_HOME, 'auth.json'))) { process.stderr.write('official auth copied\\n'); process.exit(12); }",
    "if (process.env.OPENAI_API_KEY || process.env.UNRELATED_SECRET) { process.stderr.write('unrelated environment copied\\n'); process.exit(13); }",
    'const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
    "if (process.argv[2] === 'app-server') {",
    "  const readline = require('node:readline');",
    "  const input = readline.createInterface({ input: process.stdin });",
    "  input.on('line', (line) => {",
    "    const frame = JSON.parse(line);",
    "    if (frame.method === 'initialize') send({ id: frame.id, result: {} });",
    "    else if (frame.method === 'config/read') send({ id: frame.id, result: {",
    "      config: { cli_auth_credentials_store: 'file', mcp_oauth_credentials_store: 'file', include_apps_instructions: false, include_collaboration_mode_instructions: false, mcp_servers: {}, features: { secret_auth_storage: false, default_mode_request_user_input: true, apps: false, plugins: false, remote_plugin: false, plugin_sharing: false, tool_suggest: false, skill_mcp_dependency_install: false }, skills: { bundled: { enabled: false } }, orchestrator: { skills: { enabled: false }, mcp: { enabled: false } } },",
    "      origins: {}, layers: [{ name: { type: 'system', file: '/etc/codex/config.toml' }, version: '1', config: {} }, { name: { type: 'user', file: path.join(process.env.CODEX_HOME, 'config.toml') }, version: '1', config: {} }, { name: { type: 'sessionFlags' }, version: '1', config: {} }],",
    "    } });",
    "    else if (frame.method === 'configRequirements/read') send({ id: frame.id, result: { requirements: null } });",
    "    else if (frame.method === 'skills/list') { const cwd = frame.params.cwds[0]; const skillPath = path.join(cwd, '.agents', 'skills', " + JSON.stringify(skillName) + ", 'SKILL.md'); send({ id: frame.id, result: { data: [{ cwd, skills: [{ name: " + JSON.stringify(skillName) + ", path: skillPath, scope: 'repo', enabled: true }], errors: [] }] } }); }",
    "    else if (frame.method === 'mcpServerStatus/list') send({ id: frame.id, result: { data: [], nextCursor: null } });",
    "  });",
    "} else {",
    `  send({ type: "item.completed", item: { type: "command_execution", status: "completed", exit_code: 0, command: "cat .agents/skills/${skillName}/SKILL.md" } });`,
    '  send({ type: "item.completed", item: { type: "agent_message", text: "fixture-secret https://example.invalid/v1" } });',
    "  process.stderr.write('fixture-secret https://example.invalid/v1\\n');",
    '  send({ type: "turn.completed", usage: { total_tokens: 7 } });',
    '}',
  ].join('\n'), 'utf8');
  await fs.chmod(codexBin, 0o755);
  return codexBin;
}

async function writeCommandPlugin(
  repo: string,
  options: {
    name: string;
    script: string;
    defaultRuns: number;
    perRunTimeoutMs: number;
    suiteTimeoutMs: number;
    supports: string[];
    caseIds?: string[];
  },
): Promise<void> {
  const pluginRoot = path.join(repo, 'plugins', options.name);
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.ensureDir(path.join(pluginRoot, 'skills', options.name, 'agents'));
  await fs.ensureDir(path.join(pluginRoot, 'skills', options.name, 'evals'));
  await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
    name: options.name,
    version: '0.1.0',
    description: 'Exercise the central command suite contract.',
    compatibility: { aw: { minVersion: '0.0.0' } },
    skills: './skills',
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
    },
  }, { spaces: 2 });
  await fs.writeFile(
    path.join(pluginRoot, 'skills', options.name, 'SKILL.md'),
    [
      '---',
      `name: ${options.name}`,
      'description: Use only to test the central command suite contract.',
      'disable-model-invocation: true',
      'user-invocable: true',
      '---',
      '',
      '# Timeout Demo',
    ].join('\n'),
    'utf8',
  );
  if (options.supports.includes('case')) {
    await fs.writeJson(
      path.join(pluginRoot, 'skills', options.name, 'evals', 'cases.json'),
      {
        skill_name: options.name,
        evals: (options.caseIds ?? ['selected_case']).map((id) => ({ id })),
      },
      { spaces: 2 },
    );
  }
  await fs.writeFile(
    path.join(pluginRoot, 'skills', options.name, 'README.md'),
    `# ${options.name}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(pluginRoot, 'skills', options.name, 'agents', 'openai.yaml'),
    'policy:\n  allow_implicit_invocation: false\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(pluginRoot, 'skills', options.name, 'evals', 'runner.mjs'),
    options.script,
    'utf8',
  );
  await fs.writeJson(path.join(
    pluginRoot,
    'skills',
    options.name,
    'evals',
    'manifest.json',
  ), {
    schemaVersion: 2,
    plugin: options.name,
    skill: options.name,
    profiles: [{
      id: 'project-default',
      scope: 'project',
      plugins: [{ name: options.name, config: {} }],
      runModel: true,
      requiredForRelease: true,
    }],
    suites: [{
      id: 'command',
      kind: 'command',
      skills: [options.name],
      entry: './runner.mjs',
      ...(options.supports.includes('case') ? { cases: './cases.json' } : {}),
      profiles: ['project-default'],
      defaultRuns: options.defaultRuns,
      releaseSplits: [],
      requiredForRelease: true,
      perRunTimeoutMs: options.perRunTimeoutMs,
      suiteTimeoutMs: options.suiteTimeoutMs,
      supports: options.supports,
    }],
  }, { spaces: 2 });
}

beforeEach(() => {
  vi.stubEnv('CODEX_PERMISSION_PROFILE', undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin eval runner', () => {
  it('ignores persisted reports but detects plugin source changes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-revision-'));
    tempDirs.push(root);
    registerCurrentTestWritableStateRoot(root);
    const sourcePath = path.join(root, 'plugins', 'demo', 'templates', 'demo', 'SKILL.md');
    const reportPath = path.join(
      root,
      'plugins',
      'demo',
      'templates',
      'demo',
      'reports',
      'evals',
      '20260812T000000Z-00000001',
      'summary.json',
    );
    await fs.outputFile(sourcePath, '---\nname: demo\n---\n');
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync(
      'git',
      ['-c', 'user.name=Eval Test', '-c', 'user.email=eval@example.test', 'commit', '-m', 'initial'],
      { cwd: root },
    );

    await fs.outputJson(reportPath, { complete: true });
    expect(await readSourceRevision({ repoRoot: root, pluginNames: ['demo'] }))
      .toMatchObject({ inScopeDirty: false });

    await fs.appendFile(sourcePath, '# changed\n');
    expect(await readSourceRevision({ repoRoot: root, pluginNames: ['demo'] }))
      .toMatchObject({ inScopeDirty: true });
  });

  it('places the complete eval batch and run work under the repository temporary root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-layout-'));
    tempDirs.push(root);
    const skillRoot = path.join(root, 'plugins', 'demo', 'skills', 'demo');
    await fs.ensureDir(skillRoot);
    const layout = await createPluginEvalRunLayout({
      repoRoot: root,
      plugin: 'demo',
      skill: 'demo',
      batchName: 'layout-test',
      runId: '20260811T000000Z-00000001',
      source: { digest: 'sha256:test', gitHead: null, inScopeDirty: false },
      environmentDigest: 'sha256:environment',
      modelEnvironmentDigest: null,
      harnessDigest: 'sha256:harness',
      requiredTargets: [],
    });

    expect(layout.reportRoot).toBe(path.join(
      root,
      '.tmp',
      'agent-workflows',
      'evals',
      'plugin',
      'demo',
      'demo',
      layout.batchId,
      'evals',
      'runs',
      '20260811T000000Z-00000001',
    ));
    expect(layout.workRoot).toBe(path.join(
      root,
      '.tmp',
      'agent-workflows',
      'evals',
      'plugin',
      'demo',
      'demo',
      layout.batchId,
      'work',
      '20260811T000000Z-00000001',
    ));
    await layout.cleanupWork();
    await expect(fs.pathExists(layout.workRoot)).resolves.toBe(false);
    await expect(fs.pathExists(layout.reportRoot)).resolves.toBe(true);
    await expect(fs.pathExists(path.join(
      root,
      'plugins',
      'demo',
      'reports',
      'demo',
    ))).resolves.toBe(false);
  });

  it('prints help without treating it as an argument error', async () => {
    let stdout = '';
    const exitCode = await runPluginEvals(['--help'], {
      stdout: (text) => { stdout += text; },
      stderr: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: pnpm plugin:eval');
    expect(stdout).toContain('--materialize-only');
    expect(stdout).toContain('--model-provider');
    expect(stdout).toContain('--codex-config');
    expect(stdout).toContain('--no-inherit-codex-config');
    expect(stdout).toContain('--aw-skill-eval-plan');
  });

  it('runs an AwSkillEvalExecutionPlan through the production bridge without Audit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-portable-eval-plan-'));
    tempDirs.push(root);
    registerCurrentTestWritableStateRoot(root);
    const skillRoot = path.join(root, 'skill');
    await fs.ensureDir(skillRoot);
    await fs.writeFile(path.join(skillRoot, 'SKILL.md'), [
      '---',
      'name: portable-fixture',
      'description: Run the portable shared-engine fixture.',
      '---',
      '',
      '# Portable Fixture',
    ].join('\n'), 'utf8');
    const cases = [{ id: 'portable_case', prompt: 'Run the portable fixture.' }];
    const casesPath = path.join(root, 'cases.json');
    await fs.writeJson(casesPath, cases, { spaces: 2 });
    const targetDigest = await computeSkillDigest(skillRoot);
    const caseCorpusDigest = sha256(stableJson(cases));
    const capabilities = getRuntimeCapabilities();
    const capabilitiesPath = path.join(root, 'capabilities.json');
    await fs.writeJson(capabilitiesPath, capabilities, { spaces: 2 });
    const capabilitiesDigest = sha256(await fs.readFile(capabilitiesPath));
    const providerPath = path.join(root, 'provider.mjs');
    await fs.writeFile(providerPath, [
      "import process from 'node:process';",
      "process.stdout.write(JSON.stringify({ usage: { fixture: true } }) + '\\n');",
    ].join('\n'), 'utf8');
    const planPath = path.join(root, 'plan.json');
    await fs.writeJson(planPath, {
      schemaVersion: 3,
      planId: 'portable-fixture',
      target: { name: 'portable-fixture', path: './skill', digest: targetDigest },
      cases: { paths: ['./cases.json'], corpusDigest: caseCorpusDigest },
      provider: {
        id: capabilities.provider,
        command: [process.execPath, providerPath],
        cwd: null,
        env: {},
        capabilitiesPath: './capabilities.json',
        capabilitiesDigest,
        inheritEnvironment: false,
      },
      configurations: [{
        id: 'with-skill',
        skillMode: 'with-skill',
        comparisonId: null,
        env: {},
      }],
      runsPerCase: 1,
      timeoutMs: 2_000,
      outputRoot: './output',
      capture: { outputs: true, trace: false, timing: true, usage: false },
    }, { spaces: 2 });
    let stdout = '';
    let stderr = '';

    const exitCode = await runPluginEvals(['--aw-skill-eval-plan', planPath], {
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    });

    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      valid: true,
      evidenceLevel: 'executed',
      requirementsMet: true,
      engine: {
        provider: capabilities.provider,
        version: capabilities.providerVersion,
      },
      bundleValidation: { valid: true, errors: [] },
    });
    await expect(fs.readJson(result.bundlePath)).resolves.toMatchObject({
      schemaVersion: 3,
      runner: { id: 'aw-skill-eval', version: capabilities.providerVersion },
      aggregate: { runs: 1, completed: 1 },
      evidenceLevel: 'executed',
      evidenceRequirement: {
        minimumEvidenceLevel: 'executed',
        satisfied: true,
      },
      limitations: expect.arrayContaining([
        expect.stringContaining('does not guarantee descendant cleanup'),
      ]),
    });

    const failedCleanupProcessTree = {
      platform: 'win32' as const,
      execFile: (
        _command: string,
        _args: string[],
        _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
        callback: (error: Error | null, stdout: string) => void,
      ): void => callback(new Error('cleanup inspection fixture failure'), ''),
    };
    stdout = '';
    stderr = '';
    const failedCleanupExitCode = await runPluginEvals(['--aw-skill-eval-plan', planPath], {
      evalProcessTree: failedCleanupProcessTree,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    });
    expect(failedCleanupExitCode, stderr).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      valid: true,
      evidenceLevel: 'executed',
      requirementsMet: false,
      bundleValidation: { valid: true, errors: [] },
    });

    const plan = await fs.readJson(planPath);
    plan.minimumEvidenceLevel = 'comparative';
    plan.configurations = [
      { id: 'with-skill', skillMode: 'with-skill', comparisonId: 'pair-1', env: {} },
      { id: 'without-skill', skillMode: 'without-skill', comparisonId: 'pair-1', env: {} },
    ];
    await fs.writeJson(planPath, plan, { spaces: 2 });
    const evalProcessTree = {
      platform: 'linux' as const,
      execFile: (
        _command: string,
        _args: string[],
        _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
        callback: (error: Error | null, stdout: string) => void,
      ): void => callback(null, ''),
    };
    stdout = '';
    stderr = '';
    const unmetExitCode = await runPluginEvals(['--aw-skill-eval-plan', planPath], {
      env: { ...process.env, CODEX_PERMISSION_PROFILE: ':danger-full-access' },
      platform: 'linux',
      evalProcessTree,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    });
    expect(unmetExitCode, stderr).toBe(1);
    const unmet = JSON.parse(stdout);
    expect(unmet).toMatchObject({
      valid: true,
      evidenceLevel: 'executed',
      requirementsMet: false,
      bundleValidation: { valid: true, errors: [] },
    });
    await expect(fs.readJson(unmet.bundlePath)).resolves.toMatchObject({
      evidenceRequirement: {
        minimumEvidenceLevel: 'comparative',
        plannedComparisons: 1,
        comparableComparisons: 0,
        satisfied: false,
      },
      processManagement: {
        mode: 'observed',
        descendantCleanupGuaranteed: false,
        limitation: 'Provider process cleanup could not be verified.',
      },
    });

    stdout = '';
    stderr = '';
    const restrictedExitCode = await runPluginEvals(['--aw-skill-eval-plan', planPath], {
      env: { ...process.env, CODEX_PERMISSION_PROFILE: ':workspace' },
      platform: 'linux',
      evalProcessTree,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    });
    expect(restrictedExitCode).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('one-off sandbox_permissions=require_escalated request is not Full Access');
  });

  it('persists the observed command execution mode through the complete production run', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-observed-'));
    const outputRoot = path.join(root, 'output');
    tempDirs.push(root);
    await writeCommandPlugin(root, {
      name: 'observed-demo',
      script: [
        "import { mkdir, writeFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        "const output = process.argv[process.argv.indexOf('--output') + 1];",
        "await mkdir(path.dirname(output), { recursive: true });",
        "await writeFile(output, JSON.stringify({ complete: true, passed: true, summary: {} }));",
      ].join('\n'),
      defaultRuns: 1,
      perRunTimeoutMs: 1_000,
      suiteTimeoutMs: 2_000,
      supports: ['codexBin'],
    });
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    let stdout = '';
    let stderr = '';

    const exitCode = await runPluginEvals([
      'observed-demo',
      '--skill',
      'observed-demo',
      '--no-inherit-codex-config',
      '--codex-bin',
      process.execPath,
    ], {
      repoRoot: root,
      env: { ...process.env, CODEX_PERMISSION_PROFILE: undefined },
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      createRunLayout: testRunLayoutFactory(outputRoot),
    });

    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(stdout);
    const expectedProcessManagement = {
      mode: 'observed',
      inspectionAvailable: true,
      userAcknowledged: false,
      descendantCleanupGuaranteed: false,
      limitation: expect.stringContaining('does not guarantee descendant cleanup'),
    };
    expect(result.bundle.processManagement).toMatchObject(expectedProcessManagement);
    const reportRoot = path.resolve(root, result.reportDir);
    await expect(fs.readJson(path.join(reportRoot, 'run.json'))).resolves.toMatchObject({
      processManagement: expectedProcessManagement,
    });
    await expect(fs.readJson(path.join(reportRoot, 'raw', 'evaluation.json')))
      .resolves.toMatchObject({ processManagement: expectedProcessManagement });
    await expect(fs.readJson(path.join(reportRoot, 'summary.json'))).resolves.toMatchObject({
      processManagement: expectedProcessManagement,
    });
    const batch = await fs.readJson(path.join(
      outputRoot,
      'observed-demo',
      'observed-demo',
      result.batchId,
      'batch.json',
    ));
    const codexVersion = (await execFileAsync(process.execPath, ['--version'])).stdout.trim();
    expect(batch.modelEnvironmentDigest).toBe(createEnvironmentDigest({
      model: 'gpt-5.6-luna',
      modelProvider: 'openai',
      codexConfigDigest: result.bundle.codexConfigDigest,
      codexVersion,
      processManagement: {
        mode: 'observed',
        inspectionAvailable: true,
        userAcknowledged: false,
        descendantCleanupGuaranteed: false,
        limitation: result.bundle.processManagement.limitation,
      },
      cliCapsule: result.bundle.cliCapsule,
    }));
  });

  it('binds checkpoint reuse to the deployed CLI production closure', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-cli-identity-'));
    const deploymentSource = path.join(root, 'deployment-source');
    const dependencyPath = path.join(
      deploymentSource,
      'node_modules',
      'fixture-dependency',
      'index.js',
    );
    const statePath = path.join(root, 'identity-state.json');
    tempDirs.push(root);
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(root);
    await writeCommandPlugin(root, {
      name: 'identity-demo',
      script: [
        "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        `const statePath = ${JSON.stringify(statePath)};`,
        "const caseId = process.argv[process.argv.indexOf('--case') + 1];",
        "const output = process.argv[process.argv.indexOf('--output') + 1];",
        "let state = { failedOnce: false };",
        "try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch {}",
        "const incomplete = caseId === 'case_b' && !state.failedOnce;",
        "if (incomplete) state.failedOnce = true;",
        "await writeFile(statePath, JSON.stringify(state));",
        "await mkdir(path.dirname(output), { recursive: true });",
        "await writeFile(output, JSON.stringify({ complete: !incomplete, passed: !incomplete, summary: {}, case_results: [{ id: caseId, outcome: incomplete ? 'incomplete' : 'passed', complete: !incomplete, mechanical_passed: !incomplete }] }));",
        "if (incomplete) process.exitCode = 1;",
      ].join('\n'),
      defaultRuns: 1,
      perRunTimeoutMs: 1_000,
      suiteTimeoutMs: 2_000,
      supports: ['codexBin', 'runs', 'case'],
      caseIds: ['case_a', 'case_b'],
    });
    await fs.outputJson(path.join(deploymentSource, 'package.json'), {
      name: '@fixture/aw',
      version: '0.1.0',
    });
    await fs.outputFile(path.join(deploymentSource, 'dist', 'index.js'), 'export {};\n');
    await fs.outputFile(dependencyPath, 'export const identity = "first";\n');
    const deployedTargets: string[] = [];
    const deployEvalCli = (target: string): Promise<void> => {
      deployedTargets.push(target);
      return fs.copy(deploymentSource, target, { dereference: false });
    };
    const run = async (batchArgs: string[]): Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }> => {
      let stdout = '';
      let stderr = '';
      const exitCode = await runPluginEvals([
        'identity-demo',
        '--skill',
        'identity-demo',
        '--no-inherit-codex-config',
        '--codex-bin',
        process.execPath,
        ...batchArgs,
      ], {
        repoRoot: root,
        env: { ...process.env, CODEX_PERMISSION_PROFILE: undefined },
        deployEvalCli,
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
      });
      return { exitCode, stdout, stderr };
    };

    const first = await run(['--batch-name', 'cli-identity']);
    expect(first.exitCode, first.stderr).toBe(1);
    const firstResult = JSON.parse(first.stdout);
    expect(firstResult.bundle.cliCapsule).toMatchObject({
      packageName: '@fixture/aw',
      packageVersion: '0.1.0',
      contentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });

    await fs.writeFile(dependencyPath, 'export const identity = "changed";\n');
    const changed = await run(['--batch-id', firstResult.batchId]);
    expect(changed.exitCode).toBe(2);
    expect(changed.stdout).toBe('');
    expect(changed.stderr).toContain('uses a different model environment');

    await fs.writeFile(dependencyPath, 'export const identity = "first";\n');
    const unchanged = await run(['--batch-id', firstResult.batchId]);
    expect(unchanged.exitCode, unchanged.stderr).toBe(0);
    const unchangedResult = JSON.parse(unchanged.stdout);
    expect(unchangedResult.bundle.cliCapsule).toEqual(firstResult.bundle.cliCapsule);
    expect(unchangedResult.bundle.suites[0].caseResults[0]).toMatchObject({
      reused: true,
      sourceRunId: firstResult.runId,
    });
    for (const target of deployedTargets) {
      await expect(fs.pathExists(path.dirname(target))).resolves.toBe(false);
    }
  }, 30_000);

  it('rejects plugin path traversal before resolving a manifest', async () => {
    let stderr = '';
    const exitCode = await runPluginEvals([
      '../outside-plugin',
      '--skill',
      'outside-skill',
      '--materialize-only',
      '--batch-name',
      'test-batch',
    ], {
      repoRoot: repoRoot(),
      stderr: (text) => { stderr += text; },
    });

    expect(exitCode).toBe(2);
    expect(stderr).toContain('without path separators');
  });

  it('rejects case ids that can escape the report target directory', async () => {
    let stderr = '';
    const exitCode = await runPluginEvals([
      'codex-enhance',
      '--skill',
      'codex-subagent-guide',
      '--suite',
      'trigger',
      '--case',
      '../../escaped',
      '--batch-name',
      'test-batch',
    ], {
      repoRoot: repoRoot(),
      stderr: (text) => { stderr += text; },
    });

    expect(exitCode).toBe(2);
    expect(stderr).toContain('safe report path segment');
  });

  it('blocks model eval under a macOS accountsKeychainExport wrapper', async () => {
    let stderr = '';
    const exitCode = await runPluginEvals([
      'codex-enhance',
      '--skill',
      'codex-subagent-guide',
      '--batch-name',
      'test-batch',
    ], {
      repoRoot: repoRoot(),
      platform: 'darwin',
      readUserKeychainSearchList: async () =>
        '    "/private/tmp/accountsKeychainExport123/accountsKeychainExport.keychain"\n',
      stderr: (text) => { stderr += text; },
    });

    expect(exitCode).toBe(2);
    expect(stderr).toContain('ordinary Terminal');
  });

  it('does not inspect the keychain for materialize-only eval', async () => {
    const root = repoRoot();
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-materialize-'));
    tempDirs.push(outputRoot);
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    const readUserKeychainSearchList = vi.fn(async () => {
      throw new Error('must not inspect the keychain');
    });

    const exitCode = await runPluginEvals([
      'codex-enhance',
      '--skill',
      'codex-subagent-guide',
      '--materialize-only',
    ], {
      repoRoot: root,
      platform: 'darwin',
      readUserKeychainSearchList,
      env: process.env,
      stdout: () => undefined,
      stderr: () => undefined,
      createRunLayout: testRunLayoutFactory(outputRoot),
    });

    expect(exitCode).toBe(0);
    expect(readUserKeychainSearchList).not.toHaveBeenCalled();
  });

  it('blocks a restricted Codex session before keychain, process, or report allocation', async () => {
    const readUserKeychainSearchList = vi.fn(async () => '');
    const inspectProcessTree = vi.fn(async () => undefined);
    const createRunLayout = vi.fn(testRunLayoutFactory(path.join(os.tmpdir(), 'unused-eval-output')));
    let stderr = '';

    const exitCode = await runPluginEvals([
      'codex-enhance',
      '--skill',
      'codex-subagent-guide',
      '--batch-name',
      'test-batch',
    ], {
      repoRoot: repoRoot(),
      env: { ...process.env, CODEX_PERMISSION_PROFILE: ':workspace' },
      platform: 'darwin',
      readUserKeychainSearchList,
      inspectProcessTree,
      stderr: (text) => { stderr += text; },
      createRunLayout,
    });

    expect(exitCode).toBe(2);
    expect(stderr).toContain('CODEX_PERMISSION_PROFILE=workspace');
    expect(stderr).toContain('sandbox_permissions=require_escalated');
    expect(stderr).toContain('Do not retry');
    expect(readUserKeychainSearchList).not.toHaveBeenCalled();
    expect(inspectProcessTree).not.toHaveBeenCalled();
    expect(createRunLayout).not.toHaveBeenCalled();
  });

  it('blocks before report allocation or model start when Full Access is unavailable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-full-access-'));
    const marker = path.join(root, 'codex-started');
    const codexBin = path.join(root, 'fake-codex');
    tempDirs.push(root);
    await fs.writeFile(codexBin, [
      '#!/usr/bin/env node',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`,
    ].join('\n'), 'utf8');
    await fs.chmod(codexBin, 0o755);
    const createRunLayout = vi.fn(testRunLayoutFactory(path.join(root, 'output')));
    let stderr = '';

    const exitCode = await runPluginEvals([
      'codex-enhance',
      '--skill',
      'codex-subagent-guide',
      '--codex-bin',
      codexBin,
    ], {
      repoRoot: repoRoot(),
      platform: 'linux',
      inspectProcessTree: async () => { throw new Error('process inspection denied'); },
      stdout: () => undefined,
      stderr: (text) => { stderr += text; },
      createRunLayout,
    });

    expect(exitCode).toBe(2);
    expect(stderr).toContain('Full Access is required');
    expect(stderr).toContain('No model process was started');
    expect(stderr).toContain('--allow-unmanaged-processes');
    expect(createRunLayout).not.toHaveBeenCalled();
    await expect(fs.pathExists(marker)).resolves.toBe(false);
  });

  it('does not claim managed descendant cleanup on Windows without Job Objects', async () => {
    await expect(assertProcessTreeInspectionAvailable({ platform: 'win32' })).rejects.toThrow(
      'Job Object containment',
    );
  });

  it.each(['linux', 'win32'] as const)(
    'runs on %s after unavailable inspection is explicitly confirmed and records the cleanup risk',
    async (platform) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-unmanaged-'));
      const outputRoot = path.join(root, 'output');
      tempDirs.push(root);
      await writeCommandPlugin(root, {
        name: 'unmanaged-demo',
        script: [
          "import { mkdir, writeFile } from 'node:fs/promises';",
          "import path from 'node:path';",
          "const output = process.argv[process.argv.indexOf('--output') + 1];",
          "await mkdir(path.dirname(output), { recursive: true });",
          "await writeFile(output, JSON.stringify({ complete: true, passed: true, summary: {} }));",
        ].join('\n'),
        defaultRuns: 1,
        perRunTimeoutMs: 1_000,
        suiteTimeoutMs: 2_000,
        supports: ['codexBin'],
      });
      registerCurrentTestReadonlyFixtureRoot(root);
      registerCurrentTestWritableStateRoot(outputRoot);
      const inspectProcessTree = vi.fn(async () => {
        throw new Error('process inspection unavailable');
      });
      let stdout = '';
      let stderr = '';

      const exitCode = await runPluginEvals([
        'unmanaged-demo',
        '--skill',
        'unmanaged-demo',
        '--allow-unmanaged-processes',
        '--no-inherit-codex-config',
        '--codex-bin',
        process.execPath,
      ], {
        repoRoot: root,
        env: { ...process.env, CODEX_PERMISSION_PROFILE: undefined },
        platform,
        inspectProcessTree,
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
        createRunLayout: testRunLayoutFactory(outputRoot),
      });

      expect(exitCode, stderr).toBe(0);
      expect(stderr).toContain('WARNING: unmanaged process cleanup was explicitly confirmed');
      expect(stderr).toContain('does not track or verify descendant cleanup');
      expect(inspectProcessTree).toHaveBeenCalledOnce();
      expect(JSON.parse(stdout).bundle.processManagement).toMatchObject({
        mode: 'unmanaged-confirmed',
        inspectionAvailable: false,
        userAcknowledged: true,
        descendantCleanupGuaranteed: false,
      });
    },
  );

  it('materializes every Codex profile one Skill at a time through real staging', async () => {
    const root = repoRoot();
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-all-'));
    tempDirs.push(outputRoot);
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    const targets = [
      ['ask-me', 'decision-grill'],
      ['codex-enhance', 'codex-explore'],
      ['codex-enhance', 'codex-subagent-guide'],
      ['git', 'git-commit'],
    ] as const;
    const bundles = [];
    for (const [plugin, skill] of targets) {
      let stdout = '';
      let stderr = '';
      const exitCode = await runPluginEvals([
        plugin,
        '--skill',
        skill,
        '--materialize-only',
      ], {
        repoRoot: root,
        env: process.env,
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
        createRunLayout: testRunLayoutFactory(outputRoot),
      });
      expect(exitCode, stderr).toBe(0);
      bundles.push(JSON.parse(stdout).bundle);
    }
    expect(bundles.map((bundle: { plugin: string; skill: string }) => [
      bundle.plugin,
      bundle.skill,
    ])).toEqual(targets);
    for (const bundle of bundles) {
      expect(bundle).toMatchObject({
        platform: 'codex',
        codexVersion: null,
        outcome: 'passed',
        complete: true,
        mechanicalPassed: true,
        suites: [],
      });
      expect(bundle.subjects).toEqual(expect.arrayContaining([
        expect.objectContaining({
          profile: 'project-default',
          scope: 'project',
          modelExecution: true,
          evidenceLevel: 'runtime-project',
        }),
        expect.objectContaining({
          profile: 'user-default',
          scope: 'user',
          modelExecution: false,
          evidenceLevel: 'materialized-user',
        }),
      ]));
      await expect(
        fs.pathExists(path.join(
          outputRoot,
          bundle.plugin,
          bundle.skill,
        )),
      ).resolves.toBe(true);
    }

    for (const skillName of ['codex-explore', 'codex-subagent-guide']) {
      const bundle = bundles.find(
        (entry: { plugin: string; skill: string }) =>
          entry.plugin === 'codex-enhance' && entry.skill === skillName,
      );
      const evalManifest = await fs.readJson(path.join(
        root,
        'plugins',
        'codex-enhance',
        'skills',
        skillName,
        'evals',
        'manifest.json',
      )) as { profiles: Array<{ id: string }> };
      expect(bundle.subjects.map((subject: { profile: string }) => subject.profile).sort())
        .toEqual(evalManifest.profiles.map((profile) => profile.id).sort());
      const defaultProfile = bundle.subjects.find(
        (entry: { profile: string }) => entry.profile === 'project-default',
      );
      const nondefaultProfile = bundle.subjects.find(
        (entry: { profile: string }) => entry.profile === 'project-nondefault',
      );
      expect(nondefaultProfile.configDigest).not.toBe(defaultProfile.configDigest);
      expect(nondefaultProfile.modelExecution).toBe(false);
      expect(nondefaultProfile.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'skill' }),
        expect.objectContaining({ kind: 'agent' }),
        expect.objectContaining({ kind: 'instruction' }),
      ]));
      if (skillName === 'codex-explore') {
        expect(bundle.subjects).toContainEqual(expect.objectContaining({
          profile: 'project-short-wait',
          scope: 'project',
          modelExecution: true,
          evidenceLevel: 'runtime-project',
        }));
      }
    }
  });

  it('records case composition contracts in the report batch', async () => {
    const root = repoRoot();
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-composition-'));
    tempDirs.push(outputRoot);
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    let stdout = '';
    let stderr = '';
    const exitCode = await runPluginEvals([
      'codex-enhance',
      '--skill',
      'codex-subagent-guide',
      '--materialize-only',
    ], {
      repoRoot: root,
      env: process.env,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      createRunLayout: testRunLayoutFactory(outputRoot),
    });
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(stdout);
    const batch = await fs.readJson(path.join(
      outputRoot,
      'codex-enhance',
      'codex-subagent-guide',
      result.batchId,
      'batch.json',
    ));
    expect(batch.targetCompositions).toMatchObject({
      'command/lifecycle/project-default/all/all': [
        'command/lifecycle/project-default/all/wait_for_terminal_result',
      ],
    });
    expect(batch.targetCompositions['command/routing/project-default/all/all']).toHaveLength(18);
    expect(batch.targetCompositions['command/routing/project-default/all/all']).toContain(
      'command/routing/project-default/all/project_rule_partial_context',
    );
    expect(batch.targetCompositions['trigger/trigger/project-default/validation/all']).toContain(
      'trigger/trigger/project-default/validation/validation_parallel_general',
    );
    expect(batch.targetCompositions['trigger/trigger/project-default/sanity/all']).toContain(
      'trigger/trigger/project-default/sanity/sanity_docs_only',
    );
  });

  it('rejects suite flags that the selected driver cannot honor', async () => {
    const root = repoRoot();
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-flags-'));
    tempDirs.push(outputRoot);
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    let stderr = '';

    const exitCode = await runPluginEvals([
      'ask-me',
      '--skill',
      'decision-grill',
      '--no-inherit-codex-config',
      '--suite',
      'behavior',
      '--split',
      'validation',
    ], {
      repoRoot: root,
      env: process.env,
      stdout: () => undefined,
      stderr: (text) => { stderr += text; },
      createRunLayout: testRunLayoutFactory(outputRoot),
    });

    expect(exitCode).toBe(2);
    expect(stderr).toContain(
      'Conversation suite "behavior" does not support --split.',
    );
  });

  it.runIf(process.platform !== 'win32')(
    'runs a selected trigger case from a non-first release split',
    async () => {
      const root = repoRoot();
      const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-case-'));
      tempDirs.push(outputRoot);
      registerCurrentTestReadonlyFixtureRoot(root);
      registerCurrentTestWritableStateRoot(outputRoot);
      const oldBin = path.join(outputRoot, 'old-bin');
      const oldMarker = path.join(outputRoot, 'old-aw-ran');
      const cliProbePath = path.join(outputRoot, 'aw-probes.jsonl');
      await fs.ensureDir(oldBin);
      await fs.writeFile(path.join(oldBin, 'aw'), [
        '#!/bin/sh',
        `printf old > ${JSON.stringify(oldMarker)}`,
        'exit 19',
      ].join('\n'), { encoding: 'utf8', mode: 0o700 });
      const codexBin = await writeFakeCodex(outputRoot, 'codex-explore', cliProbePath);
      let stdout = '';
      let stderr = '';

      const exitCode = await runPluginEvals([
        'codex-enhance',
        '--skill',
        'codex-explore',
        '--no-inherit-codex-config',
        '--suite',
        'trigger',
        '--case',
        'casual_unknown_repo',
        '--runs',
        '1',
        '--codex-bin',
        codexBin,
      ], {
        repoRoot: root,
        env: {
          ...process.env,
          PATH: [oldBin, process.env.PATH].filter(Boolean).join(path.delimiter),
        },
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
        inspectProcessTree: async () => undefined,
        createRunLayout: testRunLayoutFactory(outputRoot),
        deployEvalCli: undefined,
      });

      expect(exitCode, stderr).toBe(1);
      expect(stderr).toContain('codex-enhance/trigger/all');
      expect(stderr).not.toContain('codex-enhance/trigger/validation');
      const commandReport = JSON.parse(stdout);
      const probeLines = (await fs.readFile(cliProbePath, 'utf8')).trim().split('\n');
      expect(
        commandReport.bundle,
        JSON.stringify(commandReport.bundle, null, 2),
      ).toMatchObject({
        outcome: 'incomplete',
        complete: false,
        mechanicalPassed: true,
        diagnostics: expect.arrayContaining([
          expect.stringContaining('--suite'),
          expect.stringContaining('--case'),
          expect.stringContaining('--runs'),
        ]),
      });
      expect(commandReport.bundle.suites).toEqual([
        expect.objectContaining({ split: 'all', outcome: 'incomplete', complete: false }),
      ]);
      const probes = probeLines.map(
        (line) => JSON.parse(line) as {
          resolvedAw: string;
          launcher: string;
          envEntry: string;
          entryRealpath: string;
          moduleRealpath: string;
          dependencyBinPresent: boolean;
          awVersion: string;
          validateHelp: string;
        },
      );
      expect(probes.length).toBeGreaterThanOrEqual(2);
      expect(new Set(probes.map((probe) => probe.resolvedAw))).toHaveLength(1);
      expect(probes.every((probe) => probe.awVersion === '0.1.0')).toBe(true);
      expect(probes.every((probe) => probe.validateHelp.includes('Usage: aw plugin validate')))
        .toBe(true);
      for (const probe of probes) {
        expect(JSON.stringify(probe)).not.toContain(root);
        expect(probe.entryRealpath).toMatch(/\/cli\/dist\/index\.js$/u);
        expect(probe.moduleRealpath).toContain(`${path.sep}cli${path.sep}node_modules${path.sep}`);
        expect(probe.dependencyBinPresent).toBe(false);
      }
      await expect(fs.pathExists(oldMarker)).resolves.toBe(false);
      await expect(fs.pathExists(probes[0]!.resolvedAw)).resolves.toBe(false);
      expect(JSON.stringify(commandReport.bundle)).not.toContain(
        path.join(root, 'packages', 'cli'),
      );
    },
    90_000,
  );

  it.runIf(process.platform !== 'win32')(
    'inherits only the selected Codex provider and keeps embedded credentials out of reports',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-provider-'));
      const sourceCodexHome = path.join(root, 'source-codex-home');
      const outputRoot = path.join(root, 'output');
      tempDirs.push(root);
      await fs.ensureDir(sourceCodexHome);
      await fs.writeFile(path.join(sourceCodexHome, 'auth.json'), '{"token":"official"}\n', 'utf8');
      await fs.writeFile(path.join(sourceCodexHome, 'config.toml'), [
        'model = "fixture-model"',
        'model_provider = "fixture-provider"',
        '',
        '[model_providers.fixture-provider]',
        'name = "Fixture"',
        'base_url = "https://example.invalid/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        'experimental_bearer_token = "fixture-secret"',
        '',
        '[plugins."do-not-copy@local"]',
        'enabled = true',
      ].join('\n'), 'utf8');
      const codexBin = await writeProviderCheckingFakeCodex(root, 'codex-explore');
      let stdout = '';
      let stderr = '';

      const exitCode = await runPluginEvals([
        'codex-enhance',
        '--skill',
        'codex-explore',
        '--suite',
        'trigger',
        '--case',
        'cross_module_fact',
        '--runs',
        '1',
        '--codex-bin',
        codexBin,
      ], {
        repoRoot: repoRoot(),
        env: {
          ...process.env,
          CODEX_HOME: sourceCodexHome,
          OPENAI_API_KEY: 'official-api-key',
          UNRELATED_SECRET: 'unrelated-secret',
        },
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
        inspectProcessTree: async () => undefined,
        createRunLayout: testRunLayoutFactory(outputRoot),
      });

      expect(exitCode, stderr).toBe(1);
      const commandReport = JSON.parse(stdout);
      expect(commandReport.bundle, stderr).toMatchObject({
        model: 'gpt-5.6-luna',
        modelProvider: 'fixture-provider',
        credentialSource: 'embedded',
        outcome: 'incomplete',
        complete: false,
      });
      expect(stdout).not.toContain('fixture-secret');
      expect(stdout).not.toContain('https://example.invalid/v1');
      expect(stderr).not.toContain('fixture-secret');
      expect(stderr).not.toContain('https://example.invalid/v1');
      const reportRoot = path.resolve(repoRoot(), commandReport.reportDir);
      expect(
        await fs.readFile(
          path.join(reportRoot, 'raw', 'evaluation.json'),
          'utf8',
        ),
      ).not.toContain('fixture-secret');
      expect(
        await fs.readFile(
          path.join(
            reportRoot,
            'raw',
            'reports',
            'trigger-all-project-default.json',
          ),
          'utf8',
        ),
      ).not.toContain('https://example.invalid/v1');
    },
  );

  it('redacts command-suite provider values and excludes unrelated host secrets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-command-redaction-'));
    const outputRoot = path.join(root, 'output');
    const sourceCodexHome = path.join(root, 'source-codex-home');
    tempDirs.push(root);
    await writeCommandPlugin(root, {
      name: 'redaction-demo',
      script: [
        "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        "if (process.env.UNRELATED_SECRET || process.env.OPENAI_API_KEY) process.exit(9);",
        "const config = await readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');",
        "const endpoint = config.match(/base_url = \\\"([^\\\"]+)/)?.[1];",
        "process.stderr.write(`${process.env.CUSTOM_TOKEN} ${endpoint}\\n`);",
        "const output = process.argv[process.argv.indexOf('--output') + 1];",
        "await mkdir(path.dirname(output), { recursive: true });",
        "await writeFile(output, JSON.stringify({ complete: true, passed: true, summary: { token: process.env.CUSTOM_TOKEN, endpoint, owner: process.env.AW_CODEX_EVAL_PROCESS_TREE_ID } }));",
        "process.stdout.write(JSON.stringify({ complete: true, passed: true, summary: { token: process.env.CUSTOM_TOKEN, endpoint } }));",
      ].join('\n'),
      defaultRuns: 1,
      perRunTimeoutMs: 1_000,
      suiteTimeoutMs: 2_000,
      supports: ['codexBin'],
    });
    await fs.ensureDir(sourceCodexHome);
    await fs.writeFile(path.join(sourceCodexHome, 'config.toml'), [
      'model_provider = "custom"',
      '[model_providers.custom]',
      'name = "Custom"',
      'base_url = "https://private.invalid/v1"',
      'env_key = "CUSTOM_TOKEN"',
    ].join('\n'), 'utf8');
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    let stdout = '';
    let stderr = '';

    const exitCode = await runPluginEvals([
      'redaction-demo',
      '--skill',
      'redaction-demo',
      '--codex-bin',
      process.execPath,
    ], {
      repoRoot: root,
      env: {
        ...process.env,
        CODEX_HOME: sourceCodexHome,
        CUSTOM_TOKEN: 'command-token',
        OPENAI_API_KEY: 'official-api-key',
        UNRELATED_SECRET: 'unrelated-secret',
      },
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      inspectProcessTree: async () => undefined,
      createRunLayout: testRunLayoutFactory(outputRoot),
    });

    expect(exitCode, stderr).toBe(0);
    expect(stdout).not.toContain('command-token');
    expect(stdout).not.toContain('https://private.invalid/v1');
    expect(stderr).toContain('[redacted] [redacted]\n');
    expect(stderr).not.toContain('command-token');
    expect(stderr).not.toContain('https://private.invalid/v1');
    const commandReport = JSON.parse(stdout);
    const reportRoot = path.resolve(root, commandReport.reportDir);
    const evaluation = await fs.readFile(path.join(reportRoot, 'raw', 'evaluation.json'), 'utf8');
    expect(evaluation).not.toContain('command-token');
    expect(evaluation).not.toContain('https://private.invalid/v1');
    const persistedReport = await fs.readFile(
      path.join(reportRoot, 'raw', 'reports', 'command-project-default.json'),
      'utf8',
    );
    expect(persistedReport).not.toContain('command-token');
    expect(persistedReport).not.toContain('https://private.invalid/v1');
    expect(persistedReport).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u,
    );
    expect(persistedReport).toContain('[redacted]');
    expect(persistedReport).toContain('[process-tree-id]');
  });

  it('keeps a full command target retryable when one reported case is incomplete', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-incomplete-case-'));
    const outputRoot = path.join(root, 'output');
    tempDirs.push(root);
    await writeCommandPlugin(root, {
      name: 'incomplete-case-demo',
      script: [
        'process.stdout.write(JSON.stringify({',
        '  passed: false,',
        '  case_results: [{ id: "selected_case", outcome: "incomplete", complete: false, mechanical_passed: false }],',
        '}));',
        'process.exitCode = 1;',
      ].join('\n'),
      defaultRuns: 1,
      perRunTimeoutMs: 1_000,
      suiteTimeoutMs: 2_000,
      supports: ['case', 'codexBin'],
    });
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    let stdout = '';
    let stderr = '';

    const exitCode = await runPluginEvals([
      'incomplete-case-demo',
      '--skill',
      'incomplete-case-demo',
      '--no-inherit-codex-config',
      '--codex-bin',
      process.execPath,
    ], {
      repoRoot: root,
      env: process.env,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      inspectProcessTree: async () => undefined,
      createRunLayout: testRunLayoutFactory(outputRoot),
    });

    expect(exitCode, stderr).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.bundle.suites).toEqual([
      expect.objectContaining({
        outcome: 'incomplete',
        complete: false,
        mechanicalPassed: false,
      }),
    ]);
    expect(result.batchSummary.eval).toMatchObject({
      releaseOutcome: 'incomplete',
      complete: false,
      mechanicalPassed: false,
    });
    expect(result.batchSummary.eval.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: 'command/command/project-default/all/all',
        outcome: 'incomplete',
        complete: false,
      }),
      expect.objectContaining({
        target: 'command/command/project-default/all/selected_case',
        outcome: 'incomplete',
        complete: false,
      }),
    ]));
  });

  it('resumes an incomplete command suite by rerunning only the current and remaining cases', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-case-resume-'));
    const outputRoot = path.join(root, 'output');
    const statePath = path.join(root, 'eval-state.json');
    tempDirs.push(root);
    await writeCommandPlugin(root, {
      name: 'case-resume-demo',
      script: [
        "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        `const statePath = ${JSON.stringify(statePath)};`,
        "const caseId = process.argv[process.argv.indexOf('--case') + 1];",
        "const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]);",
        "const output = process.argv[process.argv.indexOf('--output') + 1];",
        "let state = { calls: [], failedOnce: false };",
        "try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch {}",
        "state.calls.push({ caseId, runs });",
        "const incomplete = caseId === 'case_b' && !state.failedOnce;",
        "if (incomplete) state.failedOnce = true;",
        "await writeFile(statePath, JSON.stringify(state));",
        "const report = {",
        "  complete: !incomplete,",
        "  passed: !incomplete,",
        "  case_results: [{",
        "    id: caseId,",
        "    outcome: incomplete ? 'incomplete' : 'passed',",
        "    complete: !incomplete,",
        "    mechanical_passed: !incomplete,",
        "  }],",
        "  summary: { runs },",
        "};",
        "await mkdir(path.dirname(output), { recursive: true });",
        "await writeFile(output, JSON.stringify(report));",
        "process.stdout.write(JSON.stringify(report));",
        "if (incomplete) process.exitCode = 1;",
      ].join('\n'),
      defaultRuns: 3,
      perRunTimeoutMs: 1_000,
      suiteTimeoutMs: 5_000,
      supports: ['case', 'runs', 'codexBin'],
      caseIds: ['case_a', 'case_b', 'case_c'],
    });
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    const createRunLayout = testRunLayoutFactory(outputRoot);
    const commonOptions = {
      repoRoot: root,
      env: process.env,
      inspectProcessTree: async () => undefined,
      createRunLayout,
    };
    let firstStdout = '';
    let firstStderr = '';

    const firstExitCode = await runPluginEvals([
      'case-resume-demo',
      '--skill',
      'case-resume-demo',
      '--batch-name',
      'case-resume',
      '--no-inherit-codex-config',
      '--codex-bin',
      process.execPath,
    ], {
      ...commonOptions,
      stdout: (text) => { firstStdout += text; },
      stderr: (text) => { firstStderr += text; },
    });

    expect(firstExitCode, firstStderr).toBe(1);
    expect(firstStderr).toContain('use the longest responsive wait that the tool allows');
    expect(firstStderr).toContain('A wait timeout is not an eval failure');
    const first = JSON.parse(firstStdout);
    expect(first.bundle.suites[0]).toMatchObject({
      outcome: 'incomplete',
      complete: false,
      caseResults: [
        { id: 'case_a', complete: true, reused: false },
        { id: 'case_b', complete: false, reused: false },
      ],
    });
    expect((await fs.readJson(statePath)).calls).toEqual([
      { caseId: 'case_a', runs: 3 },
      { caseId: 'case_b', runs: 3 },
    ]);

    let resumedStdout = '';
    let resumedStderr = '';
    const resumedExitCode = await runPluginEvals([
      'case-resume-demo',
      '--skill',
      'case-resume-demo',
      '--batch-id',
      first.batchId,
      '--no-inherit-codex-config',
      '--codex-bin',
      process.execPath,
    ], {
      ...commonOptions,
      stdout: (text) => { resumedStdout += text; },
      stderr: (text) => { resumedStderr += text; },
    });

    expect(resumedExitCode, resumedStderr).toBe(0);
    expect(resumedStderr).toContain('reuse=1 pending=2');
    const resumed = JSON.parse(resumedStdout);
    expect(resumed.bundle.suites[0]).toMatchObject({
      outcome: 'passed',
      complete: true,
      caseResults: [
        { id: 'case_a', complete: true, reused: true, sourceRunId: first.runId },
        { id: 'case_b', complete: true, reused: false, sourceRunId: resumed.runId },
        { id: 'case_c', complete: true, reused: false, sourceRunId: resumed.runId },
      ],
    });
    expect(resumed.batchSummary.eval).toMatchObject({
      releaseOutcome: 'passed',
      complete: true,
      mechanicalPassed: true,
    });
    expect((await fs.readJson(statePath)).calls).toEqual([
      { caseId: 'case_a', runs: 3 },
      { caseId: 'case_b', runs: 3 },
      { caseId: 'case_b', runs: 3 },
      { caseId: 'case_c', runs: 3 },
    ]);
  });

  it('runs every command case when a reduced run count only makes coverage incomplete', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-reduced-runs-'));
    const outputRoot = path.join(root, 'output');
    const statePath = path.join(root, 'eval-state.json');
    tempDirs.push(root);
    await writeCommandPlugin(root, {
      name: 'reduced-runs-demo',
      script: [
        "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        `const statePath = ${JSON.stringify(statePath)};`,
        "const caseId = process.argv[process.argv.indexOf('--case') + 1];",
        "const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]);",
        "const output = process.argv[process.argv.indexOf('--output') + 1];",
        'let calls = [];',
        "try { calls = JSON.parse(await readFile(statePath, 'utf8')); } catch {}",
        'calls.push({ caseId, runs });',
        'await writeFile(statePath, JSON.stringify(calls));',
        'const report = {',
        '  complete: true,',
        '  passed: true,',
        '  case_results: [{',
        '    id: caseId, outcome: "passed", complete: true, mechanical_passed: true,',
        '  }],',
        '  summary: { runs },',
        '};',
        "await mkdir(path.dirname(output), { recursive: true });",
        'await writeFile(output, JSON.stringify(report));',
        'process.stdout.write(JSON.stringify(report));',
      ].join('\n'),
      defaultRuns: 3,
      perRunTimeoutMs: 1_000,
      suiteTimeoutMs: 5_000,
      supports: ['case', 'runs', 'codexBin'],
      caseIds: ['case_a', 'case_b', 'case_c'],
    });
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    let stdout = '';
    let stderr = '';

    const exitCode = await runPluginEvals([
      'reduced-runs-demo',
      '--skill',
      'reduced-runs-demo',
      '--batch-name',
      'reduced-runs',
      '--suite',
      'command',
      '--runs',
      '1',
      '--no-inherit-codex-config',
      '--codex-bin',
      process.execPath,
    ], {
      repoRoot: root,
      env: process.env,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      inspectProcessTree: async () => undefined,
      createRunLayout: testRunLayoutFactory(outputRoot),
    });

    expect(exitCode, stderr).toBe(1);
    expect(await fs.readJson(statePath)).toEqual([
      { caseId: 'case_a', runs: 1 },
      { caseId: 'case_b', runs: 1 },
      { caseId: 'case_c', runs: 1 },
    ]);
    expect(JSON.parse(stdout).bundle.suites[0]).toMatchObject({
      outcome: 'incomplete',
      complete: false,
      caseResults: [
        { id: 'case_a', outcome: 'incomplete', complete: false },
        { id: 'case_b', outcome: 'incomplete', complete: false },
        { id: 'case_c', outcome: 'incomplete', complete: false },
      ],
    });
  });

  it('does not let a command case result weaken the central suite outcome', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-case-outcome-'));
    const outputRoot = path.join(root, 'output');
    const statePath = path.join(root, 'eval-state.json');
    tempDirs.push(root);
    await writeCommandPlugin(root, {
      name: 'case-outcome-demo',
      script: [
        "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        `const statePath = ${JSON.stringify(statePath)};`,
        "const caseId = process.argv[process.argv.indexOf('--case') + 1];",
        "const output = process.argv[process.argv.indexOf('--output') + 1];",
        'let calls = [];',
        "try { calls = JSON.parse(await readFile(statePath, 'utf8')); } catch {}",
        'calls.push(caseId);',
        'await writeFile(statePath, JSON.stringify(calls));',
        "const incomplete = caseId === 'case_a';",
        'const report = {',
        '  complete: !incomplete,',
        '  passed: !incomplete,',
        '  case_results: [{',
        '    id: caseId, outcome: "passed", complete: true, mechanical_passed: true,',
        '  }],',
        '  summary: {},',
        '};',
        "await mkdir(path.dirname(output), { recursive: true });",
        'await writeFile(output, JSON.stringify(report));',
        'process.stdout.write(JSON.stringify(report));',
      ].join('\n'),
      defaultRuns: 1,
      perRunTimeoutMs: 1_000,
      suiteTimeoutMs: 5_000,
      supports: ['case', 'runs', 'codexBin'],
      caseIds: ['case_a', 'case_b'],
    });
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    let stdout = '';
    let stderr = '';

    const exitCode = await runPluginEvals([
      'case-outcome-demo',
      '--skill',
      'case-outcome-demo',
      '--batch-name',
      'case-outcome',
      '--no-inherit-codex-config',
      '--codex-bin',
      process.execPath,
    ], {
      repoRoot: root,
      env: process.env,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      inspectProcessTree: async () => undefined,
      createRunLayout: testRunLayoutFactory(outputRoot),
    });

    expect(exitCode, stderr).toBe(1);
    expect(await fs.readJson(statePath)).toEqual(['case_a']);
    const result = JSON.parse(stdout);
    expect(result.bundle.suites[0]).toMatchObject({
      outcome: 'incomplete',
      complete: false,
      caseResults: [{
        id: 'case_a', outcome: 'incomplete', complete: false, mechanicalPassed: false,
      }],
    });
    expect(result.batchSummary.eval.targets).toContainEqual(expect.objectContaining({
      target: 'command/command/project-default/all/case_a',
      outcome: 'incomplete',
      complete: false,
    }));
  });

  it('forwards an explicit model to a supporting command suite', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-command-model-'));
    const outputRoot = path.join(root, 'output');
    tempDirs.push(root);
    await writeCommandPlugin(root, {
      name: 'model-demo',
      script: [
        "import { mkdir, writeFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        "const model = process.argv[process.argv.indexOf('--model') + 1];",
        "if (model !== 'gpt-test') process.exit(7);",
        "const output = process.argv[process.argv.indexOf('--output') + 1];",
        "await mkdir(path.dirname(output), { recursive: true });",
        "await writeFile(output, JSON.stringify({ complete: true, passed: true, summary: { model } }));",
      ].join('\n'),
      defaultRuns: 1,
      perRunTimeoutMs: 1_000,
      suiteTimeoutMs: 2_000,
      supports: ['model', 'codexBin'],
    });
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    let stdout = '';
    let stderr = '';

    const exitCode = await runPluginEvals([
      'model-demo',
      '--skill',
      'model-demo',
      '--model',
      'gpt-test',
      '--codex-bin',
      process.execPath,
    ], {
      repoRoot: root,
      env: process.env,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      inspectProcessTree: async () => undefined,
      createRunLayout: testRunLayoutFactory(outputRoot),
    });

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout).bundle.suites[0].summary).toEqual({ model: 'gpt-test' });
  });

  it('materializes a repo-local cross-plugin Skill set for one owner suite', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-composed-'));
    const outputRoot = path.join(root, 'output');
    tempDirs.push(root);
    await writeCommandPlugin(root, {
      name: 'owner-demo',
      script: [
        "import { existsSync } from 'node:fs';",
        "import { mkdir, writeFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        "const skills = JSON.parse(process.env.AW_PLUGIN_EVAL_PARTICIPANT_SKILLS);",
        "const plugins = JSON.parse(process.env.AW_PLUGIN_EVAL_INSTALLED_PLUGINS);",
        "if (!existsSync('.agents/skills/owner-demo/SKILL.md')) process.exit(7);",
        "if (!existsSync('.agents/skills/companion-demo/SKILL.md')) process.exit(8);",
        "if (JSON.stringify(skills) !== JSON.stringify(['owner-demo', 'companion-demo'])) process.exit(9);",
        "if (JSON.stringify(plugins) !== JSON.stringify(['owner-demo', 'companion-demo'])) process.exit(10);",
        "const output = process.argv[process.argv.indexOf('--output') + 1];",
        "await mkdir(path.dirname(output), { recursive: true });",
        "await writeFile(output, JSON.stringify({ complete: true, passed: true, summary: { skills, plugins } }));",
      ].join('\n'),
      defaultRuns: 1,
      perRunTimeoutMs: 1_000,
      suiteTimeoutMs: 3_000,
      supports: ['codexBin'],
    });
    await writeCommandPlugin(root, {
      name: 'companion-demo',
      script: 'process.exit(0);\n',
      defaultRuns: 1,
      perRunTimeoutMs: 1_000,
      suiteTimeoutMs: 3_000,
      supports: [],
    });
    const ownerManifestPath = path.join(
      root,
      'plugins',
      'owner-demo',
      'skills',
      'owner-demo',
      'evals',
      'manifest.json',
    );
    const ownerManifest = await fs.readJson(ownerManifestPath);
    ownerManifest.profiles[0].plugins.push({ name: 'companion-demo', config: {} });
    ownerManifest.suites[0].skills.push('companion-demo');
    await fs.writeJson(ownerManifestPath, ownerManifest, { spaces: 2 });
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    let stdout = '';
    let stderr = '';

    const exitCode = await runPluginEvals([
      'owner-demo',
      '--skill',
      'owner-demo',
      '--codex-bin',
      process.execPath,
    ], {
      repoRoot: root,
      env: process.env,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      inspectProcessTree: async () => undefined,
      createRunLayout: testRunLayoutFactory(outputRoot),
    });

    expect(exitCode, stderr).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.bundle.subjects[0].installedPlugins).toMatchObject([
      { name: 'owner-demo' },
      { name: 'companion-demo' },
    ]);
    expect(report.bundle.suites[0]).toMatchObject({
      skills: ['owner-demo', 'companion-demo'],
      outcome: 'passed',
    });
  });

  it('rejects plugin-wide --all execution', async () => {
    let stderr = '';
    const exitCode = await runPluginEvals([
      '--all',
      '--skill',
      'commit',
    ], {
      stderr: (text) => { stderr += text; },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain('Unknown option "--all"');
  });

  it.runIf(process.platform !== 'win32')(
    'reports an incomplete suite and kills descendants of a timed-out command',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-timeout-'));
      const outputRoot = path.join(root, 'output');
      const descendantMarker = path.join(root, 'descendant-finished');
      tempDirs.push(root);
      const descendantScript = [
        "const fs = require('node:fs');",
        'process.on("SIGTERM", () => {});',
        `setTimeout(() => { fs.writeFileSync(${JSON.stringify(descendantMarker)}, 'alive'); process.exit(0); }, 1800);`,
      ].join('\n');
      await writeCommandPlugin(root, {
        name: 'timeout-demo',
        script: [
          "import { spawn } from 'node:child_process';",
          `spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: 'ignore' });`,
          'process.on("SIGTERM", () => {});',
          'setInterval(() => {}, 1000);',
        ].join('\n'),
        defaultRuns: 1,
        perRunTimeoutMs: 100,
        suiteTimeoutMs: 500,
        supports: ['codexBin'],
      });
      registerCurrentTestReadonlyFixtureRoot(root);
      registerCurrentTestWritableStateRoot(outputRoot);
      const startedAt = Date.now();
      let stdout = '';
      let stderr = '';

      const exitCode = await runPluginEvals([
        'timeout-demo',
        '--skill',
        'timeout-demo',
        '--no-inherit-codex-config',
        '--suite',
        'command',
        '--codex-bin',
        process.execPath,
      ], {
        repoRoot: root,
        env: process.env,
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
        inspectProcessTree: async () => undefined,
        createRunLayout: testRunLayoutFactory(outputRoot),
      });

      expect(exitCode).toBe(1);
      expect(stderr).toContain('Suite exceeded central timeout of 500ms.');
      const commandReport = JSON.parse(stdout);
      expect(commandReport.bundle.suites).toEqual([
        expect.objectContaining({
          outcome: 'incomplete',
          complete: false,
          mechanicalPassed: false,
          diagnostics: expect.arrayContaining([expect.stringContaining('signal=SIGKILL')]),
        }),
      ]);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await expect(fs.pathExists(descendantMarker)).resolves.toBe(false);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'cleans a detached descendant after a successful command closes',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-success-tree-'));
      tempDirs.push(root);
      const marker = path.join(root, 'descendant-survived');
      const pidPath = path.join(root, 'descendant-pid');
      const descendantScript = [
        'process.on("SIGTERM", () => {});',
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 300);`,
        'setInterval(() => {}, 1000);',
      ].join('\n');
      const rootScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: 'ignore' });`,
        'child.unref();',
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
        'process.exit(0);',
      ].join('\n');
      let descendantPid: number | undefined;
      let cleanupStderr = '';
      try {
        await expect(runChild(process.execPath, ['-e', rootScript], {
          cwd: root,
          env: process.env,
          stderr: (text) => { cleanupStderr += text; },
          timeoutMs: 2_000,
        })).resolves.toMatchObject({ exitCode: 0, timedOut: false });
        descendantPid = Number(await fs.readFile(pidPath, 'utf8'));
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(await fs.pathExists(marker), cleanupStderr).toBe(false);
      } finally {
        if (descendantPid) {
          try {
            process.kill(descendantPid, 'SIGKILL');
          } catch {
            // Best-effort test cleanup.
          }
        }
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'keeps the process-tree token out of command output',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-tree-token-'));
      tempDirs.push(root);
      let renderedStderr = '';
      const result = await runChild(process.execPath, ['-e', [
        "const value = process.env.AW_CODEX_EVAL_PROCESS_TREE_ID;",
        'process.stdout.write(value);',
        'process.stderr.write(value);',
      ].join('\n')], {
        cwd: root,
        env: process.env,
        stderr: (text) => { renderedStderr += text; },
        timeoutMs: 2_000,
      });

      expect(result.stdout).toBe('[process-tree-id]');
      expect(result.stderr).toBe('[process-tree-id]');
      expect(renderedStderr.trim()).toBe('[process-tree-id]');
      expect(result).toMatchObject({
        exitCode: 0,
        descendantCleanupGuaranteed: false,
        containmentLimitation: expect.stringContaining('non-portable'),
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'uses the deadline when an exited root leaves inherited pipes open',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-open-pipe-'));
      tempDirs.push(root);
      const marker = path.join(root, 'descendant-survived');
      const pidPath = path.join(root, 'descendant-pid');
      const descendantScript = [
        'process.on("SIGTERM", () => {});',
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 2500);`,
        'setInterval(() => {}, 1000);',
      ].join('\n');
      const rootScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });`,
        'child.unref();',
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
        'setTimeout(() => process.exit(0), 100);',
      ].join('\n');
      let descendantPid: number | undefined;
      try {
        await expect(runChild(process.execPath, ['-e', rootScript], {
          cwd: root,
          env: process.env,
          stderr: () => undefined,
          timeoutMs: 400,
        })).resolves.toMatchObject({ timedOut: true });
        descendantPid = Number(await fs.readFile(pidPath, 'utf8'));
        await new Promise((resolve) => setTimeout(resolve, 500));
        await expect(fs.pathExists(marker)).resolves.toBe(false);
      } finally {
        if (descendantPid) {
          try {
            process.kill(descendantPid, 'SIGKILL');
          } catch {
            // Best-effort test cleanup.
          }
        }
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'does not time out a child that closes before cleanup crosses the deadline',
    async () => {
      await assertProcessTreeInspectionAvailable();
      const terminate = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        return [];
      });

      await expect(runChild(process.execPath, ['-e', 'process.exit(0);'], {
        cwd: process.cwd(),
        env: process.env,
        stderr: () => undefined,
        timeoutMs: 500,
        createProcessTreeMonitor: () => ({ terminate }),
      })).resolves.toMatchObject({
        exitCode: 0,
        signal: null,
        timedOut: false,
      });
      expect(terminate).toHaveBeenCalledOnce();
    },
  );

  it('keeps a successful result when cleanup is confirmed with monitor diagnostics', async () => {
    const diagnostic = 'Could not monitor the POSIX process tree before cleanup: temporary scan timeout.';
    const terminate = vi.fn(async () => [diagnostic]);
    let renderedStderr = '';

    await expect(runChild(process.execPath, ['-e', 'process.exit(0);'], {
      cwd: process.cwd(),
      env: process.env,
      stderr: (text) => { renderedStderr += text; },
      timeoutMs: 1_000,
      createProcessTreeMonitor: () => ({ terminate }),
    })).resolves.toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stderr: `${diagnostic}\n`,
    });
    expect(renderedStderr).toContain(diagnostic);
    expect(processTreeCleanupIsUnconfirmed([diagnostic])).toBe(false);
  });

  it.runIf(process.platform !== 'win32')(
    'terminates an active command suite and prevents the next suite before re-emitting SIGTERM',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-signal-'));
      tempDirs.push(root);
      const baselineHandlers = new Set(process.listeners('SIGTERM'));
      const originalKill = process.kill.bind(process);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === process.pid) return true;
        return originalKill(pid, signal);
      });

      try {
        const childResult = runChild(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000);'],
          {
            cwd: root,
            env: process.env,
            stderr: () => undefined,
            timeoutMs: 10_000,
          },
        );
        await vi.waitFor(() => {
          expect(process.listeners('SIGTERM').some((handler) => !baselineHandlers.has(handler)))
            .toBe(true);
        });
        const signalHandler = process.listeners('SIGTERM')
          .find((handler) => !baselineHandlers.has(handler));
        expect(signalHandler).toBeDefined();
        signalHandler!();

        await expect(childResult).resolves.toMatchObject({
          signal: 'SIGKILL',
          timedOut: false,
        });
        await vi.waitFor(() => {
          expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
        });
        const secondSuiteMarker = path.join(root, 'second-suite-started');
        await expect(runChild(
          process.execPath,
          [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(secondSuiteMarker)}, 'started');`,
          ],
          {
            cwd: root,
            env: process.env,
            stderr: () => undefined,
            timeoutMs: 10_000,
          },
        )).rejects.toThrow('signal shutdown is in progress');
        await expect(fs.pathExists(secondSuiteMarker)).resolves.toBe(false);
      } finally {
        resetCodexEvalSignalShutdownForTests();
        killSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'stops polling and reports when SIGKILL termination cannot be confirmed',
    async () => {
      const fakePid = 2_147_483_000;
      const originalKill = process.kill.bind(process);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === fakePid || pid === -fakePid) return true;
        return originalKill(pid, signal);
      });
      const startedAt = Date.now();

      try {
        await expect(terminatePosixProcessTree(fakePid, {
          readProcessTable: async () => {
            throw new Error('ps unavailable');
          },
          kill: (pid, signal) => killSpy(pid, signal),
        })).resolves.toContainEqual(
          expect.stringContaining('Could not confirm process-tree cleanup'),
        );
        expect(Date.now() - startedAt).toBeLessThan(4_000);
      } finally {
        killSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'freezes the root before discovering a descendant created at termination',
    async () => {
      const rootPid = 41_000;
      const descendantPid = 41_001;
      const processes = new Map([
        [rootPid, { ppid: 1, state: 'S', startTime: 'root-start' }],
      ]);
      const readProcessTable = vi.fn(async () => new Map(processes));
      let descendantCreated = false;
      const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
        if (pid === -rootPid) {
          if (signal === 0) {
            throw Object.assign(new Error('process group is gone'), { code: 'ESRCH' });
          }
          return true;
        }
        if (pid === rootPid && signal === 'SIGSTOP' && !descendantCreated) {
          descendantCreated = true;
          processes.set(rootPid, { ppid: 1, state: 'T', startTime: 'root-start' });
          processes.set(descendantPid, {
            ppid: rootPid,
            state: 'S',
            startTime: 'descendant-start',
          });
        }
        if (pid === rootPid && signal === 'SIGTERM') {
          processes.delete(rootPid);
          const descendant = processes.get(descendantPid);
          if (descendant) processes.set(descendantPid, { ...descendant, ppid: 1 });
        }
        if (pid === descendantPid && signal === 'SIGSTOP') {
          const descendant = processes.get(descendantPid);
          if (descendant) processes.set(descendantPid, { ...descendant, state: 'T' });
        }
        if (signal === 'SIGKILL') processes.delete(pid);
        return true;
      });

      await terminatePosixProcessTree(rootPid, { readProcessTable, kill });

      expect(kill).toHaveBeenCalledWith(rootPid, 'SIGSTOP');
      expect(kill).toHaveBeenCalledWith(descendantPid, 'SIGKILL');
    },
  );

  it('uses the process group when the POSIX root is missing or already a zombie', async () => {
    const rootPid = 42_000;
    for (const rootEntry of [undefined, { ppid: 1, state: 'Z', startTime: 'root-start' }]) {
      let processGroupRunning = true;
      const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
        if (pid !== -rootPid) return true;
        if (signal === 'SIGKILL') processGroupRunning = false;
        if (signal === 0 && !processGroupRunning) {
          throw Object.assign(new Error('process group is gone'), { code: 'ESRCH' });
        }
        return true;
      });
      const table = new Map<number, { ppid: number; state: string; startTime: string }>();
      if (rootEntry) table.set(rootPid, rootEntry);

      await expect(terminatePosixProcessTree(rootPid, {
        readProcessTable: async () => table,
        kill,
      })).resolves.toEqual([]);

      expect(kill).toHaveBeenCalledWith(-rootPid, 'SIGKILL');
      expect(kill).not.toHaveBeenCalledWith(rootPid, 'SIGSTOP');
    }
  });

  it('does not terminate a reused POSIX descendant PID', async () => {
    const rootPid = 43_000;
    const descendantPid = 43_001;
    const processes = new Map([
      [rootPid, { ppid: 1, state: 'S', startTime: 'root-start' }],
      [descendantPid, { ppid: rootPid, state: 'S', startTime: 'old-start' }],
    ]);
    const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (pid === rootPid && signal === 'SIGSTOP') {
        processes.set(rootPid, { ppid: 1, state: 'T', startTime: 'root-start' });
      }
      if (pid === descendantPid && signal === 'SIGSTOP') {
        processes.set(descendantPid, {
          ppid: rootPid,
          state: 'S',
          startTime: 'reused-start',
        });
      }
      if (pid === rootPid && signal === 'SIGKILL') {
        processes.delete(rootPid);
        processes.set(descendantPid, {
          ppid: 1,
          state: 'S',
          startTime: 'reused-start',
        });
      }
      return true;
    });

    await terminatePosixProcessTree(rootPid, {
      readProcessTable: async () => new Map(processes),
      kill,
    });

    expect(kill).toHaveBeenCalledWith(descendantPid, 'SIGSTOP');
    expect(kill).not.toHaveBeenCalledWith(descendantPid, 'SIGKILL');
    expect(kill).toHaveBeenCalledWith(rootPid, 'SIGKILL');
  });

  function createUnclosedWindowsChild(exitCode: number | null = null): {
    child: ChildProcess;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
    stdout: PassThrough;
    stderr: PassThrough;
  } {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const kill = vi.fn(() => true);
    const unref = vi.fn();
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode,
      signalCode: null,
      stdout,
      stderr,
      kill,
      unref,
    }) as unknown as ChildProcess;
    return { child, kill, unref, stdout, stderr };
  }

  it('bounds Windows close confirmation after taskkill succeeds', async () => {
    const fixture = createUnclosedWindowsChild(0);

    await expect(terminateWindowsProcessTree(fixture.child, {
      closeTimeoutMs: 10,
      runTaskkill: async () => undefined,
    })).resolves.toContainEqual(expect.stringContaining(
      'Could not confirm Windows process-tree termination within 10ms after taskkill',
    ));
    expect(fixture.stdout.destroyed).toBe(true);
    expect(fixture.stderr.destroyed).toBe(true);
    expect(fixture.unref).toHaveBeenCalledOnce();
  });

  it('bounds Windows close confirmation after the SIGKILL fallback', async () => {
    const fixture = createUnclosedWindowsChild();

    await expect(terminateWindowsProcessTree(fixture.child, {
      closeTimeoutMs: 10,
      runTaskkill: async () => { throw new Error('taskkill unavailable'); },
    })).resolves.toEqual(expect.arrayContaining([
      expect.stringContaining('taskkill failure: taskkill unavailable'),
      expect.stringContaining('and SIGKILL fallback'),
    ]));
    expect(fixture.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fixture.stdout.destroyed).toBe(true);
    expect(fixture.stderr.destroyed).toBe(true);
    expect(fixture.unref).toHaveBeenCalledOnce();
  });

  it('keeps Windows tree cleanup unconfirmed when taskkill fails but SIGKILL closes the root', async () => {
    const fixture = createUnclosedWindowsChild();
    fixture.kill.mockImplementation(() => {
      fixture.child.emit('close');
      return true;
    });

    const diagnostics = await terminateWindowsProcessTree(fixture.child, {
      closeTimeoutMs: 10,
      runTaskkill: async () => { throw new Error('taskkill unavailable'); },
    });

    expect(diagnostics).toEqual([
      expect.stringContaining('Could not verify Windows process-tree termination'),
    ]);
    expect(processTreeCleanupIsUnconfirmed(diagnostics)).toBe(true);
  });

  it('waits for close after taskkill fails even when the Windows child has exited', async () => {
    const fixture = createUnclosedWindowsChild(1);

    await expect(terminateWindowsProcessTree(fixture.child, {
      closeTimeoutMs: 10,
      runTaskkill: async () => { throw new Error('process already exited'); },
    })).resolves.toEqual(expect.arrayContaining([
      expect.stringContaining('taskkill failure: process already exited'),
      expect.stringContaining('after taskkill failure; process 4242 may still be running'),
    ]));
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(fixture.stdout.destroyed).toBe(true);
    expect(fixture.stderr.destroyed).toBe(true);
    expect(fixture.unref).toHaveBeenCalledOnce();
  });

  it('does not taskkill an exited Windows root PID', async () => {
    const fixture = createUnclosedWindowsChild(0);
    const runTaskkill = vi.fn(async () => undefined);

    const diagnostics = await createWindowsChildProcessTreeMonitor(fixture.child, {
      closeTimeoutMs: 10,
      runTaskkill,
    }).terminate();

    expect(runTaskkill).not.toHaveBeenCalled();
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(processTreeCleanupIsUnconfirmed(diagnostics)).toBe(false);
    expect(diagnostics).toContainEqual(expect.stringContaining(
      'potentially reused PID',
    ));
  });

  it('taskkills a Windows root that is still running', async () => {
    const fixture = createUnclosedWindowsChild();
    const runTaskkill = vi.fn(async () => {
      fixture.child.emit('close');
    });

    await expect(createWindowsChildProcessTreeMonitor(fixture.child, {
      closeTimeoutMs: 10,
      runTaskkill,
    }).terminate()).resolves.toEqual([]);

    expect(runTaskkill).toHaveBeenCalledOnce();
    expect(runTaskkill).toHaveBeenCalledWith(4242);
  });

  it('marks every debug coverage selector as incomplete evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-coverage-'));
    tempDirs.push(root);
    await writeCommandPlugin(root, {
      name: 'coverage-demo',
      script: [
        'process.stdout.write(JSON.stringify({',
        '  complete: true,',
        '  passed: true,',
        '  case_results: [{ id: "selected_case", outcome: "passed", complete: true, mechanical_passed: true }],',
        '}));',
      ].join('\n'),
      defaultRuns: 2,
      perRunTimeoutMs: 1_000,
      suiteTimeoutMs: 2_000,
      supports: ['split', 'case', 'runs', 'codexBin'],
    });
    registerCurrentTestReadonlyFixtureRoot(root);

    const cases = [
      { name: 'suite', args: ['--suite', 'command'], diagnostic: '--suite' },
      { name: 'profile', args: ['--profile', 'project-default'], diagnostic: '--profile' },
      { name: 'split', args: ['--split', 'validation'], diagnostic: '--split' },
      {
        name: 'case',
        args: ['--suite', 'command', '--case', 'selected_case'],
        diagnostic: '--case',
      },
      { name: 'runs', args: ['--runs', '1'], diagnostic: '--runs' },
    ];

    for (const testCase of cases) {
      const outputRoot = path.join(root, `output-${testCase.name}`);
      registerCurrentTestWritableStateRoot(outputRoot);
      let stdout = '';
      let stderr = '';
      const exitCode = await runPluginEvals([
        'coverage-demo',
        '--skill',
        'coverage-demo',
        '--no-inherit-codex-config',
        ...testCase.args,
        '--codex-bin',
        process.execPath,
      ], {
        repoRoot: root,
        env: process.env,
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
        inspectProcessTree: async () => undefined,
        createRunLayout: testRunLayoutFactory(outputRoot),
      });

      expect(exitCode, stderr).toBe(1);
      const result = JSON.parse(stdout);
      const bundle = result.bundle;
      expect(bundle).toMatchObject({
        outcome: 'incomplete',
        complete: false,
        mechanicalPassed: true,
        diagnostics: expect.arrayContaining([
          expect.stringContaining(testCase.diagnostic),
        ]),
      });
      expect(bundle.suites).toEqual([
        expect.objectContaining(testCase.name === 'runs'
          ? { outcome: 'incomplete', complete: false }
          : { outcome: 'passed', complete: true }),
      ]);
      if (testCase.name === 'runs') {
        expect(result.batchSummary.eval.releaseOutcome).toBe('incomplete');
      }
    }
  });

  it('allows multiple legal runs to exceed the per-run timeout in aggregate', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-multi-run-'));
    const outputRoot = path.join(root, 'output');
    tempDirs.push(root);
    await writeCommandPlugin(root, {
      name: 'multi-run-demo',
      script: [
        'const valueAfter = (flag) => process.argv[process.argv.indexOf(flag) + 1];',
        'const runs = Number(valueAfter("--runs"));',
        'const timeoutMs = Number(valueAfter("--timeout-ms"));',
        'for (let index = 0; index < runs; index += 1) {',
        '  await new Promise((resolve) => setTimeout(resolve, 75));',
        '}',
        'process.stdout.write(JSON.stringify({ complete: true, passed: true, summary: { runs, timeoutMs } }));',
      ].join('\n'),
      defaultRuns: 3,
      perRunTimeoutMs: 100,
      suiteTimeoutMs: 2_000,
      supports: ['runs', 'codexBin', 'timeout'],
    });
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    let stdout = '';
    let stderr = '';

    const exitCode = await runPluginEvals([
      'multi-run-demo',
      '--skill',
      'multi-run-demo',
      '--no-inherit-codex-config',
      '--codex-bin',
      process.execPath,
    ], {
      repoRoot: root,
      env: process.env,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      inspectProcessTree: async () => undefined,
      createRunLayout: testRunLayoutFactory(outputRoot),
    });

    expect(exitCode, stderr).toBe(0);
    const commandReport = JSON.parse(stdout);
    expect(commandReport.bundle.suites).toEqual([
      expect.objectContaining({
        outcome: 'passed',
        complete: true,
        summary: expect.objectContaining({ runs: 3, timeoutMs: 100 }),
      }),
    ]);
  });
});
