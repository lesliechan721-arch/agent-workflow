#!/usr/bin/env node
// Explicit developer qualification of the documented native CLI path, not a runtime adapter.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startFixture } from './browser-fixture.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('node scripts/qualify-browser.mjs --out NEW_DIRECTORY [--headed] [--online]\nUses installed agent-browser and Chrome with isolated HOME/workspace and loopback pages. Saves native responses, PNGs and trace. --online also reads https://example.com. No installation or model calls.');
  process.exit(0);
}
if (args.length < 2 || args.length > 4 || args[0] !== '--out' || !args[1]
  || args.slice(2).some(arg => !['--headed', '--online'].includes(arg))
  || new Set(args.slice(2)).size !== args.slice(2).length) {
  console.error('Invalid arguments. Use --help.'); process.exit(2);
}
process.umask(0o077);
const out = path.resolve(args[1]);
await mkdir(out, { mode: 0o700 }); // Existing output is deliberately not overwritten.
// macOS Unix sockets have a short path limit; its default TMPDIR can already be long.
const root = await mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'bu-n-'));
const cwd = path.join(root, 'workspace'), home = path.join(root, 'home');
await mkdir(cwd); await mkdir(home);
const maxOutput = 16000;
const browser = process.env.AGENT_BROWSER_EXECUTABLE_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Qualification has synthetic credentials only. It does not test agent compliance with these settings.
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: root,
  AGENT_BROWSER_EXECUTABLE_PATH: browser };
const records = [], checks = [], sessions = new Set(), tempArtifacts = [];
const report = { platform: process.platform, arch: process.arch, node: process.version,
  headed: args.includes('--headed'), checks, modelEval: 'not-run', independentAudit: 'not-run',
  visualInspection: 'separate-image-tool-required', limitations: [
    'Native responses are not passed through a plugin redactor or result protocol.',
    'No lost-acknowledgement or exactly-once guarantee is inferred from this qualification.'
  ] };
