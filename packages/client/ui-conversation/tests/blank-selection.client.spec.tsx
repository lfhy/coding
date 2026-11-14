// @vitest-environment jsdom
/** 空白入口的 Host 创建、草稿交接与迟到导航租约。 */
import { describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime, stubSettingsScope } from 'coding-client-test-runtime'
import { LocaleRuntime } from 'coding-client-locale/client'
import type { SessionId, WorkspaceId } from 'coding-client-runtime/client'
import { createSnapshotStore } from 'coding-client-runtime/client'
import type { PageRoute } from 'coding-client-ui-layout/client'
import { apply, inject } from '../src/client/apply.ts'
import type { ConversationInjected } from '../src/client/contract/slots.ts'
import type { DraftAttachmentId } from '../src/client/input/contract.ts'

const SOURCE = 'work-blank' as SessionId
const HOME = 'home-blank' as SessionId
const NEXT = 'next-blank' as SessionId
const WORKSPACE = 'workspace-one' as WorkspaceId

function deferred() {
  let resolve!: (id: SessionId) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<SessionId>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

async function bench() {
  const runtime = await SlotTestRuntime.create()
  runtime.provide('connection', { api: { settings: {} }, isLoopback: false })
  runtime.provide('remote', { $on: () => () => {} })
  runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  const layout = { conversationIntent: 1, page: createSnapshotStore<PageRoute | null>(null) }
  runtime.provide('layout', layout)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  for (const id of [SOURCE, HOME, NEXT]) {
    await runtime.sessions.add({ id, summary: { blank: true } }, { current: false })
  }
  await runtime.sessions.setCurrent(SOURCE)
  await runtime.workspaces.update((draft) => {
    draft.items = [{
      workspaceId: WORKSPACE, path: '/project', title: '项目', sessionIds: [SOURCE],
      createdAt: '', updatedAt: '',
    }]
  })
  await runtime.root.declare({
    conversation: { kind: 'single', scope: 'session-maybe' },
    details: { kind: 'single', scope: 'session' },
  }, () => null)
  const feature = await runtime.mount({ inject: [...inject], apply })
  const resident = (id: SessionId | undefined) => (
    runtime.slots.entries('conversation')[0]!.inject as unknown as (id: SessionId | undefined) => ConversationInjected
  )(id)
  const input = (id: SessionId) => runtime.ctx.conversation.input.for(runtime.sessions.binding(id)!.ctx)
  runtime.workspaces.stub('connectHome', () => Promise.resolve(HOME))
  runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(SOURCE))
  return { runtime, feature, resident, input, layout }
}

