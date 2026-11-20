import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';

import { ConsoleAppV4, type ConsoleExitRequest } from './console-app-v4.js';
import type { PublicCommandInterruption } from '../commands/public-interruption.js';
import type { SessionHost, SessionHostSnapshot } from './session-host.js';

export function SessionConsoleApp(props: {
  host: SessionHost;
  processInterruption?: PublicCommandInterruption;
  onExit?: (request: ConsoleExitRequest) => void;
}): React.JSX.Element {
  const [session, setSession] = useState<SessionHostSnapshot>(props.host.snapshot);

  useEffect(() => props.host.subscribe(setSession), [props.host]);

  useEffect(() => {
    const interruption = props.processInterruption;
    if (!interruption) return;
    const exit = () => props.onExit?.({ code: interruption.exitCode ?? 1, reason: 'interrupted' });
    if (interruption.signal.aborted) exit();
    else interruption.signal.addEventListener('abort', exit, { once: true });
    return () => interruption.signal.removeEventListener('abort', exit);
  }, [props.processInterruption, props.onExit]);

  if (session.reloading) {
    return <Box flexDirection="column"><Text>正在安全结束当前会话…</Text></Box>;
  }

  return (
    <ConsoleAppV4
      key={session.epoch}
      controller={session.controller}
      ownsController={false}
      pendingSessionNavigation={session.pendingNavigation}
      pendingSessionNavigationDrafts={session.pendingNavigationDrafts}
      onCancelPendingSessionNavigation={() => props.host.cancelPendingNavigation()}
      onSessionNavigation={(navigation, options) => props.host.requestNavigation(navigation, options)}
      onExit={props.onExit}
    />
  );
}
