/**
 * 显式 opt-in 的 macOS 原生冒烟：先构建 Host/Web 与 Electron，再直接用 Node 运行本文件。
 * 不使用 *.spec.* 命名，避免根 Vitest 的 keyless 套件意外启动 GUI。
 * --focus-only 只验收输入框焦点，不依赖 macOS 窗口前台与最小化状态。
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronExecutable from 'electron'
import { _electron } from 'playwright'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const entry = join(repositoryRoot, 'apps/desktop-electron/lib/main.js')
const timeoutMs = 90_000

function deadline(promise, description, ms = timeoutMs) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function until(check, description, ms = timeoutMs) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 150))
  }
  throw new Error(`${description} timed out after ${ms}ms`)
}

async function hostRecord(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (value.type === 'coding-host-ready' && value.protocol === 1 &&
      value.version === 'dev' && Number.isSafeInteger(value.pid) &&
      Number.isSafeInteger(value.port) && value.port > 0 && value.port <= 65535 &&
      typeof value.token === 'string' && value.token.length > 0) return value
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return undefined
}

async function describeHost(origin) {
  const rpcId = randomUUID()
  const response = await fetch(`${origin}/api/host.describe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function stopVerifiedHost(hostHome, expected) {
  const path = join(hostHome, 'host.json')
  const current = await hostRecord(path)
  if (expected === undefined) return current === undefined
  if (!pidAlive(expected.pid)) return true
  if (current === undefined || current.pid !== expected.pid || current.port !== expected.port ||
    current.token !== expected.token) return false
  try {
    const response = await describeHost(`http://127.0.0.1:${current.port}`)
    if (response.managedHostToken !== expected.token) return false
  } catch {
    return false
  }
  // 只向当前记录与 RPC 双重认证的测试 Host 发送温和终止信号。
  process.kill(expected.pid, 'SIGTERM')
  try {
    await until(() => Promise.resolve(!pidAlive(expected.pid)), 'test Host graceful exit', 10_000)
    return true
  } catch {
    return false
  }
}

async function secondLaunch(env) {
  const child = spawn(electronExecutable, [entry], {
    cwd: repositoryRoot,
    env,
    stdio: 'ignore',
  })
  try {
    const code = await deadline(new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', (status, signal) => signal === null
        ? resolveExit(status)
        : reject(new Error(`second Electron exited on ${signal}`)))
    }), 'second Electron instance', 15_000)
    assert.equal(code, 0, 'second instance should exit after passing focus to the first')
  } finally {
    // 仅处理本测试刚启动的第二实例，绝不依据记录 PID 清理已有 Host。
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

async function closeOwnApp(app) {
  const child = app.process()
  try {
    await deadline(app.close(), 'Electron shutdown', 10_000)
  } catch { /* 对测试自己启动的子进程作有界退出，避免错误对话框阻塞清理。 */ }
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    new Promise(resolveWait => setTimeout(resolveWait, 2_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

function screenLocked() {
  const result = spawnSync('/usr/sbin/ioreg', ['-l', '-w', '0'], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 20_000_000,
    env: { PATH: '/usr/sbin:/usr/bin:/bin' },
  })
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined
  for (const line of result.stdout.split('\n')) {
    if (!line.includes('"IOConsoleUsers"')) continue
    const consoleSession = [...line.matchAll(/\{[^{}]*\}/g)]
      .map(match => match[0])
      .find(entry => entry.includes('"kCGSSessionOnConsoleKey"=Yes'))
    if (consoleSession === undefined) continue
    if (consoleSession.includes('"CGSSessionScreenIsLocked"=Yes')) return true
    if (consoleSession.includes('"CGSSessionScreenIsLocked"=No')) return false
  }
  return undefined
}

async function verifyWindowBoundary(page, app, origin) {
  const firstWindowCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  assert.equal(firstWindowCount, 1)

  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__nativeSmokeNavigations = []
    for (const eventName of ['will-frame-navigate', 'will-navigate']) {
      BrowserWindow.getAllWindows()[0].webContents.once(eventName, details => {
        globalThis.__nativeSmokeNavigations.push({ eventName, url: details.url })
      })
    }
  })

  // 用真实点击触发跨源导航与 window.open，而非仅调用窗口边界的单元测试函数。
  await page.evaluate(() => {
    const navigation = document.createElement('a')
    navigation.id = 'native-smoke-navigation'
    navigation.href = 'https://example.com/native-smoke'
    navigation.textContent = 'navigation probe'
    navigation.style.cssText = 'position:fixed;top:48px;left:48px;z-index:2147483647;background:white;color:black'
    document.body.append(navigation)
    const popup = document.createElement('button')
    popup.id = 'native-smoke-popup'
    popup.textContent = 'popup probe'
    popup.style.cssText = 'position:fixed;top:48px;left:240px;z-index:2147483647;background:white;color:black'
    popup.onclick = () => { window.open('https://example.com/native-smoke-popup') }
    document.body.append(popup)
  })
  try {
    await page.locator('#native-smoke-popup').click({ noWaitAfter: true })
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), firstWindowCount,
      'cross-origin popup must not create another window')
    assert.equal(await page.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state),
      'denied', 'renderer geolocation permission')

    // 跨源导航放在最后：Chromium 被阻止的导航可使自动化驱动持续等待 load。
    // 被主进程取消的导航没有 load 事件；点击本身完成即可，另以导航事件验证。
    await page.locator('#native-smoke-navigation').click({ noWaitAfter: true })
    await until(() => app.evaluate(() => globalThis.__nativeSmokeNavigations.some(entry =>
      entry.url === 'https://example.com/native-smoke')), 'cross-origin navigation event', 5_000)
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
    assert.equal(page.url(), `${origin}/`, 'navigation must remain on the verified Host')
  } finally {
    await page.evaluate(() => {
      document.querySelector('#native-smoke-navigation')?.remove()
      document.querySelector('#native-smoke-popup')?.remove()
    }).catch(() => undefined)
  }
}

async function verifyWebSockets(page, origin) {
  const states = await page.evaluate(async hostOrigin => {
    return Promise.all(['events.mux', 'events.host'].map(path => new Promise((resolveOpen, reject) => {
      const socket = new WebSocket(`${hostOrigin.replace(/^http/, 'ws')}/api/${path}`)
      const timer = setTimeout(() => { socket.close(); reject(new Error(`${path} opening timed out`)) }, 10_000)
      socket.onopen = () => {
        clearTimeout(timer)
        const state = socket.readyState
        socket.close()
        resolveOpen({ path, state })
      }
      socket.onerror = () => { clearTimeout(timer); reject(new Error(`${path} WebSocket failed`)) }
    })))
  }, origin)
  assert.deepEqual(states, [
    { path: 'events.mux', state: 1 },
    { path: 'events.host', state: 1 },
  ])
}

async function verifyRemoteSshBridge(page) {
  const bridge = await page.evaluate(async () => {
    const remoteSSH = window.codingDesktop?.remoteSSH
    const methods = remoteSSH === undefined ? [] : Object.keys(remoteSSH).sort()
    const browser = window.codingDesktop?.browser
    const dispose = remoteSSH?.subscribeProgress(() => {})
    dispose?.()
    return {
      desktopKeys: Object.keys(window.codingDesktop ?? {}),
      methods,
      browserKeys: browser === undefined ? [] : Object.keys(browser).sort(),
      browserAvailable: browser?.available,
      browserPresentType: typeof browser?.present,
      disposeType: typeof dispose,
      leakedGlobals: [
        'ipcRenderer', 'require', 'process', 'go', '__CODING_DESKTOP_BRIDGE_TOKEN',
        'DSH_REMOTE_BRIDGE_TOKEN', 'DSH_HOST_TOKEN', '__CODING_HOST_BEARER',
        'CODING_HOST_BEARER', 'managedHostToken',
      ].filter(name => name in window),
      result: await remoteSSH?.cancelConnect('smoke-attempt'),
    }
  })
  assert.deepEqual(bridge.desktopKeys, ['remoteSSH', 'browser'],
    'preload must expose only Remote-SSH and browser presentation surfaces')
  assert.deepEqual(bridge.browserKeys, ['available', 'present'],
    'browser preload must expose only availability and presentation')
  assert.equal(bridge.browserAvailable, true, 'native guest presentation must be available')
  assert.equal(bridge.browserPresentType, 'function', 'native guest presentation must be callable')
  assert.deepEqual(bridge.methods, [
    'cancelConnect', 'close', 'connect', 'listDirectories', 'rejectHostKey', 'selectDirectory', 'subscribeProgress',
  ], 'preload must expose exactly six methods plus progress subscription')
  assert.equal(bridge.disposeType, 'function', 'progress subscription must have a disposer')
  assert.deepEqual(bridge.leakedGlobals, [], 'renderer must not expose IPC, Go bridge token or Host bearer globals')
  assert.deepEqual(bridge.result, {}, 'cancelConnect must complete through preload, main IPC and the Go helper')
}

