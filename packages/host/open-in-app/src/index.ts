/**
 * 工作区打开能力的 Host 半边：探测本机应用、提供应用图标与启动端点，并为
 * Remote-SSH 或无宿主桌面的工作区提供 Session 绑定的文件预览与用户终端。浏览器侧配套包是
 * `@deepseek-ai/dsh-client-ui-open-in-app`。
 *
 * 安全边界集中在本模块。每条路由都先调用 composition 的 connection
 * `requestRejection`，统一执行 Host/Origin 防护与浏览器认证。所有 POST
 * 请求再校验媒体类型、64 KiB body 上限和封闭载荷；工作区根只读取 Session
 * header，路径逐段匹配 provider 返回的子项，不把浏览器字符串拼成 provider
 * target。终端 upgrade 使用同一信任检查，并在 Agent 的执行世界中启动用户 PTY。
 *
 * 应用目录在插件生命周期内惰性解析一次。点击只使用已验证启动器；若启动器
 * 以 ENOENT 消失，只刷新该条目一次。远端 marker、SSH 启动或 marker 损坏
 * 都不会落入本机应用启动路径，而是切到内置文件页或在文件页呈现读取失败。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import {
  remoteWorkspacePath,
} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-subprocess'
import { launchedThroughSsh, launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import { OPEN_IN_APP_CATALOG, type OpenInAppApp } from './catalog.ts'
import {
  launchResolved,
  resolveLaunch,
  resolveOpenInAppApps,
  type OpenInAppInternals,
  type OpenInAppResolvedLaunch,
} from './resolver.ts'
import { extractAppIcon, type OpenInAppIcon } from './icons.ts'
import { internals } from './internals.ts'
import { OpenInAppTerminalGateway } from './terminal.ts'
import {
  OPEN_IN_APP_APPS_ROUTE,
  OPEN_IN_APP_FILES_ROUTE,
  OPEN_IN_APP_ICON_PREFIX,
  OPEN_IN_APP_OPEN_ROUTE,
  OPEN_IN_APP_READ_ROUTE,
  OPEN_IN_APP_TARGET_ROUTE,
  OPEN_IN_APP_TERMINAL_ROUTE,
  type OpenInAppOpenPayload,
  type OpenInAppOpenResult,
  type OpenInAppTargetPayload,
  type OpenInAppTargetRequest,
} from './shared.ts'
import {
  listWorkspaceFiles,
  parseFilesRequest,
  parseReadRequest,
  readWorkspaceFile,
  WorkspaceProtocolError,
} from './workspace.ts'

export type * from './shared.ts'

/** Cordis function-plugin 名称。 */
export const name = 'open-in-app'
/** 路由载体、认证栅栏、Session/Agent 身份与跨执行世界执行能力。 */
export const inject = ['webServer', 'connection', 'subprocess', 'fs', 'sessions', 'agents']

/** open-in-app Host 配置。 */
export interface Config {
  /** catalog 探测命令（`xcode-select`、Windows 注册表）的单次期限。 */
  readonly probeTimeoutMs: number
  /** 图标提取命令（macOS `plutil`/`sips`、Windows PowerShell）的单次期限。 */
  readonly iconTimeoutMs: number
  /** 启动器仍存活即视为成功的早期失败观察窗口。 */
  readonly launchWatchMs: number
  /** 单个文件预览允许读取的最大完整文件字节数。 */
  readonly previewMaxBytes: number
}

const boundedMs = (): z<number> => z.number().step(1).min(1).max(600_000).required()

export const Config: z<Config> = z.object({
  probeTimeoutMs: boundedMs(),
  iconTimeoutMs: boundedMs(),
  launchWatchMs: boundedMs(),
  previewMaxBytes: z.number().step(1).min(1).max(32 * 1024 * 1024).default(2 * 1024 * 1024),
})

/** 本模块消费的最小 connection 信任接口。 */
interface OpenInAppConnection {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** 从 composition 取得浏览器侧 connection 服务的 Host 信任接口。 */
function connectionOf(ctx: Context): OpenInAppConnection {
  return Reflect.get(ctx, 'connection') as OpenInAppConnection
}

const MAX_BODY_BYTES = 64 * 1024

/** 发送不缓存的 JSON 响应。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 发送带唯一允许方法的 405。 */
function sendMethodNotAllowed(res: ServerResponse, allow: 'GET' | 'POST'): void {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/** 收集有界 UTF-8 请求体；超过上限时排空剩余 stream 并返回 null。 */
async function readBoundedBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

type JsonBody =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: 400 | 413 | 415; readonly message: string }

/** 校验 JSON 媒体类型和 body 上限，并解析一个 wire 值。 */
async function readJsonBody(req: IncomingMessage): Promise<JsonBody> {
  const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
  if (essence !== 'application/json') {
    return { ok: false, status: 415, message: 'content-type must be application/json' }
  }
  let text: string | null
  try {
    text = await readBoundedBody(req)
  } catch {
    return { ok: false, status: 400, message: 'request body unreadable' }
  }
  if (text === null) return { ok: false, status: 413, message: 'request body is too large' }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, status: 400, message: 'request body must be valid JSON' }
  }
}

