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
  if (data.length < 126) return Buffer.concat([Buffer.from([0x81, data.length]), data])
  if (data.length < 65536) return Buffer.concat([Buffer.from([0x81, 126, data.length >> 8, data.length & 255]), data])
  // 大帧（例如超预算的 PNG）需要 8 字节长度，否则浏览器侧解析不到响应。
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 127
  header.writeBigUInt64BE(BigInt(data.length), 2)
  return Buffer.concat([header, data])
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
  let bigPng = false
  let currentIndex = 1
  let windowAvailable = true
  let windowWidth = 648
  let windowHeight = 444
  let emulated: { width: number; height: number; deviceScaleFactor?: number } | null = null
  let failedMetrics = false
  const currentViewport = () => emulated ?? { width: Math.max(0, windowWidth - 8), height: Math.max(0, windowHeight - 84) }
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
          case 'Page.getLayoutMetrics': result = { cssLayoutViewport: {
            clientWidth: failedMetrics ? 0 : currentViewport().width,
            clientHeight: currentViewport().height,
          } }; break
          case 'Browser.getWindowForTarget': result = windowAvailable ? { windowId: 1 } : {}; break
          case 'Browser.getWindowBounds': result = { bounds: { left: 0, top: 0, width: windowWidth, height: windowHeight } }; break
          case 'Browser.setWindowBounds': {
            const bounds = request.params.bounds as { width: number; height: number }
            windowWidth = Math.max(500, bounds.width); windowHeight = bounds.height
            break
          }
          case 'Emulation.setDeviceMetricsOverride': emulated = request.params as { width: number; height: number; deviceScaleFactor?: number }; break
          case 'Emulation.clearDeviceMetricsOverride': emulated = null; break
          case 'Runtime.evaluate': result = request.params.expression?.toString().includes('document.elementFromPoint')
            ? { result: { value: { cursor: 'pointer', title: 'A link', href: 'https://example.test/next' } } }
            : request.params.expression?.toString().includes('window.outerWidth')
              ? { result: { value: { ow: windowWidth, iw: currentViewport().width,
                oh: windowHeight, ih: currentViewport().height } } }
              : request.params.expression?.toString().includes('({ w:')
                ? { result: { value: { w: currentViewport().width, h: currentViewport().height } } }
                : { result: { value: { x: 5, y: 7, width: viewportAvailable ? currentViewport().width : 0,
                  height: currentViewport().height, dpr: emulated?.deviceScaleFactor ?? 2 } } }; break
          case 'Page.captureScreenshot': result = {
            // 照片类页面用 PNG 会很大：用超预算的假数据驱动 JPEG 回退分支。
            data: imageAvailable ? (bigPng && request.params.format === 'png' ? 'A'.repeat(1_300_000) : JPEG) : '',
          }; break
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
  expect(await image.json()).toMatchObject({ targetId: 'owned', data: JPEG, mime: 'image/png', vw: 640, vh: 360 })
  expect(await (await fetch(`${api}/api/spaces`)).json()).toMatchObject({ spaces: [{ viewportW: 640, viewportH: 360 }] })
  failedMetrics = true
  expect(await (await fetch(`${api}/api/spaces`)).json()).toMatchObject({ spaces: [{ viewportW: 640, viewportH: 360 }] })
  failedMetrics = false
  windowWidth = 690
  expect(await (await fetch(`${api}/api/frame?targetId=owned`)).json()).toMatchObject({ vw: 682, vh: 360 })
  expect(await (await fetch(`${api}/api/spaces`)).json()).toMatchObject({ spaces: [{ viewportW: 682, viewportH: 360 }] })
  windowWidth = 648
  // 未设置面板视口时按页面真实像素比采集：2 倍屏幕得到 1280 宽的设备像素画面，默认无损 PNG。
  expect(calls.find(call => call.method === 'Page.captureScreenshot')).toMatchObject({
    sessionId: 'fake-session', params: { format: 'png', clip: { x: 5, y: 7, width: 640, height: 360, scale: 1 } },
  })
  const postSize = async (width: number, height: number, pixelRatio?: number) => {
    const response = await fetch(`${api}/api/window-size`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetId: 'owned', width, height, ...(pixelRatio === undefined ? {} : { pixelRatio }) }) })
    return { status: response.status, body: await response.json() as { viewport: { width: number; height: number } } }
  }
  // Headless Chrome 可以把窗口宽度钳在 500；面板仍需拿到真实目标视口。
  expect(await postSize(375, 620)).toMatchObject({ status: 200, body: { viewport: { width: 375, height: 620 } } })
  expect(calls.some(call => call.method === 'Emulation.setDeviceMetricsOverride'
    && call.params.width === 375 && call.params.height === 620 && call.params.deviceScaleFactor === 1)).toBe(true)
  expect(await (await fetch(`${api}/api/frame?targetId=owned`)).json()).toMatchObject({ vw: 375, vh: 620 })
  expect(await (await fetch(`${api}/api/spaces`)).json()).toMatchObject({ spaces: [{ viewportW: 375, viewportH: 620 }] })
  expect(await postSize(800, 620)).toMatchObject({ status: 200, body: { viewport: { width: 800, height: 620 } } })
  expect(await (await fetch(`${api}/api/frame?targetId=owned`)).json()).toMatchObject({ vw: 800, vh: 620 })
  expect(await (await fetch(`${api}/api/spaces`)).json()).toMatchObject({ spaces: [{ viewportW: 800, viewportH: 620 }] })
  windowAvailable = false
  expect(await postSize(390, 700)).toMatchObject({ status: 200, body: { viewport: { width: 390, height: 700 } } })
  expect(await (await fetch(`${api}/api/frame?targetId=owned`)).json()).toMatchObject({ vw: 390, vh: 700 })
  expect(await (await fetch(`${api}/api/spaces`)).json()).toMatchObject({ spaces: [{ viewportW: 390, viewportH: 700 }] })
  emulated = null
  expect(await (await fetch(`${api}/api/frame?targetId=owned`)).json()).toMatchObject({ vw: 390, vh: 700 })
  expect(calls.filter(call => call.method === 'Emulation.setDeviceMetricsOverride' && call.params.width === 390)).toHaveLength(2)
  // HiDPI 面板：同一 CSS 视口按 2 倍设备像素采集，面板放大显示时不再发虚。
  expect(await postSize(390, 700, 2)).toMatchObject({ status: 200, body: { viewport: { width: 390, height: 700 } } })
  expect(calls.filter(call => call.method === 'Emulation.setDeviceMetricsOverride'
    && call.params.width === 390 && call.params.deviceScaleFactor === 2)).toHaveLength(1)
  expect(await (await fetch(`${api}/api/frame?targetId=owned`)).json()).toMatchObject({ vw: 390, vh: 700 })
  expect(calls.filter(call => call.method === 'Page.captureScreenshot').at(-1)).toMatchObject({
    params: { clip: { width: 390, height: 700, scale: 1 } },
  })
  // 设备像素过宽时按比例收缩，单帧体积不会随显示器像素比无限增长。
  expect(await postSize(1600, 900, 2)).toMatchObject({ status: 200 })
  expect(await (await fetch(`${api}/api/frame?targetId=owned`)).json()).toMatchObject({ vw: 1600, vh: 900 })
  expect(calls.filter(call => call.method === 'Page.captureScreenshot').at(-1)).toMatchObject({
    params: { clip: { width: 1600, height: 900, scale: 0.8 } },
  })
  // Host 按用户设置下发宽度上限：设备像素换算成缩放比，UI 页面走无损 PNG。
  expect(await (await fetch(`${api}/api/frame?targetId=owned&quality=90&maxWidth=800`)).json())
    .toMatchObject({ mime: 'image/png', vw: 1600, vh: 900 })
  expect(calls.filter(call => call.method === 'Page.captureScreenshot').at(-1)).toMatchObject({
    params: { format: 'png', clip: { width: 1600, height: 900, scale: 0.25 } },
  })
  // PNG 超出体积预算时按设置质量退回 JPEG。
  bigPng = true
  expect(await (await fetch(`${api}/api/frame?targetId=owned&quality=90&maxWidth=800`)).json())
    .toMatchObject({ mime: 'image/jpeg', data: JPEG })
  expect(calls.filter(call => call.method === 'Page.captureScreenshot').slice(-2)).toMatchObject([
    { params: { format: 'png', clip: { width: 1600, height: 900, scale: 0.25 } } },
    { params: { format: 'jpeg', quality: 90, clip: { width: 1600, height: 900, scale: 0.25 } } },
  ])
  bigPng = false
  expect((await fetch(`${api}/api/frame?targetId=owned&quality=0`)).status).toBe(400)
  expect((await fetch(`${api}/api/frame?targetId=owned&unknown=1`)).status).toBe(400)
  const hovered = await fetch(`${api}/api/hover`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: 'owned', x: 10, y: 20 }) })
  expect(await hovered.json()).toMatchObject({ ok: true, cursor: 'pointer', href: 'https://example.test/next' })
  // 真实指针移动合并后异步投递：只断言页面最终收到该坐标。
  await vi.waitFor(() => {
    expect(calls.some(call => call.method === 'Input.dispatchMouseEvent'
      && call.params.type === 'mouseMoved' && call.params.x === 10 && call.params.y === 20)).toBe(true)
  })
  const outside = await fetch(`${api}/api/hover`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: 'owned', x: 5000, y: 20 }) })
  expect(outside.status).toBe(400)
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
