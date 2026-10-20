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
    destroy: vi.fn(),
    on: vi.fn((name: string, listener: (...args: unknown[]) => void) => { windowListeners.set(name, listener) }),
  }
  const bridge = {
    origin: 'ws://127.0.0.1:4243/browser-bridge', token: 'test-token',
    attach: vi.fn(), publish: vi.fn(), dispose: vi.fn<() => Promise<void>>(),
  }
  const manager = { dispose: vi.fn<() => Promise<void>>() }
  const chrome = { showWindow: vi.fn(), closeWindow: vi.fn(), dispose: vi.fn() }
  return {
    listeners, windowListeners, helper, window, bridge, manager, chrome,
    app: {
      isPackaged: false,
      setName: vi.fn(), setPath: vi.fn(), requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn((name: string, listener: (...args: unknown[]) => void) => { listeners.set(name, listener) }),
      whenReady: vi.fn(async () => undefined),
      quit: vi.fn(() => { listeners.get('before-quit')?.({ preventDefault: vi.fn() }) }),
    },
    showErrorBox: vi.fn(),
    prepareDevelopmentDirectories: vi.fn(async () => undefined),
    resolveRuntimeConfig: vi.fn(async () => ({ home: '/test/home', userData: '/test/user-data', cwd: '/test/workspace', helper: { env: {} } })),
    launchHelper: vi.fn(async (_options: { signal: AbortSignal; env: Record<string, string | undefined> }) => helper),
    createHostWindow: vi.fn(() => window),
    createBrowserBridge: vi.fn(async () => bridge),
    createBrowserGuestManager: vi.fn(() => manager),
    installBrowserIpc: vi.fn(() => vi.fn()),
    installRemoteIpc: vi.fn(() => vi.fn()),
    createNativeChrome: vi.fn(() => chrome),
  }
})

vi.mock('electron', () => ({ app: mocks.app, BrowserWindow: vi.fn(), dialog: { showErrorBox: mocks.showErrorBox } }))
vi.mock('coding-home-paths', () => ({ defaultCodingHome: () => '/test/installed' }))
vi.mock('../src/directories.ts', () => ({ prepareDevelopmentDirectories: mocks.prepareDevelopmentDirectories }))
vi.mock('../src/runtime-config.ts', () => ({ resolveRuntimeConfig: mocks.resolveRuntimeConfig, isGuiLaunch: () => false }))
vi.mock('../src/helper-client.ts', () => ({ launchHelper: mocks.launchHelper }))
vi.mock('../src/window.ts', () => ({ createHostWindow: mocks.createHostWindow }))
vi.mock('../src/browser-bridge.ts', () => ({ createBrowserBridge: mocks.createBrowserBridge }))
vi.mock('../src/browser-guest.ts', () => ({ createBrowserGuestManager: mocks.createBrowserGuestManager }))
vi.mock('../src/browser-ipc.ts', () => ({ installBrowserIpc: mocks.installBrowserIpc }))
vi.mock('../src/remote-ipc.ts', () => ({ installRemoteIpc: mocks.installRemoteIpc }))
vi.mock('../src/native-chrome.ts', () => ({ createNativeChrome: mocks.createNativeChrome }))

function requestQuit(): ReturnType<typeof vi.fn> {
  const preventDefault = vi.fn()
  mocks.listeners.get('before-quit')!({ preventDefault })
  return preventDefault
}

function flush(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}

