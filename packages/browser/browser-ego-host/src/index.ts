/** ego-lite 浏览器 Host：完整移植上游 35 个安全工具定义，并保留会话与信任边界。 @module coding-browser-ego-host */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from 'coding-tools'
import type {} from 'coding-client-connection'
import type {} from 'coding-host-webserver'
import type {} from 'coding-session'
import type {} from 'coding-subprocess'
import type { SessionId } from 'coding-session/types'
import { markToolStart } from './activity.ts'
import { parseScriptResult } from './scripts.ts'
import { sessionSpaceArgs, spaceNameForSession, targetIdsForSession } from './session-space.ts'
import { installRoutes, trusted } from './routes.ts'
import { apply as applyUpstream } from 'coding-browser-ego-host/upstream'

/** 上游 apply 只按结构使用 Context，本地适配层集中在这里。 */
type UpstreamContext = {
  tools: { register(definition: unknown): void }
  subprocess: unknown
  get?(name: string): unknown
  effect?(fn: () => unknown, label?: string): unknown
  on?(event: string, fn: (...args: unknown[]) => unknown): () => void
  inject?(services: readonly string[], fn: (sctx: UpstreamContext) => void): void
  settings?: unknown
  /** 上游把「浏览器进程需要的环境」交回宿主，供宿主自己启动的进程复用。 */
  exportBrowserEnv?(resolve: () => NodeJS.ProcessEnv): void
}
type WebServerLike = {
  register(options: { path: string; handler?: (req: unknown, res: unknown) => unknown }): () => void
  [key: string]: unknown
}

const CLI = fileURLToPath(new URL('../runtime/ego-linux/bin/ego-browser.mjs', import.meta.url))
/** 这些端点由本项目实现会话过滤，上游同名路由不得重复注册。 */
const OWNED_PATHS = new Set([
  '/api/ego/spaces', '/api/ego/stream', '/api/ego/input', '/api/ego/status',
  '/api/ego/close', '/api/ego/history', '/api/ego/frame', '/api/ego/activity',
  '/api/ego/navigation', '/api/ego/pages', '/api/ego/hover',
])

declare module '@deepseek-ai/cordis' {
  interface Context { egoBrowser: EgoBrowserHost }
}

/** 默认使用内置 Edge/Chrome 探测，用户仍可通过上游设置项覆盖。 */
function defaultChromePath(): string {
  if (process.env.EGO_LINUX_CHROME) return process.env.EGO_LINUX_CHROME
  if (process.platform !== 'darwin') return ''
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ]
  return candidates.find(existsSync) ?? ''
}

/** 服务只收集上游工具定义；模型工具由按 Agent 权限审批的消费方注册。 */
export default class EgoBrowserHost extends Service {
  static inject = ['sessions', 'subprocess']
  private readonly definitions: readonly ToolDefinition[]
  /** 上游按当前设置计算的环境（无窗口、光标标签、Chrome 路径等）。 */
  private browserEnv: (() => NodeJS.ProcessEnv) | undefined
  /** 人工新建页面按 Session 排队，空间锚页、页数与归属复核不得并发交错。 */
  private readonly pageCreates = new Map<SessionId, Promise<string | null>>()

  constructor(ctx: Context) {
    super(ctx, 'egoBrowser')
    const collected: ToolDefinition[] = []
    const proxy: UpstreamContext = {
      tools: { register: (definition: unknown) => { collected.push(this.observe(definition as ToolDefinition)) } },
      subprocess: ctx.subprocess,
      get: (name: string) => name === 'webServer'
        ? (ctx.get('webServer') === undefined ? undefined : guardedServer(ctx))
        : ctx.get(name) as unknown,
      effect: (fn, label) => ctx.effect(fn as never, label),
      on: (event, fn) => ctx.on(event as never, fn as never),
      inject: (services, fn) => { ctx.inject(services, fn as never) },
      settings: ctx.get('settings'),
      exportBrowserEnv: (resolve) => { this.browserEnv = resolve },
    }
    const config: Record<string, unknown> = {
      egoBin: CLI,
      chromePath: defaultChromePath(),
      sessionScopedSpaces: true,
      isolateSpaces: false,
      residentExecutor: true,
    }
    applyUpstream(proxy, config)
    this.definitions = Object.freeze(collected)
    installRoutes(ctx)
  }

