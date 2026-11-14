// @vitest-environment jsdom
// 活动行只负责展示：具体进度可播报，随机短语与时钟不打断读屏。
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from 'coding-client-test-runtime'
import { en as commonEn, zh as commonZh } from 'coding-client-locale/src/locales/index.ts'
import { TurnStatus } from '../src/client/chat/TurnStatus.tsx'
import { turnStatusPhrases } from '../src/client/chat/turn-status-phrases/index.ts'
import { en, zh } from '../src/client/locales.ts'

const NOW = 1_700_000_000_000
const t = makeTranslate(zh, commonZh)
const tEn = makeTranslate(en, commonEn)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  document.documentElement.lang = 'zh'
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  document.documentElement.lang = ''
})

describe('回合活动行', () => {
  it('具体进度按原文播报，圆环与运行时钟保持装饰', () => {
    const label = '核对界面与权限边界'
    const view = render(<TurnStatus startTime={NOW - 25_000} label={label} t={t} />)
    const status = view.getByRole('status')
    const progress = view.getByText(label)
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.getAttribute('aria-atomic')).toBe('true')
    expect(progress.getAttribute('aria-hidden')).toBeNull()
    expect(progress.getAttribute('title')).toBe(label)
    expect(status.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    expect(view.getByText('25秒').getAttribute('aria-hidden')).toBe('true')
    expect(view.queryByText(zh['status.running'])).toBeNull()
  })

  it('长进度保留完整文本与悬停全文，计时仍独立显示', () => {
    const label = '检查兼容性并核对所有验收条件。'.repeat(35)
    const view = render(<TurnStatus startTime={NOW - 125_000} label={label} t={t} />)
    const progress = view.getByTitle(label)
    expect(progress.textContent).toBe(label)
    const clock = view.getByText('2分05秒')
    expect(progress.contains(clock)).toBe(false)
    expect(clock.parentElement).toBe(view.getByRole('status'))
  })

  it('进度变化不重置回合计时，缺少起点时才回退到挂载时间', () => {
    const view = render(<TurnStatus startTime={null} label="正在阅读需求" t={t} />)
    expect(view.queryByText('0秒')).toBeNull()
    act(() => { vi.advanceTimersByTime(14_000) })
    expect(view.queryByText('14秒')).toBeNull()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(view.getByText('15秒')).toBeTruthy()
    view.rerender(<TurnStatus startTime={null} label="正在实现功能" t={t} />)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(view.getByText('16秒')).toBeTruthy()
    expect(view.getByText('正在实现功能')).toBeTruthy()
    view.rerender(<TurnStatus startTime={NOW - 60_000} label="正在实现功能" t={t} />)
    expect(view.getByText('1分16秒')).toBeTruthy()
  })

  it('只有随机模式轮换短语，读屏始终只读固定运行文案', () => {
    const view = render(<TurnStatus startTime={NOW} label={null} t={t} />)
    const phrase = (): HTMLElement => view.getByRole('status').querySelector<HTMLElement>('[title]')!
    const first = phrase().textContent
    expect(turnStatusPhrases('thinking', 'zh')).toContain(first)
    expect(phrase().getAttribute('aria-hidden')).toBe('true')
    expect(view.getByText(zh['status.running']).getAttribute('aria-hidden')).toBeNull()
    act(() => { vi.advanceTimersByTime(10_000) })
    const second = phrase().textContent
    expect(second).not.toBe(first)
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(phrase().textContent).not.toBe(second)
    expect(view.getByText('20秒').getAttribute('aria-hidden')).toBe('true')
  })

  it('具体进度期间不抽取随机短语，清除后立即从当前阶段恢复', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const view = render(<TurnStatus startTime={NOW} label="正在检查实现" t={t} />)
    act(() => { vi.advanceTimersByTime(61_000) })
    expect(random).not.toHaveBeenCalled()
    expect(view.getByText('正在检查实现')).toBeTruthy()
    expect(view.getByText('1分01秒')).toBeTruthy()
    view.rerender(<TurnStatus startTime={NOW} label={null} t={t} />)
    expect(random).toHaveBeenCalledTimes(1)
    const phrase = view.getByRole('status').querySelector('[title]')!
    expect(turnStatusPhrases('long', 'zh')).toContain(phrase.textContent)
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(random).toHaveBeenCalledTimes(2)
    view.rerender(<TurnStatus startTime={NOW} label="正在收尾验证" t={t} />)
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(random).toHaveBeenCalledTimes(2)
    expect(view.getByText('1分31秒')).toBeTruthy()
  })

  it('起步和长时间阶段跟随界面语言，计时同样本地化', () => {
    document.documentElement.lang = 'en-US'
    const view = render(<TurnStatus startTime={NOW - 65_000} label={null} t={tEn} />)
    const phrase = view.getByRole('status').querySelector('[title]')!
    expect(turnStatusPhrases('long', 'en')).toContain(phrase.textContent)
    expect(view.getByText(en['status.running'])).toBeTruthy()
    expect(view.getByText('1m 05s')).toBeTruthy()
  })

  it('起点晚于当前时间时不显示负时长，卸载清理全部定时器', () => {
    const view = render(<TurnStatus startTime={NOW + 30_000} label={null} t={t} />)
    act(() => { vi.advanceTimersByTime(15_000) })
    expect(view.queryByText(/^-\d/)).toBeNull()
    expect(view.queryByText('15秒')).toBeNull()
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
