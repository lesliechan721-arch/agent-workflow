import path from 'node:path';

import fs from 'fs-extra';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { expect } from 'vitest';

import {
  TuiController,
} from '../../src/tui/controller.js';

export async function nextTurn(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function input(instance: ReturnType<typeof render>, ...values: string[]): Promise<void> {
  for (const value of values) {
    instance.stdin.write(value);
    await nextTurn(2);
  }
}

export interface AcceptanceTraceStep {
  label: string;
  size: { columns: number; rows: number };
  inputs: string[];
  frame: string;
}

export function acceptanceTraceStep(
  instance: ReturnType<typeof render>,
  size: { columns: number; rows: number },
  label: string,
  inputs: string[] = [],
): AcceptanceTraceStep {
  const frame = instance.lastFrame() ?? '';
  expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
  expect(Math.max(...frame.split('\n').map(stringWidth))).toBeLessThanOrEqual(size.columns);
  expect(frame).not.toMatch(/\u001B\[[0-9;]*m/u);
  const focusCount = frame.match(/›/gu)?.length ?? 0;
  if (focusCount !== 1) throw new Error(`Expected one visible focus, got ${focusCount}:\n${frame}`);
  return { label, size, inputs, frame };
}

export async function writeAcceptanceTrace(
  fixtureId: string,
  steps: AcceptanceTraceStep[],
): Promise<void> {
  const outputDir = process.env.AW_TUI_ACCEPTANCE_TRACE_DIR;
  if (!outputDir) return;
  await fs.outputJson(path.join(outputDir, `${fixtureId.replaceAll('/', '__')}.json`), {
    schemaVersion: 1,
    fixtureId,
    synthetic: true,
    steps,
  }, { spaces: 2 });
}

export async function escape(instance: ReturnType<typeof render>): Promise<void> {
  instance.stdin.write('\u001B');
  await new Promise((resolve) => setTimeout(resolve, 550));
  await nextTurn(2);
}

export async function focusAction(
  instance: ReturnType<typeof render>,
  label: string,
  limit = 24,
): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    const frame = instance.lastFrame()?.replace(/ +(?=\[[a-z/?]\] *$)/gmu, ' ');
    if (frame?.includes(`› ${label}`) || frame?.includes(`› [${label}]`)
      || frame?.includes(`› ○ ${label}`) || frame?.includes(`› ● ${label}`)) return;
    await input(instance, '\u001B[B');
  }
  throw new Error(`Action was not reachable: ${label}\n${instance.lastFrame() ?? ''}`);
}

export async function focusBottomAction(
  instance: ReturnType<typeof render>,
  label: string,
): Promise<void> {
  await input(instance, 'a');
  await focusAction(instance, label);
}

export async function confirmReview(
  instance: ReturnType<typeof render>,
  value: TuiController,
): Promise<void> {
  if (value.snapshot.activeReview?.requiresConfirmation) {
    await input(instance, '\r', '\u001B[B', '\r');
  } else await input(instance, '\r');
}

export async function chooseConfigSave(
  instance: ReturnType<typeof render>,
  value: TuiController,
  action: 'only' | 'apply',
): Promise<void> {
  expect(value.snapshot.router.current.route.name).toBe('review');
  if (action === 'only' && instance.lastFrame()?.includes('改为只保存')) {
    await focusAction(instance, '改为只保存，稍后应用');
    await input(instance, '\r');
  }

  for (let index = 0; index < 12 && value.snapshot.router.current.route.name === 'reviewPreparing'; index += 1) {
    await nextTurn();
  }
  expect(value.snapshot.router.current.route.name).toBe('review');
}

export async function openConfigSave(
  instance: ReturnType<typeof render>,
  value: TuiController,
): Promise<void> {
  if (value.snapshot.router.current.route.name === 'configLayer') {
    await input(instance, '\u001B[B', '\r');
    await nextTurn(3);
  }
  expect(value.snapshot.router.current.route.name).toBe('configFields');
  await input(instance, 's');
  expect(value.snapshot.router.current.route.name).toBe('review');
}

export async function chooseConfigTarget(
  instance: ReturnType<typeof render>,
  value: TuiController,
  scope: 'project' | 'user',
): Promise<void> {
  if (value.snapshot.router.current.route.name === 'configFields') {
    expect(instance.lastFrame()).toContain(`仅可保存到${scope === 'project' ? '当前项目' : '个人默认'}`);
    return;
  }
  expect(value.snapshot.router.current.route.name).toBe('configLayer');
  await focusAction(instance, scope === 'project' ? '当前项目' : '个人默认');
  await input(instance, '\r');
  await nextTurn(3);
  expect(value.snapshot.router.current.route).toMatchObject({
    name: 'configFields', layer: { scope: 'effective' },
  });
}