describe('空白会话选择的导航归属', () => {
  it('标准模式准备完成前不打开目标或迁移草稿，失败保留原会话', async () => {
    const b = await bench()
    const pending = deferred()
    const targets: SessionId[] = []
    b.runtime.ctx.on('conversation/prepare-standalone', async (id) => {
      targets.push(id)
      await pending.promise
    })
    b.input(SOURCE).setDraft('等待标准模式')
    const result = b.resident(SOURCE).selectWithoutWorkspace()
    await vi.waitFor(() => { expect(targets).toEqual([HOME]) })
    expect(b.runtime.sessions.list.getSnapshot().current).toBe(SOURCE)
    expect(b.input(SOURCE).state.getSnapshot().draft).toBe('等待标准模式')
    pending.reject(new Error('preset unavailable'))
    await expect(result).rejects.toThrow('preset unavailable')
    expect(b.runtime.sessions.calls.filter(call => call.method === 'open')).toEqual([])
    expect(b.input(SOURCE).state.getSnapshot().draft).toBe('等待标准模式')
    await b.runtime.dispose()
  })

  it('标准模式准备期间切走再返回，完成后仍不导航或搬走草稿', async () => {
    const b = await bench()
    const pending = deferred()
    b.runtime.ctx.on('conversation/prepare-standalone', async () => { await pending.promise })
    b.input(SOURCE).setDraft('不被迟到准备搬走')
    const result = b.resident(SOURCE).selectWithoutWorkspace()
    await Promise.resolve()
    await b.runtime.sessions.setCurrent(NEXT)
    await b.runtime.sessions.setCurrent(SOURCE)
    pending.resolve(HOME)
    expect(await result).toBeUndefined()
    expect(b.runtime.sessions.list.getSnapshot().current).toBe(SOURCE)
    expect(b.input(SOURCE).state.getSnapshot().draft).toBe('不被迟到准备搬走')
    await b.runtime.dispose()
  })

  it('直接聊天创建并打开无项目会话，文字和图片来回交接且不释放图片', async () => {
    const b = await bench()
    const image = 'pending-image' as DraftAttachmentId
    b.input(SOURCE).setDraft('保留这段草稿')
    b.input(SOURCE).addImages([image])
    expect(await b.resident(SOURCE).selectWithoutWorkspace()).toBe(HOME)
    expect(b.runtime.workspaces.calls).toContainEqual({ method: 'connectHome', args: [] })
    expect(b.runtime.sessions.list.getSnapshot().current).toBe(HOME)
    expect(b.input(SOURCE).state.getSnapshot()).toMatchObject({ draft: '', imageIds: [] })
    expect(b.input(HOME).state.getSnapshot()).toMatchObject({ draft: '保留这段草稿', imageIds: [image] })

    expect(await b.resident(HOME).selectWorkspace(WORKSPACE)).toBe(SOURCE)
    expect(b.input(SOURCE).state.getSnapshot()).toMatchObject({ draft: '保留这段草稿', imageIds: [image] })
    expect(b.input(HOME).state.getSnapshot()).toMatchObject({ draft: '', imageIds: [] })
    await b.runtime.dispose()
  })

  it('已是未分组空白会话则复用；没有当前选择则通过 Host 创建', async () => {
    const b = await bench()
    await b.runtime.sessions.setCurrent(HOME)
    expect(await b.resident(HOME).selectWithoutWorkspace()).toBe(HOME)
    expect(b.runtime.workspaces.calls).not.toContainEqual({ method: 'connectHome', args: [] })
    await b.runtime.sessions.setCurrent(undefined)
    expect(await b.resident(undefined).selectWithoutWorkspace()).toBe(HOME)
    expect(b.runtime.workspaces.calls).toContainEqual({ method: 'connectHome', args: [] })
    await b.runtime.dispose()
  })

  it('跨模式保留通用引用的提交身份及复制投影', async () => {
    const b = await bench()
    const reference = '@[参考会话](dsh-session:InNvdXJjZSI)'
    const source = b.input(SOURCE)
    source.setDraft('@ref')
    expect(source.insertReference({
      source: 'custom-source', ref: 'reference-id', label: '参考会话', appearance: 'session', clipboardText: reference,
    }, { start: 0, end: 4, draftRev: source.state.getSnapshot().draftRev })).toBe(true)
    expect(await b.resident(SOURCE).selectWithoutWorkspace()).toBe(HOME)
    expect(b.input(HOME).state.getSnapshot()).toMatchObject({
      draft: '@参考会话 ', occurrences: [{
        source: 'custom-source', ref: 'reference-id', label: '参考会话', appearance: 'session', clipboardText: reference,
      }],
    })
    expect(await b.resident(HOME).selectWorkspace(WORKSPACE)).toBe(SOURCE)
    expect(source.state.getSnapshot().occurrences[0]?.ref).toBe('reference-id')
    await b.runtime.dispose()
  })

  it('创建失败保留来源选择、草稿和图片，不导航到半成会话', async () => {
    const b = await bench()
    b.input(SOURCE).setDraft('稍后重试')
    b.input(SOURCE).addImages(['keep-image' as DraftAttachmentId])
    b.runtime.workspaces.stub('connectHome', () => Promise.reject(new Error('private transport detail')))
    await expect(b.resident(SOURCE).selectWithoutWorkspace()).rejects.toThrow('private transport detail')
    expect(b.runtime.sessions.list.getSnapshot().current).toBe(SOURCE)
    expect(b.runtime.sessions.calls.filter(call => call.method === 'open')).toEqual([])
    expect(b.input(SOURCE).state.getSnapshot()).toMatchObject({ draft: '稍后重试', imageIds: ['keep-image'] })
    await b.runtime.dispose()
  })

  it.each(['新意图', '换会话', '独立页面', '主动撤销', '插件卸载'] as const)('%s 撤销无项目创建的迟到导航', async (reason) => {
    const b = await bench()
    const pending = deferred()
    b.runtime.workspaces.stub('connectHome', () => pending.promise)
    b.input(SOURCE).setDraft('旧入口草稿')
    const resident = b.resident(SOURCE)
    const result = resident.selectWithoutWorkspace()
    if (reason === '新意图') b.layout.conversationIntent++
    if (reason === '换会话') await b.runtime.sessions.setCurrent(NEXT)
    if (reason === '独立页面') b.layout.page.set({ kind: 'image', sessionId: SOURCE })
    if (reason === '主动撤销') resident.abortBlankSelection()
    if (reason === '插件卸载') await b.feature.dispose()
    pending.resolve(HOME)
    expect(await result).toBeUndefined()
    expect(b.runtime.sessions.calls.filter(call => call.method === 'open')).toEqual([])
    if (reason !== '插件卸载') expect(b.input(SOURCE).state.getSnapshot().draft).toBe('旧入口草稿')
    await b.runtime.dispose()
  })

  it.each(['切走会话再返回', '打开独立页再关闭'] as const)('%s 不恢复旧请求的导航权', async (navigation) => {
    const b = await bench()
    const pending = deferred()
    b.runtime.workspaces.stub('connectHome', () => pending.promise)
    b.input(SOURCE).setDraft('离开再回来仍保留')
    const image = 'round-trip-image' as DraftAttachmentId
    b.input(SOURCE).addImages([image])
    const result = b.resident(SOURCE).selectWithoutWorkspace()
    if (navigation === '切走会话再返回') {
      await b.runtime.sessions.setCurrent(NEXT)
      await b.runtime.sessions.setCurrent(SOURCE)
    } else {
      b.layout.page.set({ kind: 'image', sessionId: SOURCE })
      b.layout.page.set(null)
    }
    pending.resolve(HOME)
    expect(await result).toBeUndefined()
    expect(b.runtime.sessions.list.getSnapshot().current).toBe(SOURCE)
    expect(b.layout.page.getSnapshot()).toBeNull()
    expect(b.runtime.sessions.calls.filter(call => call.method === 'open')).toEqual([])
    expect(b.input(SOURCE).state.getSnapshot()).toMatchObject({ draft: '离开再回来仍保留', imageIds: [image] })
    expect(b.input(HOME).state.getSnapshot()).toMatchObject({ draft: '', imageIds: [] })
    await b.runtime.dispose()
  })

  it('新工作区选择胜出后，旧 connectHome 与失败都不抢导航或移走草稿', async () => {
    const b = await bench()
    const pending = deferred()
    b.runtime.workspaces.stub('connectHome', () => pending.promise)
    b.runtime.workspaces.stub('connectWorkspace', () => Promise.resolve(NEXT))
    b.input(SOURCE).setDraft('给最新选择')
    const resident = b.resident(SOURCE)
    const old = resident.selectWithoutWorkspace()
    expect(await resident.selectWorkspace(WORKSPACE)).toBe(NEXT)
    pending.reject(new Error('old request failed'))
    expect(await old).toBeUndefined()
    expect(b.runtime.sessions.list.getSnapshot().current).toBe(NEXT)
    expect(b.input(NEXT).state.getSnapshot().draft).toBe('给最新选择')
    expect(b.input(HOME).state.getSnapshot().draft).toBe('')
    await b.runtime.dispose()
  })

  it('旧工作区连接也不能越过新的 HOME 选择，陈旧闭包不再创建', async () => {
    const b = await bench()
    const pending = deferred()
    b.runtime.workspaces.stub('connectWorkspace', () => pending.promise)
    b.input(SOURCE).setDraft('留给对话')
    const resident = b.resident(SOURCE)
    const old = resident.selectWorkspace(WORKSPACE)
    expect(await resident.selectWithoutWorkspace()).toBe(HOME)
    pending.resolve(NEXT)
    expect(await old).toBeUndefined()
    expect(b.runtime.sessions.list.getSnapshot().current).toBe(HOME)
    expect(b.input(HOME).state.getSnapshot().draft).toBe('留给对话')
    const calls = b.runtime.workspaces.calls.length
    expect(await resident.selectWithoutWorkspace()).toBeUndefined()
    expect(b.runtime.workspaces.calls).toHaveLength(calls)
    await b.runtime.dispose()
  })
})
