#!/usr/bin/env node

if (process.argv.includes('--help')) {
  process.stdout.write('Usage: inspect_skill_target.mjs [--help]\n');
} else {
  process.stdout.write('{"ok":true,"target":"near-miss-helper"}\n');
}
