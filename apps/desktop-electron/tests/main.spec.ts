import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const windowListeners = new Map<string, (...args: unknown[]) => void>()
  const helper = {
    origin: 'http://127.0.0.1:4242',
    request: vi.fn<() => Promise<unknown>>(),
    close: vi.fn<() => Promise<void>>(),
    onActivate: vi.fn(() => vi.fn()),
    onClosed: vi.fn(() => vi.fn()),
  }
  const window = {
    isDestroyed: vi.fn(() => false),
    hide: vi.fn(), destroy: vi.fn(),
    on: vi.fn((name: string, listener: (...args: unknown[]) => void) => { windowListeners.set(name, listener) }),
  }
  const chrome = { showWindow: vi.fn(), closeWindow: vi.fn(), dispose: vi.fn() }
  const helperEnv = { PATH: '/test/bin', EGO_LINUX_CDP_URL: 'ws://127.0.0.1:8/stale' }
  return {
    listeners, windowListeners, helper, window, chrome, helperEnv,
    app: {
      isPackaged: false,
      setName: vi.fn(), setPath: vi.fn(), requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn((name: string, listener: (...args: unknown[]) => void) => { listeners.set(name, listener) }),
      whenReady: vi.fn(async () => undefined),
      quit: vi.fn(() => { listeners.get('before-quit')?.({ preventDefault: vi.fn() }) }),
    },
    showErrorBox: vi.fn(),
    prepareDevelopmentDirectories: vi.fn(async () => undefined),
    resolveRuntimeConfig: vi.fn(async () => ({ home: '/test/home', userData: '/test/user-data', cwd: '/test/workspace', helper: { env: helperEnv } })),
    launchHelper: vi.fn(async (_options: { signal: AbortSignal; env: Record<string, string | undefined> }) => helper),
    createHostWindow: vi.fn(() => window),
    installRemoteIpc: vi.fn(() => vi.fn()),
    createNativeChrome: vi.fn(() => chrome),
    createEgoPageHost: vi.fn(() => ({
      present: vi.fn(), conceal: vi.fn(), closeAll: vi.fn(), dispose: vi.fn(),
      list: () => [], find: () => undefined, defaultContext: () => 'desktop-default',
      createContext: () => 'context-1', disposeContext: vi.fn(),
      createPage: vi.fn(async () => ({ targetId: 'target-1' })),
      getCookies: vi.fn(async () => []), setCookies: vi.fn(async () => {}),
      downloads: () => [], cancelDownload: vi.fn(() => false),
      saveDownload: vi.fn(async () => '/tmp/target'), onDownload: vi.fn(() => vi.fn()),
    })),
    createEgoCdpBroker: vi.fn(async () => ({
      url: 'ws://127.0.0.1:9/token', close: vi.fn(async () => {}),
    })),
    installEgoPresentationIpc: vi.fn(() => vi.fn()),
    installEgoDownloadsIpc: vi.fn(() => vi.fn()),
  }
})

vi.mock('electron', () => ({ app: mocks.app, BrowserWindow: vi.fn(), dialog: { showErrorBox: mocks.showErrorBox } }))
vi.mock('coding-home-paths', () => ({ defaultCodingHome: () => '/test/installed' }))
vi.mock('../src/directories.ts', () => ({ prepareDevelopmentDirectories: mocks.prepareDevelopmentDirectories }))
vi.mock('../src/runtime-config.ts', () => ({ resolveRuntimeConfig: mocks.resolveRuntimeConfig, isGuiLaunch: () => false }))
vi.mock('../src/helper-client.ts', () => ({ launchHelper: mocks.launchHelper }))
vi.mock('../src/window.ts', () => ({ createHostWindow: mocks.createHostWindow }))
vi.mock('../src/remote-ipc.ts', () => ({ installRemoteIpc: mocks.installRemoteIpc }))
vi.mock('../src/native-chrome.ts', () => ({ createNativeChrome: mocks.createNativeChrome }))
vi.mock('../src/ego-page-host.ts', () => ({ createEgoPageHost: mocks.createEgoPageHost }))
vi.mock('../src/ego-cdp-broker.ts', () => ({ createEgoCdpBroker: mocks.createEgoCdpBroker }))
vi.mock('../src/ego-presentation-ipc.ts', () => ({
  installEgoPresentationIpc: mocks.installEgoPresentationIpc,
}))
vi.mock('../src/ego-downloads-ipc.ts', () => ({
  installEgoDownloadsIpc: mocks.installEgoDownloadsIpc,
  EGO_DOWNLOADS_EVENT: 'coding:ego-downloads-event',
}))

