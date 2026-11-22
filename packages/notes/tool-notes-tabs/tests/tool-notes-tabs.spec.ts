import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from 'coding-agent'
import type { Agent, AgentStatus } from 'coding-agent'
import SessionStore, { SessionId, Session } from 'coding-session'
import ToolRuntime from 'coding-tools'
import { StaleNoteError, type MindMapSnapshot } from 'coding-file-library'
import SystemPrompt from 'coding-system-prompt'
import TypertRegistry from 'coding-typert-registry'
import * as notesTabs from '../src/index.ts'

const SESSION = 'notes-tabs-test-session'
let ctx: Context | undefined
let root: string | undefined
let notesRoot: string | undefined
/** 发布路由由 WebServer 注入；测试直接调用同一个 handler，不监听真实端口。 */
let route: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
}

function stubAgent(session: Session): StubAgent {
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  const status: AgentStatus = 'running'
  const agent: Agent = {
    id: session.id, options: {}, session, inbox,
    get status() { return status },
    ctx: new Context(), send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  return { agent, session }
}

async function boot(mode: 'workspace-write' | 'read-only' = 'workspace-write') {
  ctx = new Context()
  root = await mkdtemp(join(tmpdir(), 'coding-notes-tabs-'))
  notesRoot = join(root, 'notes')
  await mkdir(notesRoot, { recursive: true })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  const sessionStore = ctx.sessions
  sessionStore.create(SessionId(SESSION), { meta: { cwd: notesRoot, agentPreset: 'standard' } })
  const liveSession = sessionStore.get(SessionId(SESSION))!
  // 笔记页先创建空白会话，再切换预设；创建头不能代表正在使用的工具集。
  liveSession.append('agent-preset/selected', { agentPreset: 'notes' })
  const live = stubAgent(liveSession)
  ctx.agents.register(live.agent)
  const readMindmap = vi.fn<(path: string) => Promise<MindMapSnapshot>>()
  const createMindmap = vi.fn<(name: string, directory?: string) => Promise<{ path: string }>>()
  const editMindmap = vi.fn<(path: string, revision: string, edits: unknown) => Promise<MindMapSnapshot>>()
  ctx.provide('fileLibrary', {
    notesRootPath: () => notesRoot, readNoteMindmap: readMindmap, createNoteMindmap: createMindmap, editNoteMindmap: editMindmap,
  } as never)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode }) } as never)
  ctx.provide('connection', { requestRejection: () => undefined } as never)
  route = undefined
  ctx.provide('webServer', {
    port: 0, host: '127.0.0.1',
    register: (entry: { handler: typeof route }) => {
      route = entry.handler
      return () => { route = undefined }
    },
  } as never)
  const plugin = await ctx.plugin(notesTabs)
  return { agent: live.agent, plugin, readMindmap, createMindmap, editMindmap }
}

/** 以一次同源 POST 调用发布路由，返回状态码与解析后的响应体。 */
async function publish(body: unknown): Promise<{ status: number; body: unknown }> {
  if (route === undefined) throw new Error('发布路由未注册')
  const payload = Buffer.from(JSON.stringify(body))
  let status = 0
  let text = ''
  const req = {
    method: 'POST', url: '/api/notes/tabs',
    headers: { host: '127.0.0.1:0', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield payload },
  } as unknown as IncomingMessage
  const res = {
    writeHead(code: number) { status = code },
    end(chunk?: string) { if (typeof chunk === 'string') text = chunk },
  } as unknown as ServerResponse
  await route(req, res)
  return { status, body: text === '' ? undefined : JSON.parse(text) }
}

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  notesRoot = undefined
})

