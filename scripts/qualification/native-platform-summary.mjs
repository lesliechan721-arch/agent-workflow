import fs from 'node:fs/promises';

try {
  const report = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const cell = (value) => String(value ?? '').replace(/[|\r\n<>]/gu, ' ').slice(0, 500);
  const lines = ['## Native qualification', '', `Core result: **${cell(report.status)}**`,
    `Acceptance policy: ${cell(report.acceptancePolicy?.id ?? 'legacy schema 1 policy')}`,
    `Candidate source: ${cell(report.candidate?.sourceSha ?? 'unverified')}`,
    `Host: ${cell(report.environment?.platform)} ${cell(report.environment?.arch)}`, '',
    '| Client | Version | Product | Input | Scope | Core result | Required checks passed | Reason |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
  const observations = [];
  for (const client of report.clients) {
    const scopes = [...client.scopes, ...(client.publicAw ?? [])];
    for (const scope of scopes.length ? scopes : [{ scope: 'not run', status: client.status, checks: [], reason: client.reason }]) {
      lines.push(`| ${cell(client.platform)} | ${cell(client.requiredVersion)} | ${cell(scope.product ?? (scope.scope === 'not run' ? '' : 'cli'))} | ${cell(scope.input ?? 'aw-projection-candidate')} | ${cell(scope.scope)} | ${cell(scope.status)} | ${scope.checks.filter((check) => check.status === 'passed').length}/${scope.checks.length} | ${cell(scope.reason ?? client.reason)} |`);
      for (const observation of scope.observations ?? []) {
        observations.push(`| ${cell(client.platform)} | ${cell(scope.input ?? 'aw-projection-candidate')} | ${cell(scope.scope)} | ${cell(observation.id)} | ${cell(observation.status)} | ${cell(observation.reason)} |`);
      }
    }
  }
  const excluded = report.clients.filter(client => client.status === 'excluded');
  if (excluded.length) lines.push('', `Excluded units: ${excluded.map(client => `${cell(client.platform)} (${cell(client.reason)})`).join(', ')}. Exclusion is not a passing qualification.`);
  if (report.mixedPublicAw) {
    const { platforms, scope, status, reason, checks } = report.mixedPublicAw;
    lines.push('', '### Mixed native install', '',
      `${platforms.map(({ platform, version }) => `${cell(platform)} ${cell(version)}`).join(' and ')} in one ${cell(scope)} batch. **${cell(status)}**`,
      '', '| Required check | Result | Reason |', '| --- | --- | --- |',
      ...checks.map(check => `| ${cell(check.id)} | ${cell(check.status)} | ${cell(check.reason)} |`));
    if (reason) lines.push('', cell(reason));
  }
  if (observations.length) lines.push('', '### Non-blocking observations', '',
    '| Client | Input | Scope | Observation | Status | Reason |', '| --- | --- | --- | --- | --- | --- |', ...observations);
  lines.push('', 'The core result requires lifecycle, consumer content, scope, process safety and cleanup evidence. Public AW runs also require each applicable status and native permission check. Skill discovery and loading observations apply to the recorded client, scope and invocation path.', '');
  const text = lines.join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, text);
  else process.stdout.write(text);
} catch {
  console.error('Native qualification report is missing or invalid.');
  process.exitCode = 1;
}
