import { describe, expect, it } from 'vitest'
import { dropSideOf, dropTabSideOf } from '../src/client/ide-drag.ts'

const rect = { left: 100, top: 50, width: 800, height: 600 }

describe('IDE 四向拖拽落点', () => {
  it('编辑区按距离最近的边缘选择左右上下', () => {
    expect(dropSideOf(rect, 110, 350)).toBe('left')
    expect(dropSideOf(rect, 890, 350)).toBe('right')
    expect(dropSideOf(rect, 500, 60)).toBe('top')
    expect(dropSideOf(rect, 500, 640)).toBe('bottom')
    expect(dropSideOf(rect, 500, 350)).toBe('top')
  })

  it('标签栏只按横坐标选择左右，避免高度造成误判', () => {
    expect(dropTabSideOf(rect, 110)).toBe('left')
    expect(dropTabSideOf(rect, 500)).toBe('right')
    expect(dropTabSideOf(rect, 890)).toBe('right')
  })
})
