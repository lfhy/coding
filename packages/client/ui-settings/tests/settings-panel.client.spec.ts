import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SettingsPanelController } from '../src/client/settings-panel.ts'

/** 建一个只提供本服务的上下文；外壳渲染不在本用例范围内。 */
function bench() {
  const ctx = new Context()
  const panel = new SettingsPanelController(ctx)
  // 产品路径经 Cordis 服务代理调用，`this` 是调用方上下文的影子对象。
  return { ctx, panel, service: ctx.settingsPanel }
}

describe('SettingsPanelController', () => {
  it('registers as ctx.settingsPanel and starts closed', () => {
    const { ctx, panel } = bench()
    expect(ctx.settingsPanel.state).toBe(panel.state)
    expect(panel.state.getSnapshot()).toEqual({ open: false, section: undefined })
  })

  it('opens on a requested section and notifies once per state change', () => {
    const { panel, service } = bench()
    const listener = vi.fn()
    const off = panel.state.subscribe(listener)
    service.open('models')
    expect(panel.state.getSnapshot()).toEqual({ open: true, section: 'models' })
    expect(listener).toHaveBeenCalledOnce()
    // 同一分区上的重复请求不产生额外通知，避免外壳重复提交。
    service.open('models')
    expect(listener).toHaveBeenCalledOnce()
    off()
  })

  it('opens without a target section and switches sections in place', () => {
    const { panel, service } = bench()
    service.open()
    expect(panel.state.getSnapshot()).toEqual({ open: true, section: undefined })
    service.select('general')
    expect(panel.state.getSnapshot()).toEqual({ open: true, section: 'general' })
  })

  it('closes and clears the target so the next open starts at the default section', () => {
    const { panel, service } = bench()
    service.open('models')
    const openSnapshot = panel.state.getSnapshot()
    service.close()
    expect(panel.state.getSnapshot()).toEqual({ open: false, section: undefined })
    expect(panel.state.getSnapshot()).not.toBe(openSnapshot)
    // 已关闭时重复关闭不产生新快照。
    const closed = panel.state.getSnapshot()
    service.close()
    expect(panel.state.getSnapshot()).toBe(closed)
  })
})
