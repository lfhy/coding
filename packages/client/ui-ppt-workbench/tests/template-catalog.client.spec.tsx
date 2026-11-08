// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from 'coding-client-test-runtime'
import { createSnapshotStore, type SessionListState, type WorkspaceListState } from 'coding-client-runtime/client'
import type { TranslateNS } from 'coding-client-ui-slots'
import type { PptDeck } from 'coding-ppt-model'
import { TemplateCatalog, TemplateSettingsSection, type TemplateCatalogProps, type TemplateSettingsProps } from '../src/client/TemplateCatalog.tsx'
import { BUILTIN_LAYOUTS, TemplateCatalogController, type PptTemplateId, type TemplateCatalogState } from '../src/client/template-catalog.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import type { TemplateHandoffId } from '../src/client/template-navigation.ts'

afterEach(() => { cleanup() })

let availablePreviewWidth = 236
class FixedResizeObserver {
  private static readonly instances = new Set<FixedResizeObserver>()
  constructor(private readonly callback: (entries: { contentRect: { width: number } }[]) => void) {}
  observe(): void { FixedResizeObserver.instances.add(this); this.notify() }
  unobserve(): void {}
  disconnect(): void { FixedResizeObserver.instances.delete(this) }
  private notify(): void { this.callback([{ contentRect: { width: availablePreviewWidth } }]) }
  static resize(width: number): void {
    availablePreviewWidth = width
    for (const observer of FixedResizeObserver.instances) observer.notify()
  }
}
globalThis.ResizeObserver = FixedResizeObserver as unknown as typeof ResizeObserver

const ID = '123e4567-e89b-42d3-a456-426614174000' as PptTemplateId
const summary = { id: ID, name: '季度汇报', pages: 1, createdAt: 42, sourceName: 'source.pptx', dropped: [] }
const deck: PptDeck = { format: 1, title: '季度汇报', size: '16:9', theme: 'ink', pages: [
  { id: 'page-1', name: '封面', background: null, transition: 'none', elements: [] },
] }
const builtinDeck: PptDeck = {
  format: 1, title: '内置单页版式', size: '16:9', theme: 'paper',
  pages: BUILTIN_LAYOUTS.map(({ id, key }) => ({
    id, name: zh[key], background: null, transition: 'none',
    elements: [{
      id: `${id}-title`, kind: 'text', x: 80, y: 80, w: 500, h: 80,
      text: { content: zh[key], size: 48, color: '#23201b', bold: true,
        align: 'left', valign: 'top', font: '' },
    }],
  })),
}
const ready: TemplateCatalogState = {
  phase: 'ready', templates: [summary], details: { [ID]: { ...summary, deck } }, error: null,
  builtins: { phase: 'ready', deck: builtinDeck, error: null },
}
const dictionary: Record<string, string> = zh
const t: TranslateNS<typeof NS> = (key, params) => (dictionary[key] ?? key)
  .replace(/\{(\w+)\}/gu, (match, name: string) => typeof params?.[name] === 'number'
    || typeof params?.[name] === 'string' ? String(params[name]) : match)

function face(state: TemplateCatalogState = ready) {
  const catalog = createSnapshotStore<TemplateCatalogState>(state)
  const actions = {
    t, useTemplateCatalog: bindSnapshotSelector(catalog),
    loadTemplates: vi.fn(async () => {}), loadBuiltins: vi.fn(async () => {}), detailTemplate: vi.fn(async () => {}),
    templateMediaUrl: vi.fn(() => `/api/ppt/templates/media?id=${ID}&path=picture.png`),
    handoffPrompt: vi.fn(async (_text: string, _id: TemplateHandoffId) => {}),
    cancelHandoff: vi.fn((_id: TemplateHandoffId) => {}),
    focusPrompt: vi.fn((_id: TemplateHandoffId) => {}),
  } satisfies TemplateCatalogProps
  return actions
}

