/**
 * 显式 opt-in 的基础 SSH 原生验收；仅连接本进程启动、禁止端口转发的回环 fixture。
 * 凭据只在内存中传递；失败日志仅包含固定阶段，不输出 SSH 输入或 bridge token。
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '../../../vendor/cordis/lib/index.js'
import { Session, SessionId, SessionStore, SESSION_FORMAT_VERSION } from '../../../packages/core/session/lib/index.js'
import JsonlSessionPersistence from '../../../packages/session/session-persistence-jsonl/lib/index.js'
import { createMessage, createUserMessage } from '../../../packages/llm/llm/lib/index.js'
import electronExecutable from 'electron'
import { _electron } from 'playwright'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const entry = join(root, 'apps/desktop-electron/lib/main.js')
const timeout = 90_000

async function bounded(promise, stage, ms = timeout) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${stage}: timed out`)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function until(check, stage, ms = timeout) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`${stage}: timed out`)
}

function safeEnvironment(home, temporary) {
  // 不继承 SSH agent、用户配置或 API key，且图形会话只需 DISPLAY。
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: temporary,
    LANG: 'zh_CN.UTF-8',
    USER: 'coding-e2e',
    LOGNAME: 'coding-e2e',
    ...process.env.DISPLAY === undefined ? {} : { DISPLAY: process.env.DISPLAY },
  }
}

async function buildFixture(binary, env) {
  const moduleCache = process.env.GOMODCACHE ?? join(process.env.GOPATH ?? join(process.env.HOME, 'go'), 'pkg/mod')
  const child = spawn('go', ['build', '-tags', 'remote_ssh_e2e', '-o', binary, './cmd/ssh-fixture'], {
    cwd: join(root, 'apps/desktop'),
    env: { ...env, CGO_ENABLED: '0', GOMODCACHE: moduleCache, GOCACHE: join(env.TMPDIR, 'go-build') },
    stdio: 'ignore',
  })
  const code = await bounded(new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Go fixture build could not start')))
    child.once('exit', resolve)
  }), 'Go fixture build', 180_000)
  assert.equal(code, 0, 'Go SSH fixture build failed')
}

async function startFixture(binary, env) {
  const child = spawn(binary, ['--no-forwarding'], {
    cwd: join(root, 'apps/desktop'), env, stdio: ['pipe', 'pipe', 'ignore'],
  })
  try {
    const ready = await bounded(new Promise((resolve, reject) => {
      let line = ''
      child.once('error', () => reject(new Error('SSH fixture could not start')))
      child.once('exit', () => reject(new Error('SSH fixture exited before ready')))
      child.stdout.on('data', chunk => {
        line += chunk.toString('utf8')
        if (line.length > 4096) { reject(new Error('SSH fixture ready frame is oversized')); return }
        const end = line.indexOf('\n')
        if (end < 0) return
        try { resolve(JSON.parse(line.slice(0, end))) }
        catch { reject(new Error('SSH fixture ready frame is invalid')) }
      })
    }), 'SSH fixture ready')
    assert.equal(ready.host, '127.0.0.1')
    assert.ok(Number.isSafeInteger(ready.port) && ready.port > 0 && ready.port <= 65535)
    assert.ok(typeof ready.username === 'string' && ready.username.length > 0)
    assert.ok(typeof ready.password === 'string' && ready.password.length > 0)
    assert.ok(typeof ready.remoteRoot === 'string' && posix.isAbsolute(ready.remoteRoot))
    ready.remoteRoot = await realpath(ready.remoteRoot)
    return { child, ready }
  } catch (error) {
    await stopChild(child)
    throw error
  }
}

async function stopChild(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
  child.stdin?.end()
  try { await bounded(new Promise(resolve => child.once('exit', resolve)), 'fixture shutdown', 5_000) }
  catch {
    child.kill('SIGTERM')
    try { await bounded(new Promise(resolve => child.once('exit', resolve)), 'fixture termination', 3_000) }
    catch { child.kill('SIGKILL') }
  }
}

async function hostRecord(home) {
  try {
    const record = JSON.parse(await readFile(join(home, 'host.json'), 'utf8'))
    if (record.type === 'coding-host-ready' && record.protocol === 1 && record.version === 'dev' &&
      Number.isSafeInteger(record.pid) && Number.isSafeInteger(record.port) && record.port > 0 &&
      typeof record.token === 'string' && record.token.length > 0) return record
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return undefined
}

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code === 'EPERM' }
}

async function rpc(page, method, payload) {
  const envelope = await page.evaluate(async ({ method, payload, rpcId }) => {
    const response = await fetch(`/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
    return { status: response.status, body: await response.json() }
  }, { method, payload, rpcId: randomUUID() })
  assert.equal(envelope.status, 200, `${method} HTTP status`)
  assert.equal(envelope.body.type, 'server-response')
  assert.equal(envelope.body.result?.ok, true, `${method} RPC result`)
  return envelope.body.result.value
}

async function workspaceRequest(page, route, payload) {
  const result = await page.evaluate(async ({ route, payload }) => {
    const response = await fetch(route, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })
    return { status: response.status, body: await response.json() }
  }, { route, payload })
  assert.equal(result.status, 200, `${route} HTTP status`)
  return result.body
}

async function selectRemoteRoot(wizard, remoteRoot, setStage) {
  setStage('open directory')
  await wizard.getByRole('button', { name: '选择远程目录' }).last().click()
  const pathLabel = wizard.locator('div[title]').first()
  await until(async () => Boolean(await pathLabel.getAttribute('title')), 'initial remote directory')
  let current = await pathLabel.getAttribute('title')
  for (let step = 0; step < 32 && current !== remoteRoot; step++) {
    setStage('navigate directory')
    if (!remoteRoot.startsWith(`${current.replace(/\/$/, '')}/`)) {
      await wizard.getByRole('button', { name: '上一级' }).click()
    } else {
      const next = posix.relative(current, remoteRoot).split('/')[0]
      await wizard.getByRole('button', { name: next, exact: true }).click()
    }
    await until(async () => (await pathLabel.getAttribute('title')) !== current, 'remote directory navigation')
    current = await pathLabel.getAttribute('title')
  }
  assert.equal(current, remoteRoot, 'UI directory selection must reach fixture root')
  setStage('select directory and create workspace')
  await wizard.getByRole('button', { name: '选择此文件夹' }).click()
  await wizard.waitFor({ state: 'hidden' })
}

async function hostKeyPromptState(wizard) {
  const accept = wizard.getByRole('button', { name: '信任并继续' })
  const alerts = await wizard.getByRole('alert').allTextContents()
  const alert = alerts.join(' ')
  const errorKind = !alert ? 'none'
    : /远程连接桌面桥接响应无效|桌面端返回了无效的远程连接响应|Invalid Remote-SSH response/i.test(alert) ? 'response-contract'
    : /authentication failed|unable to authenticate|permission denied/i.test(alert) ? 'authentication'
      : /known_hosts|host.key|fingerprint/i.test(alert) ? 'host-key'
        : /SSH handshake|connection refused|dial tcp|timeout|timed out/i.test(alert) ? 'transport'
          : /Remote-SSH IPC|bridge|helper/i.test(alert) ? 'desktop-bridge'
            : 'other'
  return {
    prompt: await accept.isVisible().catch(() => false),
    errorKind,
    ready: await wizard.getByRole('button', { name: '选择远程目录' }).last().isVisible().catch(() => false),
  }
}

async function connectInWizard(page, ready, setStage) {
  setStage('open wizard')
  await page.getByRole('button', { name: '选择工作区' }).first().click()
  await page.getByText('远程连接', { exact: true }).first().click()
  const wizard = page.getByRole('dialog', { name: '远程连接' })
  await wizard.waitFor({ state: 'visible' })
  assert.equal(await wizard.getByRole('radio', { name: /基础模式/ }).isChecked(), true,
    'the default remote connection mode must be basic')
  await wizard.locator('#remote-ssh-host').fill(ready.host)
  await wizard.locator('#remote-ssh-port').fill(String(ready.port))
  await wizard.locator('#remote-ssh-user').fill(ready.username)
  await wizard.locator('#remote-ssh-secret').fill(ready.password)
  setStage('connect SSH')
  await wizard.getByRole('button', { name: '连接', exact: true }).click()
  setStage('unknown host prompt')
  // 此处等待交互态而非整句文案；失败诊断只输出枚举，不记录可能包含连接材料的原始 UI 文本。
  try {
    await until(async () => {
      const state = await hostKeyPromptState(wizard)
      return state.prompt || state.errorKind !== 'none' || state.ready
    }, 'unknown host prompt')
    const state = await hostKeyPromptState(wizard)
    if (!state.prompt) throw new Error('prompt absent')
    assert.match(await wizard.innerText(), /SHA256:/)
  } catch {
    const state = await hostKeyPromptState(wizard).catch(() => ({ prompt: false, errorKind: 'unavailable', ready: false }))
    throw new Error(`unknown host prompt unavailable (prompt=${state.prompt}, error=${state.errorKind}, ready=${state.ready})`)
  }
  setStage('accept host key')
  await wizard.getByRole('button', { name: '信任并继续' }).click()
  setStage('basic SSH ready')
  await wizard.getByRole('button', { name: '选择远程目录' }).last().waitFor({ state: 'visible' })
  await selectRemoteRoot(wizard, ready.remoteRoot, setStage)
}

async function markerIn(home) {
  const base = join(home, 'remote-workspaces')
  const targets = await readdir(base)
  assert.equal(targets.length, 1, 'only the fixture host has a marker target')
  const folders = await readdir(join(base, targets[0]))
  assert.equal(folders.length, 1, 'only the selected root has a marker')
  const path = await realpath(join(base, targets[0], folders[0]))
  const marker = JSON.parse(await readFile(join(path, '.coding-remote-workspace.json'), 'utf8'))
  assert.equal(marker.version, 3)
  assert.equal(marker.mode, 'basic')
  return { path, marker }
}

async function terminalProof(page, sessionId, remoteRoot) {
  const suffix = randomUUID().replaceAll('-', '')
  const proof = await page.evaluate(async ({ sessionId, suffix }) => new Promise((resolve, reject) => {
    const url = `${location.origin.replace(/^http/, 'ws')}/open-in-app/terminal?sessionId=${encodeURIComponent(sessionId)}&cols=80&rows=24`
    const socket = new WebSocket(url)
    const expected = `BASIC_PARITY_${suffix}`
    let output = ''
    const timer = setTimeout(() => { socket.close(); reject(new Error('basic terminal proof timed out')) }, 30_000)
    socket.onerror = () => { clearTimeout(timer); reject(new Error('basic terminal WebSocket failed')) }
    socket.onmessage = event => {
      const frame = JSON.parse(event.data)
      if (frame.type === 'error') { clearTimeout(timer); socket.close(); reject(new Error('basic terminal failed')) }
      if (frame.type === 'ready') {
        socket.send(JSON.stringify({ type: 'resize', cols: 113, rows: 41 }))
        socket.send(JSON.stringify({ type: 'input', data: `stty size; pwd -P; printf 'BASIC_%s\\n' 'PARITY_${suffix}'\r` }))
      }
      if (frame.type === 'output') {
        output += frame.data
        if (output.includes(expected) && /41\s+113/.test(output)) {
          clearTimeout(timer)
          socket.send(JSON.stringify({ type: 'close' }))
          resolve(output)
        }
      }
    }
  }), { sessionId, suffix })
  assert.match(proof, /41\s+113/, 'basic remote PTY must apply resize')
  assert.ok(proof.includes(remoteRoot), 'basic remote PTY cwd must be the selected root')
}

async function closeOwnApp(app) {
  if (app === undefined) return
  const child = app.process()
  try { await bounded(app.close(), 'Electron shutdown', 10_000) }
  catch { /* 只收敛本测试启动的 Electron 子进程。 */ }
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try { await bounded(new Promise(resolve => child.once('exit', resolve)), 'Electron termination', 2_000) }
  catch { child.kill('SIGKILL') }
}

