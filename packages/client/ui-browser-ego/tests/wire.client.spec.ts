import { describe, expect, it } from 'vitest'
import { pointOnFrame } from '../src/client/geometry.ts'
import { parseActions, parseActivity, parseFrame, parseSpaces, parseStatus } from '../src/client/wire.ts'

const page = { targetId: 'page-one', title: '页面', url: 'https://example.com/', active: true,
  viewportW: 480, viewportH: 320 }

describe('Agent 浏览器输入边界', () => {
  it('只接受合法的页面、画面和明确的会话活动', () => {
    expect(parseSpaces([page])).toEqual([{ ...page, humanCheck: false }])
    expect(parseSpaces([{ ...page, url: 'chrome://newtab/', viewportW: null }])[0]?.viewportW).toBeNull()
    expect(() => parseSpaces([page, page])).toThrow()
    expect(() => parseSpaces([{ ...page, url: 'javascript:alert(1)' }])).toThrow()
    expect(() => parseSpaces([{ ...page, title: 'hidden\ncontrol' }])).toThrow()
    expect(parseFrame({ targetId: page.targetId, data: 'YWJj', vw: 480, vh: 320, ts: 3 })).toEqual({
      targetId: page.targetId, src: 'data:image/jpeg;base64,YWJj', width: 480, height: 320, ts: 3,
    })
    expect(parseFrame({ targetId: page.targetId, data: 'data:text/html,evil', vw: 480, vh: 320, ts: 3 })).toBeNull()
    expect(parseFrame({ targetId: page.targetId, data: 'YWJj', vw: 0, vh: 320, ts: 3 })).toBeNull()
    expect(parseActivity({ sessionId: 'other', count: 2 })).toEqual({
      sessionId: 'other', count: 2, kind: 'other', at: null,
    })
    expect(parseActivity({ sessionId: 'other', count: 2, tool: 'browser_navigate', at: 9 })).toEqual({
      sessionId: 'other', count: 2, kind: 'navigate', at: 9,
    })
    expect(parseActivity({ sessionId: 'other', count: 2, data: 'a frame' })).toBeNull()
    expect(parseActivity({ sessionId: 'other', count: 2, at: -1 })).toBeNull()
    expect(parseActivity({ sessionId: 'other', count: 2, tool: 'a\nb' })).toBeNull()
  })

  it('只保留人机验证的布尔事实，拒绝无法解释的检测值', () => {
    expect(parseSpaces([{ ...page, humanCheck: null }])[0]?.humanCheck).toBe(false)
    expect(parseSpaces([{ ...page, humanCheck: { detected: true, kind: 'recaptcha' } }])[0]?.humanCheck).toBe(true)
    expect(parseSpaces([{ ...page, humanCheck: { detected: false } }])[0]?.humanCheck).toBe(false)
    expect(() => parseSpaces([{ ...page, humanCheck: 'recaptcha' }])).toThrow()
    expect(() => parseSpaces([{ ...page, humanCheck: { detected: 'yes' } }])).toThrow()
  })

  it('只接受运行/连接布尔值，并把历史工具名归类为动作类别', () => {
    expect(parseStatus({ ok: true, running: true, browserConnected: true, spaces: 2 }))
      .toEqual({ running: true, browserConnected: true })
    expect(parseStatus({ ok: false, running: true, browserConnected: true })).toBeNull()
    expect(parseStatus({ ok: true, running: 'yes', browserConnected: true })).toBeNull()
    expect(parseActions({ ok: true, actions: [
      { tool: 'browser_navigate', at: 10 }, { tool: 'ego_wait_for_human', at: 12 }, { tool: 'unknown_tool', at: 13 },
    ] })).toEqual([
      { kind: 'navigate', at: 10 }, { kind: 'human', at: 12 }, { kind: 'other', at: 13 },
    ])
    expect(() => parseActions({ ok: true })).toThrow()
    expect(() => parseActions({ ok: true, actions: [{ tool: 'browser_click', at: -1 }] })).toThrow()
    expect(() => parseActions({ ok: true, actions: [{ tool: 'browser_\nclick', at: 1 }] })).toThrow()
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
