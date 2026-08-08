import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCodexConversationSuite } from '../../scripts/codex-eval-app-server.js';
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
        '    send({',
        "      id: 'tool-1',",
        "      method: 'item/tool/requestUserInput',",
        '      params: {',
        "        threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', autoResolutionMs: null,",
        '        questions: [{',
        "          id: 'runtime-question-id', header: 'Choice', question: 'Proceed?',",
        "          options: [{ label: 'Yes', description: 'Continue.' }],",
        '        }],',
        '      },',
        '    });',
        "  } else if (frame.id === 'tool-1' && frame.result) {",
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
    expect(run.with_skill.questions[0].answers).toEqual({
      'runtime-question-id': ['approved'],
    });
    expect(run.without_skill.questions[0].answers).toEqual({
      'runtime-question-id': ['approved'],
    });
    expect(run.with_skill.finalMessages).toEqual(['done']);
    expect(run.with_skill.workspaceChanges).toEqual([]);
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
      "process.stderr.write(`${process.env.CUSTOM_TOKEN} https://private.invalid/v1\\n`);",
      "const input = readline.createInterface({ input: process.stdin });",
      "const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');",
      "input.on('line', (line) => {",
      "  const frame = JSON.parse(line);",
      "  if (frame.method === 'initialize') send({ id: frame.id, result: {} });",
      "  else if (frame.method === 'thread/start') send({ id: frame.id, result: { thread: { id: 'thread-1' } } });",
      "  else if (frame.method === 'turn/start') {",
      "    send({ id: frame.id, result: { turn: { id: 'turn-1' } } });",
      "    send({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'message-1', text: `${process.env.CUSTOM_TOKEN} https://private.invalid/v1` } } });",
      "    send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });",
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
    expect(persisted).toContain('[redacted]');
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
