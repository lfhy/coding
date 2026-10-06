// @vitest-environment jsdom
import { cleanup, fireEvent } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'

let runtime: SlotTestRuntime | undefined

afterEach(async () => {
  cleanup()
  await runtime?.dispose()
  runtime = undefined
  vi.unstubAllGlobals()
})

async function bench() {
  runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('zh')
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const openWorkbench = vi.fn()
  runtime.provide('layout', {
    openWorkbench, closeWorkbench: vi.fn(), toggleWorkbenchFullscreen: vi.fn(),
    toggleWorkbenchBottom: vi.fn(), closeWorkbenchBottom: vi.fn(),
    workbench: () => createSnapshotStore({ open: true, fullscreen: false, bottomOpen: false }),
  })
  const first = await runtime.sessions.add({ id: 'external-first' })
  const second = await runtime.sessions.add({ id: 'external-second' }, { current: false })
  await runtime.declare({ workbench: { kind: 'single', scope: 'root' } })
  await runtime.mount({ inject: [...inject], apply })
  const workbench = runtime.renderSlot('workbench', {
    shown: true, fullscreen: false, bottomOpen: false,
  })
  return { runtime, workbench, first, second, openWorkbench }
}

describe('外部工作台标签的真实插件与 slot 装配', () => {
  it('引导入口和新增入口绘制 keyed 内容、可选标题，并按 Session 与显隐保留及卸载清理', async () => {
    const b = await bench()
    const mounted = vi.fn()
    const unmounted = vi.fn()
    type BodyProps = PropsRuntime<'sidebar.right.pane.tab'>
    type TitleProps = PropsRuntime<'sidebar.right.pane.tab.title'>
    function NoteBody(props: BodyProps) {
      const owner = props.useTabInfo()
      useEffect(() => {
        mounted(props.sessionId, owner.tab.id)
        return () => { unmounted(props.sessionId, owner.tab.id) }
      }, [owner.tab.id, props.sessionId])
      return <article data-testid="extension-body" data-session={props.sessionId}
        data-instance={owner.tab.id} data-shown={owner.shown}>
        {owner.tab.address}
      </article>
    }
    function NoteTitle(props: TitleProps) {
      return <span>插件标题：{props.useTabInfo().tab.name}</span>
    }
    const contribution = await b.runtime.mount({
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx: Context) {
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: 'fixture.notes', kind: 'notes', title: () => '笔记', keepMounted: true,
          guide: [{ id: 'open-note', order: 10, title: () => '打开笔记' }],
        }), 'test: notes definition')
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: 'fixture.plain', kind: 'plain', title: () => '普通标签',
          guide: [{ id: 'open-plain', order: 20, title: () => '打开普通标签' }],
        }), 'test: plain definition')
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: 'fixture.notes',
        }, NoteBody))
        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title', key: 'fixture.notes',
        }, NoteTitle))
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: 'fixture.plain',
        }, ({ tab }: BodyProps) => <article data-testid="plain-body">{tab.address}</article>))
      },
    })

    expect(b.workbench.view.getByRole('button', { name: '打开笔记' })).toBeTruthy()
    fireEvent.click(b.workbench.view.getByRole('button', { name: '打开笔记' }))
    const titled = b.workbench.view.getByRole('tab', { name: '插件标题：笔记' })
    const firstBody = b.workbench.view.getByTestId('extension-body')
    expect(firstBody.textContent).toBe('sidebar://notes')
    expect(firstBody.dataset.session).toBe(b.first)
    expect(firstBody.dataset.shown).toBe('true')
    expect(titled.getAttribute('aria-controls')).toBe(firstBody.closest('[role="tabpanel"]')?.id)
    expect(b.openWorkbench).toHaveBeenLastCalledWith(b.first)

    fireEvent.click(b.workbench.view.getByRole('button', { name: '添加工作台标签' }))
    expect(b.workbench.view.getByTestId('extension-body')).toBe(firstBody)
    expect(firstBody.dataset.shown).toBe('false')
    fireEvent.click(b.workbench.view.getByRole('button', { name: '打开普通标签' }))
    expect(b.workbench.view.getByRole('tab', { name: '普通标签' })).toBeTruthy()
    expect(b.workbench.view.getByTestId('plain-body').textContent).toBe('sidebar://plain')
    expect(firstBody.isConnected).toBe(true)
    expect(firstBody.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true)
    b.workbench.update({ shown: false, fullscreen: false, bottomOpen: false })
    expect(firstBody.isConnected).toBe(true)
    expect(firstBody.dataset.shown).toBe('false')
    b.workbench.update({ shown: true, fullscreen: false, bottomOpen: false })

    await b.runtime.sessions.setCurrent(b.second)
    expect(b.workbench.view.queryByTestId('extension-body')).toBeNull()
    expect(b.workbench.view.queryByRole('tab', { name: '普通标签' })).toBeNull()
    fireEvent.click(b.workbench.view.getByRole('button', { name: '打开笔记' }))
    const secondBody = b.workbench.view.getByTestId('extension-body')
    expect(secondBody.dataset.session).toBe(b.second)
    expect(secondBody).not.toBe(firstBody)
    expect(secondBody.dataset.instance).toBe(firstBody.dataset.instance)
    expect(unmounted).toHaveBeenCalledWith(b.first, firstBody.dataset.instance)
    await b.runtime.sessions.setCurrent(b.first)
    expect(b.workbench.view.getByRole('tab', { name: '普通标签' })).toBeTruthy()
    expect(b.workbench.view.getByTestId('extension-body').dataset.session).toBe(b.first)

    fireEvent.click(b.workbench.view.getByRole('button', { name: '关闭 笔记' }))
    expect(b.workbench.view.queryByTestId('extension-body')).toBeNull()
    expect(b.workbench.view.getByRole('tab', { name: '普通标签' })).toBeTruthy()
    await contribution.dispose()
    expect(b.workbench.view.queryByRole('tab', { name: '普通标签' })).toBeNull()
    expect(b.workbench.view.queryByRole('button', { name: '打开笔记' })).toBeNull()
    expect(b.workbench.view.queryByRole('button', { name: '打开普通标签' })).toBeNull()
    expect(b.runtime.slots.entries('sidebar.right.pane.tab')).toEqual([])
    expect(b.runtime.slots.entries('sidebar.right.pane.tab.title')).toEqual([])
    await b.runtime.sessions.setCurrent(b.second)
    expect(b.workbench.view.queryByRole('tab', { name: '插件标题：笔记' })).toBeNull()
    expect(mounted).toHaveBeenCalledWith(b.first, expect.any(String))
    expect(mounted).toHaveBeenCalledWith(b.second, expect.any(String))
  })
})
