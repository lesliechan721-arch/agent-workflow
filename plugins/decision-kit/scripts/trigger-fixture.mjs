import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const IMPLEMENTATION_REPO_FILES = {
  'src/components/pagination.ts': [
    'export const DEFAULT_PAGE_SIZE = 50;',
    'export function paginate(items, page) {',
    '  return items.slice((page - 1) * DEFAULT_PAGE_SIZE, page * DEFAULT_PAGE_SIZE);',
    '}',
    '',
  ].join('\n'),
  'src/features/invoices/export.ts': [
    'export const invoiceExportPolicy = {',
    "  format: 'csv',",
    "  range: 'current-filter',",
    "  fields: ['id', 'customer', 'amount', 'created_at'],",
    "  permission: 'list:read',",
    '};',
    '',
    'export function exportInvoicesCsv(rows) {',
    '  const header = invoiceExportPolicy.fields.join(\',\');',
    '  const body = rows.map((row) =>',
    '    invoiceExportPolicy.fields.map((field) => String(row[field])).join(\',\'),',
    '  );',
    "  return [header, ...body].join('\\n');",
    '}',
    '',
  ].join('\n'),
  'src/features/orders/list.ts': [
    'export interface Order {',
    '  id: string;',
    '  customer: string;',
    '  amount: number;',
    '  created_at: string;',
    '}',
    '',
    'export function listOrders(): Order[] { return []; }',
    '',
  ].join('\n'),
  'src/features/settings/page.ts': [
    "export const settingsPrimaryButtonColor = 'gray';",
    '',
  ].join('\n'),
  'src/styles/button-colors.ts': [
    "export const primaryButtonBlue = '#2563eb';",
    '',
  ].join('\n'),
  'src/logging/format-entry.ts': 'export function formatEntry(value) { return String(value); }\n',
  'src/parser.py': 'def parse(value):\n    return value\n',
  'tests/parser_test.py': [
    'from src.parser import parse',
    '',
    'def test_parse_trims_whitespace():',
    "    assert parse(' value ') == 'value'",
    '',
  ].join('\n'),
  'spec/account-pause.md': [
    '# Account pause',
    '',
    'This specification is complete and approved. Internal implementation choices follow nearby code.',
    'Implement in `src/accounts/pause-account.ts`, `src/accounts/store.ts`,',
    '`src/auth/sign-in.ts`, `src/billing/create-charge.ts`,',
    '`src/notifications/account-email.ts`, and `tests/account-pause.test.ts`.',
    '',
    '## Pause behavior',
    '',
    '- Paused users cannot sign in. Authentication returns `ACCOUNT_PAUSED`.',
    '- Paused users cannot create new charges. Billing returns `ACCOUNT_PAUSED`.',
    '- Existing data remains readable by administrators.',
    '- After a pause succeeds, send the account owner one `account-paused` email.',
    '- Pausing an already paused account succeeds without sending another email.',
    '',
    '## Recovery',
    '',
    '- An administrator can resume the account.',
    '- Sign-in and new charges become available immediately after resume succeeds.',
    '- Resume does not modify existing account data.',
    '',
    '## Acceptance',
    '',
    '- Tests cover sign-in, new charges, administrator reads, email deduplication, and resume.',
    '- Existing behavior for active accounts remains unchanged.',
    '',
  ].join('\n'),
  'docs/approved-migration.md': [
    '# Approved session expiry migration',
    '',
    'This requirement, execution sequence, rollback, and acceptance criteria are approved.',
    'Do not reopen the architecture decision during implementation.',
    'Add `db/migrations/202608110900_add_session_expiry.sql`, then update',
    '`src/sessions/repository.ts`, `src/config/flags.ts`, and `tests/session-expiry.test.ts`.',
    '',
    '## Requirement',
    '',
    '- Add a nullable `expires_at` column to `sessions`.',
    '- Existing rows with `expires_at = NULL` remain valid until they are replaced.',
    '- New sessions set `expires_at` to 30 days after creation.',
    '',
    '## Execution',
    '',
    '1. Add the nullable column without a table rewrite.',
    '2. Deploy reads that accept NULL and writes that set the 30-day expiry.',
    '3. Verify new and existing sessions before removing the rollout flag.',
    '',
    '## Rollback',
    '',
    '- Re-enable the old write path and keep the nullable column.',
    '- Do not drop the column during rollback.',
    '',
    '## Acceptance',
    '',
    '- Existing sessions remain valid after migration.',
    '- New sessions contain the expected expiry.',
    '- Rolling back does not invalidate any session.',
    '',
  ].join('\n'),
  'docs/ADR-014.md': [
    '# ADR-014',
    '',
    'PostgreSQL was selected for transactional consistency and existing operations support.',
    '',
  ].join('\n'),
  'docs/deletion.md': '# Deletion\nDeleted accounts can be restored for 30 days.\n',
  'docs/network.md': '# Network\nIPv6 is not enabled in the current deployment.\n',
};