async function stopOwnHost(home, record) {
  if (record === undefined) return (await hostRecord(home)) === undefined
  if (!alive(record.pid)) return true
  const current = await hostRecord(home)
  if (current?.pid !== record.pid || current.port !== record.port || current.token !== record.token) return false
  const response = await fetch(`http://127.0.0.1:${record.port}/api/host.describe`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'host.describe', payload: {} }),
    signal: AbortSignal.timeout(5_000),
  })
  if ((await response.json()).result?.value?.managedHostToken !== record.token) return false
  process.kill(record.pid, 'SIGTERM')
  await until(() => Promise.resolve(!alive(record.pid)), 'owned Host shutdown', 10_000)
  return true
}

function ownedHelperPid(app) {
  const pid = Number(execFileSync('/usr/bin/pgrep', ['-P', String(app.process().pid), '-f', 'coding-electron-helper-darwin-arm64']))
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'one owned Electron helper')
  return pid
}

async function unarchivedMembers(page, workspaceId) {
  const { items, archivedSessionIds } = await rpc(page, 'workspace.list', {})
  const workspace = items.find(item => item.workspaceId === workspaceId)
  assert.ok(workspace, 'workspace remains registered')
  return workspace.sessionIds.filter(id => !archivedSessionIds.includes(id))
}

