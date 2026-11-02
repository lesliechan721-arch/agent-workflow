import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const checkTimeoutMs = 10_000

export const WINDOWS_PLUGIN_JOB_REQUIRED_CHECKS = [
  'plugin-stdio-argv-environment-exit-code',
  'plugin-fast-success',
  'plugin-successful-root-child-cleanup',
  'plugin-nested-child-cleanup',
  'plugin-forced-helper-exit-cleanup',
  'plugin-explicit-stop-cleanup',
  'plugin-parent-crash-cleanup',
  'plugin-name-collision',
  'plugin-ready-failure-no-resume',
]

export function captureQualificationHelper(child) {
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('helperCloseTimeout'))
    }, checkTimeoutMs)
    child.once('error', () => {
      clearTimeout(timer)
      reject(new Error('helperStartFailed'))
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
  // Startup and PID-record waits can precede awaiting close.
  closed.catch(() => {})
  return { child, closed, output: () => ({ stdout, stderr }) }
}

function nativeOperation(helperPath, operation, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(helperPath, ['--operation'], {
      windowsHide: true, timeout: checkTimeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
    }, (error, stdout) => {
      if (error) { reject(new Error('pluginNativeOperationFailed')); return }
      try {
        const response = JSON.parse(stdout)
        if (!response || response.schemaVersion !== 1 || Object.keys(response).sort().join(',') !== 'result,schemaVersion') throw new Error()
        resolve(response.result)
      } catch { reject(new Error('pluginNativeResponseInvalid')) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ schemaVersion: 1, operation, input }))
  })
}

async function currentUserSID() {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR
  if (!root || !path.isAbsolute(root)) throw new Error('windowsSystemRootRequired')
  return new Promise((resolve, reject) => {
    execFile(path.join(root, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      windowsHide: true, timeout: checkTimeoutMs, maxBuffer: 64 * 1024, encoding: 'utf8',
    }, (error, stdout) => {
      const sid = /"(S-1-\d+(?:-\d+)+)"/u.exec(stdout ?? '')?.[1]
      if (error || !sid) reject(new Error('qualificationUserIdentityFailed'))
      else resolve(sid)
    })
  })
}

async function absent(target) {
  try { await readFile(target); return false }
  catch (error) { if (error.code === 'ENOENT') return true; throw error }
}

