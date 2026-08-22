#!/usr/bin/env node

process.argv.splice(2, 0, '--deprecated-check-versions-alias');
await import('./plugin-status.mjs');
