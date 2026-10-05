/**
 * 显式 opt-in 的 macOS arm64 打包版冒烟：直接运行独立 Electron .app 中的 Coding，
 * 通过 Electron 测试通道观察主进程和真实 Host 页面；不进入 keyless Vitest，不安装应用。
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const bundle = join(root, 'dist/Coding.app')
const executable = join(bundle, 'Contents/MacOS/Coding')
const resources = join(bundle, 'Contents/Resources')
const helperExecutable = join(resources, 'coding-electron-helper')
const browserRoot = join(resources, 'playwright-browsers')
const shellExecutable = join(browserRoot, 'chromium_headless_shell-1228',
  'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
const packagedPlaywright = join(resources, 'runtime', 'node_modules', 'playwright', 'index.mjs')
const packagedBrowserProvider = join(resources, 'runtime', 'node_modules',
  '@deepseek-ai', 'dsh-browser-playwright', 'lib', 'index.js')
const packagedElectronBrowser = join(resources, 'runtime', 'node_modules',
  '@deepseek-ai', 'dsh-browser-electron')
const packagedElectronProtocol = join(packagedElectronBrowser, 'lib', 'types', 'protocol.js')
const packagedBrowserTransport = join(resources, 'runtime', 'node_modules', 'ws', 'index.js')
const packagedCordis = join(resources, 'runtime', 'node_modules', '@deepseek-ai/cordis', 'lib', 'index.js')
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
    join(resources, 'metadata.json'), join(resources, 'app.asar'), join(resources, 'CodingIcon.png'),
    shellExecutable, packagedPlaywright, packagedBrowserProvider, packagedCordis,
    join(packagedElectronBrowser, 'package.json'), join(packagedElectronBrowser, 'lib', 'index.js'),
    packagedElectronProtocol, packagedBrowserTransport]) {
    const entry = await lstat(path).catch(() => undefined)
    assert.ok(entry?.isFile(), `missing packaged regular file: ${path}; rebuild dist/Coding.app`)
    if (path === join(resources, 'app.asar')) assert.ok(entry.size > 0, 'packaged app.asar must not be empty')
  }
  const providerManifest = JSON.parse(await readFile(join(packagedElectronBrowser, 'package.json'), 'utf8'))
  assert.equal(providerManifest.name, '@deepseek-ai/dsh-browser-electron', 'packaged native browser provider')
  assert.equal(providerManifest.exports?.['./protocol']?.default, './lib/types/protocol.js',
    'packaged main-process browser bridge must resolve the shipped protocol')
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
  for (const path of [executable, helperExecutable, join(resources, 'coding-host'), shellExecutable]) {
    const arch = command('/usr/bin/lipo', ['-archs', path])
    assert.equal(arch.status, 0, `could not inspect packaged Mach-O: ${path}`)
    assert.equal(arch.stdout.trim(), 'arm64', `packaged binary must be arm64: ${path}`)
  }
}

async function verifyBundledBrowser(home, tmp) {
  // 验证打包的 Provider 真实执行，不冒充 Host 的工具审批或模型轮次。
  let handshakes = 0
  const sockets = new Set()
  const fixture = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<title>bundled-browser</title><h1>local browser page</h1>' +
      '<button id="go" onclick="document.querySelector(\'h1\').textContent=\'Clicked\'">Open</button>' +
      '<output>Socket waiting</output><script>const socket = new WebSocket("ws://" + location.host + "/socket");' +
      'socket.onmessage = event => { document.querySelector("output").textContent = event.data; socket.close() };</script>')
  })
  fixture.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    if (req.url !== '/socket' || typeof key !== 'string') { socket.destroy(); return }
    handshakes++
    sockets.add(socket)
    socket.on('error', () => { socket.destroy() })
    socket.on('close', () => { sockets.delete(socket) })
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const message = Buffer.from('Packaged localhost WebSocket delivered')
    // 本地 fixture 只发送一条短文本帧，并响应浏览器关闭帧。
    socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]))
    socket.on('data', () => { socket.end(Buffer.from([0x88, 0])) })
  })
  await new Promise((resolveListen, reject) => {
    fixture.once('error', reject)
    fixture.listen(0, '127.0.0.1', resolveListen)
  })
  const address = fixture.address()
  assert.ok(address && typeof address !== 'string', 'loopback fixture must bind a TCP port')
  const origin = `http://localhost:${address.port}`
  // 子进程只接触包内 Provider、Playwright 和浏览器；隔离 HOME 无用户级缓存。
  const script = `
    import assert from 'node:assert/strict';
    const { Context } = await import(process.argv[1]);
    const { default: Provider } = await import(process.argv[2]);
    const origin = process.argv[3];
    const ctx = new Context();
    const signal = new AbortController().signal;
    const session = 'packaged-browser-smoke';
    try {
      const fiber = ctx.plugin(Provider);
      await fiber.await();
      const service = ctx.browserUse;
      assert.ok(service instanceof Provider, 'packaged Cordis service must be the real Provider');
      const first = await service.execute(session, { kind: 'navigate', url: origin + '/' }, signal);
      assert.equal(first.observation.url, origin + '/');
      assert.equal(first.observation.title, 'bundled-browser');
      assert.ok(first.observation.snapshot.includes('local browser page'));
      const websocketDeadline = Date.now() + 10_000;
      let websocketSnapshot = first;
      while (!websocketSnapshot.observation.snapshot.includes('Packaged localhost WebSocket delivered')) {
        assert.ok(Date.now() < websocketDeadline, 'packaged Provider must receive a localhost WebSocket message');
        websocketSnapshot = await service.execute(session, { kind: 'snapshot' }, signal);
      }
      const snapshot = await service.execute(session, { kind: 'snapshot' }, signal);
      assert.ok(snapshot.observation.snapshot.includes('local browser page'));
      const ref = snapshot.observation.snapshot.match(/(e[0-9]+-[a-f0-9-]+) button "Open"/)?.[1];
      assert.ok(ref, 'packaged Provider must expose the observed button ref');
      const clicked = await service.execute(session,
        { kind: 'click', ref, revision: snapshot.observation.revision }, signal);
      assert.ok(clicked.observation.snapshot.includes('Clicked'));
      const screenshot = await service.execute(session, { kind: 'screenshot' }, signal);
      assert.equal(Buffer.from(screenshot.png).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      await service.closeSession(session);
    } finally { await ctx.fiber.dispose(); }
  `
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, packagedCordis,
    packagedBrowserProvider, origin], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'],
    env: { HOME: home, TMPDIR: tmp, PATH: '/usr/bin:/bin:/usr/sbin',
      PLAYWRIGHT_BROWSERS_PATH: browserRoot },
  })
  let failure = ''
  child.stderr.on('data', bytes => { failure = (failure + bytes.toString()).slice(-4096) })
  try {
    const status = await deadline(new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => signal === null ? resolveExit(code)
        : reject(new Error(`bundled Provider exited on ${signal}`)))
    }), 'packaged browser Provider', 45_000)
    assert.equal(status, 0, `packaged Provider must navigate localhost, receive WebSocket output, snapshot, click and screenshot: ${failure}`)
    assert.equal(handshakes, 1, 'packaged default Provider must make one real localhost WebSocket handshake')
    assert.equal(existsSync(join(home, 'Library', 'Caches', 'ms-playwright')), false,
      'packaged browser must not create a user cache')
  } finally {
    if (child.exitCode === null && child.signalCode === null) await stopOwnProcess(child)
    for (const socket of sockets) socket.destroy()
    fixture.closeAllConnections()
    await new Promise(resolveClose => fixture.close(resolveClose))
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

async function stopOwnProcess(child) {
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

async function stopOwnApp(app) {
  const child = app.process()
  try { await deadline(app.close(), 'packaged Electron shutdown', 10_000) }
  catch { /* 仅终止本次测试启动的进程；Host/helper 另行核验所有权。 */ }
  return stopOwnProcess(child)
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
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise(resolveExit => child.once('exit', resolveExit)),
        new Promise(resolveWait => setTimeout(resolveWait, 2_000)),
      ])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }
}