  /**
   * 暴露上游完整工具集合给按 Agent 权限审批的消费方；本服务不碰 ctx.tools。
   * @returns 每次调用都复核调用会话的工具定义。
   */
  toolDefinitions(): readonly ToolDefinition[] { return this.definitions }

  /**
   * 把 Agent 浏览器换成真实可见窗口（用户在面板里主动要求时使用）。
   *
   * 默认的无窗口模式无法完成登录扫码或人机验证，因此这一步由用户触发；
   * 运行时的 `--open` 会把无窗口实例换成同 profile 的有窗口实例，标签页随
   * profile 恢复。命令成功只表示请求被接受，具体页面仍以面板轮询为准。
   * @returns 浏览器进程正常退出（退出码 0）时为 true。
   */
  async raiseWindow(): Promise<boolean> {
    // 复用上游为工具进程算好的环境：少了它，这里的 `--open` 会退回运行时默认值，
    // 页面上重新出现厂商光标标签，启动意图也会被记成“有窗口”。
    const env: NodeJS.ProcessEnv = { ...(this.browserEnv?.() ?? process.env) }
    if (env.EGO_LINUX_CHROME === undefined) {
      const chrome = defaultChromePath()
      if (chrome !== '') env.EGO_LINUX_CHROME = chrome
    }
    try {
      const handle = this.ctx.subprocess.spawn({
        argv: [process.execPath, CLI, '--open'],
        cwd: process.cwd(),
        env,
        stdio: {
          stdin: { data: '' },
          stdout: { maxBytes: 4096 },
          stderr: { maxBytes: 4096 },
        },
        graceMs: 30_000,
      })
      const outcome = await handle.done
      return outcome.exitCode === 0
    } catch {
      return false
    }
  }

  /**
   * 仅为空会话创建自己的任务空间页面；CLI 在该空间创建或使用空白锚页，不选全局标签。
   * @param sessionId - 已在 sessions 服务中确认存在的会话。
   * @param url - Host 已验证的绝对导航地址。
   * @returns 页面归属写入会话空间并确认仍存在时为 true。
   */
  async createSessionPage(sessionId: SessionId, url: string): Promise<boolean> {
    if ((await targetIdsForSession(sessionId)).size !== 0) return false
    const space = spaceNameForSession(sessionId)
    // CLI 的脚本以 page 为预置形参；局部变量不能重名，否则在运行前就解析失败。
    const script = `await taskSpaces.useOrCreate(${JSON.stringify(space)})\n` +
      `const createdTab = await ego.createTab(${JSON.stringify(url)})\n` +
      'console.log(\'@@DSH_RESULT@@\' + JSON.stringify({ ok: true, targetId: createdTab.targetId }))\n'
    const env: NodeJS.ProcessEnv = { ...(this.browserEnv?.() ?? process.env), EGO_ISOLATE_SPACES: '1' }
    try {
      const handle = this.ctx.subprocess.spawn({
        argv: [process.execPath, CLI, 'nodejs'], cwd: process.cwd(), env,
        stdio: { stdin: { data: script }, stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        graceMs: 30_000,
      })
      const outcome = await handle.done
      if (outcome.exitCode !== 0) return false
      const output = handle.collected.stdout?.readFrom(0).text ?? ''
      const result: unknown = parseScriptResult(output)
      if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true
        || !('targetId' in result) || typeof result.targetId !== 'string') return false
      return (await targetIdsForSession(sessionId)).has(result.targetId)
    } catch { return false }
  }

