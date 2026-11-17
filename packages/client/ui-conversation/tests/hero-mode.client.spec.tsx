// @vitest-environment jsdom
/** Hero 顶部入口与常驻编辑器的装配行为，不依赖工作区插件内部实现。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { LocaleRuntime } from 'coding-client-locale/client'
import { Button } from 'coding-client-ui-primitives'
import type { PropsRenderSlots, PropsRuntime } from 'coding-client-ui-slots'
import type { SessionId, WorkspaceId } from 'coding-client-runtime/client'
import { createSnapshotStore } from 'coding-client-runtime/client'
import type { PageRoute } from 'coding-client-ui-layout/client'
import { SlotTestRuntime, stubSettingsScope } from 'coding-client-test-runtime'
import { apply, inject } from '../src/client/apply.ts'
import type { EmptyWorkspaceOwnerProps } from '../src/client/contract/slots.ts'
import type { HeroModeOwnerProps } from '../src/client/contract/hero-mode.ts'

const WORK = 'work-blank' as SessionId
const HOME = 'home-blank' as SessionId
const WORKSPACE = 'workspace-one' as WorkspaceId

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function AppRoot({ renderSlot }: PropsRenderSlots<'conversation'>) {
  return renderSlot('conversation', { sidebarCollapsed: false })
}

function ModeProbe({ mode, busy, onPick, id }: HeroModeOwnerProps) {
  return <div role="tablist" aria-label="开始方式">
    <Button id={`${id}-work`} role="tab" aria-controls={`${id}-panel`}
      aria-selected={mode === 'work'} disabled={busy} onClick={() => { onPick('work') }}>工作</Button>
    <Button id={`${id}-conversations`} role="tab" aria-controls={`${id}-panel`}
      aria-selected={mode === 'conversation'} disabled={busy} onClick={() => { onPick('conversation') }}>对话</Button>
  </div>
}

function PresetProbe() { return <Button>模式</Button> }
function ActionProbe() { return <Button>文件面板</Button> }
function GitProbe({ sessionId }: PropsRuntime<'conversation.hero.git'>) {
  return sessionId === undefined ? null : <Button>项目分支</Button>
}

async function bench(initial: 'work' | 'conversation' | 'none' | 'active' = 'work') {
  const runtime = await SlotTestRuntime.create()
  runtime.provide('connection', { api: { settings: {} }, isLoopback: false })
  runtime.provide('remote', { $on: () => () => {} })
  runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  const layout = { conversationIntent: 1, page: createSnapshotStore<PageRoute | null>(null) }
  runtime.provide('layout', layout)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const prompt = vi.fn(async () => ({ ok: true as const, value: { accepted: true as const } }))
  for (const id of [WORK, HOME]) {
    await runtime.sessions.add({
      id, summary: { blank: initial !== 'active' },
      snapshot: { blank: initial !== 'active', composerPhase: initial === 'active' ? 'active' : 'blank' },
      session: { prompt },
    }, { current: false })
  }
  await runtime.workspaces.update((draft) => {
    draft.items = [{
      workspaceId: WORKSPACE, path: '/project', title: '项目一', sessionIds: [WORK],
      createdAt: '', updatedAt: '',
    }]
  })
  await runtime.sessions.setCurrent(initial === 'none' ? undefined : initial === 'conversation' ? HOME : WORK)
  await runtime.root.declare({
    conversation: { kind: 'single', scope: 'session-maybe' },
    details: { kind: 'single', scope: 'session' },
  }, AppRoot)
  await runtime.mount({ inject: [...inject], apply })
  runtime.slots.register({ name: 'conversation.hero.mode' }, ModeProbe)
  runtime.slots.register({ name: 'conversation.hero.agentPreset' }, PresetProbe)
  runtime.slots.register({ name: 'conversation.hero.actions', id: 'test-files' }, ActionProbe)
  runtime.slots.register({ name: 'conversation.hero.git', priority: -1 }, GitProbe)
  let picker: EmptyWorkspaceOwnerProps | undefined
  runtime.slots.register({ name: 'conversation.hero.workspace' }, (owner) => { picker = owner; return null })
  runtime.workspaces.stub('connectHome', () => Promise.resolve(HOME))
  runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(WORK))
  const view = runtime.renderRoot()
  return { runtime, view, layout, prompt, picker: () => picker! }
}

describe('新对话页面顶部入口', () => {
  it('胶囊在页面顶部、问候和输入框之外，关联面板并保留右上面板动作', async () => {
    const b = await bench()
    const tabs = b.view.getByRole('tablist', { name: '开始方式' })
    const panel = b.view.getByRole('tabpanel')
    const work = b.view.getByRole('tab', { name: '工作' })
    expect(panel.contains(tabs)).toBe(false)
    expect(tabs.closest('[data-phase]')).toBe(panel.parentElement)
    expect(panel.contains(b.view.getByRole('textbox'))).toBe(true)
    expect(panel.getAttribute('aria-labelledby')).toBe(work.id)
    expect(work.getAttribute('aria-controls')).toBe(panel.id)
    expect(work.getAttribute('aria-selected')).toBe('true')
    expect(b.view.getByRole('button', { name: '文件面板' })).toBeTruthy()
    expect(b.view.getByRole('button', { name: '项目分支' })).toBeTruthy()
    await b.runtime.dispose()
  })

  it('切直接对话经 connectHome 打开会话并搬草稿，回工作恢复项目且 textarea 不重挂', async () => {
    const b = await bench()
    const textarea = b.view.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '跨模式的草稿' } })
    fireEvent.click(b.view.getByRole('tab', { name: '对话' }))
    await waitFor(() => { expect(b.runtime.sessions.list.getSnapshot().current).toBe(HOME) })
    await waitFor(() => { expect(textarea.disabled).toBe(false) })
    expect(b.view.getByRole('textbox')).toBe(textarea)
    expect(textarea.value).toBe('跨模式的草稿')
    expect(b.view.queryByRole('button', { name: '选择工作区' })).toBeNull()
    expect(b.view.queryByRole('button', { name: '项目分支' })).toBeNull()
    expect(b.view.queryByRole('button', { name: '模式' })).toBeNull()
    expect(b.view.getByRole('button', { name: '文件面板' })).toBeTruthy()
    expect(b.view.getByRole('tab', { name: '对话' }).getAttribute('aria-selected')).toBe('true')
    expect(b.runtime.workspaces.calls).toContainEqual({ method: 'connectHome', args: [] })
    expect(b.runtime.storeOf('conversation.session', HOME).getSnapshot()).toMatchObject({ draft: '跨模式的草稿' })
    expect(b.runtime.storeOf('conversation.session', WORK).getSnapshot()).toMatchObject({ draft: '' })

    fireEvent.click(b.view.getByRole('tab', { name: '工作' }))
    await waitFor(() => { expect(b.runtime.sessions.list.getSnapshot().current).toBe(WORK) })
    expect(b.view.getByRole('textbox')).toBe(textarea)
    expect(textarea.value).toBe('跨模式的草稿')
    expect(b.view.getByRole('button', { name: '选择工作区' })).toBeTruthy()
    expect(b.runtime.storeOf('conversation.session', WORK).getSnapshot()).toMatchObject({ draft: '跨模式的草稿' })
    expect(b.view.getByRole('button', { name: '模式' })).toBeTruthy()
    expect(b.runtime.workspaces.calls).toContainEqual({ method: 'connectWorkspace', args: [WORKSPACE] })
    await b.runtime.dispose()
  })

  it('没有会话默认工作；顶部直接对话完成创建后立即可输入', async () => {
    const b = await bench('none')
    const textarea = b.view.getByRole('textbox') as HTMLTextAreaElement
    expect(b.view.getByRole('tab', { name: '工作' }).getAttribute('aria-selected')).toBe('true')
    expect(textarea.readOnly).toBe(true)
    fireEvent.click(b.view.getByRole('tab', { name: '对话' }))
    await waitFor(() => { expect(textarea.disabled || textarea.readOnly).toBe(false) })
    expect(b.view.getByRole('textbox')).toBe(textarea)
    expect(b.runtime.sessions.list.getSnapshot().current).toBe(HOME)
    fireEvent.change(textarea, { target: { value: '直接聊' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => { expect(b.prompt).toHaveBeenCalled() })
    await b.runtime.dispose()
  })

  it('已有无项目空白默认对话；回工作未选项目只锁输入，不清除会话与草稿', async () => {
    const b = await bench('conversation')
    const textarea = b.view.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '待选择项目的草稿' } })
    expect(b.view.getByRole('tab', { name: '对话' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(b.view.getByRole('tab', { name: '工作' }))
    expect(textarea.readOnly).toBe(true)
    expect(textarea.value).toBe('待选择项目的草稿')
    expect(b.runtime.sessions.list.getSnapshot().current).toBe(HOME)
    expect(b.runtime.workspaces.calls).toEqual([])
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(b.prompt).not.toHaveBeenCalled()
    expect(b.picker().open).toBe(true)
    fireEvent.click(b.view.getByRole('tab', { name: '对话' }))
    await waitFor(() => { expect(textarea.readOnly || textarea.disabled).toBe(false) })
    expect(textarea.value).toBe('待选择项目的草稿')
    expect(b.runtime.workspaces.calls).not.toContainEqual({ method: 'connectHome', args: [] })
    await b.runtime.dispose()
  })

  it('失败恢复旧模式、输入和草稿，并用安全 Toast 替换原异常', async () => {
    const b = await bench()
    const textarea = b.view.getByRole('textbox') as HTMLTextAreaElement
    b.runtime.workspaces.stub('connectHome', () => Promise.reject(new Error('secret debug stack')))
    fireEvent.change(textarea, { target: { value: '失败后还在' } })
    fireEvent.click(b.view.getByRole('tab', { name: '对话' }))
    const toast = await b.view.findByRole('alert')
    expect(toast.textContent).toContain('草稿已保留')
    expect(toast.textContent).not.toContain('secret debug stack')
    expect(b.view.getByRole('tab', { name: '工作' }).getAttribute('aria-selected')).toBe('true')
    expect(textarea.disabled || textarea.readOnly).toBe(false)
    expect(textarea.value).toBe('失败后还在')
    expect(b.runtime.sessions.list.getSnapshot().current).toBe(WORK)
    await b.runtime.dispose()
  })

  it('菜单无项目入口使用相同迁移路径，并将失败 Promise 交回菜单', async () => {
    const b = await bench()
    const textarea = b.view.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '菜单草稿' } })
    b.runtime.workspaces.stub('connectHome', () => Promise.reject(new Error('raw transport error')))
    let failure: unknown
    await act(async () => {
      try { await b.picker().startSessionWithoutWorkspace!() }
      catch (error: unknown) { failure = error }
    })
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('草稿已保留')
    expect((failure as Error).message).not.toContain('raw transport error')
    expect(b.view.queryByRole('alert')).toBeNull()
    expect(b.view.getByRole('button', { name: '选择工作区' })).toBeTruthy()
    expect(textarea.value).toBe('菜单草稿')

    b.runtime.workspaces.stub('connectHome', () => Promise.resolve(HOME))
    await act(async () => { await b.picker().startSessionWithoutWorkspace!() })
    expect(b.runtime.sessions.list.getSnapshot().current).toBe(HOME)
    expect(textarea.value).toBe('菜单草稿')
    expect(b.view.getByRole('textbox')).toBe(textarea)
    await b.runtime.dispose()
  })

  it('新意图使迟到创建失效，模式恢复且草稿留在当前会话', async () => {
    const b = await bench()
    let finish!: (id: SessionId) => void
    b.runtime.workspaces.stub('connectHome', () => new Promise<SessionId>((resolve) => { finish = resolve }))
    const textarea = b.view.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '新意图不丢' } })
    fireEvent.click(b.view.getByRole('tab', { name: '对话' }))
    expect((b.view.getByRole('tab', { name: '工作' }) as HTMLButtonElement).disabled).toBe(true)
    expect(textarea.disabled).toBe(true)
    b.layout.conversationIntent++
    await act(async () => { finish(HOME); await Promise.resolve() })
    expect(b.runtime.sessions.list.getSnapshot().current).toBe(WORK)
    expect(b.view.getByRole('tab', { name: '工作' }).getAttribute('aria-selected')).toBe('true')
    expect(textarea.disabled).toBe(false)
    expect(textarea.value).toBe('新意图不丢')
    await b.runtime.dispose()
  })

  it('外部会话往返后旧选择结果不会恢复原来的工作锁定', async () => {
    const b = await bench('conversation')
    let finish!: (id: SessionId) => void
    b.runtime.workspaces.stub('connectWorkspace', () => new Promise<SessionId>((resolve) => { finish = resolve }))
    const textarea = b.view.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '返回后保持对话' } })
    fireEvent.click(b.view.getByRole('tab', { name: '工作' }))
    expect(textarea.readOnly).toBe(true)
    act(() => { b.picker().onPick(WORKSPACE) })
    await b.runtime.sessions.setCurrent(WORK)
    await b.runtime.sessions.setCurrent(HOME)
    expect(b.view.getByRole('tab', { name: '对话' }).getAttribute('aria-selected')).toBe('true')
    await act(async () => { finish(WORK); await Promise.resolve() })
    expect(b.view.getByRole('tab', { name: '对话' }).getAttribute('aria-selected')).toBe('true')
    expect(textarea.disabled || textarea.readOnly).toBe(false)
    expect(textarea.value).toBe('返回后保持对话')
    await b.runtime.dispose()
  })

  it('同为工作模式的外部会话切换关闭原菜单，离开空态再返回也不重开', async () => {
    const b = await bench()
    await b.runtime.workspaces.update((draft) => { draft.items[0]!.sessionIds.push(HOME) })
    const textarea = b.view.getByRole('textbox')
    fireEvent.click(b.view.getByRole('button', { name: '选择工作区' }))
    expect(b.picker().open).toBe(true)
    await b.runtime.sessions.setCurrent(HOME)
    expect(b.view.getByRole('tab', { name: '工作' }).getAttribute('aria-selected')).toBe('true')
    expect(b.picker().open).toBe(false)
    expect(b.view.getByRole('textbox')).toBe(textarea)
    fireEvent.click(b.view.getByRole('button', { name: '选择工作区' }))
    expect(b.picker().open).toBe(true)
    await b.runtime.sessions.updateSnapshot(HOME, (draft) => { draft.composerPhase = 'active'; draft.blank = false })
    await b.runtime.sessions.updateSnapshot(HOME, (draft) => { draft.composerPhase = 'blank'; draft.blank = true })
    expect(b.picker().open).toBe(false)
    expect(b.view.getByRole('textbox')).toBe(textarea)
    await b.runtime.dispose()
  })

  it('非空会话没有模式入口，Hero 首条消息后入口移除且 textarea 保持', async () => {
    const b = await bench()
    const textarea = b.view.getByRole('textbox')
    await b.runtime.sessions.updateSnapshot(WORK, (draft) => { draft.composerPhase = 'active'; draft.blank = false })
    expect(b.view.queryByRole('tablist', { name: '开始方式' })).toBeNull()
    expect(b.view.queryByRole('tabpanel')).toBeNull()
    expect(b.view.getByRole('textbox')).toBe(textarea)
    await b.runtime.dispose()
  })
})
