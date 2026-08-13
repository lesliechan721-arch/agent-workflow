import { Writable } from 'node:stream';

import { render, useApp } from 'ink';
import { useCallback, type ReactElement } from 'react';

import type { CliPromptOutputSink } from '../commands/runtime.js';

export interface TuiLaunchRequest<T> {
  input: NodeJS.ReadableStream;
  output: CliPromptOutputSink;
  render: (complete: (result: T) => void) => ReactElement;
}

export interface TuiRunner {
  launch: <T>(request: TuiLaunchRequest<T>) => Promise<T>;
}

function TuiSession<T>(props: {
  request: TuiLaunchRequest<T>;
  onComplete: (result: T) => void;
}): React.JSX.Element {
  const { exit } = useApp();
  const complete = useCallback((result: T) => {
    props.onComplete(result);
    exit();
  }, [exit, props]);
  return <>{props.request.render(complete)}</>;
}

function createInkOutput(output: CliPromptOutputSink): NodeJS.WriteStream {
  if (typeof (output as NodeJS.WriteStream).on === 'function') {
    return output as NodeJS.WriteStream;
  }

  const writable = new Writable({
    write(chunk, _encoding, callback) {
      output.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      callback();
    },
  }) as NodeJS.WriteStream;
  Object.defineProperties(writable, {
    isTTY: { value: output.isTTY === true },
    columns: { value: process.stderr.columns ?? 80 },
    rows: { value: process.stderr.rows ?? 24 },
  });
  return writable;
}

export function createInkTuiRunner(): TuiRunner {
  return {
    async launch<T>(request: TuiLaunchRequest<T>): Promise<T> {
      const input = request.input as NodeJS.ReadStream & {
        isRaw?: boolean;
        setRawMode?: (mode: boolean) => unknown;
      };
      const sourceWasRaw = input.isRaw === true;
      const output = createInkOutput(request.output);
      let completed = false;
      let result: T | undefined;
      const instance = render(
        <TuiSession
          request={request}
          onComplete={(value) => {
            completed = true;
            result = value;
          }}
        />,
        {
          stdin: input,
          stdout: output,
          stderr: output,
          alternateScreen: true,
          exitOnCtrlC: false,
          interactive: true,
          patchConsole: false,
        },
      );

      try {
        await instance.waitUntilExit();
      } finally {
        instance.cleanup();
        if (input.isTTY && typeof input.setRawMode === 'function') {
          input.setRawMode(sourceWasRaw);
        }
        input.pause();
      }

      if (!completed) {
        throw new Error('TUI session ended without a result.');
      }
      return result as T;
    },
  };
}
