/** 可参与滚动换算的一侧：滚过的距离与可滚动总量。 */
export interface ScrollPane {
  /** 已滚过的像素。 */
  scrollTop: number
  /** 内容总高。 */
  scrollHeight: number
  /** 可视高度。 */
  clientHeight: number
}

/** 参与同步的两侧：Markdown 源码与排版预览。 */
export type ScrollSide = 'source' | 'preview'

/** 一次需要写入的滚动位置：写哪一侧、写多少。 */
export interface ScrollWrite {
  /** 被带动的一侧。 */
  side: ScrollSide
  /** 要写入的 scrollTop。 */
  offset: number
}

/**
 * 按滚动比例把一侧的位置换算到另一侧：源码与预览的排版高度不同，只能按可滚动的
 * 余量等比对应，顶到底两端因此始终对齐。
 * @param from - 刚被用户滚动的一侧。
 * @param to - 要跟随的一侧。
 * @returns 目标侧应设置的 scrollTop；任一侧不可滚动时为 0。
 */
function ratioOffset(from: ScrollPane, to: ScrollPane): number {
  const fromRange = from.scrollHeight - from.clientHeight
  const toRange = to.scrollHeight - to.clientHeight
  if (fromRange <= 0 || toRange <= 0) return 0
  const ratio = Math.min(Math.max(from.scrollTop / fromRange, 0), 1)
  return Math.round(ratio * toRange)
}

/** 滚动同步器：记录上一笔写入，据此认出并丢弃自己引发的回声滚动。 */
export interface ScrollFollower {
  /**
   * 处理一侧的滚动回调。
   * @param side - 触发滚动的一侧。
   * @param panes - 两侧当前的滚动量；程序化写入后浏览器会再报一次同样的位置。
   * @returns 需要写入另一侧的滚动位置；这次是回声或没有可滚动余量时为 null。
   */
  follow(side: ScrollSide, panes: Record<ScrollSide, ScrollPane>): ScrollWrite | null
}

/**
 * 创建滚动同步器。两侧互相驱动时，写入引发的 scroll 事件会再触发一次换算，
 * 靠记住上一笔写入的位置把它认成回声丢掉，避免两侧来回追赶。
 * @returns 绑定一次的同步器；每处实时预览持有一个。
 */
export function createScrollFollower(): ScrollFollower {
  let pending: ScrollWrite | null = null
  return {
    follow(side, panes) {
      if (pending !== null && pending.side === side) {
        const echoed = Math.abs(panes[side].scrollTop - pending.offset) < 1
        pending = null
        if (echoed) return null
      }
      const other: ScrollSide = side === 'source' ? 'preview' : 'source'
      const offset = ratioOffset(panes[side], panes[other])
      pending = { side: other, offset }
      return pending
    },
  }
}
