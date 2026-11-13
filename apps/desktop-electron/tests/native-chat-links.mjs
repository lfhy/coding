/**
 * 显式 opt-in 的原生链接验收：隔离开发 Electron、Host 与浏览器状态，点击真实 Assistant 消息。
 * 不启动模型，不使用现有桌面实例；失败时保留无法确认已停机的测试目录。
 */
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '../../../vendor/cordis/lib/index.js'
import { Session, SessionId, SessionStore, SESSION_FORMAT_VERSION } from '../../../packages/core/session/lib/index.js'
import JsonlSessionPersistence from '../../../packages/session/session-persistence-jsonl/lib/index.js'
import { createMessage, createUserMessage } from '../../../packages/llm/llm/lib/index.js'
import electronExecutable from 'electron'
import { _electron } from 'playwright'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const entry = join(root, 'apps/desktop-electron/lib/main.js')
const packagedSource = join(root, 'dist/Coding.app')
const packaged = process.argv[2] === '--packaged'
if (process.argv.length > 3 || (process.argv[2] !== undefined && !packaged)) {
  throw new Error('usage: native-chat-links.mjs [--packaged]')
}
const egoCli = join(root, 'packages/browser/browser-ego-host/runtime/ego-linux/bin/ego-browser.mjs')
const sessionId = SessionId('native-chat-links-fixture')
const title = '原生链接验收'
const exec = promisify(execFile)

/** 每次等待有独立期限，不把首次浏览器启动误判为立即失败。 */
async function until(check, label, timeout = 90_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`${label} timed out`)
}

async function bounded(promise, label, timeout = 10_000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout)
    })])
  } finally { clearTimeout(timer) }
}

/** 以正式持久化接口预置关闭的会话，Host 首次打开时会真实恢复其消息。 */
async function seedSession(hostHome, workspace, link) {
  const session = Session.create(sessionId)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '打开本地测试页面' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title, messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      content: [{ type: 'text', text: `[打开测试页面](${link})` }] }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const seeder = new Context()
  try {
    await seeder.plugin(SessionStore)
    await seeder.plugin(JsonlSessionPersistence, { root: join(hostHome, 'sessions') })
    await seeder.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: Date.now() - 60_000,
      cwd: workspace, delegationDepth: 0,
    })
    await seeder.sessionPersistence.append(sessionId, session.events)
  } finally { await seeder.fiber.dispose() }
}

async function hostRecord(hostHome) {
  try {
    const value = JSON.parse(await readFile(join(hostHome, 'host.json'), 'utf8'))
    const version = packaged
      ? JSON.parse(await readFile(join(packagedSource, 'Contents/Resources/metadata.json'), 'utf8')).version
      : 'dev'
    if (value.type === 'coding-host-ready' && value.protocol === 1 && value.version === version
      && Number.isSafeInteger(value.pid) && value.pid > 0
      && Number.isSafeInteger(value.port) && value.port > 0 && value.port <= 65535
      && typeof value.token === 'string' && value.token.length > 0) return value
    throw new Error('invalid isolated Host record')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error('invalid isolated Host record')
  }
}

/** 每次清理前用当前记录与在线 Host 双重核对所有权。 */
async function describeHost(origin) {
  const rpcId = randomUUID()
  const response = await fetch(`${origin}/api/host.describe`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'host.describe', payload: {} }),
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.rpcId, rpcId)
  assert.equal(result.result?.ok, true)
  return result.result.value
}