async function verifyRemoteSshWizard(page, screenshot) {
  // 引导已由隔离的本地模型配置完成；不读取或提交真实 API Key。
  await page.getByRole('button', { name: '选择工作区' }).first().click()
  await page.getByText('远程连接', { exact: true }).first().click()
  const wizard = page.getByRole('dialog', { name: '远程连接' })
  await wizard.waitFor({ state: 'visible' })
  const host = wizard.locator('#remote-ssh-host')
  assert.equal(await host.isVisible(), true,
    'Electron preload must enable the Remote-SSH host form')
  assert.equal(await wizard.getByText('Remote-SSH 仅在 Coding 桌面端中可用。').count(), 0,
    'Electron wizard must not show the desktop-only fallback')
  // 点击先激活原生窗口，再从模式单选项用 Tab 回到输入框验证键盘焦点。
  await host.click()
  await host.press('Shift+Tab')
  await page.keyboard.press('Tab')
  const focus = await host.evaluate(input => {
    const inner = getComputedStyle(input)
    const outer = getComputedStyle(input.parentElement)
    const probe = document.createElement('span')
    probe.style.color = 'var(--dsw-alias-state-business-primary)'
    document.body.append(probe)
    const business = getComputedStyle(probe).color
    probe.remove()
    return {
      active: document.activeElement === input,
      visible: input.matches(':focus-visible'),
      outline: inner.outlineStyle,
      radius: outer.borderTopLeftRadius,
      border: outer.borderTopColor,
      shadow: outer.boxShadow,
      business,
    }
  })
  assert.equal(focus.active, true, 'Tab must return focus to the SSH host input')
  assert.equal(focus.visible, true, 'SSH host input must expose its keyboard focus state')
  assert.equal(focus.outline, 'none', 'rounded SSH field must not draw a square inner focus outline')
  assert.notEqual(focus.radius, '0px', 'SSH field focus frame must remain rounded')
  assert.equal(focus.border, focus.business, 'SSH field must retain its business-color focus frame')
  assert.notEqual(focus.shadow, 'none', 'SSH field focus must remain visible around the rounded frame')
  await wizard.screenshot({ path: screenshot })
  await wizard.getByRole('button', { name: '关闭' }).click()
  await wizard.waitFor({ state: 'hidden' })
}

async function verifyTitlebar(page, app) {
  const strip = page.locator('[data-window-drag-strip]')
  await strip.waitFor({ state: 'visible' })
  const dragStyle = await strip.evaluate(element => ({
    region: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
    rootVariable: getComputedStyle(document.documentElement).getPropertyValue('--dsh-desktop-window-drag'),
    source: [...document.styleSheets].flatMap(sheet => {
      try { return [...sheet.cssRules].map(rule => rule.cssText).filter(rule => rule.includes('windowDragStrip')) }
      catch { return [] }
    }).slice(0, 2),
  }))
  assert.equal(dragStyle.region, 'drag', `empty Hero titlebar must be an Electron drag region: ${JSON.stringify(dragStyle)}`)
  assert.equal(await page.getByRole('button', { name: '显示终端底栏' }).first().evaluate(element =>
    getComputedStyle(element).getPropertyValue('-webkit-app-region')), 'no-drag',
  'titlebar action must remain clickable')
  await page.getByRole('button', { name: '收起侧边栏' }).click()
  await page.locator('[data-sidebar-collapsed]').waitFor({ state: 'attached' })
  const collapsedStrip = await strip.boundingBox()
  assert.ok(collapsedStrip && collapsedStrip.x >= 89,
    'collapsed rail drag region must not cover macOS traffic lights')
  await page.getByRole('button', { name: '打开侧边栏' }).click()

  const locked = screenLocked()
  if (locked !== false) {
    console.log(`physical titlebar drag unverified: ${locked === true ? 'screen locked' : 'screen-lock probe unavailable'}`)
    return false
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize())
  await until(() => app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isMaximized()),
    'restore maximized window')
  const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
  const box = await strip.boundingBox()
  assert.ok(box && box.width > 240 && box.height >= 32, 'titlebar drag strip must have visible space')
  const x = box.x + 120
  const y = box.y + 18
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 55, y + 30, { steps: 8 })
  await page.mouse.up()
  await until(() => app.evaluate(({ BrowserWindow }, previous) => {
    const bounds = BrowserWindow.getAllWindows()[0].getBounds()
    return bounds.x !== previous.x || bounds.y !== previous.y
  }, before), 'native titlebar drag moves the restored window', 5_000)
  await page.mouse.dblclick(x, y)
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()),
    'native titlebar double-click maximizes the window', 5_000)
  return true
}

async function verifyTerminalTabs(page, screenshot) {
  await page.getByRole('button', { name: '显示终端底栏' }).first().click()
  const first = page.getByRole('tab', { name: 'coding 1' })
  await first.waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '新建终端' }).click()
  const second = page.getByRole('tab', { name: 'coding 2' })
  await second.waitFor({ state: 'visible' })
  assert.equal(await second.getAttribute('aria-selected'), 'true', 'new terminal must be selected')
  assert.equal(await page.locator('.xterm-screen').count(), 2, 'each tab must retain its own xterm')
  const activeTerminal = page.getByRole('tabpanel', { name: 'coding 2' })
  await until(async () => await activeTerminal.getAttribute('data-connected') === 'true',
    'second terminal connected')
  const terminalScreen = await activeTerminal.locator('.xterm-screen').boundingBox()
  assert.ok(terminalScreen && terminalScreen.height > 80,
    'connected terminal canvas must fill the bottom panel')
  await first.click()
  assert.equal(await first.getAttribute('aria-selected'), 'true', 'first terminal must be switchable')
  await second.click()
  await page.screenshot({ path: screenshot })
  await page.getByRole('button', { name: '关闭 coding 1' }).click()
  assert.equal(await page.getByRole('tab', { name: 'coding 1' }).count(), 0,
    'closing one terminal removes only its tab')
  assert.equal(await second.count(), 1, 'other terminal must remain mounted')
  await page.getByRole('region', { name: '终端' }).getByRole('button', { name: '隐藏终端底栏' }).click()
  assert.equal(await page.locator('section[aria-label="终端"]').isVisible(), false,
    'bottom close must hide the panel without closing its terminal')
  await page.getByRole('button', { name: '显示终端底栏' }).first().click()
  await second.waitFor({ state: 'visible' })
  await activeTerminal.locator('textarea').focus()
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await until(async () => await second.count() === 0, 'exited terminal tab removed', 10_000)
  await until(async () => !(await page.locator('section[aria-label="终端"]').isVisible()),
    'last terminal exit hides bottom panel', 10_000)
  await page.getByRole('button', { name: '显示终端底栏' }).first().click()
  await page.getByRole('tab', { name: 'coding 3' }).waitFor({ state: 'visible' })
}

async function verifyNativeChrome(app, hostHome, record, origin, originalId) {
  const menu = await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find(item => item.label === '文件')
    return {
      file: file?.label,
      items: file?.submenu?.items.map(item => ({ label: item.label, accelerator: item.accelerator })),
    }
  })
  assert.equal(menu.file, '文件', 'native application menu must contain 文件')
  assert.ok(menu.items?.some(item => item.label === '新建会话' && item.accelerator === 'CmdOrCtrl+N'),
    'native 新建会话 must have CmdOrCtrl+N')
  assert.ok(menu.items?.some(item => item.label === '隐藏窗口' && item.accelerator === 'CmdOrCtrl+W'),
    'native 隐藏窗口 must have CmdOrCtrl+W')

  // 经真实 BrowserWindow.close 事件验证主进程的拦截，不直接调用 nativeChrome 句柄。
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await until(() => app.evaluate(({ BrowserWindow }, id) => {
    const windows = BrowserWindow.getAllWindows()
    return windows.length === 1 && windows[0].id === id &&
      !windows[0].isDestroyed() && !windows[0].isVisible()
  }, originalId), 'macOS close must hide and retain the same BrowserWindow', 10_000)
  assert.equal(pidAlive(record.pid), true, 'closing the window must not stop the managed Host')
  assert.deepEqual(await hostRecord(join(hostHome, 'host.json')), record,
    'closing the window must retain the managed Host record')
  assert.equal((await describeHost(origin)).managedHostToken, record.token,
    'managed Host RPC must remain available after closing the window')

  // Dock 激活事件交由入口注册的监听器恢复窗口，不绕开应用生命周期。
  await app.evaluate(({ app: electronApp }) => electronApp.emit('activate'))
  await until(() => app.evaluate(({ BrowserWindow }, id) => {
    const windows = BrowserWindow.getAllWindows()
    return windows.length === 1 && windows[0].id === id && windows[0].isVisible()
  }, originalId), 'Dock activate must restore the same BrowserWindow', 10_000)

  // 锁屏或锁屏状态不明时 app.hide() 依赖前台 WindowServer，不能证明菜单回调是否生效。
  if (screenLocked() !== false) {
    console.log('native menu hide unverified: unlock the graphical session and rerun')
    return false
  }

  // 菜单项的实际 click 回调也应隐藏窗口，之后仍能由 Dock 激活复原。
  await app.evaluate(({ BrowserWindow, Menu }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const file = Menu.getApplicationMenu().items.find(item => item.label === '文件')
    const hide = file.submenu.items.find(item => item.label === '隐藏窗口')
    hide.click(hide, window, {})
  })
  await until(() => app.evaluate(({ BrowserWindow }, id) => {
    const windows = BrowserWindow.getAllWindows()
    return windows.length === 1 && windows[0].id === id && !windows[0].isVisible()
  }, originalId), 'native menu hide must retain the same BrowserWindow', 10_000)
  await app.evaluate(({ app: electronApp }) => electronApp.emit('activate'))
  await until(() => app.evaluate(({ BrowserWindow }, id) => {
    const windows = BrowserWindow.getAllWindows()
    return windows.length === 1 && windows[0].id === id && windows[0].isVisible()
  }, originalId), 'Dock activate must restore the menu-hidden BrowserWindow', 10_000)
  console.log('macOS Tray existence and status-menu interaction require native UI inspection; Electron exposes no Tray.getAll API')
  return true
}

async function assertBlueFocusedField(locator, name) {
  assert.equal(await locator.isVisible(), true, `${name} input must be visible`)
  const colors = await locator.evaluate(input => {
    const style = getComputedStyle(input)
    const probe = document.createElement('span')
    probe.style.color = 'var(--dsw-alias-state-business-primary)'
    probe.style.boxShadow = '0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)'
    document.body.append(probe)
    const business = getComputedStyle(probe).color
    const shadow = getComputedStyle(probe).boxShadow
    probe.remove()
    return {
      focused: document.activeElement === input,
      border: style.borderTopColor,
      shadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      business,
      expectedShadow: shadow,
    }
  })
  assert.equal(colors.focused, true, `${name} input must receive actual keyboard focus`)
  assert.notEqual(colors.business, 'rgb(0, 0, 0)', `${name} business theme token must not resolve to black`)
  assert.equal(colors.border, colors.business, `${name} focus border must use business blue, not black`)
  assert.equal(colors.shadow, colors.expectedShadow, `${name} focus shadow must use business blue`)
  assert.equal(colors.outlineStyle, 'none', `${name} text input must not draw a second inner focus outline`)
}

