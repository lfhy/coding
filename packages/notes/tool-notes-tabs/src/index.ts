/**
 * 笔记页打开标签的 Host 快照：发布源只给相对路径，Host 负责查证真实文件与绝对路径。
 * 快照按会话和窗口保存在内存中，重启或预设卸载后不能重建，必须由页面重新发布。
 * @module coding-tool-notes-tabs
 */
import { lstat, realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from 'coding-session/types'
import type { Agent } from 'coding-agent'
import type {} from 'coding-client-connection'
import type {} from 'coding-file-library'
import type {} from 'coding-host-webserver'
import { defineTool } from 'coding-tools'
import type { NotesTabsPublishRequest, NotesTabsPublishResponse } from './protocol.ts'

export type { NotesTabsPublishRequest, NotesTabsPublishResponse } from './protocol.ts'

export const name = 'tool-notes-tabs'
export const inject = ['tools', 'webServer', 'connection', 'sessions', 'agents', 'fileLibrary']

const ROUTE = '/api/notes/tabs'
const MAX_BODY_BYTES = 64 * 1024
const MAX_TABS = 64
const WINDOW_TTL_MS = 30 * 1000

type VerifiedTab = {
  readonly path: string
  readonly absolutePath: string
}

interface Snapshot {
  readonly sessionId: string
  readonly windowId: string
  readonly version: number
  readonly openTabs: readonly VerifiedTab[]
  readonly activeTabPath: string | null
  readonly activeKind: 'note' | 'ppt'
  readonly updatedAt: number
}

type ReadResult = {
  status: 'ready'
  sessionId: string
  windowId: string
  version: number
  openTabs: VerifiedTab[]
  activeTabPath: string | null
  activeKind: 'note' | 'ppt'
} | { status: 'unavailable'; reason: 'not-published' | 'window-closed' | 'ambiguous-window' | 'session-mismatch' }

type PublishResult = { status: 200 | 400 | 409; body: NotesTabsPublishResponse }

/** 校验标识后再查 live agent；客户端宣称的 sessionId 本身不能授予读取能力。 */
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** 拒绝绝对路径、越级路径、控制字符与非规范分隔符，避免客户端输入伪造根目录文件。 */
function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !isAbsolute(value) && !/^[A-Za-z]:/u.test(value) && !/[\\\u0000-\u001f\u007f]/u.test(value)
    && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
    && ['.md', '.markdown', '.pptx'].includes(extname(value).toLowerCase())
}

/** 网络 body 必须是一份完整且一致的标签集；null 表示确实没有活动文件。 */
function parsePublish(value: unknown): NotesTabsPublishRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const body = value as Record<string, unknown>
  if (Object.keys(body).some(key => !['sessionId', 'windowId', 'version', 'openTabs', 'activeTabPath', 'activeKind'].includes(key))
    || !validId(body.sessionId) || !validId(body.windowId)
    || !Number.isSafeInteger(body.version) || (body.version as number) < 1
    || !Array.isArray(body.openTabs) || body.openTabs.length > MAX_TABS
    || !body.openTabs.every(validPath) || new Set(body.openTabs).size !== body.openTabs.length
    || (body.activeTabPath !== null && !validPath(body.activeTabPath))
    || (body.activeTabPath !== null && !body.openTabs.includes(body.activeTabPath))
    || (body.activeKind !== 'note' && body.activeKind !== 'ppt')
    || body.activeTabPath !== null
      && (body.activeKind === 'ppt') !== body.activeTabPath.toLowerCase().endsWith('.pptx')) return undefined
  return body as unknown as NotesTabsPublishRequest
}

/** 限长解析 JSON；失败不能影响当前已发布的快照。 */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) throw new TypeError('body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown
}

/** 复用文件库当前根目录，逐段拒绝符号链接；发布时只相信这次核验的文件。 */
async function verifyTabs(root: string, paths: readonly string[]): Promise<VerifiedTab[]> {
  const realRoot = await realpath(root)
  const tabs: VerifiedTab[] = []
  for (const path of paths) {
    const absolutePath = join(root, ...path.split('/'))
    const realParent = await realpath(resolve(absolutePath, '..'))
    if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) throw new TypeError('path outside notes')
    const stat = await lstat(absolutePath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError('not a regular note file')
    tabs.push({ path, absolutePath })
  }
  return tabs
}

/** 当前 live agent 与会话必须是同一实例、已在 notes 预设并使用文件库根目录。 */
function ownsNotes(ctx: Context, sessionId: string): Agent | undefined {
  const agent = ctx.agents.get(sessionId as SessionId)
  if (agent === undefined || agent.session !== ctx.sessions.get(sessionId as SessionId)
    || agent.session.header.agentPreset !== 'notes'
    || agent.session.header.cwd !== ctx.fileLibrary.notesRootPath()) return undefined
  return agent
}

