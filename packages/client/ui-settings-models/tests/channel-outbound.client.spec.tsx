// @vitest-environment jsdom
/**
 * 渠道级出站行的行为契约：分段选择即时保存、自定义代理要求地址、失败诊断
 * 留在行内、只读时禁用写入。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelOutboundRow } from '../src/client/ChannelOutboundRow.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

describe('ChannelOutboundRow', () => {
  it('选择内置代理池立即保存该模式', () => {
    const onSave = vi.fn(async () => undefined)
    render(<ChannelOutboundRow value={{ mode: 'direct' }} disabled={false} t={t} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: en.channelOutboundPool }))
    expect(onSave).toHaveBeenCalledWith({ mode: 'pool' })
  })

  it('从直连切到自定义代理后填入地址再应用', () => {
    const onSave = vi.fn(async () => undefined)
    render(<ChannelOutboundRow value={{ mode: 'direct' }} disabled={false} t={t} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: en.channelOutboundCustom }))
    // 展开地址输入但尚未写入设置。
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(en.channelOutboundUrl), { target: { value: 'http://10.0.0.1:8080' } })
    fireEvent.click(screen.getByRole('button', { name: en.channelOutboundApply }))
    expect(onSave).toHaveBeenCalledWith({ mode: 'custom', customUrl: 'http://10.0.0.1:8080' })
  })

  it('保存失败时显示诊断', async () => {
    const onSave = vi.fn(async () => 'save failed')
    render(<ChannelOutboundRow value={{ mode: 'direct' }} disabled={false} t={t} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: en.channelOutboundDirect }))
    expect((await screen.findByRole('alert')).textContent).toBe('save failed')
  })

  it('只读时禁用选择', () => {
    render(<ChannelOutboundRow value={{ mode: 'direct' }} disabled t={t} onSave={vi.fn()} />)
    expect(screen.getByRole('button', { name: en.channelOutboundDirect })).toHaveProperty('disabled', true)
  })
})
