/** 目录同步保留用户视图选择，页面进出目录只影响同种类的会话标签。 */
import { describe, expect, it } from 'vitest'
import type { SessionId } from 'coding-session/types'
import { createRetainedWorkbenchStore, type WorkbenchExternalTab } from '../src/client/store.ts'

const FIRST = 'first-session' as SessionId
const SECOND = 'second-session' as SessionId
const KIND = 'ego-browser:watch'
const DEFINITION = 'agent-browser'
const fallback = { address: 'sidebar://ego-browser%3Awatch', name: 'Agent 浏览器' }

function page(targetId: string, name: string) {
  return {
    address: `${fallback.address}/${targetId}`,
    name,
    params: { targetId },
  }
}

function directory(pages: ReturnType<typeof page>[], firstSeen?: string) {
  return { kind: KIND, definitionId: DEFINITION, fallback, pages,
    ...(firstSeen === undefined ? {} : { firstSeen }) }
}

function browserTabs(instance: ReturnType<ReturnType<typeof createRetainedWorkbenchStore>['create']>, sessionId: SessionId) {
  return instance.getSnapshot().sessions[sessionId]?.tabs.filter((tab): tab is WorkbenchExternalTab =>
    tab.type === 'external' && tab.kind === KIND) ?? []
}

describe('目录驱动的页面标签', () => {
  it('重开已知页面复用视图，入口切回页面，已关闭的首张页面不被空入口自动复活', () => {
    const instance = createRetainedWorkbenchStore().create()
    const firstPage = page('page-one', '第一页')
    const secondPage = page('page-two', '第二页')
    instance.actions.syncExternalTabs(FIRST, directory([firstPage, secondPage], firstPage.address))
    const firstTab = browserTabs(instance, FIRST)[0]
    instance.actions.openExternalTab(FIRST, { definitionId: DEFINITION, kind: KIND,
      name: firstPage.name, address: firstPage.address, params: firstPage.params,
      multiple: true, reuseAddress: true })
    expect(browserTabs(instance, FIRST)).toHaveLength(2)
    expect(instance.getSnapshot().sessions[FIRST]?.activeId).toBe(firstTab?.id)
    instance.actions.closeExternalTab(FIRST, firstTab?.id ?? '')
    instance.actions.openExternalTab(FIRST, { definitionId: DEFINITION, kind: KIND,
      name: fallback.name, address: fallback.address, multiple: true, reuseAddress: true })
    expect(browserTabs(instance, FIRST)).toHaveLength(1)
    expect(instance.getSnapshot().sessions[FIRST]?.activeId).toBe(browserTabs(instance, FIRST)[0]?.id)
    instance.actions.syncExternalTabs(FIRST, directory([firstPage, secondPage], firstPage.address))
    expect(browserTabs(instance, FIRST).map(tab => tab.address)).toEqual([secondPage.address])
  })

  it('手动打开已在目录中的页面后，目录同步不会再生成第二个相同标签', () => {
    const instance = createRetainedWorkbenchStore().create()
    const firstPage = page('page-one', '第一页')
    instance.actions.openExternalTab(FIRST, { definitionId: DEFINITION, kind: KIND,
      name: fallback.name, address: fallback.address, multiple: true, reuseAddress: true })
    instance.actions.syncExternalTabs(FIRST, directory([firstPage], firstPage.address))
    instance.actions.openExternalTab(FIRST, { definitionId: DEFINITION, kind: KIND,
      name: firstPage.name, address: firstPage.address, params: firstPage.params,
      multiple: true, reuseAddress: true })
    instance.actions.syncExternalTabs(FIRST, directory([firstPage], firstPage.address))
    expect(browserTabs(instance, FIRST)).toHaveLength(1)
  })

  it('通用入口不借用其他插件的多实例标签', () => {
    const instance = createRetainedWorkbenchStore().create()
    const other = { definitionId: 'other', kind: 'other', name: '其他页面', address: 'sidebar://other/page' }
    instance.actions.openExternalTab(FIRST, { ...other, multiple: true })
    instance.actions.openExternalTab(FIRST, { definitionId: DEFINITION, kind: KIND,
      name: fallback.name, address: fallback.address, multiple: true, reuseAddress: true })
    expect(instance.getSnapshot().sessions[FIRST]?.tabs).toHaveLength(2)
    expect(browserTabs(instance, FIRST)).toMatchObject([{ address: fallback.address }])
  })

  it('首次目录将 fallback 原位变为页面，后续新增页面不抢用户正在查看的标签', () => {
    const instance = createRetainedWorkbenchStore().create()
    instance.actions.openExternalTab(FIRST, { definitionId: DEFINITION, kind: KIND,
      name: fallback.name, address: fallback.address, multiple: true })
    const fallbackId = instance.getSnapshot().sessions[FIRST]?.activeId
    const firstPage = page('page-one', '第一页')
    instance.actions.syncExternalTabs(FIRST, directory([firstPage], firstPage.address))

    expect(browserTabs(instance, FIRST)).toMatchObject([{
      id: fallbackId, definitionId: DEFINITION, address: firstPage.address,
      name: '第一页', params: { targetId: 'page-one' }, revision: 1,
    }])
    expect(instance.getSnapshot().sessions[FIRST]).toMatchObject({ view: 'external', activeId: fallbackId })

    instance.actions.openFileManager(FIRST)
    const secondPage = page('page-two', '第二页')
    instance.actions.syncExternalTabs(FIRST, directory([page('page-one', '第一页面'), secondPage], secondPage.address))
    expect(browserTabs(instance, FIRST)).toMatchObject([
      { id: fallbackId, address: firstPage.address, name: '第一页面', revision: 1 },
      { address: secondPage.address, name: '第二页', params: { targetId: 'page-two' }, revision: 0 },
    ])
    expect(browserTabs(instance, FIRST)[1]?.id).not.toBe(fallbackId)
    expect(instance.getSnapshot().sessions[FIRST]).toMatchObject({ view: 'files', activeId: 'file-manager' })
    instance.actions.syncExternalTabs(FIRST, directory([page('page-one', '第一页面'), secondPage]))
    expect(browserTabs(instance, FIRST)).toHaveLength(2)
    expect(instance.getSnapshot().sessions[FIRST]).toMatchObject({ view: 'files', activeId: 'file-manager' })
  })

  it('手动新建仅替换发起时仍选中的菜单标签，迟到结果不吞掉后开的菜单', () => {
    const instance = createRetainedWorkbenchStore().create()
    instance.actions.openLauncher(FIRST)
    const launcherId = instance.getSnapshot().sessions[FIRST]?.activeId ?? ''
    instance.actions.syncExternalTabs(FIRST, directory([page('new-page', '新页面')]))
    expect(browserTabs(instance, FIRST)).toHaveLength(0)
    instance.actions.openExternalTab(FIRST, { definitionId: DEFINITION, kind: KIND,
      name: '新页面', address: page('new-page', '新页面').address,
      params: { targetId: 'new-page' }, multiple: true, reuseAddress: true, launcherId })
    expect(browserTabs(instance, FIRST).map(tab => tab.address)).toEqual([page('new-page', '新页面').address])
    expect(instance.getSnapshot().sessions[FIRST]?.tabs.some(tab => tab.id === launcherId)).toBe(false)
    instance.actions.openLauncher(FIRST)
    const laterLauncher = instance.getSnapshot().sessions[FIRST]?.activeId
    instance.actions.openExternalTab(FIRST, { definitionId: DEFINITION, kind: KIND,
      name: '过期页面', address: page('late', '过期页面').address,
      params: { targetId: 'late' }, multiple: true, reuseAddress: true, launcherId })
    expect(instance.getSnapshot().sessions[FIRST]?.activeId).toBe(laterLauncher)
    expect(browserTabs(instance, FIRST)).toHaveLength(1)
  })

  it('关闭视图后的轮询不复活，目录删除关闭页面，旧页退出再出现可重新打开', () => {
    const instance = createRetainedWorkbenchStore().create()
    const firstPage = page('page-one', '第一页')
    const secondPage = page('page-two', '第二页')
    instance.actions.syncExternalTabs(FIRST, directory([firstPage, secondPage], firstPage.address))
    const firstTabId = browserTabs(instance, FIRST)[0]?.id ?? ''
    expect(browserTabs(instance, FIRST)).toMatchObject([
      { address: firstPage.address }, { address: secondPage.address },
    ])
    expect(instance.getSnapshot().sessions[FIRST]?.activeId).toBe(firstTabId)
    instance.actions.closeExternalTab(FIRST, firstTabId)
    instance.actions.syncExternalTabs(FIRST, directory([firstPage, secondPage], firstPage.address))
    expect(browserTabs(instance, FIRST).map(tab => tab.address)).toEqual([secondPage.address])
    expect(instance.getSnapshot().sessions[FIRST]?.activeId).toBe(browserTabs(instance, FIRST)[0]?.id)
    expect(instance.getSnapshot().sessions[FIRST]?.knownExternalAddresses[KIND])
      .toEqual([firstPage.address, secondPage.address])

    instance.actions.syncExternalTabs(FIRST, directory([firstPage]))
    expect(browserTabs(instance, FIRST)).toHaveLength(0)
    expect(instance.getSnapshot().sessions[FIRST]).toMatchObject({ view: 'menu', activeId: null })
    instance.actions.syncExternalTabs(FIRST, directory([]))
    instance.actions.syncExternalTabs(FIRST, directory([firstPage], firstPage.address))
    expect(browserTabs(instance, FIRST)).toMatchObject([{
      address: firstPage.address, params: { targetId: 'page-one' }, revision: 0,
    }])
    expect(browserTabs(instance, FIRST)[0]?.id).not.toBe(firstTabId)
    expect(instance.getSnapshot().sessions[FIRST]?.activeId).toBe(browserTabs(instance, FIRST)[0]?.id)
  })

  it('同步一个 kind 与 Session 不改变其他类型或会话中的标签和目录记忆', () => {
    const instance = createRetainedWorkbenchStore().create()
    const other = { definitionId: 'plugin:notes', kind: 'notes', name: '笔记', address: 'sidebar://notes' }
    instance.actions.openExternalTab(FIRST, other)
    instance.actions.openExternalTab(SECOND, { definitionId: DEFINITION, kind: KIND,
      name: fallback.name, address: fallback.address, multiple: true })
    instance.actions.syncExternalTabs(SECOND, directory([page('other', '另一个会话')]))
    const otherSession = instance.getSnapshot().sessions[SECOND]
    const noteTab = instance.getSnapshot().sessions[FIRST]?.tabs[0]
    const firstPage = page('page-one', '第一页')
    instance.actions.syncExternalTabs(FIRST, directory([firstPage], firstPage.address))
    instance.actions.syncExternalTabs(FIRST, directory([]))

    expect(instance.getSnapshot().sessions[FIRST]).toMatchObject({
      view: 'external', activeId: noteTab?.id,
      tabs: [{ type: 'external', kind: 'notes', address: other.address }],
      knownExternalAddresses: { [KIND]: [] },
    })
    expect(instance.getSnapshot().sessions[FIRST]?.tabs[0]).toEqual(noteTab)
    expect(instance.getSnapshot().sessions[SECOND]).toBe(otherSession)
    expect(browserTabs(instance, SECOND)).toMatchObject([{
      address: page('other', '另一个会话').address, name: '另一个会话',
    }])
  })
})
