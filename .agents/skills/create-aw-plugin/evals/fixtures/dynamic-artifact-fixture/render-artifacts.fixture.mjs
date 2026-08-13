process.stdout.write(JSON.stringify({
  version: 1,
  artifacts: [
    {
      id: 'dynamic-instructions',
      platform: 'codex',
      target: 'codex.developerInstructionsBlock',
      state: 'present',
      refreshKeys: ['message'],
      content: 'Legacy dynamic instructions.',
    },
  ],
}));
