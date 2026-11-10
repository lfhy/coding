import { PPT_FORMAT, type PptElement } from 'coding-ppt-model'
import { describe, expect, it, vi } from 'vitest'
import { PptPanelController } from '../src/client/controller.ts'
import type { PptSnapshotView } from '../src/client/wire.ts'

const SESSION = 'ppt-controller-session'
const ROOT = '/presentation-workspace'
const project = {
  dir: `${ROOT}/ppt/deck`, title: '季度汇报', revision: 1, pages: 1,
  canUndo: false, canRedo: false,
  deck: { format: PPT_FORMAT, title: '季度汇报', size: '16:9', theme: 'ink', pages: [
    { id: 'page-1', name: '封面', background: null, transition: 'none', elements: [] },
  ] },
}

/** 用响应桩隔离 UI 轮询，确认已有工程的通知只被消费一次。 */
function fetcherFor(openRequest: { dir: string; at: number } | null, active: unknown = project) {
  const requests: { path: string; body: unknown }[] = []
  const fetcher = vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    requests.push({ path, body })
    if (path.startsWith('/api/ppt/state?')) return Response.json({ ok: true, state: {
      root: ROOT, projects: [], active, openRequest,
    } })
    if (path === '/api/ppt/ack') return Response.json({ ok: true })
    throw new Error(`unexpected request: ${path}`)
  })
  return { fetcher, requests }
}

function editableProject(): PptSnapshotView {
  const text: PptElement = { id: 'text-1', kind: 'text', x: 100, y: 100, w: 300, h: 80,
    text: { content: '报告', size: 32, bold: false, color: '#111111', align: 'left', valign: 'top', font: '' } }
  const image: PptElement = { id: 'image-1', kind: 'image', x: 220, y: 180, w: 360, h: 240,
    source: 'media/old.png', fit: 'contain' }
  const table: PptElement = { id: 'table-1', kind: 'table', x: 200, y: 200, w: 400, h: 180,
    rows: 2, columns: 2, columnWeights: [1, 1], header: true, headerFill: '#eeeeee', borderColor: '#333333',
    text: { size: 20, color: '#111111', bold: false, align: 'left', font: '' },
    cells: [[{ content: '项目' }, { content: '值' }], [{ content: '预算' }, { content: '100' }]] }
  return { ...project, pages: 2, deck: { ...project.deck, size: '16:9', theme: 'ink', pages: [
    { ...project.deck.pages[0]!, transition: 'none' as const, elements: [text, image, table] },
    { id: 'page-2', name: '第二页', background: null, transition: 'none', elements: [] },
  ] } }
}

function editingFetcher(initial: unknown = editableProject()) {
  let active: unknown = initial
  let failEdit = false
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const fetcher = vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    const body = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as Record<string, unknown>
    requests.push({ path, body })
    if (path.startsWith('/api/ppt/state?')) return Response.json({ ok: true, state: {
      root: ROOT, projects: [], active, openRequest: null,
    } })
    if (path === '/api/ppt/edit') {
      if (failEdit) return Response.json({ ok: false, error: { code: 'conflict', message: '版本冲突' } }, { status: 409 })
      const snapshot = active as typeof project
      active = { ...snapshot, revision: snapshot.revision + 1 }
      return Response.json({ ok: true, project: active })
    }
    if (path === `/api/ppt/upload?sessionId=${SESSION}`) {
      expect(body).toMatchObject({ dir: project.dir, name: 'new.png' })
      expect(body).not.toHaveProperty('sessionId')
      return Response.json({ ok: true, source: 'media/replaced.png' })
    }
    throw new Error(`unexpected request: ${path}`)
  })
  return { fetcher, requests, failNextEdit: () => { failEdit = true }, setActive: (next: unknown) => { active = next } }
}