const localReply = '本地回环验收历史'
const localHistoryId = SessionId('basic-parity-local-history')

/** 在远端空白归档后写入最近的本地历史，避免重启时自动连接远端。 */
async function seedLocalHistory(page, hostHome, cwd, remote) {
  for (const sessionId of await unarchivedMembers(page, remote.workspaceId)) {
    await rpc(page, 'workspace.archiveSession', { sessionId })
  }
  const { workspace } = await rpc(page, 'workspace.create', { path: await realpath(cwd), title: '回环本地工作区' })
  const id = localHistoryId
  const session = Session.create(id)
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '本地回环验收' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { turn: 1, step: 1, message: createMessage({
    role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    content: [{ type: 'text', text: localReply }],
  }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const seeder = new Context()
  try {
    await seeder.plugin(SessionStore)
    await seeder.plugin(JsonlSessionPersistence, { root: join(hostHome, 'sessions') })
    await seeder.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd: workspace.path, delegationDepth: 0 })
    await seeder.sessionPersistence.append(id, session.events)
  } finally { await seeder.fiber.dispose() }
  await rpc(page, 'session.create', { workspaceId: workspace.workspaceId, sessionId: id })
}

async function verifyColdStart(page, fixture, hostHome, before, remote, setStage) {
  setStage('cold startup restores local history')
  const localHistory = page.locator('[data-phase="active"]').getByText(localReply, { exact: true })
  await localHistory.waitFor({ state: 'visible', timeout: 10_000 })
  const side = page.locator('#dsh-layout-sidebar')
  await side.waitFor({ state: 'visible' })
  // 窄窗先按实际 Frame 宽度收起侧栏，不能使用首帧的行坐标。
  await new Promise(resolve => setTimeout(resolve, 550))
  const expand = page.getByRole('button', { name: '展开侧边栏', exact: true })
  if (await expand.isVisible()) await expand.click()
  await until(() => side.evaluate(el => el.getBoundingClientRect().width >= 250), 'expanded sidebar', 5_000)
  const work = side.getByRole('tab', { name: '工作', exact: true })
  if (await work.getAttribute('aria-selected') !== 'true') await work.click()
  setStage('cold remote row: no prewarming before the click')
  assert.deepEqual(await unarchivedMembers(page, remote.workspaceId), [], 'no reusable remote session')
  const markerUnchanged = async () => {
    const { marker } = await markerIn(hostHome)
    assert.equal(marker.generation, before.generation, 'remote was not reconnected before the click')
    assert.ok(marker.connectionId === before.connectionId, 'saved route identity is still stale')
  }
  await markerUnchanged()
  setStage('cold remote row: hover to reveal the create button')
  const row = side.getByRole('treeitem').filter({ has: page.getByText(remote.title, { exact: true }) })
  await row.hover({ position: { x: 24, y: 14 }, timeout: 5_000 })
  const plus = row.getByRole('button', { name: `在“${remote.title}”中新建会话`, exact: true })
  const pending = row.getByRole('status').filter({ hasText: /^正在准备会话…$/ })
  const creates = [], histories = new Set()
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (request.method() !== 'POST') return
    if (path === '/api/session.create') creates.push(request.postDataJSON()?.payload?.workspaceId)
    if (path === '/api/session.history') histories.add(request.postDataJSON()?.payload?.sessionId)
  })
  // 仅暂停本测试拥有的回环 SSH 进程；不改认证或产品传输，失败也必须恢复进程。
  assert.equal(fixture.kill('SIGSTOP'), true)
  try {
    setStage('cold remote row: click and preparation')
    await plus.click({ timeout: 5_000 })
    await pending.waitFor({ state: 'visible', timeout: 5_000 })
    const historyBox = await localHistory.boundingBox()
    assert.ok(historyBox, 'local history remains visible while preparing')
    await page.mouse.move(historyBox.x + historyBox.width / 2, historyBox.y + historyBox.height / 2)
    assert.equal(await row.evaluate(el => el.matches(':hover')), false)
    assert.equal(await localHistory.isVisible(), true, 'local history remains selected after moving the pointer')
    assert.equal(await pending.isVisible(), true, 'preparation remains visible without hover')
    assert.equal(await plus.isDisabled(), true)
    await markerUnchanged()
    assert.equal(creates.length, 0, 'no create before SSH is ready')
  } finally { fixture.kill('SIGCONT') }
  setStage('cold remote row: one remote blank after release')
  await page.locator('[data-phase="hero"]').getByText(remote.title, { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 })
  await pending.waitFor({ state: 'hidden' })
  const ids = await unarchivedMembers(page, remote.workspaceId)
  assert.equal(ids.length, 1, 'exactly one active remote session')
  const { items } = await rpc(page, 'session.list', {})
  assert.ok(items.some(item => item.sessionId === ids[0] && item.blank && item.cwd === remote.path))
  await until(() => histories.has(ids[0]), 'renderer opened the created session', 5_000)
  assert.deepEqual(creates, [remote.workspaceId], 'single create for the selected workspace')
  const { marker } = await markerIn(hostHome)
  assert.equal(marker.generation, before.generation + 1)
  assert.ok(marker.connectionId !== before.connectionId, 'cold connection replaced stale identity')
}

