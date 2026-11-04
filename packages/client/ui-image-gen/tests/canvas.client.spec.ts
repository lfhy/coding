import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasController } from '../src/client/canvas.ts'

const json = (value: unknown, status = 200) => ({ ok: status < 400, status, json: async () => value }) as Response
const empty = { revision: 1, state: { version: 1, nodes: [] } }
afterEach(() => { vi.unstubAllGlobals() })

describe('会话画布', () => {
  it('未打开画布时也能把画廊图片置入并以同会话 revision 保存', async () => {
    const writes: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain('sessionId=one')
      if (init.method !== 'PUT') return json(empty)
      const payload = JSON.parse(init.body as string) as typeof empty
      writes.push(payload)
      return json({ ...payload, revision: payload.revision + 1 })
    }))
    const canvas = new CanvasController('one', id => `/api/image-gen/image?sessionId=one&id=${id}`)
    expect(await canvas.addImage('first', 512, 512)).toBe(true)
    expect(canvas.view.getSnapshot().nodes).toMatchObject([{ type: 'image', imageId: 'first' }])
    expect(writes).toMatchObject([{ revision: 1, state: { nodes: [{ imageId: 'first' }] } }])
    expect(canvas.url('first')).toContain('sessionId=one&id=first')
    canvas.dispose()
  })

  it('画笔、橡皮、选区、清空按 revision 排队；冲突不会覆盖新版本', async () => {
    let revision = 1
    let conflict = false
    const written: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method !== 'PUT') return json(empty)
      const payload = JSON.parse(init.body as string) as typeof empty
      written.push(payload)
      if (conflict) return json({ error: 'conflict' }, 409)
      expect(payload.revision).toBe(revision)
      return json({ ...payload, revision: ++revision })
    }))
    const canvas = new CanvasController('one', id => id)
    canvas.show(true)
    await vi.waitFor(() => { expect(canvas.view.getSnapshot().phase).toBe('ready') })
    const ink = canvas.add({ id: 'stroke', type: 'stroke', points: [{ x: 4, y: 4 }], width: 4, color: 'ink' })
    const eraser = canvas.add({ id: 'erase', type: 'stroke', points: [{ x: 4, y: 4 }], width: 24, color: 'ink', erase: true })
    expect(await ink).toBe(true)
    expect(await eraser).toBe(true)
    expect(canvas.view.getSnapshot().nodes).toHaveLength(2)
    conflict = true
    expect(await canvas.clear()).toBe(false)
    expect(canvas.view.getSnapshot().issue).toBe('conflict')
    expect(await canvas.clear()).toBe(false)
    expect(written).toHaveLength(3)
    canvas.dispose()
  })
})
