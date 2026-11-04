import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SessionId } from 'coding-session/types'
import SessionStore from 'coding-session'
import { canvasSnapshot, galleryItems, parseCanvasState } from '../src/gallery.ts'

const item = (id: string) => ({
  id, attachmentId: 'sample' as never, mediaType: 'image/png' as const, bytes: 64,
  width: 1, height: 1, prompt: 'mountains', model: 'mock-image', createdAt: 1,
})

describe('session-scoped gallery and canvas', () => {
  it('rejects cross-session images and stale or invalid canvas input', () => {
    const store = new SessionStore(new Context())
    const first = store.create(SessionId('one'))
    const second = store.create(SessionId('two'))
    first.append('image-gen/created', { item: item('0') })
    expect(galleryItems(first.events)).toEqual([item('0')])
    expect(galleryItems(second.events)).toEqual([])
    expect(() => parseCanvasState({ version: 1, nodes: [
      { id: 'foreign', type: 'image', imageId: '0', x: 0, y: 0, width: 50, height: 50 },
    ] }, galleryItems(second.events))).toThrow(/同会话/)
    expect(() => parseCanvasState({ version: 1, nodes: [
      { id: 'old-color', type: 'stroke', color: '#000000', width: 2, points: [{ x: 1, y: 2 }] },
    ] }, galleryItems(first.events))).toThrow(/笔画/)
    expect(() => parseCanvasState({ version: 1, nodes: [
      { id: 'outside', type: 'stroke', color: 'ink', width: 2, points: [{ x: 961, y: 2 }] },
    ] }, galleryItems(first.events))).toThrow(/笔画/)
    const state = parseCanvasState({ version: 1, nodes: [
      { id: 'image', type: 'image', imageId: '0', x: 10, y: 10, width: 100, height: 100 },
      { id: 'line', type: 'stroke', color: 'ink', width: 2, points: [{ x: 1, y: 2 }] },
    ] }, galleryItems(first.events))
    first.append('image-gen/canvas', { revision: 1, state })
    expect(canvasSnapshot(first.events)).toEqual({ revision: 1, state })
    expect(canvasSnapshot(second.events)).toEqual({ revision: 0, state: { version: 1, nodes: [] } })
  })
})
