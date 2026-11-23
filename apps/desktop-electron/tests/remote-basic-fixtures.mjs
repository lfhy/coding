/** 原生 Basic SSH 验收使用的回环传输、流式模型与合成图片。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { realpath } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { connect, createServer as createTcpServer } from 'node:net'
import { join, posix } from 'node:path'

async function listenLoopback(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return server.address().port
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(5_000) })
  child.stdin.end()
  try { await exited } catch {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    const terminated = once(child, 'exit', { signal: AbortSignal.timeout(3_000) })
    child.kill('SIGTERM')
    try { await terminated } catch { child.kill('SIGKILL') }
  }
}

async function startFixture(binary, cwd, env) {
  const child = spawn(binary, ['--no-forwarding'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
  try {
    const ready = await new Promise((resolve, reject) => {
      let line = ''
      const timer = setTimeout(() => reject(new Error('SSH fixture ready: timed out')), 90_000)
      child.once('error', () => { clearTimeout(timer); reject(new Error('SSH fixture could not start')) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('SSH fixture exited before ready')) })
      child.stdout.on('data', chunk => {
        line += chunk.toString('utf8')
        if (line.length > 4096) { clearTimeout(timer); reject(new Error('SSH fixture ready frame is oversized')); return }
        const end = line.indexOf('\n')
        if (end < 0) return
        clearTimeout(timer)
        try { resolve(JSON.parse(line.slice(0, end))) }
        catch { reject(new Error('SSH fixture ready frame is invalid')) }
      })
    })
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

/**
 * 在隔离目录编译并启动真实 SSH 夹具；门闩只暂停或断开回环握手，不替代认证或传输。
 * @param options - 仓库根目录、隔离的可执行文件路径和启动环境。
 * @returns 持有客户端、待放行连接与进程退出所有权的夹具。
 */
export async function startSshFixture({ root, binary, env }) {
  const cwd = join(root, 'apps/desktop')
  const moduleCache = process.env.GOMODCACHE ?? join(process.env.GOPATH ?? join(process.env.HOME, 'go'), 'pkg/mod')
  const build = spawn('go', ['build', '-tags', 'remote_ssh_e2e', '-o', binary, './cmd/ssh-fixture'], {
    cwd, env: { ...env, CGO_ENABLED: '0', GOENV: 'off', GOPROXY: 'off', GOTOOLCHAIN: 'auto',
      GOMODCACHE: moduleCache, GOCACHE: join(env.TMPDIR, 'go-build') },
    signal: AbortSignal.timeout(180_000), stdio: 'ignore',
  })
  const [code] = await once(build, 'exit')
  assert.equal(code, 0, 'Go SSH fixture build failed')
  const { child, ready } = await startFixture(binary, cwd, env)
  const clients = new Set(), held = new Set()
  const gate = { accepts: 0, paused: false, clients, held,
    release() {
      gate.paused = false
      for (const client of held) forward(client)
    },
    async close() {
      for (const client of clients) client.destroy()
      try { await new Promise(resolve => server.close(resolve)) } finally { await stopChild(child) }
    },
  }
  function forward(client) {
    held.delete(client)
    if (client.destroyed) return
    const upstream = connect(ready.port, ready.host)
    upstream.on('error', () => client.destroy())
    upstream.once('close', () => client.destroy())
    client.once('close', () => upstream.destroy())
    client.pipe(upstream).pipe(client)
  }
  const server = createTcpServer(client => {
    gate.accepts++
    clients.add(client)
    client.on('error', () => client.destroy())
    client.once('close', () => { clients.delete(client); held.delete(client) })
    if (gate.paused) held.add(client)
    else forward(client)
  })
  try { return Object.assign(gate, { ready: { ...ready, port: await listenLoopback(server) } }) }
  catch (error) { await gate.close(); throw error }
}

/** 回环模型的唯一选择与可见回执。 */
export const fixtureModel = { provider: 'native-basic-fixture', model: 'native-basic-model' }
export const fixtureReply = '回环模型已收到消息。'

/**
 * 提供真实 Host 使用的 OpenAI 兼容 SSE；收到代理请求时拒绝转发，不记录模型请求。
 * @returns 回环地址、模型配置操作、合成输入的到达记录及关闭操作。
 */
export async function startModel() {
  const ref = 'NATIVE_BASIC_FIXTURE_KEY', key = randomUUID(), received = new Set()
  const server = createHttpServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/chat/completions') return response.writeHead(403).end()
    if (request.headers.authorization !== `Bearer ${key}`) return response.writeHead(401).end()
    try {
      const chunks = []
      let bytes = 0
      for await (const chunk of request) {
        if ((bytes += chunk.length) > 2 ** 21) throw new Error('fixture request too large')
        chunks.push(chunk)
      }
      const { model, messages, stream } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert.ok(model === fixtureModel.model && stream === true && Array.isArray(messages))
      for (const { role, content } of messages) if (role === 'user') {
        if (typeof content === 'string') received.add(content)
        else for (const part of content) if (part.type === 'text') received.add(part.text)
      }
      const header = { id: `chatcmpl-${randomUUID()}`, object: 'chat.completion.chunk', model, created: Math.floor(Date.now() / 1000) }
      const frames = [
        { ...header, choices: [{ index: 0, delta: { role: 'assistant', content: fixtureReply }, finish_reason: null }] },
        { ...header, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n')
    } catch { response.writeHead(400).end() }
  })
  server.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'))
  const url = `http://127.0.0.1:${await listenLoopback(server)}`
  return { url, received, async configure(page, rpc) {
    const provider = { api: 'openai-completions', baseURL: url, apiKeyEnv: ref, models: [{ id: fixtureModel.model, input: ['text', 'image'] }] }
    await rpc(page, 'settings.update', { ns: 'llm-pi-ai', patch: { providers: { [fixtureModel.provider]: provider } } })
    await rpc(page, 'credentials.set', { ref, value: key })
    await rpc(page, 'settings.update', { ns: 'agent-default-model', patch: fixtureModel })
  }, async close() {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  } }
}

/**
 * 通过输入栏的粘贴入口添加小 PNG；用已解码预览的 URL 核对重试是否保留了同一份草稿附件。
 * @param input - 实际的消息输入框。
 * @param composer - 输入栏区域，用来定位待发送图片而非聊天记录。
 * @returns 原始图片 RPC 部分与检查其预览的操作。
 */
export async function pasteDraftPng(input, composer) {
  const name = 'basic-parity-retry.png'
  const data = await input.evaluate(async (textarea, name) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 8
    const paint = canvas.getContext('2d')
    paint.fillStyle = '#268763'
    paint.fillRect(0, 0, 8, 8)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('could not encode synthetic PNG')
    const transfer = new DataTransfer()
    transfer.items.add(new File([blob], name, { type: 'image/png' }))
    textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())))
  }, name)
  const preview = composer.getByRole('img', { name, exact: true })
  const loadedSrc = async () => {
    await preview.waitFor({ state: 'visible', timeout: 5_000 })
    return preview.evaluate(async img => { await img.decode(); return img.currentSrc })
  }
  const src = await loadedSrc()
  assert.ok(src.startsWith('blob:'), 'PNG is a draft preview, not a posted image')
  return { content: { type: 'image', mediaType: 'image/png', data, name }, preview, async assertRetained() {
    assert.ok(await loadedSrc() === src, 'the original draft preview survived SSH failure')
  } }
}