async function verifyOnboardingFocus(page, afterScreenshot) {
  const dialog = page.getByRole('dialog', { name: '配置模型，开始使用' })
  await dialog.waitFor({ state: 'visible', timeout: timeoutMs })
  const title = dialog.getByRole('heading', { name: '配置模型，开始使用' })
  const credential = dialog.locator('input[type="password"][aria-label="API 密钥"]')
  const channel = dialog.getByLabel('渠道名称', { exact: true })
  const baseUrl = dialog.getByLabel('API 地址', { exact: true })

  // 当前引导先聚焦标题；测试仅输入临时非凭据文本，不向真实提供方发请求。
  await until(() => title.evaluate(element => document.activeElement === element),
    'model onboarding title autofocus', 5_000)
  await credential.click()
  await assertBlueFocusedField(credential, 'API Key')

  assert.equal(await channel.inputValue(), 'DeepSeek', 'channel name must initially name the shipped provider')
  await channel.click()
  await assertBlueFocusedField(channel, 'channel name')
  await channel.fill('smoke-local')
  assert.equal(await channel.inputValue(), 'smoke-local', 'channel name must be locally editable without saving')
  await channel.fill('DeepSeek')

  await baseUrl.click()
  await assertBlueFocusedField(baseUrl, 'API URL')
  await page.screenshot({ path: afterScreenshot })
}

async function browserFixture() {
  let stalledRequests = 0
  let pendingAssistantImages = 0
  let completedAssistantImages = 0
  const server = createServer((request, response) => {
    if (request.url === '/stalled-image') {
      stalledRequests++
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      response.flushHeaders()
      return
    }
    if (request.url === '/timeout') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(`<!doctype html><title>Native guest timeout fixture</title>
        <h1>Timeout recovery fixture</h1><p>The document is ready while its image is still loading.</p>
        <img src="/stalled-image" alt="Stalled fixture image">`)
      return
    }
    if (request.url === '/assistant-link-pending') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(`<!doctype html><title>Native guest fixture</title>
        <h1>Pending assistant link</h1><img src="/delayed-assistant-image" alt="Delayed image">`)
      return
    }
    if (request.url === '/delayed-assistant-image') {
      pendingAssistantImages++
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      response.flushHeaders()
      setTimeout(() => {
        completedAssistantImages++
        response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64'))
      }, 3_000)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>Native guest fixture</title>
      <h1>Live native guest</h1>
      <button id="human" onclick="document.querySelector('#human-result').textContent='Human clicked'">Human click</button>
      <output id="human-result">Waiting</output>
      <input id="typed" aria-label="Guest input" oninput="document.querySelector('#typed-result').textContent=this.value">
      <output id="typed-result">Waiting</output>
      <button id="agent" onclick="document.querySelector('#agent-result').textContent='Agent clicked'">Agent click</button>
      <output id="agent-result">Waiting</output>
      <button id="popup" onclick="window.open('https://example.com/native-guest-popup')">Open popup</button>`)
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string', 'native guest fixture must bind locally')
  return { url: `http://127.0.0.1:${address.port}/`,
    assistantLinkUrl: `http://127.0.0.1:${address.port}/assistant-link`,
    pendingAssistantLinkUrl: `http://127.0.0.1:${address.port}/assistant-link-pending`,
    timeoutUrl: `http://127.0.0.1:${address.port}/timeout`,
    get stalledRequests() { return stalledRequests },
    get pendingAssistantImages() { return pendingAssistantImages },
    get completedAssistantImages() { return completedAssistantImages },
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolveClose => server.close(resolveClose))
    } }
}

async function scriptedModel() {
  let browserStep = 0
  const observations = []
  const failures = []
  const toolNames = []
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
        const titleRequest = !tools.includes('browser_snapshot')
        let frames
        if (titleRequest) {
          frames = [{ choices: [{ delta: { content: 'Native smoke session' }, finish_reason: 'stop' }] }]
        } else {
          toolNames.push(tools)
          assert.ok(tools.includes('browser_click'), 'the shipped Agent must advertise browser_click')
          const results = payload.messages.filter(message => message.role === 'tool')
          let name
          let args
          if (browserStep === 0) {
            assert.equal(results.length, 0, 'first model step must start before browser tools')
            name = 'browser_snapshot'
            args = '{}'
          } else if (browserStep === 1) {
            const snapshot = JSON.parse(results.at(-1)?.content)
            assert.equal(snapshot.action, 'snapshot', 'model must receive actual browser_snapshot output')
            assert.ok(snapshot.observation.snapshot.includes('Human clicked'),
              'Agent snapshot must see the human click in the original guest')
            assert.ok(snapshot.observation.snapshot.includes('native typed text'),
              'Agent snapshot must see human keyboard input in the original guest')
            const ref = snapshot.observation.snapshot.match(/(e\d+-\S+) button "Agent click"/)?.[1]
            assert.ok(ref, 'Agent must receive the observed button ref')
            observations.push(snapshot.observation)
            name = 'browser_click'
            args = JSON.stringify({ ref, revision: snapshot.observation.revision })
          } else if (browserStep === 2) {
            const clicked = JSON.parse(results.at(-1)?.content)
            assert.equal(clicked.action, 'click', 'model must receive actual browser_click output')
            assert.ok(clicked.observation.snapshot.includes('Agent clicked'),
              'Agent click must mutate the original guest')
            observations.push(clicked.observation)
          } else throw new Error('unexpected extra native Agent request')
          browserStep++
          frames = name === undefined
            ? [{ choices: [{ delta: { content: 'NATIVE_AGENT_OK' }, finish_reason: 'stop' }] }]
            : [
              { choices: [{ delta: { tool_calls: [{ index: 0, id: `native-${browserStep}`, type: 'function',
                function: { name, arguments: args } }] } }] },
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
  return { url: `http://127.0.0.1:${address.port}`, observations, failures, toolNames,
    get browserStep() { return browserStep },
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolveClose => server.close(resolveClose))
    } }
}

async function scriptedNavigateModel(fixtureUrl) {
  let phase = 'navigate'
  let step = 0
  const observations = []
  const failures = []
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
          frames = [{ choices: [{ delta: { content: 'Native navigate smoke' }, finish_reason: 'stop' }] }]
        } else {
          assert.ok(tools.includes('browser_navigate'), 'shipped Agent must advertise browser_navigate')
          const results = payload.messages.filter(message => message.role === 'tool')
          let name
          let args
          if (phase === 'navigate' && step === 0) {
            assert.equal(results.length, 0, 'fresh Session must start before browser tools')
            name = 'browser_navigate'
            args = JSON.stringify({ url: fixtureUrl })
          } else if (phase === 'navigate' && step === 1) {
            const content = results.at(-1)?.content
            assert.ok(content?.startsWith('{'), `Agent navigation tool failed: ${content}`)
            const navigated = JSON.parse(content)
            assert.equal(navigated.action, 'navigate', 'model must receive actual browser_navigate output')
            assert.equal(navigated.observation.url, fixtureUrl, 'Agent navigation must reach local fixture')
            observations.push(navigated.observation)
          } else if (phase === 'snapshot' && step === 0) {
            name = 'browser_snapshot'
            args = '{}'
          } else if (phase === 'snapshot' && step === 1) {
            const snapshot = JSON.parse(results.at(-1)?.content)
            assert.equal(snapshot.action, 'snapshot', 'second model turn must receive browser_snapshot output')
            assert.ok(snapshot.observation.snapshot.includes('Human clicked'),
              'second model turn must see the human mutation in the native guest')
            observations.push(snapshot.observation)
          } else throw new Error(`unexpected native navigate model request: ${phase}/${step}`)
          step++
          frames = name === undefined
            ? [{ choices: [{ delta: { content: 'NATIVE_NAVIGATE_OK' }, finish_reason: 'stop' }] }]
            : [
              { choices: [{ delta: { tool_calls: [{ index: 0, id: `native-${phase}-${step}`, type: 'function',
                function: { name, arguments: args } }] } }] },
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
  assert.ok(address && typeof address !== 'string', 'navigate model must bind locally')
  return { url: `http://127.0.0.1:${address.port}`, observations, failures,
    get step() { return step },
    startSnapshot() {
      assert.equal(phase, 'navigate')
      assert.equal(step, 2, 'navigate turn must have completed before second model prompt')
      phase = 'snapshot'
      step = 0
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolveClose => server.close(resolveClose))
    } }
}

async function scriptedAssistantLinkModel(fixtureUrl, pendingUrl) {
  let responses = 0
  const failures = []
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
        const content = tools.includes('browser_snapshot')
          ? `请查看[打开本地页面](${fixtureUrl})、[打开慢速页面](${pendingUrl})、[再次打开本地页面](${fixtureUrl})和[第三次打开本地页面](${fixtureUrl})。`
          : 'Native assistant link smoke'
        if (tools.includes('browser_snapshot')) responses++
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
        response.writeHead(500).end('invalid scripted assistant link step')
      }
    })
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string', 'assistant link model must bind locally')
  return { url: `http://127.0.0.1:${address.port}`, failures,
    get responses() { return responses },
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolveClose => server.close(resolveClose))
    } }
}

