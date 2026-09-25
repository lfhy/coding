/**
 * 显式 opt-in 的原生 Remote-SSH 全链路验收；只连接本测试创建的回环 SSH fixture。
 * 失败保留隔离 HOME 供人工检查，绝不打印密码、bridge token 或原始跨进程错误。
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
const markerName = '.coding-remote-workspace.json'

async function until(check, label, ms = timeout) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`${label}: timed out`)
}

async function bounded(promise, label, ms = timeout) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timed out`)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function safeEnvironment(home, temporary) {
  // 仅显式传递编译、Node 与图形会话所需的变量；不继承 SSH agent、API key 和用户配置。
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

async function fixture(binary, env) {
  const child = spawn(binary, [], { cwd: join(root, 'apps/desktop'), env, stdio: ['pipe', 'pipe', 'ignore'] })
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
  // macOS /var -> /private/var；远端 agent 的目录结果使用物理规范路径。
  ready.remoteRoot = await realpath(ready.remoteRoot)
  return { child, ready }
}

async function stopChild(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
  child.stdin?.end()
  try {
    await bounded(new Promise(resolve => child.once('exit', resolve)), 'fixture shutdown', 5_000)
  } catch {
    child.kill('SIGTERM')
    try { await bounded(new Promise(resolve => child.once('exit', resolve)), 'fixture termination', 3_000) }
    catch { child.kill('SIGKILL') }
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

async function selectRemoteRoot(wizard, remoteRoot, phase, screenshot) {
  phase('open directory')
  await wizard.getByRole('button', { name: '选择远程目录' }).last().click()
  const pathLabel = wizard.locator('div[title]').first()
  await until(async () => Boolean(await pathLabel.getAttribute('title')), 'initial remote directory')
  let current = await pathLabel.getAttribute('title')
  for (let step = 0; step < 32 && current !== remoteRoot; step++) {
    phase('navigate directory')
    try {
      if (!remoteRoot.startsWith(`${current.replace(/\/$/, '')}/`)) {
        await wizard.getByRole('button', { name: '上一级' }).click()
      } else {
        const next = posix.relative(current, remoteRoot).split('/')[0]
        await wizard.getByRole('button', { name: next, exact: true }).click()
      }
      await until(async () => (await pathLabel.getAttribute('title')) !== current,
        'remote directory navigation')
      current = await pathLabel.getAttribute('title')
    } catch {
      await wizard.screenshot({ path: screenshot }).catch(() => undefined)
      throw new Error('remote directory navigation failed')
    }
  }
  assert.equal(current, remoteRoot, 'UI directory selection must reach fixture root')
  phase('select directory and create workspace')
  await wizard.getByRole('button', { name: '选择此文件夹' }).click()
  await wizard.waitFor({ state: 'hidden' })
}

async function connectInWizard(page, ready, first, phase, screenshot) {
  phase('open wizard')
  await page.getByRole('button', { name: '选择工作区' }).first().click()
  await page.getByText('连接 Remote-SSH', { exact: true }).first().click()
  const wizard = page.getByRole('dialog', { name: '连接 Remote-SSH' })
  await wizard.waitFor({ state: 'visible' })
  await wizard.locator('#remote-ssh-host').fill(ready.host)
  await wizard.locator('#remote-ssh-port').fill(String(ready.port))
  await wizard.locator('#remote-ssh-user').fill(ready.username)
  await wizard.locator('#remote-ssh-secret').fill(ready.password)
  phase('connect SSH')
  await wizard.getByRole('button', { name: '连接', exact: true }).click()
  if (first) {
    phase('unknown host prompt')
    await wizard.getByText('此主机尚不在 known_hosts 中。', { exact: false }).waitFor({ state: 'visible' })
    assert.match(await wizard.innerText(), /SHA256:/)
    phase('accept host key')
    await wizard.getByRole('button', { name: '信任并继续' }).click()
  } else {
    assert.equal(await wizard.getByRole('button', { name: '信任并继续' }).count(), 0,
      'accepted test host must not prompt again')
  }
  phase('remote agent ready')
  try {
    await wizard.getByRole('button', { name: '选择远程目录' }).last().waitFor({ state: 'visible' })
  } catch {
    // 认证输入已离开表单；仅在此进度页保存故障截图，不写入 stdout。
    await wizard.screenshot({ path: screenshot }).catch(() => undefined)
    throw new Error('remote agent did not become ready')
  }
  await selectRemoteRoot(wizard, ready.remoteRoot, phase, screenshot)
}

async function cancelWizard(page, ready) {
  await page.getByRole('button', { name: '选择工作区' }).first().click()
  await page.getByText('连接 Remote-SSH', { exact: true }).first().click()
  const wizard = page.getByRole('dialog', { name: '连接 Remote-SSH' })
  await wizard.locator('#remote-ssh-host').fill(ready.host)
  await wizard.locator('#remote-ssh-port').fill(String(ready.port))
  await wizard.locator('#remote-ssh-user').fill(ready.username)
  await wizard.locator('#remote-ssh-secret').fill(ready.password)
  await wizard.getByRole('button', { name: '连接', exact: true }).click()
  await wizard.getByRole('button', { name: '关闭' }).click()
  await wizard.waitFor({ state: 'hidden' })
}

async function markerIn(home) {
  const base = join(home, 'remote-workspaces')
  const targets = await readdir(base)
  assert.equal(targets.length, 1, 'only the fixture host has a marker target')
  const folders = await readdir(join(base, targets[0]))
  assert.equal(folders.length, 1, 'only the selected remote root has a marker')
  const path = join(base, targets[0], folders[0])
  const marker = JSON.parse(await readFile(join(path, markerName), 'utf8'))
  assert.equal(marker.version, 2)
  return { path: await realpath(path), marker }
}

async function terminalProof(page, sessionId, remoteRoot, phase) {
  const suffix = randomUUID().replaceAll('-', '')
  const proof = await page.evaluate(async ({ sessionId, suffix }) => {
    return await new Promise((resolve, reject) => {
      const socket = new WebSocket(`/open-in-app/terminal?sessionId=${encodeURIComponent(sessionId)}&cols=80&rows=24`.replace(/^\//, `${location.origin.replace(/^http/, 'ws')}/`))
      let output = ''
      const timer = setTimeout(() => { socket.close(); reject(new Error('terminal proof timed out')) }, 30_000)
      socket.onerror = () => { clearTimeout(timer); reject(new Error('terminal websocket failed')) }
      socket.onmessage = event => {
        const frame = JSON.parse(event.data)
        if (frame.type === 'error') { clearTimeout(timer); socket.close(); reject(new Error('terminal failed')) }
        if (frame.type === 'ready') {
          socket.send(JSON.stringify({ type: 'resize', cols: 113, rows: 41 }))
          socket.send(JSON.stringify({ type: 'input', data: `stty size; pwd -P; printf 'REMOTE_%s\\n' 'PARITY_${suffix}'\r` }))
        }
        if (frame.type === 'output') {
          output += frame.data
          if (output.includes(`REMOTE_PARITY_${suffix}`)) {
            clearTimeout(timer)
            socket.send(JSON.stringify({ type: 'close' }))
            resolve(output)
          }
        }
      }
    })
  }, { sessionId, suffix })
  phase('assert resized remote PTY')
  assert.match(proof, /41\s+113/, 'remote PTY must apply resize')
  phase('assert remote PTY cwd')
  assert.ok(proof.includes(remoteRoot), 'remote PTY pwd must be the selected remote directory')
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
  assert.equal(process.platform, 'darwin', 'native Remote-SSH parity requires macOS')
  assert.equal(process.arch, 'arm64', 'Electron helper currently requires macOS arm64')
  assert.ok(existsSync(entry), 'build Host/Web and Electron first')
  assert.ok(existsSync(join(root, 'dist/coding-electron-helper-darwin-arm64')), 'build Electron helper first')
  assert.ok(existsSync(join(root, 'dist/remote-agent', `coding-remote-agent-darwin-${process.arch}`)),
    'build the fixture platform remote-agent first')
  assert.ok(existsSync(join(root, 'apps/desktop/cmd/ssh-fixture')), 'Go SSH fixture source is required')
  const isolated = await mkdtemp(join(tmpdir(), 'coding-electron-remote-ssh-'))
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
    stage = 'start fixture'
    const { child, ready } = await fixture(binary, env)
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
    stage = 'unknown host confirmation and first workspace'
    assert.equal(existsSync(join(hostHome, 'remote-ssh/known_hosts')), false)
    await connectInWizard(page, ready, true, phase => { stage = `first workspace: ${phase}` },
      join(isolated, 'first-progress.png'))
    const first = await markerIn(hostHome)
    assert.equal(first.marker.remoteRoot, ready.remoteRoot)
    assert.equal(first.marker.generation, 1)
    assert.ok((await readFile(join(hostHome, 'remote-ssh/known_hosts'), 'utf8')).length > 0)
    stage = 'Host workspace.list after UI create'
    const { items } = await rpc(page, 'workspace.list', {})
    stage = 'assert UI-created workspace'
    const created = items.find(item => item.path === first.path)
    assert.ok(created, 'UI must create a workspace for the marker')
    stage = 'Host session.create in remote workspace'
    const session = await rpc(page, 'session.create', { workspaceId: created.workspaceId })
    stage = 'Host remote file list'
    const listing = await workspaceRequest(page, '/open-in-app/files', { sessionId: session.sessionId, segments: [] })
    assert.ok(listing.entries.some(entry => entry.name === 'seed.txt' && entry.type === 'file'))
    assert.ok(listing.entries.some(entry => entry.name === 'nested' && entry.type === 'directory'))
    stage = 'Host remote file read'
    const seed = await workspaceRequest(page, '/open-in-app/read',
      { sessionId: session.sessionId, segments: ['seed.txt'] })
    assert.equal(seed.kind, 'text')
    assert.equal(seed.text, 'remote fixture seed\n', 'Host must read the fixture seed content')
    stage = 'Host remote PTY and resize'
    await terminalProof(page, session.sessionId, ready.remoteRoot,
      phase => { stage = `Host remote PTY: ${phase}` })
    stage = 'same-directory rebind and old-route rejection'
    await connectInWizard(page, ready, false, phase => { stage = `rebind: ${phase}` },
      join(isolated, 'rebind-progress.png'))
    const second = await markerIn(hostHome)
    assert.equal(second.path, first.path)
    assert.equal(second.marker.generation, first.marker.generation + 1)
    assert.notEqual(second.marker.connectionId, first.marker.connectionId)
    assert.equal(await page.evaluate(async connectionId => {
      try { await window.codingDesktop.remoteSSH.listDirectories(connectionId, '/'); return false }
      catch { return true }
    }, first.marker.connectionId), true, 'old SSH connection must fail closed')
    const afterRebind = await workspaceRequest(page, '/open-in-app/read',
      { sessionId: session.sessionId, segments: ['seed.txt'] })
    assert.equal(afterRebind.text, seed.text)
    stage = 'cancel and quit cleanup'
    await cancelWizard(page, ready)
    assert.equal((await markerIn(hostHome)).marker.generation, second.marker.generation,
      'canceling a third UI connection must not publish another marker')
    await closeOwnApp(app)
    app = undefined
    await stopChild(fixtureProcess)
    fixtureProcess = undefined
    assert.equal(await stopOwnHost(hostHome, record), true, 'test Host must stop safely')
    passed = true
    console.log('PASS: unknown host key, UI directory/marker/workspace, Host list/read, remote PTY resize, generation rebind, stale connection rejection, cancel and shutdown')
  } catch {
    // 原始异常可能包含 SSH 输入或内部 token；只输出预先写定的测试阶段。
    console.error(`FAIL: remote-ssh parity at ${stage}; isolated data: ${isolated}`)
    process.exitCode = 1
  } finally {
    await closeOwnApp(app).catch(() => undefined)
    await stopChild(fixtureProcess).catch(() => undefined)
    let safe = false
    try { safe = await stopOwnHost(hostHome, record) } catch { /* 所有权不能证明则保留数据。 */ }
    if (passed && safe) await rm(isolated, { recursive: true, force: true })
    else console.error(`Isolated data retained: ${isolated}`)
  }
}

main().catch(() => {
  console.error('FAIL: remote-ssh parity setup')
  process.exitCode = 1
})
