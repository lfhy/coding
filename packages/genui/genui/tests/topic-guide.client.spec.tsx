// @vitest-environment jsdom
/** 话题引导通过会话发送可见预设消息，不触发普通模型动作。 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GenuiBlock } from '../src/client/GenuiBlock.tsx'
import { GenuiActionContext } from '../src/client/action-context.ts'
import { GenuiMessageContext } from '../src/client/message-context.ts'
import { setLocale } from '../src/client/i18n/index.ts'
import { loadBlockState, saveBlockState } from '../src/client/interaction-store.ts'
import type { GenuiSpec } from '../src/client/spec.ts'

const topic = {
  type: 'topic-guide' as const,
  id: 'gpu-followup',
  question: '接下来了解哪个方向？',
  options: [
    { label: '模型概览', message: '请解释模型概览以及适用场景。' },
    { label: '部署建议', message: '请给我部署建议，并标出前提。' },
  ],
}
const spec: GenuiSpec = { items: [topic] }

beforeEach(() => { localStorage.clear(); setLocale('zh') })
afterEach(cleanup)

function show(send?: (message: string) => Promise<void>, value = spec, stateKey = 'topic:session:reply') {
  const action = vi.fn()
  const view = render(
    <GenuiActionContext.Provider value={action}>
      <GenuiMessageContext.Provider value={send}>
        <GenuiBlock spec={value} stateKey={stateKey} animateEntrance={false} />
      </GenuiMessageContext.Provider>
    </GenuiActionContext.Provider>,
  )
  return { ...view, action }
}

describe('话题引导', () => {
  it('选择并确认后原样发送预设文本，排队期间不重复提交，成功后锁定', async () => {
    let resolve!: () => void
    const send = vi.fn(() => new Promise<void>((done) => { resolve = done }))
    const { action } = show(send, { items: [{ ...topic, confirmLabel: '继续聊这个话题' }] })
    const option = screen.getByRole('radio', { name: '部署建议' })
    fireEvent.click(option)
    expect(option.getAttribute('aria-checked')).toBe('true')
    expect(send).not.toHaveBeenCalled()
    const confirm = screen.getByRole('button', { name: '继续聊这个话题' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(send).toHaveBeenCalledExactlyOnceWith('请给我部署建议，并标出前提。')
    expect(action).not.toHaveBeenCalled()
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { resolve(); await Promise.resolve() })
    expect(screen.getByRole('status').textContent).toContain('已发送')
    await act(async () => { await new Promise(done => setTimeout(done, 350)) })
    expect(loadBlockState('topic:session:reply')?.topics?.['gpu-followup']?.sent).toBe(true)
  })

  it('不设置确认标签时点选即发送；键盘方向键只切换选择，选项按键激活才发送', async () => {
    const send = vi.fn(async () => {})
    show(send)
    const first = screen.getByRole('radio', { name: '模型概览' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(screen.getByRole('radio', { name: '部署建议' }).getAttribute('aria-checked')).toBe('true')
    expect(send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: '部署建议' }))
    await act(async () => { await Promise.resolve() })
    expect(send).toHaveBeenCalledExactlyOnceWith('请给我部署建议，并标出前提。')
  })

  it('会话不可发送时禁用选择；失败显示共享提示且仍可重试', async () => {
    const noSession = show()
    expect(screen.getByRole<HTMLButtonElement>('radio', { name: '模型概览' }).disabled).toBe(true)
    noSession.unmount()
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('network detail'))
      .mockResolvedValueOnce(undefined)
    show(send)
    fireEvent.click(screen.getByRole('radio', { name: '模型概览' }))
    expect((await screen.findByRole('alert')).textContent).toContain('话题发送失败，请重试')
    expect(document.body.textContent).not.toContain('network detail')
    fireEvent.click(screen.getByRole('radio', { name: '模型概览' }))
    await act(async () => { await Promise.resolve() })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('重放时恢复已选择与已发送状态，不在挂载时再次发送', () => {
    saveBlockState('topic:session:reply', { topics: { 'gpu-followup': { selected: 1, sent: true } } })
    const send = vi.fn(async () => {})
    show(send)
    expect(screen.getByRole('radio', { name: '部署建议' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole<HTMLButtonElement>('radio', { name: '部署建议' }).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('已发送')
    expect(send).not.toHaveBeenCalled()
  })
})
