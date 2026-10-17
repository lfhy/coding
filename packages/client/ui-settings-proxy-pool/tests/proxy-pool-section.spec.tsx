// @vitest-environment jsdom
/**
 * 代理池分区组件测试：testing-library 渲染真实组件，快照选择器经
 * bindSnapshotSelector 绑定自建 store，断言用户可见行为。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from 'coding-client-test-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProxyPoolSection } from '../src/client/ProxyPoolSection.tsx'
import type { ProxyPoolSectionText } from '../src/client/ProxyPoolSection.tsx'
import { createProxyPoolStore } from '../src/client/store.ts'
import type { IApiClient, ProxyHealthView, ProxyNodeView, OutboundModeView } from 'coding-api-remotes/client'

afterEach(cleanup)

const t: ProxyPoolSectionText = {
  title: '代理池',
  outbound: '出站方式',
  outboundDirect: '直连',
  outboundPool: '代理池',
  outboundCustom: '自定义代理',
  customUrlLabel: '自定义代理地址',
  importLabel: '导入代理链接',
  importPlaceholder: '每行一条',
  importButton: '导入',
  imported: count => `已导入 ${count} 个`,
  skipped: count => `跳过 ${count} 行`,
  nodes: '节点',
  test: '测试',
  remove: '删除',
  alive: '可用',
  dead: '不可用',
  latency: ms => `${ms} ms`,
  frontend: '本地代理地址',
  loadFailed: '加载失败',
  retry: '重试',
}

/** describe 成功值。 */
const POOL_VALUE = {
  nodes: [
    { id: 'a', name: '节点A', protocol: 'socks5', address: '1.2.3.4', port: 1080, hasUsername: false, hasSecret: true },
  ] satisfies ProxyNodeView[],
  groups: [],
  health: [{ nodeId: 'a', alive: true, latencyMs: 42, checkedAt: 1 }] satisfies ProxyHealthView[],
  outbound: { mode: 'pool' } satisfies OutboundModeView,
  frontendURL: 'http://127.0.0.1:52000',
}

/** 载波客户端桩：describe 返回固定成功值，动作按需断言。 */
function fakeApi(overrides: Partial<Record<'describe' | 'importLinks' | 'removeNode' | 'testNode' | 'setOutbound', () => Promise<unknown>>> = {}): IApiClient['proxyPool'] {
  return {
    describe: overrides.describe ?? (async () => ({ result: { ok: true, value: POOL_VALUE } })),
    importLinks: overrides.importLinks ?? (async () => ({ result: { ok: true, value: { imported: [] as ProxyNodeView[], skipped: 0 } } })),
    removeNode: overrides.removeNode ?? (async () => ({ result: { ok: true, value: { removed: true } } })),
    testNode: overrides.testNode ?? (async () => ({ result: { ok: true, value: undefined } })),
    setOutbound: overrides.setOutbound ?? (async () => ({ result: { ok: true, value: { outbound: POOL_VALUE.outbound } } })),
  } as unknown as IApiClient['proxyPool']
}

describe('ProxyPoolSection', () => {
  it('注入未完成时渲染为空', () => {
    const { container } = render(<ProxyPoolSection />)
    expect(container.innerHTML).toBe('')
  })

  it('就绪态展示出站选择、前端地址、节点与健康延迟', async () => {
    const store = createProxyPoolStore(fakeApi())
    const actions = { ...store, hooksStore: store.store }
    delete (actions as { store?: unknown }).store
    render(
      <ProxyPoolSection
        actions={actions as never}
        t={t}
        useSnapshot={bindSnapshotSelector(store.store)}
      />,
    )
    expect(await screen.findByRole('heading', { name: '代理池' })).toBeTruthy()
    expect(await screen.findByText(/127.0.0.1:52000/)).toBeTruthy()
    expect(screen.getByText('节点A')).toBeTruthy()
    expect(screen.getByText('socks5 1.2.3.4:1080')).toBeTruthy()
    expect(screen.getByText(/可用.*42 ms/)).toBeTruthy()
  })

  it('加载失败展示错误与重试入口', async () => {
    const api = fakeApi({ describe: async () => ({ result: { ok: false as const, error: { code: 'proxy-pool-unavailable', message: 'the proxy pool service is not installed', details: { capability: 'proxy-pool' } } } }) })
    const store = createProxyPoolStore(api)
    const actions = { ...store, hooksStore: store.store }
    delete (actions as { store?: unknown }).store
    render(
      <ProxyPoolSection
        actions={actions as never}
        t={t}
        useSnapshot={bindSnapshotSelector(store.store)}
      />,
    )
    expect(await screen.findByText(/the proxy pool service is not installed/)).toBeTruthy()
    expect(screen.getByText('重试')).toBeTruthy()
  })

  it('导入动作携带输入文本并回显摘要', async () => {
    const importLinks = vi.fn(async () => ({ result: { ok: true as const, value: { imported: [{ id: 'b', name: 'n', protocol: 'http' as const, address: '5.6.7.8', port: 8080, hasUsername: false, hasSecret: false }], skipped: 1 } } }))
    const store = createProxyPoolStore(fakeApi({ importLinks }))
    const actions = { ...store, hooksStore: store.store }
    delete (actions as { store?: unknown }).store
    render(
      <ProxyPoolSection
        actions={actions as never}
        t={t}
        useSnapshot={bindSnapshotSelector(store.store)}
      />,
    )
    const textarea = screen.getByLabelText('导入代理链接')
    fireEvent.change(textarea, { target: { value: 'http://5.6.7.8:8080\nbad' } })
    fireEvent.click(screen.getByText('导入'))
    await vi.waitFor(() => {
      expect(importLinks).toHaveBeenCalledWith({ text: 'http://5.6.7.8:8080\nbad' })
    })
  })
})