async function main() {
  assert.equal(process.platform, 'darwin', 'native basic SSH parity requires macOS')
  assert.equal(process.arch, 'arm64', 'Electron helper currently requires macOS arm64')
  assert.ok(existsSync(entry), 'build Host/Web and Electron first')
  assert.ok(existsSync(join(root, 'dist/coding-electron-helper-darwin-arm64')), 'build Electron helper first')
  // macOS 的长 TMPDIR 会超出 SSH bridge 的 Unix socket 路径上限。
  const isolated = await mkdtemp('/tmp/coding-remote-basic-')
  const home = join(isolated, 'home')
  const temporary = join(isolated, 'tmp')
  const hostHome = join(home, '.dsh-electron-dev')
  const workspace = join(hostHome, 'workspace')
  const binary = join(isolated, 'ssh-fixture')
  let app
  let fixtureProcess
  let record
  let passed = false
  let stage = 'setup'
  const env = safeEnvironment(home, temporary)
  async function launch(restoreLocalHistory = false) {
    app = await _electron.launch({ executablePath: electronExecutable, cwd: root, timeout,
      args: ['--lang=zh-CN', '--use-mock-keychain', '--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', entry],
      env: { ...env, DSH_HOME: hostHome, DSH_CWD: workspace } })
    if (restoreLocalHistory) {
      // Host 重启会换 HTTP 源；在新文档加载前准备该源的本地选择，不模拟一次点击。
      await app.context().addInitScript(id => {
        if (window === window.top && location.hostname === '127.0.0.1') {
          localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
        }
      }, localHistoryId)
    }
    await bounded(app.firstWindow(), 'first Electron window')
    await until(async () => { record = await hostRecord(hostHome); return record !== undefined && alive(record.pid) }, 'managed Host record')
    const origin = `http://127.0.0.1:${record.port}`
    let page
    await until(() => {
      page = app.windows().find(window => !window.isClosed() && window.url() === `${origin}/`)
      return page !== undefined
    }, 'Host renderer')
    assert.equal(await realpath(await app.evaluate(({ app: native }) => native.getPath('userData'))),
      await realpath(join(hostHome, 'electron-user-data')), 'isolated Electron profile')
    await page.locator('[data-shell-overlay]').waitFor({ state: 'attached' })
    assert.ok((await page.locator('body').innerText()).length > 20, 'Host UI is not blank')
    const onboarding = page.getByRole('dialog', { name: '配置模型，开始使用' })
    if (await onboarding.isVisible()) await onboarding.getByRole('button', { name: '稍后配置' }).click()
    return page
  }
  try {
    await Promise.all([home, temporary, workspace].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
    stage = 'build fixture'
    await buildFixture(binary, env)
    stage = 'start fixture without forwarding'
    const { child, ready } = await startFixture(binary, env)
    fixtureProcess = child
    stage = 'start Electron and Host'
    let page = await launch()
    stage = 'unknown host confirmation and basic workspace'
    assert.equal(existsSync(join(hostHome, 'remote-ssh/known_hosts')), false)
    await connectInWizard(page, ready, phase => { stage = `basic workspace: ${phase}` })
    const selected = await markerIn(hostHome)
    assert.equal(selected.marker.remoteRoot, ready.remoteRoot)
    assert.equal(selected.marker.generation, 1)
    assert.ok((await readFile(join(hostHome, 'remote-ssh/known_hosts'), 'utf8')).length > 0)
    stage = 'no remote agent deployment'
    assert.deepEqual((await readdir(ready.remoteRoot)).sort(), ['nested', 'seed.txt'],
      'basic mode must not upload an agent or create deployment directories')
    stage = 'Host workspace and session'
    const { items } = await rpc(page, 'workspace.list', {})
    const created = items.find(item => item.path === selected.path)
    assert.ok(created, 'UI must create a workspace for the marker')
    await page.locator('[data-phase="hero"]').getByText(created.title, { exact: true }).first().waitFor({ state: 'visible' })
    const session = await rpc(page, 'session.create', { workspaceId: created.workspaceId })
    stage = 'Host remote file list'
    const listing = await workspaceRequest(page, '/open-in-app/files', { sessionId: session.sessionId, segments: [] })
    assert.ok(listing.entries.some(item => item.name === 'seed.txt' && item.type === 'file'))
    assert.ok(listing.entries.some(item => item.name === 'nested' && item.type === 'directory'))
    stage = 'Host remote file read'
    const seed = await workspaceRequest(page, '/open-in-app/read',
      { sessionId: session.sessionId, segments: ['seed.txt'] })
    assert.equal(seed.kind, 'text')
    assert.equal(seed.text, 'remote fixture seed\n')
    stage = 'Host basic remote PTY and resize'
    await terminalProof(page, session.sessionId, ready.remoteRoot)
    stage = 'assert no local fallback'
    assert.deepEqual(await readdir(workspace), [], 'remote operations must not touch local workspace')
    assert.deepEqual((await readdir(ready.remoteRoot)).sort(), ['nested', 'seed.txt'])
    stage = 'prepare local history and archive remote blanks'
    await seedLocalHistory(page, hostHome, workspace, created)
    const { marker: before } = await markerIn(hostHome)
    stage = 'quit first Electron, helper and Host'
    const old = [app.process().pid, ownedHelperPid(app), record.pid]
    await closeOwnApp(app)
    app = undefined
    assert.equal(await stopOwnHost(hostHome, record), true, 'old Host must stop safely')
    await until(() => old.every(pid => !alive(pid)), 'old Electron, helper and Host exited', 10_000)
    stage = 'launch fresh Electron, helper and Host'
    page = await launch(true)
    assert.ok([app.process().pid, ownedHelperPid(app), record.pid].every(pid => !old.includes(pid)))
    await verifyColdStart(page, fixtureProcess, hostHome, before, created, phase => { stage = phase })
    stage = 'quit cleanup'
    await closeOwnApp(app)
    app = undefined
    await stopChild(fixtureProcess)
    fixtureProcess = undefined
    assert.equal(await stopOwnHost(hostHome, record), true, 'test Host must stop safely')
    passed = true
    console.log('PASS: basic default, unknown host, UI marker/workspace, no agent or forwarding, Host remote files and PTY resize, local isolation, cold remote row preparation and creation, and shutdown')
  } catch (error) {
    const diagnostic = stage === 'basic workspace: unknown host prompt' && error instanceof Error
      && error.message.startsWith('unknown host prompt unavailable (') ? `; ${error.message}` : ''
    console.error(`FAIL: remote-basic parity at ${stage}${diagnostic}; isolated data: ${isolated}`)
    process.exitCode = 1
  } finally {
    await closeOwnApp(app).catch(() => undefined)
    await stopChild(fixtureProcess).catch(() => undefined)
    let safe = false
    try { safe = await stopOwnHost(hostHome, record) } catch { /* 所有权无法证明则保留隔离数据。 */ }
    if (passed && safe) await rm(isolated, { recursive: true, force: true })
    else console.error(`Isolated data retained: ${isolated}`)
  }
}

main().catch(() => {
  console.error('FAIL: remote-basic parity setup')
  process.exitCode = 1
})
