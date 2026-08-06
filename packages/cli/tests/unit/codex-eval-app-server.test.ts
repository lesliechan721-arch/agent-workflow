import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { runCodexConversationSuite } from '../../scripts/codex-eval-app-server.js';

const tempDirs: string[] = [];

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

  it.each([
    {
      name: 'an empty eval list',
      document: { skill_name: 'ask-me', evals: [] },
      message: 'evals must be a non-empty array',
    },
    {
      name: 'a mismatched skill name',
      document: { skill_name: 'other-skill', evals: [{ id: 'one' }] },
      message: 'does not match suite skill "ask-me"',
    },
    {
      name: 'a blank case id',
      document: { skill_name: 'ask-me', evals: [{ id: '  ' }] },
      message: 'evals[0].id must be a non-empty string',
    },
    {
      name: 'duplicate case ids after trimming',
      document: { skill_name: 'ask-me', evals: [{ id: 'one' }, { id: ' one ' }] },
      message: 'duplicate case id "one"',
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
