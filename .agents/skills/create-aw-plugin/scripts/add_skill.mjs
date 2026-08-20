#!/usr/bin/env node

process.argv.splice(2, 0, 'add-skill');
await import('./run-aw-plugin-command.mjs');