async function scriptedTimeoutRecoveryModel(timeoutUrl) {
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
          frames = [{ choices: [{ delta: { content: 'Native timeout smoke' }, finish_reason: 'stop' }] }]
        } else {
          assert.ok(tools.includes('browser_navigate'), 'shipped Agent must advertise browser_navigate')
          const results = payload.messages.filter(message => message.role === 'tool')
          let name
          let args
          if (step === 0) {
            name = 'browser_navigate'
            args = JSON.stringify({ url: timeoutUrl })
          } else if (step === 1) {
            assert.ok(results.at(-1)?.content.includes('browser navigation timed out; loading stopped'),
              'model must receive the safe navigation timeout diagnostic')
            name = 'browser_snapshot'
            args = '{}'
          } else if (step === 2) {
            const snapshot = JSON.parse(results.at(-1)?.content)
            assert.equal(snapshot.action, 'snapshot', 'Agent must recover with a real browser_snapshot')
            assert.equal(snapshot.observation.url, timeoutUrl, 'snapshot must inspect the stopped page')
            assert.ok(snapshot.observation.snapshot.includes('Timeout recovery fixture'),
              'fresh Agent snapshot must read the DOM loaded before the stalled image')
            observations.push(snapshot.observation)
          } else throw new Error(`unexpected native timeout model step: ${step}`)
          step++
          frames = name === undefined
            ? [{ choices: [{ delta: { content: 'NATIVE_TIMEOUT_RECOVERED' }, finish_reason: 'stop' }] }]
            : [
              { choices: [{ delta: { tool_calls: [{ index: 0, id: `native-timeout-${step}`, type: 'function',
                function: { name, arguments: args } }] } }] },
              { choices: [{ delta: {}, finish_reason: 'tool_calls' }],
                usage: { prompt_tokens: 10, completion_tokens: 5 } },
            ]
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`)
        response.end('data: [DONE]\n\n')
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
        response.writeHead(500).end('invalid scripted timeout recovery step')
      }
    })
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string', 'timeout model must bind locally')
  return { url: `http://127.0.0.1:${address.port}`, failures, observations,
    get step() { return step },
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolveClose => server.close(resolveClose))
    } }
}

async function browserRpcResponse(page, method, payload) {
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
  return response.envelope.result
}

async function browserRpc(page, method, payload) {
  const result = await browserRpcResponse(page, method, payload)
  assert.equal(result?.ok, true, `${method} result: ${result?.error?.code ?? 'unknown'}`)
  return result.value
}

async function nativeGuest(app, id) {
  return app.evaluate(({ BrowserWindow }, expected) => {
    const views = BrowserWindow.getAllWindows()[0].contentView.children
      .filter(view => view.webContents && !view.webContents.isDestroyed())
    const guest = views.find(view => view.webContents.id === expected)
      ?? views.find(view => view.webContents.getTitle() === 'Native guest fixture')
    if (!guest) return null
    return { id: guest.webContents.id, title: guest.webContents.getTitle(),
      url: guest.webContents.getURL(), bounds: guest.getBounds(), attached: views.includes(guest) }
  }, id)
}

async function guestScript(app, guestId, expression) {
  return app.evaluate(({ webContents }, { guestId, expression }) => {
    const guest = webContents.fromId(guestId)
    if (!guest || guest.isDestroyed()) throw new Error('native guest no longer exists')
    return guest.executeJavaScript(expression)
  }, { guestId, expression })
}

async function clickGuest(guestPage, selector) {
  await guestPage.locator(selector).click()
}

async function verifyAgentOnNativeGuest(page, app, sessionId, guestId, model) {
  const prompted = await browserRpc(page, 'session.prompt', { sessionId, mode: 'queue',
    content: [{ type: 'text', text: 'Inspect the open native guest and click Agent click.' }] })
  assert.equal(prompted.accepted, true, 'shipped Host must accept the scripted Agent turn')
  let history
  try {
    await until(async () => {
      history = await browserRpc(page, 'session.history', { sessionId, maxMessages: 10 })
      return history.events.some(({ event }) => event.type === 'turn/end')
    }, 'scripted native Agent turn completion', 45_000)
  } catch (error) {
    throw new Error(`${error.message}; scripted model errors: ${model.failures.join(' | ') || 'none'}`)
  }
  assert.deepEqual(model.failures, [], 'scripted model requests must all match the keyless browser flow')
  assert.equal(model.browserStep, 3, 'Agent must call snapshot, then click, then complete')
  assert.ok(model.toolNames.every(names => names.includes('browser_snapshot') && names.includes('browser_click')),
    'shipped model requests must advertise the real browser tools')
  const events = history.events.map(({ event }) => event)
  const calls = events.filter(event => event.type === 'tool/call')
  assert.deepEqual(calls.map(event => event.data.name), ['browser_snapshot', 'browser_click'],
    'Host session log must record both actual model tool calls')
  const results = events.filter(event => event.type === 'tool/result')
  assert.deepEqual(results.map(event => event.data.message.content[0]?.isError), [false, false],
    'both Host browser tools must succeed through the shipped approval path')
  assert.deepEqual(results.map(event => event.data.message.content[0]?.toolCallId),
    calls.map(event => event.data.callId), 'session log must pair tool results with model calls')
  assert.equal(events.findLast(event => event.type === 'turn/end')?.data.reason.kind, 'completed',
    'scripted Agent turn must complete')
  assert.equal(model.observations.length, 2, 'mock model must inspect the real tool observations')
  assert.equal(model.observations[0].tabId, model.observations[1].tabId,
    'Agent snapshot and ref click must operate the same browser tab')
  assert.equal(await nativeGuest(app, guestId), null,
    'Agent tools must not present the browser guest over the file-manager workbench')
  assert.equal(await app.evaluate(({ webContents }, id) => {
    const guest = webContents.fromId(id)
    return guest && !guest.isDestroyed() ? guest.id : null
  }, guestId), guestId, 'Agent tools must retain the exact hidden human-operated WebContentsView')
  assert.equal(await guestScript(app, guestId, 'document.querySelector("#agent-result").textContent'),
    'Agent clicked', 'Agent ref click must be visible in the original native guest')
  assert.equal(await guestScript(app, guestId, 'document.querySelector("#typed-result").textContent'),
    'native typed text', 'Agent call must preserve the human-entered native DOM')
}

async function verifyNativeBrowser(page, app, fixtureUrl, hostOrigin, screenshot, guestScreenshot, model) {
  // 欢迎页入口先创建空白 Session；工作台菜单才建立该 Session 的浏览器标签。
  await page.getByRole('button', { name: '打开右侧边栏' }).click()
  const menu = page.getByRole('navigation', { name: '工作台功能' })
  await menu.waitFor({ state: 'visible' })
  await menu.getByRole('button', { name: '浏览器' }).click()
  const canvas = page.getByTestId('browser-canvas')
  await canvas.waitFor({ state: 'visible' })
  const sessions = await browserRpc(page, 'session.list', {})
  assert.equal(sessions.items.length, 1, 'workbench entry must create one local Session')
  const sessionId = sessions.items[0].sessionId
  const address = page.getByRole('textbox', { name: '网址' })
  await address.fill(fixtureUrl)
  await address.press('Enter')
  await until(async () => (await browserRpc(page, 'browser.control',
    { sessionId, command: { kind: 'ensure-tab' } })).tabs[0]?.url === fixtureUrl,
  'Host browser.control must reach native guest')
  const initialBrowser = await browserRpc(page, 'browser.control',
    { sessionId, command: { kind: 'ensure-tab' } })
  const firstId = initialBrowser.activeTabId
  let guest
  await until(async () => {
    guest = await nativeGuest(app)
    return guest?.attached && guest.url === fixtureUrl && guest.title === 'Native guest fixture'
  }, 'native WebContentsView visible with page title')
  const guestId = guest.id
  const guestPage = app.context().pages().find(candidate => !candidate.isClosed() && candidate.url() === fixtureUrl)
  assert.ok(guestPage, `live guest must expose an interactive Chromium target; ` +
    `targets=${app.context().pages().map(candidate => candidate.url()).join(', ')}`)
  assert.ok(guest.bounds.width >= 200 && guest.bounds.height >= 240,
    'native guest must occupy a real visible viewport')
  assert.equal(await canvas.locator('img').count(), 0, 'desktop browser must not present a PNG image')
  assert.equal(await page.getByLabel('浏览器页面').count(), 1, 'renderer must have a native guest placeholder')
  assert.deepEqual(await guestScript(app, guestId, `[
    'codingDesktop', 'require', 'process', 'ipcRenderer', 'DSH_HOST_TOKEN',
    'DSH_DESKTOP_BROWSER_BRIDGE_TOKEN', '__CODING_DESKTOP_BRIDGE_TOKEN',
  ].filter(name => name in window)`), [], 'guest page must not receive preload, Node or bridge credentials')
  await clickGuest(guestPage, '#human')
  await until(async () => await guestScript(app, guestId,
    'document.querySelector("#human-result").textContent') === 'Human clicked', 'native guest human click', 10_000)
  await clickGuest(guestPage, '#typed')
  await guestPage.keyboard.type('native typed text')
  await until(async () => await guestScript(app, guestId,
    'document.querySelector("#typed-result").textContent') === 'native typed text', 'native guest keyboard input', 10_000)
  await clickGuest(guestPage, '#popup')
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1,
    'guest window.open must not create a BrowserWindow')
  assert.equal(await guestScript(app, guestId,
    'navigator.permissions.query({ name: "geolocation" }).then(value => value.state)'), 'denied',
  'native guest must deny permissions')
  // 浏览器工作台隐藏后，Agent 仍应在同一未呈现的 guest 中完成观测和点击。
  await page.getByRole('button', { name: '添加工作台标签' }).click()
  await menu.getByRole('button', { name: '文件', exact: true }).click()
  await page.getByRole('tab', { name: '文件管理器' }).waitFor({ state: 'visible' })
  await until(async () => await nativeGuest(app, guestId) === null, 'hidden guest detached')
  assert.equal(await guestScript(app, guestId,
    'document.querySelector("#typed-result").textContent'), 'native typed text',
  'hidden guest must retain its document')
  assert.equal(await guestScript(app, guestId,
    'document.querySelector("#agent-result").textContent'), 'Waiting',
  'Agent click must not happen before the hidden workbench test')
  await verifyAgentOnNativeGuest(page, app, sessionId, guestId, model)
  await page.locator(`[data-browser-tab-id="${firstId}"]`).click()
  await until(async () => (await nativeGuest(app, guestId))?.attached, 'same guest restored')
  assert.equal((await nativeGuest(app, guestId)).id, guestId,
    'restoring the browser workbench must present the human/Agent guest')
  // 人工入口和 Electron 的网络层均不得让 guest 访问承载 Client/RPC 的 Host 端口。
  const hostAlias = `http://localhost:${new URL(hostOrigin).port}/`
  for (const blockedUrl of [hostOrigin + '/', hostAlias]) {
    const denied = await browserRpcResponse(page, 'browser.control',
      { sessionId, command: { kind: 'navigate', url: blockedUrl } })
    assert.deepEqual({ code: denied.error?.code, reason: denied.error?.details?.reason },
      { code: 'browser-failed', reason: 'BROWSER_DENIED' }, 'guest navigation to Host origin must be denied')
    assert.equal((await nativeGuest(app, guestId)).url, fixtureUrl,
      'denied Host navigation must retain the live fixture in the same guest')
  }
  const subresource = await guestScript(app, guestId,
    `fetch(${JSON.stringify(hostAlias)}, { mode: 'no-cors', cache: 'no-store' })
      .then(() => 'loaded', error => error.name)`)
  assert.equal(subresource, 'TypeError', 'guest subresource fetch to Host alias must be canceled')
  assert.equal((await nativeGuest(app, guestId)).id, guestId,
    'denied Host requests must retain the human/Agent guest identity')
  // Host 页截图不会合成 WebContentsView；直接截 guest target 作为真实页面画面证据。
  await guestPage.screenshot({ path: guestScreenshot })
  await page.screenshot({ path: screenshot })
  // 通过共享 Host 控制面验证标签切换，再关掉页面释放该会话资源。
  const second = await browserRpc(page, 'browser.control', { sessionId, command: { kind: 'new-tab' } })
  assert.notEqual(second.activeTabId, firstId, 'new tab must have a different id')
  await page.locator(`[data-browser-tab-id="${second.activeTabId}"]`).waitFor({ state: 'visible' })
  await page.locator(`[data-browser-tab-id="${firstId}"]`).click()
  await until(async () => (await browserRpc(page, 'browser.control',
    { sessionId, command: { kind: 'ensure-tab' } })).activeTabId === firstId,
  'human workbench tab selection must reach Host')
  await until(async () => (await nativeGuest(app, guestId))?.attached, 'switching tabs restores original guest')
  assert.equal(await guestScript(app, guestId, 'document.querySelector("#typed-result").textContent'),
    'native typed text', 'switching tabs must retain original DOM state')
  await browserRpc(page, 'browser.control', { sessionId, command: { kind: 'close-tab', tabId: second.activeTabId } })
  assert.equal(await browserRpc(page, 'browser.control',
    { sessionId, command: { kind: 'close-tab', tabId: firstId } }), null,
  'closing the last tab must release the Session browser')
  await until(async () => await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.isDestroyed() !== false,
    guestId), 'closed native guest destroyed')
  return sessionId
}