async function inspectPackagedMain(app, guestUrl) {
  // 测试通道只读取应用身份和原生视图，不访问进程环境、Host token 或文件。
  const identity = await app.evaluate(({ app: electronApp, BrowserWindow, WebContentsView }) => ({
    packaged: electronApp.isPackaged,
    appName: electronApp.getName(),
    appPathIsAsar: electronApp.getAppPath() === process.resourcesPath + '/app.asar',
    guests: BrowserWindow.getAllWindows().flatMap(window => window.contentView.children
      .filter(view => view instanceof WebContentsView)
      .map(view => ({ id: view.webContents.id, url: view.webContents.getURL(),
        title: view.webContents.getTitle(), bounds: view.getBounds() }))),
  }))
  assert.equal(identity.packaged, true, 'Electron main must be packaged')
  assert.equal(identity.appName, 'Coding', 'Electron main application name')
  assert.equal(identity.appPathIsAsar, true, 'Electron main must load Resources/app.asar')
  if (guestUrl !== undefined) {
    assert.equal(identity.guests.length, 1, 'packaged browser must own one WebContentsView')
    assert.equal(identity.guests[0].url, guestUrl, 'native guest must hold the Host-controlled page')
    assert.ok(identity.guests[0].id > 0 && identity.guests[0].bounds.width >= 200,
      'native guest must occupy a live viewport')
    return identity.guests[0]
  }
  return identity.guests
}

