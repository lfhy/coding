/**
 * 显式 opt-in 的 macOS arm64 打包版冒烟：直接运行独立 Electron .app 中的 Coding，
 * 用独立的 CDP 端口观察真实 Host 页面；不进入 keyless Vitest，不安装应用。
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const bundle = join(root, 'dist/Coding.app')
const executable = join(bundle, 'Contents/MacOS/Coding')
const resources = join(bundle, 'Contents/Resources')
const helperExecutable = join(resources, 'coding-electron-helper')
const expectedVersion = JSON.parse(await readFile(join(root, 'apps/desktop-electron/package.json'), 'utf8')).version
const timeoutMs = 90_000

function deadline(promise, label, ms = timeoutMs) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

async function until(check, label, ms = timeoutMs) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 150))
  }
  throw new Error(`${label} timed out after ${ms}ms`)
}

function command(binary, args) {
  return spawnSync(binary, args, {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin' },
  })
}

async function preflight() {
  assert.equal(process.platform, 'darwin', 'packaged smoke requires macOS')
  assert.equal(process.arch, 'arm64', 'packaged smoke requires native arm64 Node')
  assert.ok(typeof expectedVersion === 'string' && expectedVersion.length > 0,
    'Electron application manifest must define a version')
  for (const path of [executable, helperExecutable, join(resources, 'coding-host'),
    join(resources, 'metadata.json'), join(resources, 'app.asar'), join(resources, 'CodingIcon.png')]) {
    const entry = await lstat(path).catch(() => undefined)
    assert.ok(entry?.isFile(), `missing packaged regular file: ${path}; rebuild dist/Coding.app`)
    if (path === join(resources, 'app.asar')) assert.ok(entry.size > 0, 'packaged app.asar must not be empty')
  }
  const metadata = JSON.parse(await readFile(join(resources, 'metadata.json'), 'utf8'))
  assert.equal(metadata.version, expectedVersion, 'packaged metadata version')
  const plist = join(bundle, 'Contents/Info.plist')
  for (const [key, expected] of [
    ['CFBundleIdentifier', 'com.coding.desktop'],
    ['CFBundleName', 'Coding'],
    ['CFBundleDisplayName', 'Coding'],
    ['CFBundleExecutable', 'Coding'],
    ['CFBundleShortVersionString', expectedVersion],
  ]) {
    const value = command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])
    assert.equal(value.status, 0, `packaged Info.plist must define ${key}`)
    assert.equal(value.stdout.trim(), expected, `packaged Info.plist ${key}`)
  }
  for (const [suffix, identifier] of [
    ['', 'helper'], [' (Renderer)', 'helper.renderer'],
    [' (GPU)', 'helper.gpu'], [' (Plugin)', 'helper.plugin'],
  ]) {
    const helperPlist = join(bundle, 'Contents/Frameworks', `Electron Helper${suffix}.app`, 'Contents/Info.plist')
    const value = command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', helperPlist])
    assert.equal(value.status, 0, `packaged helper Info.plist must define CFBundleIdentifier: ${suffix}`)
    assert.equal(value.stdout.trim(), `com.coding.desktop.${identifier}`, `packaged helper identifier: ${suffix}`)
  }
  if (command('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]).status !== 0) {
    throw new Error('packaged signature failed; rerun the macOS packaging step, then check ' +
      '`codesign --verify --deep --strict dist/Coding.app` including nested helpers; do not disable signature checks')
  }
  for (const path of [executable, helperExecutable, join(resources, 'coding-host')]) {
    const arch = command('/usr/bin/lipo', ['-archs', path])
    assert.equal(arch.status, 0, `could not inspect packaged Mach-O: ${path}`)
    assert.equal(arch.stdout.trim(), 'arm64', `packaged binary must be arm64: ${path}`)
  }
}

async function hostRecord(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (value.type === 'coding-host-ready' && value.protocol === 1 && value.version === expectedVersion &&
      Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.port) &&
      value.port > 0 && value.port <= 65535 && typeof value.token === 'string' && value.token.length > 0) return value
    throw new Error('invalid isolated Host discovery record')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    // JSON 解析异常可能引用原文；固定错误文本，不输出 host.json 中的所有权 token。
    throw new Error('invalid isolated Host discovery record')
  }
}

async function describeHost(origin) {
  const rpcId = randomUUID()
  const response = await fetch(`${origin}/api/host.describe`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'host.describe', payload: {} }),
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(response.status, 200, 'host.describe HTTP status')
  const envelope = await response.json()
  assert.equal(envelope.type, 'server-response')
  assert.equal(envelope.rpcId, rpcId)
  assert.equal(envelope.result?.ok, true, 'host.describe RPC result')
  return envelope.result.value
}

function processCommand(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined
  const result = command('/bin/ps', ['-p', String(pid), '-o', 'stat=', '-o', 'command='])
  if (result.status !== 0) return undefined
  const match = /^\s*(\S+)\s+([\s\S]+?)\s*$/.exec(result.stdout)
  if (!match || match[1].startsWith('Z')) return undefined
  return match[2]
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0) } catch (error) { return error.code !== 'ESRCH' }
  const result = command('/bin/ps', ['-p', String(pid), '-o', 'stat='])
  // ps 失败不证明进程退出；保留测试 HOME。
  return result.status !== 0 || !result.stdout.trim().startsWith('Z')
}

function helperCommand(pid, home, hostHome) {
  const actual = processCommand(pid)
  return actual !== undefined && actual.startsWith(`${helperExecutable} --home ${hostHome} --cwd ${home} `) &&
    actual.includes(`--host-version ${expectedVersion} `) &&
    actual.includes(`--runtime-root ${resources} --exclusive-desktop-instance`)
}

function ownHelperPid(appPid, home, hostHome) {
  const result = command('/bin/ps', ['-axo', 'pid=', '-o', 'ppid=', '-o', 'command='])
  assert.equal(result.status, 0, 'cannot inspect own helper process')
  const matches = result.stdout.split('\n').flatMap(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    return row && Number(row[2]) === appPid && helperCommand(Number(row[1]), home, hostHome)
      ? [Number(row[1])] : []
  })
  assert.equal(matches.length, 1, 'packaged Electron must own one Go helper with isolated arguments')
  return matches[0]
}

async function stopOwnApp(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolveExit => {
      if (child.exitCode !== null || child.signalCode !== null) resolveExit()
      else child.once('exit', resolveExit)
    }),
    new Promise(resolveWait => setTimeout(resolveWait, 10_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await Promise.race([
    new Promise(resolveExit => {
      if (child.exitCode !== null || child.signalCode !== null) resolveExit()
      else child.once('exit', resolveExit)
    }),
    new Promise(resolveWait => setTimeout(resolveWait, 2_000)),
  ])
  return !pidAlive(child.pid)
}

async function stopVerifiedHelper(pid, home, hostHome) {
  if (pid === undefined) return false
  if (!pidAlive(pid)) return true
  if (!helperCommand(pid, home, hostHome)) return false
  try { process.kill(pid, 'SIGTERM') } catch (error) { return error.code === 'ESRCH' }
  try {
    await until(() => !pidAlive(pid), 'isolated helper graceful exit', 5_000)
    return true
  } catch {
    if (!helperCommand(pid, home, hostHome)) return false
    try { process.kill(pid, 'SIGKILL') } catch (error) { return error.code === 'ESRCH' }
    try {
      await until(() => !pidAlive(pid), 'isolated helper forced exit', 2_000)
      return true
    } catch { return false }
  }
}

async function stopVerifiedHost(hostHome, expected) {
  if (expected === undefined) return false
  const current = await hostRecord(join(hostHome, 'host.json'))
  if (!pidAlive(expected.pid)) return current === undefined ||
    (current.pid === expected.pid && current.port === expected.port && current.token === expected.token)
  if (current?.pid !== expected.pid || current.port !== expected.port || current.token !== expected.token) return false
  try {
    const response = await describeHost(`http://127.0.0.1:${expected.port}`)
    if (response.managedHostToken !== expected.token) return false
  } catch { return false }
  // PID、隔离记录与在线 RPC 三重一致后才终止测试 Host；不按端口或名称盲杀。
  try { process.kill(expected.pid, 'SIGTERM') } catch (error) { return error.code === 'ESRCH' }
  try {
    await until(() => !pidAlive(expected.pid), 'isolated Host graceful exit', 10_000)
    return true
  } catch { return false }
}

async function secondLaunch(env) {
  const child = spawn(executable, [], { cwd: root, env, stdio: 'ignore' })
  try {
    const code = await deadline(new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', (status, signal) => signal === null
        ? resolveExit(status) : reject(new Error(`second packaged Electron exited on ${signal}`)))
    }), 'second packaged Electron instance', 15_000)
    assert.equal(code, 0, 'second instance should activate the original and exit')
  } finally {
    if (child.exitCode === null && child.signalCode === null) await stopOwnApp(child)
  }
}

function launchOwnApp(env) {
  const child = spawn(executable, ['--inspect=0', '--remote-debugging-port=0'], {
    cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  let endpoint
  let inspector
  // stderr 只用于发现 CDP endpoint；绝不输出原文（可能包含授权信息）。
  child.stderr.on('data', bytes => {
    stderr = (stderr + bytes.toString()).slice(-4096)
    const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/.exec(stderr)
    if (match) endpoint = match[1]
    const nodeMatch = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[\w-]+)/.exec(stderr)
    if (nodeMatch) inspector = nodeMatch[1]
  })
  child.stderr.on('error', () => {})
  return { child, endpoint: () => endpoint, inspector: () => inspector }
}

async function inspectPackagedMain(url) {
  const socket = new WebSocket(url)
  try {
    await deadline(new Promise((resolveOpen, reject) => {
      socket.addEventListener('open', resolveOpen, { once: true })
      socket.addEventListener('error', () => reject(new Error('Node inspector connection failed')), { once: true })
    }), 'Node inspector connection', 5_000)
    // 只读求值应用身份；不访问环境、Host token、文件或凭据。
    const expression = `(() => {
      const app = process.getBuiltinModule('module').createRequire(process.execPath)('electron').app;
      return { packaged: app.isPackaged, appName: app.getName(),
        appPathIsAsar: app.getAppPath() === process.resourcesPath + '/app.asar' };
    })()`
    const identity = await deadline(new Promise((resolveValue, reject) => {
      socket.addEventListener('message', event => {
        let reply
        try { reply = JSON.parse(event.data) } catch { reject(new Error('invalid Node inspector response')); return }
        if (reply.id !== 1) return
        if (reply.error || reply.result?.exceptionDetails) {
          reject(new Error('packaged main-process identity evaluation failed'))
          return
        }
        resolveValue(reply.result?.result?.value)
      })
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
        params: { expression, returnByValue: true } }))
    }), 'packaged main-process identity', 5_000)
    assert.deepEqual(identity, { packaged: true, appName: 'Coding', appPathIsAsar: true },
      'Electron main must report Coding, app.isPackaged and load Resources/app.asar')
  } finally {
    socket.close()
  }
}

async function findPage(browser, origin) {
  let page
  await until(() => {
    page = browser.contexts().flatMap(context => context.pages())
      .find(candidate => !candidate.isClosed() && candidate.url() === `${origin}/`)
    return page !== undefined
  }, 'packaged Host renderer')
  return page
}

async function verifyWebSockets(page, origin) {
  const states = await page.evaluate(async hostOrigin => Promise.all(['events.mux', 'events.host'].map(path =>
    new Promise((resolveOpen, reject) => {
      const socket = new WebSocket(`${hostOrigin.replace(/^http/, 'ws')}/api/${path}`)
      const timer = setTimeout(() => { socket.close(); reject(new Error(`${path} timed out`)) }, 10_000)
      socket.onopen = () => { clearTimeout(timer); const state = socket.readyState; socket.close(); resolveOpen({ path, state }) }
      socket.onerror = () => { clearTimeout(timer); reject(new Error(`${path} WebSocket failed`)) }
    }))), origin)
  assert.deepEqual(states, [{ path: 'events.mux', state: 1 }, { path: 'events.host', state: 1 }])
}

async function verifyRemoteBridge(page) {
  const bridge = await page.evaluate(() => {
    const native = window.codingDesktop
    return {
      keys: native && Object.keys(native),
      methods: native?.remoteSSH && Object.keys(native.remoteSSH),
      node: typeof window.require,
      ipc: typeof native?.remoteSSH?.ipcRenderer,
    }
  })
  assert.deepEqual(bridge.keys, ['remoteSSH'], 'packaged sandbox preload must be present')
  assert.deepEqual(bridge.methods, [
    'connect', 'cancelConnect', 'listDirectories', 'selectDirectory', 'close', 'rejectHostKey', 'subscribeProgress',
  ])
  assert.equal(bridge.node, 'undefined')
  assert.equal(bridge.ipc, 'undefined')
  // 随机且不存在的 attempt ID：只走本地 bridge/helper，不联系 SSH 主机或读取密钥。
  const result = await page.evaluate(async attemptId => {
    const dispose = window.codingDesktop.remoteSSH.subscribeProgress(() => {})
    try { return await window.codingDesktop.remoteSSH.cancelConnect(attemptId) }
    finally { dispose() }
  }, `smoke-${randomUUID()}`)
  assert.deepEqual(result, {}, 'Remote-SSH preload call must reach the live Go helper')
}

async function main() {
  await preflight()
  const isolated = await mkdtemp(join(tmpdir(), 'dsh-electron-packaged-'))
  const home = join(isolated, 'home')
  const tmp = join(isolated, 'tmp')
  const hostHome = join(home, '.dsh')
  const userData = join(home, '.dsh-electron-user-data')
  const instanceSocket = join(tmp, 'coding-instance.sock')
  let child
  let browser
  let record
  let helperPid
  let passed = false
  try {
    await Promise.all([home, tmp].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
    // 白名单而非继承：不传用户凭据、代理、SSH agent、Node 注入或真实 DSH_HOME。
    const env = {
      PATH: '/usr/bin:/bin:/usr/sbin', HOME: home, TMPDIR: tmp,
      USER: process.env.USER ?? '', LOGNAME: process.env.LOGNAME ?? '', LANG: 'en_US.UTF-8',
    }
    const launched = launchOwnApp(env)
    child = launched.child
    await deadline(new Promise((resolveReady, reject) => {
      const timer = setInterval(() => {
        if (launched.endpoint() && launched.inspector()) { clearInterval(timer); resolveReady() }
      }, 100)
      child.once('error', () => { clearInterval(timer); reject(new Error('packaged Electron executable failed to start')) })
      child.once('exit', () => { clearInterval(timer); reject(new Error('packaged Electron exited before CDP became ready')) })
    }), 'packaged Electron CDP readiness')
    try {
      browser = await chromium.connectOverCDP(launched.endpoint(), { timeout: 15_000 })
    } catch {
      throw new Error('CDP endpoint announced but handshake failed; check for an Electron startup dialog ' +
        'before isolated userData and Host readiness')
    }
    await until(async () => { record = await hostRecord(join(hostHome, 'host.json')); return record !== undefined },
      'isolated packaged Host discovery record')
    const origin = `http://127.0.0.1:${record.port}`
    const page = await findPage(browser, origin)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.locator('[data-shell-overlay]').waitFor({ state: 'attached', timeout: timeoutMs })
    const body = (await page.locator('body').innerText()).trim()
    assert.ok(body.length > 20, 'packaged Host page must not be blank')
    assert.ok(!/vite.*error|internal server error/i.test(body), 'packaged Host page must not show build errors')
    assert.equal(errors.length, 0, 'packaged renderer must not report runtime errors')
    assert.equal(existsSync(userData), true, 'packaged Electron userData must be inside isolated HOME')
    assert.equal((await lstat(instanceSocket)).isSocket(), true, 'Go installed desktop lock must use isolated TMPDIR')
    helperPid = ownHelperPid(child.pid, home, hostHome)

    const described = await describeHost(origin)
    assert.equal(described.version, expectedVersion, 'Host version must match packaged metadata')
    assert.equal(described.home, home, 'Host must see test HOME')
    assert.equal(described.cwd, await realpath(home), 'packaged Host workspace must be test HOME')
    assert.ok(described.managedHostToken === record.token, 'Host must own isolated discovery record')
    await inspectPackagedMain(launched.inspector())
    await verifyWebSockets(page, origin)
    await verifyRemoteBridge(page)
    await secondLaunch(env)
    assert.equal(helperCommand(helperPid, home, hostHome), true, 'second instance must retain original helper')
    const retained = await hostRecord(join(hostHome, 'host.json'))
    assert.ok(retained?.pid === record.pid && retained.port === record.port && retained.token === record.token,
      'second instance must retain original Host')
    assert.ok((await describeHost(origin)).managedHostToken === record.token,
      'second instance must retain original Host ownership')
    assert.equal(page.url(), `${origin}/`, 'second instance must retain original Host page')
    assert.equal(errors.length, 0, 'renderer must remain healthy after second instance')
    passed = true
  } finally {
    // CDP 只能观察 renderer；不能假装它证明了 app.isPackaged、Tray 或原生菜单动作。
    if (browser !== undefined) await browser.close().catch(() => undefined)
    const appStopped = child === undefined ? true : await stopOwnApp(child).catch(() => false)
    const helperStopped = child === undefined ? true : helperPid === undefined ? false :
      await stopVerifiedHelper(helperPid, home, hostHome).catch(() => false)
    const hostStopped = child === undefined ? true : await stopVerifiedHost(hostHome, record).catch(() => false)
    const socketStopped = !existsSync(instanceSocket)
    if (appStopped && helperStopped && hostStopped && socketStopped) {
      await rm(isolated, { recursive: true, force: true })
    } else {
      console.warn(`Isolated test HOME preserved because process ownership/lifecycle is uncertain: ${isolated}`)
    }
    if (passed) {
      assert.ok(appStopped && helperStopped && hostStopped && socketStopped,
        'packaged Electron/helper/Host and isolated desktop lock must all stop')
      console.log('PASS: signed macOS arm64 app.asar, app.isPackaged, metadata/Host version, real Host page, both WebSockets, ' +
        'single instance, sandbox preload, Go helper/bridge, isolated desktop lock and cleanup')
      console.log('Not inspected by CDP/Node inspector: native menu/Tray and macOS window close/hide; ' +
        'verify those in a native UI session.')
    }
  }
}

main().catch(error => {
  // 不输出 helper 原始 stderr、host.json、授权 token、进程环境或用户凭据。
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