async function verifyAgentNavigateAutoReveal(page, app, fixtureUrl, model) {
  // 无 Workspace 时侧栏「新建会话」先返回欢迎页；欢迎页右侧边栏入口创建本地空会话。
  await page.getByRole('button', { name: '收起右侧边栏' }).first().click()
  await page.getByRole('button', { name: '打开右侧边栏' }).first().waitFor({ state: 'visible' })
  const previous = (await browserRpc(page, 'session.list', {})).items.map(item => item.sessionId)
  await page.getByRole('button', { name: '新建会话' }).first().click()
  await page.getByRole('button', { name: '打开右侧边栏' }).first().click()
  let sessionId
  await until(async () => {
    const sessions = await browserRpc(page, 'session.list', {})
    sessionId = sessions.items.find(item => !previous.includes(item.sessionId))?.sessionId
    return sessionId !== undefined
  }, 'fresh Session for model-driven navigation')
  await page.getByRole('button', { name: '收起右侧边栏' }).first().click()
  assert.equal(await page.getByRole('button', { name: '打开右侧边栏' }).first().isVisible(), true,
    'fresh Session right sidebar must begin closed')

  const prompted = await browserRpc(page, 'session.prompt', { sessionId, mode: 'queue',
    content: [{ type: 'text', text: 'Use browser_navigate to open the local fixture.' }] })
  assert.equal(prompted.accepted, true, 'fresh Session must accept scripted navigation turn')
  let history
  try {
    await until(async () => {
      history = await browserRpc(page, 'session.history', { sessionId, maxMessages: 30 })
      return history.events.some(({ event }) => event.type === 'turn/end')
    }, 'model-driven navigation turn completion', 45_000)
  } catch (error) {
    throw new Error(`${error.message}; scripted navigate model errors: ${model.failures.join(' | ') || 'none'}`)
  }
  assert.deepEqual(model.failures, [], 'scripted navigation model must receive valid browser observations')
  assert.equal(model.step, 2, 'Agent must navigate and complete its first turn')
  const firstEvents = history.events.map(({ event }) => event)
  const navigateCalls = firstEvents.filter(event => event.type === 'tool/call')
  assert.deepEqual(navigateCalls.map(event => event.data.name), ['browser_navigate'],
    'fresh Session must record the model browser_navigate tool call')
  const navigateResults = firstEvents.filter(event => event.type === 'tool/result')
  assert.deepEqual(navigateResults.map(event => event.data.message.content[0]?.isError), [false],
    'native browser_navigate must succeed through the shipped approval path')
  assert.equal(navigateResults[0].data.message.content[0]?.toolCallId, navigateCalls[0].data.callId,
    'navigation tool result must pair with the model call')
  assert.equal(firstEvents.findLast(event => event.type === 'turn/end')?.data.reason.kind, 'completed')
  const tabId = model.observations[0].tabId
  assert.ok(tabId, 'Agent navigation must produce a real browser tab id')

  // 轮次与工具租约结束后才验收视图；租约中原生 guest 可能有意退让。
  let state
  await until(async () => {
    const result = await browserRpcResponse(page, 'browser.control',
      { sessionId, command: { kind: 'ensure-tab' } })
    if (result?.error?.code === 'browser-failed' && result.error.details?.reason === 'BROWSER_BUSY') return false
    assert.equal(result.ok, true, `human browser control after turn: ${result?.error?.code ?? 'unknown'}`)
    state = result.value
    return state?.activeTabId === tabId
  }, 'navigation lease release and active tab')
  assert.deepEqual(state.tabs.map(tab => tab.id), [tabId],
    'auto-reveal must retain only the tab opened by the Agent')
  await page.getByRole('button', { name: '收起右侧边栏' }).first().waitFor({ state: 'visible' })
  const selected = page.locator(`[data-browser-tab-id="${tabId}"][aria-selected="true"]`)
  await selected.waitFor({ state: 'visible' })
  await page.getByTestId('browser-canvas').waitFor({ state: 'visible' })
  let guest
  await until(async () => {
    guest = await nativeGuest(app)
    return guest?.attached && guest.url === fixtureUrl && guest.title === 'Native guest fixture'
  }, 'Agent-navigated guest automatically visible in the right sidebar')
  const guestId = guest.id
  const guestPage = app.context().pages().find(candidate => !candidate.isClosed() && candidate.url() === fixtureUrl)
  assert.ok(guestPage, 'auto-revealed guest must remain an interactive Chromium target')
  await clickGuest(guestPage, '#human')
  await until(async () => await guestScript(app, guestId,
    'document.querySelector("#human-result").textContent') === 'Human clicked',
  'human mutation in Agent-navigated native guest', 10_000)

  model.startSnapshot()
  const second = await browserRpc(page, 'session.prompt', { sessionId, mode: 'queue',
    content: [{ type: 'text', text: 'Take a fresh browser snapshot to inspect my click.' }] })
  assert.equal(second.accepted, true, 'same Session must accept the second scripted Agent turn')
  try {
    await until(async () => {
      history = await browserRpc(page, 'session.history', { sessionId, maxMessages: 30 })
      return history.events.filter(({ event }) => event.type === 'turn/end').length >= 2
    }, 'second native snapshot turn completion', 45_000)
  } catch (error) {
    throw new Error(`${error.message}; scripted navigate model errors: ${model.failures.join(' | ') || 'none'}`)
  }
  assert.deepEqual(model.failures, [], 'second scripted model request must receive the human mutation')
  assert.equal(model.step, 2, 'Agent must snapshot and complete its second turn')
  assert.deepEqual(model.observations.map(observation => observation.tabId), [tabId, tabId],
    'second Agent snapshot must observe the same browser tab')
  assert.deepEqual(history.events.filter(({ event }) => event.type === 'tool/call')
    .map(({ event }) => event.data.name), ['browser_navigate', 'browser_snapshot'],
  'session log must record navigation and the later snapshot in order')
  assert.equal(await app.evaluate(({ webContents }, id) => {
    const current = webContents.fromId(id)
    return current && !current.isDestroyed() ? current.id : null
  }, guestId), guestId, 'human mutation and Agent snapshot must retain the same native guest')
  await until(async () => (await nativeGuest(app, guestId))?.attached,
    'original guest visible after second Agent turn')
  assert.equal(await guestScript(app, guestId, 'document.querySelector("#human-result").textContent'),
    'Human clicked', 'Agent snapshot must preserve the human-mutated DOM')
  assert.equal((await browserRpc(page, 'browser.control',
    { sessionId, command: { kind: 'close-tab', tabId } })), null,
  'closing the Agent-opened tab must release fresh Session browser resources')
  await until(async () => await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.isDestroyed() !== false,
    guestId), 'Agent-opened native guest destroyed')
  return sessionId
}

