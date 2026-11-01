import { describe, expect, it, vi } from 'vitest'
import { watchActivity } from '../src/client/activity.ts'

class FakeStream extends EventTarget {
  closed = false
  emit(payload: unknown): void {
    this.dispatchEvent(new MessageEvent('tool-call', { data: JSON.stringify(payload) }))
  }
  close(): void { this.closed = true }
}

describe('Agent 浏览器自动展开', () => {
  it('只按新活动的确切会话展开，重放和其他事件不重复抢焦点', () => {
    const stream = new FakeStream()
    const open = vi.fn()
    const dispose = watchActivity(open, (url) => {
      expect(url).toBe('/api/ego/activity')
      return stream as unknown as EventSource
    })
    stream.emit({ sessionId: 'first', count: 1 })
    stream.emit({ sessionId: 'first', count: 1 })
    stream.emit({ sessionId: 'second', count: 2 })
    stream.emit({ sessionId: 'first', count: 3 })
    stream.emit({ sessionId: 'second', count: 4, data: 'hidden frame' })
    expect(open.mock.calls).toEqual([['first'], ['second']])
    dispose()
    stream.emit({ sessionId: 'third', count: 5 })
    expect(stream.closed).toBe(true)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('活动路由未就绪时不阻断手动打开，并允许后续活动重试失败会话', () => {
    expect(() => { watchActivity(vi.fn(), () => { throw new Error('not ready') })() }).not.toThrow()
    const stream = new FakeStream()
    const open = vi.fn().mockImplementationOnce(() => { throw new Error('not mounted') })
    const dispose = watchActivity(open, () => stream as unknown as EventSource)
    stream.emit({ sessionId: 'first', count: 1 })
    stream.emit({ sessionId: 'first', count: 2 })
    expect(open).toHaveBeenCalledTimes(2)
    stream.dispatchEvent(new Event('error'))
    expect(stream.closed).toBe(true)
    dispose()
  })
})