describe('Electron 主进程退出', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.listeners.clear()
    mocks.windowListeners.clear()
    mocks.window.isDestroyed.mockReturnValue(false)
    mocks.helper.request.mockResolvedValue(null)
    mocks.helper.close.mockResolvedValue(undefined)
    mocks.launchHelper.mockResolvedValue(mocks.helper)
    mocks.createBrowserBridge.mockResolvedValue(mocks.bridge)
    mocks.createBrowserGuestManager.mockReturnValue(mocks.manager)
    mocks.bridge.dispose.mockResolvedValue(undefined)
    mocks.manager.dispose.mockResolvedValue(undefined)
    await import('../src/main.ts')
    await flush()
    expect(mocks.createNativeChrome).toHaveBeenCalledOnce()
  })

  it('重复退出请求必须等待同一次 helper shutdown 与进程关闭', async () => {
    const shutdown = Promise.withResolvers<unknown>()
    const closed = Promise.withResolvers<undefined>()
    mocks.helper.request.mockReturnValue(shutdown.promise)
    mocks.helper.close.mockReturnValue(closed.promise)
    expect(requestQuit()).toHaveBeenCalledOnce()
    await flush()
    expect(mocks.helper.request).toHaveBeenCalledExactlyOnceWith('shutdown', {})
    expect(requestQuit()).toHaveBeenCalledOnce()
    await flush()
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
    expect(mocks.createBrowserBridge).toHaveBeenCalledOnce()

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

  it.each(['bridge', 'manager', 'both'] as const)('%s 清理悬挂时立即销毁 guest，三秒后仍关闭 helper 并退出', async (owner) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const disposed = Promise.withResolvers<undefined>()
    if (owner !== 'manager') mocks.bridge.dispose.mockReturnValue(disposed.promise)
    if (owner !== 'bridge') mocks.manager.dispose.mockReturnValue(disposed.promise)
    try {
      requestQuit()
      await flush()
      expect(mocks.bridge.dispose).toHaveBeenCalledOnce()
      expect(mocks.manager.dispose).toHaveBeenCalledOnce()
      const installed = mocks.installBrowserIpc.mock.results[0]!
      if (installed.type !== 'return') throw new Error('Missing browser IPC disposer')
      const revoke = installed.value
      expect(revoke).toHaveBeenCalledOnce()
      expect(revoke.mock.invocationCallOrder[0]).toBeLessThan(mocks.bridge.dispose.mock.invocationCallOrder[0]!)
      await vi.advanceTimersByTimeAsync(2_999)
      expect(mocks.helper.request).not.toHaveBeenCalled()
      expect(mocks.helper.close).not.toHaveBeenCalled()
      expect(mocks.app.quit).not.toHaveBeenCalled()
      requestQuit()
      await vi.advanceTimersByTimeAsync(1)
      expect(mocks.helper.request).toHaveBeenCalledExactlyOnceWith('shutdown', {})
      expect(mocks.helper.close).toHaveBeenCalledOnce()
      expect(mocks.app.quit).toHaveBeenCalledOnce()
      expect(mocks.bridge.dispose).toHaveBeenCalledOnce()
      expect(mocks.manager.dispose).toHaveBeenCalledOnce()
    } finally {
      disposed.resolve(undefined)
      await flush()
      vi.useRealTimers()
    }
  })

  it('普通退出等待桥和 guest 都完成清理，但不串行阻塞销毁', async () => {
    const bridge = Promise.withResolvers<undefined>()
    const manager = Promise.withResolvers<undefined>()
    mocks.bridge.dispose.mockReturnValue(bridge.promise)
    mocks.manager.dispose.mockReturnValue(manager.promise)
    requestQuit()
    await flush()
    expect(mocks.bridge.dispose).toHaveBeenCalledOnce()
    expect(mocks.manager.dispose).toHaveBeenCalledOnce()
    expect(mocks.helper.request).not.toHaveBeenCalled()
    bridge.resolve(undefined)
    await flush()
    expect(mocks.helper.request).not.toHaveBeenCalled()
    manager.resolve(undefined)
    await flush()
    expect(mocks.helper.close).toHaveBeenCalledOnce()
    expect(mocks.app.quit).toHaveBeenCalledOnce()
  })

  it('旧清理超时后重开使用新的桥令牌，迟到拒绝不触碰新实例', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const oldCleanup = Promise.withResolvers<undefined>()
    mocks.bridge.dispose.mockReturnValue(oldCleanup.promise)
    mocks.manager.dispose.mockReturnValue(oldCleanup.promise)
    const nextBridge = { ...mocks.bridge, token: 'next-token', origin: 'ws://127.0.0.1:4244/browser-bridge',
      dispose: vi.fn(async () => undefined) }
    const nextManager = { dispose: vi.fn(async () => undefined) }
    const nextHelper = { ...mocks.helper, close: vi.fn(async () => undefined) }
    mocks.createBrowserBridge.mockResolvedValueOnce(nextBridge)
    mocks.createBrowserGuestManager.mockReturnValueOnce(nextManager)
    mocks.launchHelper.mockResolvedValueOnce(nextHelper)
    try {
      mocks.windowListeners.get('closed')!()
      mocks.listeners.get('activate')!()
      await flush()
      expect(mocks.launchHelper).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(mocks.launchHelper).toHaveBeenCalledTimes(2)
      expect(mocks.launchHelper.mock.calls[1]![0].env).toMatchObject({
        DSH_DESKTOP_BROWSER_BRIDGE_ORIGIN: nextBridge.origin,
        DSH_DESKTOP_BROWSER_BRIDGE_TOKEN: nextBridge.token,
      })
      expect(mocks.helper.close).toHaveBeenCalledOnce()
      oldCleanup.reject(new Error('old bridge cleanup failed'))
      await flush()
      expect(nextBridge.dispose).not.toHaveBeenCalled()
      expect(nextManager.dispose).not.toHaveBeenCalled()
      expect(nextHelper.close).not.toHaveBeenCalled()
      expect(mocks.app.quit).not.toHaveBeenCalled()

      requestQuit()
      await flush()
      expect(nextBridge.dispose).toHaveBeenCalledOnce()
      expect(nextManager.dispose).toHaveBeenCalledOnce()
      expect(nextHelper.close).toHaveBeenCalledOnce()
      expect(mocks.app.quit).toHaveBeenCalledOnce()
    } finally {
      oldCleanup.resolve(undefined)
      vi.useRealTimers()
    }
  })

  it('桥清理同步抛错仍销毁 guest，且清理拒绝不会阻止关闭 helper', async () => {
    mocks.bridge.dispose.mockImplementationOnce(() => { throw new Error('bridge cleanup failed') })
    mocks.manager.dispose.mockRejectedValueOnce(new Error('manager cleanup failed'))
    requestQuit()
    await flush()
    expect(mocks.bridge.dispose).toHaveBeenCalledOnce()
    expect(mocks.manager.dispose).toHaveBeenCalledOnce()
    expect(mocks.helper.close).toHaveBeenCalledOnce()
    expect(mocks.app.quit).toHaveBeenCalledOnce()
    expect(mocks.showErrorBox).not.toHaveBeenCalled()
  })
})
