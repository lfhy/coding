/**
 * 指纹派生的回归测试：`ses_` 形状与时间戳段必须与官方客户端一致，
 * 且同一会话在多次调用间稳定。上游把这两点当作硬门，因此逐条钉住。
 */

import { describe, expect, it } from 'vitest'
import {
  canonicalSessionId,
  conversationSeed,
  deriveRequestIds,
  disguiseHeaders,
  invertedTimestampHex,
  opencodeUserAgent,
  projectId,
} from '../src/ids.ts'

const CANONICAL = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

describe('invertedTimestampHex', () => {
  it('编码毫秒时钟并按位取反，序号固定为一', () => {
    const now = 1_700_000_000_000
    const current = BigInt(now) * 0x1000n + 1n
    expect(invertedTimestampHex(now)).toBe((~current & 0xffff_ffff_ffffn).toString(16).padStart(12, '0'))
  })

  it('把序号一写进低 12 位，使时间戳段以 ffe 结尾', () => {
    // 低 12 位是序号，取反后成为 0xfff - counter；counter 为 1 即 ffe。
    // 这是官方客户端 id 的结构性后果，也是上游读回计数器的地方。
    expect(invertedTimestampHex(1_700_000_000_000).slice(-3)).toBe('ffe')
  })

  it('始终输出 12 位小写 hex', () => {
    for (const now of [0, 1, 1_700_000_000_000, 2_000_000_000_000]) {
      const hex = invertedTimestampHex(now)
      expect(hex).toHaveLength(12)
      expect(hex).toMatch(/^[0-9a-f]{12}$/)
    }
  })
})

describe('canonicalSessionId', () => {
  it('展开任意信号为官方形状', () => {
    expect(canonicalSessionId('conversation-a')).toMatch(CANONICAL)
  })

  it('同一信号返回同一个 id，不同信号互不相同', () => {
    const first = canonicalSessionId('conversation-stable')
    const second = canonicalSessionId('conversation-stable')
    expect(second).toBe(first)
    expect(canonicalSessionId('conversation-other')).not.toBe(first)
  })

  it('已经是官方形状的信号原样通过，保留上游 prompt cache 亲和', () => {
    const official = `ses_${invertedTimestampHex(1_700_000_000_000)}0123456789abcd`
    expect(official).toMatch(CANONICAL)
    expect(canonicalSessionId(official)).toBe(official)
  })

  it('尾段由会话身份决定，因此同一时钟下的不同会话不会碰撞', () => {
    const left = canonicalSessionId('left')
    const right = canonicalSessionId('right')
    expect(left.slice(4, 16)).toBe(right.slice(4, 16))
    expect(left.slice(16)).not.toBe(right.slice(16))
  })
})

describe('deriveRequestIds', () => {
  it('按首条用户消息派生，历史增长不改变会话', () => {
    const first = deriveRequestIds([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
    const later = deriveRequestIds([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [] },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ])
    expect(later.session).toBe(first.session)
  })

  it('每次调用都产生新的请求标识，会话保持稳定', () => {
    const messages = [{ role: 'user', content: 'hi' }]
    const first = deriveRequestIds(messages)
    const second = deriveRequestIds(messages)
    expect(first.session).toBe(second.session)
    expect(first.request).not.toBe(second.request)
    expect(second.project).toBe(first.project)
  })

  it('没有用户内容时仍产出一个合法会话', () => {
    expect(deriveRequestIds([{ role: 'assistant', content: [] }]).session).toMatch(CANONICAL)
  })

  it('把没有用户轮次的历史判为空信号', () => {
    expect(conversationSeed([{ role: 'system', content: 'x' }])).toBe('')
    expect(conversationSeed([{ role: 'user', content: null }])).toBe('')
  })
})

describe('disguiseHeaders', () => {
  it('把会话 id 放在四个关联头上，项目头是裸 hex，且不发请求头', () => {
    const ids = deriveRequestIds([{ role: 'user', content: 'hi' }])
    expect(disguiseHeaders(ids)).toEqual({
      'user-agent': opencodeUserAgent(),
      'x-opencode-client': 'cli',
      'x-opencode-session': ids.session,
      'x-opencode-session-id': ids.session,
      'x-session-affinity': ids.session,
      'X-Session-Id': ids.session,
      'x-opencode-project': ids.project,
    })
    // 上游自 2026-10-14 起拒绝请求级关联头，因此它只留在本进程内。
    expect(disguiseHeaders(ids)).not.toHaveProperty('x-opencode-request')
  })

  it('User-Agent 是官方 CLI 的形态：opencode/ 前缀加通道、版本与客户端名', () => {
    expect(opencodeUserAgent()).toMatch(/^opencode\/[^/]+\/[^/]+\/cli$/)
  })

  it('项目头是裸 40 位小写 hex，同一个信号稳定', () => {
    expect(projectId('dsh-opencode:default-project')).toMatch(/^[0-9a-f]{40}$/)
    expect(projectId('dsh-opencode:default-project')).toBe(projectId('dsh-opencode:default-project'))
    expect(projectId('other')).not.toBe(projectId('dsh-opencode:default-project'))
  })
})

describe('canonicalSessionId', () => {
  it('只原样通过带真实降序时钟段的会话 id', () => {
    const minted = `ses_${invertedTimestampHex(1_700_000_000_000)}${'A'.repeat(14)}`
    expect(invertedTimestampHex(1_700_000_000_000).slice(9)).toMatch(/^f[c-f][0-9a-f]$/)
    expect(canonicalSessionId(minted)).toBe(minted)
    // 形状对但时钟段是摘要与升序值时，同样按信号重新铸造。
    const hashed = `ses_${'0'.repeat(9)}0a1${'A'.repeat(4)}`
    expect(canonicalSessionId(hashed)).not.toBe(hashed)
    expect(canonicalSessionId(hashed)).toMatch(CANONICAL)
  })
})
