import { expect, it, vi } from 'vitest';
import { observeProcessTree, terminateProcessTree } from '../../src/process-tree.js';

// Test Value Gate: the sentinel failure must remain blocking while diagnostics
// distinguish an absent row, changed identity, missing marker and unreadable query.
it.each(['absent', 'identity-changed', 'marker-missing', 'query-failed'] as const)(
  'retains independent sentinel evidence when %s', async (failure) => {
    const marker = 'private-marker-value';
    const kill = vi.fn();
    const observation = observeProcessTree(100, marker, {
      platform: 'linux', enforceProcessMarker: true, kill,
      execFile: (_command, args, _options, callback) => {
        if (failure === 'query-failed') { callback(new Error('private-query-error'), ''); return; }
        const markerScan = args.some((arg) => arg.includes('command='));
        const suffix = markerScan ? ` node AW_NATIVE_CLI_PROCESS_MARKER=${marker}` : '';
        const rows = [`100 1 100 S root-start${suffix}`];
        if (failure !== 'absent') rows.push(`900001 1 900001 S ${failure === 'identity-changed' ? 'changed-start' : 'sentinel-start'}${markerScan
          ? failure === 'marker-missing' ? ' node' : suffix : ''}`);
        callback(null, rows.join('\n'));
      },
    }, { marker, sentinel: { pid: 900001, startTime: 'sentinel-start' }, release: async () => {} });
    try {
      await expect(terminateProcessTree(100, () => {}, { platform: 'linux' }, { observation, requireConfirmedCleanup: true })).rejects.toThrow(/identity lookup|sentinel/iu);
      const diagnostic = observation.diagnostics[0]!;
      expect(diagnostic.sentinel).toMatchObject({ pid: 900001, knownStartTime: 'sentinel-start',
        present: failure === 'query-failed' ? null : failure !== 'absent',
        identityMatches: failure === 'query-failed' ? null : failure === 'marker-missing',
        markerMatches: failure === 'query-failed' ? null : failure === 'identity-changed',
      });
      expect(diagnostic.processes.some((entry) => entry.pid === 900001)).toBe(false);
      expect(JSON.stringify(observation.diagnostics)).not.toContain(marker);
      expect(JSON.stringify(observation.diagnostics)).not.toContain('private-query-error');
    } finally { observation.dispose(); }
  },
);
