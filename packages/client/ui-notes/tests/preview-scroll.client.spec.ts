import { describe, expect, it } from 'vitest'
import { createScrollFollower } from '../src/client/preview-scroll.ts'

const pane = (scrollTop: number, scrollHeight: number, clientHeight: number) =>
  ({ scrollTop, scrollHeight, clientHeight })

describe('预览与源码滚动同步', () => {
  it('按可滚动余量等比换算到另一侧', () => {
    const follower = createScrollFollower()
    const write = follower.follow('source', {
      source: pane(400, 2000, 400),
      preview: pane(0, 900, 100),
    })
    // 源码滚了四分之一（400 / 1600），预览跟到四分之一（800 / 4 = 200）。
    expect(write).toEqual({ side: 'preview', offset: 200 })
  })

  it('内容不足一屏时落在顶部，不因除零算出 NaN', () => {
    const follower = createScrollFollower()
    const write = follower.follow('preview', {
      source: pane(0, 300, 400),
      preview: pane(60, 400, 100),
    })
    expect(write).toEqual({ side: 'source', offset: 0 })
  })

  it('滚过末尾时按到底处理', () => {
    const follower = createScrollFollower()
    const write = follower.follow('source', {
      source: pane(9999, 1000, 400),
      preview: pane(0, 800, 100),
    })
    expect(write).toEqual({ side: 'preview', offset: 700 })
  })

  it('丢掉自己刚写入那一侧的回声滚动，避免两侧来回追赶', () => {
    const follower = createScrollFollower()
    const panes = { source: pane(800, 2000, 400), preview: pane(0, 900, 100) }
    expect(follower.follow('source', panes)).toEqual({ side: 'preview', offset: 400 })
    // 预览被程序化滚到 400 后浏览器回报一次 scroll，位置与写入值一致，视为回声。
    const echo = follower.follow('preview', { source: panes.source, preview: pane(400, 900, 100) })
    expect(echo).toBeNull()
    // 用户真的继续滚动预览，则正常带动源码。
    const next = follower.follow('preview', { source: panes.source, preview: pane(500, 900, 100) })
    expect(next).toEqual({ side: 'source', offset: 1000 })
  })

  it('回声判断只认紧邻的一次，之后同位置的真实滚动仍会带动另一侧', () => {
    const follower = createScrollFollower()
    const panes = { source: pane(0, 2000, 400), preview: pane(0, 900, 100) }
    expect(follower.follow('source', panes)).toEqual({ side: 'preview', offset: 0 })
    const echo = follower.follow('preview', { source: panes.source, preview: pane(0, 900, 100) })
    expect(echo).toBeNull()
    const again = follower.follow('preview', { source: pane(0, 2000, 400), preview: pane(0, 900, 100) })
    expect(again).toEqual({ side: 'source', offset: 0 })
  })

  it('连续滚同一侧时不会把自己上一笔写入当成回声', () => {
    const follower = createScrollFollower()
    const panes = { source: pane(400, 2000, 400), preview: pane(0, 900, 100) }
    expect(follower.follow('source', panes)).toEqual({ side: 'preview', offset: 200 })
    // 等待的写入属于预览，源码继续滚动时不比较、直接换算。
    expect(follower.follow('source', { source: pane(800, 2000, 400), preview: pane(200, 900, 100) }))
      .toEqual({ side: 'preview', offset: 400 })
  })

  it('被带动的一侧随即真的滚动时按新位置继续换算', () => {
    const follower = createScrollFollower()
    expect(follower.follow('source', { source: pane(400, 2000, 400), preview: pane(0, 900, 100) }))
      .toEqual({ side: 'preview', offset: 200 })
    // 预览停在别的像素上，说明这是用户自己滚的，不是回声。
    expect(follower.follow('preview', { source: pane(400, 2000, 400), preview: pane(500, 900, 100) }))
      .toEqual({ side: 'source', offset: 1000 })
  })
})
