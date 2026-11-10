import fs from 'node:fs/promises';

try {
  const report = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const cell = (value) => String(value ?? '').replace(/[|\r\n<>]/gu, ' ').slice(0, 500);
  const lines = ['## Native qualification', '', `Result: **${cell(report.status)}**`, '',
    '| Client | Scope | Result | Checks passed | Reason |', '| --- | --- | --- | --- | --- |'];
  for (const client of report.clients) {
    for (const scope of client.scopes.length ? client.scopes : [{ scope: 'not run', status: client.status, checks: [], reason: client.reason }]) {
      lines.push(`| ${cell(client.platform)} | ${cell(scope.scope)} | ${cell(scope.status)} | ${scope.checks.filter((check) => check.status === 'passed').length}/${scope.checks.length} | ${cell(scope.reason)} |`);
    }
  }
  lines.push('', 'This verifies AW projection candidates with real CLI clients. It does not qualify model behavior, Desktop, all five component kinds, or the complete public AW install pipeline.', '');
  const text = lines.join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, text);
  else process.stdout.write(text);
} catch {
  console.error('Native qualification report is missing or invalid.');
  process.exitCode = 1;
}