async function verifyAssistantLinkOpensNativeGuest(page, app, sessionId, fixture, model, hostOrigin) {
  // 同一当前会话先有一个页面，再收起右栏：链接必须新建页面并重新选择浏览器。
  const menu = page.getByRole('navigation', { name: '工作台功能' })
  await page.getByRole('button', { name: '添加工作台标签' }).click()
  await menu.getByRole('button', { name: '浏览器' }).click()
  await page.getByTestId('browser-canvas').waitFor({ state: 'visible' })
  const initial = await browserRpc(page, 'browser.control', { sessionId, command: { kind: 'ensure-tab' } })
  const oldTabId = initial.activeTabId
  assert.ok(oldTabId, 'current Session must have an existing browser tab')
  const address = page.getByRole('textbox', { name: '网址' })
  await address.fill(fixture.url)
  await address.press('Enter')
  await until(async () => (await browserRpc(page, 'browser.control',
    { sessionId, command: { kind: 'ensure-tab' } })).tabs.find(tab => tab.id === oldTabId)?.url === fixture.url,
  'existing Session browser page reaches local fixture')
  let oldGuest
  await until(async () => {
    oldGuest = await nativeGuest(app)
    return oldGuest?.attached && oldGuest.url === fixture.url
  }, 'existing native guest presented')
  const oldGuestId = oldGuest.id
  const oldPage = app.context().pages().find(candidate => !candidate.isClosed() && candidate.url() === fixture.url)
  assert.ok(oldPage, 'existing native guest must expose an interactive target')
  await clickGuest(oldPage, '#human')
  assert.equal(await guestScript(app, oldGuestId, 'document.querySelector("#human-result").textContent'),
    'Human clicked', 'existing guest must retain a distinguishable DOM mutation')
  await page.getByRole('button', { name: '收起右侧边栏' }).first().click()
  await page.getByRole('button', { name: '打开右侧边栏' }).first().waitFor({ state: 'visible' })
  await until(async () => await nativeGuest(app, oldGuestId) === null, 'old guest detached while sidebar hidden')

  const priorTurns = (await browserRpc(page, 'session.history', { sessionId, maxMessages: 100 }))
    .events.filter(({ event }) => event.type === 'turn/end').length
  const prompted = await browserRpc(page, 'session.prompt', { sessionId, mode: 'queue',
    content: [{ type: 'text', text: 'Offer the local fixture as an ordinary Markdown link.' }] })
  assert.equal(prompted.accepted, true, 'current Session must accept the scripted assistant link turn')
  let history
  try {
    await until(async () => {
      history = await browserRpc(page, 'session.history', { sessionId, maxMessages: 100 })
      return history.events.filter(({ event }) => event.type === 'turn/end').length > priorTurns
    }, 'scripted assistant Markdown turn completion', 45_000)
  } catch (error) {
    throw new Error(`${error.message}; scripted assistant link errors: ${model.failures.join(' | ') || 'none'}`)
  }
  assert.deepEqual(model.failures, [], 'scripted link model must serve the real Agent request')
  assert.equal(model.responses, 1, 'Agent must emit one ordinary Markdown link response')
  const link = page.getByRole('link', { name: '打开本地页面', exact: true })
  await link.waitFor({ state: 'visible' })
  assert.equal(await link.getAttribute('href'), fixture.assistantLinkUrl,
    'visible conversation anchor must retain the external-to-Host local fixture URL')
  assert.notEqual(new URL(fixture.assistantLinkUrl).origin, hostOrigin,
    'assistant link must not point back to the Host renderer')
  const before = await browserRpc(page, 'browser.control', { sessionId, command: { kind: 'ensure-tab' } })
  assert.equal(before.activeTabId, oldTabId)
  assert.deepEqual(before.tabs.map(tab => tab.id), [oldTabId], 'existing page must precede the assistant click')
  await page.evaluate(() => {
    window.__nativeSmokeWindowOpenCalls = 0
    window.__nativeSmokeOriginalOpen = window.open
    window.open = (...args) => {
      window.__nativeSmokeWindowOpenCalls++
      return window.__nativeSmokeOriginalOpen(...args)
    }
  })
  try {
    await link.click({ noWaitAfter: true })
    let opened
    await until(async () => {
      opened = await browserRpc(page, 'browser.control', { sessionId, command: { kind: 'ensure-tab' } })
      return opened.tabs.length === 2 && opened.activeTabId !== oldTabId &&
        opened.tabs.find(tab => tab.id === opened.activeTabId)?.url === fixture.assistantLinkUrl
    }, 'assistant click opens a new active Host browser tab')
    const newTabId = opened.activeTabId
    assert.equal(opened.tabs.find(tab => tab.id === oldTabId)?.url, fixture.url,
      'existing page must survive the assistant link')
    await page.getByRole('button', { name: '收起右侧边栏' }).first().waitFor({ state: 'visible' })
    await page.locator(`[data-browser-tab-id="${newTabId}"][aria-selected="true"]`).waitFor({ state: 'visible' })
    await page.getByTestId('browser-canvas').waitFor({ state: 'visible' })
    let newGuest
    await until(async () => {
      newGuest = await nativeGuest(app)
      return newGuest?.attached && newGuest.url === fixture.assistantLinkUrl &&
        newGuest.title === 'Native guest fixture'
    }, 'assistant link displayed in a main-owned native WebContentsView')
    assert.notEqual(newGuest.id, oldGuestId, 'link must use a new guest, not navigate the old page')
    assert.equal(await guestScript(app, newGuest.id, 'document.querySelector("#human-result").textContent'),
      'Waiting', 'new guest must load the local fixture document, not a renderer screenshot')
    assert.equal(await guestScript(app, oldGuestId, 'document.querySelector("#human-result").textContent'),
      'Human clicked', 'hidden old native guest DOM must remain intact')
    assert.equal(await page.locator('#human-result').count(), 0,
      'fixture DOM belongs to the native guest and must not be confused with Host renderer DOM')
    assert.equal(await page.getByTestId('browser-canvas').locator('img').count(), 0,
      'native guest presentation must not rely on a renderer screenshot')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1,
      'assistant link must not create another BrowserWindow')
    assert.equal(await page.evaluate(() => window.__nativeSmokeWindowOpenCalls), 0,
      'assistant link must not call renderer window.open')
    assert.equal(page.url(), `${hostOrigin}/`, 'assistant click must not navigate the Host renderer')
    await page.locator(`[data-browser-tab-id="${oldTabId}"]`).click()
    await until(async () => (await nativeGuest(app, oldGuestId))?.attached,
      'old native guest can still be selected after assistant link opens')
    await page.locator(`[data-browser-tab-id="${newTabId}"]`).click()
    await until(async () => (await nativeGuest(app, newGuest.id))?.attached,
      'new guest reselected without replacement')
    const rapidTabIds = await verifyRapidAssistantLinks(page, app, sessionId, fixture,
      [oldTabId, newTabId], [oldGuestId, newGuest.id])
    for (const tabId of [oldTabId, newTabId, ...rapidTabIds]) {
      const closed = await browserRpc(page, 'browser.control',
        { sessionId, command: { kind: 'close-tab', tabId } })
      if (tabId === rapidTabIds.at(-1)) {
        assert.equal(closed, null, 'closing all assistant-link test tabs releases this Session browser')
      }
    }
  } finally {
    await page.evaluate(() => {
      if (window.__nativeSmokeOriginalOpen !== undefined) window.open = window.__nativeSmokeOriginalOpen
      delete window.__nativeSmokeOriginalOpen
      delete window.__nativeSmokeWindowOpenCalls
    }).catch(() => undefined)
  }
}

async function verifyRapidAssistantLinks(page, app, sessionId, fixture, oldTabIds, oldGuestIds) {
  const pending = page.getByRole('link', { name: '打开慢速页面', exact: true })
  const repeated = page.getByRole('link', { name: '再次打开本地页面', exact: true })
  const latest = page.getByRole('link', { name: '第三次打开本地页面', exact: true })
  for (const link of [pending, repeated, latest]) await link.waitFor({ state: 'visible' })
  const dialogs = []
  const onDialog = dialog => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  }
  page.on('dialog', onDialog)
  try {
    await pending.click({ noWaitAfter: true })
    await until(() => Promise.resolve(fixture.pendingAssistantImages > 0),
      'first assistant link navigation starts loading its delayed image', 10_000)
    assert.equal(fixture.completedAssistantImages, 0,
      'first assistant link navigation must still be pending before rapid clicks')
    await repeated.click({ noWaitAfter: true })
    await latest.click({ noWaitAfter: true })
    assert.equal(fixture.completedAssistantImages, 0,
      'repeated assistant link clicks must arrive while the first navigation is pending')

    await until(async () => await page.locator('[data-browser-tab-id]').count() === 5 &&
      await page.locator('[data-browser-tab-id][aria-selected="true"]').count() === 1,
    'rapid assistant links settle as three additional browser tabs', 30_000)
    const settled = await browserRpc(page, 'browser.control',
      { sessionId, command: { kind: 'ensure-tab' } })
    assert.equal(fixture.completedAssistantImages, 1, 'first delayed navigation must finish')
    assert.deepEqual(settled.tabs.slice(0, 2).map(tab => tab.id), oldTabIds,
      'rapid clicks must retain both pre-existing tabs')
    assert.deepEqual(settled.tabs.slice(2).map(tab => tab.url),
      [fixture.pendingAssistantLinkUrl, fixture.assistantLinkUrl, fixture.assistantLinkUrl],
      'each rapid click, including a repeated URL, must create its own tab in click order')
    const rapidTabIds = settled.tabs.slice(2).map(tab => tab.id)
    assert.equal(new Set(settled.tabs.map(tab => tab.id)).size, 5,
      'rapid assistant links must not reuse an existing tab')
    assert.equal(settled.activeTabId, rapidTabIds[2],
      'the newest clicked assistant link must be selected after all navigation settles')
    await page.locator(`[data-browser-tab-id="${rapidTabIds[2]}"][aria-selected="true"]`)
      .waitFor({ state: 'visible' })
    const guestIds = []
    for (const [index, tabId] of rapidTabIds.entries()) {
      await page.locator(`[data-browser-tab-id="${tabId}"]`).click()
      let guest
      await until(async () => {
        guest = await nativeGuest(app)
        return guest?.attached && guest.url === settled.tabs[index + 2].url
      }, 'each rapid assistant tab presents its own native guest')
      guestIds.push(guest.id)
    }
    assert.equal(new Set([...oldGuestIds, ...guestIds]).size, 5,
      'all old and rapid assistant tabs must own distinct native guests')
    await page.locator(`[data-browser-tab-id="${rapidTabIds[2]}"]`).click()
    await until(async () => (await nativeGuest(app, guestIds[2]))?.attached,
      'newest rapid assistant guest restored after inspecting the other guests')
    assert.equal(await guestScript(app, oldGuestIds[0],
      'document.querySelector("#human-result").textContent'), 'Human clicked',
    'the original guest DOM must survive rapid assistant link navigation')
    assert.equal(await page.getByRole('dialog', { name: '无法打开链接' }).count(), 0,
      'rapid assistant links must not surface an error dialog')
    assert.equal(await page.getByText(/BROWSER_BUSY|BROWSER_FAILED/).count(), 0,
      'rapid assistant links must not surface browser busy or failed diagnostics')
    assert.deepEqual(dialogs, [], 'rapid assistant links must not open native dialogs')
    return rapidTabIds
  } finally {
    page.off('dialog', onDialog)
  }
}