const sessionList = createSnapshotStore<SessionListState>({
  ids: [], byId: {}, current: undefined, phase: 'ready',
  subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
})
const workspaceList = createSnapshotStore<WorkspaceListState>({
  items: [], archivedSessionIds: [], state: 'idle', phase: 'pending', error: null,
  baselinesReady: false, recentWorkspaceId: undefined,
})

describe('只读 PPT 模板目录', () => {
  it('区分整稿模板与七种内置单页版式，并用回调交接创建/使用提示词', async () => {
    const actions = face()
    render(<TemplateCatalog {...actions} />)
    expect(screen.getAllByText('季度汇报')).toHaveLength(2)
    expect(screen.getByRole('heading', { name: '内置单页版式' })).toBeTruthy()
    expect(screen.getByText(/不是预装的整份演示文稿模板/u)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /用.+版式创建/u })).toHaveLength(7)
    for (const { key } of BUILTIN_LAYOUTS) {
      expect(screen.getByLabelText(`${zh[key]}版式预览`).textContent).toContain(zh[key])
    }
    expect(screen.queryByRole('button', { name: '改名' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull()
    expect(screen.queryByLabelText('选择 .pptx 文件')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '导入 / 创建模板' }))
    await waitFor(() => { expect(actions.handoffPrompt.mock.calls[0]?.[0]).toBe('帮我生成PPT模版') })
    fireEvent.click(screen.getByRole('button', { name: '使用此模板' }))
    await waitFor(() => { expect(actions.handoffPrompt.mock.calls[1]?.[0]).toBe(
      `请使用“季度汇报”这个 PPT 模板（模板 ID：${ID}）创建一份演示文稿。`,
    ) })
    fireEvent.click(screen.getByRole('button', { name: '用图表页版式创建' }))
    await waitFor(() => { expect(actions.handoffPrompt.mock.calls[2]?.[0]).toContain('template: chart') })
    const prompt = actions.handoffPrompt.mock.calls[2]?.[0]
    expect(prompt).toContain('创建可编辑的 PPT 页面')
    expect(prompt).toContain('未给主题时先做可替换的占位文案')
    expect(prompt).toContain('必须依据原稿证据，不得把占位内容当成修复完成')
    expect(prompt).toContain('请实际调用 PPT 工具，不要只回复方案')
    expect(en.useBuiltinLayoutPrompt).toContain('template: {id}')
    expect(en.useBuiltinLayoutPrompt).toContain('rely on evidence from the original')
    expect(en.useBuiltinLayoutPrompt).toContain('do not treat placeholders as a completed repair')
    expect(actions.focusPrompt).toHaveBeenCalledTimes(3)
    expect(actions.focusPrompt.mock.calls.map(([id]) => id))
      .toEqual(actions.handoffPrompt.mock.calls.map(([, id]) => id))
  })

  it('第一页预览宽度跟随可用内宽，设置保留自身标题', () => {
    availablePreviewWidth = 236
    const actions = face()
    render(<TemplateCatalog {...actions} />)
    expect(screen.getByRole('heading', { name: 'PPT 模板管理' })).toBeTruthy()
    const preview = screen.getByLabelText('第一页预览')
    expect((preview.firstElementChild as HTMLElement).style.width).toBe('236px')
    act(() => { FixedResizeObserver.resize(172) })
    expect((preview.firstElementChild as HTMLElement).style.width).toBe('172px')
    expect((screen.getByLabelText('图表页版式预览').firstElementChild as HTMLElement).style.width).toBe('172px')
  })

  it('设置交接成功后先关闭设置再请求聚焦对话输入', async () => {
    const steps: string[] = []
    const actions = face()
    actions.handoffPrompt.mockImplementation(async () => { steps.push('handoff') })
    actions.focusPrompt.mockImplementation(() => { steps.push('focus') })
    const props = {
      ...actions, close: () => { steps.push('close') },
      useSessions: bindSnapshotSelector(sessionList), useWorkspaces: bindSnapshotSelector(workspaceList),
    } satisfies TemplateSettingsProps
    render(<TemplateSettingsSection {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '导入 / 创建模板' }))
    await waitFor(() => { expect(steps).toEqual(['handoff', 'close', 'focus']) })
  })

  it('展示详情报告的实际丢失项，保留失败与重试入口', () => {
    const actions = face({ ...ready,
      details: { [ID]: { ...summary, dropped: ['SmartArt / 封面'], deck } },
    })
    const view = render(<TemplateCatalog {...actions} />)
    expect(screen.getByText(/导入时未保留：SmartArt \/ 封面/u)).toBeTruthy()
    view.unmount()
    const failed = face({ ...ready, phase: 'error', error: '目录无法读取' })
    render(<TemplateCatalog {...failed} />)
    expect(screen.getByRole('alert').textContent).toBe('目录无法读取')
    expect(screen.queryByText('季度汇报')).toBeNull()
    expect(screen.getByLabelText('封面版式预览')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(failed.loadTemplates).toHaveBeenCalledTimes(2)
  })

  it('个人库加载与空模板状态不遮挡内置版式', () => {
    const loading = render(<TemplateCatalog {...face({ ...ready, phase: 'loading', templates: [], details: {} })} />)
    expect(screen.getByRole('status').textContent).toBe('正在读取模板…')
    loading.unmount()
    render(<TemplateCatalog {...face({ ...ready, templates: [], details: {} })} />)
    expect(screen.getByText(/还没有整稿模板/u)).toBeTruthy()
    expect(screen.getByRole('heading', { name: '内置单页版式' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '使用此模板' })).toBeNull()
  })

  it('handoff 失败只显示错误，不自动发送或隐藏目录', async () => {
    const actions = face()
    actions.handoffPrompt.mockRejectedValueOnce(new Error('当前草稿已有内容'))
    render(<TemplateCatalog {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: '导入 / 创建模板' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('当前草稿已有内容') })
    expect(screen.getByRole('button', { name: '导入 / 创建模板' })).toBeTruthy()
    expect(actions.focusPrompt).not.toHaveBeenCalled()
  })

  it('设置分区卸载会取消正在交接的令牌，迟到成功不会关闭或聚焦', async () => {
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const actions = face()
    actions.handoffPrompt.mockReturnValueOnce(waiting)
    const close = vi.fn()
    const props = {
      ...actions, close,
      useSessions: bindSnapshotSelector(sessionList), useWorkspaces: bindSnapshotSelector(workspaceList),
    } satisfies TemplateSettingsProps
    const view = render(<TemplateSettingsSection {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '导入 / 创建模板' }))
    const id = actions.handoffPrompt.mock.calls[0]?.[1]
    expect(id).toBeDefined()
    view.unmount()
    expect(actions.cancelHandoff).toHaveBeenCalledWith(id)
    await act(async () => { release(); await waiting })
    expect(close).not.toHaveBeenCalled()
    expect(actions.focusPrompt).not.toHaveBeenCalled()
  })

  it('内置版式独立加载、失败和重试，个人模板仍可用', () => {
    const loading = face({ ...ready, builtins: { phase: 'loading', deck: null, error: null } })
    const view = render(<TemplateCatalog {...loading} />)
    expect(screen.getByRole('status').textContent).toBe('正在读取内置版式预览…')
    expect(screen.getByRole('button', { name: '使用此模板' })).toBeTruthy()
    view.unmount()
    const failed = face({ ...ready, builtins: { phase: 'error', deck: null, error: '预览错误' } })
    render(<TemplateCatalog {...failed} />)
    expect(screen.getByRole('alert').textContent).toContain('预览错误')
    fireEvent.click(screen.getByRole('button', { name: '重试内置版式' }))
    expect(failed.loadBuiltins).toHaveBeenCalledTimes(2)
    expect(failed.loadTemplates).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '使用此模板' })).toBeTruthy()
  })

  it('内置版式交接失败可重试，卸载取消令牌且不抢焦点', async () => {
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const actions = face()
    actions.handoffPrompt.mockReturnValueOnce(waiting)
    const view = render(<TemplateCatalog {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: '用封面版式创建' }))
    expect(screen.getByRole('button', { name: '用章节页版式创建' }).hasAttribute('disabled')).toBe(true)
    const id = actions.handoffPrompt.mock.calls[0]?.[1]
    view.unmount()
    expect(actions.cancelHandoff).toHaveBeenCalledWith(id)
    await act(async () => { release(); await waiting })
    expect(actions.focusPrompt).not.toHaveBeenCalled()
  })
})

