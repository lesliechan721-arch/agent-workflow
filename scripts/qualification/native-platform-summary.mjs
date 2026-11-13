import fs from 'node:fs/promises';

try {
  const report = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const cell = (value) => String(value ?? '').replace(/[|\r\n<>]/gu, ' ').slice(0, 500);
  const lines = ['## Native qualification', '', `Core result: **${cell(report.status)}**`,
    `Acceptance policy: ${cell(report.acceptancePolicy?.id ?? 'legacy schema 1 policy')}`, '',
    '| Client | Input | Scope | Core result | Required checks passed | Reason |', '| --- | --- | --- | --- | --- | --- |'];
  const observations = [];
  for (const client of report.clients) {
    const scopes = [...client.scopes, ...(client.publicAw ?? [])];
    for (const scope of scopes.length ? scopes : [{ scope: 'not run', status: client.status, checks: [], reason: client.reason }]) {
      lines.push(`| ${cell(client.platform)} | ${cell(scope.input ?? 'aw-projection-candidate')} | ${cell(scope.scope)} | ${cell(scope.status)} | ${scope.checks.filter((check) => check.status === 'passed').length}/${scope.checks.length} | ${cell(scope.reason)} |`);
      for (const observation of scope.observations ?? []) {
        observations.push(`| ${cell(client.platform)} | ${cell(scope.input ?? 'aw-projection-candidate')} | ${cell(scope.scope)} | ${cell(observation.id)} | ${cell(observation.status)} | ${cell(observation.reason)} |`);
      }
    }
  }
  const excluded = report.clients.filter(client => client.status === 'excluded');
  if (excluded.length) lines.push('', `Excluded units: ${excluded.map(client => `${cell(client.platform)} (${cell(client.reason)})`).join(', ')}. Exclusion is not a passing qualification.`);
  if (observations.length) lines.push('', '### Non-blocking observations', '',
    '| Client | Input | Scope | Observation | Status | Reason |', '| --- | --- | --- | --- | --- | --- |', ...observations);
  lines.push('', 'Candidate projection and optional public AW CLI scenarios are reported separately. Required management, dynamic consumer content and scope checks determine the core result. Unknown required checks remain blocking. Skill observations do not prove model adoption; unverified observations do not block the core result. Process safety and cleanup failures remain blocking. Excluded distributions do not count as passed. This report does not establish complete platform or component coverage.', '');
  const text = lines.join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, text);
  else process.stdout.write(text);
} catch {
  console.error('Native qualification report is missing or invalid.');
  process.exitCode = 1;
}