async function waitForReady(started) {
  const deadline = Date.now() + checkTimeoutMs
  while (Date.now() < deadline) {
    try {
      const ready = JSON.parse(await readFile(started.status, 'utf8'))
      if (ready?.ready !== true || !Number.isInteger(ready.pid) || ready.pid <= 0) throw new Error('pluginReadyInvalid')
      if (!await absent(started.configuration)) throw new Error('pluginConfigNotRemoved')
      return ready
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    if (started.child.exitCode !== null || started.child.signalCode !== null) throw new Error('pluginExitedBeforeReady')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('pluginReadyTimeout')
}

async function createPluginHarness(tempRoot, options) {
  const sid = await currentUserSID()
  const launches = new Set()
  const helperPath = options.helperPath
  async function protect(target, kind) {
    if (await nativeOperation(helperPath, 'aclProtect', { resources: [{ target, kind, sid }] }) !== true) {
      throw new Error('pluginQualificationProtectionFailed')
    }
  }
  await protect(tempRoot, 'directory')
  async function prepare(executable, args, extra = {}) {
    const directory = await mkdtemp(path.join(tempRoot, 'plugin-'))
    await protect(directory, 'directory')
    const configuration = path.join(directory, 'launch.json')
    const status = extra.status ?? path.join(directory, 'ready.json')
    const scope = { kind: 'windows-job', name: extra.name ?? `Local\\aw-subagent-${randomBytes(16).toString('hex')}`, sid }
    await writeFile(configuration, JSON.stringify({ schemaVersion: 1, executable, args, parentPid: extra.parentPid ?? process.pid, name: scope.name, status, sid }), { flag: 'wx' })
    await protect(configuration, 'file')
    return { directory, configuration, status, scope }
  }
  async function startHelper(executable, args, extra = {}) {
    const launch = await prepare(executable, args, extra)
    const started = Object.assign(captureQualificationHelper(spawn(helperPath, ['--plugin-config', launch.configuration], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: extra.env ?? options.env ?? process.env, ...(extra.cwd ? { cwd: extra.cwd } : {}),
    })), launch)
    launches.add(started)
    if (extra.expectReady !== false) {
      try { started.ready = await waitForReady(started) }
      catch (error) { started.child.kill('SIGKILL'); await started.closed.catch(() => {}); throw error }
    }
    return started
  }
  async function members(scope, stop = false) {
    const result = await nativeOperation(helperPath, stop ? 'jobStop' : 'jobObserve', scope)
    if (!Array.isArray(result) || result.some((pid) => !Number.isInteger(pid) || pid <= 0 || pid > 0xffff_ffff) || stop && result.length) {
      throw new Error('pluginJobMembersInvalid')
    }
    return result
  }
  async function dispose() {
    const pending = [...launches].filter(({ child }) => child.exitCode === null && child.signalCode === null)
    for (const started of pending) started.child.kill('SIGKILL')
    await Promise.all(pending.map(({ closed }) => closed.catch(() => {})))
  }
  return { prepare, startHelper, members, dispose }
}

async function checkPluginStdioAndEnvironment(harness, options) {
  const args = ['', 'space value', 'quote"value', 'trailing\\', '斜线\\引号"']
  for (const present of [true, false]) {
    const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter(([name]) => !/^(?:Win)?PSModulePath$/iu.test(name)))
    if (present) { env.PSModulePath = 'qualification-original-module-path'; env.WinPSModulePath = 'qualification-original-win-module-path' }
    const expected = { args, cwd: process.cwd(), paths: present ? { PSModulePath: env.PSModulePath, WinPSModulePath: env.WinPSModulePath } : {} }
    const script = [
      "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);",
      "process.stdin.on('end',()=>{const paths=Object.fromEntries(Object.entries(process.env).filter(([name])=>/^(?:Win)?PSModulePath$/i.test(name)));",
      "process.stdout.write(JSON.stringify({input,args:process.argv.slice(1),cwd:process.cwd(),paths}));process.stderr.write('err:plugin');process.exitCode=7;});",
    ].join('')
    const started = await harness.startHelper(process.execPath, ['-e', script, '--', ...args], { env })
    started.child.stdin.end('plugin-input')
    const close = await started.closed
    const output = started.output()
    let result
    try { result = JSON.parse(output.stdout) } catch { throw new Error('pluginStdioInvalid') }
    if (close.code !== 7 || close.signal !== null || output.stderr !== 'err:plugin' || JSON.stringify(result) !== JSON.stringify({ input: 'plugin-input', ...expected })) {
      throw new Error('pluginStdioArgvEnvironmentMismatch')
    }
  }
}

async function checkPluginStop(harness, common) {
  const started = await harness.startHelper(process.execPath, ['-e', common.managedCleanupFixture(path.join(common.tempRoot, 'plugin-stop-pids.txt'))])
  const pids = await common.waitForRecordedPids(path.join(common.tempRoot, 'plugin-stop-pids.txt'))
  const members = await harness.members(started.scope)
  if (!pids.every((pid) => members.includes(pid))) throw new Error('pluginJobObservationMissedDescendant')
  await harness.members(started.scope, true)
  await Promise.all(pids.map(common.waitForProcessExit))
  const close = await started.closed
  if (close.code !== 250 || (await harness.members(started.scope)).length) throw new Error('pluginStopNotConfirmed')
}