const EXPORT_POLICY_ONLY_REPO_FILES = {
  ...IMPLEMENTATION_REPO_FILES,
  'src/features/invoices/export.ts': [
    'export const invoiceExportPolicy = {',
    "  format: 'csv',",
    "  range: 'current-filter',",
    "  fields: ['id', 'customer', 'amount', 'created_at'],",
    "  permission: 'list:read',",
    '};',
    '',
  ].join('\n'),
};

const TYPESCRIPT_SERVICE_FILES = {
  'package.json': [
    '{',
    '  "name": "decision-kit-trigger-fixture",',
    '  "private": true,',
    '  "type": "module",',
    '  "scripts": { "test": "node --test" }',
    '}',
    '',
  ].join('\n'),
  'tsconfig.json': [
    '{',
    '  "compilerOptions": {',
    '    "module": "NodeNext",',
    '    "moduleResolution": "NodeNext",',
    '    "strict": true',
    '  },',
    '  "include": ["src/**/*.ts", "tests/**/*.ts"]',
    '}',
    '',
  ].join('\n'),
  'README.md': [
    '# Fixture service',
    '',
    'This is a small TypeScript service. Domain code lives under `src/`,',
    'PostgreSQL migrations live under `db/migrations/`, and tests live under `tests/`.',
    '',
  ].join('\n'),
};

const NEUTRAL_EXPORT_REPO_FILES = {
  ...TYPESCRIPT_SERVICE_FILES,
  'src/features/orders/list.ts': [
    'export interface Order {',
    '  id: string;',
    '  customer: string;',
    '  amount: number;',
    '}',
    '',
    'export function listOrders(): Order[] {',
    '  return [];',
    '}',
    '',
  ].join('\n'),
  'docs/order-export.md': [
    '# Order export',
    '',
    'The export feature has not been specified.',
    'This repository contains no approved export range convention.',
    '',
  ].join('\n'),
};

const ACCOUNT_PAUSE_REPO_FILES = {
  ...TYPESCRIPT_SERVICE_FILES,
  'src/accounts/store.ts': [
    "export type AccountStatus = 'active' | 'paused';",
    '',
    'export interface Account {',
    '  id: string;',
    '  ownerEmail: string;',
    '  status: AccountStatus;',
    '}',
    '',
    'const accounts = new Map<string, Account>();',
    '',
    'export function getAccount(id: string): Account | undefined {',
    '  return accounts.get(id);',
    '}',
    '',
    'export function putAccount(account: Account): void {',
    '  accounts.set(account.id, account);',
    '}',
    '',
    'export function resetAccounts(): void {',
    '  accounts.clear();',
    '}',
    '',
    'export function setAccountStatus(id: string, status: AccountStatus): Account | undefined {',
    '  const account = accounts.get(id);',
    '  if (!account) return undefined;',
    '  account.status = status;',
    '  return account;',
    '}',
    '',
  ].join('\n'),
  'src/accounts/read-account.ts': [
    "export type AccountReadRole = 'administrator' | 'owner';",
    '',
    'export function canReadAccount(role: AccountReadRole): boolean {',
    "  return role === 'administrator' || role === 'owner';",
    '}',
    '',
  ].join('\n'),
  'src/accounts/pause-account.ts': [
    'export function pauseAccount(accountId: string) {',
    "  throw new Error('not implemented');",
    '}',
    '',
    'export function resumeAccount(accountId: string) {',
    "  throw new Error('not implemented');",
    '}',
    '',
  ].join('\n'),
  'src/auth/sign-in.ts': [
    "export type SignInResult = { ok: true } | { ok: false; code: 'ACCOUNT_NOT_FOUND' | 'ACCOUNT_PAUSED' };",
    '',
    "export function signIn(status: 'active' | 'paused' | 'missing'): SignInResult {",
    "  if (status === 'missing') return { ok: false, code: 'ACCOUNT_NOT_FOUND' };",
    '  return { ok: true };',
    '}',
    '',
  ].join('\n'),
  'src/billing/create-charge.ts': [
    "export type ChargeResult = { ok: true } | { ok: false; code: 'ACCOUNT_NOT_FOUND' | 'ACCOUNT_PAUSED' };",
    '',
    "export function createCharge(status: 'active' | 'paused' | 'missing'): ChargeResult {",
    "  if (status === 'missing') return { ok: false, code: 'ACCOUNT_NOT_FOUND' };",
    '  return { ok: true };',
    '}',
    '',
  ].join('\n'),
  'src/notifications/account-email.ts': [
    "export type AccountEmailTemplate = 'account-paused';",
    '',
    'export const sentAccountEmails: Array<{ template: AccountEmailTemplate; email: string }> = [];',
    '',
    'export function sendAccountEmail(template: AccountEmailTemplate, email: string) {',
    '  const message = { template, email };',
    '  sentAccountEmails.push(message);',
    '  return message;',
    '}',
    '',
    'export function resetAccountEmails(): void {',
    '  sentAccountEmails.length = 0;',
    '}',
    '',
  ].join('\n'),
  'tests/account-pause.test.ts': [
    "export const accountPauseAcceptanceCases = ['sign-in', 'charge', 'email', 'resume'];",
    '',
  ].join('\n'),
};

