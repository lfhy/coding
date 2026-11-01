import { describe, expect, it } from 'vitest'
import { pointOnFrame } from '../src/client/geometry.ts'
import { parseActivity, parseFrame, parseSpaces } from '../src/client/wire.ts'

const page = { targetId: 'page-one', title: '页面', url: 'https://example.com/', active: true,
  viewportW: 480, viewportH: 320 }

describe('Agent 浏览器输入边界', () => {
  it('只接受合法的页面、画面和明确的会话活动', () => {
    expect(parseSpaces([page])).toEqual([{ ...page }])
    expect(parseSpaces([{ ...page, url: 'chrome://newtab/', viewportW: null }])[0]?.viewportW).toBeNull()
    expect(() => parseSpaces([page, page])).toThrow()
    expect(() => parseSpaces([{ ...page, url: 'javascript:alert(1)' }])).toThrow()
    expect(() => parseSpaces([{ ...page, title: 'hidden\ncontrol' }])).toThrow()
    expect(parseFrame({ targetId: page.targetId, data: 'YWJj', vw: 480, vh: 320, ts: 3 })).toEqual({
      targetId: page.targetId, src: 'data:image/jpeg;base64,YWJj', width: 480, height: 320, ts: 3,
    })
    expect(parseFrame({ targetId: page.targetId, data: 'data:text/html,evil', vw: 480, vh: 320, ts: 3 })).toBeNull()
    expect(parseFrame({ targetId: page.targetId, data: 'YWJj', vw: 0, vh: 320, ts: 3 })).toBeNull()
    expect(parseActivity({ sessionId: 'other', count: 2 })).toEqual({ sessionId: 'other', count: 2 })
    expect(parseActivity({ sessionId: 'other', count: 2, data: 'a frame' })).toBeNull()
  })

  it('只将实际 JPEG 的非留白位置映射到视口整数坐标', () => {
    const rect = { left: 20, top: 10, width: 300, height: 200 } as DOMRect
    const natural = { width: 100, height: 100 }
    const viewport = { width: 1000, height: 1000 }
    expect(pointOnFrame(100, 40, rect, natural, viewport)).toEqual({ x: 150, y: 150 })
    expect(pointOnFrame(25, 40, rect, natural, viewport)).toBeNull()
    expect(pointOnFrame(319, 209, rect, natural, viewport)).toBeNull()
    expect(pointOnFrame(Number.NaN, 40, rect, natural, viewport)).toBeNull()
  })
})