async function verifyAgentTimeoutRecovery(page, app, sessionId, fixture, model) {
  const initial = await browserRpc(page, 'browser.control',
    { sessionId, command: { kind: 'ensure-tab' } })
  const tabId = initial.activeTabId
  await page.locator(`[data-browser-tab-id="${tabId}"]`).waitFor({ state: 'visible' })
  await page.locator(`[data-browser-tab-id="${tabId}"]`).click()
  const opened = await browserRpcResponse(page, 'browser.control',
    { sessionId, command: { kind: 'navigate', url: fixture.url } })
  if (!opened.ok) {
    assert.equal(opened.error?.details?.reason, 'BROWSER_STALE_REF',
      `stable guest navigation: ${JSON.stringify(opened.error)}`)
    const after = await browserRpc(page, 'browser.control',
      { sessionId, command: { kind: 'ensure-tab' } })
    assert.equal(after.activeTabId, tabId)
    assert.equal(after.tabs.find(tab => tab.id === tabId)?.url, fixture.url,
      'stale first capture must still leave the live local page in the original tab')
  } else assert.equal(opened.value.activeTabId, tabId)
  let guest
  await until(async () => {
    guest = await nativeGuest(app)
    return guest?.url === fixture.url && guest.title === 'Native guest fixture'
  }, 'stable guest before timeout navigation')
  const guestId = guest.id
  await page.getByRole('button', { name: '收起右侧边栏' }).first().click()
  await page.getByRole('button', { name: '打开右侧边栏' }).first().waitFor({ state: 'visible' })
  const priorTurns = (await browserRpc(page, 'session.history', { sessionId, maxMessages: 30 }))
    .events.filter(({ event }) => event.type === 'turn/end').length
  const prompted = await browserRpc(page, 'session.prompt', { sessionId, mode: 'queue',
    content: [{ type: 'text', text: 'Navigate to the stalled local fixture, then recover with a new snapshot.' }] })
  assert.equal(prompted.accepted, true, 'Agent must accept timeout recovery turn')
  try {
    await until(async () => {
      if (fixture.stalledRequests === 0) return false
      try {
        return await guestScript(app, guestId, `document.readyState !== 'loading' &&
          document.title === 'Native guest timeout fixture' &&
          document.body.innerText.includes('Timeout recovery fixture')`)
      } catch { return false }
    }, 'DOM ready while local image response remains stalled', 8_000)
  } catch (error) {
    const current = await app.evaluate(({ webContents }, id) => {
      const wc = webContents.fromId(id)
      return wc && !wc.isDestroyed() ? { url: wc.getURL(), loading: wc.isLoadingMainFrame() } : null
    }, guestId)
    throw new Error(`${error.message}; image requests=${fixture.stalledRequests}, guest=${JSON.stringify(current)}, ` +
      `model step=${model.step}, errors=${model.failures.join(' | ') || 'none'}`)
  }
  let history
  try {
    await until(async () => {
      history = await browserRpc(page, 'session.history', { sessionId, maxMessages: 30 })
      return history.events.filter(({ event }) => event.type === 'turn/end').length > priorTurns
    }, 'Agent timeout and fresh snapshot turn completion', 45_000)
  } catch (error) {
    throw new Error(`${error.message}; scripted timeout model errors: ${model.failures.join(' | ') || 'none'}`)
  }
  assert.deepEqual(model.failures, [], 'scripted recovery model must receive the timeout then fresh snapshot')
  assert.equal(model.step, 3, 'Agent must navigate, snapshot after timeout, then complete')
  const events = history.events.map(({ event }) => event)
  const calls = events.filter(event => event.type === 'tool/call').slice(-2)
  assert.deepEqual(calls.map(event => event.data.name), ['browser_navigate', 'browser_snapshot'],
    'Session must record actual model navigation and subsequent snapshot calls')
  const results = events.filter(event => event.type === 'tool/result').slice(-2)
  assert.deepEqual(results.map(event => event.data.message.content[0]?.isError), [true, false],
    'navigation must fail with a timeout while the fresh snapshot succeeds')
  assert.deepEqual(results.map(event => event.data.message.content[0]?.toolCallId),
    calls.map(event => event.data.callId), 'recovery tool results must pair with model calls')
  assert.equal(events.findLast(event => event.type === 'turn/end')?.data.reason.kind, 'completed')
  assert.equal(model.observations[0]?.tabId, tabId, 'fresh snapshot must retain the original browser tab')
  assert.equal(await app.evaluate(({ webContents }, id) => {
    const current = webContents.fromId(id)
    return current && !current.isDestroyed() ? current.id : null
  }, guestId), guestId, 'stopped navigation must retain the same native WebContentsView')
  let state
  await until(async () => {
    const result = await browserRpcResponse(page, 'browser.control',
      { sessionId, command: { kind: 'ensure-tab' } })
    if (result?.error?.code === 'browser-failed' && result.error.details?.reason === 'BROWSER_BUSY') return false
    assert.equal(result.ok, true, `human browser control after recovery: ${JSON.stringify(result.error)}`)
    state = result.value
    return state?.activeTabId === tabId
  }, 'timeout recovery lease release and original tab')
  assert.deepEqual(state.tabs.map(tab => tab.id), [tabId],
    'timeout recovery must not create a replacement tab')
  await page.getByRole('button', { name: '收起右侧边栏' }).first().waitFor({ state: 'visible' })
  await page.locator(`[data-browser-tab-id="${tabId}"][aria-selected="true"]`).waitFor({ state: 'visible' })
  await until(async () => (await nativeGuest(app, guestId))?.attached,
    'recoverable navigation timeout automatically reveals the original guest')
  assert.equal(await browserRpc(page, 'browser.control',
    { sessionId, command: { kind: 'close-tab', tabId } }), null,
  'closing recovered tab must release its browser resources')
}

