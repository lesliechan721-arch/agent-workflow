import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Route } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';
import {
  cleanupSmokeBuildSnapshot,
  createSmokeBuildSnapshot,
  type SmokeBuildSnapshot,
} from '../support/smoke-build-snapshot.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

type PrototypeOption = {
  id: string;
  label: string;
  kind: 'html' | 'image' | 'text' | 'metrics';
  artifact: string;
  description?: string;
};

type PrototypeConfig = {
  schemaVersion: 2;
  id: string;
  revision: number;
  question: string;
  decisionContext: {
    goal: string;
    priorities: string[];
    constraints: string[];
  };
  selectionMode?: 'single' | 'multiple' | 'none';
  htmlExecution?: 'static' | 'sandboxed';
  stopCondition: string;
  allowOther?: boolean;
  allowAnnotations?: boolean;
  options: PrototypeOption[];
  guidedQuestions?: Array<{
    id: string;
    label: string;
    selectionMode: 'single' | 'multiple' | 'freeform';
    choices?: string[];
  }>;
  editableCssVariables?: Record<string, string[]>;
};

type StartedSession = {
  ok: true;
  status: 'ready';
  session: string;
  url: string;
  prototypeId: string;
  revision: number;
  prototypePath: string;
};

const tempRoots: string[] = [];
const activeSessions = new Set<string>();
let browser: Browser;
let buildSnapshot: SmokeBuildSnapshot | null = null;
let runtimeScript: string;

function parseReceipt(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

async function createTempRoot(name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `ask-me-browser-${name}-`));
  tempRoots.push(root);
  return registerCurrentTestWritableStateRoot(root, `ask-me Prototype Review browser smoke ${name}`);
}

async function runRuntime(root: string, args: string[]): Promise<Record<string, unknown>> {
  const runtimeTmp = path.join(root, 'runtime-tmp');
  await fs.ensureDir(runtimeTmp);
  const result = await execFileAsync(process.execPath, [runtimeScript, ...args], {
    cwd: repoRoot,
    env: { ...process.env, AW_HOME: path.join(root, 'aw-home'), TMPDIR: runtimeTmp },
    maxBuffer: 2 * 1024 * 1024,
    timeout: 20_000,
  });
  return parseReceipt(result.stdout);
}

async function writePrototype(
  root: string,
  config: PrototypeConfig,
  artifacts: Record<string, string>,
): Promise<string> {
  await fs.ensureDir(path.join(root, 'artifact'));
  await fs.writeFile(path.join(root, 'brief.md'), '# Browser smoke prototype\n', 'utf8');
  await Promise.all(Object.entries(artifacts).map(async ([relativePath, content]) => {
    const target = path.join(root, relativePath);
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, content, 'utf8');
  }));
  const prototypePath = path.join(root, 'prototype.json');
  await fs.writeJson(prototypePath, config, { spaces: 2 });
  return prototypePath;
}

async function startPrototype(
  root: string,
  config: PrototypeConfig,
  artifacts: Record<string, string>,
  ttl = '2m',
): Promise<StartedSession> {
  const prototypePath = await writePrototype(root, config, artifacts);
  const receipt = await runRuntime(root, ['start', '--prototype', prototypePath, '--ttl', ttl]);
  expect(receipt).toMatchObject({ ok: true, status: 'ready', prototypeId: config.id });
  const started = { ...receipt, prototypePath } as StartedSession;
  activeSessions.add(started.session);
  return started;
}

async function waitForSubmission(root: string, started: StartedSession): Promise<Record<string, unknown>> {
  const receipt = await runRuntime(root, [
    'wait',
    '--session',
    started.session,
    '--timeout',
    '5s',
  ]);
  activeSessions.delete(started.session);
  return receipt;
}

async function stopSession(session: string): Promise<void> {
  const root = tempRoots.find((candidate) => session.startsWith(path.join(candidate, 'runtime-tmp')));
  try {
    await execFileAsync(process.execPath, [runtimeScript, 'stop', '--session', session], {
      cwd: repoRoot,
      env: root ? { ...process.env, TMPDIR: path.join(root, 'runtime-tmp') } : process.env,
      timeout: 10_000,
    });
  } catch {
    // The owning test can already have completed or stopped the session.
  }
  activeSessions.delete(session);
}

