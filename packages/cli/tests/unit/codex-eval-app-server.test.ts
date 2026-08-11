import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  inspectAppServerConfigWarning,
  runCodexEvalIsolationProbe,
  runCodexConversationSuite,
  settleAppServerProcessCleanup,
} from '../../scripts/codex-eval-app-server.js';
import { resolveCodexEvalRuntimeConfig } from '../../scripts/codex-eval-runtime-config.js';

const tempDirs: string[] = [];

function behaviorCase(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    prompt: 'Prompt.',
    scripted_replies: [],
    expected_output: 'Expected.',
    review: { checks: ['Check.'], workspace_unchanged: true },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('Codex app-server eval driver', () => {
  it('detects app-server config warnings for strict evals', () => {
    expect(inspectAppServerConfigWarning({
      method: 'configWarning',
      params: { summary: 'Project-local config is disabled.' },
    })).toBe('Project-local config is disabled.');
    expect(inspectAppServerConfigWarning({
      method: 'turn/started',
      params: {},
    })).toBeNull();
  });

  it('releases open handles before reporting unconfirmed cleanup', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const unref = vi.fn();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      unref,
    }) as unknown as ChildProcess;
    const waitForClose = vi.fn(async () => false);

    await expect(settleAppServerProcessCleanup({
      child,
      processTreeMonitor: {
        terminate: async () => [
          'Could not confirm process-tree cleanup: token scan unavailable.',
        ],
      },
      waitForClose,
    })).rejects.toThrow('token scan unavailable');

    expect(waitForClose).toHaveBeenCalledWith(1_000);
    expect(stdin.destroyed).toBe(true);
    expect(stdout.destroyed).toBe(true);
    expect(stderr.destroyed).toBe(true);
    expect(unref).toHaveBeenCalledOnce();
  });

  it('answers dynamic request_user_input ids and preserves baseline evidence', async () => {
    const subjectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-app-server-subject-'));
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-app-server-report-'));
    tempDirs.push(subjectRoot, outputRoot);
    await fs.ensureDir(path.join(subjectRoot, '.agents', 'skills', 'ask-me'));
    await fs.writeFile(
      path.join(subjectRoot, '.agents', 'skills', 'ask-me', 'SKILL.md'),
      '# Ask Me\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(subjectRoot, 'app-server'),
      [
        "const readline = require('node:readline');",
        "const input = readline.createInterface({ input: process.stdin });",
        "const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');",
        "input.on('line', (line) => {",
        '  const frame = JSON.parse(line);',
        "  if (frame.method === 'initialize') {",
        '    send({ id: frame.id, result: {} });',
        "  } else if (frame.method === 'thread/start') {",
        "    send({ id: frame.id, result: { thread: { id: 'thread-1' } } });",
        "  } else if (frame.method === 'turn/start') {",
        "    send({ id: frame.id, result: { turn: { id: 'turn-1' } } });",
        "    send({ method: 'remoteControl/status/changed', params: { serverName: 'private-server-name', installationId: 'private-installation-id' } });",
        "    send({ method: 'account/rateLimits/updated', params: { planType: 'private-plan-type' } });",
        '    send({',
        '      id: 17,',
        "      method: 'item/tool/requestUserInput',",
        '      params: {',
        "        threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', autoResolutionMs: null,",
        '        questions: [{',
        "          id: 'runtime-question-id', header: 'Choice', question: 'Proceed?',",
        "          options: [{ label: 'Yes', description: 'Continue.' }],",
        '        }],',
        '      },',
        '    });',
        '  } else if (frame.id === 17 && frame.result) {',
        "    const answer = frame.result.answers?.['runtime-question-id']?.answers?.[0];",
        "    if (answer !== 'approved') {",
        "      send({ method: 'error', params: { message: 'unexpected answer' } });",
        '      return;',
        '    }',
        "    send({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'message-1', text: 'done' } } });",
        "    send({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { totalTokens: 7 } } });",
        "    send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });",
        '  }',
        '});',
      ].join('\n'),
      'utf8',
    );
    const casesPath = path.join(subjectRoot, 'cases.json');
    await fs.writeJson(casesPath, {
      skill_name: 'ask-me',
      evals: [{
        id: 'dynamic-question-id',
        prompt: 'Ask one question.',
        scripted_replies: [{
          expected_question_count: 1,
          answers_by_index: ['approved'],
          unexpected_question_answer: 'stop',
        }],
        expected_output: 'Finish after the reply.',
        files: [],
        review: {
          workspace_unchanged: true,
          checks: ['Uses the scripted reply.'],
        },
      }],
    }, { spaces: 2 });
    const reportPath = path.join(outputRoot, 'behavior.json');

    const report = await runCodexConversationSuite({
      suiteId: 'behavior',
      skillName: 'ask-me',
      casesPath,
      subjectRoot,
      profile: 'project-default',
      runs: 1,
      codexBin: process.execPath,
      timeoutMs: 10_000,
      sourceEnv: process.env,
      reportPath,
    });

    expect(report).toMatchObject({
      outcome: 'needs_review',
      complete: true,
      mechanicalPassed: true,
      qualitativeReview: 'required',
      summary: { cases: 1, runs: 2 },
    });
    const evidence = await fs.readJson(reportPath);
    const run = evidence.results[0].runs[0];
    expect(run.with_skill.questions[0].requestId).toBe('17');
    expect(run.with_skill.questions[0].answers).toEqual({
      'runtime-question-id': ['approved'],
    });
    expect(run.without_skill.questions[0].answers).toEqual({
      'runtime-question-id': ['approved'],
    });
    expect(run.with_skill.finalMessages).toEqual(['done']);
    expect(run.with_skill.workspaceChanges).toEqual([]);
    expect(JSON.stringify(evidence)).not.toContain('private-server-name');
    expect(JSON.stringify(evidence)).not.toContain('private-installation-id');
    expect(JSON.stringify(evidence)).not.toContain('private-plan-type');
  });

  it('proves strict config, target-only Skills, and empty MCP before model work', async () => {
    const subjectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-app-server-probe-'));
    const sourceCodexHome = path.join(subjectRoot, 'source-codex-home');
    const tracePath = path.join(subjectRoot, 'probe-trace.jsonl');
    tempDirs.push(subjectRoot);
    await fs.ensureDir(path.join(subjectRoot, '.agents', 'skills', 'target-skill'));
    await fs.ensureDir(path.join(subjectRoot, '.agents', 'skills', 'other-skill'));
    await fs.ensureDir(sourceCodexHome);
    await fs.writeFile(
      path.join(subjectRoot, '.agents', 'skills', 'target-skill', 'SKILL.md'),
      '# Target\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(subjectRoot, '.agents', 'skills', 'other-skill', 'SKILL.md'),
      '# Other\n',
      'utf8',
    );
    await fs.writeFile(path.join(subjectRoot, 'app-server'), [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const readline = require('node:readline');",
      `const tracePath = ${JSON.stringify(tracePath)};`,
      "fs.appendFileSync(tracePath, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');",
      "fs.appendFileSync(tracePath, JSON.stringify({ config: fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8') }) + '\\n');",
      "const input = readline.createInterface({ input: process.stdin });",
      "const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');",
      "input.on('line', (line) => {",
      "  const frame = JSON.parse(line);",
      "  if (frame.method) fs.appendFileSync(tracePath, JSON.stringify({ method: frame.method }) + '\\n');",
      "  if (frame.method === 'initialize') send({ id: frame.id, result: {} });",
      "  else if (frame.method === 'config/read') send({ id: frame.id, result: {",
      "    config: {",
      "      cli_auth_credentials_store: 'file', mcp_oauth_credentials_store: 'file',",
      "      include_apps_instructions: false, include_collaboration_mode_instructions: false,",
      "      mcp_servers: {},",
      "      features: { secret_auth_storage: false, default_mode_request_user_input: true, apps: false, plugins: false, remote_plugin: false, plugin_sharing: false, tool_suggest: false, skill_mcp_dependency_install: false },",
      "      skills: { bundled: { enabled: false } },",
      "      orchestrator: { skills: { enabled: false }, mcp: { enabled: false } },",
      "    },",
      "    origins: {},",
      "    layers: [",
      "      { name: { type: 'system', file: '/etc/codex/config.toml' }, version: '1', config: {} },",
      "      { name: { type: 'user', file: path.join(process.env.CODEX_HOME, 'config.toml') }, version: '1', config: {} },",
      "      { name: { type: 'sessionFlags' }, version: '1', config: {} },",
      "    ],",
      "  } });",
      "  else if (frame.method === 'configRequirements/read') send({ id: frame.id, result: { requirements: null } });",
      "  else if (frame.method === 'skills/list') {",
      "    const cwd = frame.params.cwds[0];",
      "    const target = path.join(cwd, '.agents', 'skills', 'target-skill', 'SKILL.md');",
      "    const other = path.join(cwd, '.agents', 'skills', 'other-skill', 'SKILL.md');",
      "    const skills = fs.existsSync(target) ? [{ name: 'target-skill', path: target, scope: 'repo', enabled: true }] : [];",
      "    const errors = fs.existsSync(other) ? [{ path: other, message: 'unexpected Skill' }] : [];",
      "    send({ id: frame.id, result: { data: [{ cwd, skills, errors }] } });",
      "  }",
      "  else if (frame.method === 'mcpServerStatus/list') send({ id: frame.id, result: { data: [], nextCursor: null } });",
      "  else if (frame.method === 'thread/start' || frame.method === 'turn/start') process.exit(21);",
      "});",
    ].join('\n'), 'utf8');
    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: sourceCodexHome },
      inheritUserConfig: false,
    });

    const evidence = await runCodexEvalIsolationProbe({
      subjectRoot,
      skillName: 'target-skill',
      codexBin: process.execPath,
      codexRuntime: runtime,
      sourceEnv: { PATH: process.env.PATH },
    });

    expect(evidence).toMatchObject({
      config_requirements_absent: true,
      mcp_server_count: 0,
      strict_overrides_effective: true,
    });
    expect(evidence.skill_paths).toHaveLength(1);
    const trace = (await fs.readFile(tracePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const argv = trace[0].argv as string[];
    expect(argv).toContain('--strict-config');
    expect(argv).toContain('cli_auth_credentials_store="file"');
    expect(argv).toContain('features.plugins=false');
    expect(argv).toContain('features.default_mode_request_user_input=true');
    expect(argv).not.toContain('features.recommended_plugins=false');
    expect(trace[1].config).toContain('trust_level = "trusted"');
    expect(trace[1].config).toContain('[projects.');
    const methods = trace.slice(2).map((entry) => entry.method);
    expect(methods).toEqual(expect.arrayContaining([
      'initialize',
      'config/read',
      'configRequirements/read',
      'skills/list',
      'mcpServerStatus/list',
    ]));
    expect(methods).not.toContain('thread/start');
  });

  it('excludes provider credentials from the model shell and redacts echoed values', async () => {
    const subjectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-app-server-redaction-'));
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-app-server-redaction-report-'));
    const sourceCodexHome = path.join(subjectRoot, 'source-codex-home');
    tempDirs.push(subjectRoot, outputRoot);
    await fs.ensureDir(path.join(subjectRoot, '.agents', 'skills', 'ask-me'));
    await fs.ensureDir(sourceCodexHome);
    await fs.writeFile(
      path.join(subjectRoot, '.agents', 'skills', 'ask-me', 'SKILL.md'),
      '# Ask Me\n',
      'utf8',
    );
    await fs.writeFile(path.join(sourceCodexHome, 'config.toml'), [
      'model_provider = "custom"',
      '[model_providers.custom]',
      'name = "Custom"',
      'base_url = "https://private.invalid/v1"',
      'env_key = "CUSTOM_TOKEN"',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(subjectRoot, 'app-server'), [
      "const readline = require('node:readline');",
      "if (process.env.UNRELATED_SECRET || process.env.OPENAI_API_KEY) process.exit(9);",
      "if (!process.argv.some((value) => value.includes('CUSTOM_TOKEN'))) process.exit(10);",
      "process.stderr.write(`${process.env.CUSTOM_TOKEN} https://private.invalid/v1\\n${process.env.AW_CODEX_EVAL_PROCESS_TREE_ID.slice(0, 12)}`);",
      "const finishTreeStderr = () => process.stderr.write(`${process.env.AW_CODEX_EVAL_PROCESS_TREE_ID.slice(12)}\\n`);",
      "const input = readline.createInterface({ input: process.stdin });",
      "const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');",
      "input.on('line', (line) => {",
      "  const frame = JSON.parse(line);",
      "  if (frame.method === 'initialize') send({ id: frame.id, result: {} });",
      "  else if (frame.method === 'thread/start') send({ id: frame.id, result: { thread: { id: 'thread-1' } } });",
      "  else if (frame.method === 'turn/start') {",
      "    send({ id: frame.id, result: { turn: { id: 'turn-1' } } });",
      "    const message = JSON.stringify({ method: 'item/completed', params: { item: { [process.env.AW_CODEX_EVAL_PROCESS_TREE_ID]: true, type: 'agentMessage', id: 'message-1', text: `${process.env.CUSTOM_TOKEN} https://private.invalid/v1 ${process.env.AW_CODEX_EVAL_PROCESS_TREE_ID}` } } }) + '\\n';",
      "    const splitAt = message.indexOf(process.env.AW_CODEX_EVAL_PROCESS_TREE_ID) + 12;",
      "    process.stdout.write(message.slice(0, splitAt));",
      "    setImmediate(() => { finishTreeStderr(); process.stdout.write(message.slice(splitAt)); send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } }); });",
      "  }",
      "});",
    ].join('\n'), 'utf8');
    const casesPath = path.join(subjectRoot, 'cases.json');
    await fs.writeJson(casesPath, {
      skill_name: 'ask-me',
      evals: [behaviorCase('redaction')],
    });
    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: {
        CODEX_HOME: sourceCodexHome,
        CUSTOM_TOKEN: 'conversation-token',
        OPENAI_API_KEY: 'official-key',
        UNRELATED_SECRET: 'unrelated-secret',
      },
      inheritUserConfig: true,
    });
    const reportPath = path.join(outputRoot, 'behavior.json');

    const report = await runCodexConversationSuite({
      suiteId: 'behavior',
      skillName: 'ask-me',
      casesPath,
      subjectRoot,
      profile: 'project-default',
      runs: 1,
      codexBin: process.execPath,
      codexRuntime: runtime,
      timeoutMs: 10_000,
      sourceEnv: {
        PATH: process.env.PATH,
        CUSTOM_TOKEN: 'conversation-token',
      },
      reportPath,
    });

    expect(JSON.stringify(report)).not.toContain('conversation-token');
    const persisted = await fs.readFile(reportPath, 'utf8');
    expect(persisted).not.toContain('conversation-token');
    expect(persisted).not.toContain('https://private.invalid/v1');
    expect(persisted).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u,
    );
    expect(persisted).toContain('[redacted]');
    expect(persisted).toContain('[process-tree-id]');
    const evidence = JSON.parse(persisted);
    expect(evidence.results[0].runs[0].with_skill.stderr).toContain('[process-tree-id]');
    expect(evidence.results[0].runs[0].without_skill.stderr).toContain('[process-tree-id]');
  });

  it('terminates an app-server descendant before accepting a completed conversation', async () => {
    const subjectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-app-server-unclosed-'));
    const descendantPidsPath = path.join(subjectRoot, 'descendant-pids.txt');
    tempDirs.push(subjectRoot);
    await fs.ensureDir(path.join(subjectRoot, '.agents', 'skills', 'ask-me'));
    await fs.writeFile(
      path.join(subjectRoot, '.agents', 'skills', 'ask-me', 'SKILL.md'),
      '# Ask Me\n',
      'utf8',
    );
    await fs.writeFile(path.join(subjectRoot, 'app-server'), [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const readline = require('node:readline');",
      "const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 30000)'], {",
      "  detached: true, stdio: ['ignore', process.stdout, process.stderr],",
      '});',
      'descendant.unref();',
      `fs.appendFileSync(${JSON.stringify(descendantPidsPath)}, String(descendant.pid) + '\\n');`,
      "const input = readline.createInterface({ input: process.stdin });",
      "const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');",
      "input.on('line', (line) => {",
      '  const frame = JSON.parse(line);',
      "  if (frame.method === 'initialize') send({ id: frame.id, result: {} });",
      "  else if (frame.method === 'thread/start') send({ id: frame.id, result: { thread: { id: 'thread-1' } } });",
      "  else if (frame.method === 'turn/start') {",
      "    send({ id: frame.id, result: { turn: { id: 'turn-1' } } });",
      "    send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });",
      '  }',
      '});',
    ].join('\n'), 'utf8');
    const casesPath = path.join(subjectRoot, 'cases.json');
    await fs.writeJson(casesPath, {
      skill_name: 'ask-me',
      evals: [behaviorCase('unclosed')],
    });

    const processExists = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
    };
    let descendantPids: number[] = [];
    try {
      await expect(runCodexConversationSuite({
        suiteId: 'behavior',
        skillName: 'ask-me',
        casesPath,
        subjectRoot,
        profile: 'project-default',
        runs: 1,
        codexBin: process.execPath,
        timeoutMs: 10_000,
        sourceEnv: process.env,
      })).resolves.toMatchObject({
        complete: true,
        mechanicalPassed: true,
      });
      descendantPids = (await fs.readFile(descendantPidsPath, 'utf8'))
        .trim()
        .split('\n')
        .map(Number);
      expect(descendantPids).toHaveLength(2);
      await vi.waitFor(() => {
        expect(descendantPids.every((pid) => !processExists(pid))).toBe(true);
      });
    } finally {
      if (descendantPids.length === 0 && await fs.pathExists(descendantPidsPath)) {
        descendantPids = (await fs.readFile(descendantPidsPath, 'utf8'))
          .trim()
          .split('\n')
          .map(Number)
          .filter(Number.isInteger);
      }
      for (const pid of descendantPids) {
        if (processExists(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Best-effort test cleanup.
          }
        }
      }
    }
  }, 10_000);

  it('cleans a detached descendant after the app-server root exits immediately', async () => {
    const subjectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-app-server-early-exit-'));
    const descendantPidsPath = path.join(subjectRoot, 'descendant-pids.txt');
    tempDirs.push(subjectRoot);
    await fs.ensureDir(path.join(subjectRoot, '.agents', 'skills', 'ask-me'));
    await fs.writeFile(
      path.join(subjectRoot, '.agents', 'skills', 'ask-me', 'SKILL.md'),
      '# Ask Me\n',
      'utf8',
    );
    const descendantScript = [
      'process.on("SIGTERM", () => {});',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    await fs.writeFile(path.join(subjectRoot, 'app-server'), [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: 'ignore' });`,
      'child.unref();',
      `fs.appendFileSync(${JSON.stringify(descendantPidsPath)}, String(child.pid) + '\\n');`,
      'process.exit(0);',
    ].join('\n'), 'utf8');
    const casesPath = path.join(subjectRoot, 'cases.json');
    await fs.writeJson(casesPath, {
      skill_name: 'ask-me',
      evals: [behaviorCase('early-exit')],
    });
    let descendantPids: number[] = [];
    const processExists = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
    };
    try {
      await expect(runCodexConversationSuite({
        suiteId: 'behavior',
        skillName: 'ask-me',
        casesPath,
        subjectRoot,
        profile: 'project-default',
        runs: 1,
        codexBin: process.execPath,
        timeoutMs: 2_000,
        sourceEnv: process.env,
      })).resolves.toMatchObject({ complete: false, mechanicalPassed: false });
      descendantPids = (await fs.readFile(descendantPidsPath, 'utf8'))
        .trim()
        .split('\n')
        .map(Number);
      expect(descendantPids.filter(processExists)).toEqual([]);
    } finally {
      for (const pid of descendantPids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Best-effort test cleanup.
        }
      }
    }
  });

  it.each([
    {
      name: 'an empty eval list',
      document: { skill_name: 'ask-me', evals: [] },
      message: 'evals must be a non-empty array',
    },
    {
      name: 'a mismatched skill name',
      document: { skill_name: 'other-skill', evals: [behaviorCase('one')] },
      message: 'does not match suite skill "ask-me"',
    },
    {
      name: 'a blank case id',
      document: { skill_name: 'ask-me', evals: [behaviorCase('  ')] },
      message: 'evals[0].id must be a non-empty string',
    },
    {
      name: 'duplicate case ids after trimming',
      document: { skill_name: 'ask-me', evals: [behaviorCase('one'), behaviorCase(' one ')] },
      message: 'duplicate case id "one"',
    },
    {
      name: 'a non-string prompt',
      document: { skill_name: 'ask-me', evals: [behaviorCase('one', { prompt: 42 })] },
      message: 'evals[0].prompt must be a non-empty string',
    },
  ])('rejects $name before starting Codex', async ({ document, message }) => {
    const subjectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-app-server-invalid-'));
    const casesPath = path.join(subjectRoot, 'cases.json');
    tempDirs.push(subjectRoot);
    await fs.writeJson(casesPath, document, { spaces: 2 });

    await expect(runCodexConversationSuite({
      suiteId: 'behavior',
      skillName: 'ask-me',
      casesPath,
      subjectRoot,
      profile: 'project-default',
      runs: 1,
      codexBin: path.join(subjectRoot, 'missing-codex'),
      timeoutMs: 10_000,
      sourceEnv: process.env,
    })).rejects.toThrow(message);
  });
});