describe('notes tabs protocol', () => {
  it('以 Loader 支持的函数插件注册笔记标签和导图工具', async () => {
    const { agent } = await boot()
    expect('default' in notesTabs).toBe(false)
    expect(notesTabs.name).toBe('tool-notes-tabs')
    expect(notesTabs.inject).toEqual(['tools', 'webServer', 'connection', 'sessions', 'agents', 'fileLibrary', 'sandboxPolicy'])
    expect(ctx?.tools.get('notes_tabs')?.name).toBe('notes_tabs')
    expect(ctx?.tools.get('notes_mindmap')?.name).toBe('notes_mindmap')
    expect(ctx?.tools.get('notes_tabs')?.parameters).toEqual({ type: 'object', properties: {} })
    expect(agent.id).toBe(SESSION)
  })

  it('卸载插件时同时移除模型工具与发布路由', async () => {
    const { plugin } = await boot()
    expect(ctx?.tools.get('notes_mindmap')).toBeDefined()
    await plugin.dispose()
    expect(ctx?.tools.get('notes_mindmap')).toBeUndefined()
    expect(ctx?.tools.get('notes_tabs')).toBeUndefined()
    expect(route).toBeUndefined()
  })

  it('publishes a .codingppt tab as the active ppt tab and rejects mismatched kinds', async () => {
    const { agent } = await boot()
    await writeFile(join(notesRoot!, 'hello.md'), '# Hello')
    await mkdir(join(notesRoot!, '演示.codingppt'))
    await mkdir(join(notesRoot!, 'data'), { recursive: true })
    const body = { sessionId: SESSION, windowId: 'window', version: 1,
      openTabs: ['hello.md', '演示.codingppt'], activeTabPath: '演示.codingppt', activeKind: 'ppt' }
    await expect(publish(body)).resolves.toMatchObject({ status: 200, body: { ok: true } })
    const result = await ctx!.tools.execute({
      name: 'notes_tabs', callId: 'notes-tabs-deck' as never, arguments: {},
      signal: new AbortController().signal, agent,
    })
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toMatchObject({ status: 'ready', activeKind: 'ppt',
      activeTabPath: '演示.codingppt', openTabs: [{ path: 'hello.md' }, { path: '演示.codingppt' }] })

    // 普通目录不能被声明成幻灯片，Markdown 也不能声明成 ppt。
    await expect(publish({ ...body, openTabs: ['data'], activeTabPath: 'data' })).resolves.toMatchObject({ status: 400 })
    await expect(publish({ ...body, openTabs: ['hello.md'], activeTabPath: 'hello.md' }))
      .resolves.toMatchObject({ status: 400 })
  })

  it('rejects a fake session and does not derive a path from the filesystem', async () => {
    const { agent } = await boot()
    await writeFile(join(notesRoot!, 'hello.md'), '# Hello')
    const result = await ctx!.tools.execute({
      name: 'notes_tabs', callId: 'notes-tabs-call' as never, arguments: {},
      signal: new AbortController().signal, agent,
    })
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toEqual({ status: 'unavailable', reason: 'not-published' })
  })
})

/** 经真实工具执行器验证参数、权限、输出转换和同窗选择。 */
function callMindmap(agent: Agent | undefined, args: object) {
  return ctx!.tools.execute({
    name: 'notes_mindmap', callId: 'mindmap-call' as never, arguments: args,
    signal: new AbortController().signal, ...(agent === undefined ? {} : { agent }),
  })
}

