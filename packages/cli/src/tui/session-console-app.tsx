import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';

import { ConsoleAppV4, type ConsoleExitRequest } from './console-app-v4.js';
import type { SessionHost, SessionHostSnapshot } from './session-host.js';

export function SessionConsoleApp(props: {
  host: SessionHost;
  onExit?: (request: ConsoleExitRequest) => void;
}): React.JSX.Element {
  const [session, setSession] = useState<SessionHostSnapshot>(props.host.snapshot);

  useEffect(() => props.host.subscribe(setSession), [props.host]);

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
      onClaimProjectIntentReminder={(projectRoot, signature) =>
        props.host.claimProjectIntentReminder(projectRoot, signature)}
      onExit={props.onExit}
    />
  );
}