describe('目录 HTTP 边界', () => {
  it('按需读取详情并合并并发请求，媒体路径安全编码', async () => {
    const calls: string[] = []
    const fetcher = vi.fn(async (path: string) => {
      calls.push(path)
      if (path === '/api/ppt/templates') return Response.json({ ok: true, templates: [summary] })
      return Response.json({ ok: true, template: { ...summary, deck } })
    })
    const catalog = new TemplateCatalogController(fetcher)
    await catalog.load()
    expect(catalog.view.getSnapshot().templates).toEqual([summary])
    await Promise.all([catalog.detail(ID), catalog.detail(ID)])
    expect(calls).toEqual(['/api/ppt/templates', `/api/ppt/templates/detail?id=${ID}`])
    expect(catalog.mediaUrl(ID, 'media/foo.png')).toBe(`/api/ppt/templates/media?id=${ID}&path=media%2Ffoo.png`)
  })

  it('拒绝坏列表，卸载时中止请求且不发布迟到结果', async () => {
    let release!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { release = resolve })
    const fetcher = vi.fn(async (_path: string, _init?: RequestInit) => pending)
    const catalog = new TemplateCatalogController(fetcher)
    const task = catalog.load()
    catalog.dispose()
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    release(Response.json({ ok: true, templates: [summary] }))
    await task
    expect(catalog.view.getSnapshot().templates).toEqual([])
    const invalid = new TemplateCatalogController(async () => Response.json({ ok: true, templates: [{ ...summary, id: 'x' }] }))
    await invalid.load()
    expect(invalid.view.getSnapshot().phase).toBe('error')
  })

  it('按需合并七版式读取，严格验证响应及顺序，不与个人目录错误互相覆盖', async () => {
    const paths: string[] = []
    const catalog = new TemplateCatalogController(async (path) => {
      paths.push(path)
      if (path.endsWith('/builtins')) return Response.json({ ok: true, deck: builtinDeck })
      return Response.json({ ok: false, error: { message: '个人目录不可用' } }, { status: 500 })
    })
    await Promise.all([catalog.loadBuiltins(), catalog.loadBuiltins(), catalog.load()])
    expect(paths.filter(path => path.endsWith('/builtins'))).toHaveLength(1)
    expect(catalog.view.getSnapshot().builtins.deck?.pages.map(page => page.id))
      .toEqual(BUILTIN_LAYOUTS.map(item => item.id))
    expect(catalog.view.getSnapshot().phase).toBe('error')
    expect(catalog.view.getSnapshot().builtins.phase).toBe('ready')
    await catalog.loadBuiltins()
    expect(paths.filter(path => path.endsWith('/builtins'))).toHaveLength(1)

    const invalid = new TemplateCatalogController(async () => Response.json({
      ok: true, deck: { ...builtinDeck, pages: [...builtinDeck.pages].reverse() },
    }))
    await invalid.loadBuiltins()
    expect(invalid.view.getSnapshot().builtins.phase).toBe('error')
    expect(invalid.view.getSnapshot().builtins.deck).toBeNull()
  })

  it('销毁时中止内置版式请求，不发布迟到页面', async () => {
    let release!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { release = resolve })
    const fetcher = vi.fn(async (_path: string, _init?: RequestInit) => pending)
    const catalog = new TemplateCatalogController(fetcher)
    const task = catalog.loadBuiltins()
    catalog.dispose()
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    release(Response.json({ ok: true, deck: builtinDeck }))
    await task
    expect(catalog.view.getSnapshot().builtins.deck).toBeNull()
  })
})
