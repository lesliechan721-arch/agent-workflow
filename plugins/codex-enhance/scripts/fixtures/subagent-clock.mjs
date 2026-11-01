import { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

// Explicit test preload: mock wall time only. Native I/O, process identities,
// PowerShell timeouts, and the parent's process watchdog use real time.
const file = process.env.FIXTURE_CLOCK_FILE;
if (file) {
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const role = path.basename(process.argv[1] ?? '') === 'worker.mjs' ? 'worker' : process.argv[2];
  if (settings.roles.includes(role)) {
    mock.timers.enable({ apis: ['Date'], now: settings.now });
    const acknowledge = () => fs.writeFileSync(`${file}.${process.pid}.ack`, JSON.stringify({ role, now: Date.now() }));
    acknowledge();
    if (settings.stepMs) {
      const realTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (callback, milliseconds, ...args) => {
        if (milliseconds > 0 && milliseconds <= 100) {
          mock.timers.setTime(Date.now() + settings.stepMs);
          acknowledge();
          return realTimeout(callback, 0, ...args);
        }
        return realTimeout(callback, milliseconds, ...args);
      };
    } else if (role === 'worker') {
      setInterval(() => {
        try {
          const next = JSON.parse(fs.readFileSync(file, 'utf8')).now;
          if (next !== Date.now()) { mock.timers.setTime(next); acknowledge(); }
        } catch { /* The controller can be replacing its own clock file. */ }
      }, 10).unref();
    }
  }
}
