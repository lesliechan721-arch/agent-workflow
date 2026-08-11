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
  ].join('\n'),
  'src/features/orders/list.ts': 'export function listOrders() { return []; }\n',
  'src/logging/format-entry.ts': 'export function formatEntry(value) { return String(value); }\n',
  'src/parser.py': 'def parse(value):\n    return value.strip()\n',
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
    'Paused users cannot sign in or create new charges.',
    'Existing data remains readable by administrators.',
    'Notifications, recovery, and acceptance checks follow this document.',
    '',
  ].join('\n'),
  'docs/approved-migration.md': [
    '# Approved migration',
    '',
    'The migration steps and rollback conditions are approved.',
    'Do not reopen the architecture decision during implementation.',
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

export const TRIGGER_WORKSPACE_FIXTURES = new Set([
  'default',
  'implementation_repo',
]);

export async function setupTriggerWorkspace({ workspaceRoot, evalCase }) {
  const fixture = evalCase.workspace_fixture ?? 'default';
  if (!TRIGGER_WORKSPACE_FIXTURES.has(fixture)) {
    throw new Error(`Unsupported trigger workspace fixture: ${fixture}`);
  }
  if (fixture === 'default') return;

  await Promise.all(Object.entries(IMPLEMENTATION_REPO_FILES).map(async ([relativePath, content]) => {
    const target = path.join(workspaceRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }));
}
