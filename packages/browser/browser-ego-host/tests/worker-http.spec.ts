/** 真 worker HTTP 入口连到受控 CDP 替身；不启动浏览器也不触碰现有 worker。 */
import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')
const WORKER = new URL('../bin/ego-cast-worker.mjs', import.meta.url)
let dir: string | undefined
let server: Server | undefined
let child: ChildProcess | undefined
const sockets = new Set<Duplex>()

/** 只实现测试需要的 WebSocket 帧，保留真实 worker 的 HTTP/CDP 协议路径。 */
function frame(payload: unknown): Buffer {
  const data = Buffer.from(JSON.stringify(payload))
  return data.length < 126 ? Buffer.concat([Buffer.from([0x81, data.length]), data])
    : Buffer.concat([Buffer.from([0x81, 126, data.length >> 8, data.length & 255]), data])
}

afterEach(async () => {
  if (child && child.exitCode === null) {
    const stopped = new Promise<void>(resolve => child!.once('exit', () => { resolve() }))
    child.kill('SIGTERM')
    await stopped
  }
  for (const socket of sockets) socket.destroy()
  if (server) await new Promise<void>(resolve => server!.close(() => { resolve() }))
  if (dir) await rm(dir, { recursive: true, force: true })
  child = undefined; server = undefined; dir = undefined; sockets.clear()
})

it('封闭 worker 在真实 HTTP/CDP 连接上采帧并导航，拒绝失效目标和失败命令', async () => {
  dir = await mkdtemp(join(tmpdir(), 'coding-worker-api-'))
  const calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = []
  let viewportAvailable = true
  let imageAvailable = true
  let currentIndex = 1
  server = createServer()
  server.on('upgrade', (req, socket) => {
    sockets.add(socket)
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    let incoming = Buffer.alloc(0)
    socket.on('data', (bytes) => {
      incoming = Buffer.concat([incoming, bytes])
      while (incoming.length >= 6) {
        if ((incoming[0]! & 0x0f) === 8) { incoming = Buffer.alloc(0); break }
        let length = incoming[1]! & 0x7f
        let header = 2
        if (length === 126) { if (incoming.length < 8) break; length = incoming.readUInt16BE(2); header = 4 }
        if (incoming.length < header + 4 + length) break
        const mask = incoming.subarray(header, header + 4)
        const data = incoming.subarray(header + 4, header + 4 + length)
        const unmasked = Buffer.from(data.map((byte, index) => byte ^ mask[index % 4]!))
        incoming = incoming.subarray(header + 4 + length)
        const request = JSON.parse(unmasked.toString('utf8')) as {
          id: number
          method: string
          params: Record<string, unknown>
          sessionId?: string
        }
        calls.push(request)
        let result: unknown = {}
        switch (request.method) {
          case 'Target.getTargets': result = { targetInfos: [{ targetId: 'owned', type: 'page', url: 'https://example.test', title: 'Test' }] }; break
          case 'Target.attachToTarget': result = { sessionId: 'fake-session' }; break
          case 'Page.getLayoutMetrics': result = { cssLayoutViewport: { clientWidth: 640, clientHeight: 360 } }; break
          case 'Runtime.evaluate': result = { result: { value: { x: 5, y: 7, width: viewportAvailable ? 640 : 0, height: 360, dpr: 2 } } }; break
          case 'Page.captureScreenshot': result = { data: imageAvailable ? JPEG : '' }; break
          case 'Page.getNavigationHistory': result = { currentIndex, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] }; break
          case 'Page.navigate': result = request.params.url === 'https://fail.example/' ? { errorText: 'blocked' } : { frameId: 'frame' }; break
        }
        socket.write(frame({ id: request.id, result }))
      }
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  // 以不同脚本名运行同一产物，避免 worker 的兄弟进程清理误伤本机正在使用的实例。
  const isolatedWorker = join(dir, 'worker-under-test.mjs')
  await writeFile(isolatedWorker, await readFile(WORKER))
  child = spawn(process.execPath, [isolatedWorker, JSON.stringify({ captureBackend: 'cdp' })], {
    env: { ...process.env, EGO_LINUX_STATE_DIR: dir, EGO_LINUX_CDP_URL: `ws://127.0.0.1:${port}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (bytes: Buffer) => { stderr += bytes.toString('utf8') })
  let workerPort = 0
  await vi.waitFor(async () => {
    const state = JSON.parse(await readFile(join(dir!, 'ego-cast.json'), 'utf8')) as { port: number }
    workerPort = state.port
    expect((await (await fetch(`http://127.0.0.1:${workerPort}/api/health`)).json() as { browserConnected: boolean }).browserConnected).toBe(true)
  }, { interval: 50, timeout: 8000 })
  const api = `http://127.0.0.1:${workerPort}`
  const missing = await fetch(`${api}/api/frame?targetId=other`)
  expect(missing.status, stderr).toBe(409)
  expect((await missing.json() as { ok: boolean }).ok).toBe(false)
  const image = await fetch(`${api}/api/frame?targetId=owned`)
  expect(image.status, stderr).toBe(200)
  expect(await image.json()).toMatchObject({ targetId: 'owned', data: JPEG, vw: 640, vh: 360 })
  expect(calls.find(call => call.method === 'Page.captureScreenshot')).toMatchObject({
    sessionId: 'fake-session', params: { format: 'jpeg', clip: { x: 5, y: 7, width: 640, height: 360, scale: 0.5 } },
  })
  viewportAvailable = false
  const badViewport = await fetch(`${api}/api/frame?targetId=owned`)
  expect(badViewport.status, stderr).toBe(503)
  expect((await badViewport.json() as { ok: boolean }).ok).toBe(false)
  viewportAvailable = true
  imageAvailable = false
  const badImage = await fetch(`${api}/api/frame?targetId=owned`)
  expect(badImage.status, stderr).toBe(503)
  expect((await badImage.json() as { ok: boolean }).ok).toBe(false)
  imageAvailable = true
  const post = async (body: unknown): Promise<{ status: number; ok: boolean }> => {
    const response = await fetch(`${api}/api/navigation`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, ok: (await response.json() as { ok: boolean }).ok }
  }
  expect(await post({ targetId: 'other', action: 'reload' })).toEqual({ status: 409, ok: false })
  expect(await post({ targetId: 'owned', action: 'navigate', url: 'javascript:alert(1)' })).toEqual({ status: 400, ok: false })
  expect(await post({ targetId: 'owned', action: 'navigate', url: 'https://example.com/' })).toEqual({ status: 200, ok: true })
  expect(await post({ targetId: 'owned', action: 'navigate', url: 'https://fail.example/' })).toEqual({ status: 409, ok: false })
  expect(await post({ targetId: 'owned', action: 'reload' })).toEqual({ status: 200, ok: true })
  expect(await post({ targetId: 'owned', action: 'back' })).toEqual({ status: 200, ok: true })
  expect(await post({ targetId: 'owned', action: 'forward' })).toEqual({ status: 200, ok: true })
  expect(calls.filter(call => call.method === 'Page.navigateToHistoryEntry').map(call => call.params.entryId)).toEqual([1, 3])
  currentIndex = 0
  expect(await post({ targetId: 'owned', action: 'back' })).toEqual({ status: 409, ok: false })
  expect(calls.filter(call => call.method === 'Page.navigateToHistoryEntry')).toHaveLength(2)
})
