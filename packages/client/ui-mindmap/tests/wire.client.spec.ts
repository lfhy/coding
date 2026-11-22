import { afterEach, describe, expect, it, vi } from 'vitest'
import { readMindmap, type MindmapNodeId, saveMindmap } from '../src/client/wire.ts'

const PATH = '笔记/方向 & 目标.codingmindmap'
const node = { id: 'root', text: '研发', children: [] }
const snapshot = { path: PATH, revision: 'old', document: { version: 1, root: node } }
const signal = new AbortController().signal

afterEach(() => { vi.unstubAllGlobals() })

describe('导图同源接口', () => {
  it('读取当前路径并按原版本发送一项编辑，不发送文档全文', async () => {
    const saved = { ...snapshot, revision: 'new' }
    const fetch = vi.fn<(url: string, options: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json(snapshot)).mockResolvedValueOnce(Response.json(saved))
    vi.stubGlobal('fetch', fetch)
    const read = await readMindmap(PATH, signal)
    expect(read).toEqual({ kind: 'ready', snapshot })
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store', signal })
    const url = new URL(fetch.mock.calls[0]![0], 'http://localhost')
    expect([url.pathname, url.searchParams.get('path')]).toEqual(['/api/notes/mindmap/read', PATH])
    if (read.kind !== 'ready') throw new Error('读取未返回快照')
    const write = await saveMindmap(read.snapshot, { op: 'rename', id: 'root' as MindmapNodeId, text: '已保存' }, signal)
    expect(write).toEqual({ kind: 'ready', snapshot: saved })
    expect(fetch.mock.calls[1]).toEqual(['/api/notes/mindmap/edit', {
      cache: 'no-store', method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ path: PATH, revision: 'old', edits: [{ op: 'rename', id: 'root', text: '已保存' }] }),
    }])
  })

  it.each([
    ['路径不符', { ...snapshot, path: 'different.codingmindmap' }],
    ['版本为空', { ...snapshot, revision: '' }],
    ['版本缺失', { ...snapshot, revision: null }],
    ['结构版本不认识', { ...snapshot, document: { version: 2, root: node } }],
    ['子项不是数组', { ...snapshot, document: { version: 1, root: { ...node, children: {} } } }],
    ['子项识别符重复', { ...snapshot, document: { version: 1, root: { ...node, children: [node] } } }],
    ['节点文字不是字符串', { ...snapshot, document: { version: 1, root: { ...node, text: 2 } } }],
    ['节点标识为空', { ...snapshot, document: { version: 1, root: { ...node, id: '' } } }],
    ['节点为空', { ...snapshot, document: { version: 1, root: null } }],
    ['响应为空', null],
  ])('拒绝无法显示的响应：%s', async (_reason, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)))
    await expect(readMindmap(PATH, signal)).resolves.toEqual({ kind: 'failed' })
  })

  it.each([[404, 'missing'], [409, 'conflict'], [503, 'failed']])('将 HTTP %s 映射为界面状态', async (status, kind) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('内部信息', { status })))
    await expect(readMindmap(PATH, signal)).resolves.toEqual({ kind })
  })

  it('网络失败和不可解析的响应不暴露异常或原文', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('内部信息'))
      .mockResolvedValueOnce(new Response('内部信息')))
    await expect(readMindmap(PATH, signal)).resolves.toEqual({ kind: 'failed' })
    await expect(readMindmap(PATH, signal)).resolves.toEqual({ kind: 'failed' })
  })
})
