import { describe, expect, it, vi } from 'vitest'
import { createGalleryNavigation } from '../src/client/navigation.ts'

interface OtherSession {
  id: string
  blank: boolean
  agentPreset: string
  updatedAt?: number
}

function bench(current?: string, blank = true, preset = 'standard', others: readonly OtherSession[] = []) {
  const byId: Record<string, OtherSession> = Object.fromEntries(others.map(item => [item.id,
    { updatedAt: 0, ...item }]))
  if (current !== undefined) byId[current] = { id: current, blank, agentPreset: preset, updatedAt: 100 }
  const list = { current, byId }
  const workspace = { workspaceId: 'workspace', sessionIds: current === undefined ? [] : [current] }
  const sessions = {
    list: { getSnapshot: () => list }, open: vi.fn((id: string) => { list.current = id }),
    noteAgentPreset: vi.fn((id: string, agentPreset: string) => {
      byId[id] = { id, blank: true, agentPreset, updatedAt: 100 }
    }),
  }
  const workspaces = {
    list: { getSnapshot: () => ({ items: [workspace], recentWorkspaceId: workspace.workspaceId }) },
    connectWorkspace: vi.fn(async () => { byId['new'] = { id: 'new', blank: true, agentPreset: 'standard', updatedAt: 100 }; return 'new' }),
    connectHome: vi.fn(async () => 'home'),
  }
  const select = vi.fn(async () => ({ result: { ok: true as const, value: { agentPreset: 'image' } } }))
  const openPanel = vi.fn(() => true)
  return { sessions, workspaces, select, openPanel,
    navigate: createGalleryNavigation(sessions as never, workspaces as never, { agentPresets: { select } } as never, openPanel) }
}

describe('画图入口', () => {
  it('无会话时创建空白会话并设置画图模式与画廊', async () => {
    const { navigate, sessions, workspaces, select, openPanel } = bench()
    await navigate()
    expect(workspaces.connectWorkspace).toHaveBeenCalledWith('workspace')
    expect(select).toHaveBeenCalledWith({ sessionId: 'new', agentPreset: 'image' })
    expect(sessions.open).toHaveBeenCalledWith('new')
    expect(openPanel).toHaveBeenCalledWith('new')
  })

  it('已有非空普通会话时优先回到最近的画图会话', async () => {
    const withImage = bench('old', false, 'standard', [
      { id: 'older-image', blank: false, agentPreset: 'image', updatedAt: 200 },
      { id: 'newer-image', blank: false, agentPreset: 'image', updatedAt: 300 },
    ])
    await withImage.navigate()
    expect(withImage.select).not.toHaveBeenCalled()
    expect(withImage.sessions.open).toHaveBeenCalledWith('newer-image')
    expect(withImage.openPanel).toHaveBeenCalledWith('newer-image')

    const withoutImage = bench('old', false)
    await withoutImage.navigate()
    expect(withoutImage.select).toHaveBeenCalledWith({ sessionId: 'new', agentPreset: 'image' })
    expect(withoutImage.sessions.open).toHaveBeenCalledWith('new')
  })

  it('空白会话也回到最近的画图会话，既有画图会话直接复用', async () => {
    const blank = bench('blank', true, 'standard', [
      { id: 'image-session', blank: false, agentPreset: 'image', updatedAt: 200 },
    ])
    await blank.navigate()
    expect(blank.select).not.toHaveBeenCalled()
    expect(blank.openPanel).toHaveBeenCalledWith('image-session')

    const blankImage = bench('blank-image', true, 'image', [
      { id: 'image-session', blank: false, agentPreset: 'image', updatedAt: 200 },
    ])
    await blankImage.navigate()
    expect(blankImage.select).not.toHaveBeenCalled()
    expect(blankImage.openPanel).toHaveBeenCalledWith('image-session')

    const image = bench('image-session', false, 'image')
    await image.navigate()
    expect(image.select).not.toHaveBeenCalled()
    expect(image.openPanel).toHaveBeenCalledWith('image-session')
  })

  it('预设切换失败时不触碰当前会话或视图', async () => {
    const benchResult = bench('blank', true)
    benchResult.select.mockRejectedValueOnce(new Error('unavailable'))
    await expect(benchResult.navigate()).rejects.toThrow()
    expect(benchResult.sessions.open).not.toHaveBeenCalled()
    expect(benchResult.openPanel).not.toHaveBeenCalled()
  })
})
