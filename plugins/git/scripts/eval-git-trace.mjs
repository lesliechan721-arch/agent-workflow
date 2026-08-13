import path from 'node:path';

const optionsWithValue = new Set([
  '-C', '-c', '--config-env', '--git-dir', '--namespace', '--super-prefix', '--work-tree',
]);

function unquoteShellToken(token) {
  if (
    token.length >= 2
    && ((token.startsWith('"') && token.endsWith('"'))
      || (token.startsWith("'") && token.endsWith("'")))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

function shellTokens(command) {
  return (command.match(/"[^"]*"|'[^']*'|[^\s]+/gu) ?? []).map(unquoteShellToken);
}

function splitShellSegments(command) {
  const segments = [];
  let buffer = '';
  let quote = null;
  let escaped = false;
  const push = () => {
    if (buffer.trim()) segments.push(buffer.trim());
    buffer = '';
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      buffer += character;
      escaped = false;
      continue;
    }
    if (quote) {
      buffer += character;
      if (character === '\\' && quote !== "'") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      buffer += character;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === '&&' || pair === '||') {
      push();
      index += 1;
    } else if (character === ';' || character === '|' || character === '\n') {
      push();
    } else {
      buffer += character;
    }
  }
  push();
  return segments;
}

function unwrapShellCommand(command) {
  const match = command.match(
    /^(?:\S*\/)?(?:bash|sh|zsh)\s+-(?:c|lc)\s+([\s\S]+)$/u,
  );
  return match ? unquoteShellToken(match[1]) : command;
}

function gitInvocation(segment) {
  const tokens = shellTokens(segment);
  const normalizeControlToken = (token) => token
    .replace(/^[({]+/u, '')
    .replace(/[)}]+$/u, '');
  const gitIndex = tokens.findIndex(
    (token) => path.basename(normalizeControlToken(token)) === 'git',
  );
  if (gitIndex < 0) return null;

  let index = gitIndex + 1;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const option = tokens[index];
    if (option === '--') {
      index += 1;
      break;
    }
    if (optionsWithValue.has(option)) index += 2;
    else index += 1;
  }
  if (index >= tokens.length) return null;
  return {
    subcommand: normalizeControlToken(tokens[index]),
    args: tokens.slice(index + 1).map(normalizeControlToken),
  };
}

export function gitInvocations(command) {
  return splitShellSegments(unwrapShellCommand(command))
    .map(gitInvocation)
    .filter(Boolean);
}

export function commandRunsScript(command, executable, script) {
  return splitShellSegments(unwrapShellCommand(command)).some((segment) => {
    const tokens = shellTokens(segment).map((token) => token
      .replace(/^[({]+/u, '')
      .replace(/[)}]+$/u, ''));
    const executableIndex = tokens.findIndex(
      (token) => path.basename(token) === executable,
    );
    return executableIndex >= 0
      && path.basename(tokens[executableIndex + 1] ?? '') === script;
  });
}