/** JSON object 判定，供封闭 wire parser 共用。 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 只接受 `{ path: string }`。 */
function parseTargetBody(value: unknown): OpenInAppTargetRequest | undefined {
  const body = recordOf(value)
  if (body === undefined || Object.keys(body).some(key => key !== 'path') || typeof body.path !== 'string') {
    return undefined
  }
  return { path: body.path }
}

/** 只接受 `{ app: string, path: string }`。 */
function parseOpenBody(value: unknown): OpenInAppOpenPayload | undefined {
  const body = recordOf(value)
  if (body === undefined || Object.keys(body).some(key => key !== 'app' && key !== 'path')
    || typeof body.app !== 'string' || typeof body.path !== 'string') return undefined
  return { app: body.app, path: body.path }
}

/** 本地目录是否存在；Remote-SSH marker 由 target 分类单独处理。 */
async function localDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

type WorkspaceTargetKind = 'local' | 'files' | 'missing'

/**
 * 对一次工作区打开进行 fail-closed 分类。Remote-SSH marker、损坏 marker 和
 * 经 SSH 启动的 Host 都不能进入本机应用分支；普通本地目录才返回 local。
 */
async function workspaceTargetKind(path: string, ssh: boolean): Promise<WorkspaceTargetKind> {
  try {
    if (await remoteWorkspacePath(path, path) !== undefined) return 'files'
  } catch {
    return 'files'
  }
  if (ssh) return 'files'
  return await localDirectory(path) ? 'local' : 'missing'
}

/** 读取 JSON body，失败时直接回答统一 wire 错误。 */
async function acceptedJson(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const body = await readJsonBody(req)
  if (body.ok) return body.value
  sendJson(res, body.status, { code: 'bad-request', message: body.message })
  return undefined
}

/** 将预期工作区拒绝映射为稳定响应，并隐藏 provider 失败细节。 */
function sendWorkspaceError(res: ServerResponse, error: unknown): void {
  if (error instanceof WorkspaceProtocolError) {
    sendJson(res, error.status, { code: error.code, message: error.message })
    return
  }
  sendJson(res, 502, { code: 'workspace-files-unavailable', message: 'workspace files are unavailable' })
}

