import { describe, expect, it, vi } from 'vitest'
import type { RpcId, RpcResponse } from 'coding-api-remotes/client'
import { createTemplateNavigation } from '../src/client/template-navigation.ts'
import type { TemplateHandoffId } from '../src/client/template-navigation.ts'

const FIRST = 'handoff-first' as TemplateHandoffId
const SECOND = 'handoff-second' as TemplateHandoffId
const THIRD = 'handoff-third' as TemplateHandoffId

interface Row { id: string; blank: boolean; agentPreset?: string }
interface Draft { draft: string; imageIds: string[]; occurrences: unknown[]; phase: 'plain' | 'claimed' | 'adjudicating' | 'submitting' }

function fixture(current: string | null = 'current', preset = 'ppt', blank = false) {
  const active = current ?? undefined
  const rows: Record<string, Row> = {}
  if (active !== undefined) rows[active] = { id: active, agentPreset: preset, blank }
  const list = { current: active, byId: rows }
  const drafts: Record<string, Draft> = {}
  const input = (id: string) => {
    drafts[id] ??= { draft: '', imageIds: [], occurrences: [], phase: 'plain' }
    return drafts[id]
  }
  const setDraft = vi.fn((id: string, text: string) => { input(id).draft = text })
  const sessions = {
    list: { getSnapshot: () => list },
    open: vi.fn((id: string) => { list.current = id }),
    scope: vi.fn((id: string) => rows[id] === undefined ? undefined : { id }),
    noteAgentPreset: vi.fn((id: string, value: string) => { rows[id]!.agentPreset = value }),
    create: vi.fn(async () => { rows.fresh = { id: 'fresh', blank: true }; return 'fresh' }),
  }
  const workspace = { workspaceId: 'work', sessionIds: active === undefined ? [] : [active] }
  const workspaces = {
    list: { getSnapshot: () => ({ items: [workspace], recentWorkspaceId: 'work' }) },
    connectWorkspace: vi.fn(async () => {
      rows.candidate ??= { id: 'candidate', blank: true }
      return 'candidate'
    }),
    connectHome: vi.fn(async () => { rows.home = { id: 'home', blank: true }; return 'home' }),
  }
  const select = vi.fn(async (): Promise<RpcResponse<{ agentPreset: string }>> => ({
    rpcId: 'template-select' as RpcId,
    result: { ok: true, value: { agentPreset: 'ppt' } },
  }))
  const conversation = {
    input: { for: vi.fn((scope: { id: string }) => ({
      state: { getSnapshot: () => input(scope.id) },
      setDraft: (text: string) => { setDraft(scope.id, text) },
    })) },
    focusInput: vi.fn(),
  }
  const layout = { showConversation: vi.fn() }
  const navigation = createTemplateNavigation(sessions as never, workspaces as never,
    { agentPresets: { select } }, conversation as never, layout)
  return { list, rows, drafts, input, setDraft, sessions, workspaces, select, conversation, layout, navigation }
}

