/**
 * 显式 opt-in 的 macOS arm64 打包版冒烟：直接运行独立 Electron .app 中的 Coding，
 * 通过 Electron 测试通道观察主进程和真实 Host 页面；不进入 keyless Vitest，不安装应用。
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
const packagedElectronBrowser = join(resources, 'runtime', 'node_modules',
  '@deepseek-ai', 'dsh-browser-electron')
const packagedElectronProtocol = join(packagedElectronBrowser, 'lib', 'types', 'protocol.js')
const packagedBrowserTransport = join(resources, 'runtime', 'node_modules', 'ws', 'index.js')
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
    join(packagedElectronBrowser, 'package.json'), join(packagedElectronBrowser, 'lib', 'index.js'),
    packagedElectronProtocol, packagedBrowserTransport]) {
    const entry = await lstat(path).catch(() => undefined)
    assert.ok(entry?.isFile(), `missing packaged regular file: ${path}; rebuild dist/Coding.app`)
    if (path === join(resources, 'app.asar')) assert.ok(entry.size > 0, 'packaged app.asar must not be empty')
  }
  assert.equal(existsSync(browserRoot), false,
    'packaged native browser must not ship a Playwright browser binary')
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

async function browserControlAfterTurn(page, sessionId, command) {
  const response = await page.evaluate(async ({ sessionId, command }) => {
    const rpcId = crypto.randomUUID()
    const result = await fetch('/api/browser.control', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'browser.control',
        payload: { sessionId, command } }) })
    return { status: result.status, envelope: await result.json(), rpcId }
  }, { sessionId, command })
  assert.equal(response.status, 200, 'browser.control HTTP status')
  assert.equal(response.envelope.type, 'server-response', 'browser.control response envelope')
  assert.equal(response.envelope.rpcId, response.rpcId, 'browser.control request identity')
  const result = response.envelope.result
  if (result?.error?.code === 'browser-failed' && result.error.details?.reason === 'BROWSER_BUSY') return undefined
  assert.equal(result?.ok, true, `browser.control after Agent turn: ${result?.error?.code ?? 'unknown'}`)
  return result.value
}

async function browserFixture() {
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>Packaged native fixture</title>
      <h1>Local packaged browser page</h1>
      <button id="human" onclick="document.querySelector('#human-result').textContent='Human clicked'">Human click</button>
      <output id="human-result">Waiting</output>
      <button id="agent" onclick="document.querySelector('#agent-result').textContent='Agent clicked'">Agent click</button>
      <output id="agent-result">Waiting</output>`)
  })
  await new Promise((resolveListen, reject) => {
    fixture.once('error', reject)
    fixture.listen(0, '127.0.0.1', resolveListen)
  })
  const address = fixture.address()
  assert.ok(address && typeof address !== 'string', 'native fixture must bind a loopback port')
  return { url: `http://127.0.0.1:${address.port}/`, close: async () => {
    fixture.closeAllConnections()
    await new Promise(resolveClose => fixture.close(resolveClose))
  } }
}

async function scriptedModel(fixtureUrl) {
  let phase = 'navigate'
  let step = 0
  const failures = []
  const observations = []
  const server = createServer((request, response) => {
    if (request.url !== '/chat/completions' || request.method !== 'POST' ||
      request.socket.remoteAddress !== '127.0.0.1') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.on('data', chunk => { body += chunk.toString('utf8') })
    request.on('end', () => {
      try {
        const payload = JSON.parse(body)
        const tools = (payload.tools ?? []).map(tool => tool.function?.name)
        let frames
        if (!tools.includes('browser_snapshot')) {
          frames = [{ choices: [{ delta: { content: 'Packaged native smoke' }, finish_reason: 'stop' }] }]
        } else {
          assert.ok(tools.includes('browser_navigate') && tools.includes('browser_click'),
            'packaged Agent must advertise the native browser tools')
          const results = payload.messages.filter(message => message.role === 'tool')
          let name
          let args
          if (phase === 'navigate' && step === 0) {
            assert.equal(results.length, 0, 'fresh Session must begin before browser tools')
            name = 'browser_navigate'
            args = JSON.stringify({ url: fixtureUrl })
          } else if (phase === 'navigate' && step === 1) {
            const navigated = JSON.parse(results.at(-1)?.content)
            assert.equal(navigated.action, 'navigate', 'model must receive real browser_navigate output')
            assert.equal(navigated.observation.url, fixtureUrl, 'Agent must reach local fixture')
            observations.push(navigated.observation)
          } else if (phase === 'inspect' && step === 0) {
            name = 'browser_snapshot'
            args = '{}'
          } else if (phase === 'inspect' && step === 1) {
            const snapshot = JSON.parse(results.at(-1)?.content)
            assert.equal(snapshot.action, 'snapshot', 'model must receive real browser_snapshot output')
            assert.ok(snapshot.observation.snapshot.includes('Human clicked'),
              'Agent must observe the human DOM mutation in the same guest')
            const ref = snapshot.observation.snapshot.match(/(e\d+-\S+) button "Agent click"/)?.[1]
            assert.ok(ref, 'Agent must receive a clickable observed ref')
            observations.push(snapshot.observation)
            name = 'browser_click'
            args = JSON.stringify({ ref, revision: snapshot.observation.revision })
          } else if (phase === 'inspect' && step === 2) {
            const clicked = JSON.parse(results.at(-1)?.content)
            assert.equal(clicked.action, 'click', 'model must receive real browser_click output')
            assert.ok(clicked.observation.snapshot.includes('Agent clicked'),
              'Agent click must mutate the native guest')
            observations.push(clicked.observation)
          } else throw new Error(`unexpected packaged model request: ${phase}/${step}`)
          step++
          frames = name === undefined
            ? [{ choices: [{ delta: { content: 'PACKAGED_NATIVE_OK' }, finish_reason: 'stop' }] }]
            : [
              { choices: [{ delta: { tool_calls: [{ index: 0, id: `packaged-${phase}-${step}`,
                type: 'function', function: { name, arguments: args } }] } }] },
              { choices: [{ delta: {}, finish_reason: 'tool_calls' }],
                usage: { prompt_tokens: 10, completion_tokens: 5 } },
            ]
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`)
        response.end('data: [DONE]\n\n')
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
        response.writeHead(500).end('invalid scripted model step')
      }
    })
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string', 'scripted model must bind locally')
  return { url: `http://127.0.0.1:${address.port}`, observations, failures,
    get step() { return step },
    startInspect() {
      assert.equal(phase, 'navigate')
      assert.equal(step, 2, 'navigation turn must finish before human input')
      phase = 'inspect'
      step = 0
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolveClose => server.close(resolveClose))
    } }
}

async function completeOnboarding(page, model) {
  // 只在隔离 HOME 中写入回环模型及占位凭据；不读取用户真实配置。
  await browserRpc(page, 'settings.update', { ns: 'llm-deepseek',
    patch: { baseURL: model.url, thinking: 'disabled', reasoningEffort: 'off' } })
  await browserRpc(page, 'credentials.set',
    { ref: 'DEEPSEEK_API_KEY', value: 'packaged-smoke-local-placeholder' })
  await browserRpc(page, 'settings.update', { ns: 'agent-default-model',
    patch: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
  await browserRpc(page, 'settings.update', { ns: 'permission',
    patch: { defaultPreset: 'danger-full-access' } })
  await page.getByRole('dialog', { name: '配置模型，开始使用' }).waitFor({ state: 'hidden', timeout: timeoutMs })
  await until(() => page.locator('#root').evaluate(root => !root.inert),
    'packaged workbench unlocked after onboarding')
}

async function promptAndHistory(page, sessionId, text, turnCount, model) {
  const prompted = await browserRpc(page, 'session.prompt', { sessionId, mode: 'queue',
    content: [{ type: 'text', text }] })
  assert.equal(prompted.accepted, true, 'packaged Host must accept the scripted Agent turn')
  let history
  try {
    await until(async () => {
      history = await browserRpc(page, 'session.history', { sessionId, maxMessages: 30 })
      return history.events.filter(({ event }) => event.type === 'turn/end').length >= turnCount
    }, `packaged Agent turn ${turnCount}`, 45_000)
  } catch (error) {
    throw new Error(`${error.message}; scripted model errors: ${model.failures.join(' | ') || 'none'}`)
  }
  assert.deepEqual(model.failures, [], 'scripted model must receive valid browser observations')
  return history.events.map(({ event }) => event)
}

async function verifyNativeBrowser(page, app, fixtureUrl, model) {
  await page.getByRole('button', { name: '打开右侧边栏' }).click()
  const menu = page.getByRole('navigation', { name: '工作台功能' })
  await menu.waitFor({ state: 'visible' })
  await menu.getByRole('button', { name: '浏览器' }).click()
  await page.getByTestId('browser-canvas').waitFor({ state: 'visible' })
  const sessions = await browserRpc(page, 'session.list', {})
  assert.equal(sessions.items.length, 1, 'packaged workbench must create one Host Session')
  const sessionId = sessions.items[0].sessionId
  let events = await promptAndHistory(page, sessionId,
    'Use browser_navigate to open the local fixture.', 1, model)
  assert.equal(model.step, 2, 'Agent must navigate and finish the first turn')
  let calls = events.filter(event => event.type === 'tool/call')
  let results = events.filter(event => event.type === 'tool/result')
  assert.deepEqual(calls.map(event => event.data.name), ['browser_navigate'])
  assert.deepEqual(results.map(event => event.data.message.content[0]?.isError), [false],
    'real browser_navigate must pass the Host tool policy')
  assert.equal(results[0].data.message.content[0]?.toolCallId, calls[0].data.callId)
  assert.equal(events.findLast(event => event.type === 'turn/end')?.data.reason.kind, 'completed')
  const tabId = model.observations[0].tabId
  assert.ok(tabId, 'native navigation must return a browser tab id')
  let state
  await until(async () => {
    state = await browserControlAfterTurn(page, sessionId, { kind: 'ensure-tab' })
    return state?.activeTabId === tabId && state.tabs[0]?.url === fixtureUrl
  }, 'packaged Agent navigation and browser lease release')
  await page.getByTestId('browser-canvas').waitFor({ state: 'visible' })
  let guest
  await until(async () => {
    const guests = await inspectPackagedMain(app)
    guest = guests.find(candidate => candidate.url === fixtureUrl)
    return guest?.title === 'Packaged native fixture' && guest.bounds.width >= 200
  }, 'packaged Agent-opened native guest visible')
  const guestPage = app.context().pages()
    .find(candidate => !candidate.isClosed() && candidate.url() === fixtureUrl)
  assert.ok(guestPage, 'Agent-opened WebContentsView must expose an interactive Chromium target')
  assert.deepEqual(await guestPage.evaluate(() => [
    'codingDesktop', 'require', 'process', 'ipcRenderer', 'DSH_HOST_TOKEN',
    'DSH_DESKTOP_BROWSER_BRIDGE_TOKEN', '__CODING_DESKTOP_BRIDGE_TOKEN',
  ].filter(name => name in window)), [], 'native guest must not receive Host/preload credentials')
  await guestPage.locator('#human').click()
  assert.equal(await guestPage.locator('#human-result').innerText(), 'Human clicked',
    'human click must update the live native guest DOM')
  assert.equal((await inspectPackagedMain(app, fixtureUrl)).id, guest.id,
    'human input must retain the Agent-opened WebContentsView')

  model.startInspect()
  events = await promptAndHistory(page, sessionId,
    'Take a browser_snapshot of my click, then click Agent click.', 2, model)
  assert.equal(model.step, 3, 'Agent must snapshot, click and finish the second turn')
  calls = events.filter(event => event.type === 'tool/call')
  results = events.filter(event => event.type === 'tool/result')
  assert.deepEqual(calls.map(event => event.data.name),
    ['browser_navigate', 'browser_snapshot', 'browser_click'], 'session log must record the model tool sequence')
  assert.deepEqual(results.map(event => event.data.message.content[0]?.isError), [false, false, false],
    'all browser tools must succeed through the Host tool path and policy')
  assert.deepEqual(results.map(event => event.data.message.content[0]?.toolCallId),
    calls.map(event => event.data.callId), 'tool results must pair with model calls')
  assert.equal(events.filter(event => event.type === 'turn/start').length, 2,
    'session history must retain both Agent turn starts')
  assert.equal(events.filter(event => event.type === 'turn/end').length, 2)
  assert.equal(events.findLast(event => event.type === 'turn/end')?.data.reason.kind, 'completed')
  assert.deepEqual(model.observations.map(observation => observation.tabId), [tabId, tabId, tabId],
    'Agent navigation, snapshot and click must use the same native tab')
  assert.equal(await guestPage.locator('#agent-result').innerText(), 'Agent clicked',
    'Agent click must update the human-operated native guest')
  assert.equal(await guestPage.locator('#human-result').innerText(), 'Human clicked',
    'Agent tools must preserve the human DOM mutation')
  await until(async () => (await inspectPackagedMain(app, fixtureUrl)).id === guest.id,
    'same native guest visible after Agent interaction')
  assert.equal(await browserRpc(page, 'browser.control',
    { sessionId, command: { kind: 'close-tab', tabId } }), null,
  'closing the packaged Agent browser tab must release the guest')
  await until(async () => (await inspectPackagedMain(app)).length === 0,
    'packaged native guest teardown', 10_000)
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
  let fixture
  let model
  let passed = false
  try {
    await Promise.all([home, tmp].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
    fixture = await browserFixture()
    model = await scriptedModel(fixture.url)
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
    await completeOnboarding(page, model)
    await verifyNativeBrowser(page, app, fixture.url, model)
    assert.equal(existsSync(join(home, 'Library', 'Caches', 'ms-playwright')), false,
      'packaged native browser must not create a Playwright browser cache')
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
    await model?.close()
    await fixture?.close()
    if (appStopped && helperStopped && hostStopped && socketStopped) {
      await rm(isolated, { recursive: true, force: true })
    } else {
      console.warn(`Isolated test HOME preserved because process ownership/lifecycle is uncertain: ${isolated}`)
    }
    if (passed) {
      assert.ok(appStopped && helperStopped && hostStopped && socketStopped,
        'packaged Electron/helper/Host and isolated desktop lock must all stop')
      console.log('PASS: signed macOS arm64 app.asar without a Playwright browser binary, packaged Electron Provider/protocol/transport, ' +
        'real Host Agent browser_navigate/snapshot/click on one interactive WebContentsView guest with human DOM continuity, app.isPackaged, metadata/Host version, real Host page, both Host WebSockets, ' +
        'single instance, sandbox preload, Go helper/bridge, isolated desktop lock and cleanup')
      console.log('The local scripted model exercises three browser_* tools through the Host tool path and two persisted Agent turns; remaining browser tools are not exercised.')
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