describe('笔记助手思维导图', () => {
  const path = '路线.codingmindmap'
  const snapshot: MindMapSnapshot = {
    path, revision: 'rev1',
    document: { version: 1, root: {
      id: 'root', text: '出行', children: [{ id: 'child', text: '交通', children: [] }],
    } },
  }

  it('只从唯一窗口读取合法活动导图，拒绝伪装类型、目录与别名', async () => {
    const { agent, readMindmap } = await boot()
    readMindmap.mockResolvedValue(snapshot)
    await writeFile(join(notesRoot!, path), '{}')
    await mkdir(join(notesRoot!, 'false.codingmindmap'))
    await symlink(notesRoot!, join(notesRoot!, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    const body = { sessionId: SESSION, windowId: 'window', version: 1, openTabs: [path], activeTabPath: path, activeKind: 'mindmap' }
    for (const invalid of [
      { ...body, activeKind: 'note' },
      ...['false.codingmindmap', `alias/${path}`].map(fake => ({ ...body, openTabs: [fake], activeTabPath: fake })),
    ]) await expect(publish(invalid)).resolves.toMatchObject({ status: 400 })
    expect((await callMindmap(agent, { action: 'read' })).isError).toBe(true)
    expect(readMindmap).not.toHaveBeenCalled()
    await expect(publish(body)).resolves.toMatchObject({ status: 200 })
    await expect(callMindmap(agent, { action: 'read' })).resolves.toMatchObject({
      isError: false, value: { path, revision: 'rev1', topics: [
        { id: 'root', text: '出行', parentId: null }, { id: 'child', text: '交通', parentId: 'root' },
      ], totalTopics: 2, nextOffset: null },
    })
    await expect(publish({ ...body, windowId: 'another' })).resolves.toMatchObject({ status: 200 })
    expect((await callMindmap(agent, { action: 'read' })).isError).toBe(true)
    expect(readMindmap).toHaveBeenCalledTimes(1)
    expect((await callMindmap(agent, { action: 'read', path })).isError).toBe(false)
  })

  it('分页约束完整结果字节数，续读必须核对文件和版本', async () => {
    const { agent, readMindmap } = await boot()
    const children = Array.from({ length: 30 }, (_, index) => ({ id: `item-${index}`, text: '🙂'.repeat(256), children: [] }))
    readMindmap.mockResolvedValue({ ...snapshot, document: { version: 1, root: { ...snapshot.document.root, children } } })
    const first = await callMindmap(agent, { action: 'read', path })
    expect(first.isError).toBe(false)
    if (first.isError) return
    expect(Buffer.byteLength(JSON.stringify(first.value))).toBeLessThanOrEqual(8192)
    expect(first.value).toMatchObject({ path, revision: 'rev1', totalTopics: 31, nextOffset: expect.any(Number) })
    const offset = (first.value as { nextOffset: number }).nextOffset
    expect((await callMindmap(agent, { action: 'read', offset })).isError).toBe(true)
    const second = await callMindmap(agent, { action: 'read', path, revision: 'rev1', offset })
    expect(second.isError).toBe(false)
    if (second.isError) return
    const { topics } = second.value as { topics: { id: string }[] }
    expect(topics[0]?.id).toBe(`item-${offset - 1}`)
    expect(Buffer.byteLength(JSON.stringify(second.value))).toBeLessThanOrEqual(8192)
    expect((await callMindmap(agent, { action: 'read', path, revision: 'old', offset })).isError).toBe(true)
  })

  it('拒绝无真实会话或只读助手的写入，允许只读助手查看', async () => {
    const { agent, readMindmap, createMindmap, editMindmap } = await boot('read-only')
    readMindmap.mockResolvedValue(snapshot)
    expect((await callMindmap(undefined, { action: 'read', path })).isError).toBe(true)
    expect((await callMindmap({ ...agent }, { action: 'read', path })).isError).toBe(true)
    expect((await callMindmap(agent, { action: 'create', name: '禁止' })).isError).toBe(true)
    expect((await callMindmap(agent, { action: 'edit', path, revision: 'rev1', edits: [{ op: 'delete', id: 'child' }] })).isError).toBe(true)
    expect(createMindmap).not.toHaveBeenCalled()
    expect(editMindmap).not.toHaveBeenCalled()
    expect((await callMindmap(agent, { action: 'read', path })).isError).toBe(false)
  })

  it('用显式目标与读取版本调用文件库；冲突不重试或覆盖', async () => {
    const { agent, createMindmap, editMindmap } = await boot()
    createMindmap.mockResolvedValue({ path })
    expect(await callMindmap(agent, { action: 'create', name: '路线' })).toMatchObject({ isError: false, value: { path } })
    const edits = [{ op: 'rename', id: 'child', text: '住宿' }]
    expect((await callMindmap(agent, { action: 'edit', revision: 'rev1', edits })).isError).toBe(true)
    expect(editMindmap).not.toHaveBeenCalled()
    editMindmap.mockRejectedValueOnce(new StaleNoteError()).mockResolvedValueOnce({ ...snapshot, revision: 'rev2' })
    expect((await callMindmap(agent, { action: 'edit', path, revision: 'old', edits })).isError).toBe(true)
    expect(editMindmap).toHaveBeenCalledExactlyOnceWith(path, 'old', edits)
    await expect(callMindmap(agent, { action: 'edit', path, revision: 'rev1', edits }))
      .resolves.toMatchObject({ isError: false, value: { path, revision: 'rev2' } })
    expect(editMindmap).toHaveBeenLastCalledWith(path, 'rev1', edits)
  })
})
