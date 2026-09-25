/**
 * 显式 opt-in 的 macOS 原生冒烟：先构建 Host/Web 与 Electron，再直接用 Node 运行本文件。
 * 不使用 *.spec.* 命名，避免根 Vitest 的 keyless 套件意外启动 GUI。
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
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
      outline: style.outlineColor,
      outlineStyle: style.outlineStyle,
      business,
      expectedShadow: shadow,
    }
  })
  assert.equal(colors.focused, true, `${name} input must receive actual keyboard focus`)
  assert.notEqual(colors.business, 'rgb(0, 0, 0)', `${name} business theme token must not resolve to black`)
  assert.equal(colors.border, colors.business, `${name} focus border must use business blue, not black`)
  assert.equal(colors.shadow, colors.expectedShadow, `${name} focus shadow must use business blue`)
  if (colors.outlineStyle !== 'none') {
    assert.equal(colors.outline, colors.business, `${name} focus outline must use business blue, not black`)
  }
}

async function verifyOnboardingFocus(page, afterScreenshot) {
  const dialog = page.getByRole('dialog', { name: '添加一个 API Key 开始使用' })
  await dialog.waitFor({ state: 'visible', timeout: timeoutMs })
  const credential = dialog.locator('input[type="password"][aria-label="API 密钥"]')
  const channel = dialog.getByLabel('渠道名称', { exact: true })
  const baseUrl = dialog.getByLabel('API 地址', { exact: true })

  // 首次打开应把焦点给密钥字段，但不会读取、填写或提交任何凭据。
  await until(() => credential.evaluate(input => document.activeElement === input),
    'API Key first-run autofocus', 5_000)
  await assertBlueFocusedField(credential, 'API Key')

  assert.equal(await channel.inputValue(), 'default', 'channel name must initially be default')
  await channel.click()
  await assertBlueFocusedField(channel, 'channel name')
  await channel.fill('smoke-local')
  assert.equal(await channel.inputValue(), 'smoke-local', 'channel name must be locally editable without saving')
  await channel.fill('default')

  await baseUrl.click()
  await assertBlueFocusedField(baseUrl, 'API URL')
  await page.screenshot({ path: afterScreenshot })
}

async function main() {
  assert.equal(process.platform, 'darwin', 'native smoke currently requires macOS')
  assert.ok(existsSync(entry), 'first run pnpm run build && pnpm run build:electron')

  const isolated = await mkdtemp(join(tmpdir(), 'dsh-electron-native-'))
  const home = join(isolated, 'home')
  const tmp = join(isolated, 'tmp')
  const hostHome = join(home, '.dsh-electron-dev')
  const workspace = join(hostHome, 'workspace')
  const userData = join(hostHome, 'electron-user-data')
  const screenshot = join(tmpdir(), `dsh-electron-native-${randomUUID()}.png`)
  const afterScreenshot = join(tmpdir(), `dsh-electron-native-focus-${randomUUID()}.png`)
  let app
  let record
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
    await page.screenshot({ path: screenshot })
    await verifyOnboardingFocus(page, afterScreenshot)
    await verifyWindowBoundary(page, app, origin)

    const originalWindow = await app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows()
      return { count: windows.length, id: windows[0]?.id }
    })
    assert.equal(originalWindow.count, 1, 'first instance must own exactly one native window')
    assert.ok(Number.isSafeInteger(originalWindow.id), 'first instance must have a native window id')
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
    assert.equal(rendererErrors.length, 0, 'renderer should not report runtime errors')
    passed = true
    console.log(`PASS: Host page, HTTP, two WebSockets, onboarding focus, window safety, ` +
      `single-instance restore${locked === true ? ' (foreground focus unverified: screen locked)' : ' and focus'}; ` +
      `screenshots: ${screenshot}, ${afterScreenshot}`)
  } finally {
    if (!passed && existsSync(screenshot)) console.error(`Failure screenshot: ${screenshot}`)
    if (!passed && existsSync(afterScreenshot)) console.error(`Focus screenshot: ${afterScreenshot}`)
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