async function main() {
  assert.equal(process.platform, 'darwin', 'native smoke currently requires macOS')
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--focus-only'),
    'only --focus-only is accepted')
  const focusOnly = process.argv[2] === '--focus-only'
  assert.ok(existsSync(entry), 'first run pnpm run build && pnpm run build:electron')

  const isolated = await mkdtemp(join(tmpdir(), 'dsh-electron-native-'))
  const home = join(isolated, 'home')
  const tmp = join(isolated, 'tmp')
  const hostHome = join(home, '.dsh-electron-dev')
  const workspace = join(hostHome, 'workspace')
  const userData = join(hostHome, 'electron-user-data')
  const screenshot = join(tmpdir(), `dsh-electron-native-${randomUUID()}.png`)
  const afterScreenshot = join(tmpdir(), `dsh-electron-native-focus-${randomUUID()}.png`)
  const remoteScreenshot = join(tmpdir(), `dsh-electron-native-remote-${randomUUID()}.png`)
  const restoredScreenshot = join(tmpdir(), `dsh-electron-native-restored-${randomUUID()}.png`)
  const terminalScreenshot = join(tmpdir(), `dsh-electron-native-terminal-${randomUUID()}.png`)
  const browserScreenshot = join(tmpdir(), `dsh-electron-native-browser-${randomUUID()}.png`)
  const guestScreenshot = join(tmpdir(), `dsh-electron-native-guest-${randomUUID()}.png`)
  let app
  let record
  let fixture
  let model
  let navigateModel
  let timeoutModel
  let assistantLinkModel
  let passed = false
  try {
    await Promise.all([home, tmp, workspace].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
    // 不继承用户凭据、Node/Electron 注入参数或现有 DSH_HOME；Host 不调用模型。
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      TMPDIR: tmp,
      USER: process.env.USER ?? '',
      LOGNAME: process.env.LOGNAME ?? '',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      DSH_HOME: hostHome,
      DSH_CWD: workspace,
      DSH_AGENTS_HOME: join(isolated, 'agents'),
    }
    app = await _electron.launch({ executablePath: electronExecutable, args: [entry], cwd: repositoryRoot,
      env, timeout: timeoutMs })
    const firstPage = await deadline(app.firstWindow(), 'first Host window')
    const windowHistory = [`first=${firstPage.url()}`]
    firstPage.on('close', () => windowHistory.push('first closed'))
    app.on('window', window => {
      windowHistory.push(`new=${window.url()}`)
      window.on('close', () => windowHistory.push('new closed'))
    })
    await until(async () => { record = await hostRecord(join(hostHome, 'host.json')); return record !== undefined },
      'managed Host discovery record')
    const origin = `http://127.0.0.1:${record.port}`
    // Chromium 站点隔离可能把初始 about:blank target 换成 Host target；不假定 firstWindow
    // 返回的 Page 在首导航后仍然有效。真正的 BrowserWindow 仍必须只有一个。
    let page
    try {
      await until(async () => {
        page = app.windows().find(candidate => !candidate.isClosed() && candidate.url() === `${origin}/`)
        return page !== undefined
      }, 'Host renderer target')
    } catch (error) {
      const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
        .catch(() => 'app disconnected')
      console.error(`Window navigation diagnostic: ${windowHistory.join(', ')}; ` +
        `targets=${app.windows().map(window => window.url()).join(', ')}; ` +
        `nativeWindowCount=${count}; appExitCode=${app.process().exitCode}`)
      throw error
    }
    const rendererErrors = []
    page.on('pageerror', error => rendererErrors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') rendererErrors.push(message.text())
    })
    await page.locator('[data-shell-overlay]').waitFor({ state: 'attached', timeout: timeoutMs })
    const bodyText = (await page.locator('body').innerText()).trim()
    assert.ok(bodyText.length > 20, 'real Host page must render meaningful content')
    assert.ok(!/vite.*error|internal server error/i.test(bodyText), 'no build-error overlay')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), true,
      'desktop window must open maximized without entering fullscreen')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), false,
      'maximized desktop window must remain a normal window')
    assert.equal(await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData')), userData)
    const dockIcon = await app.evaluate(({ app: electronApp }) => {
      const icon = electronApp.dock?.getIcon?.()
      return icon === undefined ? 'unavailable' : !icon.isEmpty()
    })
    if (dockIcon !== 'unavailable') assert.equal(dockIcon, true, 'macOS Dock icon must not be empty')
    else console.log('macOS Dock icon inspection is unavailable in this Electron runtime')
    const described = await describeHost(origin)
    assert.equal(described.version, 'dev')
    // macOS 的 /var 在 chdir 后会以 /private/var 的真实路径回报。
    assert.equal(described.cwd, await realpath(workspace))
    assert.equal(described.home, home)
    assert.equal(described.managedHostToken, record.token)
    await verifyWebSockets(page, origin)
    await verifyRemoteSshBridge(page)
    await page.screenshot({ path: screenshot })
    await verifyOnboardingFocus(page, afterScreenshot)
    model = await scriptedModel()
    await browserRpc(page, 'settings.update', { ns: 'llm-deepseek',
      patch: { baseURL: model.url, thinking: 'disabled', reasoningEffort: 'off' } })
    await browserRpc(page, 'credentials.set',
      { ref: 'DEEPSEEK_API_KEY', value: 'native-smoke-local-placeholder' })
    await browserRpc(page, 'settings.update', { ns: 'agent-default-model',
      patch: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
    await page.getByRole('dialog', { name: '配置模型，开始使用' }).waitFor({ state: 'hidden' })
    await verifyRemoteSshWizard(page, remoteScreenshot)
    if (focusOnly) {
      assert.equal(rendererErrors.length, 0, 'renderer should not report runtime errors')
      passed = true
      console.log(`PASS: native text input focus, no square inner outline, rounded SSH focus frame; ` +
        `screenshots: ${afterScreenshot}, ${remoteScreenshot}`)
      return
    }
    await browserRpc(page, 'settings.update', { ns: 'permission',
      patch: { defaultPreset: 'danger-full-access' } })
    const titlebarInteractionVerified = await verifyTitlebar(page, app)
    await verifyTerminalTabs(page, terminalScreenshot)
    fixture = await browserFixture()
    const recoverySessionId = await verifyNativeBrowser(page, app, fixture.url, origin,
      browserScreenshot, guestScreenshot, model)
    timeoutModel = await scriptedTimeoutRecoveryModel(fixture.timeoutUrl)
    await browserRpc(page, 'settings.update', { ns: 'llm-deepseek',
      patch: { baseURL: timeoutModel.url, thinking: 'disabled', reasoningEffort: 'off' } })
    await verifyAgentTimeoutRecovery(page, app, recoverySessionId, fixture, timeoutModel)
    navigateModel = await scriptedNavigateModel(fixture.url)
    await browserRpc(page, 'settings.update', { ns: 'llm-deepseek',
      patch: { baseURL: navigateModel.url, thinking: 'disabled', reasoningEffort: 'off' } })
    const linkSessionId = await verifyAgentNavigateAutoReveal(page, app, fixture.url, navigateModel)
    assistantLinkModel = await scriptedAssistantLinkModel(fixture.assistantLinkUrl,
      fixture.pendingAssistantLinkUrl)
    await browserRpc(page, 'settings.update', { ns: 'llm-deepseek',
      patch: { baseURL: assistantLinkModel.url, thinking: 'disabled', reasoningEffort: 'off' } })
    await verifyAssistantLinkOpensNativeGuest(page, app, linkSessionId, fixture, assistantLinkModel, origin)
    await verifyWindowBoundary(page, app, origin)

    const originalWindow = await app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows()
      return { count: windows.length, id: windows[0]?.id }
    })
    assert.equal(originalWindow.count, 1, 'first instance must own exactly one native window')
    assert.ok(Number.isSafeInteger(originalWindow.id), 'first instance must have a native window id')
    const nativeMenuVerified = await verifyNativeChrome(app, hostHome, record, origin, originalWindow.id)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
    await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
      'primary window minimized', 5_000)
    await secondLaunch(env)
    await until(() => app.evaluate(({ BrowserWindow }, originalId) => {
      const windows = BrowserWindow.getAllWindows()
      return windows.length === 1 && windows[0].id === originalId &&
        windows[0].isVisible() && !windows[0].isMinimized()
    }, originalWindow.id), 'second instance must restore the same visible native window', 10_000)
    const locked = screenLocked()
    if (locked === true) {
      console.log('foreground focus not verified: unlock and rerun')
    } else {
      if (locked === undefined) console.log('screen-lock probe unavailable; foreground focus still required')
      await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
        'second instance must focus the original window on an unlocked screen', 10_000)
    }
    assert.equal(page.url(), `${origin}/`)
    await page.screenshot({ path: restoredScreenshot })
    assert.equal(rendererErrors.length, 0, 'renderer should not report runtime errors')
    passed = true
    console.log(`PASS: Host page, HTTP, two WebSockets, onboarding focus, Remote-SSH bridge and wizard, window safety, ` +
      `native titlebar styling${titlebarInteractionVerified ? ', drag and double-click' : ' (physical drag and double-click unverified)'}, ` +
      `terminal tabs, native shared-session browser guest and auto-reveal, ${nativeMenuVerified ? 'native menu, ' : 'native menu hide unverified, '}` +
      `close-hide and Dock restore, single-instance restore` +
      `${locked === true ? ' (foreground focus unverified: screen locked)' : ' and focus'}; ` +
      `screenshots: ${screenshot}, ${afterScreenshot}, ${remoteScreenshot}, ${terminalScreenshot}, ${browserScreenshot}, ${guestScreenshot}, ${restoredScreenshot}`)
    console.log('PASS: scripted loopback model drove shipped Host browser_snapshot and browser_click on the human-operated native guest; Host origin/localhost navigation and guest subresource fetch denied; no external model API used')
    console.log('PASS: separate fresh Session browser_navigate auto-revealed its native guest and selected tab; a human click persisted into the next model browser_snapshot on the same guest')
    console.log('PASS: assistant Markdown links reopened the hidden sidebar, preserved old native guests, and queued rapid repeated clicks as distinct tabs with the newest selected, without window.open or dialogs')
    console.log('PASS: stalled local image timed out browser_navigate, stopped loading safely, and the same Electron guest/tab yielded a fresh Agent browser_snapshot')
  } finally {
    if (!passed && existsSync(screenshot)) console.error(`Failure screenshot: ${screenshot}`)
    if (!passed && existsSync(afterScreenshot)) console.error(`Focus screenshot: ${afterScreenshot}`)
    if (!passed && existsSync(remoteScreenshot)) console.error(`Remote-SSH screenshot: ${remoteScreenshot}`)
    if (!passed && existsSync(terminalScreenshot)) console.error(`Terminal screenshot: ${terminalScreenshot}`)
    if (!passed && existsSync(browserScreenshot)) console.error(`Browser screenshot: ${browserScreenshot}`)
    if (!passed && existsSync(guestScreenshot)) console.error(`Guest screenshot: ${guestScreenshot}`)
    if (!passed && existsSync(restoredScreenshot)) console.error(`Restored screenshot: ${restoredScreenshot}`)
    if (fixture !== undefined) await fixture.close()
    if (model !== undefined) await model.close()
    if (navigateModel !== undefined) await navigateModel.close()
    if (timeoutModel !== undefined) await timeoutModel.close()
    if (assistantLinkModel !== undefined) await assistantLinkModel.close()
    if (app !== undefined) await closeOwnApp(app)
    // 未能证明 Host 所有权或无法等到其退出时保留 HOME，避免删掉仍运行的 Host 的数据。
    let safeToClean = false
    try {
      safeToClean = await stopVerifiedHost(hostHome, record)
    } catch { /* 不可信的记录或竞态一律保留隔离目录。 */ }
    if (safeToClean) await rm(isolated, { recursive: true, force: true })
    else console.warn(`Test HOME preserved while Host ownership/lifecycle is uncertain: ${isolated}`)
  }
}

main().catch(error => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