const ACCOUNT_PAUSE_GAP_REPO_FILES = {
  ...TYPESCRIPT_SERVICE_FILES,
  ...ACCOUNT_PAUSE_REPO_FILES,
  'docs/account-pause.md': [
    '# Account pause',
    '',
    'The repository has no approved specification for account pause behavior.',
    'The implementation must define effects on sign-in, billing, and data access.',
    '',
  ].join('\n'),
};

const SESSION_MIGRATION_REPO_FILES = {
  ...TYPESCRIPT_SERVICE_FILES,
  'db/migrations/README.md': [
    '# Migration convention',
    '',
    'Use UTC timestamp prefixes and forward-only SQL files.',
    'Rollback keeps additive nullable columns and restores the previous application path.',
    '',
  ].join('\n'),
  'db/migrations/202608100900_create_sessions.sql': [
    'CREATE TABLE sessions (',
    '  id text PRIMARY KEY,',
    '  created_at timestamptz NOT NULL',
    ');',
    '',
  ].join('\n'),
  'src/config/flags.ts': [
    "export const sessionExpiryRollout = process.env.SESSION_EXPIRY_ROLLOUT === '1';",
    '',
  ].join('\n'),
  'src/sessions/repository.ts': [
    'export interface SessionRow {',
    '  id: string;',
    '  created_at: string;',
    '}',
    '',
    'export function createSession(id: string, createdAt: string): SessionRow {',
    '  return { id, created_at: createdAt };',
    '}',
    '',
    'export function isSessionValid(_session: SessionRow, _now: string): boolean {',
    '  return true;',
    '}',
    '',
  ].join('\n'),
  'tests/session-expiry.test.ts': [
    "export const sessionExpiryAcceptanceCases = ['existing', 'new', 'rollback'];",
    '',
  ].join('\n'),
};

export const TRIGGER_WORKSPACE_FIXTURES = new Set([
  'default',
  'neutral_export_repo',
  'export_policy_only_repo',
  'implementation_repo',
  'account_pause_gap_repo',
  'account_pause_repo',
  'session_migration_repo',
]);

export async function setupTriggerWorkspace({ workspaceRoot, evalCase }) {
  const fixture = evalCase.workspace_fixture ?? 'default';
  if (!TRIGGER_WORKSPACE_FIXTURES.has(fixture)) {
    throw new Error(`Unsupported trigger workspace fixture: ${fixture}`);
  }
  if (fixture === 'default') return;

  const files = fixture === 'neutral_export_repo'
    ? NEUTRAL_EXPORT_REPO_FILES
    : fixture === 'export_policy_only_repo'
      ? EXPORT_POLICY_ONLY_REPO_FILES
      : fixture === 'account_pause_gap_repo'
        ? ACCOUNT_PAUSE_GAP_REPO_FILES
        : {
          ...IMPLEMENTATION_REPO_FILES,
          ...(fixture === 'account_pause_repo' ? ACCOUNT_PAUSE_REPO_FILES : {}),
          ...(fixture === 'session_migration_repo' ? SESSION_MIGRATION_REPO_FILES : {}),
        };

  await Promise.all(Object.entries(files).map(async ([relativePath, content]) => {
    const target = path.join(workspaceRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }));
}