/** 注册应用目录、启动、Session 文件协议和用户终端 upgrade。 */
export function apply(ctx: Context, config: Config): void {
  const ssh = launchedThroughSsh(launchEnvironmentOf(ctx))
  const catalogInternals = (): OpenInAppInternals => ({
    ssh,
    resolveExecutable: async (command) => {
      try {
        return await ctx.subprocess.resolveExecutable(command)
      } catch {
        return null
      }
    },
    ...internals.catalog,
  })

  let resolutions: Promise<Map<string, OpenInAppResolvedLaunch>> | undefined
  const availability = (): Promise<Map<string, OpenInAppResolvedLaunch>> =>
    resolutions ??= resolveOpenInAppApps(config.probeTimeoutMs, catalogInternals())
  const icons = new Map<string, Promise<OpenInAppIcon | null>>()
  const iconOf = (app: OpenInAppApp, resolved: OpenInAppResolvedLaunch): Promise<OpenInAppIcon | null> => {
    let cached = icons.get(app.id)
    if (cached === undefined) {
      cached = extractAppIcon(app, resolved, config.iconTimeoutMs, catalogInternals())
      icons.set(app.id, cached)
    }
    return cached
  }
  const refreshResolution = async (app: OpenInAppApp): Promise<OpenInAppResolvedLaunch | undefined> => {
    const map = await availability()
    const fresh = await resolveLaunch(app, config.probeTimeoutMs, catalogInternals())
    icons.delete(app.id)
    if (fresh === null) {
      map.delete(app.id)
      return undefined
    }
    map.set(app.id, fresh)
    return fresh
  }
  const rejected = (req: IncomingMessage, res: ServerResponse): boolean => {
    const rejection = connectionOf(ctx).requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_IN_APP_APPS_ROUTE,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      sendJson(res, 200, { apps: [...(await availability()).keys()] })
    },
  }), `open-in-app: GET ${OPEN_IN_APP_APPS_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_IN_APP_TARGET_ROUTE,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      const raw = await acceptedJson(req, res)
      if (raw === undefined) return
      const body = parseTargetBody(raw)
      if (body === undefined) {
        sendJson(res, 400, { code: 'bad-request', message: 'request body must contain only string "path"' })
        return
      }
      if (body.path === '' || !isAbsolute(body.path) || body.path.includes('\0')) {
        sendJson(res, 400, { code: 'bad-request', message: 'path must be an absolute directory path' })
        return
      }
      const kind = await workspaceTargetKind(body.path, ssh)
      if (kind === 'missing') {
        sendJson(res, 404, { code: 'not-found', message: `workspace directory is unavailable: ${body.path}` })
        return
      }
      const payload: OpenInAppTargetPayload = kind === 'files'
        ? { kind: 'files', apps: [] }
        : { kind: 'local', apps: [...(await availability()).keys()] }
      sendJson(res, 200, payload)
    },
  }), `open-in-app: POST ${OPEN_IN_APP_TARGET_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: OPEN_IN_APP_ICON_PREFIX,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      const pathname = new URL(String(req.url), 'http://localhost').pathname
      const id = pathname.slice(OPEN_IN_APP_ICON_PREFIX.length).replace(/^\//, '')
      const noIcon = (): void => {
        sendJson(res, 404, { code: 'not-found', message: `no icon for ${id}` })
      }
      const app = OPEN_IN_APP_CATALOG.find(entry => entry.id === id)
      if (app === undefined) {
        noIcon()
        return
      }
      const resolved = (await availability()).get(app.id)
      if (resolved === undefined) {
        noIcon()
        return
      }
      const icon = await iconOf(app, resolved)
      if (icon === null) {
        noIcon()
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', icon.contentType)
      res.setHeader('cache-control', 'public, max-age=3600')
      res.end(icon.bytes)
    },
  }), `open-in-app: GET ${OPEN_IN_APP_ICON_PREFIX}/<id>`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_IN_APP_OPEN_ROUTE,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      const raw = await acceptedJson(req, res)
      if (raw === undefined) return
      const body = parseOpenBody(raw)
      if (body === undefined) {
        sendJson(res, 400, { code: 'bad-request', message: 'request body must contain string "app" and "path"' })
        return
      }
      if (body.path === '' || !isAbsolute(body.path) || body.path.includes('\0')) {
        sendJson(res, 400, { code: 'bad-request', message: 'path must be an absolute directory path' })
        return
      }
      const targetKind = await workspaceTargetKind(body.path, ssh)
      if (targetKind === 'missing') {
        sendJson(res, 404, { code: 'not-found', message: `directory does not exist: ${body.path}` })
        return
      }
      if (targetKind === 'files') {
        const result: OpenInAppOpenResult = { ok: true, action: 'files' }
        sendJson(res, 200, result)
        return
      }
      const app = OPEN_IN_APP_CATALOG.find(entry => entry.id === body.app)
      const resolved = app === undefined ? undefined : (await availability()).get(app.id)
      if (app === undefined || resolved === undefined) {
        sendJson(res, 400, { code: 'bad-request', message: `unknown or unavailable app: ${body.app}` })
        return
      }
      let outcome = await launchResolved(resolved, body.path, config.launchWatchMs, catalogInternals())
      if (outcome === 'missing') {
        const fresh = await refreshResolution(app)
        outcome = fresh === undefined
          ? 'failed'
          : await launchResolved(fresh, body.path, config.launchWatchMs, catalogInternals())
      }
      if (outcome !== 'launched') {
        sendJson(res, 502, { code: 'launch-failed', message: `failed to launch ${app.id}` })
        return
      }
      const result: OpenInAppOpenResult = { ok: true, action: 'launched' }
      sendJson(res, 200, result)
    },
  }), `open-in-app: POST ${OPEN_IN_APP_OPEN_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_IN_APP_FILES_ROUTE,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      const raw = await acceptedJson(req, res)
      if (raw === undefined) return
      const body = parseFilesRequest(raw)
      if (body === undefined) {
        sendJson(res, 400, { code: 'bad-request', message: 'invalid session workspace path' })
        return
      }
      try {
        sendJson(res, 200, await listWorkspaceFiles(ctx, body))
      } catch (error) {
        sendWorkspaceError(res, error)
      }
    },
  }), `open-in-app: POST ${OPEN_IN_APP_FILES_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_IN_APP_READ_ROUTE,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      const raw = await acceptedJson(req, res)
      if (raw === undefined) return
      const body = parseReadRequest(raw)
      if (body === undefined) {
        sendJson(res, 400, { code: 'bad-request', message: 'invalid session workspace file' })
        return
      }
      try {
        sendJson(res, 200, await readWorkspaceFile(ctx, body, config.previewMaxBytes))
      } catch (error) {
        sendWorkspaceError(res, error)
      }
    },
  }), `open-in-app: POST ${OPEN_IN_APP_READ_ROUTE}`)

  const terminal = new OpenInAppTerminalGateway(ctx)
  ctx.effect(() => {
    const unregister = ctx.webServer.registerUpgrade({
      path: OPEN_IN_APP_TERMINAL_ROUTE,
      handler: (req, socket, head) => { terminal.handle(req, socket, head) },
    })
    return async () => {
      unregister()
      await terminal.close()
    }
  }, `open-in-app: WS ${OPEN_IN_APP_TERMINAL_ROUTE}`)
}
