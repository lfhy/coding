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
import { StaleNoteError, type FileLibrary, type MindMapSnapshot, type OfficeSnapshot } from 'coding-file-library'
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
  const office = {
    readNoteOffice: vi.fn<FileLibrary['readNoteOffice']>(),
    createNoteOffice: vi.fn<FileLibrary['createNoteOffice']>(),
    editNoteOffice: vi.fn<FileLibrary['editNoteOffice']>(),
    exportNoteOffice: vi.fn<FileLibrary['exportNoteOffice']>(),
    saveExport: vi.fn<FileLibrary['saveExport']>(),
  }
  ctx.provide('fileLibrary', {
    notesRootPath: () => notesRoot, readNoteMindmap: readMindmap, createNoteMindmap: createMindmap, editNoteMindmap: editMindmap,
    ...office,
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
  return { agent: live.agent, plugin, readMindmap, createMindmap, editMindmap, office }
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
  it('以 Loader 支持的函数插件注册笔记标签、导图和办公工具', async () => {
    const { agent } = await boot()
    expect('default' in notesTabs).toBe(false)
    expect(notesTabs.name).toBe('tool-notes-tabs')
    expect(notesTabs.inject).toEqual(['tools', 'webServer', 'connection', 'sessions', 'agents', 'fileLibrary', 'sandboxPolicy'])
    expect(ctx?.tools.get('notes_tabs')?.name).toBe('notes_tabs')
    expect(ctx?.tools.get('notes_mindmap')?.name).toBe('notes_mindmap')
    expect(ctx?.tools.get('notes_office')?.name).toBe('notes_office')
    expect(ctx?.tools.get('notes_tabs')?.parameters).toEqual({ type: 'object', properties: {} })
    expect(agent.id).toBe(SESSION)
  })

  it('卸载插件时同时移除模型工具与发布路由', async () => {
    const { plugin } = await boot()
    expect(ctx?.tools.get('notes_mindmap')).toBeDefined()
    await plugin.dispose()
    expect(ctx?.tools.get('notes_mindmap')).toBeUndefined()
    expect(ctx?.tools.get('notes_office')).toBeUndefined()
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
    expect(first.value).toMatchObject({ path, revision: 'rev1', totalTopics: 31 })
    const offset = (first.value as { nextOffset: number }).nextOffset
    expect(offset).toBeGreaterThan(0)
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

/** 经执行器验证模型的结构化参数、只读边界与结果。 */
function callOffice(agent: Agent | undefined, args: object) {
  return ctx!.tools.execute({
    name: 'notes_office', callId: 'office-call' as never, arguments: args,
    signal: new AbortController().signal, ...(agent === undefined ? {} : { agent }),
  })
}

describe('笔记助手 Word 和 Excel', () => {
  const wordPath = '会议纪要.codingword'
  const word: OfficeSnapshot = {
    path: wordPath, revision: 'word-1',
    document: { kind: 'word', version: 1, paragraphs: [{ style: 'heading1', runs: [{ text: '结果', bold: true }] }] },
  }
  const sheetId = 'first'
  const excelPath = '预算.codingexcel'
  const excel: OfficeSnapshot = {
    path: excelPath, revision: 'excel-1',
    document: { kind: 'excel', version: 1, sheets: [{ id: sheetId, name: '预算表',
      cells: [{ row: 0, column: 0, value: null, formula: '=SUM(B2:B5)' }, { row: 1, column: 0, value: 20 }],
    }] },
  }
  it.each([word, excel])('只从唯一真实活动窗口选择 $path', async (snapshot) => {
    const { agent, office } = await boot()
    office.readNoteOffice.mockResolvedValue(snapshot)
    const { path, document } = snapshot
    await writeFile(join(notesRoot!, path), '{}')
    const body = { sessionId: SESSION, windowId: 'window', version: 1,
      activeTabPath: path, activeKind: document.kind, openTabs: [path] }
    await expect(publish({ ...body, activeKind: 'mindmap' })).resolves.toMatchObject({ status: 400 })
    expect((await callOffice(agent, { action: 'read' })).isError).toBe(true)
    expect(office.readNoteOffice).not.toHaveBeenCalled()
    await expect(publish(body)).resolves.toMatchObject({ status: 200 })
    await expect(callOffice(agent, { action: 'read' })).resolves.toMatchObject({
      isError: false, value: { path, revision: snapshot.revision, kind: document.kind, offset: 0, nextOffset: null },
    })
    await expect(publish({ ...body, windowId: 'other' })).resolves.toMatchObject({ status: 200 })
    expect((await callOffice(agent, { action: 'read' })).isError).toBe(true)
    expect(office.readNoteOffice).toHaveBeenCalledExactlyOnceWith(path)
  })

  it('报告超长项的截断且不跳过正文，续读需要上一页的路径和版本', async () => {
    const { agent, office } = await boot()
    const paragraphs = [
      { style: 'normal' as const, runs: [{ text: '🙂'.repeat(8_000) }] },
      ...Array.from({ length: 30 }, () => ({ style: 'title' as const, runs: [{ text: '列席代表' }] })),
    ]
    office.readNoteOffice.mockResolvedValue({ ...word, document: { kind: 'word', version: 1, paragraphs } })
    const first = await callOffice(agent, { action: 'read', path: wordPath })
    if (first.isError) throw new Error(JSON.stringify(first.content))
    expect(first.value).toMatchObject({ total: 31, nextOffset: 24, paragraphs: [
      { index: 0, truncated: true, preview: '🙂'.repeat(128) },
      ...Array.from({ length: 23 }, (_, index) => ({ index: index + 1, style: 'title' })),
    ] })
    expect(Buffer.byteLength(JSON.stringify(first.value))).toBeLessThanOrEqual(8 * 1024)
    for (const revision of [undefined, 'old']) {
      const args = { action: 'read', path: wordPath, offset: 24, ...(revision === undefined ? {} : { revision }) }
      expect((await callOffice(agent, args)).isError).toBe(true)
    }
    await expect(callOffice(agent, { action: 'read', path: wordPath, revision: 'word-1', offset: 24 }))
      .resolves.toMatchObject({ isError: false, value: { nextOffset: null,
        paragraphs: Array.from({ length: 7 }, (_, index) => ({ index: index + 24 })),
      } })
  })

  it('分页读取工作表元数据及单元格，保留公式和类型', async () => {
    const { agent, office } = await boot()
    office.readNoteOffice.mockResolvedValue(excel)
    await expect(callOffice(agent, { action: 'read', path: excelPath })).resolves.toMatchObject({
      isError: false, value: { sheets: [{ id: sheetId, name: '预算表', cellCount: 2, mergeCount: 0 }] },
    })
    const readSheet = { action: 'read', path: excelPath, sheetId }
    expect((await callOffice(agent, readSheet)).isError).toBe(true)
    await expect(callOffice(agent, { ...readSheet, revision: 'excel-1',
      range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
    })).resolves.toMatchObject({ isError: false, value: {
      sheetId, total: 1, cells: [{ row: 0, column: 0, value: null, formula: '=SUM(B2:B5)' }],
    } })
  })

  it('不接受无 Agent、非笔记会话或只读会话写入', async () => {
    const { agent, office } = await boot('read-only')
    office.readNoteOffice.mockResolvedValue(excel)
    const read = { action: 'read', path: excelPath }
    for (const caller of [undefined, { ...agent }]) expect((await callOffice(caller, read)).isError).toBe(true)
    expect((await callOffice(agent, read)).isError).toBe(false)
    const target = { path: excelPath, revision: 'excel-1' }
    for (const args of [{ action: 'create', name: '预算', kind: 'excel' }, { action: 'export', ...target },
      { action: 'edit', ...target, edits: [{ op: 'add_sheet', name: 'Actual' }] }]) {
      expect((await callOffice(agent, args)).isError).toBe(true)
    }
    expect(office.createNoteOffice).not.toHaveBeenCalled()
    expect(office.editNoteOffice).not.toHaveBeenCalled()
    expect(office.exportNoteOffice).not.toHaveBeenCalled()
    expect(office.saveExport).not.toHaveBeenCalled()
    agent.session.append('agent-preset/selected', { agentPreset: 'standard' })
    expect((await callOffice(agent, read)).isError).toBe(true)
  })

  it('只按明确版本写入或保存成品，不重试冲突文件', async () => {
    const { agent, office } = await boot()
    office.createNoteOffice.mockResolvedValue({ path: wordPath })
    await expect(callOffice(agent, { action: 'create', kind: 'word', name: '会议纪要' }))
      .resolves.toMatchObject({ isError: false, value: { path: wordPath } })
    const edits = [{ op: 'set_cells', sheetId, cells: [{ row: 0, column: 0, value: null }] }]
    expect((await callOffice(agent, { action: 'edit', revision: 'excel-1', edits })).isError).toBe(true)
    expect(office.editNoteOffice).not.toHaveBeenCalled()
    office.editNoteOffice.mockRejectedValueOnce(new StaleNoteError())
      .mockResolvedValueOnce({ ...excel, revision: 'excel-2' })
    expect((await callOffice(agent, { action: 'edit', path: excelPath, revision: 'stale', edits })).isError).toBe(true)
    expect(office.editNoteOffice).toHaveBeenCalledExactlyOnceWith(excelPath, 'stale', edits)
    await expect(callOffice(agent, { action: 'edit', path: excelPath, revision: 'excel-1', edits }))
      .resolves.toMatchObject({ isError: false, value: { path: excelPath, kind: 'excel', revision: 'excel-2' } })
    const name = '预算.xlsx'
    const mediaType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    const bytes = new Uint8Array([80, 75])
    office.exportNoteOffice.mockResolvedValue({ name, mediaType, bytes })
    office.saveExport.mockResolvedValue({ record: { id: 'export-id', name }, path: '/private/export' } as never)
    await expect(callOffice(agent, { action: 'export', path: excelPath, revision: 'excel-2' }))
      .resolves.toMatchObject({ isError: false, value: { fileId: 'export-id', name } })
    expect(office.exportNoteOffice).toHaveBeenCalledExactlyOnceWith(excelPath, 'excel-2')
    expect(office.saveExport).toHaveBeenCalledExactlyOnceWith({ name, mediaType, data: bytes, sessionId: SESSION })
  })
})