async function newPage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
  });
  return { context, page: await context.newPage() };
}

async function expectVisible(locator: Locator): Promise<void> {
  await locator.waitFor({ state: 'visible' });
  expect(await locator.isVisible()).toBe(true);
}

async function expectHidden(locator: Locator): Promise<void> {
  await locator.waitFor({ state: 'hidden' });
  expect(await locator.isVisible()).toBe(false);
}

async function expectCount(locator: Locator, count: number): Promise<void> {
  await expect.poll(() => locator.count()).toBe(count);
}

async function expectText(locator: Locator, text: string, { exact = false } = {}): Promise<void> {
  await expect.poll(async () => {
    const value = await locator.textContent();
    return exact ? value === text : value?.includes(text) === true;
  }).toBe(true);
}

async function expectFocused(locator: Locator): Promise<void> {
  await expect.poll(() => locator.evaluate((element) => element === element.ownerDocument.activeElement))
    .toBe(true);
}

async function expectChecked(locator: Locator): Promise<void> {
  await expect.poll(() => locator.isChecked()).toBe(true);
}

async function expectSubmitted(page: Page): Promise<void> {
  await expectVisible(page.getByText('反馈已保存。可以关闭本页。'));
  await expectHidden(page.locator('#reviewForm'));
  await expectFocused(page.locator('#success'));
}

function tokenFrom(started: StartedSession): string {
  return new URLSearchParams(new URL(started.url).hash.slice(1)).get('token')!;
}

async function browserSessionStatus(
  page: Page,
  started: StartedSession,
): Promise<Record<string, unknown>> {
  return page.evaluate(async (token) => {
    const response = await fetch('/api/status', {
      headers: { 'x-prototype-review-token': token },
    });
    return response.json();
  }, tokenFrom(started));
}

beforeAll(async () => {
  buildSnapshot = await createSmokeBuildSnapshot(repoRoot);
  const skillRoot = path.join(
    buildSnapshot.catalogOutputRoot,
    'plugins',
    'ask-me',
    'codex',
    'skills',
    'decision-prototype',
  );
  runtimeScript = path.join(skillRoot, 'scripts', 'prototype-review.mjs');
  await Promise.all([
    runtimeScript,
    path.join(skillRoot, 'assets', 'prototype.schema.json'),
    path.join(skillRoot, 'assets', 'feedback.schema.json'),
    path.join(skillRoot, 'assets', 'review-shell', 'index.html'),
    path.join(skillRoot, 'assets', 'review-shell', 'app.js'),
    path.join(skillRoot, 'assets', 'review-shell', 'styles.css'),
    path.join(skillRoot, 'assets', 'review-shell', 'review-policy.mjs'),
  ].map((filePath) => fs.access(filePath)));
  browser = await chromium.launch({ headless: true });
});

afterEach(async () => {
  for (const session of [...activeSessions]) await stopSession(session);
  await Promise.all(tempRoots.splice(0).map((root) => fs.remove(root)));
});

afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await cleanupSmokeBuildSnapshot(buildSnapshot);
    buildSnapshot = null;
  }
});