describe('PPT 面板轮询', () => {
  it('接受宿主已有的绝对工程快照并确认相对路径的打开通知，不再触发 open', async () => {
    const { fetcher, requests } = fetcherFor({ dir: 'ppt/deck', at: 17 })
    const panel = new PptPanelController(SESSION, fetcher)
    await panel.refresh()
    expect(panel.view.getSnapshot()).toMatchObject({ phase: 'ready', project: { dir: project.dir, title: '季度汇报' } })
    expect(requests.map(item => item.path)).toEqual([
      `/api/ppt/state?sessionId=${SESSION}`, '/api/ppt/ack',
    ])
    expect(requests[1]?.body).toEqual({ sessionId: SESSION, at: 17 })
    panel.dispose()
  })

  it('模型切到另一工程时采用宿主最新快照，清理旧选中状态', async () => {
    const first = { ...project, dir: `${ROOT}/ppt/first`, title: '第一份' }
    let active: unknown = first
    let openRequest: { dir: string; at: number } | null = null
    const requests: string[] = []
    const fetcher = vi.fn(async (path: string): Promise<Response> => {
      requests.push(path)
      if (path.startsWith('/api/ppt/state?')) return Response.json({ ok: true, state: {
        root: ROOT, projects: [], active, openRequest,
      } })
      if (path === '/api/ppt/ack') return Response.json({ ok: true })
      throw new Error(`unexpected request: ${path}`)
    })
    const panel = new PptPanelController(SESSION, fetcher)
    await panel.refresh()
    panel.selectElement('selected')
    panel.setEditing('selected')
    active = project
    openRequest = { dir: 'ppt/deck', at: 20 }
    await panel.refresh()
    expect(panel.view.getSnapshot()).toMatchObject({
      phase: 'ready', project: { dir: project.dir }, selectedId: null, editingId: null,
    })
    expect(requests).toEqual([`/api/ppt/state?sessionId=${SESSION}`,
      `/api/ppt/state?sessionId=${SESSION}`, '/api/ppt/ack'])
    panel.dispose()
  })

  it('确认请求失败时仍显示已读取的工程，下一次可重试确认', async () => {
    const requests: string[] = []
    const fetcher = vi.fn(async (path: string): Promise<Response> => {
      requests.push(path)
      if (path.startsWith('/api/ppt/state?')) return Response.json({ ok: true, state: {
        root: ROOT, projects: [], active: project, openRequest: { dir: 'ppt/deck', at: 21 },
      } })
      if (path === '/api/ppt/ack') return Response.json({ ok: false }, { status: 503 })
      throw new Error(`unexpected request: ${path}`)
    })
    const panel = new PptPanelController(SESSION, fetcher)
    await panel.refresh()
    expect(panel.view.getSnapshot()).toMatchObject({ phase: 'ready', project: { dir: project.dir } })
    await panel.refresh()
    expect(requests.filter(path => path === '/api/ppt/ack')).toHaveLength(2)
    panel.dispose()
  })

  it('没有工程时保持可用并且不回执', async () => {
    const empty = fetcherFor(null, null)
    const panel = new PptPanelController('another', empty.fetcher)
    await panel.refresh()
    expect(panel.view.getSnapshot()).toMatchObject({ phase: 'ready', project: null })
    expect(empty.requests).toHaveLength(1)
    panel.dispose()
  })

  it('跨页粘贴新元素，切工程清空剪贴区，冲突保留内容供重试', async () => {
    const service = editingFetcher()
    const panel = new PptPanelController(SESSION, service.fetcher)
    await panel.refresh()
    panel.copyElement('text-1')
    expect(panel.view.getSnapshot().hasClipboard).toBe(true)
    panel.selectPage(1)
    await panel.pasteElement({ x: 1200, y: 690 })
    const first = service.requests.filter(request => request.path === '/api/ppt/edit')[0]?.body
    expect(first).toMatchObject({ baseRevision: 1, ops: [{ op: 'add_element', page: 'page-2',
      element: { kind: 'text', x: 980, y: 640, w: 300, h: 80, text: { content: '报告' } } }] })
    expect((first?.ops as { element: { id?: string } }[])[0]?.element.id).toBeUndefined()
    service.failNextEdit()
    await panel.pasteElement()
    expect(panel.view.getSnapshot()).toMatchObject({ hasClipboard: true, notice: { tone: 'conflict' } })
    service.setActive({ ...editableProject(), dir: `${ROOT}/ppt/other` })
    await panel.refresh()
    expect(panel.view.getSnapshot().hasClipboard).toBe(false)
    await panel.pasteElement()
    expect(service.requests.filter(request => request.path === '/api/ppt/edit')).toHaveLength(2)
    panel.dispose()
  })

  it('剪切与单元格修改提交旧页数据，图片替换使用专用操作', async () => {
    const service = editingFetcher()
    const panel = new PptPanelController(SESSION, service.fetcher)
    await panel.refresh()
    await panel.cutElement('text-1')
    expect(service.requests.find(request => request.path === '/api/ppt/edit')?.body)
      .toMatchObject({ ops: [{ op: 'remove_element', page: 'page-1', element: 'text-1' }] })
    await panel.editCell('table-1', 1, 0, '')
    expect(service.requests.filter(request => request.path === '/api/ppt/edit')[1]?.body)
      .toMatchObject({ ops: [{ op: 'update_element', page: 'page-1', element: 'table-1',
        cells: [[{ content: '项目' }, { content: '值' }], [{ content: '' }, { content: '100' }]] }] })
    const image = { name: 'new.png', arrayBuffer: async () => Uint8Array.of(137, 80, 78).buffer } as File
    await panel.insertImage(image, 'image-1')
    expect(service.requests.filter(request => request.path === '/api/ppt/edit')[2]?.body)
      .toMatchObject({ ops: [{ op: 'replace_image', page: 'page-1', element: 'image-1', source: 'media/replaced.png' }] })
    expect(service.requests.filter(request => request.path === `/api/ppt/upload?sessionId=${SESSION}`)).toHaveLength(1)
    panel.dispose()
  })

  it('替换矩形与占位文字时一次提交，非法目标和失效标签不上传', async () => {
    const base = editableProject()
    const rect: PptElement = { id: 'placeholder', kind: 'rect', x: 96, y: 188, w: 254, h: 143, fill: '#e8e5dc' }
    const label: PptElement = { id: 'label', kind: 'text', x: 96, y: 188, w: 254, h: 143,
      text: { content: '代码截图', size: 14, color: '#75736c', bold: false, align: 'center', valign: 'middle', font: '' } }
    const first = base.deck.pages[0]!
    const service = editingFetcher({ ...base, deck: { ...base.deck, pages: [
      { ...first, elements: [...first.elements, rect, label] }, ...base.deck.pages.slice(1),
    ] } })
    const panel = new PptPanelController(SESSION, service.fetcher)
    await panel.refresh()
    const image = { name: 'new.png', arrayBuffer: async () => Uint8Array.of(137, 80, 78).buffer } as File
    await panel.insertImage(image, 'text-1')
    await panel.insertImage(image, 'placeholder', 'text-1')
    expect(service.requests.filter(request => request.path === `/api/ppt/upload?sessionId=${SESSION}`)).toHaveLength(0)
    await panel.insertImage(image, 'placeholder', 'label')
    expect(service.requests.filter(request => request.path === `/api/ppt/upload?sessionId=${SESSION}`)).toHaveLength(1)
    expect(service.requests.find(request => request.path === '/api/ppt/edit')?.body).toMatchObject({
      baseRevision: 1, ops: [{ op: 'replace_image', page: 'page-1', element: 'placeholder', label: 'label', source: 'media/replaced.png' }],
    })
    panel.dispose()
  })
})
