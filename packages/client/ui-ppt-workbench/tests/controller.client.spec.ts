import { PPT_FORMAT } from 'coding-ppt-model'
import { describe, expect, it, vi } from 'vitest'
import { PptPanelController } from '../src/client/controller.ts'

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
})
