import { createRequire } from 'node:module'
import process from 'node:process'
import type { RuntimeCapabilities } from './types.js'

export function getRuntimeCapabilities(platform: NodeJS.Platform = process.platform): RuntimeCapabilities {
  const require = createRequire(import.meta.url)
  const packageJson = require('../package.json') as { version: string }
  const processObservationAvailable = platform === 'darwin' || platform === 'linux' || platform === 'win32'
  return {
    schemaVersion: 2,
    provider: 'aw-skill-eval-process',
    providerVersion: packageJson.version,
    capabilities: {
      triggerDiscovery: false,
      conversation: false,
      skillPathExecution: processObservationAvailable,
      previousVersionBaseline: processObservationAvailable,
      withoutSkillBaseline: processObservationAvailable,
      cleanContext: false,
      parallelRuns: false,
      toolTrace: false,
      tokenUsage: true,
      duration: true,
      sandbox: false,
      materialization: true,
    },
    limitations: [
      'The process provider does not prove a clean model context.',
      'The process provider does not supply a tool trace or sandbox.',
      ...(processObservationAvailable
        ? [
            `Standalone ${platform} execution uses process observation and before/after Skill digests; it does not guarantee descendant cleanup.`,
            ...(platform === 'darwin' || platform === 'linux'
              ? ['Comparative evidence requires Full Access verified process observation or confirmed external containment.']
              : ['Comparative evidence is disabled without confirmed external containment.']),
          ]
        : [`Standalone ${platform} execution is disabled because process observation is unavailable.`]),
    ],
  }
}
