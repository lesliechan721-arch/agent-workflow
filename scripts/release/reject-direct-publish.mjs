#!/usr/bin/env node

process.stderr.write('Direct package publication is disabled. Use pnpm release.\n');
process.exitCode = 1;
