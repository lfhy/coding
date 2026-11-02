/** ego-lite 浏览器 Host：完整移植上游 35 个安全工具定义，并保留会话与信任边界。 @module coding-browser-ego-host */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from 'coding-tools'
import type {} from 'coding-client-connection'
import type {} from 'coding-host-webserver'
import type {} from 'coding-session'
import type {} from 'coding-subprocess'
import type { SessionId } from 'coding-session/types'
import { markToolStart } from './activity.ts'
import { parseScriptResult } from './scripts.ts'
import { spaceNameForSession, targetIdsForSession } from './session-space.ts'
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
  '/api/ego/navigation',
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

  /** 在执行入口记录活动历史，失败仍交给上游工具自己报告。 */
  private observe(definition: ToolDefinition): ToolDefinition {
    const execute = definition.execute.bind(definition)
    return {
      ...definition,
      execute: (args: unknown, exec: ToolRunContext) => {
        const session: { id?: unknown } | undefined = exec.agent?.session
        const id = session?.id
        if (typeof id === 'string') markToolStart(id as SessionId, definition.name)
        return execute(args, exec)
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