async function findPage(app, origin) {
  let page
  await until(() => {
    page = app.windows()
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
      browserKeys: native?.browser && Object.keys(native.browser),
      browserAvailable: native?.browser?.available,
      browserPresentType: typeof native?.browser?.present,
      node: typeof window.require,
      ipc: typeof native?.remoteSSH?.ipcRenderer,
      browserIpc: typeof native?.browser?.ipcRenderer,
    }
  })
  assert.deepEqual(bridge.keys, ['remoteSSH', 'browser'], 'packaged sandbox preload must be present')
  assert.deepEqual(bridge.methods, [
    'connect', 'cancelConnect', 'listDirectories', 'selectDirectory', 'close', 'rejectHostKey', 'subscribeProgress',
  ])
  assert.deepEqual(bridge.browserKeys, ['available', 'present'],
    'packaged browser preload must expose only presentation')
  assert.equal(bridge.browserAvailable, true)
  assert.equal(bridge.browserPresentType, 'function')
  assert.equal(bridge.node, 'undefined')
  assert.equal(bridge.ipc, 'undefined')
  assert.equal(bridge.browserIpc, 'undefined')
  // 随机且不存在的 attempt ID：只走本地 bridge/helper，不联系 SSH 主机或读取密钥。
  const result = await page.evaluate(async attemptId => {
    const dispose = window.codingDesktop.remoteSSH.subscribeProgress(() => {})
    try { return await window.codingDesktop.remoteSSH.cancelConnect(attemptId) }
    finally { dispose() }
  }, `smoke-${randomUUID()}`)
  assert.deepEqual(result, {}, 'Remote-SSH preload call must reach the live Go helper')
}

async function browserRpc(page, method, payload) {
  const response = await page.evaluate(async ({ method, payload }) => {
    const rpcId = crypto.randomUUID()
    const result = await fetch(`/api/${method}`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }) })
    return { status: result.status, envelope: await result.json(), rpcId }
  }, { method, payload })
  assert.equal(response.status, 200, `${method} HTTP status`)
  assert.equal(response.envelope.type, 'server-response', `${method} response envelope`)
  assert.equal(response.envelope.rpcId, response.rpcId, `${method} request identity`)
  assert.equal(response.envelope.result?.ok, true,
    `${method} result: ${response.envelope.result?.error?.code ?? 'unknown'}`)
  return response.envelope.result.value
}

async function completeOnboarding(page) {
  const dialog = page.getByRole('dialog', { name: '配置模型，开始使用' })
  await dialog.waitFor({ state: 'visible', timeout: timeoutMs })
  // 仅在隔离 HOME 内保存测试占位值；不使用真实凭据或触发模型请求。
  await dialog.locator('input[type="password"][aria-label="API 密钥"]').fill('packaged-smoke-local-placeholder')
  await dialog.getByRole('button', { name: '保存' }).click()
  const model = dialog.getByRole('combobox', { name: '默认模型' })
  try {
    await until(async () => !await dialog.isVisible() ||
      await model.locator('option').count() > 1 && await model.isEnabled(),
    'packaged onboarding completion or model catalog', 15_000)
  } catch (error) {
    const diagnostics = await dialog.locator('[role="alert"], [role="status"]').allInnerTexts()
    const options = await model.locator('option').allInnerTexts()
    throw new Error(`onboarding did not finish or expose a model: ${JSON.stringify({ diagnostics, options })}`,
      { cause: error })
  }
  if (await dialog.isVisible()) {
    await model.selectOption({ index: 1 })
    await dialog.getByRole('button', { name: '开始使用' }).click()
  }
  await dialog.waitFor({ state: 'hidden', timeout: timeoutMs })
  await until(() => page.locator('#root').evaluate(root => !root.inert),
    'packaged workbench unlocked after onboarding')
}

