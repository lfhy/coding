// @vitest-environment jsdom
import { cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from 'coding-client-test-runtime'
import { LocaleRuntime } from 'coding-client-locale/client'
import { createSnapshotStore } from 'coding-client-runtime/client'
import { apply as applyWorkbench, inject as workbenchInject } from 'coding-client-ui-open-in-app/client'
import { apply as applyBrowser, inject as browserInject } from '../src/client/index.ts'
import { state } from './browser-fixtures.ts'

vi.mock('../../ui-open-in-app/node_modules/@xterm/xterm', () => ({ Terminal: class {
  cols = 80
  rows = 24
  options: Record<string, unknown> = {}
  loadAddon(): void {}
  open(): void {}
  onData() { return { dispose: vi.fn() } }
  focus(): void {}
  dispose(): void {}
} }))
vi.mock('../../ui-open-in-app/node_modules/@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))

let runtime: SlotTestRuntime | undefined

afterEach(async () => {
  cleanup()
  await runtime?.dispose()
  runtime = undefined
  vi.unstubAllGlobals()
})

/** 旧浏览器插件可与默认工作台装配，但只有自定义 owner 才能激活其可选 slot。 */
async function bench(browserFirst: boolean) {
  runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('zh')
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.provide('layout', {
    openWorkbench: vi.fn(), closeWorkbench: vi.fn(),
    toggleWorkbenchFullscreen: vi.fn(), toggleWorkbenchBottom: vi.fn(),
    workbench: () => createSnapshotStore({ open: true, fullscreen: false, bottomOpen: false }),
  })
  const control = vi.fn()
  runtime.provide('connection', { api: { browser: { control } } })
  const fetcher = vi.fn(async () => new Response(JSON.stringify(state()), { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  await runtime.sessions.add({ id: 'browser-workbench-session' })
  await runtime.declare({ workbench: { kind: 'single', scope: 'root' } })

  if (browserFirst) await runtime.mount({ inject: [...browserInject], apply: applyBrowser })
  await runtime.mount({ inject: [...workbenchInject], apply: applyWorkbench })
  if (!browserFirst) await runtime.mount({ inject: [...browserInject], apply: applyBrowser })

  const workbench = runtime.renderSlot('workbench', {
    shown: true, fullscreen: false, bottomOpen: false,
  })
  return { workbench, control, fetcher }
}

describe('default workbench with the optional legacy browser plugin', () => {
  it.each([
    ['before', true],
    ['after', false],
  ])('does not restore legacy Host tabs when the browser plugin loads %s the workbench', async (_, browserFirst) => {
    const { workbench, control, fetcher } = await bench(browserFirst)
    expect(workbench.view.getByRole('navigation', { name: '工作台功能' })).toBeTruthy()
    expect(workbench.view.queryByRole('tab', { name: 'Example' })).toBeNull()
    expect(workbench.view.queryByRole('button', { name: '浏览器' })).toBeNull()

    fireEvent.click(workbench.view.getByRole('button', { name: '添加工作台标签' }))
    expect(workbench.view.getByRole('tab', { name: '新标签页' }).getAttribute('aria-selected')).toBe('true')
    expect(workbench.view.getByRole('button', { name: '文件' })).toBeTruthy()
    expect(workbench.view.queryByRole('button', { name: '浏览器' })).toBeNull()
    expect(control).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