async function checkPluginNameCollision(harness, common) {
  const first = await harness.startHelper(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
  try {
    const marker = path.join(first.directory, 'collision-resumed.txt')
    const second = await harness.startHelper(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'resumed')`], { name: first.scope.name, expectReady: false })
    const close = await second.closed
    if (close.code !== 250 || !await absent(marker) || !await absent(second.status)) throw new Error('pluginNameCollisionAccepted')
    const members = await harness.members(first.scope)
    if (!members.includes(first.ready.pid)) throw new Error('pluginNameCollisionChangedExistingJob')
  } finally {
    await harness.members(first.scope, true)
    await first.closed
    await common.waitForProcessExit(first.ready.pid)
  }
}

export async function checkPluginReadyFailure(tempRoot, { startHelper, members }) {
  const sentinel = path.join(tempRoot, 'ready-existing.json')
  const marker = path.join(tempRoot, 'ready-failure-resumed.txt')
  await writeFile(sentinel, 'preserve-existing-ready', { flag: 'wx' })
  const started = await startHelper(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'resumed')`], { status: sentinel, expectReady: false })
  const close = await started.closed
  if (close.code !== 250 || !await absent(marker) || (await readFile(sentinel, 'utf8')) !== 'preserve-existing-ready' || (await members(started.scope)).length) {
    throw new Error('pluginReadyFailureResumedOrChangedExistingFile')
  }
}

async function checkPluginParentCrash(harness, common, helperPath) {
  const pidPath = path.join(common.tempRoot, 'plugin-parent-crash-pids.txt')
  const controller = spawn(process.execPath, ['-e', [
    "const {spawn}=require('node:child_process');const {access}=require('node:fs/promises');",
    "process.once('message',async({helperPath,configuration,pidPath})=>{const child=spawn(helperPath,['--plugin-config',configuration],{stdio:'ignore',windowsHide:true});",
    "child.on('error',()=>process.exit(1));process.send(child.pid);",
    "for(let i=0;i<500;i++){try{await access(pidPath);process.exit(0)}catch{await new Promise(resolve=>setTimeout(resolve,10))}}process.exit(1)});",
  ].join('')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
  const captured = captureQualificationHelper(controller)
  let helperPid
  controller.once('message', (pid) => { helperPid = pid })
  try {
    const launch = await harness.prepare(process.execPath, ['-e', common.managedCleanupFixture(pidPath)], { parentPid: controller.pid })
    controller.send({ helperPath, configuration: launch.configuration, pidPath })
    const close = await captured.closed
    if (close.code !== 0 || !Number.isInteger(helperPid) || helperPid <= 0) throw new Error('pluginParentCrashControllerFailed')
    const pids = await common.waitForRecordedPids(pidPath)
    await Promise.all([...pids, helperPid].map(common.waitForProcessExit))
    if ((await harness.members(launch.scope)).length) throw new Error('pluginParentCrashJobNotEmpty')
  } finally {
    if (controller.exitCode === null && controller.signalCode === null) controller.kill('SIGKILL')
    await captured.closed.catch(() => {})
  }
}

export function createWindowsPluginJobChecks(tempRoot, options, common) {
  let harness
  const getHarness = () => harness ??= createPluginHarness(tempRoot, options)
  const shared = { ...common, tempRoot }
  const checks = [
    () => getHarness().then((h) => checkPluginStdioAndEnvironment(h, options)),
    () => getHarness().then((h) => common.checkFastSuccess({ ...options, startHelper: h.startHelper })),
    () => getHarness().then((h) => common.checkSuccessfulRootCleansChild({ ...options, startHelper: h.startHelper })),
    () => getHarness().then((h) => common.checkNestedChildCleanup({ ...options, startHelper: h.startHelper })),
    () => getHarness().then((h) => common.checkForcedHelperExit({ ...options, startHelper: h.startHelper })),
    () => getHarness().then((h) => checkPluginStop(h, shared)),
    () => getHarness().then((h) => checkPluginParentCrash(h, shared, options.helperPath)),
    () => getHarness().then((h) => checkPluginNameCollision(h, shared)),
    () => getHarness().then((h) => checkPluginReadyFailure(tempRoot, h)),
  ]
  return {
    checks: WINDOWS_PLUGIN_JOB_REQUIRED_CHECKS.map((id, index) => [id, checks[index]]),
    async dispose() { if (harness) await (await harness.catch(() => null))?.dispose() },
  }
}
