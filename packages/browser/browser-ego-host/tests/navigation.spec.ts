/** 人工导航的 Host 载荷必须先校验，再发送到 worker。 */
import { describe, expect, it } from 'vitest'
import { navigationUrl, parseNavigation } from '../src/navigation.ts'

const owned = { sessionId: 'session-one', targetId: 'owned' }

describe('人工导航输入', () => {
  it.each(['https://example.com/path?q=1', 'http://localhost:3000/', 'file:///tmp/index.html',
    'file:///tmp/My%20Page/%E4%B8%AD%E6%96%87.html'])('接受绝对网页或严格本地文件 %s', (url) => {
    expect(navigationUrl(url)).toBe(url)
    expect(parseNavigation({ ...owned, action: 'navigate', url }, true)).toEqual({ targetId: 'owned', action: 'navigate', url })
  })

  it.each(['', '/relative', '//example.com', 'http:example.com', 'https://user@example.com', 'https://@example.com',
    'file://server/share', 'file:////tmp/a', 'file:///tmp/%2fsecret', 'file:///tmp/%5csecret',
    'file:///tmp/%00secret', 'file:///tmp/other\\file', 'about:blank', 'javascript:alert(1)',
    'data:text/plain,hello', 'ftp://example.com', 'https://example.com/\n'])('拒绝无效或危险地址 %s', (url) => {
    expect(navigationUrl(url)).toBeNull()
    expect(parseNavigation({ ...owned, action: 'navigate', url }, true)).toBeNull()
  })

  it('仅空白 Host 会话可不指定 targetId，worker 永远要求 targetId', () => {
    expect(parseNavigation({ sessionId: owned.sessionId, action: 'navigate', url: 'https://example.com/' }, true))
      .toEqual({ action: 'navigate', url: 'https://example.com/' })
    expect(parseNavigation({ action: 'navigate', url: 'https://example.com/' })).toBeNull()
    for (const action of ['reload', 'back', 'forward']) {
      expect(parseNavigation({ sessionId: owned.sessionId, action }, true)).toBeNull()
      expect(parseNavigation({ ...owned, action, url: 'https://example.com/' }, true)).toBeNull()
      expect(parseNavigation({ ...owned, action }, true)).toEqual({ targetId: owned.targetId, action })
    }
    expect(parseNavigation({ ...owned, action: 'navigate', url: 'https://example.com/', method: 'Page.navigate' }, true)).toBeNull()
    expect(parseNavigation({ sessionId: owned.sessionId, targetId: null, action: 'navigate', url: 'https://example.com/' }, true)).toBeNull()
    expect(parseNavigation({ sessionId: owned.sessionId, targetId: '', action: 'navigate', url: 'https://example.com/' }, true)).toBeNull()
    expect(parseNavigation({ ...owned, action: 'navigate', url: 'https://example.com/' })).toBeNull()
    expect(parseNavigation({ targetId: 'owned', action: 'navigate', url: 'https://example.com/' }))
      .toEqual({ targetId: 'owned', action: 'navigate', url: 'https://example.com/' })
  })
})
