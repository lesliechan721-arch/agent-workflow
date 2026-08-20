#!/usr/bin/env node

process.argv.splice(2, 0, 'check-versions');
await import('./run-aw-plugin-command.mjs');
