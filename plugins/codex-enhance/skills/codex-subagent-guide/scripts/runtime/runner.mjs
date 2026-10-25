import fs from 'node:fs/promises';
import path from 'node:path';
import { LIMITS, fail } from './contracts.mjs';
import { safePath, readText, readStdin, executablePaths } from './files.mjs';
import { validateEnvironmentConfig } from './plan.mjs';
import { validateSelectors } from '../file-selection/contracts.mjs';

export function resolveAdapterEnvironment(source = process.env, executor = {}) {
  validateEnvironmentConfig(executor);
  const host = { ...source };
  const environment = Object.fromEntries(Object.entries(host).filter(([key, value]) => typeof value === 'string' && !key.startsWith('AW_PLUGIN_') && !key.startsWith('AW_SUBAGENT_')));
  const referenced = {};
  const secretValues = [];
  for (const [target, origin] of Object.entries(executor.envFrom ?? {})) {
    if (!Object.hasOwn(host, origin) || typeof host[origin] !== 'string') fail('environmentSourceMissing', 'A configured envFrom host variable is missing. Set the source variable before running.');
    if (host[origin].includes('\0')) fail('environmentInvalid', 'An envFrom host value contains NUL.');
    referenced[target] = host[origin];
    secretValues.push(host[origin]);
  }
  return { environment: { ...environment, ...(executor.env ?? {}), ...referenced }, secretValues };
}
export function adapterEnvironment(source = process.env, executor = {}) {
  return resolveAdapterEnvironment(source, executor).environment;
}

export async function prepareRun(selected, request, options = {}) {
  const fileSelectors = request.files ?? [];
  if (selected.mode === 'workspace' && fileSelectors.length) fail('filesNotAllowedInWorkspace', 'Workspace execution does not accept --file. Describe the focus paths in the prompt.');
  if (request.prompt === undefined) fail('argumentsRequired', 'Supply --executor and --prompt TEXT or --prompt -.');
  if (selected.mode === 'bundle') validateSelectors(fileSelectors);
  const workspace = await fs.realpath(path.resolve(request.workspace ?? process.cwd())).catch(() => fail('workspaceMissing', 'The workspace is missing.'));
  await safePath(workspace, 'directory');
  let task;
  if (request.prompt === '-') task = await readStdin(options.stdin ?? process.stdin);
  else {
    if (typeof request.prompt !== 'string' || !request.prompt.isWellFormed() || request.prompt.includes('\0')) fail('promptInvalid', 'The prompt must be valid UTF-8 text without NUL.');
    if (Buffer.byteLength(request.prompt) > LIMITS.taskBytes) fail('taskTooLarge', 'The prompt exceeds the 256 KiB limit. Use a smaller task.');
    task = request.prompt;
  }
  if (!task.trim()) fail('inputEmpty', 'The prompt is empty. Supply a task.');
  let prompt = task;
  if (request.instructionsFile !== undefined) {
    if (typeof request.instructionsFile !== 'string' || !request.instructionsFile || request.instructionsFile === '-') fail('instructionsInvalid', 'Use a readable instruction file path; stdin is reserved for --prompt -.');
    const instructions = await readText(request.instructionsFile, LIMITS.instructionBytes, 'instructionsTooLarge');
    prompt = `Instructions:\n${instructions}\n\nTask:\n${task}`;
  }
  let executable;
  try { executable = await executablePaths(selected.command, selected.entrypoint); }
  catch (error) {
    if (selected.executor.adapter !== 'custom') fail('installedRuntimeMissing', 'The installed adapter resource is missing or unreadable. Sync or reinstall the Guide.', ['sync', 'reinstall']);
    throw error;
  }
  const wire = {
    protocolVersion: 5, type: 'start', execution: { ...selected.execution }, mode: selected.mode,
    workspace, prompt, args: [...selected.executor.args],
    ...(selected.mode === 'bundle' ? {
      fileSelectors: [...fileSelectors],
      fileResolver: { command: process.execPath, args: [path.join(selected.resourceRoot, 'scripts', 'resolve-files.mjs')] },
    } : {}),
  };
  return { selected, executable, originalWorkspace: workspace, request: wire, ...resolveAdapterEnvironment(options.environment ?? process.env, selected.executor) };
}
