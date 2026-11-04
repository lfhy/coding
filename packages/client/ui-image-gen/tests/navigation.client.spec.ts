import { describe, expect, it, vi } from 'vitest'
import { createGalleryNavigation } from '../src/client/navigation.ts'

function bench(current?: string, blank = true, preset = 'standard') {
  const list = { current, byId: current === undefined ? {} : { [current]: { id: current, blank, agentPreset: preset } } }
  const workspace = { workspaceId: 'workspace', sessionIds: current === undefined ? [] : [current] }
  const sessions = {
    list: { getSnapshot: () => list }, open: vi.fn((id: string) => { list.current = id }),
    noteAgentPreset: vi.fn((id: string, agentPreset: string) => { list.byId[id] = { id, blank: true, agentPreset } }),
  }
  const workspaces = {
    list: { getSnapshot: () => ({ items: [workspace], recentWorkspaceId: workspace.workspaceId }) },
    connectWorkspace: vi.fn(async () => { list.byId['new'] = { id: 'new', blank: true, agentPreset: 'standard' }; return 'new' }),
    connectHome: vi.fn(async () => 'home'),
  }
  const select = vi.fn(async () => ({ result: { ok: true as const, value: { agentPreset: 'image' } } }))
  const conversation = { selectView: vi.fn() }
  return { sessions, workspaces, select, conversation,
    navigate: createGalleryNavigation(sessions as never, workspaces as never, { agentPresets: { select } } as never, conversation) }
}

describe('画图入口', () => {
  it('无会话时创建空白会话并设置画图模式与画廊', async () => {
    const { navigate, sessions, workspaces, select, conversation } = bench()
    await navigate()
    expect(workspaces.connectWorkspace).toHaveBeenCalledWith('workspace')
    expect(select).toHaveBeenCalledWith({ sessionId: 'new', agentPreset: 'image' })
    expect(sessions.open).toHaveBeenCalledWith('new')
    expect(conversation.selectView).toHaveBeenCalledWith('new', 'image-gallery')
  })

  it('已有非空会话不能强切预设，空白和既有画图会话可以复用', async () => {
    const nonblank = bench('old', false)
    await nonblank.navigate()
    expect(nonblank.select).toHaveBeenCalledWith({ sessionId: 'new', agentPreset: 'image' })
    expect(nonblank.sessions.open).toHaveBeenCalledWith('new')
    const image = bench('image-session', false, 'image')
    await image.navigate()
    expect(image.select).not.toHaveBeenCalled()
    expect(image.conversation.selectView).toHaveBeenCalledWith('image-session', 'image-gallery')
  })

  it('预设切换失败时不触碰当前会话或视图', async () => {
    const benchResult = bench('blank', true)
    benchResult.select.mockRejectedValueOnce(new Error('unavailable'))
    await expect(benchResult.navigate()).rejects.toThrow()
    expect(benchResult.sessions.open).not.toHaveBeenCalled()
    expect(benchResult.conversation.selectView).not.toHaveBeenCalled()
  })
})
