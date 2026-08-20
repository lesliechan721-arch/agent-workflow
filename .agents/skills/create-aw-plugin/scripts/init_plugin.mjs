#!/usr/bin/env node

process.argv.splice(2, 0, 'init');
await import('./run-aw-plugin-command.mjs');
