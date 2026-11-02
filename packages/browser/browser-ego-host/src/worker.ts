/** ego-cast 仅经本机回环读取；Host 负责最终的会话过滤与准入。 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { egoStateDirectory } from './session-space.ts'

const WORKER = fileURLToPath(new URL('../bin/ego-cast-worker.mjs', import.meta.url))
let startPromise: Promise<number | null> | undefined
let lastAttempt = 0

async function runningWorker(): Promise<number | null> {
  try {
    const state: unknown = JSON.parse(await readFile(join(egoStateDirectory(), 'ego-cast.json'), 'utf8'))
    if (!state || typeof state !== 'object' || !('port' in state) || !('pid' in state)
      || !Number.isInteger(state.port) || (state.port as number) < 1 || (state.port as number) > 65535
      || !Number.isInteger(state.pid) || (state.pid as number) < 1) return null
    process.kill(state.pid as number, 0)
    const health = await workerGet(state.port as number, '/api/health')
    return health && typeof health === 'object' && 'workerOk' in health && health.workerOk === true
      ? state.port as number : null
  } catch { return null }
}

/** 只在可信 HTTP 请求或工具已启动浏览器后惰性启动本地 worker。 */
export async function ensureWorker(ctx: Context): Promise<number | null> {
  const active = await runningWorker()
  if (active !== null) return active
  if (startPromise) return startPromise
  if (Date.now() - lastAttempt < 8000) return null
  lastAttempt = Date.now()
  startPromise = (async () => {
    try {
      const handle = ctx.subprocess.spawn({
        argv: [process.execPath, WORKER, JSON.stringify({ captureBackend: 'cdp' })],
        cwd: process.cwd(),
        stdio: { stdin: { data: '' }, stdout: { maxBytes: 8192 }, stderr: { maxBytes: 4096 } },
        graceMs: 10_000,
        env: (process.versions as { electron?: string }).electron ? { ELECTRON_RUN_AS_NODE: '1' } : undefined,
      })
      void handle.done.catch(() => {})
      for (let attempts = 0; attempts < 40; attempts++) {
        const port = await runningWorker()
        if (port !== null) return port
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    } catch { /* 子进程缺失或不就绪时只显示空画面。 */ }
    return null
  })()
  try { return await startPromise }
  finally { startPromise = undefined }
}

/** 查询已知的 worker 只读端点，绝不透传浏览器请求路径。 */
export async function workerGet(port: number, path: '/api/health' | '/api/spaces' | `/api/frame?targetId=${string}`): Promise<unknown> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(4000) })
    return response.ok ? await response.json() as unknown : null
  } catch { return null }
}

/** 受控写请求：只用于已核验会话与目标的路由，不转发任意路径。 */
export async function workerPost(port: number, path: '/api/close' | '/api/input' | '/api/navigation', body: Record<string, unknown>): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(4000),
    })
    const result: unknown = await response.json()
    return response.ok && result !== null && typeof result === 'object' && 'ok' in result && result.ok === true
  } catch { return false }
}

/** 悬停仅转发已归属当前会话的坐标，结果由调用方再次检查 target。 */
export async function workerHover(port: number, body: { targetId: string; x: number; y: number }): Promise<unknown> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/hover`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    })
    return response.ok ? await response.json() as unknown : null
  } catch { return null }
}

/** 输入仅在上层完整校验与归属复核通过后发送封闭字段。 */
export async function workerInput(port: number, body: Record<string, unknown>): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(4000),
    })
    const result: unknown = await response.json()
    return response.ok && result !== null && typeof result === 'object' && 'ok' in result && result.ok === true
  } catch { return false }
}
