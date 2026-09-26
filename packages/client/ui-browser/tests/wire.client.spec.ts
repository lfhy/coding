import { describe, expect, it } from 'vitest'
import { parseBrowserState } from '../src/client/wire.ts'

const state = {
  generation: 'g1', revision: 2, url: 'https://example.com/', title: 'Example',
  snapshot: 'Page text', viewport: { width: 1280, height: 720 },
  cursor: { x: 640, y: 360, kind: 'click', at: 123 }, hasFrame: true,
}

describe('browser state wire', () => {
  it('projects a complete safe observation without trusting prototype or extra fields', () => {
    expect(parseBrowserState({ ...state, extra: 1 })).toEqual(state)
    expect(parseBrowserState({ ...state, url: 'about:blank', cursor: null }).cursor).toBeNull()
  })

  it.each([
    null, [], { ...state, generation: '../g' }, { ...state, revision: -1 },
    { ...state, revision: 1.5 }, { ...state, url: 'javascript:alert(1)' },
    { ...state, url: 'https://example.com/\n' },
    { ...state, url: 'https://user:secret@example.com' }, { ...state, title: '\u0000' },
    { ...state, snapshot: 'x'.repeat(12_001) }, { ...state, viewport: { width: 0, height: 720 } },
    { ...state, cursor: { ...state.cursor, x: 1281 } },
    { ...state, cursor: { ...state.cursor, kind: 'hover' } },
    { ...state, hasFrame: 'yes' },
  ])('rejects malformed or unsafe Host JSON %#', (value) => {
    expect(() => parseBrowserState(value)).toThrow()
  })
})