describe('ask-me Prototype Review browser smoke', () => {
  it('drives tabs, previews, annotations, guided answers, CSS values, validation, and revise submission', async () => {
    const root = await createTempRoot('rich');
    const config: PrototypeConfig = {
      schemaVersion: 2,
      id: 'browser-rich',
      revision: 1,
      question: '哪一个审批方向更容易核对？',
      decisionContext: {
        goal: '选择最容易核对审批状态的页面。',
        priorities: ['状态层级清楚', '主要动作容易找到'],
        constraints: ['保留审批历史', '手机上仍可阅读'],
      },
      selectionMode: 'single',
      htmlExecution: 'static',
      stopCondition: '评审者提供一个方向和具体修改。',
      allowOther: true,
      allowAnnotations: true,
      options: [
        {
          id: 'html-direction',
          label: 'HTML 方向',
          kind: 'html',
          artifact: 'artifact/direction.html',
          description: '可操作的审批摘要。',
        },
        {
          id: 'image-direction',
          label: '图片方向',
          kind: 'image',
          artifact: 'artifact/direction.svg',
          description: '静态信息层级方案。',
        },
      ],
      guidedQuestions: [
        { id: 'density', label: '信息密度是否合适？', selectionMode: 'single', choices: ['合适', '太密'] },
        { id: 'risks', label: '哪些部分仍有风险？', selectionMode: 'multiple', choices: ['层级', '交互', '文案'] },
        { id: 'change', label: '最重要的修改是什么？', selectionMode: 'freeform' },
      ],
      editableCssVariables: {
        '--accent': ['rgb(12, 34, 56)', 'rgb(78, 90, 123)'],
      },
    };
    const started = await startPrototype(root, config, {
      'artifact/direction.html': `<!doctype html>
        <style>:root{--accent:rgb(12,34,56)}body{margin:0;font:18px system-ui;padding:32px}.review-grid{display:grid;grid-template-columns:1fr 220px;gap:24px}.approval-row{display:flex;align-items:center;gap:18px}#summary{flex:1;color:var(--accent);padding:24px;border:2px solid currentColor}</style>
        <main class="review-grid"><div class="approval-row"><section id="summary" data-prototype-id="approval-summary" data-prototype-kind="text">待审批：设计系统更新</section><button>复核</button></div><aside>审批历史</aside><div style="grid-column:1/-1;height:900px"></div></main>`,
      'artifact/direction.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="300" viewBox="0 0 1200 300">
        <rect width="1200" height="300" fill="#f4f4f5"/><rect x="80" y="40" width="1040" height="220" rx="24" fill="#fff" stroke="#334155" stroke-width="4"/>
        <text x="150" y="130" font-family="system-ui" font-size="48" fill="#0f172a">审批摘要</text><text x="600" y="130" font-family="system-ui" font-size="30" fill="#475569">状态：等待复核</text>
      </svg>`,
    });
    const { context, page } = await newPage();
    try {
      await page.goto(started.url);
      await expectText(page.locator('#sessionState'), '页面已连接', { exact: true });
      await expectText(page.getByRole('heading', { level: 1 }), config.question, { exact: true });
      await expectText(page.locator('#decisionContext'), config.decisionContext.goal);
      await expectText(page.locator('#decisionContext'), config.decisionContext.priorities[1]);
      await expectText(page.locator('#decisionContext'), config.decisionContext.constraints[0]);
      expect(await page.locator('body').textContent()).not.toContain('"goal"');
      await expectCount(page.locator('button.primary:visible'), 1);
      await expectCount(page.getByText('下载 feedback.json'), 0);
      await expectHidden(page.locator('#candidateSelection'));
      await expectHidden(page.locator('#detailFeedback'));
      expect(await page.evaluate(() => {
        const ids = [
          'decisionContext',
          'candidateTabs',
          'previewHost',
          'candidateSelection',
          'verdictFieldset',
          'detailFeedback',
          'submitFeedback',
        ];
        const elements = ids.map((id) => document.getElementById(id));
        return elements.every((element, index) => (
          index === 0
          || Boolean(elements[index - 1]?.compareDocumentPosition(element!) & Node.DOCUMENT_POSITION_FOLLOWING)
        ));
      })).toBe(true);

      await expectCount(page.getByRole('tab'), 2);
      await expectCount(page.locator('.preview-panel'), 1);
      const desktopWidth = (await page.locator('.html-frame-shell').boundingBox())?.width ?? 0;
      expect(desktopWidth).toBeGreaterThan(800);
      await page.getByRole('button', { name: '手机' }).click();
      const mobileWidth = (await page.locator('.html-frame-shell').boundingBox())?.width ?? 1000;
      expect(mobileWidth).toBeLessThanOrEqual(392);
      await page.getByRole('button', { name: '桌面' }).click();
      await page.getByRole('button', { name: '并排比较' }).click();
      await expectCount(page.locator('.preview-panel'), 2);
      await page.getByRole('button', { name: '结束并排比较' }).click();

      await page.locator('input[name="verdict"][value="revise"]').check();
      await expectVisible(page.locator('#candidateSelection'));
      await expectVisible(page.locator('#detailFeedback'));
      await page.locator('input[name="selected-option"][value="html-direction"]').check();
      await page.getByRole('button', { name: '提交反馈' }).click();
      await expectVisible(page.locator('#notesError'));
      await expectFocused(page.locator('#globalNotes'));

      await page.getByRole('tab', { name: '图片方向' }).click();
      const zoom = page.locator('input[data-image-zoom="image-direction"]');
      await zoom.fill('150');
      await expect.poll(async () => (
        (await page.locator('.image-canvas').getAttribute('style'))?.includes('150%') === true
      )).toBe(true);
      await zoom.fill('100');
      const imageKeyboardTarget = page.locator('[data-annotation-target-key="point:image-direction:0.5:0.5"]');
      await imageKeyboardTarget.focus();
      await page.keyboard.press('Enter');
      await expectText(page.locator('#annotationTarget'), '图片位置 50%, 50%');
      await expectFocused(page.locator('#annotationCategory'));
      await page.keyboard.press('Escape');
      await expectFocused(imageKeyboardTarget);

      const image = page.locator('img[data-option-id="image-direction"]');
      const imageBox = await image.boundingBox();
      expect(imageBox).not.toBeNull();
      const imageClick = {
        x: Math.floor(imageBox!.width * 0.73),
        y: Math.floor(imageBox!.height * 0.62),
      };
      const expectedImagePoint = {
        x: imageClick.x / imageBox!.width,
        y: imageClick.y / imageBox!.height,
      };
      await image.click({ position: imageClick });
      await expectVisible(page.locator('#annotationDrawer'));
      await expectText(page.locator('#annotationTarget'), '图片方向 · 图片位置');
      await page.locator('#annotationCategory').selectOption('visual');
      await page.locator('#annotationComment').fill('状态与标题距离太近。');
      await page.locator('#annotationOutcome').fill('增加分组留白。');
      await page.getByRole('button', { name: '保存' }).click();
      await expectText(page.locator('.image-marker'), '1', { exact: true });

      await page.getByRole('tab', { name: 'HTML 方向' }).click();
      const frame = page.frameLocator('iframe[title="HTML 方向"]');
      const domTarget = frame.locator('[data-prototype-id="approval-summary"]');
      const beforeAnnotation = await domTarget.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      const domKeyboardTarget = page.locator('[data-annotation-target-key="text:html-direction:approval-summary"]');
      await domKeyboardTarget.focus();
      await page.keyboard.press('Enter');
      await expectText(page.locator('#annotationTarget'), '文本块');
      await expectFocused(page.locator('#annotationCategory'));
      await page.keyboard.press('Tab');
      await expectFocused(page.locator('#annotationComment'));
      await page.keyboard.type('摘要没有显示审批人。');
      await page.keyboard.press('Tab');
      await expectFocused(page.locator('#annotationOutcome'));
      await page.keyboard.type('在状态旁显示审批人。');
      await page.keyboard.press('Tab');
      await expectFocused(page.locator('#saveAnnotation'));
      await page.keyboard.press('Enter');
      await expectFocused(domKeyboardTarget);
      await expectText(frame.locator('.prototype-review-marker'), '2', { exact: true });
      await expectCount(page.locator('.annotation-item'), 2);
      const afterAnnotation = await frame.locator('[data-prototype-id="approval-summary"]').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      expect(afterAnnotation.x).toBeCloseTo(beforeAnnotation.x, 5);
      expect(afterAnnotation.y).toBeCloseTo(beforeAnnotation.y, 5);
      expect(afterAnnotation.width).toBeCloseTo(beforeAnnotation.width, 5);
      expect(afterAnnotation.height).toBeCloseTo(beforeAnnotation.height, 5);
      const domMarker = frame.locator('.prototype-review-marker');
      const markerLeft = await domMarker.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left));
      await page.setViewportSize({ width: 1100, height: 1000 });
      await expect.poll(async () => {
        const current = await domMarker.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left));
        return Math.abs(current - markerLeft) > 1;
      }).toBe(true);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await frame.locator('body').evaluate(() => window.scrollTo(0, 240));
      await expectHidden(domMarker);
      await frame.locator('body').evaluate(() => window.scrollTo(0, 0));
      await expectVisible(domMarker);

      await page.locator('.annotation-summary').first().click();
      await expectFocused(page.locator('.image-marker[data-annotation-id="annotation-1"]'));
      await page.getByRole('tab', { name: 'HTML 方向' }).click();
      await expectChecked(page.locator('input[name="selected-option"][value="html-direction"]'));

      await page.locator('[data-question-id="density"] input[value="合适"]').check();
      await page.locator('[data-question-id="risks"] input[value="层级"]').check();
      await page.locator('[data-question-id="risks"] input[value="交互"]').check();
      await page.locator('[data-question-id="change"] textarea').fill('先显示审批人，再显示时间。');
      const cssSelect = page.locator('select[data-variable-name="--accent"]');
      await cssSelect.selectOption('rgb(78, 90, 123)');
      await expect.poll(() => frame.locator('html').evaluate((element) =>
        (element as HTMLElement).style.getPropertyValue('--accent'))).toBe('rgb(78, 90, 123)');

      await page.getByRole('button', { name: '提交反馈' }).click();
      await expectSubmitted(page);

      const waited = await waitForSubmission(root, started);
      expect(waited).toMatchObject({
        ok: true,
        status: 'submitted',
        verdict: 'revise',
        selectedOptionCount: 1,
        annotationCount: 2,
      });
      const feedback = await fs.readJson(path.join(root, 'feedback.json'));
      expect(feedback).toMatchObject({
        verdict: 'revise',
        selectedOptions: ['html-direction'],
        answers: [
          { questionId: 'density', selected: ['合适'] },
          { questionId: 'risks', selected: ['层级', '交互'] },
          { questionId: 'change', selected: [], comment: '先显示审批人，再显示时间。' },
        ],
        cssVariableValues: { '--accent': 'rgb(78, 90, 123)' },
      });
      expect(feedback.annotations.map((annotation: { target: { kind: string } }) => annotation.target.kind))
        .toEqual(['point', 'text']);
      const imageAnnotation = feedback.annotations.find((annotation: { target: { kind: string } }) => (
        annotation.target.kind === 'point'
      ));
      expect(imageAnnotation.target.value.x).toBeCloseTo(expectedImagePoint.x, 2);
      expect(imageAnnotation.target.value.y).toBeCloseTo(expectedImagePoint.y, 2);
      await expect(runRuntime(root, ['start', '--prototype', started.prototypePath, '--ttl', '2m']))
        .resolves.toMatchObject({ status: 'submitted', verdict: 'revise' });
      await expect(fetch(started.url)).rejects.toThrow();
    } finally {
      await context.close();
    }
  }, 60_000);

  it('completes an accepted single-selection flow with the keyboard and locks submitted editing', async () => {
    const root = await createTempRoot('keyboard');
    const config: PrototypeConfig = {
      schemaVersion: 2,
      id: 'browser-keyboard',
      revision: 1,
      question: '键盘用户应接受哪个方向？',
      decisionContext: {
        goal: '确认主流程可用键盘完成。',
        priorities: ['清晰焦点'],
        constraints: ['不使用鼠标'],
      },
      selectionMode: 'single',
      stopCondition: '键盘提交一个候选。',
      options: [
        { id: 'alpha', label: 'Alpha', kind: 'text', artifact: 'artifact/alpha.txt' },
        { id: 'beta', label: 'Beta', kind: 'text', artifact: 'artifact/beta.txt' },
      ],
    };
    const started = await startPrototype(root, config, {
      'artifact/alpha.txt': 'Alpha candidate\n',
      'artifact/beta.txt': 'Beta candidate\n',
    });
    const { context, page } = await newPage();
    try {
      await page.goto(started.url);
      const candidate = page.locator('input[name="selected-option"][value="beta"]');
      const verdict = page.locator('input[name="verdict"][value="accepted"]');
      await verdict.focus();
      await page.keyboard.press('Space');
      await expectChecked(verdict);
      await candidate.focus();
      await page.keyboard.press('Space');
      await expectChecked(candidate);
      const submit = page.getByRole('button', { name: '提交反馈' });
      await submit.focus();
      await page.keyboard.press('Enter');
      await expectSubmitted(page);
      await expect.poll(() => candidate.isDisabled()).toBe(true);

      const waited = await waitForSubmission(root, started);
      expect(waited).toMatchObject({
        status: 'submitted',
        verdict: 'accepted',
        selectedOptionCount: 1,
      });
    } finally {
      await context.close();
    }
  });

  it('connects, extends to the cap, and ends cancellation, expiry, and disconnection without a verdict', async () => {
    const config: PrototypeConfig = {
      schemaVersion: 2,
      id: 'browser-session-controls',
      revision: 1,
      question: '会话控制是否清楚？',
      decisionContext: {
        goal: '核对连接和结束状态。',
        priorities: ['状态真实'],
        constraints: ['取消不生成反馈'],
      },
      selectionMode: 'none',
      stopCondition: '确认会话控制。',
      options: [{ id: 'only', label: '会话控制', kind: 'text', artifact: 'artifact/only.txt' }],
    };

    const cancelRoot = await createTempRoot('session-controls');
    const started = await startPrototype(cancelRoot, config, { 'artifact/only.txt': 'Session controls\n' });
    const first = await newPage();
    try {
      await first.page.goto(started.url);
      await expectText(first.page.locator('#sessionState'), '页面已连接', { exact: true });
      const connected = await browserSessionStatus(first.page, started);
      expect(connected).toMatchObject({
        status: 'ready',
        presentation: { pageConnected: true },
      });
      expect(Date.parse(connected.expiresAt as string)).toBeLessThan(Date.parse(connected.maxExpiresAt as string));

      const extend = first.page.getByRole('button', { name: '延长 30 分钟' });
      for (let count = 0; count < 8; count += 1) {
        await extend.click();
        await expectText(first.page.locator('#sessionState'), '页面已连接', { exact: true });
      }
      await expect.poll(() => extend.isDisabled()).toBe(true);
      const capped = await browserSessionStatus(first.page, started);
      expect(capped.expiresAt).toBe(capped.maxExpiresAt);

      let pendingFeedbackRoute: Route | undefined;
      let markFeedbackPending!: () => void;
      const feedbackPending = new Promise<void>((resolve) => { markFeedbackPending = resolve; });
      await first.page.route('**/api/feedback', (route) => {
        pendingFeedbackRoute = route;
        markFeedbackPending();
      });
      await first.page.locator('input[name="verdict"][value="accepted"]').check();
      await first.page.getByRole('button', { name: '提交反馈' }).click();
      await feedbackPending;
      await first.page.getByRole('button', { name: '取消评审' }).click();
      await expectText(first.page.locator('#sessionState'), '评审已取消', { exact: true });
      await pendingFeedbackRoute!.abort('internetdisconnected');
      await expect.poll(() => first.page.locator('#status').textContent()).toBe('');
      await expectVisible(first.page.getByText('此会话已取消。未生成反馈判断。'));
      await expect.poll(() => first.page.locator('#reviewForm').evaluate((form) => (
        [...form.querySelectorAll('button, input, select, textarea')]
          .every((control) => (control as HTMLButtonElement).disabled)
      ))).toBe(true);
      await expect(waitForSubmission(cancelRoot, started)).resolves.toMatchObject({ status: 'cancelled' });
      await expect(fs.pathExists(path.join(cancelRoot, 'feedback.json'))).resolves.toBe(false);
      await expect(fetch(started.url)).rejects.toThrow();
    } finally {
      await first.context.close();
    }

    const disconnectedRoot = await createTempRoot('disconnected');
    const disconnected = await startPrototype(disconnectedRoot, {
      ...config,
      id: 'browser-disconnected',
    }, { 'artifact/only.txt': 'Disconnected session\n' });
    const second = await newPage();
    try {
      await second.page.goto(disconnected.url);
      await expectText(second.page.locator('#sessionState'), '页面已连接', { exact: true });
      await second.page.route('**/api/status', async (route) => route.abort('internetdisconnected'));
      await expect.poll(
        () => second.page.locator('#sessionState').textContent(),
        { timeout: 5000 },
      ).toBe('连接已断开');
      await expect.poll(() => second.page.locator('input[name="verdict"]').first().isDisabled()).toBe(true);
      await expect(fs.pathExists(path.join(disconnectedRoot, 'feedback.json'))).resolves.toBe(false);
    } finally {
      await second.context.close();
    }

    const expiredRoot = await createTempRoot('expired');
    const expired = await startPrototype(expiredRoot, {
      ...config,
      id: 'browser-expired',
    }, { 'artifact/only.txt': 'Expiring session\n' }, '2s');
    const third = await newPage();
    try {
      await third.page.goto(expired.url);
      await expectText(third.page.locator('#sessionState'), '页面已连接', { exact: true });
      await expect.poll(
        async () => ['评审已到期', '期限已到，状态待确认'].includes(
          (await third.page.locator('#sessionState').textContent()) || '',
        ),
        { timeout: 6000 },
      ).toBe(true);
      await expect.poll(() => third.page.locator('input[name="verdict"]').first().isDisabled()).toBe(true);
      await expect(waitForSubmission(expiredRoot, expired)).resolves.toMatchObject({ status: 'expired' });
      await expect(fs.pathExists(path.join(expiredRoot, 'feedback.json'))).resolves.toBe(false);
      await expect(fetch(expired.url)).rejects.toThrow();
    } finally {
      await third.context.close();
    }
  }, 40_000);

  it('uses checkboxes for multiple selection and hides meaningless controls for single-candidate modes', async () => {
    const multipleRoot = await createTempRoot('multiple');
    const baseContext = {
      goal: '核对候选选择语义。',
      priorities: ['控件类型正确'],
      constraints: ['不创建额外状态'],
    };
    const multiple: PrototypeConfig = {
      schemaVersion: 2,
      id: 'browser-multiple',
      revision: 1,
      question: '哪些模块应组合？',
      decisionContext: baseContext,
      selectionMode: 'multiple',
      stopCondition: '选择一个或多个模块。',
      options: [
        { id: 'one', label: '模块一', kind: 'text', artifact: 'artifact/one.txt' },
        { id: 'two', label: '模块二', kind: 'text', artifact: 'artifact/two.txt' },
      ],
    };
    const multipleStarted = await startPrototype(multipleRoot, multiple, {
      'artifact/one.txt': 'One\n',
      'artifact/two.txt': 'Two\n',
    });
    const first = await newPage();
    try {
      await first.page.goto(multipleStarted.url);
      await expectCount(first.page.locator('input[name="selected-option"][type="checkbox"]'), 2);
      await expectHidden(first.page.locator('#candidateSelection'));
      await first.page.locator('input[name="verdict"][value="accepted"]').check();
      await expectVisible(first.page.locator('#candidateSelection'));
      await first.page.locator('input[name="selected-option"]').first().check();
      await first.page.locator('input[name="selected-option"]').last().check();
      await first.page.locator('input[name="verdict"][value="rejected"]').check();
      await expect.poll(() => first.page.locator('#candidateSelection').evaluate(
        (element) => (element as HTMLFieldSetElement).disabled,
      )).toBe(true);
      await expectCount(first.page.locator('input[name="selected-option"]:checked'), 0);
      await first.page.locator('input[name="verdict"][value="accepted"]').check();
      await expect.poll(() => first.page.locator('#candidateSelection').evaluate(
        (element) => (element as HTMLFieldSetElement).disabled,
      )).toBe(false);
      await expectCount(first.page.locator('input[name="selected-option"]:checked'), 0);
      await first.page.locator('input[name="selected-option"]').first().check();
      await first.page.locator('input[name="selected-option"]').last().check();
      await first.page.getByRole('button', { name: '提交反馈' }).click();
      await expectSubmitted(first.page);
      await expect(waitForSubmission(multipleRoot, multipleStarted)).resolves.toMatchObject({
        status: 'submitted',
        selectedOptionCount: 2,
      });
    } finally {
      await first.context.close();
    }

    const singleRoot = await createTempRoot('single-candidate');
    const single: PrototypeConfig = {
      schemaVersion: 2,
      id: 'browser-single-candidate',
      revision: 1,
      question: '这个单一候选是否成立？',
      decisionContext: baseContext,
      selectionMode: 'single',
      stopCondition: '直接判断单一候选。',
      options: [
        { id: 'only', label: '唯一候选', kind: 'text', artifact: 'artifact/only.txt' },
      ],
    };
    const singleStarted = await startPrototype(singleRoot, single, {
      'artifact/only.txt': 'Only candidate\n',
    });
    const singlePage = await newPage();
    try {
      await singlePage.page.goto(singleStarted.url);
      await expectHidden(singlePage.page.locator('#candidateTabs'));
      await expectHidden(singlePage.page.locator('#candidateSelection'));
      await expectCount(singlePage.page.locator('input[name="selected-option"]'), 0);
      await singlePage.page.locator('input[name="verdict"][value="accepted"]').check();
      await singlePage.page.locator('input[name="verdict"][value="rejected"]').check();
      await expect.poll(() => singlePage.page.locator('#candidateSelection').evaluate(
        (element) => (element as HTMLFieldSetElement).disabled,
      )).toBe(true);
      await singlePage.page.locator('#verdictDetailInput').fill('唯一候选没有满足当前目标。');
      await singlePage.page.getByRole('button', { name: '提交反馈' }).click();
      await expectSubmitted(singlePage.page);
      await expect(waitForSubmission(singleRoot, singleStarted)).resolves.toMatchObject({
        status: 'submitted',
        verdict: 'rejected',
        selectedOptionCount: 0,
      });
      await expect(fs.readJson(path.join(singleRoot, 'feedback.json'))).resolves.toMatchObject({
        verdict: 'rejected',
        selectedOptions: [],
        reason: '唯一候选没有满足当前目标。',
      });
    } finally {
      await singlePage.context.close();
    }

    const noneRoot = await createTempRoot('none');
    const none: PrototypeConfig = {
      schemaVersion: 2,
      id: 'browser-none',
      revision: 1,
      question: '这个单一原型是否成立？',
      decisionContext: baseContext,
      selectionMode: 'none',
      htmlExecution: 'sandboxed',
      stopCondition: '直接判断单一原型。',
      options: [
        { id: 'only', label: '唯一原型', kind: 'html', artifact: 'artifact/only.html' },
      ],
    };
    const noneStarted = await startPrototype(noneRoot, none, {
      'artifact/only.html': '<p data-prototype-id="sandbox-result">等待脚本</p><script>document.querySelector("p").textContent = "模型逻辑已运行"</script>',
    });
    const second = await newPage();
    try {
      await second.page.goto(noneStarted.url);
      await expectHidden(second.page.locator('#candidateTabs'));
      await expectHidden(second.page.locator('#candidateSelection'));
      await expectCount(second.page.locator('input[name="selected-option"]'), 0);
      await expectText(second.page.frameLocator('iframe').locator('p'), '模型逻辑已运行', { exact: true });
      await expectHidden(second.page.locator('#annotationPanel'));
      await expectCount(second.page.frameLocator('iframe').locator('.prototype-review-marker'), 0);
      await second.page.locator('input[name="verdict"][value="accepted"]').check();
      await second.page.locator('#globalNotes').fill('整体反馈仍可提交。');
      await second.page.getByRole('button', { name: '提交反馈' }).click();
      await expectSubmitted(second.page);
      await expect(waitForSubmission(noneRoot, noneStarted)).resolves.toMatchObject({
        status: 'submitted',
        selectedOptionCount: 0,
      });
    } finally {
      await second.context.close();
    }
  }, 40_000);
});