async function verifyNativeBrowser(page, app) {
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<title>Packaged native fixture</title><button id="human" ' +
      'onclick="document.querySelector(\'output\').textContent=\'Human clicked\'">Click</button>' +
      '<output>Waiting</output>')
  })
  await new Promise((resolveListen, reject) => {
    fixture.once('error', reject)
    fixture.listen(0, '127.0.0.1', resolveListen)
  })
  try {
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string', 'native fixture must bind a loopback port')
    const url = `http://127.0.0.1:${address.port}/`
    await page.getByRole('button', { name: '打开右侧边栏' }).click()
    const menu = page.getByRole('navigation', { name: '工作台功能' })
    await menu.waitFor({ state: 'visible' })
    await menu.getByRole('button', { name: '浏览器' }).click()
    await page.getByTestId('browser-canvas').waitFor({ state: 'visible' })
    const sessions = await browserRpc(page, 'session.list', {})
    assert.equal(sessions.items.length, 1, 'packaged workbench must create one Host Session')
    const sessionId = sessions.items[0].sessionId
    const addressField = page.getByRole('textbox', { name: '网址' })
    await addressField.fill(url)
    await addressField.press('Enter')
    let state
    await until(async () => {
      state = await browserRpc(page, 'browser.control', { sessionId, command: { kind: 'ensure-tab' } })
      return state?.tabs[0]?.url === url
    }, 'packaged Host browser.control on native guest')
    const guest = await inspectPackagedMain(app, url)
    const guestPage = app.context().pages()
      .find(candidate => !candidate.isClosed() && candidate.url() === url)
    assert.ok(guestPage, 'packaged native WebContentsView must expose an interactive Chromium target')
    await guestPage.locator('#human').click()
    await until(async () => await guestPage.locator('output').innerText() === 'Human clicked',
      'packaged native guest human interaction', 10_000)
    assert.equal((await inspectPackagedMain(app, url)).id, guest.id,
      'Host control and human input must retain the same native WebContentsView')
    assert.equal((await browserRpc(page, 'browser.control',
      { sessionId, command: { kind: 'ensure-tab' } })).activeTabId, state.activeTabId,
    'Host must retain the native guest tab after human interaction')
    assert.equal(await browserRpc(page, 'browser.control',
      { sessionId, command: { kind: 'close-tab', tabId: state.activeTabId } }), null,
    'closing the packaged browser tab must release the guest')
    await until(async () => (await inspectPackagedMain(app)).length === 0,
      'packaged native guest teardown', 10_000)
  } finally {
    fixture.closeAllConnections()
    await new Promise(resolveClose => fixture.close(resolveClose))
  }
}

async function main() {
  await preflight()
  const isolated = await mkdtemp(join(tmpdir(), 'dsh-electron-packaged-'))
  const home = join(isolated, 'home')
  const tmp = join(isolated, 'tmp')
  const hostHome = join(home, '.dsh')
  const userData = join(home, '.dsh-electron-user-data')
  const instanceSocket = join(tmp, 'coding-instance.sock')
  let app
  let child
  let record
  let helperPid
  let passed = false
  try {
    await Promise.all([home, tmp].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
    await verifyBundledBrowser(home, tmp)
    // 白名单而非继承：不传用户凭据、代理、SSH agent、Node 注入或真实 DSH_HOME。
    const env = {
      PATH: '/usr/bin:/bin:/usr/sbin', HOME: home, TMPDIR: tmp,
      USER: process.env.USER ?? '', LOGNAME: process.env.LOGNAME ?? '', LANG: 'en_US.UTF-8',
    }
    try {
      app = await _electron.launch({ executablePath: executable, args: [], cwd: root, env, timeout: timeoutMs })
    } catch (error) {
      const timedOut = error instanceof Error && /timed out|timeout/i.test(error.message)
      throw new Error(timedOut
        ? 'signed Coding.app did not establish the Electron test channel before timeout; ' +
          'check whether the graphical session is unlocked and the packaged main process starts'
        : 'signed Coding.app exited or rejected the Electron test channel before readiness; ' +
          'check the packaged main-process startup', { cause: error })
    }
    child = app.process()
    await deadline(app.firstWindow(), 'packaged first Host window')
    await until(async () => { record = await hostRecord(join(hostHome, 'host.json')); return record !== undefined },
      'isolated packaged Host discovery record')
    const origin = `http://127.0.0.1:${record.port}`
    const page = await findPage(app, origin)
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
    await inspectPackagedMain(app)
    await verifyWebSockets(page, origin)
    await verifyRemoteBridge(page)
    await completeOnboarding(page)
    await verifyNativeBrowser(page, app)
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
    const appStopped = app === undefined ? child === undefined : await stopOwnApp(app).catch(() => false)
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
      console.log('PASS: signed macOS arm64 app.asar, bundled Playwright Provider localhost navigation/WebSocket/snapshot/click/screenshot, packaged Electron Provider/protocol/transport, ' +
        'real Host browser.control and interactive WebContentsView guest, app.isPackaged, metadata/Host version, real Host page, both Host WebSockets, ' +
        'single instance, sandbox preload, Go helper/bridge, isolated desktop lock and cleanup')
      console.log('Not exercised: Host approval of the seven browser_* tools or a model turn; the isolated Playwright Provider test uses the bundled runtime directly.')
      console.log('Not inspected by the Electron test channel: native menu/Tray and macOS window close/hide; ' +
        'verify those in a native UI session.')
    }
  }
}

main().catch(error => {
  // 不输出 helper 原始 stderr、host.json、授权 token、进程环境或用户凭据。
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