let fixture, session;
function command(argv, { input, sessionName = session, raw = false, environment = env } = {}) {
  return new Promise((resolve, reject) => {
    const invocation = [...(sessionName ? ['--session', sessionName] : []), ...(!raw ? ['--json'] : []), ...argv];
    const child = execFile('agent-browser', invocation, { cwd, env: environment, timeout: 35000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`${argv[0]} failed: ${error.code ?? error.signal}; ${stderr || stdout || error.message}`)); return; }
      if (raw) { resolve(stdout.trim()); return; }
      try {
        const value = JSON.parse(stdout);
        records.push({ args: invocation, value });
        if (Array.isArray(value)) assert.ok(value.every(item => item.success), JSON.stringify(value));
        else assert.equal(value.success, true, JSON.stringify(value));
        resolve(value);
      } catch (error) { reject(error); }
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
  });
}
async function native(argv, options) { return (await command(argv, options)).data; }
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function closeOwned(name) {
  if (!(await native(['session', 'info'], { sessionName: name })).active) { sessions.delete(name); return; }
  await native(['close'], { sessionName: name });
  // A successful close is acknowledged before the daemon's final exit on some builds.
  for (let i = 0; i < 40; i++) {
    if (!(await native(['session', 'info'], { sessionName: name })).active) { sessions.delete(name); return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Owned session ${name} shutdown was not confirmed.`);
}
try {
  report.agentBrowser = await command(['--version'], { raw: true });
  const version = await promisify(execFile)(browser, ['--version'], { env, timeout: 5000, maxBuffer: 4096 });
  report.browserVersion = version.stdout.trim();
  session = await command(['session', 'id', '--scope', 'cwd', '--prefix', 'bu-q'], { raw: true });
  assert.ok(session && !session.includes('\n'));
  report.session = session;
  fixture = await startFixture();
  await check('native-named-session', async () => {
    assert.equal((await native(['session', 'info'])).active, false);
    sessions.add(session);
    await native([...(report.headed ? ['--headed'] : []), 'open', fixture.url]);
    const info = await native(['session', 'info']);
    assert.equal(info.runtime.restoreStatus, 'not_configured');
    assert.equal(info.runtime.browserLaunched, true);
    report.daemonPid = info.pid;
    report.launch = info.runtime.effectiveLaunch;
    const userAgent = await native(['eval', '--stdin'], { input: 'navigator.userAgent' });
    assert.equal(JSON.stringify(userAgent).includes('HeadlessChrome/'), !report.headed);
    report.interfaceModeEvidence = userAgent.result;
  });
  await check('rendered-content-and-spinner-wait', async () => {
    await native(['open', fixture.url]);
    await native(['wait', '#spinner', '--state', 'hidden']);
    await native(['wait', '--text', 'Monthly quota']);
    await native(['wait', '#email']);
    await native(['wait', '--url', fixture.url + '/*']);
    assert.match((await native(['get', 'text', '#ready'])).text, /150.*8/u);
    assert.equal((await native(['get', 'url'])).url, fixture.url + '/');
    assert.equal((await native(['get', 'title'])).title, 'Browser Use Fixture');
    const rendered = await native(['read']);
    assert.match(JSON.stringify(rendered), /Monthly quota/u);
  });
  await check('on-demand-content-boundaries-and-max-output', async () => {
    const boundaryFlags = ['--content-boundaries', '--max-output', String(maxOutput)];
    const short = await command([...boundaryFlags, 'read']);
    assert.equal(short._boundary.origin, fixture.url + '/');
    assert.ok(short._boundary.nonce);
    await native(['open', fixture.url + '/output-limit']);
    const json = await command([...boundaryFlags, 'read']);
    const bounded = await command([...boundaryFlags, 'read'], { raw: true });
    assert.match(bounded, /^--- AGENT_BROWSER_PAGE_CONTENT nonce=/u);
    assert.match(bounded, /--- END_AGENT_BROWSER_PAGE_CONTENT nonce=/u);
    assert.doesNotMatch(bounded, /END-OF-LONG-PAGE/u);
    const notice = bounded.lastIndexOf('\n[truncated: showing ');
    assert.ok(notice > 0);
    const contentCharacters = bounded.slice(bounded.indexOf('\n') + 1, notice).length;
    assert.equal(contentCharacters, maxOutput);
    report.nativeOutput = { configuredLimit: maxOutput, textContentCharacters: contentCharacters,
      textOutputCharacters: bounded.length, jsonContentCharacters: json.data.content.length,
      jsonReadTruncated: json.data.truncated, boundaryOrigin: json._boundary.origin };
    if (json.data.content.length > maxOutput) report.limitations.push(
      'The native text output limit does not bound --json read in this run; use scoped reads or authorized local filtering.');
    await native(['open', fixture.url]);
  });
  await check('multi-viewport-media-styles-and-temp-screenshot', async () => {
    await native(['set', 'viewport', '1440', '900']);
    const lightStyles = JSON.stringify(await native(['get', 'styles', 'body']));
    const desktop = await native(['screenshot']);
    assert.ok(desktop.path && !path.resolve(desktop.path).startsWith(path.resolve(cwd) + path.sep));
    tempArtifacts.push(desktop.path);
    const desktopBytes = await readFile(desktop.path);
    assert.deepEqual([...desktopBytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
    const desktopWidth = desktopBytes.readUInt32BE(16);
    await native(['set', 'viewport', '390', '844']);
    await native(['set', 'media', 'dark']);
    const mobile = await native(['screenshot']);
    assert.ok(mobile.path && !path.resolve(mobile.path).startsWith(path.resolve(cwd) + path.sep));
    tempArtifacts.push(mobile.path);
    const mobileBytes = await readFile(mobile.path);
    assert.deepEqual([...mobileBytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
    const mobileWidth = mobileBytes.readUInt32BE(16);
    assert.ok(desktopWidth > mobileWidth, `expected desktop width (${desktopWidth}) > mobile width (${mobileWidth})`);
    const box = await native(['get', 'box', '#send']);
    assert.ok(box.width > 0 && box.height > 0);
    const darkStyles = JSON.stringify(await native(['get', 'styles', 'body']));
    assert.notEqual(darkStyles, lightStyles);
    assert.match(darkStyles, /rgb\(245,\s*245,\s*245\)|rgb\(17,\s*17,\s*17\)/u);
    assert.deepEqual(await readdir(cwd), []);
    await native(['set', 'media', 'light']);
    await native(['set', 'viewport', '1280', '800']);
  });
  await check('snapshot-fill-select-without-submit', async () => {
    const snapshot = await native(['snapshot', '-i', '-s', 'main']);
    const entry = Object.entries(snapshot.refs).find(([, node]) => node.role === 'textbox' && node.name.trim() === 'Name');
    assert.ok(entry);
    await native(['fill', '@' + entry[0], 'Lin']);
    await native(['fill', '#email', 'lin@example.test']);
    await native(['select', '#plan', 'yearly']);
    assert.equal((await native(['get', 'value', '#email'])).value, 'lin@example.test');
    assert.equal((await native(['get', 'value', '#plan'])).value, 'yearly');
    assert.equal(fixture.state.submissions, 0);
  });
  await check('literal-option-text-and-stable-daemon', async () => {
    await command(['batch', '--bail'], { input: JSON.stringify([['fill', '#name', '--headed']]) });
    assert.equal((await native(['get', 'value', '#name'])).value, '--headed');
    assert.equal((await native(['session', 'info'])).pid, report.daemonPid);
  });
  await check('authorized-submit-and-native-eval-stdin', async () => {
    await native(['hover', '#send']); await native(['scroll', 'down', '100']);
    await native(['press', 'Tab']); await native(['click', '#send']);
    await native(['wait', '--text', 'ORDER-1042']);
    assert.equal(fixture.state.submissions, 1);
    const result = await native(['eval', '--stdin'], { input: 'document.querySelector("#result").textContent' });
    assert.match(JSON.stringify(result), /ORDER-1042/u);
  });
  await check('network-filter-errors-and-route-mock', async () => {
    await native(['click', '#query']); await native(['wait', '--text', 'Search unavailable']);
    const list = await native(['network', 'requests', '--type', 'xhr,fetch', '--status', '400-599']);
    const request = list.requests.find(item => item.url.includes('/api/search'));
    assert.ok(request); assert.equal(request.status, 500);
    const detail = await native(['network', 'request', request.requestId]);
    assert.equal(detail.status, 500);
    report.responseBodyCaptured = typeof detail.responseBody === 'string';
    assert.ok((await native(['console'])).messages.length);
    assert.ok((await native(['errors'])).errors.length);
    await native(['console', '--clear']);
    assert.equal((await native(['console'])).messages.length, 0);
    await native(['network', 'route', '**/api/orders', '--body', '{"error":"SERVICE_DOWN"}']);
    await native(['click', '#orders-btn']);
    await native(['wait', '--text', 'Fallback notice: SERVICE_DOWN']);
    await native(['network', 'unroute', '**/api/orders']);
  });
  await check('tabs-and-autosave-observation', async () => {
    const first = (await native(['tab', 'list'])).tabs.find(tab => tab.active).tabId;
    await native(['tab', 'new', fixture.url + '/second']);
    const second = (await native(['tab', 'list'])).tabs.find(tab => tab.active).tabId;
    assert.notEqual(first, second);
    assert.match((await native(['get', 'text', '#result'])).text, /20 projects/u);
    await native(['tab', first]); await native(['tab', 'close', second]);
    await native(['open', fixture.url + '/autosave']);
    await native(['fill', '#autosave', 'draft']);
    await native(['get', 'value', '#autosave']);
    assert.ok(fixture.state.autosaves > 0);
    await native(['click', '#rerender']);
    assert.match((await native(['snapshot', '-i'])).snapshot, /Send replaced demo/u);
  });
  await check('closing-owned-other-session-preserves-current', async () => {
    const other = session + '-other'; sessions.add(other);
    await native(['open', fixture.url + '/second'], { sessionName: other });
    await closeOwned(other);
    assert.equal((await native(['session', 'info'])).runtime.browserLaunched, true);
  });
  await check('explicit-path-png-and-private-output-directory', async () => {
    for (const page of ['covered', 'clear']) {
      await native(['open', fixture.url + '/' + page]);
      const file = path.join(out, page + '.png');
      assert.equal((await native(['screenshot', file])).path, file);
      const bytes = await readFile(file);
      assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
      assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [1280,800]);
      assert.equal((await stat(file)).mode & 0o077, 0);
    }
    assert.equal((await stat(out)).mode & 0o077, 0);
  });
  await check('native-trace', async () => {
    await native(['trace', 'start']); await native(['get', 'text', 'main']);
    const file = path.join(out, 'trace.json');
    assert.equal((await native(['trace', 'stop', file])).path, file);
    assert.ok(JSON.parse(await readFile(file, 'utf8')).traceEvents.length);
  });
  if (args.includes('--online')) await check('public-rendered-page', async () => {
    await native(['open', 'https://example.com']);
    assert.match((await native(['get', 'text', 'body'])).text, /Example Domain/u);
  });
  report.ok = true;
} catch (error) {
  report.ok = false; report.failure = error.message; process.exitCode = 1;
} finally {
  for (const name of [...sessions]) {
    try { await closeOwned(name); checks.push('owned-session-closed:' + name); }
    catch (error) { (report.cleanupFailures ??= []).push(error.message); report.ok = false; process.exitCode = 1; }
  }
  for (const file of tempArtifacts) await rm(file, { force: true }).catch(() => {});
  if (fixture) await fixture.close();
  if (!sessions.size) await rm(root, { recursive: true });
  else report.retainedTemporaryRoot = root;
  await writeFile(path.join(out, 'responses.json'), JSON.stringify(records, null, 2) + '\n');
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
