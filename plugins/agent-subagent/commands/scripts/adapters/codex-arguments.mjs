import { checkArguments, rejectOption } from './arguments.mjs';
import { permissionMode } from './permission-mode.mjs';

export function checkCodexArguments(request, owned = []) {
  const mode = permissionMode(request);
  checkArguments(request.args, {
    owned: ['--json', '--output-last-message', '-o', '--cd', '-C', '--worktree', '--help', '-h', '--version', '-V', ...owned],
    commands: ['exec', 'resume', 'fork', 'review', 'help'],
    short: { '-c': 'value', '-m': 'value', '-p': 'value', '-s': 'value', '-a': 'value', '-i': 'value' },
    values: ['--config', '--model', '--profile', '--sandbox', '--ask-for-approval', '--enable', '--disable', '--local-provider', '--add-dir', '--thread-source', '--cyber-access-program', '--output-schema', '--color'],
    variadic: ['--image', '-i'],
    booleans: ['--oss', '--approve-for-me', '--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config'],
    onOption(option, value) {
      const key = String(value ?? '').split('=', 1)[0].trim().replace(/^["']|["']$/g, '');
      if (mode !== 'default' && (['--ask-for-approval', '-a', '--approve-for-me', '--full-auto', '--dangerously-bypass-approvals-and-sandbox'].includes(option) || ['--config', '-c'].includes(option) && ['approval_policy', 'approvals_reviewer'].some((leaf) => key === leaf || key.startsWith(`${leaf}.`)) || mode === 'full-access' && (['--sandbox', '-s'].includes(option) || ['--config', '-c'].includes(option) && (key === 'sandbox_mode' || key.startsWith('sandbox_mode.'))))) rejectOption(option);
      if (request.execution?.model !== undefined && (['--model', '-m'].includes(option) || ['--config', '-c'].includes(option) && key === 'model')) rejectOption(option);
      if (request.execution?.reasoningEffort !== undefined && ['--config', '-c'].includes(option) && key === 'model_reasoning_effort') rejectOption(option);
    },
  });
}
