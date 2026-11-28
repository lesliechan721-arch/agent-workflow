import { getNativeTestLayout } from './native-execution-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

export async function nativeFixtureLayout(pluginName: string, sourceId = 'team', scope: 'user' | 'project' = 'project', platform: 'codex' | 'claude' = 'codex', sourceIdentity?: string) {
  const { env, layout } = getCurrentSourceTestIsolation();
  return getNativeTestLayout({ platform, sourceId, pluginId: `${sourceId}/${pluginName}`, scope,
    cwd: layout.fixtureCwd, env, sourceIdentity });
}
export async function nativeRegistrationId(pluginName: string, sourceId = 'team', platform: 'codex' | 'claude' = 'codex') {
  return (await nativeFixtureLayout(pluginName, sourceId, 'user', platform)).nativeIdentity.registrationId!;
}
