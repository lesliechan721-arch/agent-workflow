import fs from 'node:fs/promises';

try {
  const report = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const cell = (value) => String(value ?? '').replace(/[|\r\n<>]/gu, ' ').slice(0, 500);
  const lines = ['## Native qualification', '', `Result: **${cell(report.status)}**`, '',
    '| Client | Input | Scope | Result | Checks passed | Reason |', '| --- | --- | --- | --- | --- | --- |'];
  for (const client of report.clients) {
    const scopes = [...client.scopes, ...(client.publicAw ?? [])];
    for (const scope of scopes.length ? scopes : [{ scope: 'not run', status: client.status, checks: [], reason: client.reason }]) {
      lines.push(`| ${cell(client.platform)} | ${cell(scope.input ?? 'aw-projection-candidate')} | ${cell(scope.scope)} | ${cell(scope.status)} | ${scope.checks.filter((check) => check.status === 'passed').length}/${scope.checks.length} | ${cell(scope.reason)} |`);
    }
  }
  lines.push('', 'Candidate projection and optional public AW CLI scenarios are reported separately. Public AW uses production profiles; missing qualification remains unverified. Neither scenario qualifies model behavior, Desktop, all five component kinds, or the complete public AW install pipeline.', '');
  const text = lines.join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, text);
  else process.stdout.write(text);
} catch {
  console.error('Native qualification report is missing or invalid.');
  process.exitCode = 1;
}