/** 仅本机同源可发布；connection 的 Host 防重绑检查仍先于会话校验。 */
function trusted(ctx: Context, req: IncomingMessage): boolean {
  if (ctx.connection.requestRejection(req) !== undefined) return false
  const host = req.headers.host
  const port = ctx.webServer.port
  return ctx.webServer.host === '127.0.0.1'
    && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
    && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host ?? '')
    && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}

function send(res: ServerResponse, status: number, body: NotesTabsPublishResponse): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}

/** 注册一次 HTTP 发布与一次模型读取；卸载、关闭会话和窗口失联后均不复用旧快照。 */
export function apply(ctx: Context): void {
  const bySession = new Map<string, Map<string, Snapshot>>()
  const invalid: PublishResult = { status: 400, body: { ok: false, error: 'invalid' } }
  const mismatch: PublishResult = { status: 409, body: { ok: false, error: 'session-mismatch' } }
  const publish = async (value: unknown): Promise<PublishResult> => {
    const body = parsePublish(value)
    if (body === undefined) return invalid
    if (ownsNotes(ctx, body.sessionId) === undefined) return mismatch
    const windows = bySession.get(body.sessionId) ?? new Map<string, Snapshot>()
    const previous = windows.get(body.windowId)
    if (previous !== undefined && body.version <= previous.version) {
      return { status: 409, body: { ok: false, error: 'stale' } }
    }
    let openTabs: VerifiedTab[]
    try { openTabs = await verifyTabs(ctx.fileLibrary.notesRootPath(), body.openTabs) }
    catch { return invalid }
    if (ownsNotes(ctx, body.sessionId) === undefined) return mismatch
    // 真实文件核验是异步的：再次比较版本，旧请求不得覆盖较新的已提交状态。
    if (body.version <= (bySession.get(body.sessionId)?.get(body.windowId)?.version ?? 0)) {
      return { status: 409, body: { ok: false, error: 'stale' } }
    }
    const currentWindows = bySession.get(body.sessionId) ?? new Map<string, Snapshot>()
    currentWindows.set(body.windowId, { ...body, openTabs, updatedAt: Date.now() })
    bySession.set(body.sessionId, currentWindows)
    return { status: 200, body: { ok: true, sessionId: body.sessionId, windowId: body.windowId, version: body.version } }
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: ROUTE,
    handler: async (req, res) => {
      if (!trusted(ctx, req)) { res.writeHead(403); res.end(); return }
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
      if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        res.writeHead(415); res.end(); return
      }
      let value: unknown
      try { value = await readBody(req) }
      catch { send(res, invalid.status, invalid.body); return }
      const result = await publish(value)
      send(res, result.status, result.body)
    },
  }), 'tool-notes-tabs: POST /api/notes/tabs')
  ctx.on('agent/disposed', ({ agent }) => { bySession.delete(agent.id) })
  ctx.effect(() => () => { bySession.clear() }, 'tool-notes-tabs: release published snapshots')
  ctx.tools.register(defineTool({
    name: 'notes_tabs',
    description: 'Read the current notes page\'s open file tabs, active file, and verified full paths. '
      + 'Returns unavailable when the page has not published, no window remains, or multiple windows are open. '
      + 'Do not infer a path when unavailable.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec): Promise<ReadResult> {
      if (exec.agent === undefined || ownsNotes(ctx, exec.agent.session.id) !== exec.agent) {
        return { status: 'unavailable', reason: 'session-mismatch' }
      }
      exec.signal.throwIfAborted()
      const windows = bySession.get(exec.agent.session.id)
      if (windows === undefined) return { status: 'unavailable', reason: 'not-published' }
      const live = [...windows.values()].filter(snapshot => Date.now() - snapshot.updatedAt <= WINDOW_TTL_MS)
      if (live.length === 0) return { status: 'unavailable', reason: 'window-closed' }
      if (live.length > 1) return { status: 'unavailable', reason: 'ambiguous-window' }
      const snapshot = live[0]
      if (snapshot === undefined) return { status: 'unavailable', reason: 'window-closed' }
      try {
        const openTabs = await verifyTabs(ctx.fileLibrary.notesRootPath(), snapshot.openTabs.map(tab => tab.path))
        exec.signal.throwIfAborted()
        if (ownsNotes(ctx, exec.agent.session.id) !== exec.agent) {
          return { status: 'unavailable', reason: 'session-mismatch' }
        }
        if (bySession.get(exec.agent.session.id)?.get(snapshot.windowId) !== snapshot
          || Date.now() - snapshot.updatedAt > WINDOW_TTL_MS) {
          return { status: 'unavailable', reason: 'window-closed' }
        }
        return { status: 'ready', sessionId: snapshot.sessionId, windowId: snapshot.windowId,
          version: snapshot.version, openTabs, activeTabPath: snapshot.activeTabPath, activeKind: snapshot.activeKind }
      } catch {
        return { status: 'unavailable', reason: 'window-closed' }
      }
    },
    presentCall: () => ({ card: 'generic', title: '读取笔记标签', kind: 'read' }),
  }))
}
