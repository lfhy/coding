/**
 * 显式 opt-in 的基础 SSH 原生验收；仅连接本进程启动、禁止端口转发的回环 fixture。
 * 凭据只在内存中传递；失败日志仅包含固定阶段，不输出 SSH 输入或 bridge token。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    LANG: process.env.LANG ?? 'en_US.UTF-8',
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

async function main() {
  assert.equal(process.platform, 'darwin', 'native basic SSH parity requires macOS')
  assert.equal(process.arch, 'arm64', 'Electron helper currently requires macOS arm64')
  assert.ok(existsSync(entry), 'build Host/Web and Electron first')
  assert.ok(existsSync(join(root, 'dist/coding-electron-helper-darwin-arm64')), 'build Electron helper first')
  const isolated = await mkdtemp(join(tmpdir(), 'coding-electron-remote-basic-'))
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
  try {
    await Promise.all([home, temporary, workspace].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
    const env = safeEnvironment(home, temporary)
    stage = 'build fixture'
    await buildFixture(binary, env)
    stage = 'start fixture without forwarding'
    const { child, ready } = await startFixture(binary, env)
    fixtureProcess = child
    stage = 'start Electron and Host'
    app = await _electron.launch({ executablePath: electronExecutable, args: [entry], cwd: root,
      env: { ...env, DSH_HOME: hostHome, DSH_CWD: workspace }, timeout })
    await bounded(app.firstWindow(), 'first Electron window')
    await until(async () => { record = await hostRecord(hostHome); return record !== undefined }, 'managed Host record')
    const origin = `http://127.0.0.1:${record.port}`
    let page
    await until(() => {
      page = app.windows().find(window => !window.isClosed() && window.url() === `${origin}/`)
      return page !== undefined
    }, 'Host renderer')
    await page.locator('[data-shell-overlay]').waitFor({ state: 'attached' })
    assert.ok((await page.locator('body').innerText()).length > 20, 'Host UI is not blank')
    const onboarding = page.getByRole('dialog', { name: '添加一个 API Key 开始使用' })
    await onboarding.getByRole('button', { name: '稍后配置' }).click()
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
    stage = 'quit cleanup'
    await closeOwnApp(app)
    app = undefined
    await stopChild(fixtureProcess)
    fixtureProcess = undefined
    assert.equal(await stopOwnHost(hostHome, record), true, 'test Host must stop safely')
    passed = true
    console.log('PASS: basic default, unknown host, UI marker/workspace, no agent or forwarding, Host remote files and PTY resize, local isolation and shutdown')
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
