/** 活动流只让会改变画面的调用展开侧栏；只读查询必须留在历史里。 */
import type { ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { SessionId } from 'coding-session/types'
import { markToolStart, recentActions, revealsBrowserView, subscribeActivity } from '../src/activity.ts'

/** 只读工具：观察、等待、查环境、同步登录态与任务空间准备，都看不出画面变化。 */
const READ_ONLY: readonly string[] = [
  'ego_status', 'ego_help', 'ego_doctor', 'ego_auth_flush', 'ego_login_import',
  'ego_snapshot', 'ego_page_info', 'ego_read_element', 'ego_screenshot', 'ego_captcha', 'ego_http',
  'ego_wait', 'ego_wait_for_selector', 'ego_wait_for_url', 'ego_wait_for_response',
  'ego_space_open', 'ego_space_close',
]

/** 会改变用户所见页面的工具：驱动页面、投递可见输入，或把页面交给用户操作。 */
const REVEALING: readonly string[] = [
  'ego_navigate', 'ego_click', 'ego_fill', 'ego_key', 'ego_hover', 'ego_select', 'ego_drag',
  'ego_scroll', 'ego_check', 'ego_upload', 'ego_download', 'ego_dialog', 'ego_wait_for_human',
  'ego_js', 'ego_cdp', 'ego_cli', 'ego_script',
]

function fakeClient(): { res: ServerResponse; frames: string[] } {
  const frames: string[] = []
  const res = {
    destroyed: false,
    write: (chunk: string) => { frames.push(chunk); return true },
    once: () => res,
  }
  return { res: res as unknown as ServerResponse, frames }
}

describe('浏览器活动是否展开侧栏', () => {
  it('只读调用不展开，只有会改变画面的调用才展开', () => {
    for (const tool of READ_ONLY) expect([tool, revealsBrowserView(tool, {})]).toEqual([tool, false])
    for (const tool of REVEALING) expect([tool, revealsBrowserView(tool, {})]).toEqual([tool, true])
  })

  it('标签页动作里只有 open、switch、close 改变用户看到的页面', () => {
    expect(revealsBrowserView('ego_tabs', { action: 'list' })).toBe(false)
    expect(revealsBrowserView('ego_tabs', { action: '' })).toBe(false)
    expect(revealsBrowserView('ego_tabs', {})).toBe(false)
    expect(revealsBrowserView('ego_tabs', { action: 'bogus' })).toBe(false)
    expect(revealsBrowserView('ego_tabs', { action: 'switch' })).toBe(true)
    expect(revealsBrowserView('ego_tabs', { action: 'open' })).toBe(true)
    expect(revealsBrowserView('ego_tabs', { action: 'close' })).toBe(true)
  })

  it('未知工具不主动打断用户', () => {
    expect(revealsBrowserView('ego_future_tool', {})).toBe(false)
    expect(revealsBrowserView('', {})).toBe(false)
  })

  it('只读调用仍记录历史，但不广播也不进入重连回放', () => {
    const { res, frames } = fakeClient()
    const unsubscribe = subscribeActivity(res)
    const session = SessionId('session-quiet-calls')
    markToolStart(session, 'ego_tabs', revealsBrowserView('ego_tabs', { action: 'list' }))
    expect(frames).toEqual([])
    expect(recentActions(session).map(action => action.tool)).toEqual(['browser_tabs'])
    markToolStart(session, 'ego_navigate', revealsBrowserView('ego_navigate', {}))
    expect(frames).toHaveLength(1)
    expect(frames[0]).toContain('event: tool-call')
    expect(frames[0]).toContain(`"sessionId":"${session}"`)
    expect(frames[0]).toContain('"tool":"browser_navigate"')
    unsubscribe()
    markToolStart(session, 'ego_click')
    expect(frames).toHaveLength(1)
    expect(recentActions(session).map(action => action.tool)).toEqual([
      'browser_tabs', 'browser_navigate', 'browser_click',
    ])
  })

  it('已断开的连接在广播时被移除', () => {
    const { res, frames } = fakeClient()
    subscribeActivity(res)
    Object.assign(res, { destroyed: true })
    markToolStart(SessionId('session-destroyed-client'), 'ego_navigate')
    expect(frames).toEqual([])
  })
})
