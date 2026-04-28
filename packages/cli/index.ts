#!/usr/bin/env node

import { main } from './src/index.js';

void main().then((exitCode) => {
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
});
