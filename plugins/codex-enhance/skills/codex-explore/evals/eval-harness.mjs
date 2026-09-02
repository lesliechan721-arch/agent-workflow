import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { setupTriggerWorkspace } from './trigger-fixture.mjs';

export async function createEvalWorkspace({ configValues = {}, sourceRoot } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-explore-eval-'));
  try {
    if (!sourceRoot) {
      throw new Error(
        'custom provider input.workspacePath is required; use the workspace snapshot from the prepared Eval Plan.',
      );
    }
    if (Object.keys(configValues).length > 0) {
      throw new Error('Specialized eval config must be represented by a materialized profile.');
    }
    await cp(sourceRoot, root, { recursive: true, force: true });
    await setupTriggerWorkspace({ workspaceRoot: root });
    return {
      root,
      skillPath: path.join(root, '.agents', 'skills', 'codex-explore', 'SKILL.md'),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function collectFinalAgentResults(calls) {
  const results = [];
  const identities = new Set();
  const add = (source, taskName, value) => {
    if (typeof value !== 'string' || value.trim() === '') return;
    const result = {
      source,
      task_name: typeof taskName === 'string' && taskName.trim() !== '' ? taskName : null,
      text: value.trim(),
    };
    const identity = JSON.stringify({ task_name: result.task_name, text: result.text });
    if (identities.has(identity)) return;
    identities.add(identity);
    results.push(result);
  };
  for (const call of calls ?? []) {
    if (call?.tool === 'agent_message' && call.output?.message_type === 'FINAL_ANSWER') {
      add('agent_message', call.output.task_name, call.output.payload);
    }
    if (
      call?.tool !== 'wait_agent'
      || !call.output?.status
      || typeof call.output.status !== 'object'
      || Array.isArray(call.output.status)
    ) continue;
    for (const [taskName, status] of Object.entries(call.output.status)) {
      add('wait_agent', taskName, status?.completed);
    }
  }
  return results;
}