describe('PPT 模板到同会话输入草稿的交接', () => {
  it('保留当前 PPT 会话、已有文字与图片引用，不提交模型轮次', async () => {
    const b = fixture()
    const occurrence = { occurrenceId: 1, offset: 0 }
    b.input('current').draft = '已有想法'
    b.input('current').imageIds = ['image']
    b.input('current').occurrences = [occurrence]
    await b.navigation.handoffPrompt('帮我生成 PPT 模板', FIRST)
    expect(b.setDraft).toHaveBeenCalledWith('current', '已有想法\n\n帮我生成 PPT 模板')
    expect(b.input('current').imageIds).toEqual(['image'])
    expect(b.input('current').occurrences).toEqual([occurrence])
    expect(b.sessions.open).not.toHaveBeenCalled()
    expect(b.select).not.toHaveBeenCalled()
    b.navigation.focusPrompt(FIRST)
    expect(b.layout.showConversation).toHaveBeenCalledWith('current')
    expect(b.conversation.focusInput).toHaveBeenCalledWith('current')
  })

  it('普通已开始会话不切预设；沿用工作区新建 PPT 空白会话', async () => {
    const b = fixture('current', 'standard', false)
    b.rows.candidate = { id: 'candidate', blank: true, agentPreset: 'standard' }
    await b.navigation.handoffPrompt('生成模板', FIRST)
    expect(b.workspaces.connectWorkspace).toHaveBeenCalledWith('work')
    expect(b.sessions.create).toHaveBeenCalledWith({ workspaceId: 'work' })
    expect(b.select).toHaveBeenCalledWith({ sessionId: 'fresh', agentPreset: 'ppt' })
    expect(b.sessions.noteAgentPreset).toHaveBeenCalledWith('fresh', 'ppt')
    expect(b.sessions.open).toHaveBeenCalledWith('fresh')
    const original = b.rows.current
    if (original === undefined) throw new Error('原会话摘要丢失')
    expect(original.agentPreset).toBe('standard')
    expect(b.input('fresh').draft).toBe('生成模板')
  })

  it('已复用的空白草稿不被劫持，另建接收会话', async () => {
    const b = fixture('current', 'standard', false)
    b.input('candidate').draft = '用户草稿'
    b.rows.candidate = { id: 'candidate', blank: true }
    await b.navigation.handoffPrompt('生成模板', FIRST)
    expect(b.sessions.create).toHaveBeenCalledOnce()
    expect(b.input('candidate').draft).toBe('用户草稿')
    expect(b.select).toHaveBeenCalledWith({ sessionId: 'fresh', agentPreset: 'ppt' })
  })

  it('既有空白会话即使输入机暂为空，也不假定其持久草稿为空', async () => {
    const b = fixture('current', 'standard', false)
    b.rows.candidate = { id: 'candidate', blank: true, agentPreset: 'ppt' }
    await b.navigation.handoffPrompt('生成模板', FIRST)
    expect(b.sessions.create).toHaveBeenCalledWith({ workspaceId: 'work' })
    expect(b.conversation.input.for).not.toHaveBeenCalledWith({ id: 'candidate' })
    expect(b.sessions.open).toHaveBeenCalledWith('fresh')
  })

  it('无当前会话选最近工作区；当前会话未归属工作区则从 Host HOME 新建', async () => {
    const noCurrent = fixture(null)
    await noCurrent.navigation.handoffPrompt('生成模板', FIRST)
    expect(noCurrent.workspaces.connectWorkspace).toHaveBeenCalledWith('work')
    expect(noCurrent.sessions.open).toHaveBeenCalledWith('candidate')
    const ungrouped = fixture('current', 'standard', false)
    ungrouped.workspaces.list.getSnapshot().items[0]!.sessionIds.splice(0, 1)
    await ungrouped.navigation.handoffPrompt('生成模板', FIRST)
    expect(ungrouped.workspaces.connectHome).toHaveBeenCalledOnce()
    expect(ungrouped.sessions.open).toHaveBeenCalledWith('home')
  })

  it('Host 拒绝切换或输入忙时保留原会话和原草稿', async () => {
    const failed = fixture('current', 'standard', false)
    failed.select.mockResolvedValueOnce({
      rpcId: 'template-select' as RpcId,
      result: { ok: false, error: { code: 'internal', message: '预设不可用', details: {} } },
    })
    await expect(failed.navigation.handoffPrompt('生成模板', FIRST)).rejects.toThrow('预设不可用')
    expect(failed.list.current).toBe('current')
    expect(failed.setDraft).not.toHaveBeenCalled()
    const busy = fixture()
    busy.input('current').phase = 'adjudicating'
    await expect(busy.navigation.handoffPrompt('生成模板', FIRST)).rejects.toThrow('输入正在提交')
    expect(busy.input('current').draft).toBe('')
    expect(busy.sessions.open).not.toHaveBeenCalled()
  })

  it('异步等待期间切换会话或释放，迟到结果不切预设、导航或写草稿', async () => {
    const switched = fixture('current', 'standard', false)
    let release!: () => void
    switched.workspaces.connectWorkspace.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => { switched.rows.candidate = { id: 'candidate', blank: true }; resolve('candidate') }
    }))
    const pending = switched.navigation.handoffPrompt('生成模板', FIRST)
    switched.list.current = 'elsewhere'
    release()
    await expect(pending).rejects.toThrow('当前会话已切换')
    expect(switched.select).not.toHaveBeenCalled()
    expect(switched.sessions.open).not.toHaveBeenCalled()
    expect(switched.setDraft).not.toHaveBeenCalled()

    const disposed = fixture('current', 'standard', false)
    let finish!: () => void
    disposed.workspaces.connectWorkspace.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => { disposed.rows.candidate = { id: 'candidate', blank: true }; resolve('candidate') }
    }))
    const task = disposed.navigation.handoffPrompt('生成模板', FIRST)
    disposed.navigation.dispose()
    finish()
    await expect(task).rejects.toThrow('已关闭')
    expect(disposed.select).not.toHaveBeenCalled()
    disposed.navigation.focusPrompt(FIRST)
    expect(disposed.conversation.focusInput).not.toHaveBeenCalled()
  })

  it('预设 RPC 在途时切走会话，不回写摘要或输入草稿', async () => {
    const b = fixture('current', 'standard', false)
    let complete!: () => void
    b.select.mockImplementationOnce(() => new Promise((resolve) => {
      complete = () => { resolve({
        rpcId: 'template-select' as RpcId,
        result: { ok: true, value: { agentPreset: 'ppt' } },
      }) }
    }))
    const pending = b.navigation.handoffPrompt('生成模板', FIRST)
    await vi.waitFor(() => { expect(b.select).toHaveBeenCalledOnce() })
    b.list.current = 'elsewhere'
    complete()
    await expect(pending).rejects.toThrow('当前会话已切换')
    expect(b.sessions.noteAgentPreset).not.toHaveBeenCalled()
    expect(b.sessions.open).not.toHaveBeenCalled()
    expect(b.setDraft).not.toHaveBeenCalled()
  })

  it('关闭设置入口会取消延迟的交接，并阻止其迟到聚焦', async () => {
    const b = fixture('current', 'standard', false)
    let release!: () => void
    b.workspaces.connectWorkspace.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => { b.rows.candidate = { id: 'candidate', blank: true }; resolve('candidate') }
    }))
    const old = b.navigation.handoffPrompt('生成模板', FIRST)
    b.navigation.cancelHandoff(FIRST)
    release()
    await expect(old).rejects.toThrow('草稿交接已取消')
    expect(b.select).not.toHaveBeenCalled()
    expect(b.sessions.open).not.toHaveBeenCalled()
    expect(b.setDraft).not.toHaveBeenCalled()
    b.navigation.focusPrompt(FIRST)
    expect(b.layout.showConversation).not.toHaveBeenCalled()
    expect(b.conversation.focusInput).not.toHaveBeenCalled()
  })

  it('旧身份取消后的迟到 RPC 不撤销同文案新身份的在途动作', async () => {
    const b = fixture('current', 'standard', false)
    let finishOld!: () => void
    let finishNew!: () => void
    b.select.mockImplementationOnce(() => new Promise((resolve) => {
      finishOld = () => { resolve({ rpcId: 'old' as RpcId, result: { ok: true, value: { agentPreset: 'ppt' } } }) }
    })).mockImplementationOnce(() => new Promise((resolve) => {
      finishNew = () => { resolve({ rpcId: 'new' as RpcId, result: { ok: true, value: { agentPreset: 'ppt' } } }) }
    }))
    const old = b.navigation.handoffPrompt('生成模板', FIRST)
    await vi.waitFor(() => { expect(b.select).toHaveBeenCalledTimes(1) })
    b.navigation.cancelHandoff(FIRST)
    const next = b.navigation.handoffPrompt('生成模板', SECOND)
    await vi.waitFor(() => { expect(b.select).toHaveBeenCalledTimes(2) })
    finishOld()
    await expect(old).rejects.toThrow('草稿交接已取消')
    b.navigation.cancelHandoff(FIRST)
    await expect(b.navigation.handoffPrompt('生成模板', THIRD)).rejects.toThrow('正在准备另一个')
    finishNew()
    await next
    expect(b.sessions.open).toHaveBeenCalledOnce()
    expect(b.setDraft).toHaveBeenCalledOnce()
    b.navigation.focusPrompt(FIRST)
    expect(b.layout.showConversation).not.toHaveBeenCalled()
    b.navigation.focusPrompt(SECOND)
    expect(b.layout.showConversation).toHaveBeenCalledOnce()
    expect(b.conversation.focusInput).toHaveBeenCalledOnce()
  })

  it('已填草稿的身份被取消后不再聚焦，也不允许复用身份', async () => {
    const b = fixture()
    await b.navigation.handoffPrompt('生成模板', FIRST)
    b.navigation.cancelHandoff(FIRST)
    b.navigation.focusPrompt(FIRST)
    expect(b.layout.showConversation).not.toHaveBeenCalled()
    expect(b.conversation.focusInput).not.toHaveBeenCalled()
    await expect(b.navigation.handoffPrompt('生成模板', FIRST)).rejects.toThrow('身份已使用')
  })

  it('同一身份的在途动作去重，不同身份拒绝；目标切换后不再触发聚焦', async () => {
    const b = fixture('current', 'standard', false)
    let release!: () => void
    b.workspaces.connectWorkspace.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => { b.rows.candidate = { id: 'candidate', blank: true }; resolve('candidate') }
    }))
    const first = b.navigation.handoffPrompt('生成模板', FIRST)
    expect(b.navigation.handoffPrompt('生成模板', FIRST)).toBe(first)
    await expect(b.navigation.handoffPrompt('另一条消息', FIRST)).rejects.toThrow('同一交接动作')
    await expect(b.navigation.handoffPrompt('生成模板', SECOND)).rejects.toThrow('正在准备另一个')
    release()
    await first
    b.list.current = 'current'
    b.navigation.focusPrompt(FIRST)
    expect(b.layout.showConversation).not.toHaveBeenCalled()
    expect(b.conversation.focusInput).not.toHaveBeenCalled()
  })
})