function requestQuit(): ReturnType<typeof vi.fn> {
  const preventDefault = vi.fn()
  mocks.listeners.get('before-quit')!({ preventDefault })
  return preventDefault
}

function flush(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}

describe('Electron 主进程', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.listeners.clear()
    mocks.windowListeners.clear()
    mocks.window.isDestroyed.mockReturnValue(false)
    mocks.helper.request.mockResolvedValue(null)
    mocks.helper.close.mockResolvedValue(undefined)
    mocks.launchHelper.mockResolvedValue(mocks.helper)
    await import('../src/main.ts')
    await flush()
    expect(mocks.createNativeChrome).toHaveBeenCalledOnce()
  })

  it('启动 helper 时传入当前桌面浏览器端点，保留其他启动环境', () => {
    expect(mocks.launchHelper.mock.calls[0]?.[0].env).toEqual({
      PATH: '/test/bin', EGO_LINUX_CDP_URL: 'ws://127.0.0.1:9/token',
    })
    expect(mocks.helperEnv.EGO_LINUX_CDP_URL).toBe('ws://127.0.0.1:8/stale')
  })

  it('重复退出请求必须等待同一次 helper shutdown 与进程关闭', async () => {
    const shutdown = Promise.withResolvers<unknown>()
    const closed = Promise.withResolvers<undefined>()
    mocks.helper.request.mockReturnValue(shutdown.promise)
    mocks.helper.close.mockReturnValue(closed.promise)
    expect(requestQuit()).toHaveBeenCalledOnce()
    expect(mocks.window.hide).toHaveBeenCalledOnce()
    expect(mocks.window.destroy).toHaveBeenCalledOnce()
    expect(mocks.window.hide.mock.invocationCallOrder[0]).toBeLessThan(mocks.window.destroy.mock.invocationCallOrder[0]!)
    await flush()
    expect(mocks.helper.request).toHaveBeenCalledExactlyOnceWith('shutdown', {})
    expect(mocks.window.destroy.mock.invocationCallOrder[0]).toBeLessThan(mocks.helper.request.mock.invocationCallOrder[0]!)
    expect(requestQuit()).toHaveBeenCalledOnce()
    await flush()
    expect(mocks.window.hide).toHaveBeenCalledOnce()
    expect(mocks.window.destroy).toHaveBeenCalledOnce()
    expect(mocks.app.quit).not.toHaveBeenCalled()
    expect(mocks.helper.close).not.toHaveBeenCalled()

    shutdown.resolve(null)
    await flush()
    expect(mocks.helper.close).toHaveBeenCalledOnce()
    requestQuit()
    await flush()
    expect(mocks.app.quit).not.toHaveBeenCalled()

    closed.resolve(undefined)
    await flush()
    expect(mocks.app.quit).toHaveBeenCalledOnce()
    expect(mocks.helper.request).toHaveBeenCalledOnce()
    expect(mocks.helper.close).toHaveBeenCalledOnce()
    expect(mocks.showErrorBox).not.toHaveBeenCalled()
  })

  it('退出期间窗口销毁后不响应激活或第二实例重启 helper', async () => {
    const shutdown = Promise.withResolvers<unknown>()
    mocks.helper.request.mockReturnValue(shutdown.promise)
    requestQuit()
    await flush()
    mocks.window.isDestroyed.mockReturnValue(true)
    mocks.windowListeners.get('closed')!()
    mocks.listeners.get('activate')!()
    mocks.listeners.get('second-instance')!()
    await flush()
    expect(mocks.launchHelper).toHaveBeenCalledOnce()
    expect(mocks.createHostWindow).toHaveBeenCalledOnce()

    shutdown.resolve(null)
    await flush()
    expect(mocks.app.quit).toHaveBeenCalledOnce()
  })

  it('shutdown 无响应时仍等待有界关闭完成，重复退出不绕过超时', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const closed = Promise.withResolvers<undefined>()
      mocks.helper.request.mockReturnValue(new Promise(() => {}))
      mocks.helper.close.mockReturnValue(closed.promise)
      requestQuit()
      await flush()
      requestQuit()
      await vi.advanceTimersByTimeAsync(12_999)
      expect(mocks.helper.close).not.toHaveBeenCalled()
      expect(mocks.app.quit).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(mocks.helper.close).toHaveBeenCalledOnce()
      expect(mocks.app.quit).not.toHaveBeenCalled()
      closed.resolve(undefined)
      await flush()
      expect(mocks.app.quit).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('退出取消进行中的启动，迟到的 helper 就绪不会创建新窗口', async () => {
    mocks.windowListeners.get('closed')!()
    await flush()
    expect(mocks.helper.close).toHaveBeenCalledOnce()
    const ready = Promise.withResolvers<typeof mocks.helper>()
    mocks.launchHelper.mockReturnValueOnce(ready.promise)
    mocks.listeners.get('activate')!()
    await flush()
    const signal = mocks.launchHelper.mock.calls[1]![0].signal
    expect(signal.aborted).toBe(false)

    requestQuit()
    expect(signal.aborted).toBe(true)
    ready.resolve(mocks.helper)
    await flush()
    expect(mocks.createHostWindow).toHaveBeenCalledOnce()
    expect(mocks.helper.request).toHaveBeenCalledTimes(2)
    expect(mocks.helper.request).toHaveBeenLastCalledWith('shutdown', {})
    expect(mocks.helper.close).toHaveBeenCalledTimes(2)
    expect(mocks.app.quit).toHaveBeenCalledOnce()
  })

  it('窗口关闭后等待旧 helper 结束再复开，不复用已关闭的句柄', async () => {
    const closed = Promise.withResolvers<undefined>()
    mocks.helper.close.mockReturnValueOnce(closed.promise)
    const nextHelper = { ...mocks.helper, close: vi.fn(async () => undefined) }
    mocks.launchHelper.mockResolvedValueOnce(nextHelper)
    mocks.windowListeners.get('closed')!()
    mocks.listeners.get('activate')!()
    mocks.listeners.get('second-instance')!()
    await flush()
    expect(mocks.helper.request).toHaveBeenCalledExactlyOnceWith('shutdown', {})
    expect(mocks.helper.close).toHaveBeenCalledOnce()
    expect(mocks.launchHelper).toHaveBeenCalledOnce()
    closed.resolve(undefined)
    await flush()
    expect(mocks.launchHelper).toHaveBeenCalledTimes(2)
    expect(mocks.launchHelper.mock.calls[1]?.[0].env).toEqual(mocks.launchHelper.mock.calls[0]?.[0].env)
    expect(mocks.createHostWindow).toHaveBeenCalledTimes(2)
    expect(nextHelper.close).not.toHaveBeenCalled()
    expect(mocks.app.quit).not.toHaveBeenCalled()

    requestQuit()
    await flush()
    expect(nextHelper.request).toHaveBeenLastCalledWith('shutdown', {})
    expect(nextHelper.close).toHaveBeenCalledOnce()
    expect(mocks.app.quit).toHaveBeenCalledOnce()
  })

  it('helper shutdown 拒绝后仍关闭进程并退出', async () => {
    mocks.helper.request.mockRejectedValueOnce(new Error('shutdown failed'))
    requestQuit()
    await flush()
    expect(mocks.helper.request).toHaveBeenCalledExactlyOnceWith('shutdown', {})
    expect(mocks.helper.close).toHaveBeenCalledOnce()
    expect(mocks.app.quit).toHaveBeenCalledOnce()
    expect(mocks.showErrorBox).not.toHaveBeenCalled()
  })
})
