import path from 'node:path';
import { pathToFileURL } from 'node:url';

import fs from 'fs-extra';

export async function writeSkillsCliFixture(
  binRoot: string,
  source: string,
  env: NodeJS.ProcessEnv,
): Promise<{ env: NodeJS.ProcessEnv; launcher: string; shim: string }> {
  const packageRoot = path.join(binRoot, 'node_modules', 'skills');
  const launcher = path.join(packageRoot, 'bin', 'cli.mjs');
  const shim = path.join(binRoot, 'skills.CMD');
  await fs.outputJson(path.join(packageRoot, 'package.json'), {
    name: 'skills', version: '1.5.23', bin: { skills: './bin/cli.mjs' },
  });
  await fs.outputFile(launcher, source);
  await fs.outputFile(path.join(binRoot, 'skills'), [
    '#!/usr/bin/env node',
    `import(${JSON.stringify(pathToFileURL(launcher).href)});`,
    '',
  ].join('\n'));
  await fs.chmod(path.join(binRoot, 'skills'), 0o755);
  await fs.outputFile(shim, [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ' +
      '"%_prog%"  "%dp0%\\node_modules\\skills\\bin\\cli.mjs" %*',
    '',
  ].join('\r\n'));
  const pathEntry = Object.entries(env).find(([key]) => key.toLowerCase() === 'path');
  return {
    launcher,
    shim,
    env: {
      ...Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path')),
      PATH: `${binRoot}${path.delimiter}${pathEntry?.[1] ?? ''}`,
    },
  };
}