  /**
   * 在会话自己的 Agent 浏览器空间里打开一页本地 HTML 并截图。
   *
   * 页面进的是该会话的正常空间，因此右侧「Agent 浏览器」标签会像别的页面一样显示它；
   * 截图与页面共用同一个标签，不额外开一套渲染通道。同路径再次捕获时导航到
   * 唯一 URL，等待新文档完成加载后才截图；截图期间临时隐藏浏览器自身的光标标记，
   * 随后恢复页面。调用方负责先写好本地文件。
   * @param options - 会话、本地页面路径、视口尺寸与输出路径。
   * @returns 截图写入成功时为 true。
   */
  async captureSessionPage(options: {
    /** 会话身份；页面进入它的浏览器空间。 */
    readonly sessionId: SessionId
    /** 本地 HTML 的绝对路径。 */
    readonly htmlPath: string
    /** 视口宽度（CSS 像素），与 HTML 的画布宽度一致。 */
    readonly width: number
    /** 视口高度（CSS 像素）。 */
    readonly height: number
    /** 要写入的 PNG 绝对路径。 */
    readonly outPath: string
    /** 等待整页稳定的毫秒数；缺省 300。 */
    readonly settleMs?: number
  }): Promise<boolean> {
    if (!this.ctx.sessions.get(options.sessionId)) return false
    const sourceUrl = pathToFileURL(options.htmlPath).href
    const nonce = randomUUID()
    const captureUrl = new URL(sourceUrl)
    captureUrl.searchParams.set('__dsh_capture', nonce)
    const space = spaceNameForSession(options.sessionId)
    const script = `await taskSpaces.useOrCreate(${JSON.stringify(space)})\n`
      + 'const existingTabs = await browser.listTabs()\n'
      + `const sourceUrl = new URL(${JSON.stringify(sourceUrl)})\n`
      + `const captureUrl = ${JSON.stringify(captureUrl.href)}\n`
      + 'const match = existingTabs.find(t => {\n'
      + '  try { const candidate = new URL(t.url); return candidate.protocol === "file:"\n'
      + '    && candidate.host === sourceUrl.host && candidate.pathname === sourceUrl.pathname }\n'
      + '  catch { return false }\n'
      + '})\n'
      + "const tab = match ?? (await ego.createTab('about:blank'))\n"
      + 'await browser.switchTab(tab.targetId)\n'
      + "await page.goto(captureUrl, { waitUntil: 'commit' })\n"
      + "if (!(await page.waitForURL(target => target.href === captureUrl, { waitUntil: 'load', timeout: 20000 })))\n"
      + "  throw new Error('capture page did not load')\n"
      + `await cdp('Emulation.setDeviceMetricsOverride', { width: ${options.width}, height: ${options.height}, `
      + 'deviceScaleFactor: 1, mobile: false })\n'
      + `await page.waitForTimeout(${options.settleMs ?? 300})\n`
      + `const cursorStyleId = ${JSON.stringify(`dsh-capture-cursor-${nonce}`)}\n`
      + 'await page.evaluate(id => {\n'
      + "  const style = document.createElement('style')\n"
      + '  style.id = id\n'
      + "  style.textContent = '#ego-agent-cursor-overlay { visibility: hidden !important }'\n"
      + '  document.head.appendChild(style)\n'
      + '}, cursorStyleId)\n'
      + 'try {\n'
      + `  await page.screenshot({ path: ${JSON.stringify(options.outPath)} })\n`
      + '} finally {\n'
      + '  await page.evaluate(id => { document.getElementById(id)?.remove() }, cursorStyleId)\n'
      + '}\n'
      + "console.log('@@DSH_RESULT@@' + JSON.stringify({ ok: true, targetId: tab.targetId }))\n"
    const env: NodeJS.ProcessEnv = { ...(this.browserEnv?.() ?? process.env), EGO_ISOLATE_SPACES: '1' }
    try {
      const handle = this.ctx.subprocess.spawn({
        argv: [process.execPath, CLI, 'nodejs'], cwd: process.cwd(), env,
        stdio: { stdin: { data: script }, stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
        graceMs: 60_000,
      })
      const outcome = await handle.done
      if (outcome.exitCode !== 0) return false
      const result: unknown = parseScriptResult(handle.collected.stdout?.readFrom(0).text ?? '')
      return Boolean(result && typeof result === 'object' && 'ok' in result && result.ok === true)
    } catch {
      return false
    }
  }

  /**
   * 为人工工作台在指定会话空间新建一张空白页；同会话的请求串行执行，首张页面复用空间锚页。
   * @param sessionId - 页面所属的会话。
   * @returns 复核归属后的目标 id；会话不存在、页面已满或创建失败时为 null。
   */
  async createBlankPage(sessionId: SessionId): Promise<string | null> {
    const previous = this.pageCreates.get(sessionId) ?? Promise.resolve(null)
    const next = previous.then(() => this.createBlankPageNow(sessionId))
    this.pageCreates.set(sessionId, next)
    try { return await next }
    finally { if (this.pageCreates.get(sessionId) === next) this.pageCreates.delete(sessionId) }
  }

  private async createBlankPageNow(sessionId: SessionId): Promise<string | null> {
    if (!this.ctx.sessions.get(sessionId)) return null
    const space = spaceNameForSession(sessionId)
    const existing = await targetIdsForSession(sessionId)
    if (existing.size >= 30) return null
    const blankAnchor = existing.size === 0 ? 'existingTabs.find(t => t.url === "about:blank")?.targetId' : 'null'
    const script = `await taskSpaces.useOrCreate(${JSON.stringify(space)})\n` +
      'const existingTabs = await browser.listTabs()\n' +
      `const targetId = ${blankAnchor} ?? (await ego.createTab('about:blank')).targetId\n` +
      'console.log(\'@@DSH_RESULT@@\' + JSON.stringify({ ok: true, targetId }))\n'
    const env: NodeJS.ProcessEnv = { ...(this.browserEnv?.() ?? process.env), EGO_ISOLATE_SPACES: '1' }
    try {
      const handle = this.ctx.subprocess.spawn({
        argv: [process.execPath, CLI, 'nodejs'], cwd: process.cwd(), env,
        stdio: { stdin: { data: script }, stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        graceMs: 30_000,
      })
      const outcome = await handle.done
      if (outcome.exitCode !== 0) return null
      const result: unknown = parseScriptResult(handle.collected.stdout?.readFrom(0).text ?? '')
      if (!result || typeof result !== 'object' || !('targetId' in result) || typeof result.targetId !== 'string'
        || !this.ctx.sessions.get(sessionId) || !(await targetIdsForSession(sessionId)).has(result.targetId)) return null
      return result.targetId
    } catch { return null }
  }

  /** 在执行入口记录活动历史，失败仍交给上游工具自己报告。 */
  private observe(definition: ToolDefinition): ToolDefinition {
    const execute = definition.execute.bind(definition)
    return {
      ...definition,
      execute: (args: unknown, exec: ToolRunContext) => {
        const session: { id?: unknown } | undefined = exec.agent?.session
        const id = session?.id
        if (typeof id !== 'string' || !this.ctx.sessions.get(id as SessionId)) {
          throw new Error('browser tool requires a live session')
        }
        const scoped = sessionSpaceArgs(args, id as SessionId, definition.name)
        markToolStart(id as SessionId, definition.name)
        return execute(scoped, exec)
      },
    }
  }
}

/** 上游 HTTP 路由也必须经过本项目的连接信任栅栏，且不得覆盖会话化端点。 */
function guardedServer(ctx: Context): WebServerLike {
  const server = ctx.webServer
  return new Proxy(server, {
    get(target, property) {
      if (property === 'register') {
        return (options: { path: string; handler?: (req: never, res: never) => unknown }) => {
          if (OWNED_PATHS.has(options.path)) return () => {}
          const allowed = (req: Parameters<Context['connection']['requestRejection']>[0]): boolean =>
            trusted(ctx, req as never, { writeHead: () => {}, end: () => {} } as never)
          return (target.register as (options: unknown) => () => void)({
            ...options,
            handler: (req: never, res: never) => {
              if (!allowed(req)) {
                const response = res as { statusCode: number; end: () => void }
                response.statusCode = 403
                response.end()
                return
              }
              return options.handler?.(req, res)
            },
          })
        }
      }
      const value: unknown = (target as unknown as Record<PropertyKey, unknown>)[property as PropertyKey]
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    },
  }) as unknown as WebServerLike
}