async function rpc(page, method, payload) {
  const result = await page.evaluate(async ({ method, payload, rpcId }) => {
    const response = await fetch(`/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
    return { status: response.status, body: await response.json() }
  }, { method, payload, rpcId: randomUUID() })
  assert.equal(result.status, 200, `${method} HTTP status`)
  assert.equal(result.body.result?.ok, true, `${method} RPC result`)
  return result.body.result.value
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0) } catch (error) { return error.code !== 'ESRCH' }
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' })
  return result.status !== 0 || !result.stdout.trim().startsWith('Z')
}

/** 进程扫描只用于核对本测试的浏览器档案，不对扫描到的 PID 发信号。 */
function processCommand(pid) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

async function statePid(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    return Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : null
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error('invalid isolated process record')
  }
}

async function stopApp(app) {
  const child = app.process()
  try { await bounded(app.close(), 'Electron shutdown', 20_000) }
  catch { /* 仅终止本测试直接启动且仍持有子进程句柄的 Electron。 */ }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  try {
    await until(() => child.exitCode !== null || child.signalCode !== null, 'Electron exit', 5000)
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await until(() => child.exitCode !== null || child.signalCode !== null, 'Electron forced exit', 3000).catch(() => {})
  }
  return child.exitCode !== null || child.signalCode !== null
}

/** Electron/helper 正常退出后等待 Host；不对无子进程句柄的裸 PID 发信号。 */
async function hostStopped(hostHome, expected) {
  if (expected === null) return await hostRecord(hostHome) === null
  const current = await hostRecord(hostHome)
  if (current && (current.pid !== expected.pid || current.port !== expected.port
    || current.token !== expected.token)) return false
  try { await until(() => !alive(expected.pid), 'isolated Host exit', 12_000); return true }
  catch { return false }
}

async function main() {
  assert.equal(process.platform, 'darwin', 'native link test requires macOS')
  const isolated = packaged
    ? await mkdtemp('/tmp/coding-links-')
    : await mkdtemp(join(tmpdir(), 'coding-native-chat-links-'))
  const home = join(isolated, 'home')
  const temporary = join(isolated, 'tmp')
  const hostHome = join(home, packaged ? '.coding' : '.dsh-electron-dev')
  const workspace = packaged ? home : join(hostHome, 'workspace')
  const browserState = join(isolated, 'browser')
  let app, record, server, passed = false
  let loadedPage = false
  let link = ''
  try {
    await Promise.all([home, temporary, workspace, browserState].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
    server = createServer((request, response) => {
      if (request.url === '/page') loadedPage = true
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><head><title>Sidebar destination</title></head><body>Ready</body></html>')
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    link = `http://127.0.0.1:${address.port}/page`
    const cwd = await realpath(workspace)
    if (!packaged) await seedSession(hostHome, cwd, link)
    // 生产包复制到短临时路径：Go 单实例锁的 Unix socket 有系统路径长度上限。
    if (packaged) {
      await cp(packagedSource, join(isolated, 'Coding.app'), {
        recursive: true, force: false, verbatimSymlinks: true,
      })
      const signature = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(isolated, 'Coding.app')])
      assert.equal(signature.status, 0, 'isolated packaged app signature')
    }
    // 测试 HOME、浏览器目录和执行环境均与用户正在运行的实例隔离。
    const env = packaged
      ? {
        HOME: home, TMPDIR: temporary, PATH: '/usr/bin:/bin:/usr/sbin',
        USER: process.env.USER ?? '', LOGNAME: process.env.LOGNAME ?? '', LANG: 'zh_CN.UTF-8',
        EGO_LINUX_STATE_DIR: browserState, EGO_LINUX_PROFILE: join(browserState, 'profile'),
        XDG_STATE_HOME: join(isolated, 'state'), EGO_LINUX_HEADLESS: '1',
      }
      : {
        HOME: home, TMPDIR: temporary, PATH: process.env.PATH ?? '/usr/bin:/bin',
        USER: process.env.USER ?? '', LOGNAME: process.env.LOGNAME ?? '', LANG: 'zh_CN.UTF-8',
        DSH_HOME: hostHome, DSH_CWD: workspace, DSH_AGENTS_HOME: join(isolated, 'agents'),
        EGO_LINUX_STATE_DIR: browserState, EGO_LINUX_PROFILE: join(browserState, 'profile'),
        EGO_LINUX_HEADLESS: '1',
      }
    const executable = packaged ? join(isolated, 'Coding.app/Contents/MacOS/Coding') : electronExecutable
    app = await _electron.launch({ executablePath: executable,
      args: packaged ? [`--user-data-dir=${join(home, '.dsh-electron-user-data')}`] : [entry],
      cwd: root, env, timeout: 30_000 })
    await bounded(app.firstWindow(), 'first Electron window', 60_000)
    await until(async () => { record = await hostRecord(hostHome); return record !== null }, 'isolated Host record')
    const origin = `http://127.0.0.1:${record.port}`
    assert.equal((await describeHost(origin)).managedHostToken, record.token)
    let page
    await until(() => {
      page = app.windows().find(candidate => !candidate.isClosed() && candidate.url() === `${origin}/`)
      return page !== undefined
    }, 'Host renderer')
    await page.locator('[data-shell-overlay]').waitFor({ state: 'attached', timeout: 30_000 })
    if (packaged) await seedSession(hostHome, cwd, link)
    const workspaceResult = await rpc(page, 'workspace.create', { path: cwd })
    await rpc(page, 'session.create', { workspaceId: workspaceResult.workspace.workspaceId, sessionId })
    // RPC 从测试端写入；重新载入 Client 才能从 Host 的会话台账建立本地搜索索引。
    await page.reload()
    await page.locator('[data-shell-overlay]').waitFor({ state: 'attached', timeout: 30_000 })
    const search = page.getByRole('button', { name: /^(搜索会话|Search sessions)$/u })
    if (await search.getAttribute('aria-expanded') !== 'true') await search.click()
    await page.getByPlaceholder(/搜索会话|Search sessions/u).fill(title)
    const result = page.getByRole('tree', { name: /搜索结果|Search results/u }).getByRole('treeitem')
    await result.first().waitFor({ state: 'visible', timeout: 15_000 })
    await result.first().click()
    await page.getByRole('button', { name: /清除搜索|Clear search/u }).click()
    const assistantLink = page.getByRole('link', { name: '打开测试页面' })
    await assistantLink.waitFor({ state: 'visible', timeout: 15_000 })
    const popup = []
    const responses = []
    page.on('popup', item => popup.push(item))
    page.on('response', response => {
      const pathname = new URL(response.url()).pathname
      if (pathname === '/api/ego/pages' || pathname === '/api/ego/navigation') {
        responses.push({ pathname, status: response.status() })
      }
    })
    await assistantLink.click()
    const addressField = page.getByRole('region', { name: /Agent 浏览器|Agent Browser/u })
      .getByRole('textbox', { name: /网页地址|Web address/u })
    try {
      await until(async () => {
        const failure = page.getByRole('dialog', { name: /无法打开链接|Couldn.t open link/u })
        if (await failure.count() && await failure.isVisible()) throw new Error('link failure dialog opened')
        return await addressField.count() > 0 && await addressField.isVisible()
          && await addressField.inputValue() === link && loadedPage
      }, 'Assistant link in right sidebar', 100_000)
    } catch (error) {
      throw new Error(`${error.message}; browser routes: ${JSON.stringify(responses)}`)
    }
    const panel = addressField.locator('xpath=ancestor::*[@role="tabpanel"]')
    assert.equal(await panel.isVisible(), true, 'right-sidebar browser panel must be visible')
    const tabId = await panel.getAttribute('aria-labelledby')
    assert.ok(tabId, 'browser tab must label its panel')
    assert.equal(await page.locator('[role="tab"][aria-selected="true"]')
      .evaluateAll((tabs, id) => tabs.some(tab => tab.id === id), tabId), true)
    assert.equal(loadedPage, true, 'backing browser must load the requested document')
    assert.deepEqual(responses.filter(item => item.pathname === '/api/ego/pages').map(item => item.status), [200])
    assert.deepEqual(responses.filter(item => item.pathname === '/api/ego/navigation').map(item => item.status), [200])
    assert.equal(popup.length, 0, 'link must not open an independent Electron window')
    assert.equal(page.url(), `${origin}/`, 'desktop Host renderer must remain open')
    passed = true
    console.log('PASS: Assistant link opened in the native right-sidebar Agent browser')
  } finally {
    const browserPid = await statePid(join(browserState, 'browser.json')).catch(() => -1)
    const workerPid = await statePid(join(browserState, 'ego-cast.json')).catch(() => -1)
    const canonicalApp = packaged ? await realpath(join(isolated, 'Coding.app')).catch(() => null) : null
    const browserOwned = browserPid !== -1 && (browserPid === null
      || processCommand(browserPid).includes(`--user-data-dir=${join(browserState, 'profile')}`))
    const workerEntry = canonicalApp
      ? join(canonicalApp, 'Contents/Resources/runtime/node_modules/coding-browser-ego-host/bin/ego-cast-worker.mjs')
      : join(root, 'packages/browser/browser-ego-host/bin/ego-cast-worker.mjs')
    const workerOwned = workerPid !== -1 && (workerPid === null
      || (!packaged || canonicalApp !== null) && processCommand(workerPid).includes(workerEntry))
    const appStopped = app ? await stopApp(app).catch(() => false) : true
    const hostExited = await hostStopped(hostHome, record).catch(() => false)
    let browserStopped = false
    if (browserOwned) {
      try {
        await exec(process.execPath, [egoCli, '--stop'], {
          env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin', EGO_LINUX_STATE_DIR: browserState,
            EGO_LINUX_PROFILE: join(browserState, 'profile'), EGO_LINUX_HEADLESS: '1' }, timeout: 10_000,
        })
        if (browserPid !== null) await until(() => !alive(browserPid), 'isolated browser exit', 12_000)
        browserStopped = browserPid === null || !alive(browserPid)
      } catch { /* 浏览器清理不确定时保留隔离目录。 */ }
    }
    let workerStopped = workerOwned
    if (workerPid !== null && workerOwned) {
      try { await until(() => !alive(workerPid), 'isolated worker exit', 12_000) }
      catch { workerStopped = false }
    }
    if (server) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
    if (appStopped && hostExited && browserStopped && workerStopped) await rm(isolated, { recursive: true, force: true })
    else console.warn(`Isolated test HOME preserved because shutdown is uncertain: ${isolated}; `
      + `appStopped=${appStopped} hostExited=${hostExited} browserOwned=${browserOwned} `
      + `browserStopped=${browserStopped} workerOwned=${workerOwned} workerStopped=${workerStopped}`)
    if (passed) assert.ok(appStopped && hostExited && browserStopped && workerStopped, 'isolated processes must stop')
  }
}

main().catch(error => { console.error(`FAIL: ${error.stack ?? error}`); process.exitCode = 1 })
